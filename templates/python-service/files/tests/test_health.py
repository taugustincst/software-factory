from fastapi.testclient import TestClient


def test_healthz_ok_with_security_headers(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
    assert res.headers["x-content-type-options"] == "nosniff"


def test_readyz(client: TestClient) -> None:
    assert client.get("/readyz").json() == {"status": "ready"}


def test_unhandled_errors_are_generic(client: TestClient) -> None:
    @client.app.get("/boom")  # type: ignore[attr-defined, untyped-decorator]
    def boom() -> None:
        raise RuntimeError("secret internals")

    res = client.get("/boom")
    assert res.status_code == 500
    assert res.json() == {"error": "internal_error"}
