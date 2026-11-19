import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.mjs';
import { collectEntries, parseOperations, makePrompt } from '../src/extractor.mjs';
const src={sessionId:'session-1',entryId:'entry-1'};
function setup(){return new MemoryStore();}
test('upsert, update, global context and provenance',()=>{
 const db=setup();
 assert.equal(db.apply([{action:'upsert',category:'preferences',key:'color_scheme',value:'Prefers white interiors',confidence:0.95,importance:'high'}],src).upserted,1);
 assert.equal(db.count(),1);
 assert.match(db.context('white room'),/Prefers white interiors/);
 db.apply([{action:'upsert',category:'preferences',key:'color_scheme',value:'Prefers warm white interiors',confidence:0.95}],{sessionId:'session-2',entryId:'entry-2'});
 assert.equal(db.count(),1);
 assert.match(db.context('interiors'),/warm white/);
 assert.equal(db.db.prepare('SELECT count(*) AS n FROM evidence').get().n,2);
 db.close();
});
test('forget creates tombstone and blocks silent reintroduction',()=>{
 const db=setup();
 const op={action:'upsert',category:'goals',key:'home',value:'Wants a condo',confidence:0.9};
 db.apply([op],src);assert.equal(db.forget('goals/home'),1);assert.equal(db.count(),0);
 assert.equal(db.apply([op],src).upserted,0);
 assert.equal(db.apply([{...op,restore:true}],src).upserted,1);
 db.close();
});
test('protects common secrets and refuses flagged sensitive data',()=>{
 const db=setup();
 const ops=[
 {action:'upsert',category:'identity',key:'secret',value:'my password is abc',confidence:0.9},
 {action:'upsert',category:'identity',key:'diagnosis',value:'Has condition X',sensitive:true,confidence:0.9},
 ];
 assert.equal(db.apply(ops,src).upserted,0);db.close();
});
test('tracks entries across sessions and never mistakes tool output for user speech',()=>{
 const db=setup();
 const branch=[{type:'message',id:'a',message:{role:'user',content:'I like cats'}},{type:'message',id:'b',message:{role:'toolResult',content:'system prompt'}},{type:'message',id:'c',message:{role:'user',content:[{type:'text',text:'I also like dogs'}]}}];
 db.markSeen([{sessionId:'s',id:'a'}]);
 const pending=collectEntries(branch,'s',(s,id)=>db.isSeen(s,id));
 assert.deepEqual(pending.map(e=>e.id),['c']);
 const result=parseOperations('{"operations":[{"action":"upsert","category":"preferences","key":"pets","value":"Likes dogs","confidence":0.9,"source_entry":"c"},{"action":"upsert","category":"other","key":"bad","source_entry":"b"}]}',pending);
 assert.equal(result.length,1);
 assert.match(makePrompt(pending,[]),/Likes? dogs/i);
 db.close();
});
test('pause is persisted and export omits source transcript contents',()=>{
 const db=setup();db.setSetting('enabled',false);assert.equal(db.getSetting('enabled',true),false);
 db.apply([{action:'upsert',category:'other',key:'timezone',value:'America/Toronto',confidence:0.95}],src);
 const backup=db.export();assert.equal(backup.facts.length,1);assert.equal(JSON.stringify(backup).includes('raw transcript'),false);db.close();
});
