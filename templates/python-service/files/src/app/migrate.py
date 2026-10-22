"""Apply every committed Alembic migration, then exit.

This is the `db-migrate` console script (the Python equivalent of the TS
templates' `db:migrate` npm script) and the test suite's migration entry
point. Migrations are plain revisions under ./alembic/versions, generated
with `uv run alembic revision --autogenerate -m "<change>"`.
"""

from pathlib import Path

from alembic import command
from alembic.config import Config

from app.config import Settings, get_settings


def alembic_config(database_url: str) -> Config:
    root = Path(__file__).resolve().parents[2]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.attributes["database_url"] = database_url
    return cfg


def run_migrations(database_url: str) -> None:
    # Route the URL through Settings so the driver normalization in
    # app.config (postgres:// -> postgresql+psycopg://) always applies,
    # whoever the caller is (CLI, test suite, factory smoke).
    normalized = Settings(database_url=database_url).database_url
    command.upgrade(alembic_config(normalized), "head")


def main() -> None:
    run_migrations(get_settings().database_url)


if __name__ == "__main__":
    main()
