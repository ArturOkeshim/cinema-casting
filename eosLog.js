/**
 * Диагностика авто-EOS: события уходят на POST /api/eos-log → logs/eos-debug.jsonl
 */

import { calcScore, MIN_TAIL_SCORE } from './scorer.js';

const SCHEMA_VERSION = 1;
const MAX_TIMELINE = 30;
const PARTIAL_THROTTLE_MS = 1000;

let sessionId = null;
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
  };
}

export function metricsForHypothesis(speakableText, hypothesis, thresholds) {
  const raw = calcScore(speakableText, hypothesis);
  const metrics = roundMetrics(raw);
  const { failedGates, gateMargins, passed } = computeGateStatus(metrics, thresholds);
  return { metrics, failedGates, gateMargins, passed };
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

function updateBestNearMiss(metrics, source) {
  if (!currentTurn) return;
  const b = currentTurn.bestNearMiss;
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
    v: SCHEMA_VERSION,
    sessionId,
    ts: nowIso(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

export function initEosLogSession({ role, actorLineCount, vocabCount, sequenceLength }) {
  sessionId = crypto.randomUUID();
  rehearsalStartMs = Date.now();
  tokenRefreshCount = 0;
  actorTurnCounter = 0;
  currentTurn = null;
  postEvents([
    {
      ...baseEnvelope(),
      event: 'rehearsal_start',
      role,
      actorLineCount,
      vocabCount,
      sequenceLength,
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
    bestNearMiss: { score: 0, tail: 0, lenRatio: 0, at: '', atTail: '', atLen: '' },
    smError: null,
  };
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

export function recordPartial(text, metrics, thresholds) {
  if (!currentTurn) return;
  currentTurn.partialCount += 1;
  currentTurn.lastPartialText = text.trim();

  const { passed } = computeGateStatus(metrics, thresholds);
  updateBestNearMiss(metrics, `partial#${currentTurn.partialCount}`);

  const now = Date.now();
  if (now - currentTurn.lastPartialLogMs < PARTIAL_THROTTLE_MS) return;
  currentTurn.lastPartialLogMs = now;

  pushTimeline({
    kind: 'partial',
    tMs: relMsSince(currentTurn.turnStartMs),
    score: Number(metrics.score.toFixed(4)),
    lenRatio: Number(metrics.lenRatio.toFixed(4)),
    tail: Number(metrics.tail.toFixed(4)),
    wouldPass: passed,
  });
}

export function recordFinal(text, metrics, thresholds) {
  if (!currentTurn) return;
  currentTurn.finalCount += 1;
  const idx = currentTurn.finalCount;
  const { failedGates, gateMargins, passed } = computeGateStatus(metrics, thresholds);
  updateBestNearMiss(metrics, `final#${idx}`);

  pushTimeline({
    kind: 'final',
    tMs: relMsSince(currentTurn.turnStartMs),
    text: text.trim().slice(0, 200),
    score: Number(metrics.score.toFixed(4)),
    lenRatio: Number(metrics.lenRatio.toFixed(4)),
    tail: Number(metrics.tail.toFixed(4)),
    coverage: Number(metrics.coverage.toFixed(4)),
    fuzzy: Number(metrics.fuzzy.toFixed(4)),
    passed,
    failedGates,
  });

  if (!passed && (failedGates.length <= 2)) {
    const near = metrics.tail >= MIN_TAIL_SCORE - 0.08 || metrics.score >= thresholds.scoreThreshold - 0.06;
    if (near) {
      postEvents([
        {
          ...baseEnvelope(),
          event: 'near_miss_final',
          seqIdx: currentTurn.seqIdx,
          finalIndex: idx,
          metrics,
          failedGates,
          gateMargins,
        },
      ]);
    }
  }
  return { passed, failedGates, gateMargins };
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
    bestNearMiss: { ...t.bestNearMiss },
    smError: t.smError,
    turnDurationMs: relMsSince(t.turnStartMs),
    rehearsalDurationMs: relMsSince(rehearsalStartMs),
    tokenRefreshCount,
    lastPartialText: t.lastPartialText,
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
    hypothesisFinal,
    hypothesisWithPartial,
    metricsFinal,
    metricsWithPartial,
    failedGatesFinal,
    failedGatesWithPartial,
    gateMarginsFinal,
    gateMarginsWithPartial,
    partialWouldPass,
    partialCount,
    finalCount,
    timeline,
    bestNearMiss,
    turnDurationMs,
    rehearsalDurationMs,
    tokenRefreshCount: refreshes,
    smError,
    smConnected,
    recordingBytes,
  } = payload;

  const line = {
    ...baseEnvelope(),
    event: 'turn_end',
    finishReason,
    seqIdx,
    actorTurnIndex,
    speakableText,
    speakableWordCount: speakableText.split(/\s+/).filter(Boolean).length,
    thresholds,
    hypothesisFinal,
    hypothesisWithPartial,
    metricsFinal,
    metricsWithPartial,
    failedGatesFinal,
    failedGatesWithPartial,
    gateMarginsFinal,
    gateMarginsWithPartial,
    partialWouldPass,
    partialCount,
    finalCount,
    timeline,
    bestNearMiss,
    turnDurationMs,
    rehearsalDurationMs,
    tokenRefreshCount: refreshes,
    smError,
    smConnected,
    recordingBytes,
  };

  if (finishReason === 'manual') {
    console.warn('[eos-log] manual_skip', {
      seqIdx,
      failedGatesFinal,
      gateMarginsFinal,
      metricsFinal,
      metricsWithPartial,
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
