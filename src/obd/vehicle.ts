import type { Elm327 } from '../elm/elm327';
import type { Message } from '../elm/parse';
import { decodeMonitorStatus, parseDtcs, type MonitorStatus } from './dtc';

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Finds the reply to a service 01 PID request and returns its data bytes. */
export function pidData(messages: Message[], pid: number): number[] | null {
  // More than one ECU may answer; the engine computer replies first.
  const m = messages.find((msg) => msg.data[0] === 0x41 && msg.data[1] === pid);
  return m ? m.data.slice(2) : null;
}

/**
 * Asks the vehicle which service 01 PIDs it supports. Each of PIDs 00, 20,
 * 40... returns a 32-bit mask for the next 32 PIDs; the last bit says whether
 * the next mask exists.
 */
export async function readSupportedPids(elm: Elm327): Promise<Set<number>> {
  const supported = new Set<number>();
  for (let base = 0; base <= 0xc0; base += 0x20) {
    const messages = await elm.obd('01' + hex2(base));
    let more = false;
    for (const { data } of messages) {
      if (data[0] !== 0x41 || data[1] !== base) continue;
      for (let i = 0; i < 32; i++) {
        const byte = data[2 + (i >> 3)] ?? 0;
        if (byte & (0x80 >> (i & 7))) {
          supported.add(base + i + 1);
          if (i === 31) more = true;
        }
      }
    }
    if (!more) break;
  }
  return supported;
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
  status: MonitorStatus | null;
  readAt: number;
}

export async function readTroubleCodes(elm: Elm327): Promise<TroubleCodes> {
  const status = await readMonitorStatus(elm);
  const stored = parseDtcs(await elm.obd('03'), 0x03, elm.bus);
  const pending = parseDtcs(await elm.obd('07'), 0x07, elm.bus);
  return { stored, pending, status, readAt: Date.now() };
}

/**
 * Clears stored codes and turns the check-engine light off (service 04).
 * This also wipes freeze-frame data and resets every readiness monitor.
 */
export async function clearTroubleCodes(elm: Elm327): Promise<void> {
  await elm.obd('04');
}
