// 데모 봇 비우기(scripts/reset-demo.ts)의 표 목록을 supabase/schema.sql 과 대조한다.
//
// 지키는 것
// - 지우는 표는 모두 실제로 있고 bot_id 열이 있다(그 열로만 데모 봇 한 대에 묶는다).
// - 남기는 표(봇 설정·상품·승인자·계정)는 지우는 목록에 절대 없다.
// - 순서: 지울 표끼리의 FK 는 항상 «뒤에 오는» 표를 가리킨다(자식 먼저).
// - CASCADE 로 맡긴 자식은 정말 ON DELETE CASCADE 로 부모에 묶여 있다.
// - schema.sql 의 모든 표가 셋 중 하나로 분류돼 있다 — 새 마이그레이션이 표를 더하면 여기서 실패한다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  BOT_SCOPE_COLUMN,
  DEMO_RESET_CASCADE,
  DEMO_RESET_DELETE,
  DEMO_RESET_KEEP,
} from '@/lib/demo/reset-plan';

type Fk = { from: string; column: string; to: string; onDelete: string };

/** 주석을 걷어낸 schema.sql 에서 표·열·FK 를 뽑는다. 이 파일이 쓰는 두 모양만 읽는다:
 *  CREATE TABLE 안의 열 정의, ALTER TABLE … ADD COLUMN … REFERENCES. */
function parseSchema(raw: string) {
  const sql = raw.replace(/--[^\n]*/g, '');
  const columns = new Map<string, Set<string>>();
  const fks: Fk[] = [];

  const addFk = (from: string, column: string, def: string) => {
    const m = /REFERENCES\s+(?:public\.)?(\w+)\s*\([^)]*\)(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/i.exec(def);
    if (m) fks.push({ from, column, to: m[1].toLowerCase(), onDelete: (m[2] ?? 'NO ACTION').toUpperCase().replace(/\s+/g, ' ') });
  };

  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(/gi;
  for (let m; (m = createRe.exec(sql)); ) {
    const table = m[1].toLowerCase();
    // 짝 맞는 닫는 괄호까지가 본문. 깊이 0 의 쉼표로 열 정의를 나눈다.
    let depth = 1;
    let i = createRe.lastIndex;
    const parts: string[] = [];
    let cur = '';
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0) break;
      if (ch === ',' && depth === 1) {
        parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    parts.push(cur);
    const cols = columns.get(table) ?? new Set<string>();
    for (const p of parts) {
      const name = /^\s*(\w+)/.exec(p)?.[1]?.toLowerCase();
      if (!name || /^(primary|unique|constraint|check|foreign)$/.test(name)) continue;
      cols.add(name);
      addFk(table, name, p);
    }
    columns.set(table, cols);
  }

  const alterRe = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)([^;,]*)/gi;
  for (let m; (m = alterRe.exec(sql)); ) {
    const table = m[1].toLowerCase();
    const column = m[2].toLowerCase();
    columns.get(table)?.add(column);
    addFk(table, column, m[3]);
  }
  const referenceCount = (sql.match(/\bREFERENCES\b/gi) ?? []).length;
  return { columns, fks, referenceCount };
}

const schema = parseSchema(readFileSync(path.resolve(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
const deleteTables = DEMO_RESET_DELETE.map((s) => s.table);
const cascadeTables = DEMO_RESET_CASCADE.map((c) => c.table);

describe('demo reset plan vs supabase/schema.sql', () => {
  it('parses the schema (sanity)', () => {
    expect(schema.columns.get('messages')?.has('conversation_id')).toBe(true);
    expect(schema.fks).toContainEqual({ from: 'responses', column: 'trigger_message_id', to: 'messages', onDelete: 'NO ACTION' });
    // 파서가 놓친 FK 가 없어야 아래 순서·CASCADE 검사가 의미가 있다. 다른 모양(표 수준 FOREIGN KEY,
    // 한 ALTER 안의 여러 ADD COLUMN 에 붙은 REFERENCES 등)이 생기면 여기서 실패한다 — 파서를 넓혀라.
    expect(schema.fks.length).toBe(schema.referenceCount);
  });

  it('every table it deletes exists and is scoped by bot_id', () => {
    for (const t of deleteTables) {
      expect(schema.columns.has(t), `${t} is not in schema.sql`).toBe(true);
      expect(schema.columns.get(t)!.has(BOT_SCOPE_COLUMN), `${t} has no ${BOT_SCOPE_COLUMN} column`).toBe(true);
      expect(
        schema.fks.some((f) => f.from === t && f.column === BOT_SCOPE_COLUMN && f.to === 'bots'),
        `${t}.${BOT_SCOPE_COLUMN} does not reference bots`,
      ).toBe(true);
    }
  });

  it('never deletes a kept table, and lists each table once', () => {
    const all = [...deleteTables, ...cascadeTables, ...DEMO_RESET_KEEP];
    expect(new Set(all).size).toBe(all.length);
    for (const keep of ['bots', 'products', 'bot_members', 'users', 'accounts', 'sessions']) {
      expect(DEMO_RESET_KEEP).toContain(keep);
    }
  });

  it('deletes children before parents', () => {
    deleteTables.forEach((t, i) => {
      for (const f of schema.fks.filter((f) => f.from === t && deleteTables.includes(f.to) && f.to !== t)) {
        expect(deleteTables.indexOf(f.to), `${t}.${f.column} → ${f.to} must be deleted after ${t}`).toBeGreaterThan(i);
      }
    });
  });

  it('cascade-only children really cascade from a deleted parent and have no bot_id', () => {
    for (const c of DEMO_RESET_CASCADE) {
      expect(deleteTables).toContain(c.parent);
      expect(schema.fks).toContainEqual({ from: c.table, column: c.fk, to: c.parent, onDelete: 'CASCADE' });
      expect(schema.columns.get(c.table)?.has(BOT_SCOPE_COLUMN)).toBe(false);
      // 부모 말고 다른 지울 표를 잡는 FK 는 SET NULL·CASCADE 여야 그 표의 DELETE 가 막히지 않는다.
      for (const f of schema.fks.filter((f) => f.from === c.table && f.column !== c.fk && deleteTables.includes(f.to))) {
        expect(['SET NULL', 'CASCADE'], `${c.table}.${f.column} → ${f.to}`).toContain(f.onDelete);
      }
    }
  });

  it('no kept table holds a restricting FK into a deleted table', () => {
    // 남기는 표가 지울 표를 NO ACTION/RESTRICT 로 잡고 있으면 DELETE 가 실패하거나, CASCADE 면 남겨야 할 행이 지워진다.
    for (const f of schema.fks.filter((f) => DEMO_RESET_KEEP.includes(f.from) && deleteTables.includes(f.to))) {
      expect(f.onDelete, `${f.from}.${f.column} → ${f.to}`).toBe('SET NULL');
    }
  });

  it('classifies every table in schema.sql (a new table must be put in delete, cascade or keep)', () => {
    const known = new Set([...deleteTables, ...cascadeTables, ...DEMO_RESET_KEEP]);
    const unknown = [...schema.columns.keys()].filter((t) => !known.has(t));
    expect(unknown).toEqual([]);
  });
});
