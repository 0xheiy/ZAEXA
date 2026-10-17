import { AsyncLocalStorage } from 'node:async_hooks';

// Each scheduled pass owns its budget, memo and pacing queue. Public requests
// keep the platform fetch/cache implementations, even while a pass is waiting.
export const reportContext = new AsyncLocalStorage();
export function fetch(input, init) {
  const meter = reportContext.getStore()?.meter;
  return meter ? meter.fetch(input, init) : globalThis.fetch(input, init);
}
export function cacheStore() {
  const meter = reportContext.getStore()?.meter;
  if (meter) return {
    match: async () => { meter.cacheSkip(); return undefined; },
    put: async () => { meter.cacheSkip(); },
  };
  return typeof caches !== 'undefined' ? caches.default : null;
}
