import { useStudioStore } from '../state/StudioContext.tsx';
import { usePage } from './usePage.ts';

/** Back to page 1 when the search changes. */
export function useExportPage(count: number, per: number) {
  const { q, kind, sort } = useStudioStore((s) => s.exportFilter);
  return usePage(count, per, `${q}\n${kind}\n${sort}`);
}
