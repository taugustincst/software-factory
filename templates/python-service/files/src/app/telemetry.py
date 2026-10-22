"""OpenTelemetry tracing — vendor-neutral and OFF by default.

Tracing only starts when OTEL_EXPORTER_OTLP_ENDPOINT is set (and
OTEL_SDK_DISABLED is not true). With no OTEL_* env the app behaves exactly
as before: no SDK, no exporter, no connection attempts.

Never add request headers, bodies or other sensitive data as span
attributes — the FastAPI instrumentation only records routes, methods
and status codes by default; keep it that way.
"""

import logging

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExporter

from app.config import Settings


class TraceContextLogFilter(logging.Filter):
    """Stamp each log record with the active span's ids (or "-").

    The log format in main.py references %(trace_id)s / %(span_id)s, so a
    log line emitted while a request is being traced can be correlated
    with its trace; outside a span the fields are "-".
    """

    def filter(self, record: logging.LogRecord) -> bool:
        context = trace.get_current_span().get_span_context()
        record.trace_id = format(context.trace_id, "032x") if context.is_valid else "-"
        record.span_id = format(context.span_id, "016x") if context.is_valid else "-"
        return True


def tracing_enabled(settings: Settings) -> bool:
    return bool(settings.otel_exporter_otlp_endpoint) and not settings.otel_sdk_disabled


def otlp_traces_url(endpoint: str) -> str:
    """OTEL_EXPORTER_OTLP_ENDPOINT is a base URL; append the traces path."""
    base = endpoint.rstrip("/")
    return base if base.endswith("/v1/traces") else f"{base}/v1/traces"


def configure_telemetry(app: FastAPI, settings: Settings, *, exporter: SpanExporter | None = None) -> bool:
    """Start tracing on the app if enabled. Returns whether tracing is active.

    Tests inject an in-memory exporter to capture spans in-process; real
    runs build the OTLP/HTTP exporter from the env endpoint instead.
    """
    if settings.otel_sdk_disabled:
        return False
    if exporter is None and not tracing_enabled(settings):
        return False

    provider = TracerProvider(resource=Resource.create({"service.name": settings.otel_service_name}))
    if exporter is not None:
        provider.add_span_processor(SimpleSpanProcessor(exporter))
    else:
        endpoint = settings.otel_exporter_otlp_endpoint or ""
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=otlp_traces_url(endpoint))))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
    app.state.tracer_provider = provider
    return True
