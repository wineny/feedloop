import { describe, it, expect } from 'vitest';
import {
  parseImports,
  resolveImport,
  findProjectRoot,
  selectImportNeighbors,
  truncateNeighbor,
  MAX_NEIGHBOR_FILES,
} from '@/lib/auto-dev/imports';

/** 데모 레포(널널투어)와 같은 모양 — Vercel root 가 `app` 이라 tsconfig 가 `app/` 아래 있다 */
const DEMO_TREE = new Set([
  'README.md',
  'app/package.json',
  'app/tsconfig.json',
  'app/app/coupons/page.tsx',
  'app/app/coupons/page.module.css',
  'app/app/coupons/SignInBanner.tsx',
  'app/components/MyCouponCard.tsx',
  'app/components/HashtagChips.tsx',
  'app/components/SourceBanner.tsx',
  'app/components/LocaleSwitcher.tsx',
  'app/components/ErrorState.tsx',
  'app/components/Skeleton.tsx',
  'app/components/icons/index.tsx',
  'app/lib/coupons/view.ts',
  'app/lib/coupon-session.ts',
  'app/lib/i18n/client.tsx',
  'app/lib/i18n/href.ts',
  'app/lib/i18n/date.ts',
  'app/lib/i18n/locales.ts',
  'app/lib/coupons/usage-note-i18n.ts',
]);

/** 데모 레포 `app/app/coupons/page.tsx` 상단 import 를 그대로 옮겼다 (PR #6 재현 재료) */
const COUPONS_PAGE = `"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import MyCouponCard from "@/components/MyCouponCard";
import HashtagChips from "@/components/HashtagChips";
import SignInBanner from "./SignInBanner";
import SourceBanner from "@/components/SourceBanner";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import ErrorState from "@/components/ErrorState";
import { SkeletonCard } from "@/components/Skeleton";
import { Icon } from "@/components/icons";
import { filterIssuesByTab, type CouponIssueView } from "@/lib/coupons/view";
import { fetchMyIssues } from "@/lib/coupon-session";
import { useLocale, useT } from "@/lib/i18n/client";
import { localeHref } from "@/lib/i18n/href";
import { localizedDateLabel } from "@/lib/i18n/date";
import { localizeUsageNote } from "@/lib/coupons/usage-note-i18n";
import type { Locale } from "@/lib/i18n/locales";

export default function Page() { return null; }
`;

describe('parseImports', () => {
  it('import·export-from·require·dynamic import 를 전부 뽑는다', () => {
    const src = `
import a from './a';
import { b, c } from '../b';
import * as ns from '@/ns';
import './side.css';
export { x } from './x';
export * from './y';
const z = require('./z');
const lazy = () => import('./lazy');
`;
    const specs = parseImports(src).map((i) => i.specifier);
    expect(specs).toEqual(['./a', '../b', '@/ns', './side.css', './x', './y', './z', './lazy']);
  });

  it('타입 전용 import 를 구분한다 — 런타임 동작이 없어 인과 추적에 쓸모없다', () => {
    const src = `
import type { Locale } from './locales';
import { type A, type B } from './types-only';
import { type C, real } from './mixed';
import Default, { type D } from './default-with-type';
`;
    const byType = Object.fromEntries(parseImports(src).map((i) => [i.specifier, i.typeOnly]));
    expect(byType['./locales']).toBe(true);
    expect(byType['./types-only']).toBe(true);
    expect(byType['./mixed']).toBe(false);
    expect(byType['./default-with-type']).toBe(false);
  });

  it('사이드이펙트 import 뒤의 type import 가 앞 문장과 붙지 않는다', () => {
    const src = `import './a.css';\nimport type { B } from './b';\n`;
    const parsed = parseImports(src);
    expect(parsed.find((i) => i.specifier === './b')?.typeOnly).toBe(true);
  });

  it('같은 모듈을 type 으로도 값으로도 가져오면 값으로 본다', () => {
    const src = `import type { T } from './m';\nimport { v } from './m';\n`;
    expect(parseImports(src)).toEqual([{ specifier: './m', typeOnly: false, order: 0 }]);
  });
});

