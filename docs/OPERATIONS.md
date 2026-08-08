# Operations Guide

This document covers running, deploying, and operating the email
intelligence service in production. For local development setup,
see the [README](../README.md).

## Architecture

```
                    Load Balancer
                         │
                         ▼
              ┌──────────────────────┐
              │   API instance 1..N    │  (src/server.ts, stateless)
              └──────────────────────┘
                 │        │        │
                 ▼        ▼        ▼
           PostgreSQL   Redis   Object Storage
          (source of   (cache,  (S3-compatible;
           truth)      locks,    currently unused —
                       rate      see "Object storage"
                       limit,    below)
                       queue
                       backend)
                         │
                         ▼
              ┌──────────────────────┐
              │   Worker 1..N          │  (src/worker.ts, stateless)
              └──────────────────────┘
                         │
                         ▼
              Third-party SMTP/DNS servers
```

API and worker are separate processes/containers (see
`docker-compose.yml`) so each scales independently: API instances
handle HTTP traffic and enqueue async batch verification work;
worker instances consume the BullMQ-backed verification queue and
perform the actual SMTP/DNS checks. Both are stateless — all
durable state lives in PostgreSQL, all ephemeral coordination state
lives in Redis.

## Environment variables

All configuration is centralized and validated at startup in
`src/config/config.ts` — the process fails fast at boot if required
configuration is missing or malformed, rather than failing
unpredictably mid-request. See that file for the full list and
defaults. Key variables:

