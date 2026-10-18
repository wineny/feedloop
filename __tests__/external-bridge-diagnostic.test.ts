import { describe, expect, it, vi } from 'vitest';
import { main, safeBridgeDiagnostic } from '../scripts/qa-external-bridge-v2';

vi.mock('node:fs',async importOriginal=>({...await importOriginal<typeof import('node:fs')>(),existsSync:()=>true}));
describe('safe external bridge failure diagnostics',()=>{
 it('stops on the shared v1 intent before credentials or any network dispatch',async()=>{
  const argv=process.argv;const fetch=vi.fn(()=>{throw new Error('network forbidden');});vi.stubGlobal('fetch',fetch);
  process.argv=['node','scripts/qa-external-bridge-v2.ts','--execute'];
  try{await expect(main()).rejects.toThrow('bridge_reserved_no_blind_retry');expect(fetch).not.toHaveBeenCalled();}
  finally{process.argv=argv;vi.unstubAllGlobals();}
 });
 it('preserves known invariant and execution stage',()=>{
  expect(safeBridgeDiagnostic(new Error('live_git_identity_changed'),'live_preflight')).toEqual({version:'bridge-v2',stage:'live_preflight',code:'live_git_identity_changed',httpStatus:null});
  expect(safeBridgeDiagnostic(new Error('bridge_reserved_no_blind_retry'),'duplicate_guard').code).toBe('bridge_reserved_no_blind_retry');
 });
 it('records safe HTTP status without provider error bodies or credentials',()=>{
  const error=Object.assign(new Error('authorization token=FAKE_SECRET provider response confidential'),{status:403,response:{data:{token:'FAKE_SECRET'}}});
  const diagnostic=safeBridgeDiagnostic(error,'create_deployment');
  expect(diagnostic).toEqual({version:'bridge-v2',stage:'create_deployment',code:'external_or_storage_failure',httpStatus:403});
  expect(JSON.stringify(diagnostic)).not.toContain('FAKE_SECRET');
  expect(JSON.stringify(diagnostic)).not.toContain('confidential');
  expect(safeBridgeDiagnostic(error,'FAKE_SECRET' as never).stage).toBe('unknown_stage');
 });
 it('ignores malformed status and retains only fixed filesystem codes',()=>{
  expect(safeBridgeDiagnostic({status:'403',message:'FAKE_SECRET'},'provider_readback').httpStatus).toBeNull();
  expect(safeBridgeDiagnostic({status:9999},'provider_readback').httpStatus).toBeNull();
  expect(safeBridgeDiagnostic({code:'EEXIST',path:'/private/FAKE_SECRET'},'lock').code).toBe('lock_or_receipt_exists');
 });
});
