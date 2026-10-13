import type { Elm327 } from '../elm/elm327';
import type { Message } from '../elm/parse';
import { decodeMonitorStatus, parseDtcs, type MonitorStatus } from './dtc';

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Finds the reply to a service 01 PID request and returns its data bytes. */
export function pidData(messages: Message[], pid: number): number[] | null {
  const m = engineFirst(messages).find((msg) => msg.data[0] === 0x41 && msg.data[1] === pid);
  return m ? m.data.slice(2) : null;
}

/**
 * More than one computer may answer a request, in no guaranteed order, and
 * they don't always agree (a transmission computer can report its own idea
 * of a value). The engine computer has the lowest address on every bus
 * (7E8 on CAN, 10 on the older ones), so sort it to the front.
 */
export function engineFirst(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => parseInt(a.ecu, 16) - parseInt(b.ecu, 16));
}

export interface PidSupport {
  pids: Set<number>;
  /** How many computers answer each PID. */
  responders: Map<number, number>;
}

/**
 * Asks the vehicle which service 01 PIDs it supports. Each of PIDs 00, 20,
 * 40... returns a 32-bit mask for the next 32 PIDs; the last bit says whether
 * the next mask exists.
 */
export async function readSupportedPids(elm: Elm327): Promise<Set<number>> {
  return (await readPidSupport(elm)).pids;
}

export async function readPidSupport(elm: Elm327): Promise<PidSupport> {
  const supported = new Set<number>();
  const responders = new Map<number, number>();
  for (let base = 0; base <= 0xc0; base += 0x20) {
    const messages = await elm.obd('01' + hex2(base));
    let more = false;
    for (const { data } of messages) {
      if (data[0] !== 0x41 || data[1] !== base) continue;
      for (let i = 0; i < 32; i++) {
        const byte = data[2 + (i >> 3)] ?? 0;
        if (byte & (0x80 >> (i & 7))) {
          supported.add(base + i + 1);
          responders.set(base + i + 1, (responders.get(base + i + 1) ?? 0) + 1);
          if (i === 31) more = true;
        }
      }
    }
    if (!more) break;
  }
  return { pids: supported, responders };
}

/** Reads the VIN (service 09 PID 02). Many pre-2005 vehicles don't report one. */
export async function readVin(elm: Elm327): Promise<string | null> {
  const messages = (await elm.obd('0902')).filter((m) => m.data[0] === 0x49 && m.data[1] === 0x02);
  // CAN sends one long message; older buses send five short numbered ones.
  messages.sort((x, y) => (x.data[2] ?? 0) - (y.data[2] ?? 0));
  const chars = messages
    .flatMap((m) => m.data.slice(3))
    .filter((c) => /[A-Z0-9]/.test(String.fromCharCode(c)))
    .map((c) => String.fromCharCode(c))
    .join('');
  return chars.length >= 17 ? chars.slice(-17) : null;
}

export async function readMonitorStatus(elm: Elm327): Promise<MonitorStatus | null> {
  const d = pidData(await elm.obd('0101'), 0x01);
  return d ? decodeMonitorStatus(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0) : null;
}

export interface TroubleCodes {
  /** Confirmed codes; these are what turn the check-engine light on. */
  stored: string[];
  /** Faults seen this or last drive cycle that haven't been confirmed yet. */
  pending: string[];
  /**
   * Codes that stay until the vehicle itself confirms the fault is gone;
   * clearing can't remove them. Newer (roughly 2010+) vehicles only.
   */
  permanent?: string[];
  status: MonitorStatus | null;
  /** Distance driven with the check-engine light on, if the vehicle reports it. */
  milDistanceKm?: number | null;
  /** The bytes that distance was decoded from, per answering computer. */
  milDistanceRaw?: string;
  /**
   * False when the vehicle didn't answer at all (ignition off), which is not
   * the same as answering "no codes". Absent in older logs.
   */
  answered?: boolean;
  readAt: number;
}

export async function readTroubleCodes(elm: Elm327): Promise<TroubleCodes> {
  const status = await readMonitorStatus(elm);
  const storedReply = await elm.obd('03');
  const stored = parseDtcs(storedReply, 0x03, elm.bus);
  const pending = parseDtcs(await elm.obd('07'), 0x07, elm.bus);
  const permanent = await elm.obd('0A').then((m) => parseDtcs(m, 0x0a, elm.bus)).catch(() => []);
  const distanceReply = await elm.obd('0121').catch(() => []);
  const distance = pidData(distanceReply, 0x21);
  const milDistanceKm = distance && distance.length >= 2 ? distance[0]! * 256 + distance[1]! : null;
  return {
    stored,
    pending,
    permanent,
    status,
    milDistanceKm,
    milDistanceRaw: rawByEcu(distanceReply, 0x01, 0x21),
    answered: status !== null || storedReply.some((m) => m.data[0] === 0x43),
    readAt: Date.now(),
  };
}

/** Whether a code read got an answer, including for logs saved before `answered` existed. */
export function codesWereRead(codes: TroubleCodes | null | undefined): codes is TroubleCodes {
  if (!codes) return false;
  return codes.answered ?? (codes.status !== null || codes.stored.length > 0 || codes.pending.length > 0);
}

/**
 * The data bytes of every reply to a request, labelled by which computer
 * sent them, e.g. "ECU 10: 00 0B". Disagreeing computers show up here.
 */
export function rawByEcu(messages: Message[], service: number, id: number, skip = 2): string {
  return engineFirst(messages)
    .filter((m) => m.data[0] === service + 0x40 && m.data[1] === id)
    .map((m) => `ECU ${m.ecu}: ${m.data.slice(skip).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`)
    .join('; ');
}

/**
 * Clears stored codes and turns the check-engine light off (service 04).
 * This also wipes freeze-frame data and resets every readiness monitor.
 */
export async function clearTroubleCodes(elm: Elm327): Promise<void> {
  await elm.obd('04');
}
