import { getPartnerAudio, getActorRecording, storeActorRecording, clearActorClips } from './audioDb.js';
import { PersistentYandexSttSession } from './recognizer.js';
import { adaptiveThresholds, MIN_TAIL_SCORE } from './scorer.js';
import { initStageNav } from './stageNav.js';
import { loadBlocks, loadRole, loadRehearsalCursor, saveRehearsalCursor, clearRehearsalCursor } from './flowState.js';
import { extractSpeakable, escapeHtml, buildSequence } from './rehearsalSequence.js';
import {
  initEosLogSession,
  beginActorTurn,
  recordPartial,
  recordFinal,
  recordEndOfUtterance,
  recordActorSmError,
  logRehearsalEnd,
  noteActorSmResumeDelay,
  getActorTurnSnapshot,
  flushTurnEnd,
  scoreHypothesisPair,
  notePeakLenRatioTrim,
} from './eosLog.js';
import {
  evaluateActorTurnCompletion,
  readEouTuningFromUrl,
  SM_EOU_SILENCE_TRIGGER_SEC,
} from './eouPolicy.js';
import {
  evaluateActorTurnCompletionV2,
  adaptiveMinLenRatioV2,
  computeLenRatioV2,
  refWordCount,
} from './eouPolicyV2.js';
import { isEosV2, resolveEosAlgoMode } from './eosConfig.js';
import { reachGoal } from './analytics.js';

initStageNav('rehearsal');

// ── Состояние ──────────────────────────────────────────────────────────────
let sequence   = [];   // [{ type:'partner'|'actor', segId?, lines?, line? }]
let currentIdx = 0;
let micStream      = null;  // единственный getUserMedia за весь сеанс
/** Одно подключение SpeechKit на всю репетицию (аудио в сокет только на репликах актёра) */
let persistentSession = null;

/** Пауза между цифрами отсчёта перед стартом репетиции (мс) */
const COUNTDOWN_STEP_MS = 1000;

/**
 * Пауза перед отправкой микрофона в SpeechKit после реплики партнёра.
 * Снижает попадание хвоста из колонок в распознавание. Запись MediaRecorder идёт сразу.
 * Наушники: часто хватает 150–250 ms; колонки/комната: 400–700 ms.
 * Подбор на устройстве: rehearsal.html?smResumeDelay=500
 */
const ACTOR_SM_RESUME_DELAY_MS = 150;
const ACTOR_SM_RESUME_DELAY_MAX_MS = 2000;

/** Неотслеживаемый «забыл вкладку»: лимит одной сессии с момента старта репетиции. */
const MAX_REHEARSAL_SESSION_MS = 30 * 60 * 1000;
const SS_RESUME_AFTER_MAX = 'rehearsalResumeAfterMaxDuration';
const SS_TIMEOUT_BANNER = 'rehearsalTimeoutBanner';

let maxDurationCheckTimer = null;
let mediaRecorder  = null;
let recordedChunks = [];
let finalSegments  = [];    // накопленные final-транскрипты текущей реплики
let turnDone       = false; // защита от двойного вызова finishActorTurn

/** Записанные реплики актёра: seqIdx → Blob (кэш; дублируется в IndexedDB) */
const actorRecordings = new Map();

/** Ссылки на skip-handlers для последующего removeEventListener */
let currentSkipHandler = null;
let currentSkipKeyHandler = null;

/** Настройки End-of-Utterance (тишина ~1 с); ?noEou=1 — выкл., ?eouSilence=0.9 */
const eouTuning = readEouTuningFromUrl();

// ── DOM ────────────────────────────────────────────────────────────────────
const actorBadgeEl   = document.getElementById('actorBadge');
const stepCounterEl  = document.getElementById('stepCounter');
const loadingSection = document.getElementById('loadingSection');
const loadingText    = document.getElementById('loadingText');
const scriptLiveEl   = document.getElementById('scriptLive');
const skipBtn        = document.getElementById('skipBtn');
const scriptViewportSection = document.getElementById('scriptViewportSection');
const scriptLaneEl = document.getElementById('scriptLane');
const rehearsalHeaderEl = document.getElementById('rehearsalHeader');
const startGate = document.getElementById('startGate');
const rehearsalActiveUi = document.getElementById('rehearsalActiveUi');
const startRehearsalBtn = document.getElementById('startRehearsalBtn');
const startGateErrorEl = document.getElementById('startGateError');
const skipHintEl = document.getElementById('skipHint');

