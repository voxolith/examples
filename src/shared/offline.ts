// The examples' service worker, registered by every page (through boot) and the landing page.
// Kept apart from boot.ts so the landing page does not pull in the renderer.

import { registerServiceWorker } from "@voxolith/engine/pwa";

/**
 * Register the examples' service worker (every page, once it has loaded), so the next visit to
 * any page works offline. It does nothing on a dev server or on localhost (the smoke run and the
 * benches), and tells nobody but the console.
 */
export function offline(): void {
  void registerServiceWorker({
    onOfflineReady: () => console.info("[offline] the examples are cached: they load offline from now on"),
    onUpdate: () => console.info("[offline] a new version of the examples is cached: reload to run it"),
  });
}
