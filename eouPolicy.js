/**
 * End-of-utterance (тишина Speechmatics) + смягчённый scorer.
 * Strict pass без изменений; relaxed только после EndOfUtterance и при
 * достаточном len + хотя бы одном совпавшем слове хвоста эталона.
 */

import {
  normalizeText,
  countMatchedTailWords,
  MIN_TAIL_SCORE,
} from './scorer.js';
import { computeGateStatus, scoreHypothesisPair } from './eosLog.js';

/** max_delay должен быть > end_of_utterance_silence_trigger (~1 с паузы). */
export const SM_RT_MAX_DELAY = 1.15;
export const SM_EOU_SILENCE_TRIGGER_SEC = 0.95;

export function speechmaticsConversationConfig() {
  return {
    end_of_utterance_silence_trigger: SM_EOU_SILENCE_TRIGGER_SEC,
  };
}

function refWordCount(speakableText) {
  return normalizeText(speakableText).split(' ').filter(Boolean).length;
}

/** Лучшие метрики за ход (peak), не только снимок в момент EoU. */
export function mergePeakMetrics(metrics, bestNearMissTrim) {
  if (!bestNearMissTrim) return { ...metrics };
  return {
    ...metrics,
    score: Math.max(metrics.score, bestNearMissTrim.score ?? 0),
    tail: Math.max(metrics.tail, bestNearMissTrim.tail ?? 0),
    lenRatio: Math.max(metrics.lenRatio, bestNearMissTrim.lenRatio ?? 0),
  };
}

/**
 * Можно ли учитывать EoU: достаточно «объёма» и ≥1 слово хвоста эталона в гипотезе.
 */
export function assessEouEligibility(speakableText, hypothesisTrimmed, thresholds) {
  const n = refWordCount(speakableText);
  const matchedTailWords = countMatchedTailWords(speakableText, hypothesisTrimmed);
  const hypWords = normalizeText(hypothesisTrimmed).split(' ').filter(Boolean);

  const pair = scoreHypothesisPair(speakableText, hypothesisTrimmed, thresholds);
  const m = pair.metricsTrimmed;

  let minLenForEou = thresholds.minLenRatio * 0.85;
  let lenOk = m.lenRatio >= minLenForEou || m.coverage >= minLenForEou;

  if (n <= 2) {
    minLenForEou = n === 1 ? 0.5 : 0.45;
    lenOk = hypWords.length >= 1 && matchedTailWords >= 1;
  } else if (n <= 5) {
    minLenForEou = Math.min(thresholds.minLenRatio, 0.5);
    lenOk = m.lenRatio >= minLenForEou || m.coverage >= 0.55;
  }

  const tailTouchOk = matchedTailWords >= 1;
  const eligible = lenOk && tailTouchOk;

  return {
    eligible,
    tailTouchOk,
    refWordCount: n,
    matchedTailWords,
    minLenForEou,
    lenRatio: m.lenRatio,
    coverage: m.coverage,
    metrics: m,
  };
}

/** 0…1 — насколько «дочитано» для силы смягчения tail/score. */
export function eouLenSignificance(metrics, thresholds, n) {
  const len = Math.max(metrics.lenRatio, metrics.coverage ?? 0);
  if (n <= 1) return matchedWordSignificance(len, 1, 0.85);
  if (n === 2) return matchedWordSignificance(len, 1, 0.9);
  const floor = thresholds.minLenRatio;
  const full = Math.min(1.05, floor + 0.12);
  if (len <= floor * 0.92) return 0;
  if (len >= full) return 1;
  return (len - floor * 0.92) / (full - floor * 0.92);
}

function matchedWordSignificance(len, fullAt, startAt) {
  if (len < startAt) return 0;
  if (len >= fullAt) return 1;
  return (len - startAt) / (fullAt - startAt);
}

export function relaxedThresholdsForEou(strictThresholds, significance, refWordCount) {
  const sig = Math.max(0, Math.min(1, significance));
  const tailRelax = 0.08 + 0.14 * sig;
  const scoreRelax = 0.04 + 0.1 * sig;

  if (refWordCount <= 2) {
    return {
      minLenRatio: strictThresholds.minLenRatio,
      scoreThreshold: Math.max(0.5, strictThresholds.scoreThreshold - 0.12),
      minTailScore: Math.max(0.5, MIN_TAIL_SCORE - 0.22),
      tailRelax,
      scoreRelax,
    };
  }

  return {
    minLenRatio: strictThresholds.minLenRatio,
    scoreThreshold: strictThresholds.scoreThreshold - scoreRelax,
    minTailScore: MIN_TAIL_SCORE - tailRelax,
    tailRelax,
    scoreRelax,
  };
}

