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
   expect(prompt.indexOf('사용자가 명시한 기존 동작의 고장은 bug')).toBeLessThan(prompt.indexOf('2. **지금 이 앱에 없는 능력을 원하는가?**'));
   expect(prompt).toContain('새 능력 요청만으로 기존 불편이나 고장을 추측하지 마세요');
  }
 });
 it('retains inquiry records independently of answering and distinguishes their summaries',()=>{
  const prompt=getSystemPrompt(profile);
  expect(prompt).toContain('답을 알거나 담당자 확인이 필요해도 category 가 cs 인 insight 로 남겨');
  expect(prompt).toContain('response·escalate 는 답변 근거와 사람의 인계 필요에 따라 별도로 판단해');
  expect(prompt).toContain('문의는 **무엇을 알고 싶은지**');
  expect(prompt).not.toContain('insight가 없는 일반 대화면');
 });
 it('preserves existing status-query and courtesy exceptions',()=>{
  const prompt=getSystemPrompt(profile);
  expect(prompt).toContain('이전에 제보한 건의 진행 상황을 묻는 후속 문의는 other');
  expect(prompt).toContain('새 내용 없는 맞장구·감사만 있는 대화는 insight 와 extends 를 null');
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
