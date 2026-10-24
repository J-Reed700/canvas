import test from 'node:test';
import assert from 'node:assert/strict';
import { ThumbnailCache } from '../downbeat/studio/src/lib/thumbnailCache.ts';

function fakeImage() {
  return { src: '', onload: null, onerror: null, removeAttribute(key) { if (key === 'src') this.src = ''; } };
}

test('timeline thumbnails keep recently used pictures and release old images and handlers', () => {
  const cache = new ThumbnailCache(2, fakeImage);
  let redraws = 0;
  const a = cache.get('a', '/a.jpg', () => redraws++);
  const b = cache.get('b', '/b.jpg', () => redraws++);
  assert.equal(cache.get('a', '/a.jpg', () => {}), a);
  const c = cache.get('c', '/c.jpg', () => redraws++);
  assert.deepEqual([...cache.images.keys()], ['a', 'c']);
  assert.equal(b.src, '');
  assert.equal(b.onload, null);
  assert.equal(b.onerror, null);
  a.onload();
  assert.equal(redraws, 1);
  assert.equal(a.onload, null, 'a decoded image no longer owns its redraw closure');
  c.onerror();
  assert.equal(c.onload, null);
  assert.equal(redraws, 1);
  cache.clear();
  assert.equal(a.src, '');
  assert.equal(c.src, '');
  assert.equal(cache.images.size, 0);
});

test('large thumbnail libraries remain bounded and invalid capacities are rejected', () => {
  const cache = new ThumbnailCache(8, fakeImage);
  for (let i = 0; i < 5000; i++) cache.get(String(i), `/${i}.jpg`, () => {});
  assert.equal(cache.images.size, 8);
  for (const limit of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => new ThumbnailCache(limit), /positive integer/);
});
