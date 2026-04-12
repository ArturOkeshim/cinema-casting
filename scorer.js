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

/** LCS на двух массивах (слова или символы). */
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

export function calcScore(reference, hypothesis) {
  const refNorm  = normalizeText(reference);
  const hypNorm  = normalizeText(hypothesis);
  const refWords = refNorm.split(' ').filter(Boolean);
  const hypWords = hypNorm.split(' ').filter(Boolean);

  if (refWords.length === 0 || hypWords.length === 0) {
    return { score: 0, coverage: 0, fuzzy: 0, lenRatio: 0, tail: 0 };
  }

  const lenRatio  = hypWords.length / refWords.length;
  const coverage  = lcsLength(refWords, hypWords) / refWords.length;
  const fuzzy     = seqRatio([...refNorm], [...hypNorm]);

  const tailCount = Math.min(TAIL_REF_WORDS, refWords.length);
  const tailRefWords = refWords.slice(-tailCount);
  const tailHypWords = hypWords.slice(-TAIL_HYP_WORDS);
  // Пословное покрытие: сколько из последних слов эталона найдено в окне гипотезы (LCS)
  const tail = lcsLength(tailRefWords, tailHypWords) / tailRefWords.length;

  const score =
    WEIGHT_COVERAGE * coverage + WEIGHT_FUZZY * fuzzy + WEIGHT_TAIL * tail;
  return { score, coverage, fuzzy, lenRatio, tail };
}
