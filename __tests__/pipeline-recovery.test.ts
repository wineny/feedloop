import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc:vi.fn(), llm:vi.fn(), config:vi.fn(), recent:vi.fn(), extend:vi.fn(), refine:vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ rpc:mocks.rpc, from:() => {
 const chain: Record<string,unknown> = {};
 for(const key of ['select','in','eq']) chain[key]=()=>chain;
 chain.then=(resolve:(v:unknown)=>void)=>resolve({count:0,error:null}); return chain;
} }) }));
vi.mock('@/lib/classify/jev', () => ({ refineCategoryWithJev: mocks.refine }));
vi.mock('@/lib/bot/core', () => ({getBotConfigFromDB:mocks.config}));
vi.mock('@/lib/bot/handler', async (actual) => ({...await actual<object>(),callLlm:mocks.llm}));
vi.mock('@/lib/bot/conversations', () => ({ getRecentTurns:mocks.recent }));
vi.mock('@/lib/bot/reply-context', async (actual) => ({...await actual<object>(),listExtendableInsights:mocks.extend}));
import { buildInsightRefMap } from '@/lib/bot/reply-context';
import { runClassificationRecovery, prepareRecoveryCase, parseRecoveryResult } from '@/lib/classify/recovery';
const message={id:'m1',bot_id:'b1',body:'PC에서도 흰 화면입니다',conversation_id:'c1',detected_at:'2026-09-13T00:00:00Z',classification_lease:'lease1',context:null};
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.refine.mockImplementation(async (_text, insight) => ({ ...insight, category: 'bug', classified_by: 'jev', classify_confidence: 0.9 }));
 mocks.rpc.mockImplementation((name:string)=>Promise.resolve(name==='pipeline_claim_message'?{data:[],error:null}:{data:{id:'i1'},error:null}));
 mocks.rpc.mockImplementationOnce(()=>Promise.resolve({data:[message],error:null}));
 mocks.config.mockResolvedValue({serviceProfile:{serviceName:'QA',serviceFeatures:[],faq:[],knowledge:'',botName:'QA',botTone:'',serviceUrl:'',serviceDescription:'',serviceCompany:'',targetUsers:'',loginMethod:''},llmApiKeyEncrypted:'test-only'});
 mocks.recent.mockResolvedValue([{id:'older',kind:'user',body:'쿠폰함 지난내역에서 흰 화면',at:'2026-09-12'}]);
 mocks.extend.mockResolvedValue([{id:'i1',summary:'쿠폰함 흰 화면',category:'bug',source_message_ids:[]}]);
 mocks.llm.mockResolvedValue('{"response":null,"insight":null}');
});
describe('durable recovery production path',()=>{
 it('reuses context cutoff and accepts genuine no-insight completion',async()=>{
  const r=await runClassificationRecovery(['b1']);
  expect(mocks.recent).toHaveBeenCalledWith('c1',9,message.detected_at);
  expect(mocks.extend).toHaveBeenCalledWith('c1',message.detected_at);
  expect(mocks.llm.mock.calls[0][2]).toContain('쿠폰함 지난내역에서 흰 화면');
  expect(mocks.rpc).toHaveBeenCalledWith('pipeline_settle_insight',expect.objectContaining({p_insight:null,p_lease:'lease1'}));
  expect(r.failed).toBe(0);
 });
 it('null-insight supplement retains existing source association', async()=>{
  mocks.extend.mockResolvedValue([{id:'ab12cd34-0000-4000-8000-000000000001',summary:'쿠폰함 흰 화면',category:'bug',source_message_ids:[]}]);
  mocks.llm.mockResolvedValue(JSON.stringify({response:null,insight:null,extends:[...buildInsightRefMap(await mocks.extend()).keys()][0]}));
  const r=await runClassificationRecovery(['b1']);
  expect(mocks.rpc).toHaveBeenCalledWith('pipeline_settle_insight',expect.objectContaining({p_insight:null,p_extend_id:'ab12cd34-0000-4000-8000-000000000001'}));
  expect(r.missingHistoricalHint).toBe(1);
 });
 it('malformed JSON remains retryable rather than marked done',async()=>{
  mocks.llm.mockResolvedValue('{}');
  const r=await runClassificationRecovery(['b1']);
  expect(r.failed).toBe(1);
  expect(mocks.rpc).toHaveBeenCalledWith('pipeline_fail_message',expect.objectContaining({p_reason:'invalid_model_output'}));
  expect(mocks.rpc.mock.calls.some(([name])=>name==='pipeline_settle_insight')).toBe(false);
 });
 it('chip-only turn completes without model call',async()=>{
  mocks.rpc.mockReset().mockResolvedValue({data:[],error:null});
  mocks.rpc.mockResolvedValueOnce({data:[{...message,body:'불편한 점이 있어요'}],error:null}).mockResolvedValueOnce({data:{id:null},error:null});
  const r=await runClassificationRecovery(['b1']);
  expect(mocks.llm).not.toHaveBeenCalled();expect(mocks.refine).not.toHaveBeenCalled();expect(r.noInsight).toBe(1);
 });
 it('refines only new inserts and persists metadata through the atomic RPC', async () => {
  mocks.llm.mockResolvedValue(JSON.stringify({response:null, insight:{category:'ux',summary:'결제 진행 불가',sentiment:'negative'},escalate:true}));
  const r=await runClassificationRecovery(['b1']);
  expect(mocks.refine).toHaveBeenCalledWith(message.body,expect.objectContaining({category:'ux',follow_up_needed:true}));
  expect(mocks.rpc).toHaveBeenCalledWith('pipeline_settle_insight',expect.objectContaining({p_insight:expect.objectContaining({category:'bug',classified_by:'jev',classify_confidence:0.9,sentiment:'negative',follow_up_needed:true})}));
  expect(r.results.bug).toBe(1);
 });
 it('keeps supplement update classification and skips Jev', async () => {
  mocks.extend.mockResolvedValue([{id:'ab12cd34-0000-4000-8000-000000000001',summary:'쿠폰함 흰 화면',category:'bug',source_message_ids:[]}]);
  mocks.llm.mockResolvedValue(JSON.stringify({response:null,insight:{category:'ux',summary:'추가 근거',sentiment:'neutral'},extends:[...buildInsightRefMap(await mocks.extend()).keys()][0]}));
  await runClassificationRecovery(['b1']);
  expect(mocks.refine).not.toHaveBeenCalled();
  expect(mocks.rpc).toHaveBeenCalledWith('pipeline_settle_insight',expect.objectContaining({p_extend_id:'ab12cd34-0000-4000-8000-000000000001',p_insight:expect.objectContaining({category:'ux'})}));
 });
 it('expired shared deadline starts no work',async()=>{
  await runClassificationRecovery(['b1'],Date.now()-1);
  expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.llm).not.toHaveBeenCalled();
 });
});

