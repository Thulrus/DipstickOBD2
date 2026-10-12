import type { BusKind, Message } from '../elm/parse';

/** Decodes the two-byte wire form of a trouble code, e.g. 0x01 0x71 -> "P0171". */
export function decodeDtc(hi: number, lo: number): string {
  const system = 'PCBU'[hi >> 6]!;
  const digits = ((hi & 0x3f) << 8) | lo;
  return system + digits.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Extracts codes from a service 03 (stored), 07 (pending) or 0A (permanent)
 * response. CAN replies carry a count byte before the codes; the older buses
 * don't, and pad each message to three codes with zeros.
 */
export function parseDtcs(messages: Message[], service: number, bus: BusKind): string[] {
  const codes = new Set<string>();
  for (const { data } of messages) {
    if (data[0] !== service + 0x40) continue;
    for (let i = bus === 'legacy' ? 1 : 2; i + 1 < data.length; i += 2) {
      const hi = data[i]!;
      const lo = data[i + 1]!;
      if (hi !== 0 || lo !== 0) codes.add(decodeDtc(hi, lo));
    }
  }
  return [...codes];
}

const AREAS: [RegExp, string][] = [
  [/^P0[012]/, 'Fuel and air metering'],
  [/^P03/, 'Ignition system or misfire'],
  [/^P04/, 'Auxiliary emission controls'],
  [/^P05/, 'Vehicle speed, idle control and auxiliary inputs'],
  [/^P06/, 'Computer and output circuits'],
  [/^P0[789]/, 'Transmission'],
  [/^P0A/, 'Hybrid propulsion'],
  [/^P[13]/, 'Powertrain (manufacturer-specific code)'],
  [/^P2/, 'Powertrain'],
  [/^C/, 'Chassis'],
  [/^B/, 'Body'],
  [/^U/, 'Network communication'],
];

/** The broad system a code belongs to. Full descriptions are on the roadmap. */
export function dtcArea(code: string): string {
  return AREAS.find(([re]) => re.test(code))?.[1] ?? 'Unknown system';
}

export interface Monitor {
  name: string;
  complete: boolean;
}

export interface MonitorStatus {
  /** Check-engine light commanded on. */
  mil: boolean;
  /** Number of stored emissions codes. */
  dtcCount: number;
  /** Readiness monitors this vehicle has (what a smog check looks at). */
  monitors: Monitor[];
}

const CONTINUOUS = ['Misfire', 'Fuel system', 'Comprehensive components'];
const SPARK = ['Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air', 'A/C refrigerant', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR system'];
const DIESEL = ['NMHC catalyst', 'NOx aftertreatment', '', 'Boost pressure', '', 'Exhaust gas sensor', 'Particulate filter', 'EGR / VVT system'];

/** Decodes service 01 PID 01 (four data bytes after the PID). */
export function decodeMonitorStatus(a: number, b: number, c: number, d: number): MonitorStatus {
  const monitors: Monitor[] = [];
  CONTINUOUS.forEach((name, bit) => {
    if (b & (1 << bit)) monitors.push({ name, complete: !(b & (1 << (bit + 4))) });
  });
  (b & 0x08 ? DIESEL : SPARK).forEach((name, bit) => {
    if (name && c & (1 << bit)) monitors.push({ name, complete: !(d & (1 << bit)) });
  });
  return { mil: (a & 0x80) !== 0, dtcCount: a & 0x7f, monitors };
}
