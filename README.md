# Skout Email Intelligence

SMTP / MX / catch-all verification, pattern ranking, and send-eligibility. Separate from the Skout API; Skout and n8n call it as a service.

- Local: `PORT=3010 npm run dev` → http://127.0.0.1:3010
- Dev (internal): `http://email-intel.skoutdev.local:3001`
- Dev (public): `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1/email-intel/verify`

See [docs/EXTERNAL.md](docs/EXTERNAL.md) for n8n, API keys, and warmup notes.