/** Сохраняются в bootstrap, нужны в startRecordingSession (словарь). */
let rehearsalBlocks = [];
let rehearsalRole = '';
let lineProgressRaf = null;
let durationAudioContext = null;

function stopLineProgress() {
  if (lineProgressRaf !== null) {
    cancelAnimationFrame(lineProgressRaf);
    lineProgressRaf = null;
  }
}

function setCurrentLineProgress(value) {
  const v = Math.max(0, Math.min(1, value));
  const fills = scriptLaneEl?.querySelectorAll('.script-line__progress-fill') || [];
  fills.forEach((fill) => {
    const line = fill.closest('.script-line');
    const i = Number(line?.dataset.index ?? '-1');
    fill.style.width = i === currentIdx ? `${(v * 100).toFixed(2)}%` : '0%';
  });
}

async function getBlobDurationSeconds(blob) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!durationAudioContext) durationAudioContext = new Ctx();
    const buffer = await blob.arrayBuffer();
    const decoded = await durationAudioContext.decodeAudioData(buffer.slice(0));
    const duration = decoded?.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

function stepToViewModel(step) {
  if (step.type === 'actor') {
    return {
      role: step.line.role,
      type: 'actor',
      text: extractSpeakable(step.line.text),
    };
  }
  const text = step.lines
    .map((line) => `${line.role}: ${extractSpeakable(line.text)}`)
    .join(' ');
  return { role: 'Партнер', type: 'partner', text };
}

function renderScriptLane() {
  if (!scriptLaneEl) return;
  scriptLaneEl.innerHTML = sequence
    .map((step, i) => {
      const view = stepToViewModel(step);
      return `<p class="script-line ${view.type}" data-index="${i}">
        <span class="script-line__role">${escapeHtml(view.role)}</span>
        <span class="script-line__text">${escapeHtml(view.text)}</span>
        <span class="script-line__progress">
          <span class="script-line__progress-track">
            <span class="script-line__progress-fill"></span>
          </span>
        </span>
        ${view.type === 'actor' ? '<span class="script-line__actions"></span>' : ''}
      </p>`;
    })
    .join('');
}

function mountSkipButtonToActorLine(index) {
  if (!skipBtn || !scriptLaneEl) return;
  const host = scriptLaneEl.querySelector(`.script-line.actor[data-index="${index}"] .script-line__actions`);
  if (!host) {
    skipBtn.hidden = true;
    return;
  }
  host.appendChild(skipBtn);
}

function setSkipHintVisible(visible) {
  if (skipHintEl) skipHintEl.hidden = !visible;
}

function unbindSkipHandlers() {
  if (currentSkipHandler && skipBtn) {
    skipBtn.removeEventListener('click', currentSkipHandler);
  }
  if (currentSkipKeyHandler) {
    document.removeEventListener('keydown', currentSkipKeyHandler);
  }
  currentSkipHandler = null;
  currentSkipKeyHandler = null;
}

function bindSkipHandlers(seqIdx) {
  unbindSkipHandlers();
  if (!skipBtn) return;

  currentSkipHandler = () => {
    if (!turnDone) finishActorTurn(seqIdx, 'manual');
  };
  currentSkipKeyHandler = (event) => {
    if (turnDone || skipBtn.hidden) return;
    if (event.code !== 'Space' && event.key !== ' ') return;
    const tag = event.target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) return;
    event.preventDefault();
    finishActorTurn(seqIdx, 'manual');
  };

  skipBtn.addEventListener('click', currentSkipHandler);
  document.addEventListener('keydown', currentSkipKeyHandler);
}

