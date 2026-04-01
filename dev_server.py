import json
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib import error, request

from dotenv import load_dotenv

load_dotenv()

HOST = "127.0.0.1"
PORT = 8000


class AppHandler(SimpleHTTPRequestHandler):
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
        super().do_GET()

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

    def do_POST(self):
        if self.path != "/api/llm":
            self._send_json(404, {"error": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
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
