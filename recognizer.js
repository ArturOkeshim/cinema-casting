/**
 * Yandex SpeechKit STT client for the browser.
 *
 * Browser opens same-origin WebSocket /api/stt → our Python server
 * talks to SpeechKit over gRPC (API key stays in .env).
 *
 * Audio: PCM s16le mono at 16 kHz. Sending can be paused between actor lines.
 */

const STT_WS_PATH = '/api/stt';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build ws(s)://host/api/stt from the current page. */
export function buildSttWsUrl() {
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '127.0.0.1:8000';
  return `${proto}//${host}${STT_WS_PATH}`;
}

/**
 * One SpeechKit session for the whole rehearsal.
 * Same handler surface the rehearsal page already expects:
 *   setHandlers({ onPartial, onFinal, onEndOfUtterance, onError })
 *   pauseSending() / resumeSending()
 */
export class PersistentYandexSttSession {
  /**
   * @param {{
   *   stream: MediaStream,
   *   onDebug?: (msg: string) => void,
   *   maxStartAttempts?: number,
   *   startAttemptDelayMs?: number,
   *   recognitionTimeoutMs?: number,
   * }} opts
   */
  constructor({
    stream,
    onDebug,
    maxStartAttempts = 4,
    startAttemptDelayMs = 900,
    recognitionTimeoutMs = 18000,
  }) {
    this._stream = stream;
    this.onDebug = onDebug ?? (() => {});
    this.onPartial = () => {};
    this.onFinal = () => {};
    this.onEndOfUtterance = () => {};
    this.onError = console.error;
    this._maxStartAttempts = maxStartAttempts;
    this._startAttemptDelayMs = startAttemptDelayMs;
    this._recognitionTimeoutMs = recognitionTimeoutMs;

    this._ws = null;
    this._ctx = null;
    this._processor = null;
    this._sessionReady = false;
    this._captureStarted = false;
    /** Do not send PCM between actor lines / during partner audio */
    this._sendAudio = false;
    this._connectPromise = null;
    this._intentionalClose = false;
  }

  setHandlers({ onPartial, onFinal, onEndOfUtterance, onError }) {
    this.onPartial = onPartial ?? (() => {});
    this.onFinal = onFinal ?? (() => {});
    this.onEndOfUtterance = onEndOfUtterance ?? (() => {});
    this.onError = onError ?? console.error;
  }

  pauseSending() {
    this._sendAudio = false;
  }

  resumeSending() {
    this._sendAudio = true;
  }

  /** First connect (with retries). */
  async connect() {
    let lastErr;
    for (let attempt = 1; attempt <= this._maxStartAttempts; attempt++) {
      try {
        await this._connectOnce();
        return;
      } catch (e) {
        lastErr = e;
        this.onDebug(`persistent connect ${attempt}/${this._maxStartAttempts}: ${String(e)}`);
        this._abortSocketOnly();
        if (attempt < this._maxStartAttempts) {
          await sleep(this._startAttemptDelayMs * attempt);
        }
      }
    }
    throw lastErr ?? new Error('SpeechKit: persistent connect failed');
  }

  /** Close and open a fresh /api/stt session (same mic graph). */
  async reconnect() {
    this.pauseSending();
    this._intentionalClose = true;
    this._abortSocketOnly();
    this._intentionalClose = false;

    let lastErr;
    for (let attempt = 1; attempt <= this._maxStartAttempts; attempt++) {
      try {
        await this._connectOnce();
        return;
      } catch (e) {
        lastErr = e;
        this.onDebug(`persistent reconnect ${attempt}/${this._maxStartAttempts}: ${String(e)}`);
        this._abortSocketOnly();
        if (attempt < this._maxStartAttempts) {
          await sleep(this._startAttemptDelayMs * attempt);
        }
      }
    }
    throw lastErr ?? new Error('SpeechKit: reconnect failed');
  }

