/**
 * Detection‑state type used by every CallDetectionProvider implementation.
 * The overlay UI and controller react to these states; they must not be
 * interpreted as “recording has started” – only the explicit user action
 * (Start AI Meeting Notes) triggers recording.
 */
export type DetectionState =
  | "IDLE"
  | "POSSIBLE_CALL"
  | "CALL_DETECTED"
  | "OVERLAY_SHOWN"
  | "USER_ACCEPTED"
  | "RECORDING"
  | "CALL_ENDED";

/**
 * Abstraction over different call‑detection sources.
 * Implementations decide how activity is detected (loopback audio, microphone,
 * Windows communication APIs, etc.) and push exactly one state change per
 * meaningful transition so the overlay logic stays simple and deterministic.
 */
export interface CallDetectionProvider {
  /** Begin monitoring for call activity. */
  start(): void;

  /** Stop monitoring. */
  stop(): void;

  /** Called whenever the detection state changes. */
  onStateChange?: (state: DetectionState) => void;

  /** Return the current detection state. */
  getState(): DetectionState;
}