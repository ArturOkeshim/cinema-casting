/**
 * Режим завершения реплики актёра.
 * - v1: scorer (tail/score/len) + strict на final + relaxed на EoU
 * - v2: только доля длины слов (peak partial) + EndOfUtterance
 *
 * Переопределение в URL: rehearsal.html?eosMode=v1 | ?eosMode=v2
 */
export const EOS_ALGO_MODE = 'v2';

export function resolveEosAlgoMode() {
  if (typeof window !== 'undefined' && window.location?.search) {
    const urlMode = new URLSearchParams(window.location.search).get('eosMode');
    if (urlMode === 'v1' || urlMode === 'v2') return urlMode;
  }
  return EOS_ALGO_MODE;
}

export function isEosV2() {
  return resolveEosAlgoMode() === 'v2';
}
