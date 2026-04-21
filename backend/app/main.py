from datetime import timedelta, datetime, timezone
from fastapi import FastAPI, HTTPException, Depends
from fastapi.security import OAuth2PasswordBearer
from passlib.context import CryptContext
from sqlalchemy import select, text
from jose import jwt, JWTError

from app.db import SessionLocal, engine
from app.models import User
from app.config import settings
from app.schemas import RegisterBody, LoginBody



app = FastAPI()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login")

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
    credentials_exception = HTTPException(status_code=401, detail="Could not validate credentials")
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
    db = SessionLocal()
    try:
        existing_user = db.execute(
            select(User).where(User.email == body.email)
        ).scalar_one_or_none()

        if existing_user:
            raise HTTPException(status_code=400, detail="Email already registered")

        user = User(
            email=body.email,
            password_hash=pwd_context.hash(body.password),
        )

        db.add(user)
        db.commit()
        db.refresh(user)

        return {"id": user.id, "email": user.email}
    finally:
        db.close()

@app.post("/login")
def login(body: LoginBody):
    db = SessionLocal()
    try:
        user = db.execute(
            select(User).where(User.email == body.email)
        ).scalar_one_or_none()
    
        if not user:
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
        if not pwd_context.verify(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Invalid email or password")
        
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