/**
 * OpenTelemetry tracing — vendor-neutral and OFF by default.
 *
 * Tracing only starts when OTEL_EXPORTER_OTLP_ENDPOINT is set (and
 * OTEL_SDK_DISABLED is not "true"). With no OTEL_* env the app behaves
 * exactly as before: this module loads, detects the missing endpoint and
 * never creates an SDK, exporter or connection.
 *
 * This module must be imported before the app modules (see server.ts) so
 * the HTTP/Fastify auto-instrumentation can patch them as they load.
 * Never add request headers, bodies or other sensitive data as span
 * attributes — the instrumentations only record routes, methods and
 * status codes by default; keep it that way.
 */
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';

export interface TracingOptions {
  /** Inject an exporter (tests pass an in-memory one). Default: OTLP/HTTP built from the env endpoint. */
  exporter?: SpanExporter;
  /** Override the reported service name. Default: OTEL_SERVICE_NAME or the fallback below. */
  serviceName?: string;
  /** Environment to read OTEL_* variables from. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

const FALLBACK_SERVICE_NAME = 'node-service';

export function isTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED?.toLowerCase() === 'true') return false;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/**
 * OTEL_EXPORTER_OTLP_ENDPOINT is a base URL per the OTel spec; the traces
 * signal path is appended unless the endpoint already carries it.
 */
export function otlpTracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

/**
 * Fields that correlate a log line with the active span. The app logger
 * uses this as its pino mixin; returns an empty object when no span is
 * active (or tracing is off), so log shapes stay unchanged otherwise.
 */
export function traceLogFields(): Record<string, string> {
  const context = trace.getActiveSpan()?.spanContext();
  if (!context || context.traceId === '00000000000000000000000000000000') return {};
  return { trace_id: context.traceId, span_id: context.spanId };
}

let sdk: NodeSDK | undefined;

/**
 * Start the SDK if tracing is enabled (or an exporter was injected).
 * Returns whether tracing is active after the call. Idempotent.
 */
export function initTracing(options: TracingOptions = {}): boolean {
  if (sdk) return true;
  const env = options.env ?? process.env;
  if (env.OTEL_SDK_DISABLED?.toLowerCase() === 'true') return false;
  if (!options.exporter && !isTracingEnabled(env)) return false;

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otlpExporter = endpoint
    ? new OTLPTraceExporter({ url: otlpTracesUrl(endpoint) })
    : new OTLPTraceExporter();
  const processor = options.exporter
    ? new SimpleSpanProcessor(options.exporter)
    : new BatchSpanProcessor(otlpExporter);
  sdk = new NodeSDK({
    // Resource detection is async in NodeSDK: spans created while it runs
    // (the first moments after startup, and short-lived tests) are dropped.
    // The service name below is the resource attribute templates need.
    autoDetectResources: false,
    serviceName: options.serviceName ?? env.OTEL_SERVICE_NAME ?? FALLBACK_SERVICE_NAME,
    spanProcessors: [processor],
    instrumentations: [new HttpInstrumentation(), new FastifyOtelInstrumentation({ registerOnInitialization: true })],
  });
  sdk.start();
  return true;
}

export async function shutdownTracing(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  await current?.shutdown();
}
