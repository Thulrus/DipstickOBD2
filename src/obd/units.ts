import type { Signal, Unit } from './signals';

export type UnitSystem = 'imperial' | 'metric';

interface Conversion {
  unit: string;
  convert(v: number): number;
}

const IMPERIAL: Partial<Record<Unit, Conversion>> = {
  '°C': { unit: '°F', convert: (v) => (v * 9) / 5 + 32 },
  'km/h': { unit: 'mph', convert: (v) => v * 0.621371 },
  km: { unit: 'mi', convert: (v) => v * 0.621371 },
  kPa: { unit: 'psi', convert: (v) => v * 0.145038 },
  'L/h': { unit: 'gal/h', convert: (v) => v * 0.264172 },
};

export function displayUnit(signal: Signal, system: UnitSystem): string {
  const unit = (system === 'imperial' && IMPERIAL[signal.unit]?.unit) || signal.unit;
  return unit === 'count' ? '' : unit;
}

/** Converts a stored (metric) value into the chosen unit system. */
export function toDisplay(signal: Signal, value: number, system: UnitSystem): number {
  const c = system === 'imperial' ? IMPERIAL[signal.unit] : undefined;
  return c ? c.convert(value) : value;
}

export function formatValue(signal: Signal, value: number, system: UnitSystem): string {
  // Pressures gain a decimal in psi, where whole numbers are too coarse.
  const decimals = system === 'imperial' && signal.unit === 'kPa' ? 1 : signal.decimals;
  return toDisplay(signal, value, system).toFixed(decimals);
}

export function defaultUnitSystem(): UnitSystem {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  return /-(US|LR|MM)$/i.test(lang) ? 'imperial' : 'metric';
}
