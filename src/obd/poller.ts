import { ElmError, type Elm327 } from '../elm/elm327';
import { ADAPTER_VOLTAGE_PID, type Signal } from './signals';
import { pidData } from './vehicle';

export interface Sample {
  /** Milliseconds since the session started. */
  t: number;
  signalId: string;
  /** Metric value, as decoded. */
  v: number;
  /** The data bytes this value was decoded from, as hex. Empty if none. */
  raw: string;
}

/** How often slow-changing signals (temperatures, long-term trims) are read. */
export const SLOW_INTERVAL_MS = 5000;
/** Consecutive empty replies before a PID is dropped for the session. */
const MAX_MISSES = 3;
/** Consecutive failed requests before polling gives up. */
const MAX_FAILURES = 5;

interface Slot {
  pid: number;
  signals: Signal[];
  slow: boolean;
  last: number;
  misses: number;
}

/**
 * Chooses the next PID to request. An ELM327 answers one request at a time,
 * so sample rate is a shared budget: slow signals get a turn only when due,
 * and the fast ones share everything else round-robin.
 */
export function pickNext<T extends { slow: boolean; last: number }>(slots: T[], now: number): T | null {
  const oldest = (list: T[]) => list.reduce<T | null>((best, s) => (!best || s.last < best.last ? s : best), null);
  const dueSlow = slots.filter((s) => s.slow && now - s.last >= SLOW_INTERVAL_MS);
  return oldest(dueSlow) ?? oldest(slots.filter((s) => !s.slow)) ?? oldest(slots);
}

export class Poller {
  private slots: Slot[] = [];
  private running = false;
  private loop: Promise<void> | null = null;
  /** Fixed at the first start, so pausing and resuming doesn't restart the log's clock. */
  private startedAt: number | null = null;
  onSample: (sample: Sample) => void = () => {};
  onError: (error: Error) => void = () => {};

  constructor(
    private readonly elm: Elm327,
    private readonly now: () => number = () => performance.now(),
  ) {}

  setSignals(signals: Signal[]): void {
    const previous = new Map(this.slots.map((s) => [s.pid, s]));
    const byPid = new Map<number, Signal[]>();
    for (const s of signals) byPid.set(s.pid, [...(byPid.get(s.pid) ?? []), s]);
    this.slots = [...byPid].map(([pid, sigs]) => ({
      pid,
      signals: sigs,
      slow: sigs.every((s) => s.rate === 'slow'),
      last: previous.get(pid)?.last ?? -Infinity,
      misses: 0,
    }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt ??= this.now();
    this.loop = this.run(this.startedAt);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(startedAt: number): Promise<void> {
    let failures = 0;
    while (this.running) {
      const slot = pickNext(this.slots, this.now());
      if (!slot) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      try {
        const reading = await this.read(slot);
        const t = Math.round(this.now() - startedAt);
        slot.last = this.now();
        failures = 0;
        if (!reading) {
          if (++slot.misses >= MAX_MISSES) this.slots = this.slots.filter((s) => s !== slot);
          continue;
        }
        slot.misses = 0;
        reading.values.forEach((v, i) => this.onSample({ t, signalId: slot.signals[i]!.id, v, raw: reading.raw }));
      } catch (e) {
        slot.last = this.now();
        // One-off glitches are normal on cheap adapters; a run of them isn't.
        const transient = e instanceof ElmError && (e.code === 'timeout' || e.code === 'bus');
        if (transient && ++failures < MAX_FAILURES) continue;
        this.running = false;
        this.onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  private async read(slot: Slot): Promise<{ values: number[]; raw: string } | null> {
    if (slot.pid === ADAPTER_VOLTAGE_PID) {
      const v = await this.elm.readVoltage();
      return v === null ? null : { values: [v], raw: '' };
    }
    const request = '01' + slot.pid.toString(16).toUpperCase().padStart(2, '0');
    const d = pidData(await this.elm.obdSingle(request), slot.pid);
    if (!d || slot.signals.some((s) => d.length < s.bytes)) return null;
    return {
      values: slot.signals.map((s) => s.decode(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0)),
      raw: d.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''),
    };
  }
}
