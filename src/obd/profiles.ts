import type { Signal } from './signals';
import { DEFAULT_SIGNAL_IDS } from './signals';

/**
 * Ready-made signal selections. The adapter reads one signal at a time, so a
 * short list is the only way to see fast-changing things like an oxygen
 * sensor switching. Each profile trades breadth for update rate.
 */
export interface Profile {
  name: string;
  hint: string;
  pick(available: Signal[]): string[];
}

const only = (ids: string[]) => (available: Signal[]) => ids.filter((id) => available.some((s) => s.id === id));
const matching = (re: RegExp) => (available: Signal[]) => available.filter((s) => re.test(s.id)).map((s) => s.id);

export const PROFILES: Profile[] = [
  { name: 'Everyday', hint: 'A general overview', pick: only(DEFAULT_SIGNAL_IDS) },
  {
    name: 'Catalyst test',
    hint: 'Engine speed and the rear (after-catalyst) oxygen sensors, as fast as possible',
    pick: (a) => ['rpm', ...matching(/^o2_b\ds2_voltage$/)(a)].filter((id) => a.some((s) => s.id === id)),
  },
  {
    name: 'Fuel trims',
    hint: 'Trims on both banks with the load, airflow and loop status that explain them',
    pick: only(['rpm', 'engine_load', 'maf', 'stft_b1', 'ltft_b1', 'stft_b2', 'ltft_b2', 'fuel_system_status']),
  },
  {
    name: 'Oxygen sensors',
    hint: 'Every oxygen and air/fuel sensor the vehicle reports',
    pick: (a) => ['rpm', ...matching(/^(o2|af)_/)(a)].filter((id) => a.some((s) => s.id === id)),
  },
  { name: 'Everything', hint: 'All signals; slowest updates', pick: (a) => a.map((s) => s.id) },
];
