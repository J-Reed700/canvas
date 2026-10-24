// Thumbnails come from the studio's server, like the clips' video, and a browser keeps only six connections
// open to one server. A burst of thumbnails, one for every cut after a roll, every tile in the segment menu
// or every clip in the library, would take all six and leave a cut's video waiting behind them to load, for
// seconds when the server has to cut each thumbnail from an original file. So at most two load at a time,
// the latest asked for first, and one whose element has left the page or moved on to another is skipped.
const MAX_LOADING = 2;

type Job = { url: string; img: HTMLImageElement; done?: () => void; wanted?: () => boolean };

const waiting: Job[] = [];
const loaded = new Set<string>();
let loading = 0;
let queued = false;

function next() {
  queued = false;
  while (loading < MAX_LOADING && waiting.length) {
    const job = waiting.pop()!;
    if (job.wanted && !job.wanted()) continue;
    loading++;
    job.img.onload = job.img.onerror = () => {
      loading--;
      if (job.img.naturalWidth) loaded.add(job.url);
      job.done?.();
      next();
    };
    job.img.src = job.url;
  }
}

/** Loads `url` into `img` (a new image if none is given) when its turn comes, then calls `done`. The queue
 * moves on after the code asking has finished, so an element made for the page has been put on it by then. */
export function loadThumb(url: string, done?: () => void, img: HTMLImageElement = new Image(), wanted?: () => boolean): HTMLImageElement {
  if (loaded.has(url)) {
    img.onload = done ?? null;
    img.src = url;
    return img;
  }
  waiting.push({ url, img, done, wanted });
  if (!queued) {
    queued = true;
    queueMicrotask(next);
  }
  return img;
}

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
  loaded.clear();
  loading = 0;
  queued = false;
}
