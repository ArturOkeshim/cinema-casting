"""
Yandex SpeechKit STT relay for the browser.

Flow:
  1) Browser opens WebSocket to our server: /api/stt
  2) Browser sends {"type":"start","sampleRate":16000}
  3) Our server opens gRPC RecognizeStreaming to SpeechKit (key stays in .env)
  4) Browser sends binary PCM; server forwards chunks and returns JSON events
     (partial / final / eou_update)

LEARNING NOTE: the browser cannot put an Api-Key on a WebSocket to Yandex.
We keep the secret on the server and only expose a same-origin /api/stt path.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import struct
import threading
from urllib.parse import urlparse

import grpc

from yandex_stt import stt_pb2, stt_pb2_grpc


DEFAULT_STT_HOST = "stt.api.cloud.yandex.net:443"
DEFAULT_BROWSER_WS_PATH = "/api/stt"
# Sentinel object: generator stops when this is put into the audio queue.
_END = object()


def browser_ws_path() -> str:
    return (os.getenv("YANDEX_BROWSER_WS_PATH") or DEFAULT_BROWSER_WS_PATH).strip() or DEFAULT_BROWSER_WS_PATH


def stt_host_from_env() -> str:
    return (os.getenv("YANDEX_STT_HOST") or DEFAULT_STT_HOST).strip() or DEFAULT_STT_HOST


def _ws_accept_key(sec_key: str) -> str:
    guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    digest = hashlib.sha1((sec_key + guid).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def _read_exact(sock, n: int) -> bytes:
    chunks = []
    got = 0
    while got < n:
        part = sock.recv(n - got)
        if not part:
            raise ConnectionError("client socket closed")
        chunks.append(part)
        got += len(part)
    return b"".join(chunks)


def _recv_browser_frame(sock) -> tuple[int, bytes]:
    """One masked WebSocket frame from the browser → (opcode, payload)."""
    header = _read_exact(sock, 2)
    b0, b1 = header[0], header[1]
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack("!H", _read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read_exact(sock, 8))[0]
    mask = _read_exact(sock, 4) if masked else b""
    payload = _read_exact(sock, length) if length else b""
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def _send_browser_frame(sock, opcode: int, payload: bytes) -> None:
    """One unmasked WebSocket frame to the browser."""
    fin_op = 0x80 | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        header = struct.pack("!BB", fin_op, n)
    elif n < 65536:
        header = struct.pack("!BBH", fin_op, 126, n)
    else:
        header = struct.pack("!BBQ", fin_op, 127, n)
    sock.sendall(header + payload)


def _send_json(sock, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _send_browser_frame(sock, 0x1, body)


def _session_options(sample_rate: int) -> stt_pb2.StreamingRequest:
    """First gRPC message: model, PCM format, Russian, realtime + EOU."""
    return stt_pb2.StreamingRequest(
        session_options=stt_pb2.StreamingOptions(
            recognition_model=stt_pb2.RecognitionModelOptions(
                model="general",
                audio_format=stt_pb2.AudioFormatOptions(
                    raw_audio=stt_pb2.RawAudio(
                        audio_encoding=stt_pb2.RawAudio.LINEAR16_PCM,
                        sample_rate_hertz=sample_rate,
                        audio_channel_count=1,
                    )
                ),
                text_normalization=stt_pb2.TextNormalizationOptions(
                    text_normalization=stt_pb2.TextNormalizationOptions.TEXT_NORMALIZATION_ENABLED,
                    profanity_filter=True,
                    literature_text=False,
                ),
                language_restriction=stt_pb2.LanguageRestrictionOptions(
                    restriction_type=stt_pb2.LanguageRestrictionOptions.WHITELIST,
                    language_code=["ru-RU"],
                ),
                audio_processing_type=stt_pb2.RecognitionModelOptions.REAL_TIME,
            ),
            eou_classifier=stt_pb2.EouClassifierOptions(
                default_classifier=stt_pb2.DefaultEouClassifier(
                    type=stt_pb2.DefaultEouClassifier.HIGH,
                    max_pause_between_words_hint_ms=500,
                )
            ),
        )
    )


def _first_text(update) -> str:
    if not update or not update.alternatives:
        return ""
    return (update.alternatives[0].text or "").strip()


def _event_from_response(response) -> dict | None:
    """Map SpeechKit StreamingResponse → small JSON for the browser."""
    event_type = response.WhichOneof("Event")
    if event_type == "partial":
        text = _first_text(response.partial)
        if not text:
            return None
        return {"type": "partial", "text": text}
    if event_type == "final":
        text = _first_text(response.final)
        if not text:
            return None
        return {"type": "final", "text": text}
    if event_type == "eou_update":
        return {"type": "eou_update"}
    if event_type == "status_code":
        code = response.status_code.code_type
        if code == stt_pb2.WORKING:
            return None
        return {
            "type": "status_code",
            "code": stt_pb2.CodeType.Name(code),
            "message": response.status_code.message or "",
        }
    # final_refinement ignored for now (plan: finals are enough for scoring)
    return None


def handle_stt_upgrade(handler) -> None:
    """
    Finish WebSocket handshake with the browser, then bridge to SpeechKit gRPC.
    `handler` is AppHandler (BaseHTTPRequestHandler).
    """
    parsed = urlparse(handler.path)
    if parsed.path.rstrip("/") != browser_ws_path().rstrip("/"):
        handler.send_error(404, "Not found")
        return

    upgrade = (handler.headers.get("Upgrade") or "").lower()
    connection = (handler.headers.get("Connection") or "").lower()
    sec_key = handler.headers.get("Sec-WebSocket-Key")
    if upgrade != "websocket" or "upgrade" not in connection or not sec_key:
        handler.send_error(400, "Expected WebSocket upgrade")
        return

    api_key = (os.getenv("YANDEX_API_KEY") or "").strip()
    if not api_key:
        handler.send_error(500, "YANDEX_API_KEY is not set in .env")
        return

    handler.protocol_version = "HTTP/1.1"
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", _ws_accept_key(sec_key))
    handler.end_headers()

    client_sock = handler.connection
    host = stt_host_from_env()
    folder_id = (os.getenv("YANDEX_FOLDER_ID") or "").strip()
    print(f"[stt] browser connected → SpeechKit {host}")

    audio_queue: queue.Queue = queue.Queue()
    sample_rate = 16000
    started = False
    stop = threading.Event()
    grpc_call = None
    # Keep the channel alive for the whole bridge (otherwise GC can close it).
    grpc_channel = None

    def request_iter():
        # First message must be session options, then audio chunks until _END.
        yield _session_options(sample_rate)
        while True:
            item = audio_queue.get()
            if item is _END:
                break
            yield stt_pb2.StreamingRequest(chunk=stt_pb2.AudioChunk(data=item))

    def yandex_to_browser():
        nonlocal grpc_call
        try:
            for response in grpc_call:
                if stop.is_set():
                    break
                event = _event_from_response(response)
                if event:
                    _send_json(client_sock, event)
        except Exception as exc:  # noqa: BLE001
            if not stop.is_set():
                print(f"[stt] gRPC stream error: {exc}")
                try:
                    _send_json(client_sock, {"type": "error", "message": str(exc)})
                except Exception:
                    pass
        finally:
            stop.set()
            try:
                _send_json(client_sock, {"type": "closed"})
            except Exception:
                pass

    def begin_grpc():
        nonlocal grpc_call, grpc_channel, started
        if started:
            return
        started = True
        metadata = [("authorization", f"Api-Key {api_key}")]
        if folder_id:
            metadata.append(("x-folder-id", folder_id))
        cred = grpc.ssl_channel_credentials()
        grpc_channel = grpc.secure_channel(host, cred)
        stub = stt_pb2_grpc.RecognizerStub(grpc_channel)
        print(f"[stt] RecognizeStreaming {host}, {sample_rate} Hz")
        grpc_call = stub.RecognizeStreaming(request_iter(), metadata=metadata)
        _send_json(client_sock, {"type": "ready", "host": host, "sampleRate": sample_rate})
        threading.Thread(target=yandex_to_browser, daemon=True).start()

    try:
        while not stop.is_set():
            opcode, payload = _recv_browser_frame(client_sock)
            if opcode == 0x8:  # close
                break
            if opcode == 0x9:  # ping → pong
                _send_browser_frame(client_sock, 0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x1:  # text JSON control
                try:
                    message = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                msg_type = message.get("type")
                if msg_type == "start":
                    rate = int(message.get("sampleRate") or 16000)
                    sample_rate = rate if rate in (8000, 16000, 48000) else 16000
                    begin_grpc()
                elif msg_type == "stop":
                    audio_queue.put(_END)
            elif opcode == 0x2:  # binary PCM
                if started and not stop.is_set():
                    audio_queue.put(payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[stt] browser socket error: {exc}")
    finally:
        stop.set()
        audio_queue.put(_END)
        if grpc_call is not None:
            try:
                grpc_call.cancel()
            except Exception:
                pass
        if grpc_channel is not None:
            try:
                grpc_channel.close()
            except Exception:
                pass
        try:
            client_sock.close()
        except Exception:
            pass
        print("[stt] bridge down")
