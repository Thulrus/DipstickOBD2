import { ElmError, type Elm327 } from '../elm/elm327';
import type { Message } from '../elm/parse';
import { decodeDtc, decodeMonitorStatus, parseDtcs } from './dtc';

/**
 * A read-only sweep of every control module that will talk to us (airbag, ABS,
 * body, transmission...), not just the engine computer. We don't need to know
 * what is in the vehicle: ask everything that might answer, keep whatever
 * does, and hand the raw codes over for the user (or an AI) to look up.
 *
 * Only "read stored codes" requests are ever sent. Nothing here can clear or
 * change anything.
 */

export interface ModuleCode {
  /** The code as the SAE letter-and-digits form, e.g. "B0051-11". See `ModuleResult.codeFormat`. */
  code: string;
  /** The code exactly as the module sent it (hex). */
  raw: string;
  /** The module's status byte (hex). */
  status: string;
  /** What the standard UDS status bits say. Empty for KWP2000, whose status bits are module-defined. */
  flags: string[];
}

export interface ModuleResult {
  /** CAN id we sent the request to, e.g. "7B0". "7DF" means everyone at once. */
  requestId: string;
  /** CAN id the module answered from, e.g. "7B8". This identifies the module. */
  responseId: string;
  protocol: 'UDS' | 'KWP2000' | 'OBD-II';
  codes: ModuleCode[];
  /** Other facts the module volunteered (calibration ids, name...), one per line. */
  info?: string[];
  /** The whole reply as hex, so nothing is lost if our reading of it is wrong. */
  raw: string;
  /** Set when the module answered but declined to give codes. */
  note?: string;
}