function computeRelaxedGateStatus(metrics, relaxed) {
  const failedGates = [];
  const gateMargins = {};
  if (metrics.lenRatio < relaxed.minLenRatio) {
    failedGates.push('lenRatio');
    gateMargins.lenRatio = Number((relaxed.minLenRatio - metrics.lenRatio).toFixed(4));
  }
  if (metrics.score < relaxed.scoreThreshold) {
    failedGates.push('score');
    gateMargins.score = Number((relaxed.scoreThreshold - metrics.score).toFixed(4));
  }
  if (metrics.tail < relaxed.minTailScore) {
    failedGates.push('tail');
    gateMargins.tail = Number((relaxed.minTailScore - metrics.tail).toFixed(4));
  }
  const passed =
    metrics.lenRatio >= relaxed.minLenRatio &&
    metrics.score >= relaxed.scoreThreshold &&
    metrics.tail >= relaxed.minTailScore;
  return { failedGates, gateMargins, passed };
}

/**
 * @param {'final'|'eou'} source
 * @returns {{ action: 'finish'|'continue', finishReason?: string, detail: object }}
 */
export function evaluateActorTurnCompletion({
  speakableText,
  hypothesisRaw,
  thresholds,
  bestNearMissTrim,
  source,
  eouIndex = 0,
}) {
  const pair = scoreHypothesisPair(speakableText, hypothesisRaw, thresholds);
  const metrics = mergePeakMetrics(pair.metricsTrimmed, bestNearMissTrim);
  const strict = computeGateStatus(metrics, thresholds);

  const detail = {
    source,
    eouIndex,
    hypothesisTrimmed: pair.hypothesisTrimmed,
    metrics,
    strictPassed: strict.passed,
    strictFailedGates: strict.failedGates,
    pair,
  };

  if (strict.passed) {
    return {
      action: 'finish',
      finishReason: source === 'eou' ? 'auto' : 'auto',
      detail: { ...detail, mode: 'strict' },
    };
  }

  if (source !== 'eou') {
    return { action: 'continue', detail: { ...detail, mode: 'strict_only' } };
  }

  const eligibility = assessEouEligibility(
    speakableText,
    pair.hypothesisTrimmed,
    thresholds,
  );
  detail.eligibility = eligibility;

  if (!eligibility.eligible) {
    return {
      action: 'continue',
      detail: {
        ...detail,
        mode: 'eou_ignored',
        eouIgnoreReason: eligibility.tailTouchOk ? 'len_low' : 'no_tail_word',
      },
    };
  }

  const n = eligibility.refWordCount;
  if (metrics.lenRatio < thresholds.minLenRatio && n > 2) {
    return {
      action: 'continue',
      detail: { ...detail, mode: 'eou_ignored', eouIgnoreReason: 'strict_len_not_met' },
    };
  }

  const significance = eouLenSignificance(metrics, thresholds, n);
  const relaxedTh = relaxedThresholdsForEou(thresholds, significance, n);
  const relaxed = computeRelaxedGateStatus(metrics, relaxedTh);

  detail.significance = significance;
  detail.relaxedThresholds = relaxedTh;
  detail.relaxedPassed = relaxed.passed;
  detail.relaxedFailedGates = relaxed.failedGates;
  detail.relaxedGateMargins = relaxed.gateMargins;

  if (relaxed.passed) {
    return {
      action: 'finish',
      finishReason: 'auto_eou',
      detail: { ...detail, mode: 'relaxed_eou' },
    };
  }

  return {
    action: 'continue',
    detail: { ...detail, mode: 'eou_no_relaxed_pass' },
  };
}

export function readEouTuningFromUrl() {
  if (typeof window === 'undefined' || !window.location?.search) {
    return { disableEou: false, silenceSec: SM_EOU_SILENCE_TRIGGER_SEC };
  }
  const p = new URLSearchParams(window.location.search);
  return {
    disableEou: p.get('noEou') === '1',
    silenceSec: Math.min(1.1, Math.max(0.4, parseFloat(p.get('eouSilence') || '') || SM_EOU_SILENCE_TRIGGER_SEC)),
  };
}
