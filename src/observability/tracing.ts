/*
==================================================
OPENTELEMETRY TRACING
==================================================

CRITICAL: this module must be the FIRST import in
any process entry point (server.ts, worker.ts).
Auto-instrumentation patches modules (pg, ioredis,
http, fastify) at load time — if those modules are
imported before this file runs, they won't be
traced.

Traces:

    API request -> service -> Postgres/Redis -> queue
                                                    -> worker -> provider

Trace context propagates across the queue boundary
via the job payload's traceparent field (see
queue/verificationQueue.ts), so a batch verification
request's trace continues into the worker process
that actually performs the SMTP check.

Exports to an OTLP collector if OTEL_EXPORTER_OTLP_ENDPOINT
is configured; otherwise exports to the console so
tracing is still inspectable in local development
without standing up a collector.
==================================================
*/

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const serviceName =
  process.env.OTEL_SERVICE_NAME ?? "email-intelligence-service";

const tracingEnabled =
  process.env.TRACING_ENABLED !== "false";

let sdk: NodeSDK | null = null;

if (tracingEnabled) {

  const exporter =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OTLPTraceExporter({
          url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
        })
      : new ConsoleSpanExporter();

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // The fs instrumentation is extremely noisy (every read of
        // the migrations directory, every log write) and rarely
        // useful for a service this size.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    console.log(
      `[Tracing] OpenTelemetry started (exporter: ${
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? "OTLP" : "console"
      })`
    );
  } catch (error) {
    console.error("[Tracing] Failed to start OpenTelemetry SDK:", error);
  }

}

export async function shutdownTracing(): Promise<void> {

  if (sdk) {
    await sdk.shutdown();
  }

}
