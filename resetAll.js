import { clearAllFlowState } from './flowState.js';
import { clearAllAudio } from './audioDb.js';

/** Сброс сценария, роли, всех записей в хранилищах браузера (включая IndexedDB). */
export async function resetAllAppData() {
  clearAllFlowState();
  await clearAllAudio();
}
