from uuid import uuid4

from fastapi.testclient import TestClient


def test_task_lifecycle(client: TestClient) -> None:
    created = client.post("/v1/tasks", json={"title": "Call back member SYN-000123"})
    assert created.status_code == 201
    task_id = created.json()["data"]["id"]

    assert client.get(f"/v1/tasks/{task_id}").json()["data"]["done"] is False

    updated = client.patch(f"/v1/tasks/{task_id}", json={"done": True})
    assert updated.json()["data"]["done"] is True

    assert len(client.get("/v1/tasks").json()["data"]) == 1
    assert client.delete(f"/v1/tasks/{task_id}").status_code == 204
    assert client.get(f"/v1/tasks/{task_id}").status_code == 404


def test_rejects_blank_title(client: TestClient) -> None:
    assert client.post("/v1/tasks", json={"title": "   "}).status_code == 422


def test_rejects_unknown_fields(client: TestClient) -> None:
    assert client.post("/v1/tasks", json={"title": "ok", "admin": True}).status_code == 422


def test_rejects_malformed_id(client: TestClient) -> None:
    assert client.get("/v1/tasks/not-a-uuid").status_code == 422


def test_unknown_ids_return_404(client: TestClient) -> None:
    missing = uuid4()
    assert client.patch(f"/v1/tasks/{missing}", json={"done": True}).status_code == 404
    assert client.delete(f"/v1/tasks/{missing}").status_code == 404
