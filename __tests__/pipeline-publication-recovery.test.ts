import {beforeEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({claim:vi.fn(),load:vi.fn(),execute:vi.fn(),group:vi.fn(),classify:vi.fn()}));
vi.mock('@/lib/auto-dev/execute-run',()=>({claimRun:state.claim,loadRun:state.load,executeClaimedRun:state.execute}));
vi.mock('@/lib/groups/grouping',()=>({runGrouping:state.group}));
vi.mock('@/lib/classify/recovery',()=>({runClassificationRecovery:state.classify}));
vi.mock('@/lib/supabase',()=>({getServiceRoleClient:()=>({from:()=>{
 const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:{id:'pending-run',group_id:'group'},error:null})};return q;
}})}));
import {runAutoPrForBot} from '@/lib/auto-dev/auto-pr';
beforeEach(()=>{vi.clearAllMocks();state.claim.mockResolvedValue('captured-token');state.load.mockResolvedValue({id:'pending-run',publication_status:'pending',status:'unverifiable'});state.execute.mockResolvedValue({pr_url:'https://github.com/qa/repo/pull/1'});});
it('cron resumes pending publication with its captured lease before grouping or generation',async()=>{
 const deadline=Date.now()+100_000;const result=await runAutoPrForBot('bot',deadline);
 expect(result).toMatchObject({runId:'pending-run',prUrl:'https://github.com/qa/repo/pull/1',error:null});
 expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({id:'pending-run'}),'captured-token',expect.any(Function),deadline);
 expect(state.group).not.toHaveBeenCalled();expect(state.classify).not.toHaveBeenCalled();
});
it('losing cron claimant never starts execution',async()=>{
 state.claim.mockResolvedValue(null);expect((await runAutoPrForBot('bot')).error).toBeTruthy();expect(state.execute).not.toHaveBeenCalled();
});
