import type { MarginApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    margin: MarginApi;
  }

  /** package.json version, inlined by electron-vite (see electron.vite.config.ts). */
  const __APP_VERSION__: string;
}

export {};
