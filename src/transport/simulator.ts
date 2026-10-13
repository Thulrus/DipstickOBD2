import type { Transport } from './types';

export interface SimulatorOptions {
  /** ELM protocol number to imitate: '6' (CAN) or '3' (ISO 9141-2). */
  protocol?: '6' | '3';
  /** Delay before each reply. Real adapters take roughly 30-150 ms. */
  latencyMs?: number;
  /** Seconds of simulated driving elapsed; injectable for tests. */
  clock?: () => number;
}

const SUPPORTED = [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x19, 0x1c, 0x1f, 0x21, 0x2e, 0x2f, 0x31, 0x33, 0x42, 0x44];
const VIN = '1N6AD07W05C400000';
/** Service 06 ids the fake engine computer has results for. */
const MONITOR_IDS = [0x01, 0x21, 0xa2];

/** Builds a "supported ids" reply: 32 bits for base+1..base+32, last bit = more follow. */
function supportMask(ids: number[], base: number): number[] {
  const mask = [0, 0, 0, 0];
  for (const id of ids) {
    const i = id - base - 1;
    if (i >= 0 && i < 31) mask[i >> 3]! |= 0x80 >> (i & 7);
  }
  if (ids.some((id) => id > base + 0x20)) mask[3]! |= 1;
  return mask;
}

/** Simulated seconds into the drive at which the stored code "happened". */
const FROZEN_AT = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const u8 = (v: number) => clamp(Math.round(v), 0, 255);
const u16 = (v: number) => {
  const n = clamp(Math.round(v), 0, 65535);
  return [n >> 8, n & 0xff];
};
const hex = (bytes: number[], spaces: boolean) =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(spaces ? ' ' : '');

/**
 * A pretend ELM327 plugged into a pretend V6 truck. It speaks the same text
 * protocol as the real thing, so the whole app (and the test suite) can run
 * with no hardware. The "truck" has a lean bank 2 to make the data
 * interesting: a stored P0174, a pending P0171 and a high LTFT on bank 2.
 */
export class SimulatorTransport implements Transport {
  label = 'Demo vehicle';
  onData: ((chunk: string) => void) | null = null;
  onClose: ((error?: Error) => void) | null = null;

  private readonly protocol: '6' | '3';
  private readonly latencyMs: number;
  private readonly clock: () => number;
  private open_ = false;
  private echo = true;
  private headers = false;
  private spaces = true;
  private searched = false;
  private stored = ['P0174'];
  private pending = ['P0171'];
  private input = '';

  constructor(options: SimulatorOptions = {}) {
    this.protocol = options.protocol ?? '6';
    this.latencyMs = options.latencyMs ?? 40;
    const t0 = Date.now();
    this.clock = options.clock ?? (() => (Date.now() - t0) / 1000);
  }

  async open(): Promise<void> {
    this.open_ = true;
  }

  async close(): Promise<void> {
    if (!this.open_) return;
    this.open_ = false;
    this.onClose?.();
  }

  async write(data: string): Promise<void> {
    if (!this.open_) throw new Error('Port is not open');
    this.input += data;
    let end: number;
    while ((end = this.input.indexOf('\r')) !== -1) {
      const command = this.input.slice(0, end);
      this.input = this.input.slice(end + 1);
      const reply = (this.echo ? command + '\r' : '') + this.handle(command.replace(/\s+/g, '').toUpperCase()) + '\r\r>';
      const send = () => this.open_ && this.onData?.(reply);
      if (this.latencyMs > 0) setTimeout(send, this.latencyMs);
      else queueMicrotask(send);
    }
  }

  private handle(cmd: string): string {
    if (cmd === '') return '';
    if (cmd.startsWith('AT')) return this.at(cmd.slice(2));
    if (!/^[0-9A-F]+$/.test(cmd) || cmd.length % 2 !== 0) return '?';
    const prefix = this.searched ? '' : 'SEARCHING...\r';
    this.searched = true;
    const service = parseInt(cmd.slice(0, 2), 16);
    const pid = cmd.length >= 4 ? parseInt(cmd.slice(2, 4), 16) : -1;
    const replies = this.respond(service, pid);
    return prefix + (replies.length ? replies.join('\r') : 'NO DATA');
  }

  private at(cmd: string): string {
    if (cmd === 'Z') {
      this.echo = true;
      this.headers = false;
      this.spaces = true;
      this.searched = false;
      return '\rELM327 v1.5';
    }
    if (cmd === 'I') return 'ELM327 v1.5';
    if (cmd === 'RV') return (this.engine().voltage - 0.2).toFixed(1) + 'V';
    if (cmd === 'DPN') return 'A' + this.protocol;
    if (cmd === 'DP') return this.protocol === '6' ? 'AUTO, ISO 15765-4 (CAN 11/500)' : 'AUTO, ISO 9141-2';
    if (/^E[01]$/.test(cmd)) this.echo = cmd === 'E1';
    else if (/^H[01]$/.test(cmd)) this.headers = cmd === 'H1';
    else if (/^S[01]$/.test(cmd)) this.spaces = cmd === 'S1';
    else if (!/^(L[01]|AT[012]|SP[0-9A]{1,2}|ST[0-9A-F]{2}|D|WS)$/.test(cmd)) return '?';
    return 'OK';
  }

