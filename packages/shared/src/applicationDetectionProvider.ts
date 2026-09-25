import type { DetectionState } from "./detectionProvider.ts";

/**
 * Enumerate the applications for which CallNotes AI may provide
 * application‑specific call detection.  Only the platforms for which a
 * reliable, documented Windows API or integration exists are listed here.
 * New entries can be added later as support becomes available.
 */
export enum ApplicationName {
  WindowsAudio = "Windows Audio",
  MicrosoftTeams = "Microsoft Teams",
  WhatsApp = "WhatsApp",
  Discord = "Discord",
  Genesys = "Genesys",
  Browser = "Browser (WebRTC)",
}

/**
 * Information about a provider's view of the current call state.
 * The `application` field is only populated when the provider can actually
 * identify the source application; otherwise it is `undefined`.
 */
export interface ApplicationDetectionInfo {
  /** The application the state applies to, or undefined if generic. */
  application: ApplicationName | undefined;
  /** The detection state specific to that application. */
  state: DetectionState;
  /** A confidence score (0‑100) indicating how reliably the provider
   *  reached this state.  Higher values mean “more certain”. */
  confidence: number;
  /** ISO‑8601 timestamp when the state was determined. */
  timestamp: number;
}

/**
 * Provider that can report application‑specific call information.
 * Implementations may query native Windows APIs, browser extensions, or
 * other integration points.  The base interface only requires a method that
 * returns the latest info; concrete classes decide what they can actually
 * detect.
 */
export interface ApplicationDetectionProvider {
  /** Return the most recent detection info, or `null` if nothing is known. */
  getApplicationDetectionInfo(): ApplicationDetectionInfo | null;

  /** Start any background monitoring the provider needs (e.g. a browser
   *  extension message listener). */
  start(): void;

  /** Stop any background monitoring. */
  stop(): void;
}