  _abortSocketOnly() {
    if (this._ws) {
      try {
        if (this._ws.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({ type: 'stop' }));
        }
      } catch {
        /* ignore */
      }
      try {
        this._ws.close();
      } catch {
        /* ignore */
      }
    }
    this._ws = null;
    this._sessionReady = false;
  }

  _connectOnce() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        this._connectPromise = null;
        reject(err);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        this._connectPromise = null;
        resolve();
      };

      const wsUrl = buildSttWsUrl();
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      const timeout = setTimeout(() => {
        settleReject(new Error('SpeechKit: timeout waiting for ready'));
      }, this._recognitionTimeoutMs);

      ws.onopen = () => {
        this.onDebug(`persistent ws open ${wsUrl}`);
        // Tell the server to open gRPC with our capture rate (16 kHz).
        ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (!this._sessionReady) {
          if (data.type === 'ready') {
            clearTimeout(timeout);
            this._sessionReady = true;
            this.onDebug(`persistent ready host=${data.host || '?'} rate=${data.sampleRate || '?'}`);
            if (!this._captureStarted) {
              this._startCapture();
              this._captureStarted = true;
            }
            settleResolve();
            return;
          }
          if (data.type === 'error') {
            clearTimeout(timeout);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            settleReject(new Error(`SpeechKit error: ${data.message || 'unknown'}`));
            return;
          }
        }

        if (data.type === 'error') {
          this.onError(new Error(`SpeechKit error: ${data.message || 'unknown'}`));
          return;
        }
        if (data.type === 'eou_update') {
          this.onEndOfUtterance({});
          return;
        }
        if (data.type === 'partial' && data.text) {
          this.onPartial(data.text);
          return;
        }
        if (data.type === 'final' && data.text) {
          this.onFinal(data.text);
          return;
        }
        if (data.type && data.type !== 'closed' && data.type !== 'ready') {
          this.onDebug(`ws message: ${data.type}`);
        }
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        this.onDebug('persistent ws error');
        settleReject(e instanceof Error ? e : new Error('WebSocket error'));
      };

      ws.onclose = (e) => {
        clearTimeout(timeout);
        if (ws !== this._ws) {
          this.onDebug(`persistent ws stale close (reconnect) code=${e.code}`);
          return;
        }
        this.onDebug(`persistent ws close code=${e.code} reason=${e.reason || 'n/a'}`);
        if (!this._sessionReady) {
          settleReject(new Error(`SpeechKit: closed before ready (${e.code})`));
        } else if (!this._intentionalClose && this._sendAudio) {
          this.onError(new Error(`SpeechKit: connection closed (${e.code})`));
        }
      };
    });
    return this._connectPromise;
  }

  _startCapture() {
    this._ctx = new AudioContext({ sampleRate: 16000 });
    if (this._ctx.sampleRate !== 16000) {
      console.warn(`AudioContext sample rate is ${this._ctx.sampleRate}, expected 16000.`);
    }
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }

    const source = this._ctx.createMediaStreamSource(this._stream);
    // LEARNING NOTE: ScriptProcessor is older API but simple and enough for PCM chunks.
    const processor = this._ctx.createScriptProcessor(4096, 1, 1);
    this._processor = processor;

    processor.onaudioprocess = (e) => {
      if (this._ws?.readyState !== WebSocket.OPEN) return;
      // LEARNING NOTE: SpeechKit wants chunks about every ≤5s. Between actor lines
      // we pause the mic for scoring, but still send silence so the gRPC stream stays up.
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      if (this._sendAudio) {
        for (let k = 0; k < f32.length; k++) {
          i16[k] = Math.max(-32768, Math.min(32767, Math.round(f32[k] * 32767)));
        }
      }
      // else: leave zeros = silence
      this._ws.send(i16.buffer);
    };

    source.connect(processor);
    processor.connect(this._ctx.destination);
  }

  /** Full teardown at end of rehearsal. */
  destroy() {
    this.pauseSending();
    this._intentionalClose = true;
    if (this._processor) {
      this._processor.disconnect();
      this._processor = null;
    }
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }
    this._captureStarted = false;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ type: 'stop' }));
      } catch {
        /* ignore */
      }
      this._ws.close();
    }
    this._ws = null;
    this._sessionReady = false;
    this._connectPromise = null;
    this._intentionalClose = false;
  }
}

/** Alias so older imports keep working during the switch. */
export const PersistentSpeechmaticsSession = PersistentYandexSttSession;
