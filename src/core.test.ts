import { describe, expect, it } from 'vitest';
import { Elm327 } from './elm/elm327';
import { parseResponse } from './elm/parse';
import { toLongCsv, toSummary, toWideCsv } from './log/export';
import type { SampleColumns, Session } from './log/types';
import { decodeDtc, decodeMonitorStatus, parseDtcs } from './obd/dtc';
import { pickNext, Poller, SLOW_INTERVAL_MS, type Sample } from './obd/poller';
import { SIGNAL_BY_ID, SIGNALS } from './obd/signals';
import { readSupportedPids, readTroubleCodes, readVin, clearTroubleCodes } from './obd/vehicle';
import { SimulatorTransport } from './transport/simulator';

describe('parseResponse', () => {
  it('reads CAN single frames and ignores padding and chatter', () => {
    const m = parseResponse(['SEARCHING...', '7E8 04 41 0C 1A F8 00 00 00'], 'can11');
    expect(m).toEqual([{ ecu: '7E8', data: [0x41, 0x0c, 0x1a, 0xf8] }]);
  });

  it('reassembles interleaved multi-frame CAN replies per ECU', () => {
    const m = parseResponse(
      ['7E8100A430401000200', '7E9024300', '7E8210300040000000000'],
      'can11',
    );
    expect(m).toEqual([
      { ecu: '7E9', data: [0x43, 0x00] },
      { ecu: '7E8', data: [0x43, 0x04, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00] },
    ]);
  });

  it('reads 29-bit CAN ids', () => {
    expect(parseResponse(['18DAF110 03 41 0D 32'], 'can29')).toEqual([{ ecu: '18DAF110', data: [0x41, 0x0d, 0x32] }]);
  });

  it('strips header and checksum on pre-CAN buses', () => {
    expect(parseResponse(['48 6B 10 41 0C 1A F8 12'], 'legacy')).toEqual([{ ecu: '10', data: [0x41, 0x0c, 0x1a, 0xf8] }]);
  });
});

describe('decoding', () => {
  it('decodes trouble codes', () => {
    expect(decodeDtc(0x01, 0x71)).toBe('P0171');
    expect(decodeDtc(0x43, 0x00)).toBe('C0300');
    expect(decodeDtc(0xc1, 0x00)).toBe('U0100');
    expect(parseDtcs([{ ecu: '10', data: [0x43, 0x01, 0x71, 0x00, 0x00, 0x00, 0x00] }], 0x03, 'legacy')).toEqual(['P0171']);
  });

  it('decodes readiness monitors', () => {
    const s = decodeMonitorStatus(0x81, 0x07, 0x65, 0x04);
    expect(s.mil).toBe(true);
    expect(s.dtcCount).toBe(1);
    expect(s.monitors.filter((m) => !m.complete).map((m) => m.name)).toEqual(['Evaporative system']);
    expect(s.monitors).toHaveLength(7);
  });

  it('decodes standard PIDs', () => {
    const d = (id: string, ...b: number[]) => SIGNAL_BY_ID.get(id)!.decode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0);
    expect(d('rpm', 0x1a, 0xf8)).toBe(1726);
    expect(d('coolant_temp', 0x7b)).toBe(83);
    expect(d('stft_b1', 0x80)).toBe(0);
    expect(d('ltft_b2', 0x90)).toBe(12.5);
    expect(d('maf', 0x01, 0xf4)).toBe(5);
    expect(d('af_b1s1_lambda', 0x80, 0x00, 0x40, 0x00)).toBe(1);
    expect(d('af_b1s1_voltage', 0x80, 0x00, 0x40, 0x00)).toBe(2);
  });

  it('has unique signal ids', () => {
    expect(new Set(SIGNALS.map((s) => s.id)).size).toBe(SIGNALS.length);
  });
});

describe('pickNext', () => {
  it('round-robins fast PIDs and fits slow ones in when due', () => {
    const fastA = { slow: false, last: 100 };
    const fastB = { slow: false, last: 50 };
    const slow = { slow: true, last: 0 };
    expect(pickNext([fastA, fastB, slow], 200)).toBe(fastB);
    expect(pickNext([fastA, fastB, slow], SLOW_INTERVAL_MS)).toBe(slow);
    expect(pickNext([slow], 10)).toBe(slow);
    expect(pickNext([], 10)).toBeNull();
  });
});

