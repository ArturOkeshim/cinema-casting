import { getPartnerAudio, getActorRecording, storeActorRecording, clearActorClips } from './audioDb.js';
import { PersistentSpeechmaticsSession } from './recognizer.js';
import { calcScore, adaptiveThresholds, MIN_TAIL_SCORE } from './scorer.js';
import { initStageNav } from './stageNav.js';
import { loadBlocks, loadRole, loadRehearsalCursor, saveRehearsalCursor, clearRehearsalCursor } from './flowState.js';
import { extractSpeakable, escapeHtml, buildSequence } from './rehearsalSequence.js';

initStageNav('rehearsal', { prependTo: document.body });

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
const partnerSection = document.getElementById('partnerSection');
const actorSection   = document.getElementById('actorSection');
const partnerLinesEl = document.getElementById('partnerLines');
const actorLineEl    = document.getElementById('actorLine');
const liveTransEl    = document.getElementById('liveTranscript');
const recStatusEl    = document.getElementById('recStatus');
const skipBtn        = document.getElementById('skipBtn');
const sceneSummaryMainEl = document.getElementById('sceneSummaryMain');
const sceneSummaryNextEl = document.getElementById('sceneSummaryNext');
const sceneTimelineEl = document.getElementById('sceneTimeline');
const sceneOverviewSection = document.getElementById('sceneOverviewSection');
const startGate = document.getElementById('startGate');
const rehearsalActiveUi = document.getElementById('rehearsalActiveUi');
const startRehearsalBtn = document.getElementById('startRehearsalBtn');
const startGateErrorEl = document.getElementById('startGateError');

/** Сохраняются в bootstrap, нужны в startRecordingSession (словарь). */
let rehearsalBlocks = [];
let rehearsalRole = '';

// ── Утилиты ────────────────────────────────────────────────────────────────
function renderAnnotations(text) {
  return escapeHtml(text)
    .replace(/\[\[(.*?)\]\]/g, '<span class="annotation-inline">[$1]</span>');
}

function summarizeStep(step) {
  if (!step) return [];
  if (step.type === 'partner') {
    return step.lines.map((line) => ({
      role: line.role,
      text: extractSpeakable(line.text).slice(0, 140),
    }));
  }
  return [{
    role: 'Вы',
    text: extractSpeakable(step.line.text).slice(0, 160),
  }];
}

function getUpcomingActorInfo(fromIdx) {
  for (let i = fromIdx; i < sequence.length; i++) {
    const step = sequence[i];
    if (step?.type === 'actor') {
      return {
        idx: i,
        distance: i - currentIdx,
        text: extractSpeakable(step.line.text),
      };
    }
  }
  return null;
}

function renderSceneOverview() {
  if (!sequence.length) {
    sceneSummaryMainEl.textContent = 'Сцена не загружена';
    sceneSummaryNextEl.textContent = '';
    sceneTimelineEl.innerHTML = '';
    return;
  }

  const currentStep = sequence[currentIdx];
  const currentLabel = currentStep?.type === 'actor' ? 'Сейчас ваша реплика' : 'Сейчас говорит партнер';
  sceneSummaryMainEl.textContent = currentLabel;

  const nextActor = currentStep?.type === 'actor'
    ? getUpcomingActorInfo(currentIdx + 1)
    : getUpcomingActorInfo(currentIdx);

  if (!nextActor) {
    sceneSummaryNextEl.textContent = currentStep?.type === 'actor'
      ? 'После этой реплики сцена завершится.'
      : 'После текущего фрагмента партнеров ваших реплик больше нет.';
  } else if (nextActor.distance <= 0) {
    sceneSummaryNextEl.textContent = `Ваш текст: ${nextActor.text}`;
  } else if (nextActor.distance === 1) {
    sceneSummaryNextEl.textContent = `Скоро вам: ${nextActor.text}`;
  } else {
    sceneSummaryNextEl.textContent = `До вашей следующей реплики: ${nextActor.distance} шага. Скоро вам: ${nextActor.text}`;
  }

  const start = Math.max(0, currentIdx - 1);
  const end = Math.min(sequence.length, currentIdx + 4);
  sceneTimelineEl.innerHTML = sequence
    .slice(start, end)
    .map((step, localIdx) => {
      const idx = start + localIdx;
      let stateLabel = 'Дальше';
      if (idx < currentIdx) stateLabel = 'Уже прошло';
      if (idx === currentIdx) stateLabel = 'Сейчас';
      const typeLabel = step.type === 'actor' ? 'Вы' : 'Партнер';
      const summaryLines = summarizeStep(step);
      const extraMeta = step.type === 'partner'
        ? `${step.lines.length} ${step.lines.length === 1 ? 'реплика' : 'реплики'}`
        : 'ваша реплика';
      const classes = [
        'timeline-item',
        step.type === 'actor' ? 'timeline-item--actor' : 'timeline-item--partner',
        idx === currentIdx ? 'timeline-item--current' : '',
        idx < currentIdx ? 'timeline-item--done' : '',
      ].filter(Boolean).join(' ');
      return `
        <div class="${classes}">
          <div class="timeline-badge">${typeLabel}</div>
          <div class="timeline-text">
            <span class="timeline-meta">${stateLabel} · ${extraMeta}</span>
            <div class="timeline-lines">
              ${summaryLines.map((line) => `
                <div class="timeline-line">
                  <span class="timeline-role">${escapeHtml(line.role || '')}</span>
                  <span class="timeline-line-text">${escapeHtml(line.text || '...')}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    })
    .join('');
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
    !actorSection.hidden &&
    mediaRecorder &&
    mediaRecorder.state === 'recording' &&
    !turnDone;
  if (shouldResume) {
    persistentSession.resumeSending();
  }
}

