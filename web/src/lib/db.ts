import type { Checkpoint, Correction, SessionRecord, TraceEntry } from '../../../shared/src/types';

export interface StudyRecord {
  id: string;
  sessionId: string;
  goal: string;
  mode: string;
  startedAt: number;
  endedAt: number;
  events: { t: number; type: string; detail: string; state?: string }[];
  video?: Blob;
  mimeType?: string;
}

const DB_NAME = 'deep-work-field';
const DB_VERSION = 1;
export type StoreName = 'checkpoints' | 'sessions' | 'trace' | 'corrections' | 'study';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['checkpoints', 'sessions', 'trace', 'corrections', 'study'] as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function withStore<T>(name: StoreName, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const request = fn(tx.objectStore(name));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putItem<T>(store: StoreName, item: T): Promise<void> {
  await withStore(store, 'readwrite', (s) => s.put(item as unknown as Record<string, unknown>));
}

export async function getItem<T>(store: StoreName, key: string): Promise<T | undefined> {
  return withStore<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  return withStore<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function deleteItem(store: StoreName, key: string): Promise<void> {
  await withStore(store, 'readwrite', (s) => s.delete(key));
}

export async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  await putItem('checkpoints', cp);
}

export async function saveSession(session: SessionRecord): Promise<void> {
  await putItem('sessions', session);
}

export async function saveTrace(entries: TraceEntry[]): Promise<void> {
  await putItem('trace', {
    id: entries[0]?.sessionId ?? `trace_${Date.now()}`,
    sessionId: entries[0]?.sessionId,
    entries,
  });
}

export async function saveCorrection(correction: Correction): Promise<void> {
  await putItem('corrections', correction);
}

export async function loadCorrections(goal?: string): Promise<Correction[]> {
  const all = await getAll<Correction>('corrections');
  return goal ? all.filter((c) => c.goal === goal) : all;
}

export async function saveStudyRecord(record: StudyRecord): Promise<void> {
  await putItem('study', record);
}

export async function loadStudyRecords(): Promise<StudyRecord[]> {
  return getAll<StudyRecord>('study');
}