function applyScriptLineClasses(activeIdx) {
  if (!scriptLaneEl) return;
  const lines = scriptLaneEl.querySelectorAll('.script-line');
  lines.forEach((line) => {
    const i = Number(line.dataset.index);
    const distance = Math.abs(i - activeIdx);
    line.classList.toggle('is-current', distance === 0);
    line.classList.remove('dist-1', 'dist-2', 'dist-3plus');
    if (distance === 1) line.classList.add('dist-1');
    else if (distance === 2) line.classList.add('dist-2');
    else if (distance >= 3) line.classList.add('dist-3plus');
  });
}

function scrollScriptToIndex(index, { instant = false } = {}) {
  const target = scriptLaneEl?.querySelector(`[data-index="${index}"]`);
  if (!target || !scriptLaneEl) return;
  const y = target.offsetTop;
  if (instant) {
    const prevTransition = scriptLaneEl.style.transition;
    scriptLaneEl.style.transition = 'none';
    scriptLaneEl.style.transform = `translateY(${-y}px)`;
    requestAnimationFrame(() => {
      scriptLaneEl.style.transition = prevTransition || '';
    });
  } else {
    scriptLaneEl.style.transform = `translateY(${-y}px)`;
  }
}

function startLineProgressForCurrent() {
  stopLineProgress();
  setCurrentLineProgress(0);
}

function calcActorLineProgress({
  score,
  lenRatio,
  tail,
  scoreThreshold,
  minLenRatio,
}) {
  const scorePart = Math.max(0, Math.min(1, score / Math.max(scoreThreshold, 0.0001)));
  const lenPart = Math.max(0, Math.min(1, lenRatio / Math.max(minLenRatio, 0.0001)));
  const tailPart = Math.max(0, Math.min(1, tail / Math.max(MIN_TAIL_SCORE, 0.0001)));
  // Композитный прогресс: смысловое совпадение важнее, длина и хвост стабилизируют оценку.
  return 0.55 * scorePart + 0.25 * lenPart + 0.2 * tailPart;
}

/** v2: прогресс = доля длины относительно адаптивного порога. */
function calcActorLineProgressV2(lenRatio, minLenRatio) {
  return Math.max(0, Math.min(1, lenRatio / Math.max(minLenRatio, 0.0001)));
}

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true;  }

function clearMaxDurationWatch() {
  if (maxDurationCheckTimer != null) {
    clearInterval(maxDurationCheckTimer);
    maxDurationCheckTimer = null;
  }
}

function startMaxDurationWatch() {
  clearMaxDurationWatch();
  const deadline = Date.now() + MAX_REHEARSAL_SESSION_MS;
  maxDurationCheckTimer = setInterval(() => {
    if (Date.now() >= deadline) {
      haltRehearsalDueToMaxDuration();
    }
  }, 15000);
}

function haltRehearsalDueToMaxDuration() {
  clearMaxDurationWatch();
  try {
    unbindSkipHandlers();
    setSkipHintVisible(false);
  } catch {
    /* ignore */
  }
  saveRehearsalCursor(currentIdx);
  sessionStorage.setItem(SS_RESUME_AFTER_MAX, '1');
  sessionStorage.setItem(
    SS_TIMEOUT_BANNER,
    'Достигнут лимит 30 минут непрерывной сессии распознавания речи. Подключение отключено. Нажмите «Начать запись пробы» ещё раз, чтобы продолжить с сохранённого шага.'
  );
  try {
    persistentSession?.destroy();
  } catch {
    /* ignore */
  }
  persistentSession = null;
  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  micStream = null;
  window.location.reload();
}

function onRehearsalVisibilityChange() {
  if (!persistentSession) return;
  if (document.hidden) {
    persistentSession.pauseSending();
    return;
  }
  const shouldResume =
    sequence[currentIdx]?.type === 'actor' &&
    mediaRecorder &&
    mediaRecorder.state === 'recording' &&
    !turnDone;
  if (shouldResume) {
    persistentSession.resumeSending();
  }
}

