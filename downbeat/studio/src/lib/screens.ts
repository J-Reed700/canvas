// The screens the stage can preview on. Every export format renders at one of these shapes, so the
// export format is the only setting: the stage shows the shape of the format you'll export, and
// picking a screen picks a format of that shape.

export type ScreenId = 'phone' | 'landscape' | 'tablet' | 'square';

export interface Screen {
  id: ScreenId;
  name: string;
  ratio: string;
  /** Width / height. */
  aspect: number;
  /** What it's for, as the screen menu says. */
  use: string;
  /** Export formats with this shape. The first is the one a click on the screen picks. */
  formats: string[];
}

export const SCREENS: Screen[] = [
  { id: 'phone', name: 'Phone', ratio: '9:16', aspect: 9 / 16, use: 'Canvas, Reels, TikTok, Shorts', formats: ['spotify', 'social_vertical'] },
  { id: 'landscape', name: 'Landscape', ratio: '16:9', aspect: 16 / 9, use: 'YouTube visualizer', formats: ['youtube_16_9'] },
  { id: 'tablet', name: 'Tablet', ratio: '3:4', aspect: 3 / 4, use: 'Apple Music motion art', formats: ['apple_tall'] },
  { id: 'square', name: 'Square', ratio: '1:1', aspect: 1, use: 'Social feeds, Apple square art, cover art', formats: ['social_square', 'apple_square', 'cover_art'] },
];

/** The screen an export format renders for. */
export const screenOf = (format?: string): Screen => SCREENS.find((s) => s.formats.includes(format || 'spotify')) || SCREENS[0];

/** The format to export after switching to `screen`: the current one if it has that shape, otherwise the screen's first. */
export const formatFor = (screen: Screen, current?: string): string =>
  current && screen.formats.includes(current) ? current : screen.formats[0];

/** The screen after `current`, for the O shortcut. */
export const nextScreen = (current: Screen): Screen => SCREENS[(SCREENS.indexOf(current) + 1) % SCREENS.length];

/** A thumbnail size in the screen's shape, with the same area as a 9:16 thumbnail `tall` pixels high. */
export function thumbSize(screen: Screen, tall: number): [number, number] {
  const h = Math.round(Math.sqrt((tall * tall * 9) / 16 / screen.aspect));
  return [Math.round(h * screen.aspect), h];
}