export interface ModuleScan {
  readAt: number;
  /** False when the vehicle's bus can't be scanned this way; `note` says why. */
  supported: boolean;
  modules: ModuleResult[];
  /** How many request ids were tried. */
  probed: number;
  /** False if the scan was stopped before it covered every id. */
  complete: boolean;
  /**
   * `can-sweep`: tried every diagnostic id on 11-bit CAN, so it can reach airbag, ABS and so on.
   * `emissions-only`: older buses, where the OBD port reaches only the emissions-related computers.
   */
  method: 'can-sweep' | 'emissions-only';
  note?: string;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hex = (bytes: number[]) => bytes.map(hex2).join(' ');

/** The status byte defined by ISO 14229 for UDS. */
const STATUS_BITS = [
  'test failed',
  'failed this drive cycle',
  'pending',
  'confirmed',
  'test not completed since clear',
  'failed since clear',
  'test not completed this drive cycle',
  'warning light requested',
];

export function statusFlags(status: number): string[] {
  return STATUS_BITS.filter((_, bit) => status & (1 << bit));
}

const REFUSALS: Record<number, string> = {
  0x10: 'general reject',
  0x11: 'service not supported',
  0x12: 'sub-function not supported',
  0x13: 'incorrect message length',
  0x21: 'busy',
  0x22: 'conditions not correct',
  0x31: 'request out of range',
  0x33: 'security access denied',
  0x78: 'response pending',
};

/**
 * UDS "report DTC by status mask" reply: 59 02, availability mask, then four
 * bytes per code (three of code, one of status). The three code bytes follow
 * ISO 15031-6 on most vehicles: the first two read like a normal P/C/B/U code
 * and the third is a failure-type byte that we append after a dash.
 */
export function parseUdsDtcs(data: number[]): ModuleCode[] {
  const out: ModuleCode[] = [];
  for (let i = 3; i + 3 < data.length; i += 4) {
    const [hi, mid, lo, status] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (hi === 0 && mid === 0 && lo === 0) continue;
    out.push({ code: `${decodeDtc(hi, mid)}-${hex2(lo)}`, raw: hex([hi, mid, lo]), status: hex2(status), flags: statusFlags(status) });
  }
  return out;
}

/** KWP2000 "read DTC by status" reply: 58, count, then three bytes per code (two of code, one of status). */
export function parseKwpDtcs(data: number[]): ModuleCode[] {
  const out: ModuleCode[] = [];
  for (let i = 2; i + 2 < data.length; i += 3) {
    const [hi, lo, status] = [data[i]!, data[i + 1]!, data[i + 2]!];
    if (hi === 0 && lo === 0) continue;
    out.push({ code: decodeDtc(hi, lo), raw: hex([hi, lo]), status: hex2(status), flags: [] });
  }
  return out;
}

/** Turns one reply into a result, `'try-kwp'` if the module wants the older request, or null if it isn't an answer to ours. */
function interpret(ecu: string, requestId: string, data: number[]): ModuleResult | 'try-kwp' | null {
  const base = { requestId, responseId: ecu, raw: hex(data) };
  if (data[0] === 0x59 && data[1] === 0x02) return { ...base, protocol: 'UDS', codes: parseUdsDtcs(data) };
  if (data[0] === 0x58) return { ...base, protocol: 'KWP2000', codes: parseKwpDtcs(data) };
  if (data[0] === 0x7f && (data[1] === 0x19 || data[1] === 0x18)) {
    if (data[1] === 0x19 && data[2] === 0x11) return 'try-kwp';
    const why = REFUSALS[data[2] ?? 0] ?? `error 0x${hex2(data[2] ?? 0)}`;
    return { ...base, protocol: data[1] === 0x19 ? 'UDS' : 'KWP2000', codes: [], note: `The module declined to give its codes (${why}).` };
  }
  return null;
}

const UDS_REQUEST = '1902FF'; // report DTCs with any status bit set
const KWP_REQUEST = '1800FF00'; // report DTCs of every group, any status
const FUNCTIONAL_ID = '7DF';
/** Where diagnostic traffic lives on 11-bit CAN. */
const FIRST_ID = 0x700;
const LAST_ID = 0x7ff;
/** Adapter reply timeout while sweeping, in units of 4 ms. */
const SWEEP_TIMEOUT = '20';
/** Probes that fail outright before the sweep gives up (a dead bus, not a quiet one). */
const MAX_BUS_FAILURES = 12;

export async function scanModules(elm: Elm327, onStep?: (step: string) => void, signal?: AbortSignal): Promise<ModuleScan> {
  const scan: ModuleScan = { readAt: Date.now(), supported: true, modules: [], probed: 0, complete: false, method: 'can-sweep' };
  if (elm.bus !== 'can11') return scanEmissionsComputers(elm, scan, onStep, signal);

  const found = new Map<string, ModuleResult>();
  const record = (result: ModuleResult) => {
    // Keep the first answer from each module; a repeat is the same module again.
    if (!found.has(result.responseId)) found.set(result.responseId, result);
  };
  let busFailures = 0;

  /** Sends a request to the current header and records every module that answers. */
  const ask = async (requestId: string, request: string, single: boolean): Promise<void> => {
    const messages: Message[] = await (single ? elm.obdSingle(request) : elm.obd(request));
    for (const { ecu, data } of messages) {
      const result = interpret(ecu, requestId, data);
      if (result === 'try-kwp') {
        const retry = (await elm.obd(KWP_REQUEST)).find((m) => m.ecu === ecu);
        const kwp = retry && interpret(retry.ecu, requestId, retry.data);
        if (kwp && kwp !== 'try-kwp') record(kwp);
      } else if (result) {
        record(result);
      }
    }
  };

  try {
    // Listen for any diagnostic id, not just the engine computer's 7E8-7EF.
    // Best effort: an adapter that refuses still scans the standard ids.
    for (const cmd of [`ATST${SWEEP_TIMEOUT}`, 'ATCF700', 'ATCM700']) await elm.command(cmd).catch(() => {});

    onStep?.('Asking every module at once');
    await elm.command(`ATSH${FUNCTIONAL_ID}`);
    await ask(FUNCTIONAL_ID, UDS_REQUEST, false).catch((e) => {
      if (e instanceof ElmError && e.code === 'closed') throw e;
    });

    // Not every module answers a broadcast, so also try each id directly.
    const alreadyAsked = new Set([...found.values()].map((r) => (parseInt(r.responseId, 16) - 8).toString(16).toUpperCase()));
    for (let id = FIRST_ID; id <= LAST_ID; id++) {
      if (signal?.aborted) break;
      const requestId = id.toString(16).toUpperCase();
      if (requestId === FUNCTIONAL_ID || alreadyAsked.has(requestId)) continue;
      scan.probed++;
      onStep?.(`Trying ${requestId} (${id - FIRST_ID + 1} of ${LAST_ID - FIRST_ID + 1}), ${found.size} found`);
      try {
        await elm.command(`ATSH${requestId}`);
        await ask(requestId, UDS_REQUEST, true);
        busFailures = 0;
      } catch (e) {
        if (e instanceof ElmError && e.code === 'closed') throw e;
        if (++busFailures >= MAX_BUS_FAILURES) {
          scan.note = 'The adapter kept reporting bus errors, so the scan was cut short.';
          break;
        }
      }
    }
    scan.complete = !signal?.aborted && !scan.note;
  } finally {
    // Put the adapter back how live polling expects it, even if we were cut off.
    for (const cmd of ['ATCRA', `ATSH${FUNCTIONAL_ID}`, 'ATST32']) await elm.command(cmd).catch(() => {});
  }

  scan.modules = [...found.values()].sort((a, b) => a.responseId.localeCompare(b.responseId));
  return scan;
}

/** Packs a code string like "P0705" back into its two wire bytes. */
function dtcBytes(code: string): number[] {
  const n = parseInt(code.slice(1), 16);
  return [('PCBU'.indexOf(code[0]!) << 6) | (n >> 8), n & 0xff];
}

/** The data bytes of a service 09 reply: older buses split them across numbered messages, CAN sends one. */
function mode09Bytes(messages: Message[], pid: number, ecu: string): number[] {
  return messages
    .filter((m) => m.ecu === ecu && m.data[0] === 0x49 && m.data[1] === pid)
    .sort((a, b) => (a.data[2] ?? 0) - (b.data[2] ?? 0))
    .flatMap((m) => m.data.slice(3));
}

/** Printable text in a byte run, split wherever the vehicle padded with zeros. */
function textRuns(bytes: number[]): string[] {
  return bytes
    .map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '\0'))
    .join('')
    .split('\0')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Older buses (and 29-bit CAN): the OBD port reaches only the computers the
 * emissions standard covers, usually the engine and sometimes the
 * transmission. We can't reach airbag, ABS or body modules from here, but we
 * can say which computer each code came from and read what else those
 * computers will tell us.
 */
