/**
 * Экспорт / импорт пробы: ZIP (session.json + папка audio/) или старый одиночный JSON с base64.
 */

import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

import {
  BLOCKS_KEY,
  ROLE_KEY,
  SCRIPT_TEXT_KEY,
  REHEARSAL_CURSOR_KEY,
  saveScriptText,
  saveBlocks,
  saveRole,
  saveRehearsalCursor,
  clearAllFlowState,
} from './flowState.js';
import { getAllAudioClips, replaceAllAudioClips } from './audioDb.js';

const FORMAT_ID = 'cinema-casting-session';
/** v2 — ZIP с отдельными файлами; v1 — один JSON, audio в base64 */
const FORMAT_VERSION_ZIP = 2;
const FORMAT_VERSION_JSON_EMBED = 1;

const FLOW_KEYS = [SCRIPT_TEXT_KEY, BLOCKS_KEY, ROLE_KEY, REHEARSAL_CURSOR_KEY];

function getStoredString(key) {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key);
}

function extForBlob(blob) {
  const t = (blob.type || '').toLowerCase();
  if (t.includes('webm')) return '.webm';
  if (t.includes('mp4') || t.includes('m4a')) return '.m4a';
  if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
  if (t.includes('ogg')) return '.ogg';
  if (t.includes('wav')) return '.wav';
  return '.webm';
}

