import type { DesktopApi } from "../ipc-contract.js";

declare global {
  interface Window {
    pspore: DesktopApi;
  }
}

export {};
