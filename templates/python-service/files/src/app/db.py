"""Postgres access: SQLAlchemy 2 models and the engine/session factories.

Feature modules keep their SQL inside a store class (see app.tasks) built on
the session factory from here; routes never touch SQLAlchemy directly.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import Boolean, DateTime, Engine, ForeignKey, String, Uuid, create_engine, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.orm import Session as OrmSession


class Base(DeclarativeBase):
    """Declarative base; Alembic autogeneration reads metadata from here."""


class TaskRow(Base):
    """Tasks table. The row shape matches the `Task` model in app.tasks."""

    __tablename__ = "tasks"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    done: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserRow(Base):
    """Users table. Passwords are only ever stored as argon2id hashes (see app.auth)."""

    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="user", server_default="user")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SessionRow(Base):
    """Sessions table. The cookie carries a random token; only its HMAC hash is stored here."""

    __tablename__ = "sessions"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


def make_engine(database_url: str) -> Engine:
    """Create a Postgres engine for the given SQLAlchemy URL."""
    return create_engine(database_url, pool_pre_ping=True)


def make_session_factory(engine: Engine) -> sessionmaker[OrmSession]:
    return sessionmaker(bind=engine, expire_on_commit=False)