async function scanEmissionsComputers(elm: Elm327, scan: ModuleScan, onStep?: (step: string) => void, signal?: AbortSignal): Promise<ModuleScan> {
  scan.method = 'emissions-only';
  scan.note =
    "This vehicle's OBD port only reaches its emissions-related computers (engine, sometimes transmission). Airbag, ABS and body modules are on a separate diagnostic line that a plain ELM327 adapter cannot reach.";
  const ecus = new Map<string, ModuleResult>();
  const entry = (ecu: string): ModuleResult => {
    let e = ecus.get(ecu);
    if (!e) ecus.set(ecu, (e = { requestId: 'all', responseId: ecu, protocol: 'OBD-II', codes: [], info: [], raw: '' }));
    return e;
  };
  const step = async (label: string, run: () => Promise<void>): Promise<void> => {
    if (signal?.aborted) return;
    scan.probed++;
    onStep?.(label);
    try {
      await run();
    } catch (e) {
      if (e instanceof ElmError && e.code === 'closed') throw e;
      /* this part isn't supported or glitched: keep what else we can get */
    }
  };

  for (const [service, label] of [[0x03, 'stored'], [0x07, 'pending'], [0x0a, 'permanent']] as const) {
    await step(`Reading ${label} codes from each computer`, async () => {
      const messages = await elm.obd(hex2(service));
      for (const ecu of new Set(messages.filter((m) => m.data[0] === service + 0x40).map((m) => m.ecu))) {
        const e = entry(ecu);
        const mine = messages.filter((m) => m.ecu === ecu);
        for (const code of parseDtcs(mine, service, elm.bus)) e.codes.push({ code, raw: hex(dtcBytes(code)), status: '', flags: [label] });
        e.raw += `${e.raw ? '; ' : ''}${label}: ${mine.map((m) => hex(m.data)).join(' | ')}`;
      }
    });
  }
  await step('Reading check-engine light status per computer', async () => {
    for (const m of await elm.obd('0101')) {
      if (m.data[0] !== 0x41 || m.data[1] !== 0x01) continue;
      const s = decodeMonitorStatus(m.data[2] ?? 0, m.data[3] ?? 0, m.data[4] ?? 0, m.data[5] ?? 0);
      const incomplete = s.monitors.filter((x) => !x.complete).map((x) => x.name);
      entry(m.ecu).info!.push(
        `Check-engine light ${s.mil ? 'ON' : 'off'}, ${s.dtcCount} stored code${s.dtcCount === 1 ? '' : 's'}; ${s.monitors.length} readiness monitors${incomplete.length ? `, not complete: ${incomplete.join(', ')}` : ''}`,
      );
    }
  });
  await step('Reading calibration ids', async () => {
    const messages = await elm.obd('0904');
    for (const ecu of new Set(messages.map((m) => m.ecu))) {
      const ids = textRuns(mode09Bytes(messages, 0x04, ecu));
      if (ids.length) entry(ecu).info!.push(`Calibration id: ${ids.join(', ')}`);
    }
  });
  await step('Reading calibration verification numbers', async () => {
    for (const m of await elm.obd('0906')) {
      if (m.data[0] === 0x49 && m.data[1] === 0x06) entry(m.ecu).info!.push(`Calibration verification number (hex): ${hex(m.data.slice(3))}`);
    }
  });
  await step('Reading computer names', async () => {
    const messages = await elm.obd('090A');
    for (const ecu of new Set(messages.map((m) => m.ecu))) {
      const name = textRuns(mode09Bytes(messages, 0x0a, ecu)).join(' ');
      if (name) entry(ecu).info!.push(`Name: ${name}`);
    }
  });
  // The industry's older read-codes request. Most of these computers won't know it; whatever comes back is kept verbatim.
  await step('Trying the older manufacturer read-codes request', async () => {
    for (const m of await elm.obd(KWP_REQUEST)) {
      if (m.data[0] === 0x58 || (m.data[0] === 0x7f && m.data[1] === 0x18)) entry(m.ecu).info!.push(`Service 18 reply (unverified): ${hex(m.data)}`);
    }
  });

  scan.modules = [...ecus.values()].sort((a, b) => a.responseId.localeCompare(b.responseId));
  scan.complete = !signal?.aborted;
  return scan;
}
