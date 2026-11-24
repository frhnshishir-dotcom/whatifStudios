import type { SaveData } from './format';

export interface SlotMeta {
  id: string;
  name: string;
  seed: number;
  savedAt: string;
  /** Small top-down preview (PNG data URL). */
  thumb?: string;
  /** Size of the stored JSON (bytes). */
  size: number;
}

interface Backend {
  kind: 'indexeddb' | 'localstorage' | 'memory';
  list(): Promise<SlotMeta[]>;
  get(id: string): Promise<SaveData | null>;
  put(meta: SlotMeta, data: SaveData): Promise<void>;
  del(id: string): Promise<void>;
}

const DB = 'lumenwild', VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function idbBackend(idb: IDBFactory): Promise<Backend> {
  const open = idb.open(DB, VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
  };
  const db = await req(open);
  const tx = (stores: string[], mode: IDBTransactionMode) => db.transaction(stores, mode);
  const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error ?? new Error('Storage transaction aborted')); });
  return {
    kind: 'indexeddb',
    list: async () => (await req(tx(['meta'], 'readonly').objectStore('meta').getAll())) as SlotMeta[],
    get: async (id) => ((await req(tx(['data'], 'readonly').objectStore('data').get(id))) as { id: string; data: SaveData } | undefined)?.data ?? null,
    put: async (meta, data) => {
      const t = tx(['meta', 'data'], 'readwrite');
      t.objectStore('meta').put(meta);
      t.objectStore('data').put({ id: meta.id, data });
      await done(t);
    },
    del: async (id) => {
      const t = tx(['meta', 'data'], 'readwrite');
      t.objectStore('meta').delete(id);
      t.objectStore('data').delete(id);
      await done(t);
    },
  };
}

function lsBackend(ls: Storage): Backend {
  const P = 'lumenwild:';
  return {
    kind: 'localstorage',
    list: async () => Object.keys(ls).filter((k) => k.startsWith(P + 'meta:')).map((k) => JSON.parse(ls.getItem(k)!) as SlotMeta),
    get: async (id) => { const s = ls.getItem(P + 'data:' + id); return s ? (JSON.parse(s) as SaveData) : null; },
    put: async (meta, data) => { ls.setItem(P + 'data:' + meta.id, JSON.stringify(data)); ls.setItem(P + 'meta:' + meta.id, JSON.stringify(meta)); },
    del: async (id) => { ls.removeItem(P + 'data:' + id); ls.removeItem(P + 'meta:' + id); },
  };
}

function memBackend(): Backend {
  const m = new Map<string, { meta: SlotMeta; data: SaveData }>();
  return {
    kind: 'memory',
    list: async () => [...m.values()].map((v) => v.meta),
    get: async (id) => m.get(id)?.data ?? null,
    put: async (meta, data) => { m.set(meta.id, { meta, data: JSON.parse(JSON.stringify(data)) }); },
    del: async (id) => { m.delete(id); },
  };
}

/**
 * Save slots in the browser (IndexedDB; falls back to localStorage, then memory). Listing reads only the small
 * metadata records; the world data is fetched when a slot is loaded.
 */
export class SlotStore {
  private constructor(private b: Backend) {}
  get kind(): Backend['kind'] { return this.b.kind; }

  static async open(env: { indexedDB?: IDBFactory; localStorage?: Storage } = globalThis as never): Promise<SlotStore> {
    if (env.indexedDB) {
      try { return new SlotStore(await idbBackend(env.indexedDB)); } catch { /* fall through */ }
    }
    try {
      if (env.localStorage) { env.localStorage.setItem('lumenwild:probe', '1'); env.localStorage.removeItem('lumenwild:probe'); return new SlotStore(lsBackend(env.localStorage)); }
    } catch { /* fall through */ }
    return new SlotStore(memBackend());
  }

  async list(): Promise<SlotMeta[]> {
    const l = await this.b.list();
    // Autosave first, then newest first.
    return l.sort((a, b) => (a.id === 'autosave' ? -1 : b.id === 'autosave' ? 1 : b.savedAt.localeCompare(a.savedAt)));
  }

  /** Save into a slot (`id` null = a new slot). Returns the slot's metadata. */
  async save(id: string | null, data: SaveData, thumb?: string): Promise<SlotMeta> {
    const json = JSON.stringify(data);
    const meta: SlotMeta = { id: id ?? `slot-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, name: data.name, seed: data.seed, savedAt: data.savedAt, thumb, size: json.length };
    await this.b.put(meta, data);
    return meta;
  }

  load(id: string): Promise<SaveData | null> { return this.b.get(id); }
  remove(id: string): Promise<void> { return this.b.del(id); }
}
