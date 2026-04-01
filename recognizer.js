/**
 * Speechmatics Real-Time клиент для браузера.
 * Захватывает аудио с микрофона (через переданный MediaStream),
 * конвертирует PCM-s16le при 16 kHz и стримит через WebSocket.
 */

const RT_URL = 'wss://eu.rt.speechmatics.com/v2';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeAdditionalVocab(additionalVocab) {
  if (!Array.isArray(additionalVocab)) return [];
  return additionalVocab
    .map((item) => {
      if (typeof item === 'string') {
        const content = item.trim();
        return content ? { content } : null;
      }
      if (!item || typeof item !== 'object') return null;
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!content) return null;
      const result = { content };
      if (Array.isArray(item.sounds_like)) {
        const soundsLike = item.sounds_like
          .filter((value) => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean);
        if (soundsLike.length) {
          result.sounds_like = soundsLike;
        }
      }
      return result;
    })
    .filter(Boolean);
}

function buildStartPayload(apiKey, jwtToken, language, additionalVocab = []) {
  const startPayload = {
    message: 'StartRecognition',
    transcription_config: {
      language,
      enable_partials: true,
      max_delay: 1,
      operating_point: 'enhanced',
    },
    audio_format: {
      type: 'raw',
      encoding: 'pcm_s16le',
      sample_rate: 16000,
    },
  };
  const vocab = sanitizeAdditionalVocab(additionalVocab);
  if (vocab.length > 0) {
    startPayload.transcription_config.additional_vocab = vocab;
  }
  if (!jwtToken) {
    startPayload.auth_token = apiKey;
  }
  return startPayload;
}

/**
 * Лёгкий прогрев: открыть сессию, дождаться RecognitionStarted, закрыть без микрофона.
 * Помогает «прогреть» TLS/маршрут и проверить JWT до реальной реплики.
 */
