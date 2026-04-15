import { getPartnerAudio, getActorRecording, storeActorRecording, clearActorClips } from './audioDb.js';
import { PersistentSpeechmaticsSession } from './recognizer.js';
import { calcScore, adaptiveThresholds, MIN_TAIL_SCORE } from './scorer.js';
import { initStageNav } from './stageNav.js';
import { loadBlocks, loadRole, loadRehearsalCursor, saveRehearsalCursor, clearRehearsalCursor } from './flowState.js';
import { extractSpeakable, escapeHtml, buildSequence } from './rehearsalSequence.js';

initStageNav('rehearsal');

// ── Состояние ──────────────────────────────────────────────────────────────
let sequence   = [];   // [{ type:'partner'|'actor', segId?, lines?, line? }]
let currentIdx = 0;
let smToken    = '';
let smTokenExpiresAtMs = 0;
let sessionAdditionalVocab = [];

let micStream      = null;  // единственный getUserMedia за весь сеанс
/** Одно подключение Speechmatics на всю репетицию (аудио в сокет только на репликах актёра) */
let persistentSession = null;

/** За сколько до истечения JWT переподключаться (мс) */
const TOKEN_REFRESH_BUFFER_MS = 120_000;

/** Пауза между цифрами отсчёта перед стартом репетиции (мс) */
const COUNTDOWN_STEP_MS = 1000;

/** Неотслеживаемый «забыл вкладку» + экономия Speechmatics: лимит одной сессии с момента старта репетиции. */
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

/** Ссылка на текущий skip-handler для последующего removeEventListener */
let currentSkipHandler = null;

