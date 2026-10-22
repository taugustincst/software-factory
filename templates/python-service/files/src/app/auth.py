"""Self-hosted session auth, mirroring the TS templates' pattern.

Email + password (argon2id), random session tokens in an httpOnly cookie,
sessions stored server-side so they can be revoked at logout. No third-party
identity provider. To swap in OIDC later, replace the register/login
handlers and keep the session layer.
"""

import hashlib
import hmac
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated, Protocol
from uuid import UUID, uuid4

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import Engine, delete, select

from app.config import Settings
from app.db import SessionRow, UserRow, make_session_factory

SESSION_COOKIE = "session"

Email = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, to_lower=True, max_length=254, pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$"
    ),
]
Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: Email
    password: Password


class PublicUser(BaseModel):
    id: UUID
    email: str
    role: str


class UserRecord(BaseModel):
    id: UUID
    email: str
    role: str
    password_hash: str


_hasher = PasswordHasher()  # argon2-cffi defaults to argon2id


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


_DUMMY_HASH = hash_password("timing-equalizer-not-a-real-password")


def hash_session_token(secret: str, token: str) -> str:
    """The cookie carries the raw token; the database stores only this HMAC, keyed by SESSION_SECRET."""
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()


class AuthStore(Protocol):
    """Store interface for auth. Postgres is the implementation; routes only see this contract."""

    def create_user(self, email: str, password_hash: str) -> UserRecord: ...

    def get_user_by_email(self, email: str) -> UserRecord | None: ...

    def create_session(self, user_id: UUID, token_hash: str, expires_at: datetime) -> None: ...

    def get_session_user(self, token_hash: str) -> PublicUser | None: ...

    def delete_session(self, token_hash: str) -> None: ...


def _to_record(row: UserRow) -> UserRecord:
    return UserRecord(id=row.id, email=row.email, role=row.role, password_hash=row.password_hash)


class PostgresAuthStore:
    """Postgres-backed auth store (SQLAlchemy 2). One short session per operation."""

    def __init__(self, engine: Engine) -> None:
        self._sessions = make_session_factory(engine)

    def create_user(self, email: str, password_hash: str) -> UserRecord:
        row = UserRow(id=uuid4(), email=email, password_hash=password_hash, role="user")
        with self._sessions() as session:
            session.add(row)
            session.commit()
            return _to_record(row)

    def get_user_by_email(self, email: str) -> UserRecord | None:
        with self._sessions() as session:
            row = session.scalars(select(UserRow).where(UserRow.email == email)).first()
            return _to_record(row) if row is not None else None

    def create_session(self, user_id: UUID, token_hash: str, expires_at: datetime) -> None:
        row = SessionRow(id=uuid4(), user_id=user_id, token_hash=token_hash, expires_at=expires_at)
        with self._sessions() as session:
            session.add(row)
            session.commit()

    def get_session_user(self, token_hash: str) -> PublicUser | None:
        with self._sessions() as session:
            row = session.scalars(select(SessionRow).where(SessionRow.token_hash == token_hash)).first()
            if row is None:
                return None
            if row.expires_at <= datetime.now(UTC):
                session.delete(row)
                session.commit()
                return None
            user = session.get(UserRow, row.user_id)
            if user is None:
                return None
            return PublicUser(id=user.id, email=user.email, role=user.role)

    def delete_session(self, token_hash: str) -> None:
        with self._sessions() as session:
            session.execute(delete(SessionRow).where(SessionRow.token_hash == token_hash))
            session.commit()


def get_store(request: Request) -> AuthStore:
    store: AuthStore = request.app.state.auth_store
    return store


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


Store = Annotated[AuthStore, Depends(get_store)]
AppSettings = Annotated[Settings, Depends(get_settings_dep)]
router = APIRouter(tags=["auth"])


def _start_session(store: AuthStore, settings: Settings, response: Response, user_id: UUID) -> None:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(UTC) + timedelta(hours=settings.session_ttl_hours)
    store.create_session(user_id, hash_session_token(settings.session_secret, token), expires)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=settings.session_ttl_hours * 3600,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.app_env == "production",
    )


def get_current_user(request: Request, store: Store, settings: AppSettings) -> PublicUser:
    """FastAPI dependency: resolve the session cookie to a user, or 401."""
    token = request.cookies.get(SESSION_COOKIE)
    user = store.get_session_user(hash_session_token(settings.session_secret, token)) if token else None
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
    return user


CurrentUser = Annotated[PublicUser, Depends(get_current_user)]


def require_role(role: str) -> Callable[[PublicUser], PublicUser]:
    """Dependency factory: require a role. Usage: `Annotated[PublicUser, Depends(require_role("admin"))]`."""

    def check(user: CurrentUser) -> PublicUser:
        if user.role != role:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
        return user

    return check


@router.post("/v1/auth/register", status_code=status.HTTP_201_CREATED)
def register(
    body: Credentials, store: Store, settings: AppSettings, response: Response
) -> dict[str, PublicUser]:
    if store.get_user_by_email(body.email) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email_taken")
    user = store.create_user(body.email, hash_password(body.password))
    _start_session(store, settings, response, user.id)
    return {"data": PublicUser(id=user.id, email=user.email, role=user.role)}


@router.post("/v1/auth/login")
def login(
    body: Credentials, store: Store, settings: AppSettings, response: Response
) -> dict[str, PublicUser]:
    user = store.get_user_by_email(body.email)
    # Verify against a real hash even for unknown emails, so timing does not reveal which emails exist.
    ok = verify_password(user.password_hash if user is not None else _DUMMY_HASH, body.password)
    if user is None or not ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")
    _start_session(store, settings, response, user.id)
    return {"data": PublicUser(id=user.id, email=user.email, role=user.role)}


@router.post("/v1/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, store: Store, settings: AppSettings) -> Response:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        store.delete_session(hash_session_token(settings.session_secret, token))
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(key=SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return response


# Protected example route: any signed-in user. Copy this pattern (or use
# require_role, as on /v1/admin below) to protect a real resource.
@router.get("/v1/me")
def me(user: CurrentUser) -> dict[str, PublicUser]:
    return {"data": user}


# RBAC example: only the `admin` role passes require_role("admin").
AdminUser = Annotated[PublicUser, Depends(require_role("admin"))]


@router.get("/v1/admin")
def admin(user: AdminUser) -> dict[str, object]:
    return {"data": {"status": "admin_ok", "user": user}}


# Re-exported for tests and app wiring.
__all__ = [
    "SESSION_COOKIE",
    "AuthStore",
    "Credentials",
    "CurrentUser",
    "PostgresAuthStore",
    "PublicUser",
    "get_current_user",
    "hash_password",
    "hash_session_token",
    "require_role",
    "router",
    "verify_password",
]
