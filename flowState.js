/** Единые ключи и чтение/запись сцены в localStorage (с fallback на sessionStorage). */

export const BLOCKS_KEY = 'cinemaCasting.roleBlocks';
export const ROLE_KEY = 'cinemaCasting.selectedRole';
export const SCRIPT_TEXT_KEY = 'cinemaCasting.scriptText';
export const REHEARSAL_CURSOR_KEY = 'cinemaCasting.rehearsalCursor';
export const PARTNER_AUDIO_READY_KEY = 'cinemaCasting.partnerAudioReady';

export function loadScriptText() {
  return (
    localStorage.getItem(SCRIPT_TEXT_KEY) ||
    sessionStorage.getItem(SCRIPT_TEXT_KEY) ||
    ''
  );
}

export function saveScriptText(text) {
  const v = typeof text === 'string' ? text : '';
  try {
    localStorage.setItem(SCRIPT_TEXT_KEY, v);
    sessionStorage.setItem(SCRIPT_TEXT_KEY, v);
  } catch {
    sessionStorage.setItem(SCRIPT_TEXT_KEY, v);
  }
}

export function loadBlocks() {
  const raw =
    localStorage.getItem(BLOCKS_KEY) || sessionStorage.getItem(BLOCKS_KEY) || '[]';
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveBlocks(blocks) {
  const raw = JSON.stringify(blocks);
  try {
    localStorage.setItem(BLOCKS_KEY, raw);
    sessionStorage.setItem(BLOCKS_KEY, raw);
  } catch {
    sessionStorage.setItem(BLOCKS_KEY, raw);
  }
}

export function loadRole() {
  return localStorage.getItem(ROLE_KEY) || sessionStorage.getItem(ROLE_KEY) || '';
}

export function saveRole(role) {
  const v = typeof role === 'string' ? role : '';
  try {
    localStorage.setItem(ROLE_KEY, v);
    sessionStorage.setItem(ROLE_KEY, v);
  } catch {
    sessionStorage.setItem(ROLE_KEY, v);
  }
}

export function clearRehearsalCursor() {
  try {
    localStorage.removeItem(REHEARSAL_CURSOR_KEY);
    sessionStorage.removeItem(REHEARSAL_CURSOR_KEY);
  } catch {
    sessionStorage.removeItem(REHEARSAL_CURSOR_KEY);
  }
}

export function loadRehearsalCursor() {
  const raw =
    localStorage.getItem(REHEARSAL_CURSOR_KEY) ||
    sessionStorage.getItem(REHEARSAL_CURSOR_KEY);
  if (raw == null || raw === '') return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function saveRehearsalCursor(idx) {
  const s = String(Math.max(0, idx));
  try {
    localStorage.setItem(REHEARSAL_CURSOR_KEY, s);
    sessionStorage.setItem(REHEARSAL_CURSOR_KEY, s);
  } catch {
    sessionStorage.setItem(REHEARSAL_CURSOR_KEY, s);
  }
}

export function loadPartnerAudioReady() {
  const raw =
    localStorage.getItem(PARTNER_AUDIO_READY_KEY) ||
    sessionStorage.getItem(PARTNER_AUDIO_READY_KEY) ||
    '';
  return raw === '1';
}

export function savePartnerAudioReady(isReady) {
  const v = isReady ? '1' : '0';
  try {
    localStorage.setItem(PARTNER_AUDIO_READY_KEY, v);
    sessionStorage.setItem(PARTNER_AUDIO_READY_KEY, v);
  } catch {
    sessionStorage.setItem(PARTNER_AUDIO_READY_KEY, v);
  }
}

const ALL_FLOW_KEYS = [BLOCKS_KEY, ROLE_KEY, SCRIPT_TEXT_KEY, REHEARSAL_CURSOR_KEY, PARTNER_AUDIO_READY_KEY];

/** Сценарий, блоки, роль, курсор репетиции — localStorage и sessionStorage. */
export function clearAllFlowState() {
  for (const key of ALL_FLOW_KEYS) {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }
}