// ── DOM ────────────────────────────────────────────────────────────────────
const rehearsalView  = document.getElementById('rehearsalView');
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
      </p>`;
    })
    .join('');
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
    if (currentSkipHandler) {
      skipBtn.removeEventListener('click', currentSkipHandler);
      currentSkipHandler = null;
    }
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

/** После готовности микрофона и Speechmatics — 3, 2, 1, затем сцена. */
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

async function ensureSmToken(opts = {}) {
  const now = Date.now();
  if (!opts.force && smToken && smTokenExpiresAtMs - now > 60_000) return true;
  const res = await fetch('/api/sm-token');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  smToken = (data.token || '').trim();
  smTokenExpiresAtMs = Number.isFinite(data.expires_at_ms) ? data.expires_at_ms : 0;
  return Boolean(smToken);
}

async function maybeReconnectPersistentIfTokenStale() {
  const now = Date.now();
  if (!persistentSession) return;
  if (smTokenExpiresAtMs - now > TOKEN_REFRESH_BUFFER_MS) return;
  await ensureSmToken({ force: true });
  if (!smToken) throw new Error('empty token');
  persistentSession.setJwt(smToken);
  await persistentSession.reconnect(smToken);
}

function collectActorSpeakableLines(blocks, role) {
  return blocks
    .filter((block) => block.role === role)
    .map((block) => extractSpeakable(block.text))
    .filter(Boolean);
}

function extractJsonBlock(text) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) return fencedMatch[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text.trim();
}

function sanitizeGeneratedVocab(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!content || seen.has(content.toLowerCase())) return null;
      seen.add(content.toLowerCase());
      const result = { content };
      if (Array.isArray(item.sounds_like)) {
        const soundsLike = item.sounds_like
          .filter((value) => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 5);
        if (soundsLike.length) {
          result.sounds_like = soundsLike;
        }
      }
      return result;
    })
    .filter(Boolean)
    .slice(0, 120);
}

async function generateSessionVocab(actorLines) {
  if (!actorLines.length) return [];

  const prompt = [
    'Ты готовишь custom dictionary для Speechmatics Realtime.',
    'На входе очищенные реплики актера на русском языке.',
    'Нужно вернуть только JSON-массив объектов additional_vocab.',
    'Формат каждого элемента: {"content":"..."} или {"content":"...","sounds_like":["..."]}.',
    'Включай только то, что реально может плохо распознаваться: имена, фамилии, редкие слова, необычные обращения, характерные междометия.',
    'Не включай обычные частотные слова.',
    'Не добавляй объяснений, markdown и комментариев.',
    'Держи словарь компактным: максимум 80 элементов.',
    'Предпочитай content длиной до 4 слов.',
    '',
    'Реплики актера:',
    ...actorLines.map((line, index) => `${index + 1}. ${line}`),
  ].join('\n');

  const response = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = typeof data.content === 'string' ? data.content : '';
  const jsonBlock = extractJsonBlock(content);
  const parsed = JSON.parse(jsonBlock);
  return sanitizeGeneratedVocab(parsed);
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

// ── Реплика актёра ─────────────────────────────────────────────────────────
async function runActorStep(step, seqIdx) {
  hide(loadingSection);
  if (skipBtn) skipBtn.hidden = false;

  const speakableText = extractSpeakable(step.line.text);
  if (scriptLiveEl) scriptLiveEl.textContent = '';
  setCurrentLineProgress(0);

  finalSegments = [];
  recordedChunks = [];
  turnDone = false;

  const { minLenRatio, scoreThreshold } = adaptiveThresholds(speakableText);

  try {
    const ok = await ensureSmToken();
    if (!ok) {
      if (scriptLiveEl) scriptLiveEl.textContent = '⚠ Не удалось получить временный токен. Нажмите «Готово» вручную.';
      return;
    }
    await maybeReconnectPersistentIfTokenStale();
  } catch (e) {
    console.error('Failed to refresh Speechmatics token:', e);
    if (scriptLiveEl) scriptLiveEl.textContent = '⚠ Ошибка обновления токена. Нажмите «Готово» вручную.';
    return;
  }

  // Skip-кнопка — «Готово» вручную
  if (currentSkipHandler) skipBtn.removeEventListener('click', currentSkipHandler);
  currentSkipHandler = () => { if (!turnDone) finishActorTurn(seqIdx); };
  skipBtn.addEventListener('click', currentSkipHandler);

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
      if (scriptLiveEl) scriptLiveEl.textContent = `Live transcript: ${text}`;
      const hyp = `${finalSegments.join(' ')} ${text}`.trim();
      if (!hyp) return;
      const { score, lenRatio, tail } = calcScore(speakableText, hyp);
      setCurrentLineProgress(
        calcActorLineProgress({
          score,
          lenRatio,
          tail,
          scoreThreshold,
          minLenRatio,
        })
      );
    },
    onFinal(text) {
      if (turnDone) return;
      finalSegments.push(text.trim());
      const hyp = finalSegments.join(' ');
      if (scriptLiveEl) scriptLiveEl.textContent = `Live transcript: ${hyp}`;

      const { score, lenRatio, tail } = calcScore(speakableText, hyp);
      setCurrentLineProgress(
        calcActorLineProgress({
          score,
          lenRatio,
          tail,
          scoreThreshold,
          minLenRatio,
        })
      );
      if (lenRatio >= minLenRatio && score >= scoreThreshold && tail >= MIN_TAIL_SCORE) {
        setCurrentLineProgress(1);
        finishActorTurn(seqIdx);
      }
    },
    onError(e) {
      console.error('Persistent session error:', e);
      if (scriptLiveEl) scriptLiveEl.textContent = '⚠ Ошибка Speechmatics. Нажмите «Готово» вручную.';
    },
  });
  persistentSession.resumeSending();
}

// ── Завершение реплики актёра ──────────────────────────────────────────────
function finishActorTurn(seqIdx) {
  if (turnDone) return;
  turnDone = true;

  if (currentSkipHandler) {
    skipBtn.removeEventListener('click', currentSkipHandler);
    currentSkipHandler = null;
  }

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

/** Токен, микрофон, Speechmatics, первый шаг — после кнопки «Начать запись пробы». */
async function startRecordingSession() {
  const blocks = rehearsalBlocks;
  const role = rehearsalRole;

  hide(startGate);
  show(rehearsalActiveUi);
  showLoading('Инициализация…');

  try {
    const ok = await ensureSmToken();
    if (!ok) throw new Error('empty token');
  } catch (e) {
    showLoading(`Ошибка получения токена Speechmatics: ${e.message}`);
    return;
  }

  showLoading('Собираем словарь сложных слов для распознавания…');
  try {
    sessionAdditionalVocab = await generateSessionVocab(collectActorSpeakableLines(blocks, role));
  } catch (e) {
    console.warn('Failed to generate session additional_vocab:', e);
    sessionAdditionalVocab = [];
  }

  showLoading('Запрашиваем доступ к микрофону…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showLoading('Нет доступа к микрофону. Разреши доступ в браузере и обнови страницу.');
    return;
  }

  showLoading('Подключение к Speechmatics (одна сессия на всю репетицию)…');
  persistentSession = new PersistentSpeechmaticsSession({
    jwtToken: smToken,
    stream: micStream,
    language: 'ru',
    additionalVocab: sessionAdditionalVocab,
    onDebug: (msg) => console.debug('[sm]', msg),
  });
  persistentSession.setHandlers({
    onPartial: () => {},
    onFinal: () => {},
    onError: (e) => console.error('Speechmatics (idle):', e),
  });
  try {
    await persistentSession.connect();
  } catch (e) {
    console.warn('Persistent connect failed, retry with fresh token', e);
    try {
      await ensureSmToken({ force: true });
      persistentSession.setJwt(smToken);
      await persistentSession.connect();
    } catch (e2) {
      showLoading(
        `Не удалось подключиться к Speechmatics: ${e2.message}. Проверь сеть и ключ в .env, затем обнови страницу.`
      );
      return;
    }
  }
  persistentSession.pauseSending();

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

