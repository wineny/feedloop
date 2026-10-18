import {describe,it,expect} from 'vitest';
import {reservationUsd,scoreContract} from '../scripts/eval-grouping-live-v1';
const id=(key:string)=>key;
const base={issues:[{id:'a',group_id:'g',category:'bug',source_intact:true},{id:'b',group_id:'g',category:'bug',source_intact:true}],groups:[{id:'g',status:'open',follow_up_pending:false,category:'bug'}],runs:0};
describe('grouping live evaluation contracts (no model calls)',()=>{
 it('reserves input bytes, overhead, full capped output before dispatch',()=>{
  expect(reservationUsd(1000)).toBe((1000+4096+4096*5)/1e6);
  expect(()=>reservationUsd(-1)).toThrow();
 });
 it('same and different require actual assigned group IDs',()=>{
  expect(scoreContract({id:'same',kind:'same',ids:['a','b']},base,id,false).correct).toBe(true);
  expect(scoreContract({id:'different',kind:'different',ids:['a','b']},base,id,false).correct).toBe(false);
  expect(scoreContract({id:'same',kind:'same',ids:['a','missing']},base,id,false).correct).toBe(false);
 });
 it('failed model/DB batch cannot be a semantic success',()=>{
  expect(scoreContract({id:'same',kind:'same',ids:['a','b']},base,id,true).correct).toBe(false);
 });
 it('existing target must match exactly; merged reuse also needs hold',()=>{
  expect(scoreContract({id:'old',kind:'existing',ids:['a'],target:'wrong'},base,id,false).correct).toBe(false);
  expect(scoreContract({id:'merged',kind:'merged',ids:['a'],target:'g'},base,id,false).correct).toBe(false);
  expect(scoreContract({id:'merged',kind:'merged',ids:['a'],target:'g'},{...base,groups:[{...base.groups[0],status:'merged',follow_up_pending:true}]},id,false).correct).toBe(true);
 });
 it('retained evidence is separately safe despite model failure but absent rows fail',()=>{
  expect(scoreContract({id:'retained',kind:'retained',ids:['a','b']},base,id,true)).toMatchObject({correct:true,safety:true,batchFailed:true});
  expect(scoreContract({id:'retained',kind:'retained',ids:['missing']},base,id,true).correct).toBe(false);
 });
 it('retention fails when source membership or original message content is missing',()=>{
  expect(scoreContract({id:'retained',kind:'retained',ids:['a']},{...base,issues:[{...base.issues[0],source_intact:false}]},id,false).correct).toBe(false);
 });
 it('uncertain report must be isolated or pending, never merged with known issue',()=>{
  expect(scoreContract({id:'uncertain',kind:'isolated-or-pending',ids:['a']},base,id,false).correct).toBe(false);
  expect(scoreContract({id:'uncertain',kind:'isolated-or-pending',ids:['a']},{...base,issues:[{...base.issues[0],group_id:null}]},id,false).correct).toBe(true);
 });
});
