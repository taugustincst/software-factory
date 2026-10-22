from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import update

from app.auth import PostgresAuthStore, hash_password, hash_session_token
from app.config import Settings
from app.db import UserRow, make_session_factory

PASSWORD = "correct horse battery"


def _register(client: TestClient, email: str = "Clinician@Example.org") -> object:
    return client.post("/v1/auth/register", json={"email": email, "password": PASSWORD})


def test_register_sets_httponly_cookie_and_me_works(client: TestClient) -> None:
    res = _register(client)
    assert res.status_code == 201
    assert res.json()["data"]["email"] == "clinician@example.org"
    assert res.json()["data"]["role"] == "user"
    assert "password" not in res.text
    set_cookie = res.headers["set-cookie"]
    assert set_cookie.startswith("session=")
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie

    me = client.get("/v1/me")
    assert me.status_code == 200
    assert me.json()["data"]["email"] == "clinician@example.org"


def test_rejects_duplicate_and_malformed_credentials(client: TestClient) -> None:
    assert _register(client).status_code == 201
    assert _register(client).status_code == 409
    assert (
        client.post("/v1/auth/register", json={"email": "b@example.org", "password": "short"}).status_code
        == 422
    )
    assert (
        client.post("/v1/auth/register", json={"email": "not-an-email", "password": PASSWORD}).status_code
        == 422
    )


def test_login_rejects_wrong_password_and_accepts_correct(client: TestClient) -> None:
    assert _register(client).status_code == 201
    client.post("/v1/auth/logout")

    wrong = client.post(
        "/v1/auth/login", json={"email": "clinician@example.org", "password": "wrong-password"}
    )
    assert wrong.status_code == 401
    assert wrong.json()["detail"] == "invalid_credentials"
    ghost = client.post("/v1/auth/login", json={"email": "ghost@example.org", "password": PASSWORD})
    assert ghost.status_code == 401

    ok = client.post("/v1/auth/login", json={"email": "clinician@example.org", "password": PASSWORD})
    assert ok.status_code == 200
    assert client.get("/v1/me").status_code == 200


def test_me_requires_auth_and_logout_revokes(client: TestClient) -> None:
    assert client.get("/v1/me").status_code == 401
    assert _register(client).status_code == 201
    assert client.get("/v1/me").status_code == 200
    assert client.post("/v1/auth/logout").status_code == 204
    assert client.get("/v1/me").status_code == 401


def test_expired_session_is_rejected(client: TestClient) -> None:
    settings = Settings(app_env="test")
    store = PostgresAuthStore(client.app.state.db_engine)  # type: ignore[attr-defined]
    user = store.create_user("old@example.org", hash_password(PASSWORD))
    token = "expired-token-value"
    store.create_session(
        user.id, hash_session_token(settings.session_secret, token), datetime(2000, 1, 1, tzinfo=UTC)
    )
    res = client.get("/v1/me", cookies={"session": token})
    assert res.status_code == 401


def test_login_is_rate_limited(client: TestClient) -> None:
    for _ in range(10):
        res = client.post("/v1/auth/login", json={"email": "ghost@example.org", "password": PASSWORD})
        assert res.status_code == 401
    blocked = client.post("/v1/auth/login", json={"email": "ghost@example.org", "password": PASSWORD})
    assert blocked.status_code == 429


def test_admin_route_enforces_role(client: TestClient) -> None:
    assert _register(client, "user@example.org").status_code == 201
    assert client.get("/v1/admin").status_code == 403
    client.post("/v1/auth/logout")
    assert client.get("/v1/admin").status_code == 401

    # Registration always creates role `user`; promote directly in the DB to model an admin.
    engine = client.app.state.db_engine  # type: ignore[attr-defined]
    store = PostgresAuthStore(engine)
    admin = store.create_user("admin@example.org", hash_password(PASSWORD))
    with make_session_factory(engine)() as session:
        session.execute(update(UserRow).where(UserRow.id == admin.id).values(role="admin"))
        session.commit()

    assert (
        client.post("/v1/auth/login", json={"email": "admin@example.org", "password": PASSWORD}).status_code
        == 200
    )
    res = client.get("/v1/admin")
    assert res.status_code == 200
    assert res.json()["data"]["status"] == "admin_ok"


def test_production_refuses_dev_session_secret() -> None:
    with pytest.raises(ValidationError, match="SESSION_SECRET"):
        Settings(app_env="production")
    assert (
        Settings(app_env="production", session_secret="a-real-production-secret-with-entropy").app_env
        == "production"
    )
