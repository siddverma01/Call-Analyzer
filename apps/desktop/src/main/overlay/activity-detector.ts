import type { NativeAudioAddon } from "../audio/types.js";
import { downmixToMono, measureLevels } from "../audio/dsp/pcm.js";

/**
 * Detection for "a call/meeting is playing on this machine". It listens to the
 * Windows loopback (system audio) session and only watches signal ENERGY - it
 * does not transcribe, record, buffer, or upload anything. If the loopback
 * sink is unavailable, detection simply stays off (the two regular monitors
 * that power the app's meters remain untouched).
 *
 * The pure state machine (`SustainedActivityGate`) is unit-tested; the shallow
 * `CallActivityMonitor` shell just feeds real RMS measurements into it.
 */

export interface ActivityGateOptions {
  /** Sustained seconds of audible sound before raising (default 2 s). */
  confirmMs: number;
  /** Continuous quiet seconds before lowering again (default 5 s). */
  resetMs: number;
  /** RMS floor for "audible sound" (0 = silence, ~1 = full scale). */
  thresholdRms: number;
}

const DEFAULT_GATE_OPTIONS: ActivityGateOptions = {
  confirmMs: 2000,
  resetMs: 5000,
  thresholdRms: 0.004,
};

export class SustainedActivityGate {
  private activeSince = -1;
  private quietSince = -1;
  private raised = false;
  private readonly opts: ActivityGateOptions;

  constructor(opts?: Partial<ActivityGateOptions>) {
    this.opts = { ...DEFAULT_GATE_OPTIONS, ...opts };
  }

  /** True after sustained audible activity; false again after sustained quiet. */
  get isActive(): boolean {
    return this.raised;
  }

  /**
   * Feed one measurement. Returns true only on a rising OR falling transition
   * so callers can react exactly once per state change.
   */
  sample(rms: number, at: number): boolean {
    const audible = rms >= this.opts.thresholdRms;
    if (audible) {
      this.quietSince = -1;
      if (this.activeSince === -1) this.activeSince = at;
      if (!this.raised && at - this.activeSince >= this.opts.confirmMs) {
        this.raised = true;
        return true;
      }
      return false;
    }

    this.activeSince = -1;
    if (!this.raised) {
      this.quietSince = -1;
      return false;
    }
    if (this.quietSince === -1) this.quietSince = at;
    if (at - this.quietSince >= this.opts.resetMs) {
      this.raised = false;
      this.quietSince = -1;
      return true;
    }
    return false;
  }
}

export interface CallActivityMonitorDeps {
  addon: NativeAudioAddon | null;
  /** Called exactly once per state change (true = raised, false = lowered). */
  onChange: (active: boolean) => void;
  /** Injected clock (Date.now) so tests can advance simulated time. */
  now?: () => number;
  /** Poll cadence in ms (default 250 ms - plenty for a 2 s confirmation). */
  pollMs?: number;
  gate?: ActivityGateOptions;
}

/** Lightweight loopback energy watcher. Only exists while `start()` runs. */
export class CallActivityMonitor {
  private sessionId: number | null = null;
  private channels = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly gate: SustainedActivityGate;
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(private readonly deps: CallActivityMonitorDeps) {
    this.gate = new SustainedActivityGate(deps.gate);
    this.now = deps.now ?? (() => Date.now());
    this.pollMs = deps.pollMs ?? 250;
  }

  /** Opens the loopback session. Returns false when no addon is present. */
  start(): boolean {
    const addon = this.deps.addon;
    if (!addon) return false;
    try {
      const session = addon.createSession({ kind: "loopback", bufferMs: 100 });
      this.sessionId = session.id;
      this.channels = Math.max(1, session.channels);
      addon.sessionStart(this.sessionId);
      this.timer = setInterval(() => this.pollOnce(), this.pollMs);
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sessionId !== null && this.deps.addon) {
      try {
        this.deps.addon.sessionStop(this.sessionId);
        this.deps.addon.sessionRelease(this.sessionId);
      } catch {
        // best-effort teardown
      }
      this.sessionId = null;
    }
  }

  private pollOnce(): void {
    if (this.sessionId === null) return;
    const addon = this.deps.addon;
    if (!addon) return;
    let rms = 0;
    try {
      const pull = addon.sessionPull(this.sessionId, 4800);
      if (pull && pull.length > 0) {
        const mono = downmixToMono(pull, this.channels);
        rms = measureLevels(mono).rms;
      }
    } catch {
      return;
    }
    if (this.gate.sample(rms, this.now())) {
      this.deps.onChange(this.gate.isActive);
    }
  }
}