// The same end-to-end checks against both kinds of bus the adapter may find.
describe.each(['6', '3'] as const)('against the simulator (protocol %s)', (protocol) => {
  // latencyMs 1 rather than 0: replies must arrive on a timer, or the polling
  // loop would never let the test's own timers run.
  async function connect(seconds = 300) {
    const transport = new SimulatorTransport({ protocol, latencyMs: 1, clock: () => seconds });
    await transport.open();
    const elm = new Elm327(transport);
    const info = await elm.init();
    return { elm, info, transport };
  }

  it('initialises and identifies the vehicle', async () => {
    const { elm, info } = await connect();
    expect(info.version).toBe('ELM327 v1.5');
    expect(info.protocol).toBe(protocol);
    expect(info.voltage).toBeGreaterThan(12);
    expect(await readVin(elm)).toBe('1N6AD07W05C400000');
    const pids = await readSupportedPids(elm);
    expect(pids.has(0x0c)).toBe(true);
    expect(pids.has(0x42)).toBe(true);
    expect(pids.has(0x0b)).toBe(false);
  });

  it('reads and clears trouble codes', async () => {
    const { elm } = await connect();
    const codes = await readTroubleCodes(elm);
    expect(codes.stored).toEqual(['P0174']);
    expect(codes.pending).toEqual(['P0171']);
    expect(codes.status?.mil).toBe(true);
    await clearTroubleCodes(elm);
    const after = await readTroubleCodes(elm);
    expect(after.stored).toEqual([]);
    expect(after.status?.mil).toBe(false);
  });

  it('polls signals, including ones the vehicle lacks', async () => {
    const { elm } = await connect();
    const poller = new Poller(elm);
    const samples: Sample[] = [];
    poller.onSample = (s) => samples.push(s);
    poller.setSignals(['rpm', 'coolant_temp', 'map', 'battery_voltage'].map((id) => SIGNAL_BY_ID.get(id)!));
    poller.start();
    await new Promise((r) => setTimeout(r, 60));
    await poller.stop();
    const seen = new Set(samples.map((s) => s.signalId));
    expect(seen).toEqual(new Set(['rpm', 'coolant_temp', 'battery_voltage']));
    const rpm = samples.find((s) => s.signalId === 'rpm')!.v;
    expect(rpm).toBeGreaterThan(600);
    expect(rpm).toBeLessThan(4000);
  });

  it('fails in-flight requests when the adapter drops', async () => {
    const { elm, transport } = await connect();
    transport.onClose = () => elm.notifyClosed();
    const pending = elm.obd('010C');
    await transport.close();
    await expect(pending).rejects.toThrow('disconnected');
  });
});

describe('exports', () => {
  const session: Session = {
    id: 's1',
    startedAt: Date.UTC(2026, 9, 12, 15, 0, 0),
    endedAt: Date.UTC(2026, 9, 12, 15, 0, 2),
    demo: false,
    vehicle: { vin: '1N6AD07W05C400000', adapter: 'ELM327 v1.5', protocol: '6', protocolName: 'ISO 15765-4 CAN (11 bit, 500 kbaud)' },
    signalIds: ['rpm', 'coolant_temp'],
    sampleCount: 4,
    codes: { stored: ['P0174'], pending: [], status: { mil: true, dtcCount: 1, monitors: [{ name: 'Catalyst', complete: false }] }, readAt: 0 },
    note: '',
  };
  const samples: SampleColumns = { t: [100, 300, 600, 1500], k: [0, 1, 0, 0], v: [800, 90, 900, 1000] };

  it('writes a wide CSV with averaged buckets and honest gaps', () => {
    expect(toWideCsv(session, samples, 'imperial')).toBe('time_s,rpm (rpm),coolant_temp (°F)\n0,850,194\n1,1000,\n');
  });

  it('writes a long CSV with every reading', () => {
    expect(toLongCsv(session, samples, 'metric').split('\n')).toEqual([
      'time_s,signal,value,unit',
      '0.1,rpm,800,rpm',
      '0.3,coolant_temp,90,°C',
      '0.6,rpm,900,rpm',
      '1.5,rpm,1000,rpm',
      '',
    ]);
  });

  it('writes a summary with codes and statistics', () => {
    const text = toSummary(session, samples, 'metric');
    expect(text).toContain('Stored codes: P0174');
    expect(text).toContain('Check-engine light: ON');
    expect(text).toContain('not yet complete: Catalyst');
    expect(text).toContain('| Engine speed | rpm | 800 | 900 | 1000 | 800 | 1000 | 3 |');
  });
});
