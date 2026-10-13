import type { MonitorTest } from '../scan';

/**
 * Vehicle-specific knowledge that the OBD2 standard leaves to the
 * manufacturer. On pre-CAN vehicles the self-test ids (service 06) mean
 * whatever the maker decided, and the only source is the service manual.
 *
 * Entries are matched on the VIN and should be as narrow as their source:
 * a table from one model year's manual says nothing about another's.
 */
interface VehicleNotes {
  description: string;
  /** VIN test, e.g. model and year digits. */
  matches(vin: string): boolean;
  /** Names for service 06 test ids, keyed by two-digit hex id. */
  selfTests: Record<string, string>;
}

const VEHICLES: VehicleNotes[] = [
  {
    // Source: 2005 Frontier service manual, EC section (pages EC-691, EC-692),
    // as relayed by an owner. Not checked against other years or engines.
    description: '2005 Nissan Frontier 4.0L (VQ40DE)',
    matches: (vin) => /^1N6AD0.{3}5/.test(vin),
    selfTests: {
      '01': 'Catalyst, bank 1',
      '02': 'Catalyst, bank 1',
      '03': 'Catalyst, bank 2',
      '04': 'Catalyst, bank 2',
      '05': 'EVAP system',
      '06': 'EVAP system',
      '07': 'EVAP system',
    },
  },
];

/**
 * A manufacturer's name for a self-test, if we know this vehicle. Works from
 * the raw record, so it also labels logs saved before the name was known.
 */
export function selfTestName(vin: string | null | undefined, test: MonitorTest): string | null {
  const id = /^Test \$([0-9A-F]{2})$/.exec(test.monitor)?.[1];
  if (!vin || !id) return null;
  return VEHICLES.find((v) => v.matches(vin))?.selfTests[id] ?? null;
}
