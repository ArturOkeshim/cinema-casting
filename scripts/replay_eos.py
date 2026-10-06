#!/usr/bin/env python3
"""
Офлайн-эксперименты с порогами EOS по logs/eos-turns.csv (без аудио и без SM).

Примеры:
  python scripts/replay_eos.py
  python scripts/replay_eos.py --tail 0.75 --score 0.65
  python scripts/replay_eos.py --csv logs/eos-turns.csv --only-manual
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


def load_turns(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def to_float(val, default=0.0) -> float:
    if val is None or val == "":
        return default
    try:
        return float(val)
    except ValueError:
        return default


def would_pass(row: dict, *, min_tail: float, min_score: float, min_len: float) -> bool:
    tail = to_float(row.get("tail_trim"))
    score = to_float(row.get("score_trim"))
    length = to_float(row.get("len_trim"))
    th_len = to_float(row.get("threshold_len"), min_len)
    th_score = to_float(row.get("threshold_score"), min_score)
    th_tail = to_float(row.get("threshold_tail"), min_tail)
    return length >= th_len and score >= th_score and tail >= th_tail


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay EOS thresholds on eos-turns.csv")
    parser.add_argument("--csv", default="logs/eos-turns.csv", help="Путь к CSV")
    parser.add_argument("--tail", type=float, default=0.78, help="MIN_TAIL_SCORE для симуляции")
    parser.add_argument("--score", type=float, default=None, help="Переопределить score (иначе из строки)")
    parser.add_argument("--len", dest="min_len", type=float, default=None, help="Переопределить len")
    parser.add_argument("--only-manual", action="store_true", help="Считать только бывшие manual")
    args = parser.parse_args()

    path = Path(args.csv)
    if not path.is_file():
        print(f"Файл не найден: {path}")
        print("Пройдите репетицию с обновлённым сервером — CSV пишется автоматически.")
        return

    rows = load_turns(path)
    if not rows:
        print("CSV пуст.")
        return

    subset = rows
    if args.only_manual:
        subset = [r for r in rows if r.get("finish_reason") == "manual"]

    rescued = 0
    false_auto = 0
    for row in subset:
        th_score = args.score if args.score is not None else to_float(row.get("threshold_score"), 0.68)
        th_len = args.min_len if args.min_len is not None else to_float(row.get("threshold_len"), 0.58)
        sim = would_pass(row, min_tail=args.tail, min_score=th_score, min_len=th_len)
        was_manual = row.get("finish_reason") == "manual"
        was_auto = row.get("finish_reason") == "auto"
        if was_manual and sim:
            rescued += 1
        if was_auto and not sim:
            false_auto += 1

    manual_total = sum(1 for r in rows if r.get("finish_reason") == "manual")
    auto_total = sum(1 for r in rows if r.get("finish_reason") == "auto")

    print(f"Строк в CSV: {len(rows)} (manual={manual_total}, auto={auto_total})")
    print(f"Симуляция: tail>={args.tail}, score/len из строки или флагов")
    if args.only_manual:
        print(f"Из manual ({len(subset)}): стали бы auto = {rescued}")
    else:
        print(f"Manual → auto (спасено): {rescued} / {manual_total}")
        print(f"Auto → fail (ложные):     {false_auto} / {auto_total}")


if __name__ == "__main__":
    main()
