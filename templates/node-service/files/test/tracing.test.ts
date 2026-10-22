import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAuthStore } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createDb, type DbHandle } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { PostgresTaskStore } from '../src/tasks.js';
import { initTracing, isTracingEnabled, otlpTracesUrl, shutdownTracing, traceLogFields } from '../src/tracing.js';

// Same real-Postgres rule as the other suites: CI service container or local Compose DB.
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://app:app@127.0.0.1:5432/app';

let handle: DbHandle;

beforeAll(async () => {
  handle = createDb(databaseUrl);
  await runMigrations(handle);
});

afterAll(async () => {
  await shutdownTracing();
  await handle.close();
});

describe('tracing enablement (off by default)', () => {
  it('requires an OTLP endpoint and honours OTEL_SDK_DISABLED', () => {
    expect(isTracingEnabled({})).toBe(false);
    expect(isTracingEnabled({ OTEL_SDK_DISABLED: 'true' })).toBe(false);
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })).toBe(true);
    expect(
      isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_SDK_DISABLED: 'true' }),
    ).toBe(false);
    expect(
      isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_SDK_DISABLED: 'false' }),
    ).toBe(true);
  });

  it('does not start the SDK without an endpoint, or when disabled', () => {
    expect(initTracing({ env: {} })).toBe(false);
    expect(
      initTracing({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_SDK_DISABLED: 'true' } }),
    ).toBe(false);
  });

  it('app boots and serves with tracing unset (no OTel env)', async () => {
    const { buildApp } = await import('../src/app.js');
    const app = buildApp(loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test', DATABASE_URL: databaseUrl }), {
      store: new PostgresTaskStore(handle.db),
      authStore: new PostgresAuthStore(handle.db),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('otlpTracesUrl', () => {
  it('appends the traces path to a base endpoint', () => {
    expect(otlpTracesUrl('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318/v1/traces');
    expect(otlpTracesUrl('http://127.0.0.1:4318/')).toBe('http://127.0.0.1:4318/v1/traces');
    expect(otlpTracesUrl('http://127.0.0.1:4318/v1/traces')).toBe('http://127.0.0.1:4318/v1/traces');
  });
});

describe('traceLogFields', () => {
  it('is empty when no span is active', () => {
    expect(traceLogFields()).toEqual({});
  });
});

describe('initTracing with an injected exporter', () => {
  it('exports spans and correlates trace ids into log fields', async () => {
    const exporter = new InMemorySpanExporter();
    expect(initTracing({ exporter, env: {}, serviceName: 'node-service-test' })).toBe(true);
    // Idempotent: a second call keeps the running SDK.
    expect(initTracing({ exporter, env: {} })).toBe(true);

    const tracer = trace.getTracer('tracing-test');
    const fields = tracer.startActiveSpan('unit-span', (span) => {
      const inside = traceLogFields();
      span.end();
      return inside;
    });

    const finished = exporter.getFinishedSpans();
    expect(finished.map((s) => s.name)).toContain('unit-span');
    const exported = finished.find((s) => s.name === 'unit-span');
    expect(fields).toEqual({ trace_id: exported?.spanContext().traceId, span_id: exported?.spanContext().spanId });
    await shutdownTracing();
  });

  it('starts with an env endpoint (OTLP exporter) and shuts down cleanly', async () => {
    expect(initTracing({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' } })).toBe(true);
    await shutdownTracing();
  });
});
