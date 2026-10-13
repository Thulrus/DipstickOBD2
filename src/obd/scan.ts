import type { Elm327 } from '../elm/elm327';
import type { Message } from '../elm/parse';
import { decodeDtc } from './dtc';
import { SIGNALS } from './signals';

/**
 * A one-off "everything the vehicle will tell us" read, taken alongside the
 * trouble codes. This is the context an AI assistant (or a mechanic) wants
 * next to a code: what the engine was doing when the fault was recorded, and
 * how the vehicle's own self-tests are scoring.
 */
export interface VehicleScan {
  readAt: number;
  /** Sensor values the engine computer saved at the moment a fault was confirmed. */
  freezeFrame: FreezeFrame | null;
  /** Fuel control state per fuel system, e.g. closed loop. */
  fuelSystem: string[];
  /** Which OBD standard the vehicle says it follows. */
  obdStandard: string | null;
  /** One reading of every supported signal (metric), keyed by signal id. */
  snapshot: Record<string, number>;
  /** Results of the vehicle's own component self-tests (service 06). */
  monitorTests: MonitorTest[];
}

export interface FreezeFrame {
  /** The code that caused the frame to be stored. */
  dtc: string;
  /** Metric values keyed by signal id. */
  values: Record<string, number>;
}

export interface MonitorTest {
  monitor: string;
  test: string;
  /**
   * Raw, unscaled numbers straight from the vehicle. `unitId` is the SAE
   * J1979 unit-and-scaling id when the vehicle gives one. Pass/fail does not
   * depend on scaling: it only compares value against the limits.
   */
  value: number;
  min: number | null;
  max: number | null;
  unitId: string | null;
  passed: boolean;
  /** The record exactly as the vehicle sent it (hex), ids included. */
  raw?: string;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hex = (bytes: number[]) => bytes.map(hex2).join(' ');
const word = (hi: number | undefined, lo: number | undefined) => ((hi ?? 0) << 8) | (lo ?? 0);

/** ORs together the "which ids do you support" bitmasks for one service. */
async function readSupported(elm: Elm327, service: number, suffix = ''): Promise<number[]> {
  const ids: number[] = [];
  const skip = suffix ? 3 : 2; // bytes before the mask: service, id, [frame]
  for (let base = 0; base <= 0xe0; base += 0x20) {
    const messages = await elm.obd(hex2(service) + hex2(base) + suffix);
    let more = false;
    for (const { data } of messages) {
      if (data[0] !== service + 0x40 || data[1] !== base) continue;
      for (let i = 0; i < 32; i++) {
        if ((data[skip + (i >> 3)] ?? 0) & (0x80 >> (i & 7))) {
          if (i === 31) more = true;
          else if (!ids.includes(base + i + 1)) ids.push(base + i + 1);
        }
      }
    }
    if (!more) break;
  }
  return ids;
}

const reply = (messages: Message[], service: number, id: number) =>
  messages.find((m) => m.data[0] === service + 0x40 && m.data[1] === id)?.data;

function decodeSignals(pid: number, d: number[], into: Record<string, number>): void {
  for (const s of SIGNALS) {
    if (s.pid === pid && d.length >= s.bytes) into[s.id] = s.decode(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0);
  }
}

async function readFreezeFrame(elm: Elm327): Promise<FreezeFrame | null> {
  // PID 02 of the frame holds the code that triggered it; zero means no frame.
  const trigger = reply(await elm.obd('020200'), 0x02, 0x02);
  if (!trigger || word(trigger[3], trigger[4]) === 0) return null;
  const values: Record<string, number> = {};
  for (const pid of await readSupported(elm, 0x02, '00')) {
    if (!SIGNALS.some((s) => s.pid === pid)) continue;
    const d = reply(await elm.obd('02' + hex2(pid) + '00'), 0x02, pid);
    if (d) decodeSignals(pid, d.slice(3), values);
  }
  return { dtc: decodeDtc(trigger[3] ?? 0, trigger[4] ?? 0), values };
}

const FUEL_SYSTEM: Record<number, string> = {
  1: 'Open loop: engine not warm enough yet',
  2: 'Closed loop: using oxygen sensor feedback',
  4: 'Open loop: due to engine load or deceleration fuel cut',
  8: 'Open loop: due to a system fault',
  16: 'Closed loop, but with a fault in the feedback system',
};

const OBD_STANDARD: Record<number, string> = {
  1: 'OBD-II (California ARB)',
  2: 'OBD (US EPA)',
  3: 'OBD and OBD-II',
  4: 'OBD-I',
  5: 'Not OBD compliant',
  6: 'EOBD (Europe)',
  7: 'EOBD and OBD-II',
  8: 'EOBD and OBD',
  9: 'EOBD, OBD and OBD-II',
  10: 'JOBD (Japan)',
  11: 'JOBD and OBD-II',
  12: 'JOBD and EOBD',
  13: 'JOBD, EOBD and OBD-II',
};

const bank = (id: number, first: number, perBank: number) => `B${Math.floor((id - first) / perBank) + 1}S${((id - first) % perBank) + 1}`;

/** Standard names for service 06 monitor ids (CAN vehicles). */
export function monitorName(mid: number): string {
  if (mid >= 0x01 && mid <= 0x10) return `Oxygen sensor ${bank(mid, 0x01, 4)}`;
  if (mid >= 0x21 && mid <= 0x24) return `Catalyst bank ${mid - 0x20}`;
  if (mid >= 0x31 && mid <= 0x34) return `EGR bank ${mid - 0x30}`;
  if (mid >= 0x35 && mid <= 0x38) return `Variable valve timing bank ${mid - 0x34}`;
  if (mid === 0x39) return 'EVAP system (cap off / 0.150")';
  if (mid === 0x3a) return 'EVAP system (0.090" leak)';
  if (mid === 0x3b) return 'EVAP system (0.040" leak)';
  if (mid === 0x3c) return 'EVAP system (0.020" leak)';
  if (mid === 0x3d) return 'EVAP purge flow';
  if (mid >= 0x41 && mid <= 0x50) return `Oxygen sensor heater ${bank(mid, 0x41, 4)}`;
  if (mid >= 0x61 && mid <= 0x64) return `Heated catalyst bank ${mid - 0x60}`;
  if (mid >= 0x71 && mid <= 0x74) return `Secondary air ${mid - 0x70}`;
  if (mid >= 0x81 && mid <= 0x84) return `Fuel system bank ${mid - 0x80}`;
  if (mid >= 0x85 && mid <= 0x88) return `Boost pressure bank ${mid - 0x84}`;
  if (mid === 0xa1) return 'Misfire, all cylinders';
  if (mid >= 0xa2 && mid <= 0xad) return `Misfire, cylinder ${mid - 0xa1}`;
  if (mid >= 0xb0 && mid <= 0xb3) return `Particulate filter bank ${mid - 0xaf}`;
  return `Monitor $${hex2(mid)}`;
}

function testName(mid: number, tid: number): string {
  if (mid >= 0xa1 && mid <= 0xad) {
    if (tid === 0x0b) return 'Misfire count, average of last 10 drive cycles';
    if (tid === 0x0c) return 'Misfire count, this or last drive cycle';
  }
  return `Test $${hex2(tid)}`;
}

async function readMonitorTests(elm: Elm327): Promise<MonitorTest[]> {
  const tests: MonitorTest[] = [];
  for (const id of await readSupported(elm, 0x06)) {
    const messages = (await elm.obd('06' + hex2(id))).filter((m) => m.data[0] === 0x46);
    for (const { data } of messages) {
      if (elm.bus === 'legacy') {
        // Pre-CAN: one test per message, manufacturer-defined, with a single
        // limit. The top bit of the component byte says which kind of limit.
        if (data.length < 7 || data[1] !== id) continue;
        const component = data[2] ?? 0;
        const value = word(data[3], data[4]);
        const limit = word(data[5], data[6]);
        const isMin = (component & 0x80) !== 0;
        tests.push({
          monitor: `Test $${hex2(id)}`,
          test: `Component $${hex2(component & 0x7f)}`,
          value,
          min: isMin ? limit : null,
          max: isMin ? null : limit,
          unitId: null,
          passed: isMin ? value >= limit : value <= limit,
          raw: hex(data.slice(1, 7)),
        });
        continue;
      }
      // CAN: nine-byte records of monitor, test, unit id, value, min, max.
      for (let i = 1; i + 8 < data.length; i += 9) {
        const unit = data[i + 2] ?? 0;
        // Unit ids from 0x80 up are signed quantities.
        const num = (hi: number | undefined, lo: number | undefined) => {
          const n = word(hi, lo);
          return unit >= 0x80 && n >= 0x8000 ? n - 0x10000 : n;
        };
        const value = num(data[i + 3], data[i + 4]);
        const min = num(data[i + 5], data[i + 6]);
        const max = num(data[i + 7], data[i + 8]);
        tests.push({
          monitor: monitorName(data[i] ?? id),
          test: testName(data[i] ?? id, data[i + 1] ?? 0),
          value,
          min,
          max,
          unitId: hex2(unit),
          passed: value >= min && value <= max,
          raw: hex(data.slice(i, i + 9)),
        });
      }
    }
  }
  return tests;
}

/**
 * Reads everything above. Each part is optional on the vehicle's side, so a
 * part that fails or isn't supported is simply left empty.
 */
export async function scanVehicle(elm: Elm327, supportedPids: ReadonlySet<number>, onStep?: (step: string) => void): Promise<VehicleScan> {
  const scan: VehicleScan = { readAt: Date.now(), freezeFrame: null, fuelSystem: [], obdStandard: null, snapshot: {}, monitorTests: [] };
  const attempt = async (step: string, run: () => Promise<void>) => {
    onStep?.(step);
    try {
      await run();
    } catch {
      /* unsupported or flaky: keep whatever else we can get */
    }
  };

  await attempt('Reading freeze frame', async () => {
    scan.freezeFrame = await readFreezeFrame(elm);
  });
  await attempt('Reading fuel system status', async () => {
    if (supportedPids.has(0x03)) {
      const d = reply(await elm.obd('0103'), 0x01, 0x03);
      scan.fuelSystem = [d?.[2], d?.[3]].flatMap((b) => (b ? [FUEL_SYSTEM[b] ?? `Unknown state ${b}`] : []));
    }
    if (supportedPids.has(0x1c)) {
      const d = reply(await elm.obd('011C'), 0x01, 0x1c);
      if (d?.[2] !== undefined) scan.obdStandard = OBD_STANDARD[d[2]] ?? `Type ${d[2]}`;
    }
  });
  await attempt('Reading all current values', async () => {
    const pids = [...new Set(SIGNALS.map((s) => s.pid))].filter((pid) => supportedPids.has(pid));
    for (const pid of pids) {
      const d = reply(await elm.obd('01' + hex2(pid)), 0x01, pid);
      if (d) decodeSignals(pid, d.slice(2), scan.snapshot);
    }
  });
  await attempt('Reading self-test results', async () => {
    scan.monitorTests = await readMonitorTests(elm);
  });
  return scan;
}
