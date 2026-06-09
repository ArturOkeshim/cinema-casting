/**
 * Диагностика авто-EOS: POST /api/eos-log → logs/eos-debug.jsonl + CSV-таблицы.
 * v2: сырой/обрезанный текст, метрики raw vs trim, timeline finals для офлайн-экспериментов.
 */

import { calcScore, MIN_TAIL_SCORE, trimHypothesisWithMeta } from './scorer.js';

export const EOS_LOG_SCHEMA_VERSION = 3;
const MAX_TIMELINE = 40;
const PARTIAL_THROTTLE_MS = 1000;

let sessionId = null;
let rehearsalRole = '';
let rehearsalStartMs = 0;
let tokenRefreshCount = 0;
let actorTurnCounter = 0;
/** @type {object | null} */
let currentTurn = null;

function nowIso() {
  return new Date().toISOString();
}

function relMsSince(startMs) {
  return Date.now() - startMs;
}

function roundMetrics(raw) {
  return {
    score: Number(raw.score.toFixed(4)),
    coverage: Number(raw.coverage.toFixed(4)),
    fuzzy: Number(raw.fuzzy.toFixed(4)),
    lenRatio: Number(raw.lenRatio.toFixed(4)),
    tail: Number(raw.tail.toFixed(4)),
    tailExact: Number((raw.tailExact ?? raw.tail).toFixed(4)),
    tailCore: Number((raw.tailCore ?? raw.tail).toFixed(4)),
    tailOptionalMatch: Number((raw.tailOptionalMatch ?? 0).toFixed(4)),
  };
}

export function metricsForHypothesis(speakableText, hypothesis, thresholds) {
  const raw = calcScore(speakableText, hypothesis);
  const metrics = roundMetrics(raw);
  const { failedGates, gateMargins, passed } = computeGateStatus(metrics, thresholds);
  return { metrics, failedGates, gateMargins, passed };
}

/** Метрики по сырой гипотезе и после trimHypothesisPrefix. */
export function scoreHypothesisPair(speakableText, hypothesisRaw, thresholds) {
  const { hypothesisRaw: raw, hypothesisTrimmed, trimWordsSkipped, trimApplied } =
    trimHypothesisWithMeta(speakableText, hypothesisRaw);
  const rawPack = metricsForHypothesis(speakableText, raw, thresholds);
  const trimPack = metricsForHypothesis(speakableText, hypothesisTrimmed, thresholds);
  return {
    hypothesisRaw: raw,
    hypothesisTrimmed,
    trimWordsSkipped,
    trimApplied,
    metricsRaw: rawPack.metrics,
    metricsTrimmed: trimPack.metrics,
    failedGatesRaw: rawPack.failedGates,
    failedGatesTrimmed: trimPack.failedGates,
    gateMarginsRaw: rawPack.gateMargins,
    gateMarginsTrimmed: trimPack.gateMargins,
    passedRaw: rawPack.passed,
    passedTrimmed: trimPack.passed,
  };
}

export function computeGateStatus(metrics, thresholds) {
  const failedGates = [];
  const gateMargins = {};
  if (metrics.lenRatio < thresholds.minLenRatio) {
    failedGates.push('lenRatio');
    gateMargins.lenRatio = Number((thresholds.minLenRatio - metrics.lenRatio).toFixed(4));
  }
  if (metrics.score < thresholds.scoreThreshold) {
    failedGates.push('score');
    gateMargins.score = Number((thresholds.scoreThreshold - metrics.score).toFixed(4));
  }
  if (metrics.tail < MIN_TAIL_SCORE) {
    failedGates.push('tail');
    gateMargins.tail = Number((MIN_TAIL_SCORE - metrics.tail).toFixed(4));
  }
  const passed =
    metrics.lenRatio >= thresholds.minLenRatio &&
    metrics.score >= thresholds.scoreThreshold &&
    metrics.tail >= MIN_TAIL_SCORE;
  return { failedGates, gateMargins, passed };
}

function updateBestNearMiss(metrics, source, which = 'trim') {
  if (!currentTurn) return;
  const b = which === 'raw' ? currentTurn.bestNearMissRaw : currentTurn.bestNearMissTrim;
  if (metrics.score > b.score) {
    b.score = metrics.score;
    b.at = source;
  }
  if (metrics.tail > b.tail) {
    b.tail = metrics.tail;
    b.atTail = source;
  }
  if (metrics.lenRatio > b.lenRatio) {
    b.lenRatio = metrics.lenRatio;
    b.atLen = source;
  }
}

