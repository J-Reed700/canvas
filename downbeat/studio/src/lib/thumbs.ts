// Thumbnails come from the studio's server, like the clips' video, and a browser keeps only six connections
// open to one server. A burst of thumbnails, one for every cut after a roll, every tile in the segment menu
// or every clip in the library, would take all six and leave a cut's video waiting behind them to load, for
// seconds when the server has to cut each thumbnail from an original file. So at most two load at a time,
// the latest asked for first, and one whose element has left the page or moved on to another is skipped.
const MAX_LOADING = 2;
const MAX_LOADED = 1024;

type Job = { url: string; img: HTMLImageElement; done?: () => void; wanted?: () => boolean };

const waiting: Job[] = [];
const loaded = new Set<string>();
const cancellations = new Map<HTMLImageElement, () => void>();
let loading = 0;
let queued = false;

function next() {
  queued = false;
  while (loading < MAX_LOADING && waiting.length) {
    const job = waiting.pop()!;
    if (job.wanted && !job.wanted()) {
      cancellations.delete(job.img);
      continue;
    }
    loading++;
    let finished = false;
    const finish = (notify: boolean) => {
      if (finished) return;
      finished = true;
      loading--;
      job.img.onload = job.img.onerror = null;
      cancellations.delete(job.img);
      if (notify && job.img.naturalWidth) {
        loaded.add(job.url);
        if (loaded.size > MAX_LOADED) loaded.delete(loaded.values().next().value!);
      }
      try { if (notify && (!job.wanted || job.wanted())) job.done?.(); }
      finally { next(); }
    };
    cancellations.set(job.img, () => {
      job.img.onload = job.img.onerror = null;
      job.img.removeAttribute('src');
      finish(false);
    });
    job.img.onload = job.img.onerror = () => finish(true);
    job.img.src = job.url;
  }
}

/** Loads `url` into `img` (a new image if none is given) when its turn comes, then calls `done`. The queue
 * moves on after the code asking has finished, so an element made for the page has been put on it by then. */
export function loadThumb(url: string, done?: () => void, img: HTMLImageElement = new Image(), wanted?: () => boolean): HTMLImageElement {
  cancelThumb(img);
  if (loaded.has(url)) {
    const release = () => {
      img.onload = img.onerror = null;
      cancellations.delete(img);
    };
    img.onload = () => { release(); if (!wanted || wanted()) done?.(); };
    img.onerror = release;
    cancellations.set(img, () => { release(); img.removeAttribute('src'); });
    img.src = url;
    return img;
  }
  const job = { url, img, done, wanted };
  waiting.push(job);
  cancellations.set(img, () => {
    const index = waiting.indexOf(job);
    if (index >= 0) waiting.splice(index, 1);
    cancellations.delete(img);
  });
  if (!queued) {
    queued = true;
    queueMicrotask(next);
  }
  return img;
}

/** Release a queued or active request without retaining its callback or occupying a loading slot. */
export function cancelThumb(img: HTMLImageElement): void { cancellations.get(img)?.(); }

/** Shows a thumbnail as an element's background once it has loaded; until then the element keeps what it had. */
export function thumbBackground(el: HTMLElement, url: string): void {
  if (el.dataset.thumb === url) return;
  el.dataset.thumb = url;
  const show = () => { if (el.dataset.thumb === url) el.style.backgroundImage = `url(${url})`; };
  if (loaded.has(url)) show();
  else loadThumb(url, show, undefined, () => el.dataset.thumb === url && el.isConnected !== false);
}

/** The same for an element React draws: `ref={thumbRef(url)}`, with no backgroundImage in its style. */
export const thumbRef = (url: string) => (el: HTMLElement | null) => { if (el) thumbBackground(el, url); };

/** For tests. */
export function resetThumbs(): void {
  waiting.length = 0;
  for (const cancel of [...cancellations.values()]) cancel();
  cancellations.clear();
  loaded.clear();
  loading = 0;
  queued = false;
}