describe('shared recovery preparation and policy',()=>{
 it('uses saved hints and reports missing historical hints explicitly',async()=>{
  const config=await mocks.config();
  const base={profile:config.serviceProfile,timeline:[],refMap:new Map(),messageId:'m',text:'내역 이동이 불편해요'};
  const saved=prepareRecoveryCase({...base,widget_hint:'feature'});
  expect(saved.user).toContain('feature_request');
  expect(saved.missingHistoricalHint).toBe(false);
  expect(prepareRecoveryCase(base).missingHistoricalHint).toBe(true);
 });
 it('applies the exact server holding policy and chip precedence',()=>{
  const raw=JSON.stringify({response:'일주일입니다',insight:{category:'cs',summary:'환불 기간 문의',sentiment:'neutral'},escalate:true});
  const result=parseRecoveryResult(raw,new Map(),'불편한 점이 있어요');
  expect(result.parsed.response).toContain('담당자가 확인하고 있어요');
  expect(result.plan).toEqual({action:'skip'});
 });
});

describe('recovery source-only courtesy boundary', () => {
  it.each([['네 고마워요', 'skip'], ['네, PC 크롬이에요', 'update']])('%s -> %s', (text, action) => {
    const raw=JSON.stringify({ response: null, insight: null, extends: 'ab12cd34' });
    expect(parseRecoveryResult(raw, new Map([['ab12cd34',{id:'i1'}]]), text).plan.action).toBe(action);
  });
});
