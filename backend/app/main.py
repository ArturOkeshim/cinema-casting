from datetime import timedelta, datetime, timezone

from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from fastapi.staticfiles import StaticFiles

from passlib.context import CryptContext
from pathlib import Path
from sqlalchemy import select, text
from jose import jwt, JWTError
import time
import json
from urllib import request
from dotenv import load_dotenv

from app.db import SessionLocal, engine
from app.models import User
from app.config import settings
from app.schemas import RegisterBody, LoginBody

load_dotenv()

app = FastAPI()
PROJECT_ROOT = Path(__file__).resolve().parents[2]

cors_origins = [origin.strip() for origin in settings.cors_allow_origins.split(",") if origin.strip()]
allow_all_origins = "*" in cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all_origins else cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login")

# Simple in-memory login rate limiter.
LOGIN_ATTEMPT_LIMIT = settings.login_attempt_limit
LOGIN_WINDOW = timedelta(minutes=settings.login_window_minutes)
failed_login_attempts: dict[str, list[datetime]] = {}



def _login_rate_key(email: str, request: Request) -> str:
    client_ip = request.client.host if request.client else "unknown"
    return f"{email.lower().strip()}|{client_ip}"


def _ensure_login_allowed(key: str) -> None:
    now = datetime.now(timezone.utc)
    attempts = failed_login_attempts.get(key, [])
    attempts = [ts for ts in attempts if now - ts < LOGIN_WINDOW]
    failed_login_attempts[key] = attempts
    if len(attempts) >= LOGIN_ATTEMPT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="Too many failed login attempts. Try again later.",
        )


def _register_failed_login(key: str) -> None:
    now = datetime.now(timezone.utc)
    attempts = failed_login_attempts.get(key, [])
    attempts.append(now)
    failed_login_attempts[key] = [ts for ts in attempts if now - ts < LOGIN_WINDOW]


def _clear_failed_logins(key: str) -> None:
    failed_login_attempts.pop(key, None)


def _normalize_email(email: str) -> str:
    return email.strip().lower()

def _create_speechmatics_rt_token(api_key: str) -> str:
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




def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)

    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)
    return encoded_jwt

def get_current_user_id(token: str = Depends(oauth2_scheme))->int:
    credentials_exception = HTTPException(
        status_code=401,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        sub = payload.get("sub")
        if sub is None:
            raise credentials_exception
        return int(sub)
    except (JWTError, ValueError):
        raise credentials_exception


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/db-check")
def db_check():
    with engine.connect() as connection:
        value = connection.execute(text("SELECT 1")).scalar()
    return {"database_ok": value == 1}


@app.post("/register")
def register(body: RegisterBody):
    normalized_email = _normalize_email(body.email)
    db = SessionLocal()
    try:
        existing_user = db.execute(
            select(User).where(User.email == normalized_email)
        ).scalar_one_or_none()

        if existing_user:
            raise HTTPException(status_code=409, detail="Email already registered")

        user = User(
            email=normalized_email,
            password_hash=pwd_context.hash(body.password),
        )

        db.add(user)
        db.commit()
        db.refresh(user)

        return {"id": user.id, "email": user.email}
    finally:
        db.close()

@app.post("/login")
def login(body: LoginBody, request: Request):
    normalized_email = _normalize_email(body.email)
    rate_limit_key = _login_rate_key(normalized_email, request)
    _ensure_login_allowed(rate_limit_key)
    db = SessionLocal()
    try:
        user = db.execute(
            select(User).where(User.email == normalized_email)
        ).scalar_one_or_none()
    
        if not user:
            _register_failed_login(rate_limit_key)
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
        if not pwd_context.verify(body.password, user.password_hash):
            _register_failed_login(rate_limit_key)
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
        _clear_failed_logins(rate_limit_key)
        access_token = create_access_token(data={"sub": str(user.id)})
        return {"access_token": access_token, "token_type": "bearer"}
    finally:
        db.close()

@app.get("/me")
def me(current_user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        user = db.get(User, current_user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return {"id": user.id, "email": user.email}
    finally:
        db.close()


@app.post("/logout")
def logout(_: int = Depends(get_current_user_id)):
    return {"ok": True, "message": "Logged out"}

@app.get("/api/sm-token")
def sm_token():
    api_key = settings.speechmatics_api_key
    if not api_key:
        raise HTTPException(status_code = 500,  detail ="No speechmatics key")
    try:
        token=_create_speechmatics_rt_token(api_key)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Failed to create speechmatics JWT token")
    ttl_seconds = settings.ttl_seconds
    return {
                "token": token,
                "ttl_seconds": ttl_seconds,
                "expires_at_ms": int((time.time() + ttl_seconds) * 1000),
            }

# Keep API and static frontend in one ASGI app during migration.
# Mounting at "/" must stay after API routes so /api/* handlers win first.
app.mount("/", StaticFiles(directory=str(PROJECT_ROOT), html=True), name="frontend")

