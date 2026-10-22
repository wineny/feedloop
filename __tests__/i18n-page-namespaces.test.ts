import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT_NAMESPACES, MESSAGE_NAMESPACES, PAGE_NAMESPACES, type PageKey } from '../src/i18n/namespaces';

// 클라이언트로 가는 사전은 namespace 를 골라 싣는다(`PageMessages`). 한 곳이라도 빠지면 그 화면이
// MISSING_MESSAGE 로 깨지므로, 각 페이지에서 import 로 닿는 «클라이언트 컴포넌트»가 쓰는 namespace 가
// layout + 그 페이지 구역 layout 이 싣는 것 안에 있는지 소스를 훑어 확인한다.

const SRC = path.resolve(__dirname, '../src');
const APP = path.join(SRC, 'app/[locale]');

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

interface FileInfo {
  client: boolean;
  namespaces: string[];
  imports: string[];
}
const cache = new Map<string, FileInfo>();
function info(file: string): FileInfo {
  const hit = cache.get(file);
  if (hit) return hit;
  const src = fs.readFileSync(file, 'utf8');
  const client = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(src);
  const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([\w.]+)['"]/g)].map((m) => m[1].split('.')[0]);
  // 루트 `useTranslations()` 는 키 앞에 namespace 를 붙여 부른다(`tRoot('common.validation…')`). 루트 번역기 변수로 부르는 문자열 리터럴의
  // 첫 마디를 namespace 로 센다. 키를 만들어 넘기는 `lib/i18n/` 는 파일에 적힌 `<namespace>.` 리터럴을 센다.
  const nsAlt = MESSAGE_NAMESPACES.join('|');
  for (const root of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:dynamicT\()?useTranslations\(\s*\)/g)) {
    for (const m of src.matchAll(new RegExp(`\\b${root[1]}\\(\\s*['"\`](${nsAlt})\\.`, 'g'))) namespaces.push(m[1]);
  }
  if (file.includes(`${path.sep}lib${path.sep}i18n${path.sep}`)) {
    for (const m of src.matchAll(new RegExp(`['"\`](${nsAlt})\\.[A-Za-z_]`, 'g'))) namespaces.push(m[1]);
  }
  const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((m) => resolveImport(file, m[1]))
    .filter((f): f is string => f !== null);
  const result = { client, namespaces, imports };
  cache.set(file, result);
  return result;
}

/** entry 에서 import 로 닿는 클라이언트 컴포넌트(와 그 하위)가 쓰는 namespace */
function clientNamespaces(entry: string): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  const go = (file: string, inClient: boolean) => {
    const key = `${file}|${inClient}`;
    if (seen.has(key)) return;
    seen.add(key);
    const i = info(file);
    const client = inClient || i.client;
    if (client) i.namespaces.forEach((n) => out.add(n));
    i.imports.forEach((f) => go(f, client));
  };
  go(entry, false);
  return out;
}

// 페이지(엔트리) → 그 페이지에 닿는 구역 layout 의 PageKey.
// `src/app/[locale]/` 아래의 page·error·not-found·layout 을 전부 찾고, 각 파일에서 루트까지 올라가며 만나는
// layout.tsx(와 파일 자신)의 `<PageMessages page="…">` 를 모은다. 새 화면을 더하면 자동으로 이 검사에 든다.
function pageKeysOf(file: string): PageKey[] {
  const keys: PageKey[] = [];
  const read = (f: string) => {
    if (!fs.existsSync(f)) return;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/<PageMessages page="([\w.]+)"/g)) keys.push(m[1] as PageKey);
  };
  read(file);
  for (let dir = path.dirname(file); dir.startsWith(APP); dir = path.dirname(dir)) {
    const layout = path.join(dir, 'layout.tsx');
    if (layout !== file) read(layout);
  }
  return keys;
}

function discoverEntries(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) discoverEntries(p, out);
    else if (/^(page|error|not-found|layout)\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

const ENTRIES = discoverEntries(APP).map((f) => path.relative(APP, f)).sort();

describe('클라이언트 사전 namespace', () => {
  it('화면 파일을 찾았다(탐색이 비어 있지 않다)', () => {
    expect(ENTRIES).toEqual(expect.arrayContaining(['page.tsx', 'monitor/page.tsx', 'classify/page.tsx', 'feedback-confirm/page.tsx', 'bots/new/page.tsx']));
  });

  it.each(ENTRIES)('%s — 쓰는 namespace 가 모두 실려 있다', (route) => {
    const file = path.join(APP, route);
    const loaded = new Set<string>([...LAYOUT_NAMESPACES, ...pageKeysOf(file).flatMap((k) => PAGE_NAMESPACES[k])]);
    const used = [...clientNamespaces(file)];
    expect(used.filter((n) => !loaded.has(n))).toEqual([]);
  });

  it('구역 layout.tsx 가 PAGE_NAMESPACES 의 모든 키를 한 번씩 싣는다', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'layout.tsx' || e.name === 'page.tsx') {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/<PageMessages page="([\w.]+)"/g)) found.push(m[1]);
        }
      }
    };
    walk(APP);
    expect(found.sort()).toEqual(Object.keys(PAGE_NAMESPACES).sort());
  });
});
