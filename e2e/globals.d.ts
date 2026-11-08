// What the suite's page code (page.evaluate) sees on window: the test handle the client exposes
// (web/src/session.ts). A property a scenario puts on window itself is typed where it is used
// (`window as unknown as { __said: string[] }`), so scenarios stay independent of each other.
/// <reference types="vite/client" />
import type { HqHandle } from "../web/src/session.ts";

declare global {
  interface Window {
    __hq: HqHandle;
  }
}
export {};
