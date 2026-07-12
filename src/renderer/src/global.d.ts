import type { MarginApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    margin: MarginApi;
  }
}

export {};
