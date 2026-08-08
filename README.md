# Email Intelligence Service

Email verification and intelligence: DNS/SMTP-based mailbox
verification, evidence collection, confidence scoring, decision
policy, pattern intelligence (learned email address patterns per
domain), and an outbound-send safety boundary that only authorizes
sending to addresses this service has itself verified.

## Quick start

```
docker compose up -d postgres redis minio
npm install
npm run migrate
npm run dev
```

The API listens on `http://localhost:3001`. `GET /health` confirms
PostgreSQL/Redis/queue connectivity.

To run the async batch queue worker (separate process):

```
npm run dev:worker
```

## Key endpoints

| Endpoint | Purpose |
|---|---|
| `POST /verify` | Verify a single email synchronously |
| `POST /verify/batch` | Verify up to 100 emails synchronously |
| `POST /verify/batch/async` | Enqueue a batch; poll `GET /verify/jobs/:jobId` |
| `POST /send` | Send an email, gated on a prior verification result |
| `GET /health` / `/readiness` / `/liveness` | Health checks |
| `GET /metrics` | Prometheus metrics |

## Documentation

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for architecture,
deployment, backup/recovery, environment variables, observability,
and security operational notes.

## Testing

```
npm test        # runs against real Postgres/Redis/MinIO — start them first
npm run lint
npm run typecheck
```
