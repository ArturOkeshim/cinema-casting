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

async function dbDeleteKeyPrefix(prefix) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    const req = os.openKeyCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const k = String(cursor.key);
      if (k.startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
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
