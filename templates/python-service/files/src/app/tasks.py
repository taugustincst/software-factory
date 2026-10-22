"""Example resource showing the patterns to follow: strict models, a store, thin handlers."""

from datetime import UTC, datetime
from typing import Annotated, Protocol
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import Engine, select

from app.db import TaskRow, make_session_factory

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title
    done: bool = False


class TaskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title | None = None
    done: bool | None = None


class Task(BaseModel):
    id: UUID
    title: str
    done: bool
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TaskStore(Protocol):
    """Store interface for tasks. Postgres is the implementation; routes only see this contract."""

    def list(self) -> list[Task]: ...

    def get(self, task_id: UUID) -> Task | None: ...

    def create(self, data: TaskCreate) -> Task: ...

    def update(self, task_id: UUID, patch: TaskUpdate) -> Task | None: ...

    def delete(self, task_id: UUID) -> bool: ...


def _to_task(row: TaskRow) -> Task:
    return Task(id=row.id, title=row.title, done=row.done, created_at=row.created_at)


class PostgresTaskStore:
    """Postgres-backed store (SQLAlchemy 2). One short session per operation."""

    def __init__(self, engine: Engine) -> None:
        self._sessions = make_session_factory(engine)

    def list(self) -> list[Task]:
        with self._sessions() as session:
            rows = session.scalars(select(TaskRow).order_by(TaskRow.created_at, TaskRow.id)).all()
            return [_to_task(row) for row in rows]

    def get(self, task_id: UUID) -> Task | None:
        with self._sessions() as session:
            row = session.get(TaskRow, task_id)
            return _to_task(row) if row is not None else None

    def create(self, data: TaskCreate) -> Task:
        row = TaskRow(id=uuid4(), title=data.title, done=data.done, created_at=datetime.now(UTC))
        with self._sessions() as session:
            session.add(row)
            session.commit()
            return _to_task(row)

    def update(self, task_id: UUID, patch: TaskUpdate) -> Task | None:
        with self._sessions() as session:
            row = session.get(TaskRow, task_id)
            if row is None:
                return None
            for key, value in patch.model_dump(exclude_none=True).items():
                setattr(row, key, value)
            session.commit()
            return _to_task(row)

    def delete(self, task_id: UUID) -> bool:
        with self._sessions() as session:
            row = session.get(TaskRow, task_id)
            if row is None:
                return False
            session.delete(row)
            session.commit()
            return True


def get_store(request: Request) -> TaskStore:
    store: TaskStore = request.app.state.task_store
    return store


Store = Annotated[TaskStore, Depends(get_store)]
router = APIRouter(prefix="/v1/tasks", tags=["tasks"])


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not_found")


@router.get("")
def list_tasks(store: Store) -> dict[str, list[Task]]:
    return {"data": store.list()}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_task(body: TaskCreate, store: Store) -> dict[str, Task]:
    return {"data": store.create(body)}


@router.get("/{task_id}")
def get_task(task_id: UUID, store: Store) -> dict[str, Task]:
    task = store.get(task_id)
    if task is None:
        raise _not_found()
    return {"data": task}


@router.patch("/{task_id}")
def update_task(task_id: UUID, body: TaskUpdate, store: Store) -> dict[str, Task]:
    task = store.update(task_id, body)
    if task is None:
        raise _not_found()
    return {"data": task}


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: UUID, store: Store) -> Response:
    if not store.delete(task_id):
        raise _not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