function showLoading(msg) {
  hide(rehearsalHeaderEl);
  hide(scriptViewportSection);
  if (skipBtn) skipBtn.hidden = true;
  loadingSection.classList.remove('loading-section--countdown');
  loadingText.classList.remove('countdown');
  show(loadingSection);
  loadingText.innerHTML = msg;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Задержка resumeSending только если перед этим играл партнёр (не для первой реплики без партнёра). */
function actorSmResumeDelayMs(seqIdx) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('smResumeDelay');
  if (raw != null && raw !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= ACTOR_SM_RESUME_DELAY_MAX_MS) {
      return n;
    }
  }
  const prev = sequence[seqIdx - 1];
  if (prev?.type !== 'partner') return 0;
  return ACTOR_SM_RESUME_DELAY_MS;
}

/** После готовности микрофона и SpeechKit — 3, 2, 1, затем сцена. */
async function showStartCountdown() {
  show(loadingSection);
  loadingSection.classList.add('loading-section--countdown');
  loadingText.classList.add('countdown');
  for (const n of [3, 2, 1]) {
    loadingText.textContent = String(n);
    await delay(COUNTDOWN_STEP_MS);
  }
  loadingText.classList.remove('countdown');
  loadingSection.classList.remove('loading-section--countdown');
  loadingText.textContent = '';
}

function updateStepCounter() {
  const total = sequence.filter(s => s.type === 'actor').length;
  const done  = actorRecordings.size;
  stepCounterEl.textContent = `${done} / ${total} реплик`;
}

async function blobForActorStep(seqIdx) {
  if (actorRecordings.has(seqIdx)) return actorRecordings.get(seqIdx);
  return getActorRecording(seqIdx);
}

// ── Навигация по шагам ─────────────────────────────────────────────────────
async function advanceTo(idx) {
  saveRehearsalCursor(idx);
  if (idx >= sequence.length) {
    finishRehearsalAndGoToResult();
    return;
  }
  currentIdx = idx;
  updateStepCounter();
  show(scriptViewportSection);
  applyScriptLineClasses(currentIdx);
  scrollScriptToIndex(currentIdx);
  startLineProgressForCurrent();

  const step = sequence[idx];
  if (step.type === 'partner') {
    await runPartnerStep(step);
  } else {
    await runActorStep(step, idx);
  }
}

// ── Партнёрский шаг ────────────────────────────────────────────────────────
async function runPartnerStep(step) {
  hide(loadingSection);
  unbindSkipHandlers();
  setSkipHintVisible(false);
  if (skipBtn) skipBtn.hidden = true;
  setCurrentLineProgress(0);
  if (scriptLiveEl) scriptLiveEl.textContent = `Партнер говорит: ${stepToViewModel(step).text.slice(0, 180)}`;

  const blob = await getPartnerAudio(step.segId);
  if (!blob) {
    // Аудио не записано — пропускаем через небольшую паузу
    setTimeout(() => advanceTo(currentIdx + 1), 600);
    return;
  }

  const decodedDurationSec = await getBlobDurationSeconds(blob);
  const url   = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const next  = () => {
    stopLineProgress();
    setCurrentLineProgress(1);
    URL.revokeObjectURL(url);
    advanceTo(currentIdx + 1);
  };
  const syncProgress = () => {
    const duration = Number.isFinite(decodedDurationSec) && decodedDurationSec > 0
      ? decodedDurationSec
      : audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      lineProgressRaf = requestAnimationFrame(syncProgress);
      return;
    }
    setCurrentLineProgress(audio.currentTime / duration);
    if (!audio.paused && !audio.ended) {
      lineProgressRaf = requestAnimationFrame(syncProgress);
    } else {
      lineProgressRaf = null;
    }
  };
  audio.onended = next;
  audio.onerror = next;
  audio.play().then(() => {
    stopLineProgress();
    lineProgressRaf = requestAnimationFrame(syncProgress);
  }).catch(next);
}

