import type { CallNotesBridge } from "@callnotes/shared";

declare global {
  interface Window {
    callnotes: CallNotesBridge;
  }
}

export {};