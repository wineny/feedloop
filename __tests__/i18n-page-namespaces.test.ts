import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT_NAMESPACES, PAGE_NAMESPACES, type PageKey } from '../src/i18n/namespaces';

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

// 페이지(엔트리) → 그 페이지에 닿는 구역 layout 의 PageKey
const ROUTES: Record<string, PageKey[]> = {
  'layout.tsx': [],
  'error.tsx': [],
  'page.tsx': ['landing'],
  'login/page.tsx': [],
  'pricing/page.tsx': ['pricing'],
  'pricing/receipt/[orderId]/page.tsx': ['pricing'],
  'inbox/page.tsx': ['inbox'],
  'dashboard/page.tsx': ['dashboard'],
  'classify/page.tsx': ['classify'],
  'monitor/page.tsx': ['monitor'],
  'feedback-confirm/page.tsx': [],
  'bots/page.tsx': ['bots'],
  'bots/new/page.tsx': ['bots', 'bots.new'],
  'bots/[id]/appearance/page.tsx': ['bots'],
  'bots/[id]/connect/page.tsx': ['bots', 'bots.connect'],
  'bots/[id]/knowledge/page.tsx': ['bots', 'bots.knowledge'],
};

describe('클라이언트 사전 namespace', () => {
  it.each(Object.entries(ROUTES))('%s — 쓰는 namespace 가 모두 실려 있다', (route, keys) => {
    const loaded = new Set<string>([...LAYOUT_NAMESPACES, ...keys.flatMap((k) => PAGE_NAMESPACES[k])]);
    const used = [...clientNamespaces(path.join(APP, route))];
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
