/**
 * Hybrid scorer — порт алгоритма из script.py.
 * Фокус на концовке: начало/середина влияют слабо (coverage/fuzzy), итог в основном
 * определяется совпадением последних слов эталона (tail).
 */

export function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** LCS на двух массивах (слова или символы), точное совпадение элементов. */
function lcsLength(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp = new Int32Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const idx = i * (n + 1) + j;
      dp[idx] = a[i - 1] === b[j - 1]
        ? dp[(i - 1) * (n + 1) + (j - 1)] + 1
        : Math.max(dp[(i - 1) * (n + 1) + j], dp[i * (n + 1) + (j - 1)]);
    }
  }
  return dp[m * (n + 1) + n];
}

/** Минимальная длина слова для нечёткого совпадения в tail (короче — только exact). */
const TAIL_WORD_MIN_LEN = 4;

/** Порог похожести символов внутри слова для tail (4 буквы — типичные ASR-ошибки). */
function tailWordSimilarityThreshold(wordLen) {
  if (wordLen === 4) return 0.75;
  if (wordLen <= 5) return 0.85;
  return 0.8;
}

/** Частицы/междометия в хвосте: не штрафуем за пропуск, бонус если совпали. */
const TAIL_OPTIONAL_PARTICLES = new Set(['и', 'да', 'ну', 'о', 'э', 'уж', 'ли', 'же']);

/** Макс. прибавка к tail от совпавших optional-слов (не выше 1). */
const TAIL_OPTIONAL_BONUS_MAX = 0.15;

/**
 * Слово в хвосте необязательно для знаменателя: короткие (кроме «бы»), частицы.
 * «бы» в «хоть бы» остаётся в ядре.
 */
export function isOptionalTailWord(w) {
  if (w === 'бы') return false;
  if (TAIL_OPTIONAL_PARTICLES.has(w)) return true;
  return w.length <= 2;
}

function splitTailRefWords(tailRefWords) {
  const core = [];
  const optional = [];
  for (const w of tailRefWords) {
    (isOptionalTailWord(w) ? optional : core).push(w);
  }
  return { core, optional };
}

/** Tail: ядро (обязательные слова) + бонус за optional; tailExact — старый точный LCS по всем. */
function calcTailMetrics(tailRefWords, tailHypWords) {
  if (tailRefWords.length === 0) {
    return { tail: 0, tailExact: 0, tailCore: 0, tailOptionalMatch: 0 };
  }

  const tailExact = lcsLength(tailRefWords, tailHypWords) / tailRefWords.length;
  let { core, optional } = splitTailRefWords(tailRefWords);
  if (core.length === 0) core = [...tailRefWords];

  const tailCore =
    lcsLengthTailWords(core, tailHypWords) / core.length;

  let tailOptionalMatch = 0;
  if (optional.length > 0) {
    tailOptionalMatch =
      lcsLengthTailWords(optional, tailHypWords) / optional.length;
  }

  const tail =
    optional.length > 0
      ? Math.min(1, tailCore + TAIL_OPTIONAL_BONUS_MAX * tailOptionalMatch)
      : tailCore;

  return { tail, tailExact, tailCore, tailOptionalMatch };
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Int32Array((m + 1) * (n + 1));
  for (let i = 0; i <= m; i++) dp[i] = i;
  for (let j = 1; j <= n; j++) {
    dp[j] = j;
    for (let i = 1; i <= m; i++) {
      const idx = i * (n + 1) + j;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[idx] = Math.min(
        dp[(i - 1) * (n + 1) + j] + 1,
        dp[i * (n + 1) + (j - 1)] + 1,
        dp[(i - 1) * (n + 1) + (j - 1)] + cost,
      );
    }
  }
  return dp[m * (n + 1) + n];
}

/** Доля совпадающих символов: 1 - distance / max(len). */
export function wordSimilarityRatio(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/** Совпадение слов для tail: exact или ~80–85% символов (только слова ≥ 4 букв). */
export function wordsMatchForTail(a, b) {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < TAIL_WORD_MIN_LEN) return false;
  const threshold = tailWordSimilarityThreshold(Math.max(a.length, b.length));
  return wordSimilarityRatio(a, b) >= threshold;
}

/** LCS по словам, где пара считается совпадением при wordsMatchForTail. */
function lcsLengthTailWords(refWords, hypWords) {
  const m = refWords.length;
  const n = hypWords.length;
  if (m === 0 || n === 0) return 0;
  const dp = new Int32Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const idx = i * (n + 1) + j;
      dp[idx] = wordsMatchForTail(refWords[i - 1], hypWords[j - 1])
        ? dp[(i - 1) * (n + 1) + (j - 1)] + 1
        : Math.max(dp[(i - 1) * (n + 1) + j], dp[i * (n + 1) + (j - 1)]);
    }
  }
  return dp[m * (n + 1) + n];
}

