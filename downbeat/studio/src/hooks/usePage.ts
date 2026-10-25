import { useCallback, useState } from 'react';

/** The page shown: back to the first when `reset` changes, and never past the last when the list shrinks. */
export function usePage(count: number, per: number, reset: string) {
  const [pagination, setPagination] = useState({ reset, page: 0 });
  if (pagination.reset !== reset) setPagination({ reset, page: 0 });
  const page = pagination.reset === reset ? pagination.page : 0;
  const setPage = useCallback((page: number) => setPagination({ reset, page }), [reset]);
  const pages = Math.max(1, Math.ceil(count / per));
  return [Math.min(page, pages - 1), pages, setPage] as const;
}