| Variable | Required in production | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_SSL` | No (defaults true in production) | Set `false` only for a Postgres without TLS (e.g. local Docker Compose) |
| `REDIS_URL` | Yes | Redis connection string |
| `STORAGE_ENDPOINT` / `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` / `STORAGE_BUCKET` | Only if using object storage | S3-compatible storage credentials |
| `PORT` | No (default 3001) | API listen port |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | No | Distributed rate limit tuning |
| `VERIFICATION_QUEUE_CONCURRENCY` | No (default 10) | Max concurrent SMTP connections per worker process |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | If unset, traces export to console instead of a collector |

**Never commit secrets.** `.env` is gitignored. In production, inject
these via your platform's secret manager (see "Secrets management"
below) rather than plain environment variables where possible.

## Database

### Migrations

Migrations live in `src/db/migrations/*.sql` and run automatically
on process startup (both API and worker), guarded by a PostgreSQL
advisory lock so concurrent instances starting simultaneously don't
race to apply the same migration. Run them explicitly (e.g. as a
pre-deploy step) with:

```
npm run migrate
```

Migrations are forward-only. There is no automatic rollback — write
new migrations to correct a bad one rather than editing history, and
always test a migration against a copy of production data before
applying it there.

### Backup strategy

Application code is not a backup system. In production, PostgreSQL
backups must be provided by the hosting platform:

- **Managed PostgreSQL (RDS, Cloud SQL, Supabase, etc.):** enable
  automated daily snapshots with point-in-time recovery (PITR) via
  WAL archiving. Retention: minimum 7 days for standard operation,
  30 days recommended given this service is a system of record for
  verification history. Point-in-time recovery is what actually
  matters here — a nightly snapshot alone loses up to 24h of
  verification results and evidence.
- **Self-managed PostgreSQL:** configure `pg_basebackup` + continuous
  WAL archiving to object storage (a natural use for the
  `StorageProvider` abstraction in `src/storage/`), or use a tool
  like `pgBackRest` / `wal-g`.

**Restore process:**

1. Provision a new PostgreSQL instance (or use the platform's
   point-in-time restore).
2. Restore the base backup + replay WAL to the desired point in
   time.
3. Point a single instance's `DATABASE_URL` at the restored database
   and run `npm run migrate` to confirm schema state matches the
   application's expectations before repointing traffic.
4. Repoint `DATABASE_URL` for all API/worker instances and restart.

**What is NOT backed up by this strategy, and why that's acceptable:**
Redis holds only ephemeral state (rate-limit counters, distributed
locks, idempotency markers, the BullMQ queue). If Redis data is
lost, in-flight queue jobs are lost, but the durable job/item records
in `verification_jobs`/`verification_job_items` (PostgreSQL) survive
and can be used to detect and re-enqueue stuck jobs — no business
data is lost, only in-flight async work needs to be resubmitted.

### Migration recovery

If a migration fails partway through, it runs inside a transaction
(see `src/database/migrations.ts`), so a failure rolls back
completely — the `migrations` tracking table will not record it as
applied, and it's safe to fix the SQL and retry. If a migration
fails *after* commit due to an application bug discovered later,
write a new forward migration to correct it; do not edit an already-
applied migration file.

## Object storage

`src/storage/storageProvider.ts` provides a tenant-isolated,
size/content-type-validated S3-compatible storage abstraction
(works against real S3 or MinIO). As of this writing, no feature in
this service actually produces large files (no CSV import/export, no
report generation), so nothing calls it yet — it exists so a future
large-artifact feature has a safe boundary to use rather than reaching
for the filesystem or PostgreSQL. If your deployment doesn't need it,
`STORAGE_*` configuration can be left at defaults; the storage health
check is informational only and does not affect `/readiness`.

## Horizontal scaling

- **API instances:** stateless; scale by running more replicas
  behind a load balancer. Rate limiting is Redis-backed so limits
  apply across all instances, not per-instance.
- **Worker instances:** stateless; scale by running more replicas.
  BullMQ handles work distribution across worker processes — jobs
  are claimed exclusively (no duplicate processing), retried with
  exponential backoff on failure, and recovered automatically if a
  worker process dies mid-job (stalled-job detection via BullMQ's
  lock renewal).
- **Migrations:** protected by a PostgreSQL advisory lock, safe for
  concurrent instances to attempt simultaneously during a deploy.

## Health checks

- `GET /liveness` — process is running. Never checks dependencies;
  an infrastructure outage must not cause an orchestrator to kill an
  otherwise-healthy process.
- `GET /readiness` — checks PostgreSQL, Redis, and queue
  reachability. Returns 503 if any are unreachable; use this for
  load balancer health checks so traffic isn't routed to an instance
  that can't actually serve requests.
- `GET /health` — human-readable combined status, includes storage
  as informational (non-gating).
- `GET /metrics` — Prometheus scrape endpoint.

## Observability

- **Logs:** structured JSON (pino), correlation ID (`x-request-id`)
  on every request, propagated to the response header. Sensitive
  fields (auth headers, secrets) are redacted — see
  `LOG_REDACT_PATHS` in `src/config/config.ts`.
- **Metrics:** Prometheus format at `/metrics` — HTTP request
  duration/count, verification duration/outcome, queue job
  duration/outcome, queue depth, rate-limit hits, provider failures.
- **Traces:** OpenTelemetry, auto-instrumenting HTTP/PostgreSQL/
  Redis. Exports to an OTLP collector if `OTEL_EXPORTER_OTLP_ENDPOINT`
  is set, otherwise to console (local dev only — very verbose, not
  suitable for production without a real collector configured).

## Security operational notes

- Rate limiting is Redis-backed (distributed across instances) — see
  `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`.
- An SSRF guard (`src/services/ssrfGuard.ts`) validates every SMTP
  connection target against private/loopback/link-local/cloud-
  metadata address ranges before connecting, resolving to a pinned
  IP to prevent DNS-rebinding bypass. This applies uniformly to both
  the live verification path (MX-resolved hosts) and the debug
  `/smtp/verify` endpoint (client-supplied host).
- The `/send` endpoint requires a `verificationId` and looks up the
  server-persisted verification record — it never trusts a client-
  supplied verification/authorization claim.
- **No authentication is implemented on any endpoint.** This is a
  deliberate scope boundary, not an oversight: there's no existing
  auth pattern in this codebase to extend, and this service may sit
  behind a gateway or on a private network in its actual deployment
  — a decision this document can't make. Before exposing this
  service beyond a trusted network, add authentication appropriate
  to your deployment (API gateway, mTLS, or an API-key layer).

## Local development

```
docker compose up -d postgres redis minio   # infrastructure only
npm install
npm run migrate
npm run dev            # API, with hot reload
npm run dev:worker      # worker, in a separate terminal
```

Or run everything (including the app) in containers:

```
docker compose up -d --build
```

## Testing

```
npm test
```

Runs against real PostgreSQL, Redis, and MinIO (started via
`docker compose up -d postgres redis minio` — see CI config in
`.github/workflows/ci.yml` for the equivalent GitHub Actions
services). This is deliberate: PostgreSQL-shaped concurrency and
transaction behavior is not meaningfully tested against SQLite, so
the test environment uses the same infrastructure classes as
production rather than mocks.
