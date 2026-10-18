import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { MERGE_BLOCK_MESSAGE, VERDICT_LABEL } from '../src/lib/auto-dev/review-labels';

describe('PR review client boundary', () => {
  it('keeps display labels available without any runtime dependency', () => {
    expect(MERGE_BLOCK_MESSAGE.conflict).toContain('충돌');
    expect(VERDICT_LABEL.fix_holds).toContain('AI 의견');
    const source = readFileSync('src/lib/auto-dev/review-labels.ts','utf8');
    const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
    expect(compiled).not.toMatch(/\b(?:import|require)\b/);
  });
  it('does not pull server review or verification modules into the panel', () => {
    const source = ts.createSourceFile('panel.tsx',readFileSync('src/components/monitor/PrReviewPanel.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const runtimeImports = source.statements.filter(ts.isImportDeclaration).filter(node => !node.importClause?.isTypeOnly).map(node => node.moduleSpecifier.getText(source));
    expect(runtimeImports.join('\n')).not.toMatch(/auto-dev\/(?:pr-review|verify-item|ai-engine)['"]/);
    expect(runtimeImports.join('\n')).toContain('auto-dev/review-labels');
  });
});
