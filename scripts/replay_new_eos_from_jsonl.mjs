#!/usr/bin/env node
/**
 * Пересчёт turn_end из logs/eos-debug-server.jsonl текущим scorer.js
 * и сравнение с исходным finishReason.
 *
 * Пример:
 *   node scripts/replay_new_eos_from_jsonl.mjs
 *   node scripts/replay_new_eos_from_jsonl.mjs --input logs/eos-debug-server.jsonl
 *   node scripts/replay_new_eos_from_jsonl.mjs --tail 0.78
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  adaptiveThresholds,
  calcScore,
  MIN_TAIL_SCORE,
  trimHypothesisWithMeta,
} from '../scorer.js';

function parseArgs(argv) {
  const out = {
    input: 'logs/eos-debug-server.jsonl',
    output: 'logs/eos-turns-rescored-new.csv',
    tail: null,
    score: null,
    len: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (a === '--output' && argv[i + 1]) out.output = argv[++i];
    else if (a === '--tail' && argv[i + 1]) out.tail = Number(argv[++i]);
    else if (a === '--score' && argv[i + 1]) out.score = Number(argv[++i]);
    else if (a === '--len' && argv[i + 1]) out.len = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/replay_new_eos_from_jsonl.mjs [--input path] [--output path] [--tail n] [--score n] [--len n]');
      process.exit(0);
    }
  }
  return out;
}

function toBool(v) {
  return v === true;
}

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function writeCsv(filePath, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) {
    console.error(`Input file not found: ${args.input}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(args.input, 'utf8').split(/\r?\n/).filter(Boolean);
  const turns = [];
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.event !== 'turn_end') continue;
    turns.push(ev);
  }

  if (!turns.length) {
    console.log('No turn_end events found.');
    process.exit(0);
  }

  const rows = [];
  let manualTotal = 0;
  let autoTotal = 0;
  let rescuedManual = 0;
  let brokenAuto = 0;

  for (const ev of turns) {
    const reference = (ev.speakableText || '').trim();
    const hypothesisRaw = (ev.hypothesisRaw || ev.hypothesisFinal || '').trim();
    const finishReason = ev.finishReason || '';
    const oldPassed = toBool(ev.passedTrimmed) || finishReason === 'auto';

    const fromAdaptive = adaptiveThresholds(reference);
    const fromEvent = ev.thresholds || {};
    const thresholdLen = args.len ?? safeNum(fromEvent.minLenRatio, fromAdaptive.minLenRatio);
    const thresholdScore = args.score ?? safeNum(fromEvent.scoreThreshold, fromAdaptive.scoreThreshold);
    const thresholdTail = args.tail ?? safeNum(fromEvent.minTailScore, MIN_TAIL_SCORE);

    const trimMeta = trimHypothesisWithMeta(reference, hypothesisRaw);
    const mRaw = calcScore(reference, trimMeta.hypothesisRaw);
    const mTrim = calcScore(reference, trimMeta.hypothesisTrimmed);
    const newPassed =
      mTrim.lenRatio >= thresholdLen &&
      mTrim.score >= thresholdScore &&
      mTrim.tail >= thresholdTail;

    if (finishReason === 'manual') manualTotal += 1;
    if (finishReason === 'auto') autoTotal += 1;
    if (finishReason === 'manual' && newPassed) rescuedManual += 1;
    if (finishReason === 'auto' && !newPassed) brokenAuto += 1;

    rows.push({
      ts: ev.ts || '',
      seq_idx: ev.seqIdx ?? '',
      actor_turn_index: ev.actorTurnIndex ?? '',
      finish_reason: finishReason,
      old_passed_trim: oldPassed,
      new_passed_trim: newPassed,
      threshold_len: thresholdLen.toFixed(4),
      threshold_score: thresholdScore.toFixed(4),
      threshold_tail: thresholdTail.toFixed(4),
      len_trim_new: mTrim.lenRatio.toFixed(4),
      score_trim_new: mTrim.score.toFixed(4),
      tail_trim_new: mTrim.tail.toFixed(4),
      tail_trim_exact_new: safeNum(mTrim.tailExact).toFixed(4),
      tail_trim_core_new: safeNum(mTrim.tailCore, mTrim.tail).toFixed(4),
      tail_trim_optional_new: safeNum(mTrim.tailOptionalMatch).toFixed(4),
      failed_gates_new: [
        mTrim.lenRatio < thresholdLen ? 'lenRatio' : '',
        mTrim.score < thresholdScore ? 'score' : '',
        mTrim.tail < thresholdTail ? 'tail' : '',
      ].filter(Boolean).join(','),
      hypothesis_raw: trimMeta.hypothesisRaw,
      hypothesis_trimmed_new: trimMeta.hypothesisTrimmed,
      reference,
    });
  }

  writeCsv(args.output, rows);

  console.log(`Turn rows: ${rows.length} (manual=${manualTotal}, auto=${autoTotal})`);
  console.log(`Thresholds: len=${args.len ?? 'event/adaptive'} score=${args.score ?? 'event/adaptive'} tail=${args.tail ?? 'event/default'}`);
  console.log(`Manual -> auto (rescued): ${rescuedManual} / ${manualTotal}`);
  console.log(`Auto -> fail (broken):    ${brokenAuto} / ${autoTotal}`);
  console.log(`Saved: ${args.output}`);
}

run();
