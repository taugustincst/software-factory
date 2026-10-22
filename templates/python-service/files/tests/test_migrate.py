import pytest
from sqlalchemy import inspect

from app import migrate
from app.config import Settings
from app.db import make_engine
from tests.conftest import DATABASE_URL


def test_migrations_create_the_tasks_table_and_are_idempotent() -> None:
    migrate.run_migrations(DATABASE_URL)
    migrate.run_migrations(DATABASE_URL)  # second run at head is a no-op
    engine = make_engine(DATABASE_URL)
    try:
        assert "tasks" in inspect(engine).get_table_names()
    finally:
        engine.dispose()


def test_main_uses_settings_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        migrate, "get_settings", lambda: Settings(app_env="test", database_url=DATABASE_URL)
    )
    migrate.main()
