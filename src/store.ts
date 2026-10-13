import { create } from 'zustand';
import { Elm327, ElmError, type AdapterInfo } from './elm/elm327';
import { deleteSession, requestPersistence } from './log/db';
import { Recorder } from './log/recorder';
import type { Session } from './log/types';
import { Poller, type Sample } from './obd/poller';
import { ADAPTER_VOLTAGE_PID, DEFAULT_SIGNAL_IDS, SIGNALS, type Signal } from './obd/signals';
import { defaultUnitSystem, type UnitSystem } from './obd/units';
import { scanVehicle, type VehicleScan } from './obd/scan';
import { clearTroubleCodes, readSupportedPids, readTroubleCodes, readVin, type TroubleCodes } from './obd/vehicle';
import { SimulatorTransport } from './transport/simulator';
import type { Transport } from './transport/types';
import { WebSerialTransport } from './transport/webSerial';

/** Readings kept per signal for the dashboard sparkline. */
const TRAIL_LENGTH = 60;
/** The dashboard repaints at most this often, however fast samples arrive. */
const UI_INTERVAL_MS = 150;

export interface LiveValue {
  v: number;
  min: number;
  max: number;
  trail: number[];
}

export type Tab = 'live' | 'codes' | 'history' | 'settings';

interface State {
  tab: Tab;
  status: 'idle' | 'connecting' | 'connected';
  /** What the connect sequence is doing right now. */
  step: string;
  error: string | null;
  /** The device picker was closed without a choice, usually because the adapter wasn't listed. */
  pickerDismissed: boolean;
  demo: boolean;
  adapter: AdapterInfo | null;
  vin: string | null;
  /** Signals this vehicle can report. */
  available: Signal[];
  /** Signal ids the user wants shown and logged, in display order. */
  selected: string[];
  /** Signal ids shown as large tiles at the top of the dashboard. */
  pinned: string[];
  units: UnitSystem;
  /** User preference: keep the screen on while connected. */
  keepAwake: boolean;
  /** Whether the browser is actually holding the screen on right now. */
  screenAwake: boolean;
  live: Record<string, LiveValue>;
  samplesPerSecond: number;
  codes: TroubleCodes | null;
  codesBusy: boolean;
  /** Freeze frame, self-tests and full snapshot; read in the background. */
  scan: VehicleScan | null;
  /** What the background scan is reading, or '' when it isn't running. */
  scanStep: string;
  sessionId: string | null;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or storage disabled: the setting just won't stick */
  }
}

export const useApp = create<State>(() => ({
  tab: 'live',
  status: 'idle',
  step: '',
  error: null,
  pickerDismissed: false,
  demo: false,
  adapter: null,
  vin: null,
  available: [],
  selected: load('dipstick.signals', DEFAULT_SIGNAL_IDS),
  pinned: load('dipstick.pinned', ['rpm', 'coolant_temp']),
  units: load('dipstick.units', defaultUnitSystem()),
  keepAwake: load('dipstick.keepAwake', true),
  screenAwake: false,
  live: {},
  samplesPerSecond: 0,
  codes: null,
  codesBusy: false,
  scan: null,
  scanStep: '',
  sessionId: null,
}));

const set = useApp.setState;
const get = useApp.getState;

// The live connection. Kept out of the store: none of it is render state.
let transport: Transport | null = null;
let elm: Elm327 | null = null;
let poller: Poller | null = null;
let recorder: Recorder | null = null;
let wakeLock: WakeLockSentinel | null = null;
let uiTimer: ReturnType<typeof setInterval> | null = null;
let pendingLive: Record<string, LiveValue> = {};
let supportedPids: ReadonlySet<number> = new Set();
let sampleCounter = 0;

