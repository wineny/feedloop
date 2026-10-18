import {beforeEach,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const state=vi.hoisted(()=>({claim:vi.fn(),load:vi.fn(),execute:vi.fn()}));
vi.mock('next-auth',()=>({getServerSession:async()=>({user:{id:'owner'}})}));
vi.mock('@/app/api/auth/[...nextauth]/route',()=>({authOptions:{}}));
vi.mock('@/lib/auto-dev/execute-run',()=>({claimRun:state.claim,loadRun:state.load,executeClaimedRun:state.execute,one:(v:unknown)=>v}));
import {GET} from '@/app/api/auto-dev/stream/route';
beforeEach(()=>vi.resetAllMocks());
it('manual pending retry passes exact claim token and refreshes persisted budget and receipt',async()=>{
 const old={id:'run',status:'unverifiable',publication_status:'pending',bots:{user_id:'owner'}};
 const fresh={...old,status:'in_progress',generation_budget:{calls:4},validation_evidence:{status:'validated'},publication_intent:{branch:'stable'}};
 state.load.mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);state.claim.mockResolvedValue('captured-token');
 state.execute.mockResolvedValue({pr_url:'https://github.com/qa/repo/pull/1',pr_number:1,files_changed:[]});
 const response=await GET(new NextRequest('http://localhost/api/auto-dev/stream?runId=run'));
 expect(await response.text()).toContain('"type":"complete"');
 expect(state.execute).toHaveBeenCalledWith(fresh,'captured-token',expect.any(Function),expect.any(Number));
 expect(state.load).toHaveBeenCalledTimes(2);
});

it.each([
 ['stopped','root_cause_unknown',null,'root_cause_unknown'],
 ['unverifiable','runner_profile_unavailable',null,'runner_profile_unavailable'],
 ['failed','old_stop','build failed','build failed'],
])('replays %s with its persisted reason and no execution',async(status,stopReason,errorMessage,reason)=>{
 state.load.mockResolvedValueOnce({id:'run',status,stop_reason:stopReason,error_message:errorMessage,publication_status:'none',bots:{user_id:'owner'}});
 const response=await GET(new NextRequest('http://localhost/api/auto-dev/stream?runId=run'));
 const event=JSON.parse((await response.text()).trim().replace(/^data: /,''));
 expect(event).toMatchObject({type:'error',status,reason,message:reason,recoverable:false});
 expect(state.claim).not.toHaveBeenCalled();expect(state.execute).not.toHaveBeenCalled();
});
it('reports freshly persisted stop consistently with later replay',async()=>{
 const active={id:'run',status:'running',bots:{user_id:'owner'}};
 state.load.mockResolvedValueOnce(active).mockResolvedValueOnce({...active,status:'in_progress'}).mockResolvedValueOnce({...active,status:'stopped',stop_reason:'no_change'});
 state.claim.mockResolvedValue('captured-token');state.execute.mockRejectedValue(new Error('no_change'));
 const response=await GET(new NextRequest('http://localhost/api/auto-dev/stream?runId=run'));
 const events=(await response.text()).trim().split('\n\n').map(line=>JSON.parse(line.replace(/^data: /,'')));
 expect(events.at(-1)).toMatchObject({type:'error',status:'stopped',reason:'no_change',message:'no_change'});
});
