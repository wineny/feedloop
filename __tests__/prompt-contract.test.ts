/** Prompt-contract checks, not claims about model classification accuracy. */
import { describe, expect, it } from 'vitest';
import { getSystemPrompt } from '@/lib/bot/prompts';
import { TAXONOMY_BLOCK } from '@/lib/classify/taxonomy';
import { buildBatchSystemPrompt } from '@/lib/classify/batch';
import { groupAction } from '@/lib/groups/policy';
const profile = { botName:'안내',botTone:'친절',serviceName:'예약',serviceUrl:'',serviceDescription:'',serviceCompany:'',targetUsers:'',serviceFeatures:[],loginMethod:'',faq:[],knowledge:'' };
describe('shared classification contract',()=>{
 it('puts explicit symptom priority before the ordered capability question in both prompts',()=>{
  for(const prompt of [getSystemPrompt(profile),buildBatchSystemPrompt('예약')]) {
   expect(prompt).toContain(TAXONOMY_BLOCK);
   expect(prompt.indexOf('a breakdown of existing behavior that the user states is bug')).toBeLessThan(prompt.indexOf('2. **Does the user want a capability this app does not have now?**'));
   expect(prompt).toContain('Do not infer an existing inconvenience or breakdown from a request for a new capability alone');
  }
 });
 it('retains inquiry records independently of answering and distinguishes their summaries',()=>{
  const prompt=getSystemPrompt(profile);
  expect(prompt).toContain('stay an insight with category cs, whether you know the answer or a person needs to check');
  expect(prompt).toContain('Decide response, escalate and hold separately');
  expect(prompt).toContain('for a\nquestion, say **what the visitor wants to know**');
  expect(prompt).not.toContain('If there is no insight in a general conversation');
 });
 it('preserves existing status-query and courtesy exceptions',()=>{
  const prompt=getSystemPrompt(profile);
  expect(prompt).toContain('A follow-up asking about the progress of an earlier report is other');
  expect(prompt).toContain('plain agreement or thanks with nothing new, set insight and extends to null');
 });
 // Fresh independent contract examples: declared expectations exercise policy routing only.
 it.each([
  ['예약 변경은 어디서 하나요?','cs','none'],
  ['필터는 작동하지만 선택 상태를 모르겠어요. 조건을 상단에 표시해 주세요.','ux','pr'],
  ['필터가 저장 후 사라져요. 복구 버튼이 있으면 좋겠어요.','bug','pr'],
  ['음성 녹음을 추가해 주세요.','feature_request','spec'],
  ['음성 녹음이 가능한가요?','cs','none'],
 ])('keeps action policy for %s',(_text,category,action)=>expect(groupAction(category)).toBe(action));
});
