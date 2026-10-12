/**
 * Standard (SAE J1979, service 01) live-data signals. Values are decoded to
 * metric and stored that way; conversion for display happens in units.ts.
 *
 * A signal is one number over time. Most PIDs carry one signal; a few (wide
 * band O2 sensors) carry two, which is why signals and PIDs are separate.
 */
export type Unit = '%' | '°C' | 'rpm' | 'km/h' | 'kPa' | 'g/s' | 'V' | '°' | 's' | 'km' | 'λ' | 'mA' | 'L/h' | 'count';

export interface Signal {
  /** Stable key used in logs and exports. Never rename once released. */
  id: string;
  /** Service 01 PID, or ADAPTER_VOLTAGE_PID for the adapter's own reading. */
  pid: number;
  name: string;
  unit: Unit;
  /** Typical range, used to scale gauges. Not a hard limit. */
  min: number;
  max: number;
  decimals: number;
  /** Fast signals are polled every cycle; slow ones every few seconds. */
  rate: 'fast' | 'slow';
  /** Data bytes needed after the PID byte. */
  bytes: number;
  decode(a: number, b: number, c: number, d: number): number;
}

/** Pseudo-PID: battery voltage measured by the adapter (ATRV), not the ECU. */
export const ADAPTER_VOLTAGE_PID = -1;

const pct = (a: number) => (a * 100) / 255;
const trim = (a: number) => ((a - 128) * 100) / 128;
const temp = (a: number) => a - 40;
const word = (a: number, b: number) => a * 256 + b;
const lambda = (a: number, b: number) => (word(a, b) * 2) / 65536;

type Def = Omit<Signal, 'rate' | 'decimals'> & Partial<Pick<Signal, 'rate' | 'decimals'>>;
const def = (s: Def): Signal => ({ rate: 'slow', decimals: 0, ...s });

function narrowbandO2(pid: number, bank: number, sensor: number): Signal {
  return def({
    id: `o2_b${bank}s${sensor}_voltage`,
    pid,
    name: `O2 sensor B${bank}S${sensor}`,
    unit: 'V',
    min: 0,
    max: 1.275,
    decimals: 2,
    rate: 'fast',
    bytes: 2,
    decode: (a) => a / 200,
  });
}

function widebandO2(pid: number, bank: number, sensor: number, kind: 'voltage' | 'current'): Signal[] {
  const base = { pid, rate: 'fast' as const, bytes: 4 };
  // Both PID families report lambda. A vehicle normally has only one of
  // them, but the ids still have to differ.
  const lambdaId = `af_b${bank}s${sensor}_lambda${kind === 'current' ? '_alt' : ''}`;
  return [
    def({ ...base, id: lambdaId, name: `A/F sensor B${bank}S${sensor} lambda`, unit: 'λ', min: 0.7, max: 1.3, decimals: 3, decode: lambda }),
    kind === 'voltage'
      ? def({ ...base, id: `af_b${bank}s${sensor}_voltage`, name: `A/F sensor B${bank}S${sensor} voltage`, unit: 'V', min: 0, max: 5, decimals: 2, decode: (_a, _b, c, d) => (word(c, d) * 8) / 65536 })
      : def({ ...base, id: `af_b${bank}s${sensor}_current`, name: `A/F sensor B${bank}S${sensor} current`, unit: 'mA', min: -2, max: 2, decimals: 2, decode: (_a, _b, c, d) => word(c, d) / 256 - 128 }),
  ];
}

// Sensor positions follow the PID 13 layout (two banks, up to four sensors
// each), which is what nearly every V6/V8 and inline engine reports.
const O2_POSITIONS: [number, number][] = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [2, 4]];

