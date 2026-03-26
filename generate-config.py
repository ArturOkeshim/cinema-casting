import json
from pathlib import Path

from dotenv import load_dotenv
import os


def to_number(value: str, fallback):
    if value is None or value == "":
        return fallback
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return fallback


def main():
    root = Path(__file__).resolve().parent
    env_path = root / ".env"
    load_dotenv(env_path)

    config = {
        "VSEGPT_API_KEY": os.getenv("VSEGPT_API_KEY", ""),
        "VSEGPT_BASE_URL": os.getenv("VSEGPT_BASE_URL", "https://api.vsegpt.ru/v1"),
        "VSEGPT_MODEL": os.getenv("VSEGPT_MODEL", "anthropic/claude-3-haiku"),
        "VSEGPT_TEMPERATURE": to_number(os.getenv("VSEGPT_TEMPERATURE"), 0.2),
        "VSEGPT_MAX_TOKENS": to_number(os.getenv("VSEGPT_MAX_TOKENS"), 3000),
        "APP_TITLE": os.getenv("APP_TITLE", "Cinema Casting"),
    }

    target = root / "public-config.js"
    target.write_text(
        "window.APP_CONFIG = " + json.dumps(config, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(f"Generated: {target}")


if __name__ == "__main__":
    main()