function emitActorTurnLog(finishReason) {
  const snap = getActorTurnSnapshot();
  if (!snap) return;

  const hypRaw = finalSegments.join(' ').trim();
  const hypWithPartialRaw = snap.lastPartialText
    ? `${hypRaw} ${snap.lastPartialText}`.trim()
    : hypRaw;

  const finalPair = scoreHypothesisPair(snap.speakableText, hypRaw, snap.thresholds);
  const partialPair = scoreHypothesisPair(snap.speakableText, hypWithPartialRaw, snap.thresholds);

  flushTurnEnd({
    finishReason,
    seqIdx: snap.seqIdx,
    actorTurnIndex: snap.actorTurnIndex,
    speakableText: snap.speakableText,
    thresholds: snap.thresholds,
    hypothesisRaw: finalPair.hypothesisRaw,
    hypothesisTrimmed: finalPair.hypothesisTrimmed,
    trimWordsSkipped: finalPair.trimWordsSkipped,
    trimApplied: finalPair.trimApplied,
    metricsRaw: finalPair.metricsRaw,
    metricsTrimmed: finalPair.metricsTrimmed,
    failedGatesRaw: finalPair.failedGatesRaw,
    failedGatesTrimmed: finalPair.failedGatesTrimmed,
    gateMarginsRaw: finalPair.gateMarginsRaw,
    gateMarginsTrimmed: finalPair.gateMarginsTrimmed,
    passedRaw: finalPair.passedRaw,
    passedTrimmed: finalPair.passedTrimmed,
    hypothesisWithPartialRaw: partialPair.hypothesisRaw,
    hypothesisWithPartialTrimmed: partialPair.hypothesisTrimmed,
    metricsPartialRaw: partialPair.metricsRaw,
    metricsPartialTrimmed: partialPair.metricsTrimmed,
    partialWouldPassRaw: partialPair.passedRaw,
    partialWouldPassTrimmed: partialPair.passedTrimmed,
    failedGatesPartialTrimmed: partialPair.failedGatesTrimmed,
    partialCount: snap.partialCount,
    finalCount: snap.finalCount,
    timeline: snap.timeline,
    bestNearMissTrim: snap.bestNearMissTrim,
    bestNearMissRaw: snap.bestNearMissRaw,
    turnDurationMs: snap.turnDurationMs,
    rehearsalDurationMs: snap.rehearsalDurationMs,
    tokenRefreshCount: snap.tokenRefreshCount,
    smError: snap.smError,
    smConnected: Boolean(persistentSession),
    smResumeDelayMs: snap.smResumeDelayMs,
    recordingBytes: recordedChunks.reduce((n, c) => n + (c.size || 0), 0),
    eouCount: snap.eouCount,
    eouPeriods: snap.eouPeriods,
    lastEouEvaluation: snap.lastEouEvaluation,
    smEouSilenceSec: eouTuning.disableEou ? 0 : eouTuning.silenceSec,
    eosAlgoMode: resolveEosAlgoMode(),
    peakLenRatioTrim: snap.peakLenRatioTrim ?? 0,
  });
}

/**
 * v1: strict на final + relaxed на EoU. v2: только EoU + доля длины (eouPolicyV2.js).
 * @param {'final'|'eou'} source
 */
function tryCompleteActorTurn(seqIdx, source, speakableText, thresholds) {
  if (turnDone) return;
  const snap = getActorTurnSnapshot();
  if (!snap) return;

  if (isEosV2()) {
    if (source !== 'eou') return;

    const hypRaw = snap.lastPartialText
      ? `${finalSegments.join(' ')} ${snap.lastPartialText}`.trim()
      : finalSegments.join(' ').trim();

    const result = evaluateActorTurnCompletionV2({
      speakableText,
      hypothesisRaw: hypRaw,
      peakLenRatioTrim: snap.peakLenRatioTrim ?? 0,
      source: 'eou',
      eouIndex: snap.eouCount + 1,
    });

    recordEndOfUtterance({
      ...result.detail,
      silenceTriggerSec: eouTuning.disableEou ? 0 : eouTuning.silenceSec,
    });

    if (result.action === 'finish') {
      setCurrentLineProgress(1);
      finishActorTurn(seqIdx, result.finishReason);
    }
    return;
  }

  const hypRaw = finalSegments.join(' ').trim();
  const result = evaluateActorTurnCompletion({
    speakableText,
    hypothesisRaw: hypRaw,
    thresholds,
    bestNearMissTrim: snap.bestNearMissTrim,
    source,
    eouIndex: snap.eouCount + (source === 'eou' ? 1 : 0),
  });

  if (source === 'eou') {
    recordEndOfUtterance({
      ...result.detail,
      silenceTriggerSec: eouTuning.disableEou ? 0 : eouTuning.silenceSec,
    });
  }

  if (result.action === 'finish') {
    setCurrentLineProgress(1);
    finishActorTurn(seqIdx, result.finishReason);
  }
}