export const SIGNALS: Signal[] = [
  def({ id: 'rpm', pid: 0x0c, name: 'Engine speed', unit: 'rpm', min: 0, max: 7000, rate: 'fast', bytes: 2, decode: (a, b) => word(a, b) / 4 }),
  def({ id: 'speed', pid: 0x0d, name: 'Vehicle speed', unit: 'km/h', min: 0, max: 200, rate: 'fast', bytes: 1, decode: (a) => a }),
  def({ id: 'throttle', pid: 0x11, name: 'Throttle position', unit: '%', min: 0, max: 100, rate: 'fast', bytes: 1, decode: pct }),
  def({ id: 'engine_load', pid: 0x04, name: 'Engine load', unit: '%', min: 0, max: 100, rate: 'fast', bytes: 1, decode: pct }),
  def({ id: 'maf', pid: 0x10, name: 'Mass air flow', unit: 'g/s', min: 0, max: 250, decimals: 1, rate: 'fast', bytes: 2, decode: (a, b) => word(a, b) / 100 }),
  def({ id: 'map', pid: 0x0b, name: 'Intake manifold pressure', unit: 'kPa', min: 0, max: 255, rate: 'fast', bytes: 1, decode: (a) => a }),
  def({ id: 'timing_advance', pid: 0x0e, name: 'Timing advance', unit: '°', min: -20, max: 60, decimals: 1, rate: 'fast', bytes: 1, decode: (a) => a / 2 - 64 }),
  def({ id: 'stft_b1', pid: 0x06, name: 'Short-term fuel trim B1', unit: '%', min: -25, max: 25, decimals: 1, rate: 'fast', bytes: 1, decode: trim }),
  def({ id: 'ltft_b1', pid: 0x07, name: 'Long-term fuel trim B1', unit: '%', min: -25, max: 25, decimals: 1, bytes: 1, decode: trim }),
  def({ id: 'stft_b2', pid: 0x08, name: 'Short-term fuel trim B2', unit: '%', min: -25, max: 25, decimals: 1, rate: 'fast', bytes: 1, decode: trim }),
  def({ id: 'ltft_b2', pid: 0x09, name: 'Long-term fuel trim B2', unit: '%', min: -25, max: 25, decimals: 1, bytes: 1, decode: trim }),
  def({ id: 'coolant_temp', pid: 0x05, name: 'Coolant temperature', unit: '°C', min: -40, max: 130, bytes: 1, decode: temp }),
  def({ id: 'intake_temp', pid: 0x0f, name: 'Intake air temperature', unit: '°C', min: -40, max: 80, bytes: 1, decode: temp }),
  def({ id: 'fuel_pressure', pid: 0x0a, name: 'Fuel pressure', unit: 'kPa', min: 0, max: 765, bytes: 1, decode: (a) => a * 3 }),
  ...O2_POSITIONS.map(([bank, sensor], i) => narrowbandO2(0x14 + i, bank, sensor)),
  def({ id: 'run_time', pid: 0x1f, name: 'Time since engine start', unit: 's', min: 0, max: 3600, bytes: 2, decode: word }),
  def({ id: 'distance_mil_on', pid: 0x21, name: 'Distance with check-engine light on', unit: 'km', min: 0, max: 1000, bytes: 2, decode: word }),
  ...O2_POSITIONS.flatMap(([bank, sensor], i) => widebandO2(0x24 + i, bank, sensor, 'voltage')),
  def({ id: 'egr_commanded', pid: 0x2c, name: 'Commanded EGR', unit: '%', min: 0, max: 100, bytes: 1, decode: pct }),
  def({ id: 'evap_purge', pid: 0x2e, name: 'Commanded EVAP purge', unit: '%', min: 0, max: 100, bytes: 1, decode: pct }),
  def({ id: 'fuel_level', pid: 0x2f, name: 'Fuel level', unit: '%', min: 0, max: 100, bytes: 1, decode: pct }),
  def({ id: 'warmups_since_clear', pid: 0x30, name: 'Warm-ups since codes cleared', unit: 'count', min: 0, max: 255, bytes: 1, decode: (a) => a }),
  def({ id: 'distance_since_clear', pid: 0x31, name: 'Distance since codes cleared', unit: 'km', min: 0, max: 65535, bytes: 2, decode: word }),
  def({ id: 'baro', pid: 0x33, name: 'Barometric pressure', unit: 'kPa', min: 60, max: 110, bytes: 1, decode: (a) => a }),
  ...O2_POSITIONS.flatMap(([bank, sensor], i) => widebandO2(0x34 + i, bank, sensor, 'current')),
  def({ id: 'cat_temp_b1s1', pid: 0x3c, name: 'Catalyst temperature B1S1', unit: '°C', min: 0, max: 1000, bytes: 2, decode: (a, b) => word(a, b) / 10 - 40 }),
  def({ id: 'cat_temp_b2s1', pid: 0x3d, name: 'Catalyst temperature B2S1', unit: '°C', min: 0, max: 1000, bytes: 2, decode: (a, b) => word(a, b) / 10 - 40 }),
  def({ id: 'module_voltage', pid: 0x42, name: 'Control module voltage', unit: 'V', min: 10, max: 16, decimals: 2, bytes: 2, decode: (a, b) => word(a, b) / 1000 }),
  def({ id: 'absolute_load', pid: 0x43, name: 'Absolute load', unit: '%', min: 0, max: 100, rate: 'fast', bytes: 2, decode: (a, b) => (word(a, b) * 100) / 255 }),
  def({ id: 'commanded_lambda', pid: 0x44, name: 'Commanded lambda', unit: 'λ', min: 0.7, max: 1.3, decimals: 3, rate: 'fast', bytes: 2, decode: lambda }),
  def({ id: 'relative_throttle', pid: 0x45, name: 'Relative throttle position', unit: '%', min: 0, max: 100, rate: 'fast', bytes: 1, decode: pct }),
  def({ id: 'ambient_temp', pid: 0x46, name: 'Ambient air temperature', unit: '°C', min: -40, max: 60, bytes: 1, decode: temp }),
  def({ id: 'accel_pedal', pid: 0x49, name: 'Accelerator pedal position', unit: '%', min: 0, max: 100, rate: 'fast', bytes: 1, decode: pct }),
  def({ id: 'throttle_commanded', pid: 0x4c, name: 'Commanded throttle', unit: '%', min: 0, max: 100, rate: 'fast', bytes: 1, decode: pct }),
  def({ id: 'oil_temp', pid: 0x5c, name: 'Engine oil temperature', unit: '°C', min: -40, max: 150, bytes: 1, decode: temp }),
  def({ id: 'fuel_rate', pid: 0x5e, name: 'Fuel rate', unit: 'L/h', min: 0, max: 60, decimals: 1, rate: 'fast', bytes: 2, decode: (a, b) => word(a, b) / 20 }),
  def({ id: 'battery_voltage', pid: ADAPTER_VOLTAGE_PID, name: 'Battery voltage (at OBD port)', unit: 'V', min: 10, max: 16, decimals: 1, bytes: 0, decode: (a) => a }),
];

export const SIGNAL_BY_ID: ReadonlyMap<string, Signal> = new Map(SIGNALS.map((s) => [s.id, s]));

/** Signals worth showing first on a fresh install, in display order. */
export const DEFAULT_SIGNAL_IDS = ['rpm', 'speed', 'coolant_temp', 'engine_load', 'throttle', 'stft_b1', 'ltft_b1', 'stft_b2', 'ltft_b2', 'maf', 'timing_advance', 'intake_temp', 'battery_voltage'];
