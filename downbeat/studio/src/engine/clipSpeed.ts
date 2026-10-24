/** Shared limits for the edit's default speed and each segment's speed. */
export const CLIP_SPEED_MIN = 0.25;
export const CLIP_SPEED_MAX = 2;
export const CLIP_SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** A one-time tempo match. Invalid or unsupported ratios must not silently pick a different tempo. */
export function speedForBpm(source: number, target: number): number | null {
  if (!Number.isFinite(source) || !Number.isFinite(target) || source <= 0 || target <= 0) return null;
  const speed = target / source;
  return speed >= CLIP_SPEED_MIN && speed <= CLIP_SPEED_MAX ? speed : null;
}
