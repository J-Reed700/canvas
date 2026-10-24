import test from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from './fakes.mjs';
import { uploadMedia, upsertMedia } from '../downbeat/studio/src/lib/mediaClient.ts';

test('uploads validate metadata, retain legacy replies, and pass the file as a streamable body', async () => {
  const clip = { id: 'clip', duration: 3, name: 'A clip.mp4', proxy: 'queued' };
  const requests = stubFetch({ 'POST /api/upload': () => ({ ok: true, kind: 'video', id: 'clip', clip }) });
  const file = new File(['x'], 'A clip.mp4');
  assert.deepEqual((await uploadMedia(file)).clip, clip);
  assert.equal(requests[0].body, file);
  assert.equal(requests[0].headers['X-Filename'], 'A%20clip.mp4');
  for (const metadata of [undefined, { id: 'other', duration: 3 }, { id: 'clip', duration: 'bad' }]) {
    stubFetch({ 'POST /api/upload': () => ({ ok: true, kind: 'video', id: 'clip', clip: metadata }) });
    const result = await uploadMedia(file);
    assert.equal(result.ok, true);
    assert.equal(result.clip, undefined, 'missing or invalid metadata asks for one batch reconciliation');
  }
  const track = { id: 'song', name: 'song.wav', source: 'added' };
  stubFetch({ 'POST /api/upload': () => ({ ok: true, kind: 'audio', id: 'song', track }) });
  assert.deepEqual((await uploadMedia(new File(['x'], 'song.wav'))).track, track);
});

test('an HTTP failure, malformed JSON, bad envelope or network failure cannot add phantom media', async () => {
  const file = new File(['x'], 'bad.mov');
  for (const value of [null, {}, { ok: true, kind: 'other', id: 'x' }, { ok: true, kind: 'video', id: '' }, new Response('{', { status: 200 }), new Response(JSON.stringify({ ok: true, kind: 'video', id: 'x' }), { status: 500 })]) {
    stubFetch({ 'POST /api/upload': () => value });
    assert.equal((await uploadMedia(file)).ok, false);
  }
  stubFetch({ 'POST /api/upload': () => ({ ok: false, error: 'decoder failed' }) });
  assert.equal((await uploadMedia(file)).error, 'Could not add bad.mov: decoder failed');
  stubFetch({ 'POST /api/upload': () => { throw new Error('disconnected'); } });
  assert.match((await uploadMedia(file)).error, /disconnected/);
});

test('incremental library updates preserve order and replace duplicate ids', () => {
  const first = { id: 'a', name: 'old' }, second = { id: 'b', name: 'untouched' };
  const items = [first, second];
  assert.deepEqual(upsertMedia(items, { id: 'a', name: 'new' }), [{ id: 'a', name: 'new' }, second]);
  assert.deepEqual(upsertMedia(items, { id: 'c', name: 'added' }), [...items, { id: 'c', name: 'added' }]);
  assert.deepEqual(items, [first, second]);
});
