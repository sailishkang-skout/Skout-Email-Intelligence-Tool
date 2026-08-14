# Email Intelligence — external access (n8n, scripts, partners)

The verification engine is a **separate microservice**. Skout Backend talks to it on the private CloudMap name. External tools should **not** need VPC access.

## Live addresses (SkoutDev)

| Where | URL |
| --- | --- |
| Public proxy (use this) | `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1/email-intel/verify` |
| Internal (ECS only) | `http://email-intel.skoutdev.local:3001/verify` |
| Local | `http://127.0.0.1:3010/verify` |

Health (internal / local): `GET /health`, `GET /liveness`.

## Auth

### From the Skout product (browser)

Clerk session as usual — `POST /api/v1/email-intel/verify` with the workspace bearer token.

### From n8n / other tools

Send a static key (no Clerk):

```
POST https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1/email-intel/verify
Content-Type: application/json
x-api-key: <EMAIL_INTEL_EXTERNAL_API_KEY>
```

```json
{ "email": "sailish@skoutai.io" }
```

Optional: `Authorization: Bearer <EMAIL_INTEL_EXTERNAL_API_KEY>`.

Set `EMAIL_INTEL_EXTERNAL_API_KEY` on the Skout API task (Secrets Manager). If unset, only logged-in product users can call the proxy.

If you call the microservice **directly** (local or future public ALB), set `API_KEY` / `EMAIL_INTEL_API_KEY` on that service. `/health` stays open.

## n8n HTTP Request node

1. Method `POST`, URL = public proxy above.
2. Header `x-api-key` = the key Neeraj issues.
3. JSON body `{{ { "email": $json.email } }}`.
4. Map `verificationStatus.status`, `sendEligibility.allowed`, `sendEligibility.decision`, `confidence` / `decisionConfidence`.

A successful verified mailbox looks like:

- `verificationStatus.status`: `VERIFIED`
- `sendEligibility.allowed`: `true`
- `sendEligibility.decision`: `USE_EMAIL` / `SAFE_TO_SEND`

## Other proxy routes

- `POST /api/v1/email-intel/verify/batch` `{ "emails": ["a@x.com"] }`
- `POST /api/v1/email-intel/discover` `{ "firstName", "lastName?", "domain" }`
- `POST /api/v1/email-intel/patterns` `{ "firstName", "lastName", "domain" }`

## Warmup

Folder `src/services/warmup/` is scaffold only (not sending mail yet). Verification stays independent so early customers can use email intel as a free add-on without warmup.
