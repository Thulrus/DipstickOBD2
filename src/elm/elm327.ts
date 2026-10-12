import type { Transport } from '../transport/types';
import { busKindFor, parseResponse, PROTOCOL_NAMES, type BusKind, type Message } from './parse';

export class ElmError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'closed' | 'no-vehicle' | 'adapter' | 'bus',
  ) {
    super(message);
    this.name = 'ElmError';
  }
}

export interface AdapterInfo {
  /** e.g. "ELM327 v1.5" (clones report whatever they like) */
  version: string;
  /** ELM protocol number, e.g. "6" */
  protocol: string;
  protocolName: string;
  bus: BusKind;
  /** Battery voltage as seen at the OBD port, if the adapter reports it. */
  voltage: number | null;
}

// Text the adapter prints instead of data when a request fails on the bus.
const BUS_ERRORS = ['UNABLE TO CONNECT', 'CAN ERROR', 'BUS ERROR', 'BUS BUSY', 'FB ERROR', 'DATA ERROR', 'BUFFER FULL', 'STOPPED', 'LV RESET', 'ERR'];

interface Pending {
  command: string;
  resolve(lines: string[]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Driver for ELM327-style adapters. The adapter is strictly
 * one-command-at-a-time: send a line, wait for the '>' prompt. Commands are
 * queued so callers can fire requests without coordinating.
 */
export class Elm327 {
  private buffer = '';
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  bus: BusKind = 'can11';

  constructor(private readonly transport: Transport) {
    transport.onData = (chunk) => this.receive(chunk);
  }

  /** Call when the transport drops so in-flight requests fail fast. */
  notifyClosed(): void {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new ElmError('Adapter disconnected', 'closed'));
      this.pending = null;
    }
  }

  private receive(chunk: string): void {
    // The ELM327 docs say stray NUL bytes can appear and should be ignored.
    this.buffer += chunk.replace(/\0/g, '');
    const end = this.buffer.indexOf('>');
    if (end === -1) return;
    const text = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 1);
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    const lines = text
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && l !== p.command);
    p.resolve(lines);
  }

  /** Sends one command and resolves with the response lines (echo removed). */
  command(command: string, timeoutMs = 5000): Promise<string[]> {
    const run = () =>
      new Promise<string[]>((resolve, reject) => {
        if (this.closed) return reject(new ElmError('Adapter disconnected', 'closed'));
        this.buffer = '';
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new ElmError(`No reply to ${command}`, 'timeout'));
        }, timeoutMs);
        this.pending = { command, resolve, reject, timer };
        this.transport.write(command + '\r').catch((e) => {
          clearTimeout(timer);
          this.pending = null;
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * Sends an OBD request (e.g. "010C") and returns the decoded messages.
   * "NO DATA" is an empty array: the vehicle simply doesn't support it.
   */
  async obd(request: string, timeoutMs = 5000): Promise<Message[]> {
    const lines = await this.command(request, timeoutMs);
    const messages = parseResponse(lines, this.bus);
    if (messages.length === 0) throwIfBusError(lines);
    return messages;
  }

  /** Resets and configures the adapter, then finds the vehicle's protocol. */
  async init(onStep?: (step: string) => void): Promise<AdapterInfo> {
    onStep?.('Resetting adapter');
    let version = 'Unknown adapter';
    try {
      const reset = await this.command('ATZ', 4000);
      version = reset.find((l) => /ELM|OBD|STN/i.test(l)) ?? version;
    } catch (e) {
      if (!(e instanceof ElmError) || e.code !== 'timeout') throw e;
      // Some clones never answer ATZ; a bare CR usually gets the prompt back.
      await this.command('', 2000).catch(() => {});
    }

    onStep?.('Configuring adapter');
    await this.command('ATE0'); // echo off
    // The rest are nice-to-have; clones answer "?" to some of them.
    for (const cmd of ['ATL0', 'ATS0', 'ATH1', 'ATAT1', 'ATSP0']) {
      await this.command(cmd).catch(() => {});
    }

    onStep?.('Looking for the vehicle');
    // The first request makes the adapter try each protocol in turn, which
    // can take a while on the older, slow-init buses.
    const probe = await this.command('0100', 20000);
    const protocol = ((await this.command('ATDPN'))[0] ?? '').replace(/^A/i, '').toUpperCase();
    this.bus = busKindFor(protocol);
    if (parseResponse(probe, this.bus).length === 0) {
      throw new ElmError(
        "The adapter is working, but the vehicle didn't answer. Check that the ignition is on.",
        'no-vehicle',
      );
    }

    let voltage: number | null = null;
    try {
      voltage = await this.readVoltage();
    } catch {
      /* optional */
    }
    return {
      version,
      protocol,
      protocolName: PROTOCOL_NAMES[protocol] ?? `Protocol ${protocol || '?'}`,
      bus: this.bus,
      voltage,
    };
  }

  /** Battery voltage measured by the adapter itself (works engine-off). */
  async readVoltage(): Promise<number | null> {
    const line = (await this.command('ATRV'))[0] ?? '';
    const v = parseFloat(line);
    return Number.isFinite(v) ? v : null;
  }
}

function throwIfBusError(lines: string[]): void {
  const text = lines.join(' ').toUpperCase();
  if (text.includes('NO DATA')) return;
  if (text.includes('UNABLE TO CONNECT')) {
    throw new ElmError('Lost contact with the vehicle. Is the ignition still on?', 'no-vehicle');
  }
  const hit = BUS_ERRORS.find((e) => text.includes(e));
  if (hit) throw new ElmError(`Adapter reported: ${hit}`, 'bus');
  if (text.includes('?')) throw new ElmError('Adapter did not understand the request', 'adapter');
}
