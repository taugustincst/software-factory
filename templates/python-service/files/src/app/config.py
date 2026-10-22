"""Configuration from environment variables, validated once at startup."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    cors_origins: list[str] = Field(default_factory=list)
    # Local default matches docker-compose.yml; CI and production set DATABASE_URL explicitly.
    database_url: str = "postgresql+psycopg://app:app@localhost:5432/app"

    @field_validator("database_url", mode="after")
    @classmethod
    def _use_psycopg_driver(cls, value: str) -> str:
        # Providers hand out postgres:// or postgresql:// URLs; SQLAlchemy
        # needs the explicit psycopg (v3) driver qualifier.
        for prefix in ("postgresql://", "postgres://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value[len(prefix) :]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
