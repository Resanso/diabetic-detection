/** Pembungkus IndexedDB kecil: satu basis data, beberapa tabel dengan kunci `id`. */
const DB_NAME = "retinova";
const STORES = ["patients", "screenings", "directory"] as const;
export type StoreName = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Penyimpanan HP penuh atau tidak tersedia."));
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, id: string) => run<T | undefined>(store, "readonly", (s) => s.get(id)),
  all: <T>(store: StoreName) => run<T[]>(store, "readonly", (s) => s.getAll()),
  put: <T>(store: StoreName, value: T) => run<void>(store, "readwrite", (s) => void s.put(value)),
  del: (store: StoreName, id: string) => run<void>(store, "readwrite", (s) => void s.delete(id)),
  clear: (store: StoreName) => run<void>(store, "readwrite", (s) => void s.clear()),
  /** Ganti seluruh isi tabel dalam satu transaksi. */
  replace: <T>(store: StoreName, values: T[]) =>
    run<void>(store, "readwrite", (s) => {
      s.clear();
      values.forEach((v) => s.put(v));
    }),
};
