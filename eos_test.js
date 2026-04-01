import { SpeechmaticsRecognizer, warmupSpeechmatics } from './recognizer.js';
import { adaptiveThresholds, calcScore, MIN_TAIL_SCORE } from './scorer.js';

const statusEl = document.getElementById('status');
const targetTextEl = document.getElementById('targetText');
const thresholdsEl = document.getElementById('thresholds');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const hypothesisEl = document.getElementById('hypothesis');
const metricsEl = document.getElementById('metrics');
const logEl = document.getElementById('log');
const simInputEl = document.getElementById('simInput');
const simBtn = document.getElementById('simBtn');

let smToken = '';
let smTokenExpiresAtMs = 0;
let recognizer = null;
let micStream = null;
let finalSegments = [];
let minLenRatio = 0.8;
let scoreThreshold = 0.86;
let done = false;
let partialSeen = false;

function setStatus(text, mode = 'normal') {
  statusEl.textContent = text;
  statusEl.className = 'status';
  if (mode === 'ok') statusEl.classList.add('ok');
  if (mode === 'err') statusEl.classList.add('err');
}

function log(message) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

window.addEventListener('error', (e) => {
  log(`JS error: ${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => {
  log(`Promise rejection: ${String(e.reason)}`);
});

function recalcThresholds() {
  const target = targetTextEl.value.trim();
  const t = adaptiveThresholds(target);
  minLenRatio = t.minLenRatio;
  scoreThreshold = t.scoreThreshold;
  thresholdsEl.textContent = `Пороги: len >= ${minLenRatio.toFixed(2)}, score >= ${scoreThreshold.toFixed(2)}, tail >= ${MIN_TAIL_SCORE.toFixed(2)}`;
}

function updateMetrics(hyp, target) {
  const raw = calcScore(target, hyp) || {};
  const score = Number.isFinite(raw.score) ? raw.score : 0;
  const coverage = Number.isFinite(raw.coverage) ? raw.coverage : 0;
  const fuzzy = Number.isFinite(raw.fuzzy) ? raw.fuzzy : 0;
  const lenRatio = Number.isFinite(raw.lenRatio) ? raw.lenRatio : 0;
  const tail = Number.isFinite(raw.tail) ? raw.tail : 0;
  if (!Number.isFinite(raw.tail)) {
    log('Diagnostic: calcScore returned no tail, fallback to 0');
  }
  metricsEl.textContent = `score=${score.toFixed(2)} coverage=${coverage.toFixed(2)} fuzzy=${fuzzy.toFixed(2)} tail=${tail.toFixed(2)} len=${lenRatio.toFixed(2)}`;
  return { score, coverage, fuzzy, lenRatio, tail };
}

function evaluateCurrentHypothesis() {
  const target = targetTextEl.value.trim();
  const hyp = finalSegments.join(' ').trim();
  hypothesisEl.textContent = hyp || '(пусто)';
  const { score, lenRatio, tail } = updateMetrics(hyp, target);
  const passed = lenRatio >= minLenRatio && score >= scoreThreshold && tail >= MIN_TAIL_SCORE;

  if (passed && !done) {
    done = true;
    setStatus('EOS сработал: условие выполнено', 'ok');
    log(`AUTO-STOP -> score=${score.toFixed(2)} len=${lenRatio.toFixed(2)} tail=${tail.toFixed(2)}`);
    stopListening();
  }
}

function appendFinalSegment(text, source) {
  const trimmed = text.trim();
  if (!trimmed) return;
  finalSegments.push(trimmed);
  log(`[${source}] final: ${trimmed}`);
  evaluateCurrentHypothesis();
}

async function fetchSmToken() {
  const res = await fetch('/api/sm-token');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cfg = await res.json();
  return {
    token: (cfg.token || '').trim(),
    expiresAtMs: Number.isFinite(cfg.expires_at_ms) ? cfg.expires_at_ms : 0,
  };
}

async function ensureSmToken(opts = {}) {
  const now = Date.now();
  if (!opts.force && smToken && smTokenExpiresAtMs - now > 60_000) return true;
  const data = await fetchSmToken();
  smToken = data.token;
  smTokenExpiresAtMs = data.expiresAtMs;
  return Boolean(smToken);
}

async function startListening() {
  log('Start button clicked');
  const target = targetTextEl.value.trim();
  if (!target) {
    setStatus('Введите эталонный текст', 'err');
    log('Start aborted: empty target text');
    return;
  }
  if (!smToken || smTokenExpiresAtMs - Date.now() <= 60_000) {
    log('Refreshing Speechmatics token from /api/sm-token');
    try {
      const ok = await ensureSmToken();
      log(ok ? 'Speechmatics token is ready' : 'Speechmatics token is empty');
    } catch (err) {
      log(`Speechmatics token reload failed: ${String(err)}`);
    }
    if (!smToken) {
      setStatus('Не удалось получить временный Speechmatics token', 'err');
      return;
    }
  }
  if (recognizer) {
    log('Recognizer already running, stopping previous session first');
    stopListening();
  }
  recalcThresholds();
  finalSegments = [];
  partialSeen = false;
  hypothesisEl.textContent = '(пусто)';
  done = false;
  updateMetrics('', target);
  setStatus('Слушаем...', 'normal');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = micStream.getAudioTracks();
    if (!tracks.length) {
      setStatus('Аудиотрек не получен', 'err');
      log('No audio tracks from getUserMedia');
      return;
    }
    const t = tracks[0];
    log(`Mic track: label="${t.label || 'unknown'}", enabled=${t.enabled}, muted=${t.muted}, readyState=${t.readyState}`);
  } catch {
    setStatus('Нет доступа к микрофону', 'err');
    log('getUserMedia failed (permission denied or no device)');
    return;
  }

  function makeRecognizer() {
    return new SpeechmaticsRecognizer({
      jwtToken: smToken,
      language: 'ru',
      stream: micStream,
      onPartial(text) {
        partialSeen = true;
        log(`[sm] partial: ${text}`);
      },
      onFinal(text) {
        if (done) return;
        appendFinalSegment(text, 'sm');
      },
      onError(err) {
        setStatus('Ошибка распознавания', 'err');
        log(`Recognizer error: ${String(err)}`);
      },
      onDebug(msg) {
        log(`[sm-debug] ${msg}`);
      },
    });
  }

  recognizer = makeRecognizer();

  try {
    await recognizer.start();
  } catch (err) {
    log(`Start error: ${String(err)}`);
    log('Повтор с новым токеном…');
    try {
      await ensureSmToken({ force: true });
    } catch {
      /* ignore */
    }
    if (!smToken) {
      setStatus('Не удалось запустить распознавание', 'err');
      stopListening();
      return;
    }
    recognizer = makeRecognizer();
    try {
      await recognizer.start();
    } catch (err2) {
      setStatus('Не удалось запустить распознавание', 'err');
      log(`Second start error: ${String(err2)}`);
      stopListening();
      return;
    }
  }

  startBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus('Распознавание запущено');
  log('Recognizer started');
  setTimeout(() => {
    if (recognizer && !partialSeen) {
      log('Diagnostic: за 4с нет partial. Проверь выбранный микрофон в ОС/браузере и активность сигнала.');
    }
  }, 4000);
}

function stopListening() {
  recognizer?.stop();
  recognizer = null;
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

async function init() {
  recalcThresholds();
  targetTextEl.addEventListener('input', () => {
    recalcThresholds();
    evaluateCurrentHypothesis();
  });

  startBtn.addEventListener('click', startListening);
  stopBtn.addEventListener('click', () => {
    stopListening();
    setStatus('Остановлено вручную');
    log('Stopped manually');
  });
  clearBtn.addEventListener('click', () => {
    logEl.textContent = '';
  });
  simBtn.addEventListener('click', () => {
    appendFinalSegment(simInputEl.value, 'sim');
    simInputEl.value = '';
  });

  try {
    const ok = await ensureSmToken();
    if (!ok) {
      setStatus('Токен не найден в /api/sm-token', 'err');
      log('Speechmatics temporary token is empty');
    } else {
      setStatus('Готово к тесту');
      log('Speechmatics temporary token loaded from /api/sm-token');
      try {
        await warmupSpeechmatics({
          jwtToken: smToken,
          onDebug: (m) => log(`[warmup] ${m}`),
        });
        log('Speechmatics warmup OK');
      } catch (wErr) {
        log(`Warmup: ${String(wErr)} (повтор при «Старт прослушивания»)`);
      }
    }
  } catch (err) {
    setStatus('Ошибка запроса /api/sm-token', 'err');
    log(`Config fetch error: ${String(err)}`);
  }
}

init();