// ── Реплика актёра ─────────────────────────────────────────────────────────
async function runActorStep(step, seqIdx) {
  hide(loadingSection);
  mountSkipButtonToActorLine(seqIdx);
  if (skipBtn) skipBtn.hidden = false;

  const speakableText = extractSpeakable(step.line.text);
  if (scriptLiveEl) scriptLiveEl.textContent = '';
  setCurrentLineProgress(0);

  finalSegments = [];
  recordedChunks = [];
  turnDone = false;

  const refWords = refWordCount(speakableText);
  const thresholds = isEosV2()
    ? { minLenRatio: adaptiveMinLenRatioV2(refWords), scoreThreshold: 0, eosMode: 'v2' }
    : (() => {
        const { minLenRatio, scoreThreshold } = adaptiveThresholds(speakableText);
        return { minLenRatio, scoreThreshold, eosMode: 'v1' };
      })();
  beginActorTurn({ seqIdx, speakableText, thresholds });

  bindSkipHandlers(seqIdx);
  setSkipHintVisible(true);

  // MediaRecorder — запись реплики актёра
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
  try {
    mediaRecorder = new MediaRecorder(micStream, { mimeType });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start(100);
  } catch (e) {
    console.error('MediaRecorder failed:', e);
    mediaRecorder = null;
  }

  persistentSession.setHandlers({
    onPartial(text) {
      const hypRaw = `${finalSegments.join(' ')} ${text}`.trim();
      if (!hypRaw) return;

      if (isEosV2()) {
        const lenPack = computeLenRatioV2(speakableText, hypRaw);
        notePeakLenRatioTrim(lenPack.lenRatioTrim);
        if (scriptLiveEl) {
          scriptLiveEl.textContent = `Live: ${lenPack.hypothesisTrimmed}`;
        }
        recordPartial(text, hypRaw, thresholds);
        const snap = getActorTurnSnapshot();
        const effectiveLen = Math.max(snap?.peakLenRatioTrim ?? 0, lenPack.lenRatioTrim);
        setCurrentLineProgress(
          calcActorLineProgressV2(effectiveLen, thresholds.minLenRatio)
        );
        return;
      }

      const pair = scoreHypothesisPair(speakableText, hypRaw, thresholds);
      if (scriptLiveEl) scriptLiveEl.textContent = `Live transcript: ${pair.hypothesisTrimmed}`;
      recordPartial(text, hypRaw, thresholds);
      const m = pair.metricsTrimmed;
      setCurrentLineProgress(
        calcActorLineProgress({
          score: m.score,
          lenRatio: m.lenRatio,
          tail: m.tail,
          scoreThreshold: thresholds.scoreThreshold,
          minLenRatio: thresholds.minLenRatio,
        })
      );
    },
    onFinal(text) {
      if (turnDone) return;
      finalSegments.push(text.trim());
      const hypRaw = finalSegments.join(' ');

      if (isEosV2()) {
        const lenPack = computeLenRatioV2(speakableText, hypRaw);
        notePeakLenRatioTrim(lenPack.lenRatioTrim);
        if (scriptLiveEl) scriptLiveEl.textContent = `Live: ${lenPack.hypothesisTrimmed}`;
        recordFinal(text.trim(), hypRaw, thresholds);
        const snap = getActorTurnSnapshot();
        const effectiveLen = Math.max(snap?.peakLenRatioTrim ?? 0, lenPack.lenRatioTrim);
        setCurrentLineProgress(
          calcActorLineProgressV2(effectiveLen, thresholds.minLenRatio)
        );
        return;
      }

      const pair = scoreHypothesisPair(speakableText, hypRaw, thresholds);
      if (scriptLiveEl) scriptLiveEl.textContent = `Live transcript: ${pair.hypothesisTrimmed}`;

      recordFinal(text.trim(), hypRaw, thresholds);
      const m = pair.metricsTrimmed;
      setCurrentLineProgress(
        calcActorLineProgress({
          score: m.score,
          lenRatio: m.lenRatio,
          tail: m.tail,
          scoreThreshold: thresholds.scoreThreshold,
          minLenRatio: thresholds.minLenRatio,
        })
      );
      tryCompleteActorTurn(seqIdx, 'final', speakableText, thresholds);
    },
    onEndOfUtterance() {
      if (turnDone || eouTuning.disableEou) return;
      tryCompleteActorTurn(seqIdx, 'eou', speakableText, thresholds);
    },
    onError(e) {
      console.error('Persistent session error:', e);
      recordActorSmError(String(e));
      if (scriptLiveEl) scriptLiveEl.textContent = '⚠ Ошибка распознавания. Нажмите «Дальше» или пробел.';
    },
  });

  const smResumeDelayMs = actorSmResumeDelayMs(seqIdx);
  noteActorSmResumeDelay(smResumeDelayMs);
  if (smResumeDelayMs > 0) {
    console.debug(`[rehearsal] SM resume delayed ${smResumeDelayMs}ms after partner`);
    await delay(smResumeDelayMs);
    if (turnDone) return;
  }
  persistentSession.resumeSending();
}

