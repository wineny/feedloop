import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { translator } from './helpers/intl';

describe('PR review client boundary', () => {
  it('keeps display labels in the dictionary, not in a runtime module', () => {
    for (const locale of ['en', 'ko'] as const) {
      const t = translator('monitor', locale);
      for (const key of ['conflict', 'build_failed', 'build_pending', 'merged', 'closed']) expect(t.has(`mergeBlock.${key}`)).toBe(true);
      for (const key of ['fix_holds', 'fix_does_not_hold', 'inconclusive']) expect(t.has(`verdict.${key}`)).toBe(true);
    }
    expect(translator('monitor').has('verdict.fix_holds')).toBe(true);
  });
  it('does not pull server review or verification modules into the panel', () => {
    const source = ts.createSourceFile('panel.tsx',readFileSync('src/components/monitor/PrReviewPanel.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const runtimeImports = source.statements.filter(ts.isImportDeclaration).filter(node => !node.importClause?.isTypeOnly).map(node => node.moduleSpecifier.getText(source));
    expect(runtimeImports.join('\n')).not.toMatch(/auto-dev\/(?:pr-review|verify-item|ai-engine)['"]/);
  });
});
