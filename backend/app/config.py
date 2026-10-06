import os
from pathlib import Path

from dotenv import load_dotenv

# Корневой .env хранит ключи сервисов, backend/.env — базу и секрет JWT.
# Второй вызов с override=True подставляет свои значения, не затирая чужие.
repo_root = Path(__file__).resolve().parents[2]
backend_dir = Path(__file__).resolve().parents[1]
load_dotenv(repo_root / ".env")
load_dotenv(backend_dir / ".env", override=True)


class Settings:
    database_url: str = os.getenv("DATABASE_URL")
    secret_key: str = os.getenv("SECRET_KEY")
    algorithm: str = os.getenv("ALGORITHM", "HS256")
    access_token_expire_minutes: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
    login_attempt_limit: int = int(os.getenv("LOGIN_ATTEMPT_LIMIT", "5"))
    login_window_minutes: int = int(os.getenv("LOGIN_WINDOW_MINUTES", "10"))
    cors_allow_origins: str = os.getenv("CORS_ALLOW_ORIGINS", "*")
    ttl_seconds: int = int(os.getenv("TTL_SECONDS", "600"))
    speechmatics_api_key: str = os.getenv("SPEECHMATICS_API_KEY")
    vse_gpt_api_key: str = os.getenv("VSEGPT_API_KEY")
    vse_gpt_base_url: str = os.getenv("VSEGPT_BASE_URL")
    vse_gpt_mode: str = os.getenv("VSEGPT_MODEL", "")
    vse_gpt_temperature: str = os.getenv("VSEGPT_TEMPERATURE", "0.2")
    vse_gpt_max_tokens: int = int(os.getenv("VSEGPT_MAX_TOKEN", "10000"))
    app_title="Cinema Casting"
settings = Settings()