function mimeFromFilename(name) {
  const low = name.toLowerCase();
  if (low.endsWith('.webm')) return 'audio/webm';
  if (low.endsWith('.m4a') || low.endsWith('.mp4')) return 'audio/mp4';
  if (low.endsWith('.mp3')) return 'audio/mpeg';
  if (low.endsWith('.ogg')) return 'audio/ogg';
  if (low.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

function audioKeyFromFilename(baseName) {
  const withoutExt = baseName.replace(/\.[^.]+$/, '');
  return withoutExt;
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

function validateManifest(data) {
  if (!data || typeof data !== 'object') return 'Файл не содержит объект JSON.';
  if (data.format !== FORMAT_ID) return 'Неизвестный формат (ожидался бэкап Cinema Casting).';
  if (data.version !== FORMAT_VERSION_JSON_EMBED && data.version !== FORMAT_VERSION_ZIP) {
    return `Версия файла (${data.version}) не поддерживается.`;
  }
  if (!data.flow || typeof data.flow !== 'object') return 'В файле нет блока flow.';
  if (data.version === FORMAT_VERSION_JSON_EMBED) {
    if (!data.audio || typeof data.audio !== 'object') return 'В файле нет блока audio.';
  }
  return null;
}

function applyFlowFromBackup(flow) {
  let script = '';
  if (typeof flow[SCRIPT_TEXT_KEY] === 'string') script = flow[SCRIPT_TEXT_KEY];
  saveScriptText(script);

  if (typeof flow[BLOCKS_KEY] === 'string') {
    try {
      const parsed = JSON.parse(flow[BLOCKS_KEY]);
      if (Array.isArray(parsed)) saveBlocks(parsed);
      else saveBlocks([]);
    } catch {
      saveBlocks([]);
    }
  } else {
    saveBlocks([]);
  }

  if (typeof flow[ROLE_KEY] === 'string') saveRole(flow[ROLE_KEY]);
  else saveRole('');

  if (typeof flow[REHEARSAL_CURSOR_KEY] === 'string') {
    const n = parseInt(flow[REHEARSAL_CURSOR_KEY], 10);
    saveRehearsalCursor(Number.isFinite(n) && n >= 0 ? n : 0);
  } else {
    saveRehearsalCursor(0);
  }
}

/**
 * Импорт вложенного audio из JSON v1 (base64).
 */
function audioEntriesFromEmbeddedV1(audioObj) {
  const entries = [];
  for (const [key, entry] of Object.entries(audioObj)) {
    if (!entry || typeof entry !== 'object') continue;
    const { mime, data: b64 } = entry;
    if (typeof b64 !== 'string') continue;
    try {
      entries.push({ key, blob: base64ToBlob(b64, typeof mime === 'string' ? mime : '') });
    } catch (e) {
      console.warn('sessionBackup: пропуск записи', key, e);
    }
  }
  return entries;
}

/**
 * Собрать объект flow для session.json.
 */
export async function buildFlowSnapshotObject() {
  const flow = {};
  for (const key of FLOW_KEYS) {
    const v = getStoredString(key);
    if (v !== null) flow[key] = v;
  }
  return flow;
}

/**
 * Полная замена данных из manifest + аудио.
 */
export async function applySessionPayload(flow, audioEntries) {
  clearAllFlowState();
  await replaceAllAudioClips([]);
  applyFlowFromBackup(flow);
  await replaceAllAudioClips(audioEntries);
}

/**
 * Импорт одиночного JSON (v1, audio внутри).
 */
export async function applyJsonBackupEmbedded(data) {
  const err = validateManifest(data);
  if (err) throw new Error(err);
  if (data.version !== FORMAT_VERSION_JSON_EMBED) {
    throw new Error('Этот JSON нужно открывать как часть ZIP (v2) или используйте файл .zip.');
  }
  const entries = audioEntriesFromEmbeddedV1(data.audio);
  await applySessionPayload(data.flow, entries);
}

/**
 * Импорт ZIP: session.json + audio/*
 */
export async function applyZipBackup(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const sessionEntry = zip.file('session.json');
  if (!sessionEntry) {
    throw new Error('В архиве нет session.json в корне.');
  }
  const text = await sessionEntry.async('string');
  const data = JSON.parse(text);
  const err = validateManifest(data);
  if (err) throw new Error(err);
  if (data.version !== FORMAT_VERSION_ZIP) {
    throw new Error('В ZIP ожидается версия 2 (отдельные аудиофайлы).');
  }

  const entries = [];
  const tasks = [];
  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const norm = relativePath.replace(/\\/g, '/');
    if (norm === 'session.json' || norm.toLowerCase().endsWith('/session.json')) continue;
    if (!norm.startsWith('audio/')) continue;
    const base = norm.slice('audio/'.length);
    if (!base || base.includes('/')) continue;
    tasks.push(
      (async () => {
        const buf = await file.async('arraybuffer');
        const key = audioKeyFromFilename(base);
        if (!/^(partner|actor)_\d+$/.test(key)) {
          console.warn('sessionBackup: нестандартное имя файла', base);
        }
        const blob = new Blob([buf], { type: mimeFromFilename(base) });
        entries.push({ key, blob });
      })()
    );
  }
  await Promise.all(tasks);

  await applySessionPayload(data.flow, entries);
}

/**
 * Скачать ZIP: session.json + audio/partner_0.webm …
 */
export async function downloadSessionBackupZip() {
  const flow = await buildFlowSnapshotObject();
  const clips = await getAllAudioClips();

  const manifest = {
    format: FORMAT_ID,
    version: FORMAT_VERSION_ZIP,
    exportedAt: new Date().toISOString(),
    flow,
  };

  const zip = new JSZip();
  zip.file('session.json', JSON.stringify(manifest, null, 0));
  const folder = zip.folder('audio');
  for (const { key, blob } of clips) {
    folder.file(`${key}${extForBlob(blob)}`, blob);
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `cinema-casting-proba-${stamp}.zip`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Выбор файла: .zip (v2) или .json (v1 с base64).
 */
export function pickAndImportSessionBackup(opts = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/zip,.zip,application/json,.json';
  input.setAttribute('aria-label', 'Файл бэкапа пробы');
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const name = (file.name || '').toLowerCase();
      if (name.endsWith('.zip')) {
        const buf = await file.arrayBuffer();
        await applyZipBackup(buf);
      } else if (name.endsWith('.json')) {
        const text = await file.text();
        const data = JSON.parse(text);
        await applyJsonBackupEmbedded(data);
      } else {
        throw new Error('Ожидается файл .zip или .json');
      }
      window.location.reload();
    } catch (e) {
      const msg =
        e instanceof SyntaxError
          ? 'Файл не является корректным JSON.'
          : e instanceof Error
            ? e.message
            : String(e);
      if (opts.onError) opts.onError(msg);
      else window.alert(`Не удалось загрузить пробу: ${msg}`);
    }
  });
  input.click();
}
