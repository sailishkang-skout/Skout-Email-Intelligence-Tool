import { z } from "zod";

/*
==================================================
CENTRALIZED APPLICATION CONFIGURATION
==================================================

Purpose:

Single source of truth for all environment-derived
configuration. Nothing else in the codebase should
read process.env directly (aside from this file and
the small number of framework bootstrap files that
need PORT before config can be validated).

Validated once at import time. If required
configuration is missing or malformed in production,
the process must fail fast at startup rather than
fail unpredictably mid-request.
==================================================
*/

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

/*
==================================================
BOOLEAN ENV PARSING
==================================================

zod's z.coerce.boolean() just does Boolean(value),
so the string "false" — like any non-empty string —
coerces to true. Env vars are always strings, so
that footgun would silently ignore every "false"
value coming from the environment. Parse explicitly
instead.
==================================================
*/

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "string") return value.trim().toLowerCase() === "true";
    return Boolean(value);
  }, z.boolean());
}

/*
==================================================
SCHEMA
==================================================
*/

const ConfigSchema = z.object({
  nodeEnv: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),

  server: z.object({
    port: z.coerce.number().int().positive().default(3001),
    host: z.string().default("0.0.0.0"),
    bodyLimitBytes: z.coerce.number().int().positive().default(1024 * 1024),
  }),

  database: z.object({
    url: z.string().min(1, "DATABASE_URL is required"),
    poolMax: z.coerce.number().int().positive().default(10),
    idleTimeoutMs: z.coerce.number().int().positive().default(30_000),
    connectionTimeoutMs: z.coerce.number().int().positive().default(10_000),
    ssl: booleanEnv(isProduction),
  }),

  redis: z.object({
    url: z.string().min(1, "REDIS_URL is required"),
    connectTimeoutMs: z.coerce.number().int().positive().default(10_000),
    maxRetriesPerRequest: z.coerce.number().int().nonnegative().default(3),
  }),

  storage: z.object({
    endpoint: z.string().optional(),
    region: z.string().default("us-east-1"),
    bucket: z.string().default("email-intelligence-artifacts"),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    forcePathStyle: booleanEnv(true),
    signedUrlTtlSeconds: z.coerce.number().int().positive().default(900),
    maxUploadBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024), // 50MB
  }),

  rateLimit: z.object({
    max: z.coerce.number().int().positive().default(120),
    windowMs: z.coerce.number().int().positive().default(60_000),
  }),

  verification: z.object({
    ttlDays: z.coerce.number().int().positive().default(30),
    retryQueueConcurrency: z.coerce.number().int().positive().default(10),
    maxBatchSize: z.coerce.number().int().positive().default(100),
  }),

  observability: z.object({
    otlpEndpoint: z.string().optional(),
    serviceName: z.string().default("email-intelligence-service"),
    metricsEnabled: booleanEnv(true),
    tracingEnabled: booleanEnv(true),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/*
==================================================
SECRET-BEARING KEYS
==================================================

Used by the logging redaction helper below. Never
log these values, even at debug level.
==================================================
*/

const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_ACCESS_KEY_ID",
];

/*
==================================================
LOAD + VALIDATE
==================================================
*/

function loadConfig(): AppConfig {
  const raw = {
    nodeEnv: process.env.NODE_ENV,

    server: {
      port: process.env.PORT,
      host: process.env.HOST,
      bodyLimitBytes: process.env.BODY_LIMIT_BYTES,
    },

    database: {
      url:
        process.env.DATABASE_URL ??
        // Sensible local default matching docker-compose.yml so
        // `npm run dev` works out of the box after `docker compose up`.
        (!isProduction
          ? "postgres://email_intel:email_intel_dev_password@localhost:5432/email_intelligence"
          : undefined),
      poolMax: process.env.DATABASE_POOL_MAX,
      idleTimeoutMs: process.env.DATABASE_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: process.env.DATABASE_CONNECTION_TIMEOUT_MS,
      ssl: process.env.DATABASE_SSL,
    },

    redis: {
      url: process.env.REDIS_URL ?? (!isProduction ? "redis://localhost:6379" : undefined),
      connectTimeoutMs: process.env.REDIS_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: process.env.REDIS_MAX_RETRIES_PER_REQUEST,
    },

    storage: {
      endpoint:
        process.env.STORAGE_ENDPOINT ??
        (!isProduction ? "http://localhost:9000" : undefined),
      region: process.env.STORAGE_REGION,
      bucket: process.env.STORAGE_BUCKET,
      accessKeyId:
        process.env.STORAGE_ACCESS_KEY_ID ??
        (!isProduction ? "minioadmin" : undefined),
      secretAccessKey:
        process.env.STORAGE_SECRET_ACCESS_KEY ??
        (!isProduction ? "minioadmin123" : undefined),
      forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE,
      signedUrlTtlSeconds: process.env.STORAGE_SIGNED_URL_TTL_SECONDS,
      maxUploadBytes: process.env.STORAGE_MAX_UPLOAD_BYTES,
    },

    rateLimit: {
      max: process.env.RATE_LIMIT_MAX,
      windowMs: process.env.RATE_LIMIT_WINDOW_MS,
    },

    verification: {
      ttlDays: process.env.VERIFICATION_TTL_DAYS,
      retryQueueConcurrency: process.env.VERIFICATION_QUEUE_CONCURRENCY,
      maxBatchSize: process.env.VERIFICATION_MAX_BATCH_SIZE,
    },

    observability: {
      otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: process.env.OTEL_SERVICE_NAME,
      metricsEnabled: process.env.METRICS_ENABLED,
      tracingEnabled: process.env.TRACING_ENABLED,
    },
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    console.error(
      "[Config] Invalid configuration:",
      result.error.flatten()
    );

    throw new Error(
      `Invalid application configuration: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }

  return result.data;
}

export const config: AppConfig = loadConfig();

/*
==================================================
LOGGING REDACTION
==================================================

Fastify's pino logger config uses this to ensure
secret-bearing fields are never written to logs,
even if a request/response object happens to
contain them.
==================================================
*/

export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  ...SECRET_ENV_KEYS.map((key) => `env.${key}`),
];

export function isProductionEnv(): boolean {
  return config.nodeEnv === "production";
}

export function isTestEnv(): boolean {
  return config.nodeEnv === "test" || isTest;
}
