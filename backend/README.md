# Backend Auth MVP

## Run

1. Open terminal in `backend`
2. Activate venv
3. Install deps: `pip install -r requirements.txt`
4. Run migrations: `alembic upgrade head`
5. Start API: `uvicorn app.main:app --reload`
6. In a second terminal (repo root), start frontend: `python .\dev_server.py`

## Environment (`backend/.env`)

- `DATABASE_URL`
- `SECRET_KEY`
- `ALGORITHM` (default `HS256`)
- `ACCESS_TOKEN_EXPIRE_MINUTES` (current: 7 days = `10080`)
- `LOGIN_ATTEMPT_LIMIT` (default `5`)
- `LOGIN_WINDOW_MINUTES` (default `10`)
- `CORS_ALLOW_ORIGINS` (default `*` for local dev)

## Endpoints

- `POST /register` -> create user
- `POST /login` -> issue JWT access token
- `GET /me` -> protected, returns current user
- `POST /logout` -> protected, client-side logout acknowledgment

## Frontend <-> Backend

- Frontend auth requests use backend base URL `http://127.0.0.1:8000` by default.
- Optional override in browser console:
  - `localStorage.setItem('AUTH_API_BASE', 'http://127.0.0.1:8000')`
  - reload page.

## Quick Test Checklist

1. Register new email -> `200`
2. Register same email (case-insensitive) -> `409`
3. Login valid credentials -> `200` + `access_token`
4. Login wrong password -> `401`
5. `/me` without token -> `401`
6. `/me` with token -> `200`
7. 6th failed login inside window -> `429`
