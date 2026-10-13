import type { Sample } from '../obd/poller';
import { appendChunk, putSession } from './db';
import type { SampleColumns, Session } from './types';

const FLUSH_INTERVAL_MS = 3000;

/**
 * Writes a session to IndexedDB as it happens. Samples are flushed every few
 * seconds, so a dropped connection, a closed tab or a dead phone battery
 * loses at most the last few seconds.
 */
export class Recorder {
  private buffer: SampleColumns = { t: [], k: [], v: [] };
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly onHide = () => {
    if (document.visibilityState === 'hidden') void this.flush();
  };

  constructor(readonly session: Session) {}

  async start(): Promise<void> {
    await putSession(this.session);
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onHide);
  }

  add(sample: Sample): void {
    let k = this.session.signalIds.indexOf(sample.signalId);
    if (k === -1) k = this.session.signalIds.push(sample.signalId) - 1;
    this.buffer.t.push(sample.t);
    this.buffer.k.push(k);
    this.buffer.v.push(sample.v);
    this.session.sampleCount++;
    this.session.endedAt = this.session.startedAt + sample.t;
  }

  /** Saves a change to the session record itself (codes, note). */
  update(change: Partial<Pick<Session, 'codes' | 'scan' | 'note'>>): void {
    Object.assign(this.session, change);
    this.writing = this.writing.then(() => putSession({ ...this.session })).catch(() => {});
  }

  flush(): Promise<void> {
    if (this.buffer.t.length === 0) return this.writing;
    const samples = this.buffer;
    this.buffer = { t: [], k: [], v: [] };
    const seq = this.seq++;
    const snapshot = { ...this.session, signalIds: [...this.session.signalIds] };
    this.writing = this.writing.then(() => appendChunk(snapshot, seq, samples)).catch(() => {});
    return this.writing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onHide);
    await this.flush();
  }
}
