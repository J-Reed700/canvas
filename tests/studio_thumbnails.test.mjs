import test from 'node:test';
import assert from 'node:assert/strict';
import { ThumbnailCache } from '../downbeat/studio/src/lib/thumbnailCache.ts';
import { cancelThumb, loadThumb, resetThumbs } from '../downbeat/studio/src/lib/thumbs.ts';

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

test('evicting queued or active timeline thumbnails preserves the two-request limit and releases callbacks', async (t) => {
  resetThumbs();
  t.after(resetThumbs);
  let redraws = 0;
  const cache = new ThumbnailCache(3, fakeImage, (image, url, ready, wanted) => {
    loadThumb(url, ready, image, wanted);
    return () => cancelThumb(image);
  });
  const a = cache.get('a', '/a', () => redraws++);
  const b = cache.get('b', '/b', () => redraws++);
  const c = cache.get('c', '/c', () => redraws++);
  await Promise.resolve();
  assert.equal(a.src, '', 'the oldest request waits behind the two newer ones');
  assert.equal(b.src, '/b');
  assert.equal(c.src, '/c');
  cache.get('d', '/d', () => redraws++);
  await Promise.resolve();
  assert.equal(a.src, '', 'an evicted queued request is never started');
  const late = b.onload;
  const e = cache.get('e', '/e', () => redraws++);
  assert.equal(b.src, '', 'an evicted active request is aborted');
  assert.equal(b.onload, null);
  assert.equal(b.onerror, null);
  late();
  await Promise.resolve();
  assert.equal(e.src, '', 'a late event from the cancelled request cannot free a second slot');
  c.naturalWidth = 200;
  c.onload();
  assert.equal(redraws, 1);
  assert.equal(e.src, '/e', 'completion makes room for the newest waiting request');
  cache.clear();
  assert.equal(e.onload, null);
  const next = loadThumb('/after-clear', () => redraws++, fakeImage());
  await Promise.resolve();
  assert.equal(next.src, '/after-clear', 'clearing the cache leaves the loader available');
  next.naturalWidth = 200;
  next.onload();
  assert.equal(redraws, 2, 'evicted thumbnails never redraw the retired timeline');
});

test('thumbnail reset cancels active and pending work without retaining loading slots', async (t) => {
  resetThumbs();
  t.after(resetThumbs);
  const images = Array.from({ length: 3 }, (_, i) => loadThumb(`/reset/${i}`, () => assert.fail('cancelled callback'), fakeImage()));
  await Promise.resolve();
  resetThumbs();
  for (const image of images) {
    assert.equal(image.src, '');
    assert.equal(image.onload, null);
    assert.equal(image.onerror, null);
  }
  const fresh = loadThumb('/fresh', undefined, fakeImage());
  await Promise.resolve();
  assert.equal(fresh.src, '/fresh');
});
