/**
 * A byte pipe to an ELM327-compatible adapter. Everything above this layer
 * (ELM327 driver, OBD decoding, logging) is transport-agnostic, so adding
 * Web Bluetooth (BLE) later means writing one more of these.
 */
export interface Transport {
  readonly label: string;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: string): Promise<void>;
  onData: ((chunk: string) => void) | null;
  /** Called once when the link drops, whether requested or not. */
  onClose: ((error?: Error) => void) | null;
}
