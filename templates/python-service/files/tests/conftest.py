from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app(Settings(app_env="test"))
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
