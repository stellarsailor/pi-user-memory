import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.mjs';
import { embedTexts, indexPendingFacts, queryEmbedding, createResilientRecall } from '../src/semantic.mjs';

const opts = {
  localOnly: true,
  embeddings: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-embed' },
};
const source = { sessionId: 'session-abc', entryId: 'msg-123' };
const add = (db, key, value, session = source) => db.apply([
  { action: 'upsert', category: 'projects', key, value, confidence: 0.95 },
], session);

test('embeddings are opt-in, loopback-only by default, and reject redirects', async () => {
  assert.deepEqual(await embedTexts(['test'], {}), []);
  let sent = 0;
  const mock = async (url, req) => {
    sent++;
    assert.equal(url, 'http://127.0.0.1:11434/v1/embeddings');
    assert.equal(req.redirect, 'error');
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(req.body).input, ['hello']);
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
  };
  assert.deepEqual(await embedTexts(['hello'], opts, mock), [[1, 0]]);
  await assert.rejects(embedTexts(['secret'], {
    ...opts, embeddings: { ...opts.embeddings, baseUrl: 'https://example.com/v1' },
  }, mock), /localOnly/);
  assert.equal(sent, 1, 'private text must not reach an external endpoint');
  await assert.rejects(embedTexts(['hello'], opts, async () => ({
    ok: true, json: async () => ({ data: [{ index: 0, embedding: [NaN] }] }),
  })), /invalid vector/);
});

test('index pending facts, rank by cosine, invalidate on updates and forget', async () => {
  const db = new MemoryStore();
  add(db, 'ui_palette', 'Uses a sea-green interface');
  add(db, 'hosting', 'Deploys projects on a cloud platform');
  const facts = db.facts();
  const vectorsByText = (s) => s.includes('sea-green') ? [1, 0] : [0, 1];
  const fakeFetch = async (_url, req) => {
    const texts = JSON.parse(req.body).input;
    return { ok: true, json: async () => ({
      data: texts.map((t, index) => ({ index, embedding: vectorsByText(t) })),
    }) };
  };
  assert.equal(await indexPendingFacts(db, opts, 24, fakeFetch), 2);
  assert.equal(await indexPendingFacts(db, opts, 24, fakeFetch), 0);
  const query = await queryEmbedding('coastal atmosphere', opts,
    async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) }));
  const scores = db.semanticScores(query, 'test-embed');
  const ranked = db.context('coastal atmosphere', 2000, scores);
  assert.ok(ranked.indexOf('sea-green') < ranked.indexOf('cloud platform'),
    'semantic similarity should influence ranking even without exact word overlap');
  assert.doesNotMatch(ranked, /source: session=/, 'default memory context should remain compact');
  assert.match(db.context('coastal atmosphere', 2000, scores, {includeSources: true}),
    /source: session="session-abc", entry="msg-123"/);

  const color = facts.find((f) => f.key === 'ui_palette');
  assert.ok(db.sourceReferences('projects/ui_palette').evidence.length === 1);
  add(db, 'ui_palette', 'Now uses navy blue', { sessionId: 'session-def', entryId: 'msg-456' });
  assert.ok(!db.semanticScores(query, 'test-embed').has(color.id), 'old vectors must be invalidated');
  assert.equal(db.saveVector(color.id, 'Uses a sea-green interface', 'test-embed', [1, 0]), false,
    'an in-flight embedding cannot overwrite a concurrently updated fact');
  assert.equal(db.pendingVectors('test-embed').length, 1);
  const refs = db.sourceReferences('projects/ui_palette');
  assert.equal(refs.fact.sourceEntry, 'msg-456');
  assert.equal(refs.evidence.length, 2, 'source history retains both message references');
  assert.ok(refs.evidence.some((e) => e.entryId === 'msg-123'));
  assert.equal(await indexPendingFacts(db, opts, 24, fakeFetch), 1);
  assert.equal(db.forget('projects/ui_palette'), 1);
  assert.equal(db.sourceReferences('projects/ui_palette'), null);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM fact_vectors').get().n, 1,
    'forgotten fact vectors are cascade-deleted');
  db.close();
});

test('short recall timeout, temporary backoff and configuration-change recovery', async () => {
  let clock = 1000;
  let attempts = 0;
  let fail = true;
  const fakeFetch = async (_url, options) => {
    attempts++;
    if (fail) {
      return new Promise((_resolve, reject) => {
        // AbortSignal.timeout uses an unref timer: retain a live handle in this mocked
        // hung-request test so Node's test runner does not cancel the pending promise.
        const keepAlive = setTimeout(() => reject(new Error('mock server still hung')), 250);
        options.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(options.signal.reason);
        }, { once: true });
      });
    }
    return { ok: true, json: async () => ({data: [{index: 0, embedding: [1, 0]}]}) };
  };
  const recall = createResilientRecall({
    fetchImpl: fakeFetch, now: () => clock, cooldownMs: 1000, recallTimeoutMs: 35,
  });
  assert.equal(await recall('ocean colors', opts), null, 'hung fetch should not block indefinitely');
  assert.equal(attempts, 1);
  fail = false;
  assert.equal(await recall('ocean colors', opts), null, 'failure should trigger temporary lexical fallback');
  assert.equal(attempts, 1, 'a prompt during cooldown should not request embeddings');
  clock = 2001;
  assert.deepEqual(await recall('ocean colors', opts), [1, 0], 'resume semantic ranking after backoff');
  assert.equal(attempts, 2);

  // A changed model should clear the previous endpoint's breaker immediately.
  fail = true;
  const changed = {...opts, embeddings: {...opts.embeddings, model: 'test-embed-2'}};
  assert.equal(await recall('ocean colors', changed), null);
  assert.equal(attempts, 3);
  fail = false;
  assert.deepEqual(await recall('ocean colors', opts), [1, 0]);
  assert.equal(attempts, 4);
});

test('endpoint canonicalization, remote opt-in and HTTP failures', async () => {
  const calls = [];
  const mock = async (url) => {
    calls.push(url);
    return {ok: true, json: async () => ({data: [{index: 0, embedding: [1, 0]}]})};
  };
  const a = {...opts, embeddings: {...opts.embeddings, baseUrl: 'http://localhost:11434/v1/embeddings?debug=1#frag'}};
  const b = {...opts, embeddings: {...opts.embeddings, baseUrl: 'http://localhost:11434/v1/?debug=1'}};
  await embedTexts(['hello'], a, mock);
  await embedTexts(['hello'], b, mock);
  assert.deepEqual(calls, ['http://localhost:11434/v1/embeddings','http://localhost:11434/v1/embeddings']);

  const remote = {...opts, localOnly: false, embeddings: {...opts.embeddings, baseUrl: 'https://api.example.com/v1'}};
  await embedTexts(['hello'], remote, mock);
  assert.equal(calls[2], 'https://api.example.com/v1/embeddings');
  await assert.rejects(embedTexts(['hello'], opts, async () => ({ok: false, status: 503})), /HTTP 503/);
});

test('rejects mismatched vector dimensions and excessively large responses', async () => {
  await assert.rejects(embedTexts(['first', 'second'], opts,
    async () => ({ok: true, json: async () => ({data: [
      {index:0, embedding:[1,0]}, {index:1, embedding:[0,1,0]},
    ]})})), /dimensions differ/);
  await assert.rejects(embedTexts(['single'], opts, async () => ({
    ok: true, json: async () => ({data: [{index:0, embedding:[1]}], junk: 'x'.repeat(4*1024*1024)}),
  })), /response too large/);
});