function describe(error: unknown): string {
  if (error instanceof ElmError) {
    return error.code === 'timeout'
      ? "The adapter didn't respond. Check that it's plugged in and that no other app is connected to it."
      : error.message;
  }
  if (error instanceof DOMException && error.name === 'NetworkError') {
    return "Couldn't open the adapter. Check that it's plugged in and powered, paired in your Bluetooth settings, and not in use by another app.";
  }
  return error instanceof Error ? error.message : String(error);
}

async function holdWakeLock(): Promise<void> {
  if (wakeLock || !get().keepAwake) return;
  try {
    const lock = (await navigator.wakeLock?.request('screen')) ?? null;
    wakeLock = lock;
    // The browser releases the lock on its own when the page is hidden.
    lock?.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
      set({ screenAwake: wakeLock !== null });
    });
  } catch {
    wakeLock = null; // denied (e.g. battery saver); logging still works while the screen is on
  }
  set({ screenAwake: wakeLock !== null });
}

function dropWakeLock(): void {
  const lock = wakeLock;
  wakeLock = null;
  void lock?.release().catch(() => {});
  set({ screenAwake: false });
}

// The browser drops a wake lock whenever the page is hidden.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && get().status === 'connected') void holdWakeLock();
  });
}

function onSample(sample: Sample): void {
  recorder?.add(sample);
  sampleCounter++;
  const prev = pendingLive[sample.signalId] ?? get().live[sample.signalId];
  pendingLive[sample.signalId] = {
    v: sample.v,
    min: prev ? Math.min(prev.min, sample.v) : sample.v,
    max: prev ? Math.max(prev.max, sample.v) : sample.v,
    trail: [...(prev?.trail ?? []), sample.v].slice(-TRAIL_LENGTH),
  };
}

function startUiUpdates(): void {
  let lastRate = performance.now();
  uiTimer = setInterval(() => {
    if (Object.keys(pendingLive).length > 0) {
      set((s) => ({ live: { ...s.live, ...pendingLive } }));
      pendingLive = {};
    }
    const now = performance.now();
    if (now - lastRate >= 2000) {
      set({ samplesPerSecond: (sampleCounter * 1000) / (now - lastRate) });
      sampleCounter = 0;
      lastRate = now;
    }
  }, UI_INTERVAL_MS);
}

function pollable(): Signal[] {
  const { available, selected } = get();
  return available.filter((s) => selected.includes(s.id));
}

export async function connect(kind: 'serial' | 'demo'): Promise<void> {
  if (get().status !== 'idle') return;
  set({ status: 'connecting', step: 'Waiting for you to pick the adapter', error: null, pickerDismissed: false, demo: kind === 'demo' });
  let opened: Transport | null = null;
  try {
    if (kind === 'demo') {
      opened = new SimulatorTransport();
    } else {
      try {
        opened = await WebSerialTransport.request();
      } catch (e) {
        // Closing the picker without choosing isn't an error worth showing.
        if (e instanceof DOMException && e.name === 'NotFoundError') return set({ status: 'idle', step: '', pickerDismissed: true });
        throw e;
      }
    }
    set({ step: 'Opening connection' });
    await opened.open();
    const driver = new Elm327(opened);
    opened.onClose = (error) => {
      driver.notifyClosed();
      if (transport === opened) void cleanup(error ? 'Connection to the adapter was lost.' : null);
    };

    const adapter = await driver.init((step) => set({ step }));
    set({ step: 'Reading vehicle information' });
    const vin = await readVin(driver).catch(() => null);
    const pids = await readSupportedPids(driver);
    const available = SIGNALS.filter((s) => (s.pid === ADAPTER_VOLTAGE_PID ? adapter.voltage !== null : pids.has(s.pid)));
    const codes = await readTroubleCodes(driver).catch(() => null);

    const now = Date.now();
    const session: Session = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: now,
      endedAt: now,
      demo: kind === 'demo',
      vehicle: { vin, adapter: adapter.version, protocol: adapter.protocol, protocolName: adapter.protocolName },
      signalIds: [],
      sampleCount: 0,
      codes,
      note: '',
    };
    transport = opened;
    elm = driver;
    recorder = new Recorder(session);
    await recorder.start();
    void requestPersistence();

    supportedPids = pids;
    set({ status: 'connected', step: '', adapter, vin, available, codes, scan: null, live: {}, sessionId: session.id });
    poller = new Poller(driver);
    poller.onSample = onSample;
    poller.onError = (e) => void cleanup(describe(e));
    poller.setSignals(pollable());
    poller.start();
    startUiUpdates();
    void holdWakeLock();
    void runScan();
  } catch (e) {
    if (opened) {
      opened.onClose = null;
      await opened.close().catch(() => {});
    }
    set({ status: 'idle', step: '', error: describe(e) });
  }
}

