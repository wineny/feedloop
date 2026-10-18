import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({llm:vi.fn(),save:vi.fn(),config:vi.fn()}));
vi.mock('@/lib/bot/handler',()=>({callLlm:mocks.llm}));
vi.mock('@/lib/bot/core',()=>({getBotConfigFromDB:mocks.config}));
vi.mock('@/lib/supabase',()=>({getServiceRoleClient:vi.fn()}));
vi.mock('@/lib/bot/conversations',()=>({
 upsertConversation:vi.fn().mockResolvedValue({id:'c1',contact_name:null}),saveWebMessage:mocks.save,
 saveConversationResponse:vi.fn(),getRecentTurns:vi.fn(),getTimeline:vi.fn(),markConversationEscalated:vi.fn(),needsEscalation:vi.fn(),
}));
vi.mock('@/lib/widget/http',async(actual)=>({
 ...await actual<object>(),resolveWidgetBot:vi.fn().mockResolvedValue({service_name:'QA'}),checkWriteRate:vi.fn().mockResolvedValue(null),
 // messages 라우트는 「어느 상한인지」를 보는 판정기를 쓴다(봇 상한이면 저장하고 LLM 만 건너뛴다).
 checkWidgetWriteRate:vi.fn().mockResolvedValue({ok:true}),
}));
import { POST } from '@/app/api/widget/[botId]/messages/route';
describe('intake must be durable before model work or acknowledgment',()=>{
 it('failed web save returns 503, no config/LLM/ack',async()=>{
  mocks.save.mockResolvedValue(null);
  const request=new NextRequest('http://localhost/api/widget/b1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({visitorId:'35028c5f-bfce-4761-980d-ad6874a9b6ea',text:'쿠폰함 화면이 안 열려요'})});
  const response=await POST(request,{params:Promise.resolve({botId:'b1'})});
  expect(response.status).toBe(503);expect(mocks.llm).not.toHaveBeenCalled();expect(mocks.config).not.toHaveBeenCalled();
  expect(JSON.stringify(await response.json())).not.toContain('잘 받았어요');
 });
});
