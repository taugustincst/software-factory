"""Postgres access: SQLAlchemy 2 models and the engine/session factories.

Feature modules keep their SQL inside a store class (see app.tasks) built on
the session factory from here; routes never touch SQLAlchemy directly.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import Boolean, DateTime, Engine, String, Uuid, create_engine, func
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


def make_engine(database_url: str) -> Engine:
    """Create a Postgres engine for the given SQLAlchemy URL."""
    return create_engine(database_url, pool_pre_ping=True)


def make_session_factory(engine: Engine) -> sessionmaker[OrmSession]:
    return sessionmaker(bind=engine, expire_on_commit=False)
