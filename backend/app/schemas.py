from pydantic import BaseModel, EmailStr, field_validator

class RegisterBody(BaseModel):
    email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def validate_password(cls, value:str) -> str:
        if len(value) <8:
            raise ValueError("Password must be at least 8 characters")
        if not any(ch.isdigit() for ch in value):
            raise ValueError("Password must contain at least one digit")
        return value

class LoginBody(BaseModel):
    email: EmailStr
    password: str