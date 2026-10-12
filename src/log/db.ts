import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SampleColumns, Session } from './types';

interface Chunk extends SampleColumns {
  sessionId: string;
  seq: number;
}

interface Schema extends DBSchema {
  sessions: { key: string; value: Session; indexes: { startedAt: number } };
  // Samples are stored a few seconds at a time rather than one row each:
  // an hour of driving is tens of thousands of readings.
  chunks: { key: [string, number]; value: Chunk };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function db(): Promise<IDBPDatabase<Schema>> {
  dbPromise ??= openDB<Schema>('dipstick', 1, {
    upgrade(d) {
      d.createObjectStore('sessions', { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
      d.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] });
    },
  });
  return dbPromise;
}

const chunkRange = (sessionId: string) => IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);

export async function putSession(session: Session): Promise<void> {
  await (await db()).put('sessions', session);
}

export async function appendChunk(session: Session, seq: number, samples: SampleColumns): Promise<void> {
  const tx = (await db()).transaction(['sessions', 'chunks'], 'readwrite');
  await Promise.all([
    tx.objectStore('chunks').put({ sessionId: session.id, seq, ...samples }),
    tx.objectStore('sessions').put(session),
    tx.done,
  ]);
}

/** Newest first. */
export async function listSessions(): Promise<Session[]> {
  return (await (await db()).getAllFromIndex('sessions', 'startedAt')).reverse();
}

export async function getSession(id: string): Promise<Session | undefined> {
  return (await db()).get('sessions', id);
}

export async function loadSamples(sessionId: string): Promise<SampleColumns> {
  const chunks = await (await db()).getAll('chunks', chunkRange(sessionId));
  const out: SampleColumns = { t: [], k: [], v: [] };
  for (const c of chunks) {
    // Not push(...c.t): spreading a large array can overflow the stack.
    for (let i = 0; i < c.t.length; i++) {
      out.t.push(c.t[i]!);
      out.k.push(c.k[i]!);
      out.v.push(c.v[i]!);
    }
  }
  return out;
}

export async function deleteSession(id: string): Promise<void> {
  const tx = (await db()).transaction(['sessions', 'chunks'], 'readwrite');
  await Promise.all([tx.objectStore('sessions').delete(id), tx.objectStore('chunks').delete(chunkRange(id)), tx.done]);
}

/** Asks the browser not to evict logs when storage runs low. */
export async function requestPersistence(): Promise<void> {
  await navigator.storage?.persist?.().catch(() => false);
}