// ── Завершение реплики актёра ──────────────────────────────────────────────
function finishActorTurn(seqIdx, finishReason = 'manual') {
  if (turnDone) return;
  emitActorTurnLog(finishReason);
  turnDone = true;

  unbindSkipHandlers();
  setSkipHintVisible(false);

  if (scriptLiveEl) scriptLiveEl.textContent = '✓ Готово';
  setCurrentLineProgress(1);

  persistentSession?.pauseSending();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType ?? 'audio/webm' });
      actorRecordings.set(seqIdx, blob);
      mediaRecorder = null;
      try {
        await storeActorRecording(seqIdx, blob);
      } catch (e) {
        console.error('storeActorRecording', e);
      }
      advanceTo(currentIdx + 1);
    };
    mediaRecorder.stop();
  } else {
    mediaRecorder = null;
    const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType ?? 'audio/webm' });
    if (blob.size > 0) {
      actorRecordings.set(seqIdx, blob);
      storeActorRecording(seqIdx, blob).catch((e) => console.error('storeActorRecording', e));
    }
    advanceTo(currentIdx + 1);
  }
}

/** Снять микрофон и распознавание, зафиксировать завершение пробы, открыть страницу итога. */
function finishRehearsalAndGoToResult() {
  reachGoal('rehearsal_completed');
  logRehearsalEnd({ completed: true, cursor: sequence.length });
  clearMaxDurationWatch();
  stopLineProgress();
  persistentSession?.destroy();
  persistentSession = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;

  saveRehearsalCursor(sequence.length);
  window.location.href = './result.html';
}

async function hydrateActorRecordingsFromDb() {
  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i].type !== 'actor') continue;
    const blob = await getActorRecording(i);
    if (blob && blob.size > 0) actorRecordings.set(i, blob);
  }
}

// ── Инициализация ──────────────────────────────────────────────────────────
function showStartGateError(html) {
  if (startGateErrorEl) {
    startGateErrorEl.hidden = false;
    startGateErrorEl.innerHTML = html;
  }
  if (startRehearsalBtn) startRehearsalBtn.hidden = true;
}

