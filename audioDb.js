/**
 * Тонкая обёртка над IndexedDB для хранения аудио-блобов между страницами.
 * Ключи: partner_0, partner_1, ... для партнёрских сегментов.
 */

const DB_NAME  = 'cinemaCastingAudio';
const STORE    = 'clips';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Удалить все ключи, начинающиеся с prefix.
 * Обход через openKeyCursor + cursor.delete() в Firefox иногда даёт
 * DOMException «mutation operation... did not allow mutations» — надёжнее getAllKeys + delete.
 */
async function dbDeleteKeyPrefix(prefix) {
  const db = await openDb();
  const keysToDelete = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => {
      const all = req.result || [];
      resolve(all.filter((k) => String(k).startsWith(prefix)));
    };
    req.onerror = () => reject(req.error);
  });
  if (keysToDelete.length === 0) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const key of keysToDelete) {
      os.delete(key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const storePartnerAudio = (id, blob) => dbPut(`partner_${id}`, blob);
export const getPartnerAudio   = (id)       => dbGet(`partner_${id}`);
/** Полная очистка хранилища (совместимость; новая сцена). */
export const clearAllAudio     = ()          => dbClear();

/** Удалить только партнёрские дорожки (перед сохранением новых из prep). */
export const clearPartnerClips = () => dbDeleteKeyPrefix('partner_');

/** Записи актёра с репетиции, ключ — индекс шага в sequence. */
export const storeActorRecording = (seqIdx, blob) => dbPut(`actor_${seqIdx}`, blob);
export const getActorRecording = (seqIdx) => dbGet(`actor_${seqIdx}`);
export const clearActorClips = () => dbDeleteKeyPrefix('actor_');

/** Новая сцена / сброс: партнёры + актёр. */
export const clearAllSessionAudio = async () => {
  await clearPartnerClips();
  await clearActorClips();
};

/**
 * Все записи в хранилище (partner_*, actor_*).
 * @returns {Promise<Array<{ key: string, blob: Blob }>>}
 */
export async function getAllAudioClips() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve(out);
        return;
      }
      const val = cur.value;
      if (val instanceof Blob) {
        out.push({ key: String(cur.key), blob: val });
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Полная замена содержимого хранилища (импорт бэкапа).
 * @param {Array<{ key: string, blob: Blob }>} entries
 */
export async function replaceAllAudioClips(entries) {
  await dbClear();
  if (!entries.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const { key, blob } of entries) {
      if (blob instanceof Blob) os.put(blob, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
