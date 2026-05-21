import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | null = null;

export async function initTracing(): Promise<void> {
  const enabled = process.env.OTEL_ENABLED === "1" || Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!enabled || sdk) return;

  const baseEndpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318").replace(/\/$/, "");
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? `${baseEndpoint}/v1/traces`;

  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: tracesEndpoint }),
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  await sdk.start();
  // console.* is intentional here: tracing starts before Fastify's logger exists.
  // eslint-disable-next-line no-console
  console.log(`[novamem] OpenTelemetry tracing enabled: ${tracesEndpoint}`);
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
}

export function tracer() {
  return trace.getTracer("novamem-server");
}

export async function traceAsync<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    const started = performance.now();
    try {
      const result = await fn(span);
      span.setAttribute("duration_ms", Math.round(performance.now() - started));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
