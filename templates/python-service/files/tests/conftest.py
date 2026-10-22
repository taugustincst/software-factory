import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.config import Settings
from app.db import TaskRow, make_engine, make_session_factory
from app.main import create_app
from app.migrate import run_migrations

# Tests run against a real, ephemeral Postgres — never a SQLite substitute.
# CI provides one as a service container (DATABASE_URL); locally use
# `docker compose up -d db` (default URL in .env.example / config).
DATABASE_URL = Settings(
    database_url=os.environ.get("DATABASE_URL", "postgresql+psycopg://app:app@localhost:5432/app")
).database_url


@pytest.fixture(scope="session", autouse=True)
def _migrated_db() -> None:
    run_migrations(DATABASE_URL)


@pytest.fixture(autouse=True)
def _clean_tasks() -> None:
    engine = make_engine(DATABASE_URL)
    with make_session_factory(engine)() as session:
        session.execute(delete(TaskRow))
        session.commit()
    engine.dispose()


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app(Settings(app_env="test", database_url=DATABASE_URL))
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
