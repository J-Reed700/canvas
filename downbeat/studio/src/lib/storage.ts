export type StudioStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function browserStorage(): StudioStorage | null {
  try { return globalThis.localStorage ?? null; }
  catch { return null; }
}