/** Микрофон, SpeechKit, первый шаг — после кнопки «Начать запись пробы». */
async function startRecordingSession() {
  const role = rehearsalRole;

  hide(startGate);
  show(rehearsalActiveUi);
  showLoading('Инициализация…');
  reachGoal('rehearsal_started');

  showLoading('Запрашиваем доступ к микрофону…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showLoading('Нет доступа к микрофону. Разреши доступ в браузере и обнови страницу.');
    return;
  }

  showLoading('Подключение к распознаванию (SpeechKit)…');
  persistentSession = new PersistentYandexSttSession({
    stream: micStream,
    onDebug: (msg) => console.debug('[stt]', msg),
  });
  persistentSession.setHandlers({
    onPartial: () => {},
    onFinal: () => {},
    onError: (e) => console.error('SpeechKit (idle):', e),
  });
  try {
    await persistentSession.connect();
  } catch (e) {
    showLoading(
      `Не удалось подключиться к распознаванию: ${e.message}. Проверь сеть и YANDEX_API_KEY в .env, затем обнови страницу.`
    );
    return;
  }
  persistentSession.pauseSending();

  const actorLineCount = sequence.filter((s) => s.type === 'actor').length;
  const eosAlgoMode = resolveEosAlgoMode();
  console.info('[rehearsal] EOS', {
    algo: eosAlgoMode,
    eouEnabled: !eouTuning.disableEou,
    silenceSec: eouTuning.disableEou ? 0 : eouTuning.silenceSec,
    defaultSec: SM_EOU_SILENCE_TRIGGER_SEC,
  });
  initEosLogSession({
    role,
    actorLineCount,
    vocabCount: 0,
    sequenceLength: sequence.length,
    smEouEnabled: !eouTuning.disableEou,
    smEouSilenceSec: eouTuning.disableEou ? 0 : eouTuning.silenceSec,
    eosAlgoMode,
  });

  await showStartCountdown();

  hide(loadingSection);
  show(rehearsalHeaderEl);
  show(scriptViewportSection);
  if (skipBtn) skipBtn.hidden = true;

  let startIdx = loadRehearsalCursor();
  if (startIdx >= sequence.length) {
    startIdx = 0;
    saveRehearsalCursor(0);
  }

  renderScriptLane();
  applyScriptLineClasses(startIdx);
  scrollScriptToIndex(startIdx, { instant: true });
  startMaxDurationWatch();
  advanceTo(startIdx);
}

async function bootstrap() {
  try {
    await clearActorClips();
  } catch (e) {
    console.error(e);
  }

  const resumeAfterMax = sessionStorage.getItem(SS_RESUME_AFTER_MAX);
  const timeoutBanner = sessionStorage.getItem(SS_TIMEOUT_BANNER);
  if (timeoutBanner) sessionStorage.removeItem(SS_TIMEOUT_BANNER);
  if (resumeAfterMax) sessionStorage.removeItem(SS_RESUME_AFTER_MAX);

  if (!resumeAfterMax) {
    clearRehearsalCursor();
    saveRehearsalCursor(0);
  }

  const blocks = loadBlocks();
  const role = loadRole();

  if (!role || !blocks.length) {
    showStartGateError('Данные не найдены. <a href="./index.html" style="color:#9fc0ff">Начни заново</a>');
    return;
  }

  sequence = buildSequence(blocks, role);
  if (!sequence.length) {
    showStartGateError('В сцене нет реплик.');
    return;
  }

  rehearsalBlocks = blocks;
  rehearsalRole = role;

  await hydrateActorRecordingsFromDb();
  actorBadgeEl.textContent = `Вы: ${role}`;
  updateStepCounter();

  if (timeoutBanner && startGateErrorEl) {
    startGateErrorEl.hidden = false;
    startGateErrorEl.textContent = timeoutBanner;
  }

  document.addEventListener('visibilitychange', onRehearsalVisibilityChange);

  startRehearsalBtn?.addEventListener(
    'click',
    () => {
      startRehearsalBtn.disabled = true;
      startRecordingSession();
    },
    { once: true }
  );
}

bootstrap();

