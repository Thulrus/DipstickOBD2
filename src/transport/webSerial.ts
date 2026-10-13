import type { Transport } from './types';

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** The standard Bluetooth Serial Port Profile service, used by ELM327 adapters. */
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

async function requestPort(): Promise<SerialPort> {
  // Android only has Bluetooth serial ports. Saying so matters: Chrome checks
  // its Nearby devices permission, and offers to fix it, only for requests
  // that are explicitly Bluetooth-only. An unfiltered request just shows an
  // empty list when the permission is missing.
  if (/Android/i.test(navigator.userAgent)) {
    try {
      return await navigator.serial.requestPort({
        filters: [{ bluetoothServiceClassId: SPP_UUID }],
        allowedBluetoothServiceClassIds: [SPP_UUID],
      });
    } catch (e) {
      // NotFoundError means the user closed the picker. Anything else means
      // this browser rejected the options, so fall back to asking for any port.
      if (e instanceof DOMException && e.name === 'NotFoundError') throw e;
    }
  }
  return navigator.serial.requestPort();
}

/**
 * Web Serial transport. Covers Bluetooth Classic (SPP) adapters that have
 * been paired in the OS Bluetooth settings, plus USB adapters on desktop.
 * Chrome/Edge on desktop, and Chrome 138+ on Android (Bluetooth only).
 */
export class WebSerialTransport implements Transport {
  label = 'Serial adapter';
  onData: ((chunk: string) => void) | null = null;
  onClose: ((error?: Error) => void) | null = null;

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private closing = false;
  private readonly encoder = new TextEncoder();

  private constructor(private readonly port: SerialPort) {}

  /** Shows the browser's device picker. Must be called from a user gesture. */
  static async request(): Promise<WebSerialTransport> {
    return new WebSerialTransport(await requestPort());
  }

  /** A port the user has already granted, if there is exactly one. */
  static async remembered(): Promise<WebSerialTransport | null> {
    const ports = await navigator.serial.getPorts();
    const port = ports.length === 1 ? ports[0] : undefined;
    return port ? new WebSerialTransport(port) : null;
  }

  async open(): Promise<void> {
    // Baud rate is ignored for Bluetooth; 38400 is the ELM327 USB default.
    await this.port.open({ baudRate: 38400 });
    if (!this.port.readable || !this.port.writable) {
      throw new Error('Serial port opened without readable/writable streams');
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoop = this.pump(this.reader);
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder('ascii');
    let error: Error | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.onData?.(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    if (!this.closing) {
      await this.teardown();
      this.onClose?.(error ?? new Error('Adapter disconnected'));
    }
  }

  async write(data: string): Promise<void> {
    if (!this.writer) throw new Error('Port is not open');
    await this.writer.write(this.encoder.encode(data));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.reader?.cancel().catch(() => {});
    await this.readLoop;
    await this.teardown();
    this.onClose?.();
  }

  private async teardown(): Promise<void> {
    try {
      this.reader?.releaseLock();
    } catch {
      /* already released */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;
    this.writer = null;
    await this.port.close().catch(() => {});
  }
}