describe('findProjectRoot / resolveImport', () => {
  it('가장 가까운 tsconfig 가 있는 디렉터리를 루트로 본다 (데모 레포는 app/)', () => {
    expect(findProjectRoot('app/app/coupons/page.tsx', DEMO_TREE)).toBe('app/');
    expect(findProjectRoot('README.md', DEMO_TREE)).toBe('');
  });

  it('@/ 별칭을 프로젝트 루트 기준으로 풀고 확장자를 찾는다', () => {
    expect(resolveImport('@/lib/coupon-session', 'app/app/coupons/page.tsx', DEMO_TREE)).toBe(
      'app/lib/coupon-session.ts',
    );
    expect(resolveImport('@/components/MyCouponCard', 'app/app/coupons/page.tsx', DEMO_TREE)).toBe(
      'app/components/MyCouponCard.tsx',
    );
  });

  it('src/ 아래에 소스가 있는 레포도 푼다', () => {
    const tree = new Set(['tsconfig.json', 'src/lib/x.ts', 'src/app/page.tsx']);
    expect(resolveImport('@/lib/x', 'src/app/page.tsx', tree)).toBe('src/lib/x.ts');
  });

  it('상대경로·index 파일·디렉터리 import 를 푼다', () => {
    expect(resolveImport('./SignInBanner', 'app/app/coupons/page.tsx', DEMO_TREE)).toBe(
      'app/app/coupons/SignInBanner.tsx',
    );
    expect(resolveImport('@/components/icons', 'app/app/coupons/page.tsx', DEMO_TREE)).toBe(
      'app/components/icons/index.tsx',
    );
    expect(resolveImport('../lib/coupon-session', 'app/app/x.ts', DEMO_TREE)).toBe('app/lib/coupon-session.ts');
  });

  it('NodeNext 식 `./k.js` 가 `k.ts` 를 가리키면 푼다', () => {
    const tree = new Set(['tsconfig.json', 'src/k.ts', 'src/page.ts']);
    expect(resolveImport('./k.js', 'src/page.ts', tree)).toBe('src/k.ts');
  });

  it('패키지·내장 모듈·CSS·레포 밖 경로는 null', () => {
    const from = 'app/app/coupons/page.tsx';
    expect(resolveImport('react', from, DEMO_TREE)).toBeNull();
    expect(resolveImport('next/link', from, DEMO_TREE)).toBeNull();
    expect(resolveImport('node:fs', from, DEMO_TREE)).toBeNull();
    expect(resolveImport('./page.module.css', from, DEMO_TREE)).toBeNull();
    expect(resolveImport('../../../../outside', from, DEMO_TREE)).toBeNull();
    expect(resolveImport('@/lib/does-not-exist', from, DEMO_TREE)).toBeNull();
  });
});

describe('selectImportNeighbors', () => {
  it('PR #6 재현 — 쿠폰 페이지의 import 16번째인 coupon-session 이 상위 3개 안에 든다', () => {
    const picked = selectImportNeighbors(
      [{ path: 'app/app/coupons/page.tsx', content: COUPONS_PAGE }],
      DEMO_TREE,
      '쿠폰함 지난 내역 탭이 흰 화면 500 /api/coupons/history',
    );
    const paths = picked.map((p) => p.path);
    expect(paths.length).toBeLessThanOrEqual(MAX_NEIGHBOR_FILES);
    expect(paths).toContain('app/lib/coupon-session.ts');
    // 데이터 계층이 컴포넌트보다 앞에 온다
    expect(paths[0]).toMatch(/^app\/lib\//);
    // i18n·아이콘·타입 전용은 뒤로 밀리거나 빠진다
    expect(paths).not.toContain('app/lib/i18n/locales.ts');
    expect(paths).not.toContain('app/components/icons/index.tsx');
  });

  it('점수가 음수인 소음(i18n·아이콘)은 자리가 남아도 넣지 않는다', () => {
    const tree = new Set(['tsconfig.json', 'src/page.tsx', 'src/lib/session.ts', 'src/i18n/messages.ts', 'src/icons/index.ts']);
    const content = `import { s } from '@/lib/session';\nimport { m } from '@/i18n/messages';\nimport { I } from '@/icons';\n`;
    const picked = selectImportNeighbors([{ path: 'src/page.tsx', content }], tree, '');
    expect(picked.map((p) => p.path)).toEqual(['src/lib/session.ts']);
  });

  it('피드백 키워드와 겹치는 경로가 앞에 온다', () => {
    const tree = new Set(['tsconfig.json', 'src/page.tsx', 'src/lib/auth.ts', 'src/lib/checkout.ts']);
    const content = `import { a } from '@/lib/auth';\nimport { c } from '@/lib/checkout';\n`;
    const picked = selectImportNeighbors([{ path: 'src/page.tsx', content }], tree, 'checkout button does nothing');
    expect(picked[0].path).toBe('src/lib/checkout.ts');
  });

  it('후보 자신과 중복은 제외하고 상한을 지킨다', () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => `src/lib/${n}.ts`);
    const tree = new Set(['tsconfig.json', 'src/main.ts', 'src/other.ts', ...files]);
    const content = files.map((f) => `import '@/lib/${f.split('/').pop()!.replace('.ts', '')}';`).join('\n') +
      `\nimport '@/other';\nimport '@/main';`;
    const picked = selectImportNeighbors(
      [{ path: 'src/main.ts', content }, { path: 'src/other.ts', content: `import '@/lib/a';` }],
      tree,
      '',
    );
    expect(picked.length).toBe(MAX_NEIGHBOR_FILES);
    expect(picked.map((p) => p.path)).not.toContain('src/main.ts');
    expect(picked.map((p) => p.path)).not.toContain('src/other.ts');
    expect(new Set(picked.map((p) => p.path)).size).toBe(picked.length);
  });
});

describe('truncateNeighbor', () => {
  it('상한 이하면 그대로, 넘으면 앞부분 + 생략 표시', () => {
    expect(truncateNeighbor('short', 100)).toBe('short');
    const long = 'x'.repeat(5000);
    const out = truncateNeighbor(long, 2000);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('rest omitted');
  });
});
