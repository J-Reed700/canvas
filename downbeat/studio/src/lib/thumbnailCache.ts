/** Owns off-DOM timeline images and releases old decoded pictures and pending handlers. */
export class ThumbnailCache {
  readonly images = new Map<string, HTMLImageElement>();
  readonly limit: number;
  private readonly create: () => HTMLImageElement;

  constructor(limit = 512, create: () => HTMLImageElement = () => new Image()) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Thumbnail capacity must be a positive integer');
    this.limit = limit;
    this.create = create;
  }

  get(key: string, url: string, onReady: () => void): HTMLImageElement {
    const existing = this.images.get(key);
    if (existing) {
      this.images.delete(key); this.images.set(key, existing);
      return existing;
    }
    const image = this.create();
    const releaseHandlers = () => { image.onload = image.onerror = null; };
    image.onload = () => { releaseHandlers(); onReady(); };
    image.onerror = releaseHandlers;
    this.images.set(key, image);
    while (this.images.size > this.limit) this.release(this.images.keys().next().value!);
    image.src = url;
    return image;
  }

  private release(key: string): void {
    const image = this.images.get(key);
    if (!image) return;
    image.onload = image.onerror = null;
    image.removeAttribute('src');
    this.images.delete(key);
  }

  clear(): void { for (const key of this.images.keys()) this.release(key); }
}