  /** Formats one or more ECU payloads the way the selected bus would. */
  private respond(service: number, pid: number): string[] {
    const lines: string[] = [];
    const engine = this.payloads(service, pid);
    for (const payload of engine) lines.push(...this.frame(payload, '7E8', 0x10));
    // A transmission computer that only answers the "what do you support" query.
    if (service === 0x01 && pid === 0x00) lines.push(...this.frame([0x41, 0x00, 0x80, 0x00, 0x00, 0x00], '7E9', 0x18));
    return lines;
  }

  private frame(payload: number[], canId: string, address: number): string[] {
    const sep = this.spaces ? ' ' : '';
    if (this.protocol === '3') {
      const bytes = [0x48, 0x6b, address, ...payload];
      const checksum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
      return [hex(this.headers ? [...bytes, checksum] : payload, this.spaces)];
    }
    const head = this.headers ? canId + sep : '';
    if (payload.length <= 7) {
      const padded = [...payload, ...Array<number>(7 - payload.length).fill(0)];
      return [head + hex(this.headers ? [payload.length, ...padded] : payload, this.spaces)];
    }
    // ISO-TP multi-frame: a first frame with 6 bytes, then 7 per frame.
    const lines = [head + hex([0x10 | (payload.length >> 8), payload.length & 0xff, ...payload.slice(0, 6)], this.spaces)];
    for (let i = 6, n = 1; i < payload.length; i += 7, n++) {
      const chunk = payload.slice(i, i + 7);
      lines.push(head + hex([0x20 | (n & 0x0f), ...chunk, ...Array<number>(7 - chunk.length).fill(0)], this.spaces));
    }
    return lines;
  }

  private payloads(service: number, pid: number): number[][] {
    const can = this.protocol === '6';
    switch (service) {
      case 0x01: {
        const data = this.pid(pid);
        return data ? [[0x41, pid, ...data]] : [];
      }
      case 0x02: {
        // Freeze frame: the engine as it was when the stored code was set.
        if (pid === 0x02) return [[0x42, 0x02, 0x00, ...(this.stored[0] ? encodeDtc(this.stored[0]) : [0, 0])]];
        if (!this.stored.length) return [];
        const data = this.pid(pid, FROZEN_AT);
        return data ? [[0x42, pid, 0x00, ...data]] : [];
      }
      case 0x06:
        return this.monitors(pid, can);
      case 0x0a:
        return can ? [[0x4a, 0x00]] : [];
      case 0x03:
      case 0x07: {
        const codes = (service === 0x03 ? this.stored : this.pending).flatMap(encodeDtc);
        if (can) return [[service + 0x40, codes.length / 2, ...codes]];
        const padded = [...codes, ...Array<number>(6 - (codes.length % 6 || 6)).fill(0)];
        const out: number[][] = [];
        for (let i = 0; i < padded.length; i += 6) out.push([service + 0x40, ...padded.slice(i, i + 6)]);
        return out.length ? out : [[service + 0x40, 0, 0, 0, 0, 0, 0]];
      }
      case 0x04:
        this.stored = [];
        this.pending = [];
        return [[0x44]];
      case 0x09: {
        if (pid !== 0x02) return [];
        const chars = [...VIN].map((c) => c.charCodeAt(0));
        if (can) return [[0x49, 0x02, 0x01, ...chars]];
        const padded = [0, 0, 0, ...chars];
        return [0, 1, 2, 3, 4].map((i) => [0x49, 0x02, i + 1, ...padded.slice(i * 4, i * 4 + 4)]);
      }
      default:
        return [];
    }
  }

  private monitors(id: number, can: boolean): number[][] {
    if (id % 0x20 === 0) {
      return id > 0xa0 ? [] : [[0x46, id, ...supportMask(can ? MONITOR_IDS : [0x01, 0x02], id)]];
    }
    if (!can) {
      // Pre-CAN format: test id, component (top bit: limit is a minimum), value, limit.
      if (id === 0x01) return [[0x46, 0x01, 0x81, 0x00, 0x52, 0x00, 0x30]];
      if (id === 0x02) return [[0x46, 0x02, 0x01, 0x01, 0x90, 0x01, 0x00]];
      return [];
    }
    switch (id) {
      case 0x01: // two oxygen sensor tests, both in range
        return [[0x46, 0x01, 0x80, 0x0a, 0x0b, 0xb0, 0x04, 0x00, 0xff, 0xff, 0x01, 0x81, 0x0a, 0x02, 0x10, 0x00, 0x00, 0x08, 0x00]];
      case 0x21: // catalyst, in range
        return [[0x46, 0x21, 0x80, 0x20, 0x00, 0x48, 0x00, 0x00, 0x00, 0x60]];
      case 0xa2: // cylinder 1 misfire counters; the recent one is over its limit
        return [[0x46, 0xa2, 0x0b, 0x24, 0x00, 0x03, 0x00, 0x00, 0xff, 0xff, 0xa2, 0x0c, 0x24, 0x00, 0x41, 0x00, 0x00, 0x00, 0x20]];
      default:
        return [];
    }
  }