/** Tears the connection down. `error` is shown to the user if given. */
async function cleanup(error: string | null): Promise<void> {
  const [t, p, r] = [transport, poller, recorder];
  if (!t) return;
  transport = elm = poller = recorder = null;
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = null;
  pendingLive = {};
  set({ status: 'idle', step: '', error, samplesPerSecond: 0, sessionId: null, scanStep: '' });
  dropWakeLock();
  // Poller first, so it can't write to a transport that is closing under it.
  if (p) await Promise.race([p.stop(), new Promise((res) => setTimeout(res, 1500))]);
  await r?.stop();
  // A session with nothing in it is just clutter in the history list.
  if (r && r.session.sampleCount === 0) await deleteSession(r.session.id).catch(() => {});
  t.onClose = null;
  await t.close().catch(() => {});
}

export function disconnect(): Promise<void> {
  return cleanup(null);
}

export function setTab(tab: Tab): void {
  set({ tab });
}

export function setUnits(units: UnitSystem): void {
  save('dipstick.units', units);
  set({ units });
}

export function setKeepAwake(keepAwake: boolean): void {
  save('dipstick.keepAwake', keepAwake);
  set({ keepAwake });
  if (!keepAwake) dropWakeLock();
  else if (get().status === 'connected') void holdWakeLock();
}

export function togglePin(id: string): void {
  const { pinned } = get();
  const next = pinned.includes(id) ? pinned.filter((s) => s !== id) : [...pinned, id];
  save('dipstick.pinned', next);
  set({ pinned: next });
}

export function toggleSignal(id: string): void {
  const { selected } = get();
  const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
  save('dipstick.signals', next);
  set({ selected: next });
  poller?.setSignals(pollable());
}

/**
 * Reads the slow, one-off diagnostic data. It shares the adapter with live
 * polling, so it runs in the background rather than holding up the dashboard.
 */
async function runScan(): Promise<void> {
  const driver = elm;
  if (!driver || get().scanStep) return;
  set({ scanStep: 'Starting' });
  try {
    const scan = await scanVehicle(driver, supportedPids, (scanStep) => elm === driver && set({ scanStep }));
    if (elm !== driver) return; // disconnected (or reconnected) meanwhile
    recorder?.update({ scan });
    set({ scan });
  } finally {
    if (elm === driver || !elm) set({ scanStep: '' });
  }
}

export async function refreshCodes(): Promise<void> {
  if (!elm || get().codesBusy) return;
  set({ codesBusy: true });
  try {
    const codes = await readTroubleCodes(elm);
    recorder?.update({ codes });
    set({ codes });
  } catch (e) {
    set({ error: describe(e) });
  } finally {
    set({ codesBusy: false });
  }
  await runScan();
}

export async function clearCodes(): Promise<void> {
  if (!elm || get().codesBusy) return;
  set({ codesBusy: true });
  try {
    await clearTroubleCodes(elm);
  } catch (e) {
    set({ error: describe(e) });
  } finally {
    set({ codesBusy: false });
  }
  await refreshCodes();
}

export function dismissError(): void {
  set({ error: null });
}
