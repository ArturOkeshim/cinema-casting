/**
 * v2: завершение реплики только по EndOfUtterance + достаточная доля длины (слова).
 * Без сравнения tail/score/coverage. Используется trim префикса гипотезы (см. scorer.js).
 */

import { normalizeText, trimHypothesisWithMeta } from './scorer.js';

export function refWordCount(speakableText) {
  return normalizeText(speakableText).split(' ').filter(Boolean).length;
}

function hypWordCount(hypothesis) {
  return normalizeText(hypothesis).split(' ').filter(Boolean).length;
}

/**
 * Минимальная доля длины (слова гипотезы / слова эталона).
 * Короткие реплики — мягче; длинные — строже, чтобы пауза на ~70% не завершала ход.
 */
export function adaptiveMinLenRatioV2(refWords) {
  const n = Math.max(0, refWords);
  if (n <= 1) return 1;
  if (n === 2) return 0.95;
  if (n <= 5) return 0.92;
  if (n <= 12) return 0.93;
  if (n <= 25) return 0.94;
  return 0.95;
}

export function computeLenRatioV2(speakableText, hypothesisRaw) {
  const refWords = refWordCount(speakableText);
  if (refWords === 0) {
    return {
      lenRatioRaw: 0,
      lenRatioTrim: 0,
      refWords: 0,
      hypWordsRaw: 0,
      hypWordsTrim: 0,
      hypothesisTrimmed: '',
      trimApplied: false,
      trimWordsSkipped: 0,
    };
  }

  const { hypothesisTrimmed, trimApplied, trimWordsSkipped } =
    trimHypothesisWithMeta(speakableText, hypothesisRaw);
  const hypWordsRaw = hypWordCount(hypothesisRaw);
  const hypWordsTrim = hypWordCount(hypothesisTrimmed);

  return {
    lenRatioRaw: hypWordsRaw / refWords,
    lenRatioTrim: hypWordsTrim / refWords,
    refWords,
    hypWordsRaw,
    hypWordsTrim,
    hypothesisTrimmed,
    trimApplied,
    trimWordsSkipped,
  };
}

/**
 * @param {'eou'} source — v2 реагирует только на EoU
 * @returns {{ action: 'finish'|'continue', finishReason?: string, detail: object }}
 */
export function evaluateActorTurnCompletionV2({
  speakableText,
  hypothesisRaw,
  peakLenRatioTrim = 0,
  source,
  eouIndex = 0,
}) {
  if (source !== 'eou') {
    return { action: 'continue', detail: { mode: 'v2_eou_only', source } };
  }

  const len = computeLenRatioV2(speakableText, hypothesisRaw);
  const minLenRatio = adaptiveMinLenRatioV2(len.refWords);
  const effectiveLenRatio = Math.max(peakLenRatioTrim, len.lenRatioTrim);

  let lenOk;
  if (len.refWords === 1) {
    lenOk = len.hypWordsTrim >= 1;
  } else {
    lenOk = effectiveLenRatio >= minLenRatio;
  }

  const detail = {
    source,
    eouIndex,
    mode: lenOk ? 'v2_pass' : 'v2_ignored_len_low',
    eouIgnoreReason: lenOk ? '' : 'len_low',
    hypothesisTrimmed: len.hypothesisTrimmed,
    trimApplied: len.trimApplied,
    trimWordsSkipped: len.trimWordsSkipped,
    minLenRatio,
    metrics: {
      lenRatio: effectiveLenRatio,
      lenRatioCurrent: len.lenRatioTrim,
      lenRatioPeak: peakLenRatioTrim,
      lenRatioRaw: len.lenRatioRaw,
      refWordCount: len.refWords,
      hypWordCountTrim: len.hypWordsTrim,
    },
    eligibility: {
      eligible: lenOk,
      refWordCount: len.refWords,
      minLenRatio,
      peakLenRatio: peakLenRatioTrim,
      currentLenRatio: len.lenRatioTrim,
      effectiveLenRatio,
      matchedTailWords: 0,
    },
    strictPassed: false,
  };

  if (lenOk) {
    return {
      action: 'finish',
      finishReason: 'auto_eou_v2',
      detail,
    };
  }

  return { action: 'continue', detail };
}