  /** The made-up engine: a looping drive with stops, warming up from cold. */
  private engine(at?: number) {
    const t = at ?? this.clock();
    const wobble = (period: number, phase = 0) => Math.sin((t / period) * 2 * Math.PI + phase);
    const speed = Math.max(0, 48 + 42 * wobble(95) + 14 * wobble(23, 1)); // km/h
    const accel = 42 * wobble(95, Math.PI / 2) + 14 * wobble(23, 1 + Math.PI / 2);
    const moving = speed > 2;
    const throttle = moving ? clamp(16 + speed * 0.12 + accel * 0.5, 4, 85) : 3.5;
    const rpm = moving ? 1150 + speed * 19 + Math.max(0, accel) * 14 + 25 * wobble(1.3) : 720 + 18 * wobble(2.1);
    const load = moving ? clamp(22 + throttle * 0.75, 15, 95) : 21 + wobble(3);
    const coolant = 88 - 70 * Math.exp(-t / 150);
    const closedLoop = coolant > 40;
    return {
      t,
      speed,
      rpm,
      throttle,
      load,
      coolant,
      intake: 24 + 6 * (1 - Math.exp(-t / 400)),
      maf: (rpm * load) / 2600,
      timing: moving ? 14 + (rpm - 1000) / 180 - load / 12 : 10 + wobble(1.7),
      stft1: closedLoop ? 2.5 * wobble(4.1) + wobble(0.9) : 0,
      stft2: closedLoop ? 4 + 3.5 * wobble(3.7, 2) + wobble(1.1) : 0,
      ltft1: 3.1,
      ltft2: moving ? 11.7 : 17.2,
      o2Rear1: 0.68 + 0.05 * wobble(11),
      o2Rear2: 0.52 + 0.12 * wobble(6, 1),
      voltage: 14.1 + 0.15 * wobble(31),
    };
  }

  private pid(pid: number, at?: number): number[] | null {
    if (pid % 0x20 === 0) return pid <= 0x40 ? supportMask(SUPPORTED, pid) : null;
    if (!SUPPORTED.includes(pid)) return null;
    const e = this.engine(at);
    const trim = (v: number) => u8((v * 128) / 100 + 128);
    switch (pid) {
      case 0x01:
        // MIL + count, then: misfire/fuel/components all complete; catalyst,
        // EVAP, O2 sensor, O2 heater supported with EVAP still incomplete.
        return [(this.stored.length ? 0x80 : 0) | this.stored.length, 0x07, 0x65, 0x04];
      case 0x03: return [e.coolant > 40 ? 0x02 : 0x01, 0x00];
      case 0x04: return [u8(e.load * 2.55)];
      case 0x05: return [u8(e.coolant + 40)];
      case 0x06: return [trim(e.stft1)];
      case 0x07: return [trim(e.ltft1)];
      case 0x08: return [trim(e.stft2)];
      case 0x09: return [trim(e.ltft2)];
      case 0x0c: return u16(e.rpm * 4);
      case 0x0d: return [u8(e.speed)];
      case 0x0e: return [u8((e.timing + 64) * 2)];
      case 0x0f: return [u8(e.intake + 40)];
      case 0x10: return u16(e.maf * 100);
      case 0x11: return [u8(e.throttle * 2.55)];
      case 0x13: return [0x22]; // sensors 2 present on both banks
      case 0x15: return [u8(e.o2Rear1 * 200), 0xff];
      case 0x19: return [u8(e.o2Rear2 * 200), 0xff];
      case 0x1c: return [0x01]; // OBD-II as defined by CARB
      case 0x1f: return u16(e.t);
      case 0x21: return u16(this.stored.length ? 212 : 0);
      case 0x2e: return [u8(e.speed > 20 ? 70 : 0)];
      case 0x2f: return [u8(62 * 2.55)];
      case 0x31: return u16(1843);
      case 0x33: return [99];
      case 0x42: return u16(e.voltage * 1000);
      case 0x44: return u16(32768);
      default: return null;
    }
  }
}

function encodeDtc(code: string): number[] {
  const n = parseInt(code.slice(1), 16);
  return [('PCBU'.indexOf(code[0]!) << 6) | (n >> 8), n & 0xff];
}
