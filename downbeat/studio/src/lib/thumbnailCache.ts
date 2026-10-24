export type ThumbnailLoader = (
  image: HTMLImageElement, url: string, onReady: () => void, wanted: () => boolean,
) => () => void;

const directLoad: ThumbnailLoader = (image, url, onReady) => {
  const releaseHandlers = () => { image.onload = image.onerror = null; };
  image.onload = () => { releaseHandlers(); onReady(); };
  image.onerror = releaseHandlers;
  image.src = url;
  return () => { releaseHandlers(); image.removeAttribute('src'); };
};

/** Owns off-DOM timeline images and releases old decoded pictures and pending requests. */
export class ThumbnailCache {
  readonly images = new Map<string, HTMLImageElement>();
  readonly limit: number;
  private readonly create: () => HTMLImageElement;
  private readonly load: ThumbnailLoader;
  private readonly disposers = new WeakMap<HTMLImageElement, () => void>();

  constructor(limit = 512, create: () => HTMLImageElement = () => new Image(), load: ThumbnailLoader = directLoad) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Thumbnail capacity must be a positive integer');
    this.limit = limit;
    this.create = create;
    this.load = load;
  }

  get(key: string, url: string, onReady: () => void): HTMLImageElement {
    const existing = this.images.get(key);
    if (existing) {
      this.images.delete(key); this.images.set(key, existing);
      return existing;
    }
    const image = this.create();
    this.images.set(key, image);
    while (this.images.size > this.limit) this.release(this.images.keys().next().value!);
    this.disposers.set(image, this.load(image, url, onReady, () => this.images.get(key) === image));
    return image;
  }

  private release(key: string): void {
    const image = this.images.get(key);
    if (!image) return;
    this.images.delete(key);
    this.disposers.get(image)?.();
    this.disposers.delete(image);
  }

  clear(): void { for (const key of this.images.keys()) this.release(key); }
}