/** Аналог SequenceMatcher.ratio(): 2*LCS / (|a| + |b|). */
function seqRatio(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/** Минимум по хвосту: здесь держим планку выше — концовку проговаривают чётко. */
export const MIN_TAIL_SCORE = 0.78;

/** Сколько последних слов эталона сравниваем с окном гипотезы (строже к финалу фразы). */
const TAIL_REF_WORDS = 4;
/** Окно в гипотезе: с запасом под ошибки сегментации ASR. */
const TAIL_HYP_WORDS = 10;

const WEIGHT_COVERAGE = 0.1;
const WEIGHT_FUZZY = 0.1;
const WEIGHT_TAIL = 0.8;

export function adaptiveThresholds(reference) {
  const n = normalizeText(reference).split(' ').filter(Boolean).length;
  // Композитный score в основном из tail — пороги ниже; длину допускаем свободнее.
  if (n <= 15) return { minLenRatio: 0.58, scoreThreshold: 0.68 };
  if (n <= 50) return { minLenRatio: 0.52, scoreThreshold: 0.63 };
  return { minLenRatio: 0.48, scoreThreshold: 0.58 };
}

/**
 * Ищет в гипотезе первое вхождение биграммы из начала эталона и возвращает
 * гипотезу начиная с этого места. Если биграмма не найдена или эталон короче
 * двух слов — возвращает исходную гипотезу без изменений.
 *
 * Это нужно чтобы отрезать мусорный префикс (хвост реплики партнёра,
 * случайные слова из микрофона), который смещает «окно хвоста» и занижает tail.
 *
 * Применяется только если:
 *   - эталон ≥ 4 слов (на коротких фразах риск ложного совпадения выше);
 *   - найденная позиция не в самом конце гипотезы (оставляем минимум 2 слова).
 */
export function trimHypothesisPrefix(reference, hypothesis) {
  const refWords = normalizeText(reference).split(' ').filter(Boolean);
  const hypWords = normalizeText(hypothesis).split(' ').filter(Boolean);

  if (refWords.length < 4 || hypWords.length < 2) return hypothesis;

  const [w0, w1] = refWords;

  for (let i = 0; i < hypWords.length - 1; i++) {
    if (hypWords[i] === w0 && hypWords[i + 1] === w1) {
      if (i === 0) return hypothesis;
      if (hypWords.length - i < 2) return hypothesis;
      return hypWords.slice(i).join(' ');
    }
  }

  return hypothesis;
}

/** Сколько слов отрезано префиксом (0 если trim не применялся). */
export function countTrimmedWords(reference, hypothesisRaw, hypothesisTrimmed) {
  const raw = normalizeText(hypothesisRaw).split(' ').filter(Boolean);
  const trimmed = normalizeText(hypothesisTrimmed).split(' ').filter(Boolean);
  if (raw.length === 0 || raw.join(' ') === trimmed.join(' ')) return 0;
  return Math.max(0, raw.length - trimmed.length);
}

export function trimHypothesisWithMeta(reference, hypothesis) {
  const trimmed = trimHypothesisPrefix(reference, hypothesis);
  const trimWordsSkipped = countTrimmedWords(reference, hypothesis, trimmed);
  return {
    hypothesisRaw: hypothesis,
    hypothesisTrimmed: trimmed,
    trimWordsSkipped,
    trimApplied: trimWordsSkipped > 0,
  };
}

export function calcScore(reference, hypothesis) {
  const refNorm  = normalizeText(reference);
  const hypNorm  = normalizeText(hypothesis);
  const refWords = refNorm.split(' ').filter(Boolean);
  const hypWords = hypNorm.split(' ').filter(Boolean);

  if (refWords.length === 0 || hypWords.length === 0) {
    return {
      score: 0, coverage: 0, fuzzy: 0, lenRatio: 0,
      tail: 0, tailExact: 0, tailCore: 0, tailOptionalMatch: 0,
    };
  }

  const lenRatio  = hypWords.length / refWords.length;
  const coverage  = lcsLength(refWords, hypWords) / refWords.length;
  const fuzzy     = seqRatio([...refNorm], [...hypNorm]);

  const tailCount = Math.min(TAIL_REF_WORDS, refWords.length);
  const tailRefWords = refWords.slice(-tailCount);
  const tailHypWords = hypWords.slice(-TAIL_HYP_WORDS);
  const { tail, tailExact, tailCore, tailOptionalMatch } =
    calcTailMetrics(tailRefWords, tailHypWords);

  const score =
    WEIGHT_COVERAGE * coverage + WEIGHT_FUZZY * fuzzy + WEIGHT_TAIL * tail;
  return { score, coverage, fuzzy, lenRatio, tail, tailExact, tailCore, tailOptionalMatch };
}
