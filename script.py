import asyncio
import os
import re
import threading
from difflib import SequenceMatcher

from dotenv import load_dotenv
from speechmatics.rt import (
    AsyncClient,
    AudioEncoding,
    AudioFormat,
    Microphone,
    ServerMessageType,
    TranscriptionConfig,
    TranscriptResult,
)

load_dotenv()

CHUNK_SIZE = 4096
# Базовые пороги; для длинных фраз см. adaptive_thresholds()
MIN_LEN_RATIO = 0.8
FINAL_SCORE_THRESHOLD = 0.86
TAIL_WINDOW = 6
TAIL_WORDS = 3


def normalize_text(text: str) -> str:
    text = text.lower().replace("ё", "е")
    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def adaptive_thresholds(reference: str) -> tuple[float, float]:
    """Чем длиннее эталон, тем больше ошибок ASR — чуть мягче пороги."""
    n = len(normalize_text(reference).split())
    if n <= 15:
        return MIN_LEN_RATIO, FINAL_SCORE_THRESHOLD
    if n <= 50:
        return 0.75, 0.80
    return 0.68, 0.74


def lcs_length(a_words: list[str], b_words: list[str]) -> int:
    if not a_words or not b_words:
        return 0
    dp = [[0] * (len(b_words) + 1) for _ in range(len(a_words) + 1)]
    for i, a_word in enumerate(a_words, start=1):
        for j, b_word in enumerate(b_words, start=1):
            if a_word == b_word:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    return dp[-1][-1]


def tail_score(ref_words: list[str], hyp_words: list[str], tail_words_count: int, tail_window: int) -> float:
    if not ref_words or not hyp_words:
        return 0.0
    tail = " ".join(ref_words[-tail_words_count:])
    window = " ".join(hyp_words[-tail_window:])
    return SequenceMatcher(None, tail, window).ratio()


def calc_score(reference: str, hypothesis: str) -> tuple[float, float, float, float]:
    ref_norm = normalize_text(reference)
    hyp_norm = normalize_text(hypothesis)
    ref_words = ref_norm.split()
    hyp_words = hyp_norm.split()

    if not ref_words or not hyp_words:
        return 0.0, 0.0, 0.0, 0.0

    len_ratio = len(hyp_words) / max(len(ref_words), 1)
    coverage = lcs_length(ref_words, hyp_words) / len(ref_words)
    fuzzy = SequenceMatcher(None, ref_norm, hyp_norm).ratio()
    tail = tail_score(ref_words, hyp_words, tail_words_count=min(TAIL_WORDS, len(ref_words)), tail_window=TAIL_WINDOW)
    score = 0.45 * coverage + 0.35 * fuzzy + 0.20 * tail
    return score, coverage, fuzzy, len_ratio


def play_done_sound() -> None:
    try:
        import winsound

        winsound.Beep(1200, 250)
        winsound.Beep(1400, 250)
    except Exception:
        print("\a")


async def main() -> None:
    api_key = os.getenv("SPEECHMATICS_API_KEY")
    if not api_key:
        raise RuntimeError("Set SPEECHMATICS_API_KEY in .env")

    target_text = input("Введите строку, которую будете читать:\n> ").strip()
    if not target_text:
        raise RuntimeError("Пустая строка. Укажите текст для чтения.")

    min_len_ratio, score_threshold = adaptive_thresholds(target_text)
    ref_wc = len(normalize_text(target_text).split())
    print(
        f"(пороги: длина ≥ {min_len_ratio:.0%} от эталона (~{ref_wc} слов), score ≥ {score_threshold:.2f})"
    )

    loop = asyncio.get_running_loop()
    done = asyncio.Event()
    client = AsyncClient(api_key=api_key)
    mic = Microphone(sample_rate=16000, chunk_size=CHUNK_SIZE)

    # Каждое ADD_TRANSCRIPT — короткий финальный сегмент, не вся фраза целиком.
    # Склеиваем сегменты и сравниваем эталон с накопленной гипотезой.
    final_segments: list[str] = []
    segments_lock = threading.Lock()

    @client.on(ServerMessageType.ADD_PARTIAL_TRANSCRIPT)
    def on_partial(message) -> None:
        result = TranscriptResult.from_message(message)
        transcript = result.metadata.transcript
        if transcript:
            print(f"[partial]: {transcript}")

    @client.on(ServerMessageType.ADD_TRANSCRIPT)
    def on_final(message) -> None:
        result = TranscriptResult.from_message(message)
        transcript = result.metadata.transcript
        if not transcript:
            return
        print(f"[final]: {transcript}")
        with segments_lock:
            final_segments.append(transcript.strip())
            full_hypothesis = " ".join(final_segments)
        score, coverage, fuzzy, len_ratio = calc_score(target_text, full_hypothesis)
        if len_ratio >= min_len_ratio and score >= score_threshold:
            print(
                "Чтение завершено "
                f"(score={score:.2f}, coverage={coverage:.2f}, fuzzy={fuzzy:.2f}, len={len_ratio:.2f})."
            )
            play_done_sound()
            loop.call_soon_threadsafe(done.set)

    mic.start()
    try:
        await client.start_session(
            transcription_config=TranscriptionConfig(language="ru", enable_partials=True, max_delay=1),
            audio_format=AudioFormat(encoding=AudioEncoding.PCM_S16LE, sample_rate=16000),
        )
        print("Говорите в микрофон. Программа остановится, когда дочитаете строку.")
        while not done.is_set():
            await client.send_audio(await mic.read(CHUNK_SIZE))
    finally:
        mic.stop()
        await client.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nОстановлено (Ctrl+C).")