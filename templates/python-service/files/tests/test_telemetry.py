import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.config import Settings
from app.main import create_app
from app.telemetry import TraceContextLogFilter, configure_telemetry, otlp_traces_url, tracing_enabled

def _record() -> logging.LogRecord:
    return logging.LogRecord("app", logging.INFO, __file__, 1, "hello", (), None)


def test_tracing_enabled_requires_endpoint_and_honours_disable() -> None:
    assert tracing_enabled(Settings()) is False
    assert tracing_enabled(Settings(otel_exporter_otlp_endpoint="http://127.0.0.1:4318")) is True
    assert (
        tracing_enabled(
            Settings(otel_exporter_otlp_endpoint="http://127.0.0.1:4318", otel_sdk_disabled=True)
        )
        is False
    )


def test_otlp_traces_url_appends_traces_path() -> None:
    assert otlp_traces_url("http://127.0.0.1:4318") == "http://127.0.0.1:4318/v1/traces"
    assert otlp_traces_url("http://127.0.0.1:4318/") == "http://127.0.0.1:4318/v1/traces"
    assert otlp_traces_url("http://127.0.0.1:4318/v1/traces") == "http://127.0.0.1:4318/v1/traces"


def test_log_filter_stamps_dashes_outside_a_span() -> None:
    record = _record()
    assert TraceContextLogFilter().filter(record) is True
    assert record.trace_id == "-"
    assert record.span_id == "-"


def test_log_filter_stamps_active_span_ids() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("test")
    record = _record()
    with tracer.start_as_current_span("unit-span") as span:
        TraceContextLogFilter().filter(record)
        context = span.get_span_context()
        assert record.trace_id == format(context.trace_id, "032x")
        assert record.span_id == format(context.span_id, "016x")
    provider.shutdown()


def test_app_boots_without_tracer_provider_by_default(client: TestClient) -> None:
    # No OTEL_* env: telemetry is a no-op and the app serves as before.
    assert client.get("/healthz").json() == {"status": "ok"}
    assert not hasattr(client.app.state, "tracer_provider")


def test_configure_telemetry_with_env_endpoint_builds_otlp_exporter() -> None:
    app = FastAPI()
    settings = Settings(otel_exporter_otlp_endpoint="http://127.0.0.1:4318")
    assert configure_telemetry(app, settings) is True
    assert hasattr(app.state, "tracer_provider")


def test_request_spans_are_exported_when_enabled() -> None:
    exporter = InMemorySpanExporter()
    settings = Settings(
        app_env="test",
        otel_exporter_otlp_endpoint="http://127.0.0.1:4318",
        otel_service_name="python-service-test",
    )
    app = create_app(settings, span_exporter=exporter)
    with TestClient(app, raise_server_exceptions=False) as client:
        res = client.get("/healthz")
    assert res.status_code == 200
    names = [span.name for span in exporter.get_finished_spans()]
    assert "GET /healthz" in names
