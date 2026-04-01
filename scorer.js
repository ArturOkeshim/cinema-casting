/**
 * Hybrid scorer — порт алгоритма из script.py.
 * Метрика: coverage (LCS по словам) + fuzzy (LCS по символам) + tail (совпадение хвоста).
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

/** Более мягкий порог хвоста — допускаем частичный пропуск служебных слов. */
export const MIN_TAIL_SCORE = 0.6;

export function adaptiveThresholds(reference) {
  const n = normalizeText(reference).split(' ').filter(Boolean).length;
  if (n <= 15) return { minLenRatio: 0.75, scoreThreshold: 0.82 };
  if (n <= 50) return { minLenRatio: 0.72, scoreThreshold: 0.77 };
  return            { minLenRatio: 0.66, scoreThreshold: 0.72 };
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

  const tailCount    = Math.min(3, refWords.length);
  const tailRefWords = refWords.slice(-tailCount);
  const tailHypWords = hypWords.slice(-6);
  // Пословное покрытие: сколько из последних слов эталона найдено в окне гипотезы (LCS)
  const tail = lcsLength(tailRefWords, tailHypWords) / tailRefWords.length;

  const score = 0.30 * coverage + 0.35 * fuzzy + 0.35 * tail;
  return { score, coverage, fuzzy, lenRatio, tail };
}
