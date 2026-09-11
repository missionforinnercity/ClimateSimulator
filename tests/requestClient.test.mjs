import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedFetch, cancelRequests, assertManifest, createAnalysisId } from '../public/requestClient.js';

test('analysis IDs work when randomUUID is unavailable on an HTTP deployment', () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  const id = createAnalysisId({ getRandomValues: target => { target.set(bytes); return target; } });
  assert.equal(id, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('newer request prevents an old body from becoming a result', async t => {
  let release;
  const stream = new ReadableStream({ start(c) { release = () => { c.enqueue(new TextEncoder().encode('{"old":true}')); c.close(); }; } });
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => ++call === 1 ? new Response(stream) : Response.json({ latest: true }));
  const first = await scopedFetch('http://localhost/api/heat/zones?metric=score&date=old');
  const old = first.json();
  const second = await scopedFetch('http://localhost/api/heat/zones?metric=score&date=new');
  assert.deepEqual(await second.json(), { latest: true });
  release();
  await assert.rejects(old, { name: 'AbortError' });
});
test('explicit cancel interrupts body decoding', async t => {
  let release;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) { release = () => { c.enqueue(new TextEncoder().encode('{}')); c.close(); }; } })));
  const response = await scopedFetch('http://localhost/api/wind/preview');
  const pending = response.json(); cancelRequests('wind'); release();
  await assert.rejects(pending, { name: 'AbortError' });
});
test('simulation errors do not retry and provide actionable busy errors', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}', { status: 503 }); });
  await assert.rejects(scopedFetch('http://localhost/api/traffic/closure-preview', { method: 'POST', body: '{}' }), /busy/);
  assert.equal(calls, 1);
});
test('safe idempotent metadata reads have bounded retries', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('', { status: 502 }) : Response.json({ status: 'ok' }));
  assert.deepEqual(await (await scopedFetch('http://localhost/api/health')).json(), { status: 'ok' });
  assert.equal(calls, 2);
});
test('timeout rejects a stalled request', async t => {
  t.mock.method(globalThis, 'fetch', (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  await assert.rejects(scopedFetch('http://localhost/api/heat/zones', { timeoutMs: 10 }), { name: 'AbortError' });
});
test('incompatible manifests fail before scene data is used', () => {
  assert.throws(() => assertManifest({ version: 2 }), /incompatible/);
  assert.throws(() => assertManifest({ version: 3, bounds: [0, 0, Infinity, 1] }), /incompatible/);
});
