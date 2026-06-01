import csv
import json
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib import error, request
from urllib.parse import unquote

from dotenv import load_dotenv

load_dotenv()

# Production: keep BIND_HOST=127.0.0.1 and put nginx in front.
HOST = os.getenv("BIND_HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

# Статика раздаётся из корня проекта — явно не отдаём секреты и служебные каталоги.
_FORBIDDEN_PATH_SEGMENTS = frozenset({
    ".env",
    ".git",
    ".svn",
    ".hg",
    ".ssh",
    "venv",
    ".venv",
    "__pycache__",
    "logs",
})
_EOS_LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
_EOS_LOG_FILE = os.path.join(_EOS_LOG_DIR, "eos-debug.jsonl")
_EOS_TURNS_CSV = os.path.join(_EOS_LOG_DIR, "eos-turns.csv")
_EOS_FINALS_CSV = os.path.join(_EOS_LOG_DIR, "eos-finals.csv")
_MAX_EOS_LOG_BODY = 128 * 1024
_MAX_EOS_LOG_EVENTS = 10

_TURNS_CSV_HEADERS = [
    "ts", "session_id", "role", "finish_reason", "seq_idx", "actor_turn_index",
    "reference", "hypothesis_raw", "hypothesis_trimmed", "trim_words_skipped", "trim_applied",
    "tail_raw", "score_raw", "len_raw",
    "tail_trim", "tail_trim_exact", "tail_trim_core", "tail_trim_optional",
    "score_trim", "len_trim",
    "failed_gates_trim", "tail_margin_trim", "score_margin_trim", "len_margin_trim",
    "passed_trim", "passed_raw", "partial_would_pass_trim",
    "hypothesis_with_partial_raw", "hypothesis_with_partial_trimmed",
    "partial_count", "final_count", "eou_count", "sm_eou_silence_sec",
    "last_eou_eligible", "last_eou_mode", "last_eou_matched_tail",
    "turn_duration_sec", "sm_resume_delay_ms",
    "sm_error", "threshold_len", "threshold_score", "threshold_tail",
]

_EOU_SILENCE_CSV = os.path.join(_EOS_LOG_DIR, "eos-eou-silence.csv")
_EOU_SILENCE_CSV_HEADERS = [
    "ts", "session_id", "role", "seq_idx", "actor_turn_index", "eou_index", "t_ms",
    "silence_trigger_sec", "eligible", "matched_tail_words", "ref_word_count",
    "len_ratio", "coverage", "tail", "score",
    "strict_passed", "relaxed_passed", "mode", "eou_ignore_reason", "significance",
]

_FINALS_CSV_HEADERS = [
    "ts", "session_id", "role", "seq_idx", "actor_turn_index", "final_index", "t_ms",
    "segment_text", "hypothesis_raw", "hypothesis_trimmed", "trim_words_skipped",
    "tail_raw", "score_raw", "len_raw",
    "tail_trim", "tail_trim_exact", "tail_trim_core", "tail_trim_optional",
    "score_trim", "len_trim",
    "passed_raw", "passed_trim", "failed_gates_trim",
]


def _csv_join(items) -> str:
    if not items:
        return ""
    return ", ".join(str(x) for x in items)


def _metric_block(ev: dict, block: str, key: str):
    return (ev.get(block) or {}).get(key)


def _append_csv_rows(path: str, headers: list[str], rows: list[dict]) -> None:
    os.makedirs(_EOS_LOG_DIR, exist_ok=True)
    write_header = not os.path.isfile(path) or os.path.getsize(path) == 0
    with open(path, "a", encoding="utf-8-sig", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=headers, extrasaction="ignore")
        if write_header:
            writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _csv_rows_for_turn_end(ev: dict) -> tuple[dict, list[dict]]:
    th = ev.get("thresholds") or {}
    gm = ev.get("gateMarginsTrimmed") or {}
    turn_row = {
        "ts": ev.get("ts", ""),
        "session_id": ev.get("sessionId", ""),
        "role": ev.get("role", ""),
        "finish_reason": ev.get("finishReason", ""),
        "seq_idx": ev.get("seqIdx"),
        "actor_turn_index": ev.get("actorTurnIndex"),
        "reference": ev.get("speakableText", ""),
        "hypothesis_raw": ev.get("hypothesisRaw") or ev.get("hypothesisFinal", ""),
        "hypothesis_trimmed": ev.get("hypothesisTrimmed") or ev.get("hypothesisFinal", ""),
        "trim_words_skipped": ev.get("trimWordsSkipped", 0),
        "trim_applied": ev.get("trimApplied", False),
        "tail_raw": _metric_block(ev, "metricsRaw", "tail"),
        "score_raw": _metric_block(ev, "metricsRaw", "score"),
        "len_raw": _metric_block(ev, "metricsRaw", "lenRatio"),
        "tail_trim": _metric_block(ev, "metricsTrimmed", "tail") or _metric_block(ev, "metricsFinal", "tail"),
        "tail_trim_exact": _metric_block(ev, "metricsTrimmed", "tailExact"),
        "tail_trim_core": _metric_block(ev, "metricsTrimmed", "tailCore"),
        "tail_trim_optional": _metric_block(ev, "metricsTrimmed", "tailOptionalMatch"),
        "score_trim": _metric_block(ev, "metricsTrimmed", "score") or _metric_block(ev, "metricsFinal", "score"),
        "len_trim": _metric_block(ev, "metricsTrimmed", "lenRatio") or _metric_block(ev, "metricsFinal", "lenRatio"),
        "failed_gates_trim": _csv_join(ev.get("failedGatesTrimmed") or ev.get("failedGatesFinal") or []),
        "tail_margin_trim": gm.get("tail"),
        "score_margin_trim": gm.get("score"),
        "len_margin_trim": gm.get("lenRatio"),
        "passed_trim": ev.get("passedTrimmed", ev.get("finishReason") == "auto"),
        "passed_raw": ev.get("passedRaw"),
        "partial_would_pass_trim": ev.get("partialWouldPassTrimmed") or ev.get("partialWouldPass"),
        "hypothesis_with_partial_raw": ev.get("hypothesisWithPartialRaw") or ev.get("hypothesisWithPartial", ""),
        "hypothesis_with_partial_trimmed": ev.get("hypothesisWithPartialTrimmed") or ev.get("hypothesisWithPartial", ""),
        "partial_count": ev.get("partialCount"),
        "final_count": ev.get("finalCount"),
        "eou_count": ev.get("eouCount", 0),
        "sm_eou_silence_sec": ev.get("smEouSilenceSec"),
        "last_eou_eligible": (ev.get("lastEouEvaluation") or {}).get("eligible"),
        "last_eou_mode": (ev.get("lastEouEvaluation") or {}).get("mode"),
        "last_eou_matched_tail": (ev.get("lastEouEvaluation") or {}).get("matchedTailWords"),
        "turn_duration_sec": round((ev.get("turnDurationMs") or 0) / 1000, 2),
        "sm_resume_delay_ms": ev.get("smResumeDelayMs", 0),
        "sm_error": ev.get("smError") or "",
        "threshold_len": th.get("minLenRatio"),
        "threshold_score": th.get("scoreThreshold"),
        "threshold_tail": th.get("minTailScore"),
    }

    final_rows: list[dict] = []
    for item in ev.get("timeline") or []:
        if item.get("kind") != "final":
            continue
        m_raw = item.get("metricsRaw") or {}
        m_trim = item.get("metricsTrimmed") or {}
        final_rows.append({
            "ts": ev.get("ts", ""),
            "session_id": ev.get("sessionId", ""),
            "role": ev.get("role", ""),
            "seq_idx": ev.get("seqIdx"),
            "actor_turn_index": ev.get("actorTurnIndex"),
            "final_index": item.get("finalIndex"),
            "t_ms": item.get("tMs"),
            "segment_text": item.get("segmentText", ""),
            "hypothesis_raw": item.get("hypothesisRaw", ""),
            "hypothesis_trimmed": item.get("hypothesisTrimmed", ""),
            "trim_words_skipped": item.get("trimWordsSkipped", 0),
            "tail_raw": m_raw.get("tail"),
            "score_raw": m_raw.get("score"),
            "len_raw": m_raw.get("lenRatio"),
            "tail_trim": m_trim.get("tail"),
            "tail_trim_exact": m_trim.get("tailExact"),
            "tail_trim_core": m_trim.get("tailCore"),
            "tail_trim_optional": m_trim.get("tailOptionalMatch"),
            "score_trim": m_trim.get("score"),
            "len_trim": m_trim.get("lenRatio"),
            "passed_raw": item.get("passedRaw"),
            "passed_trim": item.get("passedTrimmed"),
            "failed_gates_trim": _csv_join(item.get("failedGatesTrimmed") or []),
        })
    return turn_row, final_rows


def _csv_rows_for_eou_periods(ev: dict) -> list[dict]:
    rows: list[dict] = []
    for period in ev.get("eouPeriods") or []:
        rows.append({
            "ts": ev.get("ts", ""),
            "session_id": ev.get("sessionId", ""),
            "role": ev.get("role", ""),
            "seq_idx": ev.get("seqIdx"),
            "actor_turn_index": ev.get("actorTurnIndex"),
            "eou_index": period.get("eouIndex"),
            "t_ms": period.get("tMs"),
            "silence_trigger_sec": period.get("silenceTriggerSec"),
            "eligible": period.get("eligible"),
            "matched_tail_words": period.get("matchedTailWords"),
            "ref_word_count": period.get("refWordCount"),
            "len_ratio": period.get("lenRatio"),
            "coverage": period.get("coverage"),
            "tail": period.get("tail"),
            "score": period.get("score"),
            "strict_passed": period.get("strictPassed"),
            "relaxed_passed": period.get("relaxedPassed"),
            "mode": period.get("mode"),
            "eou_ignore_reason": period.get("eouIgnoreReason"),
            "significance": period.get("significance"),
        })
    return rows


_FORBIDDEN_FILE_NAMES = frozenset({
    "id_rsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials.json",
    "secrets.json",
})
_FORBIDDEN_SUFFIXES = (".pem",)


def _is_forbidden_static_path(raw_path: str) -> bool:
    path_only = unquote(raw_path.split("?", 1)[0])
    if ".." in path_only:
        return True
    segments = [s for s in path_only.split("/") if s]
    for seg in segments:
        low = seg.lower()
        if seg in _FORBIDDEN_PATH_SEGMENTS or low in _FORBIDDEN_PATH_SEGMENTS:
            return True
        if seg.startswith(".env") or low.startswith(".env"):
            return True
        if low in _FORBIDDEN_FILE_NAMES:
            return True
        if any(low.endswith(sfx) for sfx in _FORBIDDEN_SUFFIXES):
            return True
    return False


class AppHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Разработка: всегда отдавать свежие HTML/JS/CSS с сервера, без кэша в браузере.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/config":
            self._send_json(200, {
                "speechmatics_key": os.getenv("SPEECHMATICS_API_KEY", ""),
            })
            return
        if self.path == "/api/sm-token":
            api_key = os.getenv("SPEECHMATICS_API_KEY", "").strip()
            if not api_key:
                self._send_json(500, {"error": "SPEECHMATICS_API_KEY is not set in .env"})
                return
            try:
                token = self._create_speechmatics_rt_token(api_key)
            except Exception as exc:  # noqa: BLE001
                self._send_json(502, {"error": f"Failed to create Speechmatics token: {exc}"})
                return
            ttl_seconds = 600
            self._send_json(
                200,
                {
                    "token": token,
                    "ttl_seconds": ttl_seconds,
                    "expires_at_ms": int((time.time() + ttl_seconds) * 1000),
                },
            )
            return
        if _is_forbidden_static_path(self.path):
            self.send_error(403, "Forbidden")
            return
        super().do_GET()

    def do_HEAD(self):
        if _is_forbidden_static_path(self.path):
            self.send_error(403, "Forbidden")
            return
        super().do_HEAD()

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _create_speechmatics_rt_token(self, api_key: str) -> str:
        req = request.Request(
            url="https://mp.speechmatics.com/v1/api_keys?type=rt",
            data=json.dumps({"ttl": 600}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with request.urlopen(req, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        token = (payload.get("key_value") or "").strip()
        if not token:
            raise RuntimeError("Speechmatics returned empty temporary token")
        return token

    def _append_eos_log_events(self, events: list) -> None:
        os.makedirs(_EOS_LOG_DIR, exist_ok=True)
        with open(_EOS_LOG_FILE, "a", encoding="utf-8") as log_file:
            for event in events:
                log_file.write(json.dumps(event, ensure_ascii=False) + "\n")

        turn_rows: list[dict] = []
        final_rows: list[dict] = []
        eou_rows: list[dict] = []
        for event in events:
            if event.get("event") != "turn_end":
                continue
            turn_row, step_rows = _csv_rows_for_turn_end(event)
            turn_rows.append(turn_row)
            final_rows.extend(step_rows)
            eou_rows.extend(_csv_rows_for_eou_periods(event))
        if turn_rows:
            _append_csv_rows(_EOS_TURNS_CSV, _TURNS_CSV_HEADERS, turn_rows)
        if final_rows:
            _append_csv_rows(_EOS_FINALS_CSV, _FINALS_CSV_HEADERS, final_rows)
        if eou_rows:
            _append_csv_rows(_EOS_SILENCE_CSV, _EOU_SILENCE_CSV_HEADERS, eou_rows)

    def _handle_eos_log(self, raw_body: bytes) -> None:
        if len(raw_body) > _MAX_EOS_LOG_BODY:
            self._send_json(413, {"error": "Payload too large"})
            return
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON body"})
            return

        events = body.get("events")
        if not isinstance(events, list) or not events:
            self._send_json(400, {"error": "Missing or empty events array"})
            return
        if len(events) > _MAX_EOS_LOG_EVENTS:
            self._send_json(400, {"error": f"Too many events (max {_MAX_EOS_LOG_EVENTS})"})
            return

        for event in events:
            if not isinstance(event, dict):
                self._send_json(400, {"error": "Each event must be an object"})
                return

        try:
            self._append_eos_log_events(events)
        except OSError as exc:
            self._send_json(500, {"error": f"Failed to write log: {exc}"})
            return

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"

        if self.path == "/api/eos-log":
            self._handle_eos_log(raw_body)
            return

        if self.path != "/api/llm":
            self._send_json(404, {"error": "Not found"})
            return

        try:
            body = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON body"})
            return

        prompt = (body.get("prompt") or "").strip()
        if not prompt:
            self._send_json(400, {"error": "Missing prompt"})
            return

        api_key = os.getenv("VSEGPT_API_KEY", "").strip()
        if not api_key:
            self._send_json(500, {"error": "VSEGPT_API_KEY is not set in .env"})
            return

        base_url = os.getenv("VSEGPT_BASE_URL", "https://api.vsegpt.ru/v1").rstrip("/")
        model = os.getenv("VSEGPT_MODEL", "anthropic/claude-3-haiku")
        app_title = os.getenv("APP_TITLE", "Cinema Casting")

        try:
            temperature = float(os.getenv("VSEGPT_TEMPERATURE", "0.2"))
        except ValueError:
            temperature = 0.2

        try:
            max_tokens = int(os.getenv("VSEGPT_MAX_TOKENS", "3000"))
        except ValueError:
            max_tokens = 3000

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "n": 1,
            "max_tokens": max_tokens,
        }

        api_request = request.Request(
            url=f"{base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "X-Title": app_title,
            },
            method="POST",
        )

        try:
            with request.urlopen(api_request, timeout=60) as response:
                response_body = response.read().decode("utf-8")
                api_data = json.loads(response_body)
        except error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            self._send_json(502, {"error": f"Upstream HTTPError: {details}"})
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(502, {"error": f"Upstream request failed: {exc}"})
            return

        content = (
            api_data.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        if not content:
            self._send_json(502, {"error": "LLM returned empty content"})
            return

        print("\n--- RAW LLM RESPONSE ---")
        print(content)
        print("--- END RAW ---\n")

        self._send_json(200, {"content": content})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Serving on http://{HOST}:{PORT}")
    server.serve_forever()
