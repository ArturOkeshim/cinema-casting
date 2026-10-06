from pydantic import BaseModel, EmailStr, field_validator

class RegisterBody(BaseModel):
    email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def validate_password(cls, value:str) -> str:
        if len(value) < 8:
            raise ValueError("Пароль должен быть не короче 8 символов.")
        if len(value.encode("utf-8")) > 72:
            # bcrypt хранит только первые 72 байта. Длиннее — лучше отказать, чем обрезать пароль молча.
            raise ValueError("Пароль должен быть не длиннее 72 символов.")
        if not any(ch.isdigit() for ch in value):
            raise ValueError("Пароль должен содержать хотя бы одну цифру.")
        return value

class LoginBody(BaseModel):
    email: EmailStr
    password: str