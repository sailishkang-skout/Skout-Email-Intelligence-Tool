# Interop with Skout Backend's canonical Evidence Ledger

Skout AI Backend's Enterprise Completion Plan (§5.3) describes one canonical, workspace-scoped
`evidence_ledger` table meant to eventually be the single "why do we believe this fact" record
across the platform, explicitly naming this repo's own `evidenceLedger`/`evidenceCollector`/
`evidenceWeighting` pipeline as one of three parallel mechanisms it should interoperate with (the
other two being apps/crm's `fieldSources` column and `next_best_action_suggestions`' acceptance
tracking).

## What this repo's evidence ledger is, and stays

This service's `evidence_ledger` (`src/services/evidenceLedger.ts`) is a real, independently
useful table in this service's **own** Postgres database — recording raw SMTP/DNS/catch-all/
pattern verification observations for arbitrary email addresses. It has no `workspaceId` (or any
CRM-entity) concept in its data model: this service verifies emails, full stop, whether or not
the caller is Skout's own product. That is a genuine, deliberate architectural boundary (see this
service's own repeated "does NOT calculate confidence / make decisions / recommend sending"
comments throughout `evidenceLedger.ts`, `evidenceCollector.ts`, `evidenceWeighting.ts`) — not a
gap to "fix" by bolting workspace scoping onto it.

## Where the interop actually lives

Skout AI Backend (`Skout AI Backend/apps/api`) is the only caller of this service that has
workspace/CRM-entity context (this service is explicitly "separate from the Skout API; Skout and
n8n call it as a service" — see this repo's own README). So the dual-write into the canonical
`evidence_ledger` happens on **that** side, not this one:

`Skout AI Backend/apps/api/src/services/email-verification.service.ts`'s `verifyList()` — the
one place that already has both this service's verdict (via `verifyEmailAsVerdict()` in
`email-intel.service.ts`) and the calling workspace/prospect context — records a
`email_deliverability` evidence row (source `"email_intelligence_tool"`, confidence derived from
`sendEligibility.decisionConfidence`) into the canonical ledger after every list verification.

This was a deliberate choice over having this service make a new outbound HTTP call back into
Skout AI Backend's `POST /api/v1/evidence`: that would add a new cross-service auth surface to a
service that today only serves stateless verification requests (no notion of a Skout session/
workspace token to authenticate that call with), for no benefit over doing it at the one place
that already has everything needed. See `docs/adr/0003-read-model-exceptions.md` in the backend
repo for the same "avoid a new cross-service hop when an existing call site already has the
needed context" reasoning applied elsewhere in this platform.

## What's still not done

- Only `verifyList()`'s dual-write is wired. `discoverEmail`/`generatePatterns` results (this
  service's `/email-discovery` and `/patterns` endpoints) are not yet dual-written — their
  backend caller (`discover-email.service.ts`) doesn't currently thread workspace/prospect
  context through to where the upstream call happens; wiring that is tracked follow-up, not done
  here.
- This service's own `evidence_ledger` is not backfilled into the canonical one, and there's no
  plan to do that retroactively — only new verifications from the point this shipped are
  dual-written.
