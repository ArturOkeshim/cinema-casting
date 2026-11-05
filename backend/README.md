# Backend Auth MVP

## Run (local)

1. Open terminal in `backend`
2. Activate venv
3. Install deps: `pip install -r requirements.txt`
4. Put secrets in `backend/.env` (see below)
5. Run migrations: `alembic upgrade head`
6. Start API: `uvicorn app.main:app --reload`
7. In a second terminal (repo root), start frontend: `python .\dev_server.py`

## Environment (`backend/.env`)

Required for auth:

- `DATABASE_URL` — example: `postgresql+psycopg://user:pass@localhost:5432/cinema-casting-db`
- `SECRET_KEY`

Optional:

- `ALGORITHM` (default `HS256`)
- `ACCESS_TOKEN_EXPIRE_MINUTES` (default `30`; for long sessions use e.g. `10080` = 7 days)
- `LOGIN_ATTEMPT_LIMIT` (default `5`)
- `LOGIN_WINDOW_MINUTES` (default `10`)
- `CORS_ALLOW_ORIGINS` (default `*` for local dev)
- `SPEECHMATICS_API_KEY`, `TTL_SECONDS`
- `VSEGPT_API_KEY`, `VSEGPT_BASE_URL`, `VSEGPT_MODEL`, `VSEGPT_TEMPERATURE`, `VSEGPT_MAX_TOKENS`

Alembic reads **the same** `DATABASE_URL`. Do not put DB passwords in `alembic.ini`.

## Migrations on a new Postgres (laptop or server)

Postgres itself must already exist (empty database + user with rights). Then:

```bash
cd backend
# .env already contains DATABASE_URL pointing at that database
alembic upgrade head
alembic current
```

`upgrade head` creates:

- table `users` (email, password_hash, registration_datetime)
- table `alembic_version` (Alembic remembers which migration ran last)

You do **not** create `users` by hand with SQL.

Useful checks:

- `alembic current` — which revision is applied
- `alembic history` — full chain of migrations

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
