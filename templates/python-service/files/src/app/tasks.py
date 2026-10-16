"""Example resource showing the patterns to follow: strict models, a store, thin handlers."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

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


class TaskStore:
    """In-memory store. Replace with a database repository behind the same methods."""

    def __init__(self) -> None:
        self._tasks: dict[UUID, Task] = {}

    def list(self) -> list[Task]:
        return list(self._tasks.values())

    def get(self, task_id: UUID) -> Task | None:
        return self._tasks.get(task_id)

    def create(self, data: TaskCreate) -> Task:
        task = Task(id=uuid4(), title=data.title, done=data.done)
        self._tasks[task.id] = task
        return task

    def update(self, task_id: UUID, patch: TaskUpdate) -> Task | None:
        current = self._tasks.get(task_id)
        if current is None:
            return None
        updated = current.model_copy(update=patch.model_dump(exclude_none=True))
        self._tasks[task_id] = updated
        return updated

    def delete(self, task_id: UUID) -> bool:
        return self._tasks.pop(task_id, None) is not None


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