function showLoading(msg) {
  hide(partnerSection);
  hide(actorSection);
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
  renderSceneOverview();

  const step = sequence[idx];
  if (step.type === 'partner') {
    await runPartnerStep(step);
  } else {
    await runActorStep(step, idx);
  }
}

// ── Партнёрский шаг ────────────────────────────────────────────────────────
async function runPartnerStep(step) {
  hide(actorSection);
  hide(loadingSection);
  show(partnerSection);

  partnerLinesEl.innerHTML = step.lines
    .map(l => `
      <div class="line-row">
        <span class="line-role">${escapeHtml(l.role)}</span>
        <span class="line-text">${renderAnnotations(l.text)}</span>
      </div>`)
    .join('');

  const blob = await getPartnerAudio(step.segId);
  if (!blob) {
    // Аудио не записано — пропускаем через небольшую паузу
    setTimeout(() => advanceTo(currentIdx + 1), 600);
    return;
  }

  const url   = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const next  = () => { URL.revokeObjectURL(url); advanceTo(currentIdx + 1); };
  audio.onended = next;
  audio.onerror = next;
  audio.play().catch(next);
}

// ── Реплика актёра ─────────────────────────────────────────────────────────
async function runActorStep(step, seqIdx) {
  hide(partnerSection);
  hide(loadingSection);
  show(actorSection);

  const speakableText = extractSpeakable(step.line.text);
  actorLineEl.innerHTML = renderAnnotations(step.line.text);
  liveTransEl.textContent = '';
  recStatusEl.textContent = 'Слушаем…';

  finalSegments = [];
  recordedChunks = [];
  turnDone = false;

  const { minLenRatio, scoreThreshold } = adaptiveThresholds(speakableText);

  try {
    const ok = await ensureSmToken();
    if (!ok) {
      recStatusEl.textContent = '⚠ Не удалось получить временный токен. Нажмите «Готово» вручную.';
      return;
    }
    await maybeReconnectPersistentIfTokenStale();
  } catch (e) {
    console.error('Failed to refresh Speechmatics token:', e);
    recStatusEl.textContent = '⚠ Ошибка обновления токена. Нажмите «Готово» вручную.';
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
      liveTransEl.textContent = text;
    },
    onFinal(text) {
      if (turnDone) return;
      finalSegments.push(text.trim());
      const hyp = finalSegments.join(' ');
      liveTransEl.textContent = hyp;

      const { score, lenRatio, tail } = calcScore(speakableText, hyp);
      if (lenRatio >= minLenRatio && score >= scoreThreshold && tail >= MIN_TAIL_SCORE) {
        finishActorTurn(seqIdx);
      }
    },
    onError(e) {
      console.error('Persistent session error:', e);
      recStatusEl.textContent = '⚠ Ошибка Speechmatics. Нажмите «Готово» вручную.';
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

  recStatusEl.textContent = '✓ Готово';

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
  show(sceneOverviewSection);

  let startIdx = loadRehearsalCursor();
  if (startIdx >= sequence.length) {
    startIdx = 0;
    saveRehearsalCursor(0);
  }

  renderSceneOverview();
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

