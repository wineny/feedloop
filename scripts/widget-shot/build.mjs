// public/widget-shot.js 를 만든다. 결과물은 커밋한다(배포 때 빌드하지 않는다 — widget.js 와 같은 정적 자산).
// 실행: node scripts/widget-shot/build.mjs
import { build } from 'rolldown';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  input: path.join(here, 'entry.js'),
  output: {
    file: path.join(here, '../../public/widget-shot.js'),
    format: 'iife',
    minify: true,
    banner: '/*! Feedloop widget-shot (I-55) — bundles modern-screenshot 4.7.0 (MIT, qq15725). Source: scripts/widget-shot/entry.js */',
  },
  logLevel: 'warn',
});
