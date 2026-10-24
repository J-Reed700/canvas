import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// No test talks to a server unless it sets up its own routes (see `serve` in studio.tsx): anything else gets a 404.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })));
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
