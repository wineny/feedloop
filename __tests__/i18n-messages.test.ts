import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGE_NAMESPACES } from '../src/i18n/namespaces';
import { loadMessages } from './helpers/intl';

const MESSAGES_DIR = path.resolve(__dirname, '../messages');

/** 리프까지의 점 경로 목록. */
function leaves(node: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === 'string') {
    out.set(prefix, node);
    return out;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    for (const [p, s] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, s);
  }
  return out;
}

/** ICU 인자 이름({name}, <b>…</b>) — 두 언어가 같은 값을 받아야 한다. */
function placeholders(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\{\s*([A-Za-z_][\w]*)\s*[,}]/g)) names.add(m[1]);
  for (const m of text.matchAll(/<\/?([A-Za-z][\w]*)>/g)) names.add(`<${m[1]}>`);
  return [...names].sort();
}

describe('messages: en / ko', () => {
  const en = leaves(loadMessages('en'));
  const ko = leaves(loadMessages('ko'));

  it('en 과 ko 의 키 집합이 같다(빠진 키 0)', () => {
    const onlyEn = [...en.keys()].filter((k) => !ko.has(k));
    const onlyKo = [...ko.keys()].filter((k) => !en.has(k));
    expect({ onlyEn, onlyKo }).toEqual({ onlyEn: [], onlyKo: [] });
  });

  it('두 언어의 ICU 인자·태그가 같다', () => {
    const diff = [...en].filter(([k, v]) => ko.has(k) && placeholders(v).join() !== placeholders(ko.get(k)!).join()).map(([k]) => k);
    expect(diff).toEqual([]);
  });

  it('빈 문구가 없다', () => {
    expect([...en, ...ko].filter(([, v]) => v.trim() === '')).toEqual([]);
  });

  it('namespaces.ts 의 MESSAGE_NAMESPACES 가 messages/<locale>/ 파일 목록과 같다', () => {
    for (const locale of ['en', 'ko']) {
      const files = fs.readdirSync(path.join(MESSAGES_DIR, locale)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
      expect(files).toEqual([...MESSAGE_NAMESPACES].sort());
    }
  });

  it('영어 사전에 한글이 없다', () => {
    expect([...en].filter(([, v]) => /[가-힣]/.test(v)).map(([k]) => k)).toEqual([]);
  });
});
