import os
from dotenv import load_dotenv

load_dotenv()


def _env_int(name: str, default: int) -> int:
    # We use a helper so a missing/empty env var does not crash startup with int(None).
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


class Settings:
    database_url: str = os.getenv("DATABASE_URL")
    secret_key: str = os.getenv("SECRET_KEY")
    algorithm: str = os.getenv("ALGORITHM", "HS256")
    access_token_expire_minutes: int = _env_int("ACCESS_TOKEN_EXPIRE_MINUTES", 30)
    login_attempt_limit: int = _env_int("LOGIN_ATTEMPT_LIMIT", 5)
    login_window_minutes: int = _env_int("LOGIN_WINDOW_MINUTES", 10)
    cors_allow_origins: str = os.getenv("CORS_ALLOW_ORIGINS", "*")
    # Speechmatics temporary token lifetime (seconds)
    ttl_seconds: int = _env_int("TTL_SECONDS", 600)
    speechmatics_api_key: str = os.getenv("SPEECHMATICS_API_KEY", "")
    # VseGPT (used when LLM moves fully into this backend)
    vse_gpt_api_key: str = os.getenv("VSEGPT_API_KEY", "")
    vse_gpt_base_url: str = os.getenv("VSEGPT_BASE_URL", "https://api.vsegpt.ru/v1")
    vse_gpt_model: str = os.getenv("VSEGPT_MODEL", "anthropic/claude-3-haiku")
    vse_gpt_temperature: float = float(os.getenv("VSEGPT_TEMPERATURE") or "0.2")
    vse_gpt_max_tokens: int = _env_int("VSEGPT_MAX_TOKENS", 3000)
    app_title: str = os.getenv("APP_TITLE", "Cinema Casting")


settings = Settings()