function pushTimeline(entry) {
  if (!currentTurn || currentTurn.timeline.length >= MAX_TIMELINE) return;
  currentTurn.timeline.push(entry);
}

async function postEvents(events) {
  if (!events.length) return;
  try {
    const res = await fetch('/api/eos-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
    if (!res.ok) {
      console.warn('[eos-log] server', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.warn('[eos-log] send failed', e);
  }
}

function baseEnvelope() {
  return {
    v: EOS_LOG_SCHEMA_VERSION,
    sessionId,
    role: rehearsalRole,
    ts: nowIso(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

export function initEosLogSession({
  role,
  actorLineCount,
  vocabCount,
  sequenceLength,
  smEouEnabled = true,
  smEouSilenceSec = 0.95,
  eosAlgoMode = 'v1',
}) {
  sessionId = crypto.randomUUID();
  rehearsalRole = role || '';
  rehearsalStartMs = Date.now();
  tokenRefreshCount = 0;
  actorTurnCounter = 0;
  currentTurn = null;
  postEvents([
    {
      ...baseEnvelope(),
      event: 'rehearsal_start',
      actorLineCount,
      vocabCount,
      sequenceLength,
      smEouEnabled,
      smEouSilenceSec,
      eosAlgoMode,
    },
  ]);
}

export function noteTokenRefresh() {
  tokenRefreshCount += 1;
}

export function beginActorTurn({ seqIdx, speakableText, thresholds }) {
  actorTurnCounter += 1;
  currentTurn = {
    seqIdx,
    actorTurnIndex: actorTurnCounter,
    speakableText,
    thresholds: { ...thresholds, minTailScore: MIN_TAIL_SCORE },
    turnStartMs: Date.now(),
    lastPartialText: '',
    partialCount: 0,
    finalCount: 0,
    lastPartialLogMs: 0,
    timeline: [],
    bestNearMissTrim: { score: 0, tail: 0, lenRatio: 0, at: '', atTail: '', atLen: '' },
    bestNearMissRaw: { score: 0, tail: 0, lenRatio: 0, at: '', atTail: '', atLen: '' },
    smError: null,
    smResumeDelayMs: 0,
    eouCount: 0,
    eouPeriods: [],
    lastEouEvaluation: null,
    peakLenRatioTrim: 0,
  };
}

/** v2: лучшая доля длины (trim) за ход — partial может «откатиться». */
export function notePeakLenRatioTrim(lenRatioTrim) {
  if (!currentTurn) return;
  const v = Number(lenRatioTrim);
  if (!Number.isFinite(v)) return;
  if (v > (currentTurn.peakLenRatioTrim || 0)) {
    currentTurn.peakLenRatioTrim = v;
  }
}

/**
 * Период тишины (EndOfUtterance от Speechmatics) внутри реплики актёра.
 * @param {object} payload — результат evaluateActorTurnCompletion.detail + eouIndex
 */
export function recordEndOfUtterance(payload) {
  if (!currentTurn) return;
  currentTurn.eouCount += 1;
  const eouIndex = currentTurn.eouCount;
  const tMs = relMsSince(currentTurn.turnStartMs);

  const period = {
    eouIndex,
    tMs,
    silenceTriggerSec: payload.silenceTriggerSec,
    eligible: payload.eligibility?.eligible ?? false,
    matchedTailWords: payload.eligibility?.matchedTailWords ?? 0,
    refWordCount: payload.eligibility?.refWordCount ?? 0,
    lenRatio: payload.metrics?.lenRatio,
    coverage: payload.metrics?.coverage,
    tail: payload.metrics?.tail,
    score: payload.metrics?.score,
    strictPassed: payload.strictPassed ?? false,
    strictFailedGates: payload.strictFailedGates ?? [],
    relaxedPassed: payload.relaxedPassed ?? false,
    relaxedFailedGates: payload.relaxedFailedGates ?? [],
    mode: payload.mode,
    eouIgnoreReason: payload.eouIgnoreReason ?? '',
    significance: payload.significance,
    wouldFinish:
      payload.mode === 'relaxed_eou' ||
      payload.mode === 'strict' ||
      payload.mode === 'v2_pass',
  };
  currentTurn.eouPeriods.push(period);
  currentTurn.lastEouEvaluation = period;

  pushTimeline({
    kind: 'eou',
    eouIndex,
    tMs,
    eligible: period.eligible,
    matchedTailWords: period.matchedTailWords,
    lenRatio: period.lenRatio,
    tail: period.tail,
    score: period.score,
    strictPassed: period.strictPassed,
    relaxedPassed: period.relaxedPassed,
    mode: period.mode,
    eouIgnoreReason: period.eouIgnoreReason,
    significance: period.significance,
  });
}

export function noteActorSmResumeDelay(ms) {
  if (currentTurn) currentTurn.smResumeDelayMs = ms;
}

export function recordActorSmError(message) {
  if (currentTurn) currentTurn.smError = String(message).slice(0, 500);
  postEvents([
    {
      ...baseEnvelope(),
      event: 'sm_error',
      seqIdx: currentTurn?.seqIdx,
      message: String(message).slice(0, 500),
    },
  ]);
}

/**
 * @param {string} partialText — последний partial от SM
 * @param {string} hypothesisRaw — finalSegments + partial
 */
export function recordPartial(partialText, hypothesisRaw, thresholds) {
  if (!currentTurn) return;
  currentTurn.partialCount += 1;
  currentTurn.lastPartialText = partialText.trim();

  const pair = scoreHypothesisPair(currentTurn.speakableText, hypothesisRaw, thresholds);
  updateBestNearMiss(pair.metricsTrimmed, `partial#${currentTurn.partialCount}`, 'trim');
  updateBestNearMiss(pair.metricsRaw, `partial#${currentTurn.partialCount}`, 'raw');

  const now = Date.now();
  if (now - currentTurn.lastPartialLogMs < PARTIAL_THROTTLE_MS) return;
  currentTurn.lastPartialLogMs = now;

  pushTimeline({
    kind: 'partial',
    tMs: relMsSince(currentTurn.turnStartMs),
    partialText: partialText.trim().slice(0, 120),
    hypothesisRaw: pair.hypothesisRaw.slice(0, 500),
    hypothesisTrimmed: pair.hypothesisTrimmed.slice(0, 500),
    trimWordsSkipped: pair.trimWordsSkipped,
    tailTrim: pair.metricsTrimmed.tail,
    scoreTrim: pair.metricsTrimmed.score,
    tailRaw: pair.metricsRaw.tail,
    scoreRaw: pair.metricsRaw.score,
    wouldPassTrim: pair.passedTrimmed,
    wouldPassRaw: pair.passedRaw,
  });
}

/**
 * @param {string} finalSegmentText — текст этого final-сегмента
 * @param {string} hypothesisRaw — все finals накопленные
 */
export function recordFinal(finalSegmentText, hypothesisRaw, thresholds) {
  if (!currentTurn) return;
  currentTurn.finalCount += 1;
  const idx = currentTurn.finalCount;

  const pair = scoreHypothesisPair(currentTurn.speakableText, hypothesisRaw, thresholds);
  updateBestNearMiss(pair.metricsTrimmed, `final#${idx}`, 'trim');
  updateBestNearMiss(pair.metricsRaw, `final#${idx}`, 'raw');

  pushTimeline({
    kind: 'final',
    finalIndex: idx,
    tMs: relMsSince(currentTurn.turnStartMs),
    segmentText: finalSegmentText.trim().slice(0, 200),
    hypothesisRaw: pair.hypothesisRaw.slice(0, 800),
    hypothesisTrimmed: pair.hypothesisTrimmed.slice(0, 800),
    trimWordsSkipped: pair.trimWordsSkipped,
    trimApplied: pair.trimApplied,
    metricsTrimmed: pair.metricsTrimmed,
    metricsRaw: pair.metricsRaw,
    failedGatesTrimmed: pair.failedGatesTrimmed,
    failedGatesRaw: pair.failedGatesRaw,
    passedTrimmed: pair.passedTrimmed,
    passedRaw: pair.passedRaw,
  });

  return { passed: pair.passedTrimmed, pair };
}

export function getActorTurnSnapshot() {
  if (!currentTurn) return null;
  const t = currentTurn;
  return {
    seqIdx: t.seqIdx,
    actorTurnIndex: t.actorTurnIndex,
    speakableText: t.speakableText,
    thresholds: t.thresholds,
    partialCount: t.partialCount,
    finalCount: t.finalCount,
    timeline: [...t.timeline],
    bestNearMissTrim: { ...t.bestNearMissTrim },
    bestNearMissRaw: { ...t.bestNearMissRaw },
    smError: t.smError,
    smResumeDelayMs: t.smResumeDelayMs,
    eouCount: t.eouCount,
    eouPeriods: [...t.eouPeriods],
    lastEouEvaluation: t.lastEouEvaluation ? { ...t.lastEouEvaluation } : null,
    turnDurationMs: relMsSince(t.turnStartMs),
    rehearsalDurationMs: relMsSince(rehearsalStartMs),
    tokenRefreshCount,
    lastPartialText: t.lastPartialText,
    peakLenRatioTrim: t.peakLenRatioTrim ?? 0,
  };
}

export function clearActorTurn() {
  currentTurn = null;
}

export function flushTurnEnd(payload) {
  clearActorTurn();
  const {
    finishReason,
    seqIdx,
    actorTurnIndex,
    speakableText,
    thresholds,
    hypothesisRaw,
    hypothesisTrimmed,
    trimWordsSkipped,
    trimApplied,
    metricsRaw,
    metricsTrimmed,
    failedGatesRaw,
    failedGatesTrimmed,
    gateMarginsRaw,
    gateMarginsTrimmed,
    passedRaw,
    passedTrimmed,
    hypothesisWithPartialRaw,
    hypothesisWithPartialTrimmed,
    metricsPartialRaw,
    metricsPartialTrimmed,
    partialWouldPassRaw,
    partialWouldPassTrimmed,
    failedGatesPartialTrimmed,
    partialCount,
    finalCount,
    timeline,
    bestNearMissTrim,
    bestNearMissRaw,
    turnDurationMs,
    rehearsalDurationMs,
    tokenRefreshCount: refreshes,
    smError,
    smConnected,
    smResumeDelayMs,
    recordingBytes,
    eouCount,
    eouPeriods,
    lastEouEvaluation,
    smEouSilenceSec,
    eosAlgoMode,
    peakLenRatioTrim,
  } = payload;

  const line = {
    ...baseEnvelope(),
    event: 'turn_end',
    finishReason,
    eosAlgoMode: eosAlgoMode || 'v1',
    peakLenRatioTrim: peakLenRatioTrim ?? 0,
    seqIdx,
    actorTurnIndex,
    speakableText,
    speakableWordCount: speakableText.split(/\s+/).filter(Boolean).length,
    thresholds,
    hypothesisRaw,
    hypothesisTrimmed,
    trimWordsSkipped,
    trimApplied,
    metricsRaw,
    metricsTrimmed,
    failedGatesRaw,
    failedGatesTrimmed,
    gateMarginsRaw,
    gateMarginsTrimmed,
    passedRaw,
    passedTrimmed,
    hypothesisWithPartialRaw,
    hypothesisWithPartialTrimmed,
    metricsPartialRaw,
    metricsPartialTrimmed,
    partialWouldPassRaw,
    partialWouldPassTrimmed,
    failedGatesPartialTrimmed,
    partialCount,
    finalCount,
    timeline,
    bestNearMissTrim,
    bestNearMissRaw,
    turnDurationMs,
    rehearsalDurationMs,
    tokenRefreshCount: refreshes,
    smError,
    smConnected,
    smResumeDelayMs,
    recordingBytes,
    eouCount: eouCount ?? 0,
    eouPeriods: eouPeriods ?? [],
    lastEouEvaluation: lastEouEvaluation ?? null,
    smEouSilenceSec,
    /** Для обратной совместимости со старым Excel-скриптом */
    hypothesisFinal: hypothesisTrimmed,
    hypothesisWithPartial: hypothesisWithPartialTrimmed,
    metricsFinal: metricsTrimmed,
    metricsWithPartial: metricsPartialTrimmed,
    failedGatesFinal: failedGatesTrimmed,
    failedGatesWithPartial: failedGatesPartialTrimmed,
    gateMarginsFinal: gateMarginsTrimmed,
    partialWouldPass: partialWouldPassTrimmed,
  };

  if (finishReason === 'manual') {
    console.warn('[eos-log] manual_skip', {
      seqIdx,
      failedGatesTrimmed,
      gateMarginsTrimmed: gateMarginsTrimmed,
      metricsTrimmed,
      trimApplied,
      trimWordsSkipped,
    });
  }

  postEvents([line]);
}

export function logSmTokenFail(seqIdx, message) {
  postEvents([
    {
      ...baseEnvelope(),
      event: 'sm_token_fail',
      seqIdx,
      message: String(message).slice(0, 300),
    },
  ]);
}

export function logRehearsalEnd({ completed, cursor }) {
  postEvents([
    {
      ...baseEnvelope(),
      event: 'rehearsal_end',
      completed,
      cursor,
      rehearsalDurationMs: relMsSince(rehearsalStartMs),
      tokenRefreshCount,
    },
  ]);
}
