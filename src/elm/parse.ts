/** How responses are framed, which depends on the vehicle's bus. */
export type BusKind = 'can11' | 'can29' | 'legacy';

/** One complete response from one ECU. `data[0]` is the service byte (e.g. 0x41). */
export interface Message {
  ecu: string;
  data: number[];
}

/** Maps an ELM327 protocol number (from ATDPN, e.g. "A6") to its framing. */
export function busKindFor(protocol: string): BusKind {
  const p = protocol.replace(/^A/i, '').toUpperCase();
  if (p === '6' || p === '8') return 'can11';
  if (p === '7' || p === '9' || p === 'A') return 'can29';
  return 'legacy';
}

export const PROTOCOL_NAMES: Record<string, string> = {
  '1': 'SAE J1850 PWM',
  '2': 'SAE J1850 VPW',
  '3': 'ISO 9141-2',
  '4': 'ISO 14230-4 KWP (5 baud init)',
  '5': 'ISO 14230-4 KWP (fast init)',
  '6': 'ISO 15765-4 CAN (11 bit, 500 kbaud)',
  '7': 'ISO 15765-4 CAN (29 bit, 500 kbaud)',
  '8': 'ISO 15765-4 CAN (11 bit, 250 kbaud)',
  '9': 'ISO 15765-4 CAN (29 bit, 250 kbaud)',
  A: 'SAE J1939 CAN',
};

function hexBytes(hex: string): number[] | null {
  if (hex.length % 2 !== 0 || !/^[0-9A-F]*$/.test(hex)) return null;
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * Turns raw adapter lines (headers ON) into per-ECU messages. Lines that are
 * not hex data (SEARCHING..., BUS INIT: OK, error text) are skipped.
 *
 * CAN responses are ISO-TP frames and get reassembled per ECU. On the older
 * buses every line is already a complete message: 3 header bytes, payload,
 * 1 checksum byte.
 */
export function parseResponse(lines: string[], bus: BusKind): Message[] {
  return bus === 'legacy' ? parseLegacy(lines) : parseCan(lines, bus === 'can11' ? 3 : 8);
}

function parseLegacy(lines: string[]): Message[] {
  const out: Message[] = [];
  for (const line of lines) {
    const bytes = hexBytes(line.replace(/\s+/g, '').toUpperCase());
    if (!bytes || bytes.length < 5) continue;
    out.push({
      ecu: bytes[2]!.toString(16).toUpperCase().padStart(2, '0'),
      data: bytes.slice(3, -1),
    });
  }
  return out;
}

function parseCan(lines: string[], idChars: number): Message[] {
  const out: Message[] = [];
  const partial = new Map<string, { length: number; data: number[] }>();
  for (const line of lines) {
    const text = line.replace(/\s+/g, '').toUpperCase();
    const ecu = text.slice(0, idChars);
    const bytes = hexBytes(text.slice(idChars));
    if (!bytes || bytes.length < 2 || !/^[0-9A-F]+$/.test(ecu) || ecu.length < idChars) continue;
    const pci = bytes[0]!;
    switch (pci >> 4) {
      case 0: // single frame
        out.push({ ecu, data: bytes.slice(1, 1 + (pci & 0x0f)) });
        break;
      case 1: // first frame of a multi-frame message
        partial.set(ecu, { length: ((pci & 0x0f) << 8) | bytes[1]!, data: bytes.slice(2) });
        break;
      case 2: {
        // consecutive frame
        const p = partial.get(ecu);
        if (!p) break;
        p.data.push(...bytes.slice(1));
        if (p.data.length >= p.length) {
          out.push({ ecu, data: p.data.slice(0, p.length) });
          partial.delete(ecu);
        }
        break;
      }
      default: // flow control and reserved types carry no payload
        break;
    }
  }
  return out;
}
