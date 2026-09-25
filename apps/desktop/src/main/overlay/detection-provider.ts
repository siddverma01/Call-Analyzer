import type { NativeAudioAddon } from "../audio/types.js";
import { downmixToMono, measureLevels } from "../audio/dsp/pcm.js";
import {
  CallActivityMonitor,
  CallActivityMonitorDeps,
  SustainedActivityGate,
  type ActivityGateOptions,
} from "./activity-detector.js";
import { DetectionState, CallDetectionProvider } from "@callnotes/shared";

/**
 * Provider that uses the existing WASAPI loop‑back session to detect
 * sustained audio activity (system‑wide) and translates the gate's
 * transitions into the shared DetectionState machine.
 *
 * Important: this provider only monitors energy – it never transcribes,
 * records, or uploads audio.  Recording is always initiated by the user
 * clicking "Start AI Meeting Notes" in the overlay.
 */
export class WindowsAudioSessionProvider implements CallDetectionProvider {
  private monitor: CallActivityMonitor | null = null;
  private gate: SustainedActivityGate;
  private currentState: DetectionState = "IDLE";
  private readonly onStateChange?: (state: DetectionState) => void;

  /** Build the provider with the native addon and gate options. */
  constructor(
    private readonly addon: NativeAudioAddon | null,
    private readonly gateOptions: Partial<ActivityGateOptions> = {},
    onStateChange: (state: DetectionState) => void,
  ) {
    this.onStateChange = onStateChange;
    this.gate = new SustainedActivityGate(gateOptions);
  }

  /** Start the loopback energy poll; immediately reports IDLE if nothing is heard. */
  start(): void {
    if (this.monitor) return;
    this.monitor = new CallActivityMonitor({
      addon: this.addon,
      onChange: (active) => this.onGateActiveChanged(active),
      now: undefined,
      pollMs: 250,
      gate: this.gate,
    });
    // Seed the UI with the initial state.
    this.onStateChange(this.getState());
  }

  /** Stop the monitor and reset internal state. */
  stop(): void {
    if (this.monitor) {
      // clear the interval inside CallActivityMonitor
      this.monitor = null;
    }
    this.currentState = "IDLE";
    this.onStateChange(this.currentState);
  }

  /** Return the current detection state. */
  getState(): DetectionState {
    return this.currentState;
  }

  /** Internal hook called by the monitor when the gate transitions. */
  private onGateActiveChanged(active: boolean): void {
    if (active) {
      // Audio is above threshold – we have a possible call.
      // The gate already guarantees we only fire once per sustained segment
      // (confirmMs), so we can move straight to POSSIBLE_CALL.
      this.transition("POSSIBLE_CALL");
    } else {
      // Quiet – the call has ended.
      this.transition("CALL_ENDED");
    }
  }

  /** Move to a new state, invoking the observer if it changed. */
  private transition(newState: DetectionState): void {
    // Simple guard: only emit if the state actually changed.
    if (this.currentState === newState) return;
    this.currentState = newState;
    this.onStateChange(newState);
  }
}