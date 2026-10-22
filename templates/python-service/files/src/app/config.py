"""Configuration from environment variables, validated once at startup."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Dev-only default for SESSION_SECRET. Production refuses to start with it (see below).
DEV_SESSION_SECRET = "dev-only-session-secret-change-me"  # noqa: S105 — public dev default; production refuses it (see Settings)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    cors_origins: list[str] = Field(default_factory=list)
    # Keys the HMAC of stored session tokens. Set a real random secret (>= 32 chars) in production.
    session_secret: str = Field(default=DEV_SESSION_SECRET, min_length=16)
    session_ttl_hours: int = Field(default=24 * 7, gt=0, le=24 * 90)
    # Local default matches docker-compose.yml; CI and production set DATABASE_URL explicitly.
    database_url: str = "postgresql+psycopg://app:app@localhost:5432/app"
    # OpenTelemetry tracing is OFF unless an OTLP endpoint is set (see app/telemetry.py).
    # Env names follow the OTel spec: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME,
    # OTEL_SDK_DISABLED — pydantic maps the field names below onto them.
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "python-service"
    otel_sdk_disabled: bool = False

    @field_validator("database_url", mode="after")
    @classmethod
    def _use_psycopg_driver(cls, value: str) -> str:
        # Providers hand out postgres:// or postgresql:// URLs; SQLAlchemy
        # needs the explicit psycopg (v3) driver qualifier.
        for prefix in ("postgresql://", "postgres://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value[len(prefix) :]
        return value

    @model_validator(mode="after")
    def _refuse_dev_secret_in_production(self) -> "Settings":
        if self.app_env == "production" and self.session_secret == DEV_SESSION_SECRET:
            msg = "SESSION_SECRET must be set to a real secret in production (the dev default is public)"
            raise ValueError(msg)
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