export async function warmupSpeechmatics({
  jwtToken,
  apiKey = '',
  language = 'ru',
  additionalVocab = [],
  onDebug = () => {},
  timeoutMs = 15000,
}) {
  const wsUrl = jwtToken ? `${RT_URL}?jwt=${encodeURIComponent(jwtToken)}` : RT_URL;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('Speechmatics warmup: timeout waiting for RecognitionStarted'));
    }, timeoutMs);

    ws.onopen = () => {
      onDebug('warmup ws open');
      ws.send(JSON.stringify(buildStartPayload(apiKey, jwtToken, language, additionalVocab)));
    };

    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.message === 'RecognitionStarted') {
        clearTimeout(timeout);
        onDebug('warmup RecognitionStarted');
        try {
          ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: 0 }));
        } catch {
          /* ignore */
        }
        ws.close();
        resolve();
      } else if (data.message === 'Error') {
        clearTimeout(timeout);
        const details = data.reason || data.code || JSON.stringify(data);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Speechmatics warmup: ${details}`));
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Speechmatics warmup: WebSocket error'));
    };

    ws.onclose = (e) => {
      if (e.code !== 1000 && e.code !== 1005) {
        onDebug(`warmup ws close code=${e.code} reason=${e.reason || 'n/a'}`);
      }
    };
  });
}

export class SpeechmaticsRecognizer {
  /**
   * @param {{
   *   apiKey?: string,
   *   jwtToken?: string,
   *   language?: string,
   *   stream: MediaStream,
   *   onPartial?: (text: string) => void,
   *   onFinal?:   (text: string) => void,
   *   onError?:   (err: unknown) => void,
   *   onDebug?:   (msg: string) => void,
   *   additionalVocab?: Array<{ content: string, sounds_like?: string[] } | string>,
   *   maxStartAttempts?: number,
   *   startAttemptDelayMs?: number,
   *   recognitionTimeoutMs?: number,
   * }} opts
   */
  constructor({
    apiKey,
    jwtToken,
    language = 'ru',
    stream,
    onPartial,
    onFinal,
    onError,
    onDebug,
    additionalVocab = [],
    maxStartAttempts = 4,
    startAttemptDelayMs = 900,
    recognitionTimeoutMs = 18000,
  }) {
    this._apiKey = apiKey ?? '';
    this._jwtToken = jwtToken ?? '';
    this._language = language;
    this._stream = stream;
    this.onPartial = onPartial ?? (() => {});
    this.onFinal = onFinal ?? (() => {});
    this.onError = onError ?? console.error;
    this.onDebug = onDebug ?? (() => {});
    this._additionalVocab = sanitizeAdditionalVocab(additionalVocab);
    this._maxStartAttempts = maxStartAttempts;
    this._startAttemptDelayMs = startAttemptDelayMs;
    this._recognitionTimeoutMs = recognitionTimeoutMs;
    this._ws = null;
    this._ctx = null;
    this._processor = null;
    this._seqNo = 0;
    this._sessionReady = false;
    this._connectPromise = null;
  }

  /** Открывает WebSocket, ждёт RecognitionStarted, затем стримит аудио. */
  async start() {
    let lastErr;
    for (let attempt = 1; attempt <= this._maxStartAttempts; attempt++) {
      try {
        await this._connectOnce();
        return;
      } catch (e) {
        lastErr = e;
        this.onDebug(`start attempt ${attempt}/${this._maxStartAttempts} failed: ${String(e)}`);
        this.stop();
        if (attempt < this._maxStartAttempts) {
          await sleep(this._startAttemptDelayMs * attempt);
        }
      }
    }
    throw lastErr ?? new Error('Speechmatics: failed to start recognition');
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

      const wsUrl = this._jwtToken ? `${RT_URL}?jwt=${encodeURIComponent(this._jwtToken)}` : RT_URL;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;
      this._sessionReady = false;

      const timeout = setTimeout(() => {
        settleReject(new Error('Speechmatics: timeout waiting for RecognitionStarted'));
      }, this._recognitionTimeoutMs);

      ws.onopen = () => {
        this.onDebug('ws open');
        ws.send(JSON.stringify(buildStartPayload(this._apiKey, this._jwtToken, this._language, this._additionalVocab)));
      };

      ws.onmessage = (ev) => {
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (!this._sessionReady) {
          if (data.message === 'RecognitionStarted') {
            clearTimeout(timeout);
            this._sessionReady = true;
            this.onDebug('RecognitionStarted');
            this._startCapture();
            settleResolve();
          } else if (data.message === 'Error') {
            clearTimeout(timeout);
            const details = data.reason || data.code || JSON.stringify(data);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            settleReject(new Error(`Speechmatics error: ${details}`));
          }
          return;
        }

        if (data?.message && data.message !== 'AddPartialTranscript' && data.message !== 'AddTranscript') {
          this.onDebug(`ws message: ${data.message}`);
        }
        if (data?.message === 'Error') {
          const details = data?.reason || data?.code || JSON.stringify(data);
          this.onError(new Error(`Speechmatics error: ${details}`));
          return;
        }
        const text = data.metadata?.transcript?.trim();
        if (!text) return;
        if (data.message === 'AddPartialTranscript') this.onPartial(text);
        else if (data.message === 'AddTranscript') this.onFinal(text);
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        this.onDebug('ws error');
        settleReject(e instanceof Error ? e : new Error('WebSocket error'));
      };

      ws.onclose = (e) => {
        clearTimeout(timeout);
        this.onDebug(`ws close code=${e.code} reason=${e.reason || 'n/a'}`);
        if (!this._sessionReady) {
          settleReject(new Error(`Speechmatics: closed before RecognitionStarted (${e.code})`));
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
    const processor = this._ctx.createScriptProcessor(4096, 1, 1);
    this._processor = processor;

    processor.onaudioprocess = (e) => {
      if (this._ws?.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let k = 0; k < f32.length; k++) {
        i16[k] = Math.max(-32768, Math.min(32767, Math.round(f32[k] * 32767)));
      }
      this._ws.send(i16.buffer);
      this._seqNo++;
      if (this._seqNo % 20 === 0) {
        this.onDebug(`audio chunks sent: ${this._seqNo}`);
      }
    };

    source.connect(processor);
    processor.connect(this._ctx.destination);
  }

  /** Останавливает захват аудио и закрывает WebSocket. */
  stop() {
    this._sessionReady = false;
    if (this._processor) {
      this._processor.disconnect();
      this._processor = null;
    }
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
    }
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this._seqNo }));
      } catch {
        /* ignore */
      }
      this._ws.close();
    }
    this._ws = null;
    this._seqNo = 0;
    this._connectPromise = null;
  }
}

/**
 * Одно подключение WebSocket на весь сеанс: между репликами только отключается отправка аудио
 * (без EndOfStream — иначе по протоколу нельзя слать аудио дальше).
 * Полный разрыв — только destroy() или reconnect() при смене JWT.
 */
export class PersistentSpeechmaticsSession {
  /**
   * @param {{
   *   jwtToken: string,
   *   stream: MediaStream,
   *   language?: string,
   *   onDebug?: (msg: string) => void,
   *   additionalVocab?: Array<{ content: string, sounds_like?: string[] } | string>,
   *   maxStartAttempts?: number,
   *   startAttemptDelayMs?: number,
   *   recognitionTimeoutMs?: number,
   * }} opts
   */
  constructor({
    jwtToken,
    stream,
    language = 'ru',
    onDebug,
    additionalVocab = [],
    maxStartAttempts = 4,
    startAttemptDelayMs = 900,
    recognitionTimeoutMs = 18000,
  }) {
    this._jwtToken = jwtToken ?? '';
    this._stream = stream;
    this._language = language;
    this._additionalVocab = sanitizeAdditionalVocab(additionalVocab);
    this.onDebug = onDebug ?? (() => {});
    this.onPartial = () => {};
    this.onFinal = () => {};
    this.onError = console.error;
    this._maxStartAttempts = maxStartAttempts;
    this._startAttemptDelayMs = startAttemptDelayMs;
    this._recognitionTimeoutMs = recognitionTimeoutMs;

    this._ws = null;
    this._ctx = null;
    this._processor = null;
    this._seqNo = 0;
    this._sessionReady = false;
    this._captureStarted = false;
    /** Не слать PCM в сокет (между репликами и во время партнёра) */
    this._sendAudio = false;
    this._connectPromise = null;
    this._intentionalClose = false;
  }

  setJwt(jwt) {
    this._jwtToken = jwt ?? '';
  }

  setAdditionalVocab(additionalVocab) {
    this._additionalVocab = sanitizeAdditionalVocab(additionalVocab);
  }

  setHandlers({ onPartial, onFinal, onError }) {
    this.onPartial = onPartial ?? (() => {});
    this.onFinal = onFinal ?? (() => {});
    this.onError = onError ?? console.error;
  }

  pauseSending() {
    this._sendAudio = false;
  }

  resumeSending() {
    this._sendAudio = true;
  }

  /** Первое подключение (с ретраями). */
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
    throw lastErr ?? new Error('Speechmatics: persistent connect failed');
  }

  /**
   * Закрыть сессию и открыть новую с тем же графом захвата (новый JWT).
   * Нужно, когда истёк временный токен.
   */
  async reconnect(newJwt) {
    if (newJwt) this._jwtToken = newJwt;
    this.pauseSending();
    this._intentionalClose = true;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this._seqNo }));
      } catch {
        /* ignore */
      }
      this._ws.close();
    }
    this._ws = null;
    this._seqNo = 0;
    this._sessionReady = false;
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
    throw lastErr ?? new Error('Speechmatics: reconnect failed');
  }

  _abortSocketOnly() {
    if (this._ws) {
      try {
        if (this._ws.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this._seqNo }));
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
    this._seqNo = 0;
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

      const wsUrl = `${RT_URL}?jwt=${encodeURIComponent(this._jwtToken)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      const timeout = setTimeout(() => {
        settleReject(new Error('Speechmatics: timeout waiting for RecognitionStarted'));
      }, this._recognitionTimeoutMs);

      ws.onopen = () => {
        this.onDebug('persistent ws open');
        ws.send(JSON.stringify(buildStartPayload('', this._jwtToken, this._language, this._additionalVocab)));
      };

      ws.onmessage = (ev) => {
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (data.message === 'Warning') {
          this.onDebug(`ws Warning: ${data.type || '?'} ${data.reason || ''}`);
          return;
        }

        if (!this._sessionReady) {
          if (data.message === 'RecognitionStarted') {
            clearTimeout(timeout);
            this._sessionReady = true;
            this.onDebug('persistent RecognitionStarted');
            if (!this._captureStarted) {
              this._startCapture();
              this._captureStarted = true;
            }
            settleResolve();
          } else if (data.message === 'Error') {
            clearTimeout(timeout);
            const details = data.reason || data.code || JSON.stringify(data);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            settleReject(new Error(`Speechmatics error: ${details}`));
          }
          return;
        }

        if (data?.message && data.message !== 'AddPartialTranscript' && data.message !== 'AddTranscript') {
          this.onDebug(`ws message: ${data.message}`);
        }
        if (data?.message === 'Error') {
          const details = data?.reason || data?.code || JSON.stringify(data);
          this.onError(new Error(`Speechmatics error: ${details}`));
          return;
        }
        const text = data.metadata?.transcript?.trim();
        if (!text) return;
        if (data.message === 'AddPartialTranscript') this.onPartial(text);
        else if (data.message === 'AddTranscript') this.onFinal(text);
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
          settleReject(new Error(`Speechmatics: closed before RecognitionStarted (${e.code})`));
        } else if (!this._intentionalClose && this._sendAudio) {
          this.onError(new Error(`Speechmatics: connection closed (${e.code})`));
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
    const processor = this._ctx.createScriptProcessor(4096, 1, 1);
    this._processor = processor;

    processor.onaudioprocess = (e) => {
      if (!this._sendAudio) return;
      if (this._ws?.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let k = 0; k < f32.length; k++) {
        i16[k] = Math.max(-32768, Math.min(32767, Math.round(f32[k] * 32767)));
      }
      this._ws.send(i16.buffer);
      this._seqNo++;
    };

    source.connect(processor);
    processor.connect(this._ctx.destination);
  }

  /** Полное закрытие (конец репетиции). */
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
        this._ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this._seqNo }));
      } catch {
        /* ignore */
      }
      this._ws.close();
    }
    this._ws = null;
    this._seqNo = 0;
    this._sessionReady = false;
    this._connectPromise = null;
    this._intentionalClose = false;
  }
}
