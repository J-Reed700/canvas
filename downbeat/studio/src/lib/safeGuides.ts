import type { ScreenId } from './screens.ts';

export interface SafeGuide {
  id: string;
  name: string;
  screen: ScreenId;
  /** Conservative layout reserves, percentages from each edge; not a platform compliance test. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  topLabel: string;
  bottomLabel: string;
  sideLabel: string;
  source: string;
}

export const SAFE_GUIDES: SafeGuide[] = [
  { id: 'spotify', name: 'Spotify Canvas', screen: 'phone', top: 14, bottom: 33, left: 9, right: 9, topLabel: 'TOP UI', bottomLabel: 'PLAYER CONTROLS', sideLabel: 'TALL PHONE CROP', source: 'https://support.spotify.com/us/artists/article/canvas-guidelines/' },
  { id: 'tiktok', name: 'TikTok', screen: 'phone', top: 13, bottom: 35, left: 11, right: 22, topLabel: 'TOP UI', bottomLabel: 'CAPTION + CTA', sideLabel: 'ACTION BUTTONS', source: 'https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads' },
  { id: 'reels', name: 'Instagram Reels', screen: 'phone', top: 14, bottom: 35, left: 6, right: 16, topLabel: 'TOP UI', bottomLabel: 'CAPTION + CONTROLS', sideLabel: 'ACTION BUTTONS', source: 'https://developers.meta.com/vr/resources/optimize-ad-campaign/' },
  { id: 'shorts', name: 'YouTube Shorts', screen: 'phone', top: 12, bottom: 25, left: 6, right: 18, topLabel: 'TOP UI', bottomLabel: 'TITLE + CONTROLS', sideLabel: 'ACTION BUTTONS', source: 'https://support.google.com/youtube/answer/16215842' },
  { id: 'apple', name: 'Apple Music 3:4', screen: 'tablet', top: 15, bottom: 25, left: 8, right: 8, topLabel: 'NOTCH + NAVIGATION', bottomLabel: 'ALBUM UI + GRADIENT', sideLabel: 'EDGE MARGIN', source: 'https://help.apple.com/itc/albummotionguide/en.lproj/static.html' },
  { id: 'square', name: 'Square composition', screen: 'square', top: 5, bottom: 5, left: 5, right: 5, topLabel: 'COMPOSITION MARGIN', bottomLabel: 'COMPOSITION MARGIN', sideLabel: 'MARGIN', source: 'https://help.apple.com/itc/albummotionguide/en.lproj/static.html' },
  { id: 'landscape', name: 'Landscape titles', screen: 'landscape', top: 10, bottom: 10, left: 10, right: 10, topLabel: 'TITLE MARGIN', bottomLabel: 'TITLE MARGIN', sideLabel: 'MARGIN', source: 'https://support.google.com/youtube/answer/16215842' },
];

/** A guide never changes the export. A changed export shape always gets a compatible guide. */
export function guideFor(screen: ScreenId, selected?: string, format?: string): SafeGuide {
  return SAFE_GUIDES.find((g) => g.id === selected && g.screen === screen)
    || SAFE_GUIDES.find((g) => g.id === (format === 'social_vertical' ? 'reels' : '') && g.screen === screen)
    || SAFE_GUIDES.find((g) => g.screen === screen)!;
}
