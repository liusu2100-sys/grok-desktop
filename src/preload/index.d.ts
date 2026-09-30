import type { DesktopApi } from "./index";

declare global {
  interface Window {
    grok: DesktopApi;
  }
}

export {};
