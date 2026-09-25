/** Canonical application version - keep in sync with package.json versions. */

export const APP_VERSION = "0.1.0";
export const APP_NAME = "CallNotes AI";

export interface AppVersion {
  name: typeof APP_NAME;
  version: typeof APP_VERSION;
  node: string;
  platform: string;
  arch: string;
}