import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/*
Regression test for the transactional outbox migration. The OLD
version of this file tested that POST /verify/batch/async failed fast
(HTTP 500) when enqueueing hung - that behavior, and the
enqueueWithTimeout() mechanism it tested, no longer exist: the route
does not call enqueueVerificationItem() at all anymore (see
verifyBatch.ts and src/queue/outboxDispatcher.ts). This is the
replacement: proof that the route now durably accepts a batch using
ONLY Postgres, with zero dependency on Redis/BullMQ being reachable -
this test deliberately never calls requireRedis() and never imports
anything from src/queue/, so a Redis outage cannot affect it even in
principle.
*/

import { requirePostgres } from "../testHelpers/requireInfra.js";

test.before(() => requirePostgres());

const { default: verifyBatchRoutes } = await import("./verifyBatch.js");
const { getDatabase } = await import("../database/database.js");

test("POST /verify/batch/async returns 202 promptly and durably persists job + items + outbox rows, without touching Redis", async () => {
  const app = Fastify({ logger: false });
  await app.register(verifyBatchRoutes);

  const start = Date.now();

  const res = await app.inject({
    method: "POST",
    url: "/verify/batch/async",
    payload: { emails: ["outbox-regression-test@example.com"] },
  });

  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 2_000, `expected a near-instant response (no Redis round trip), took ${elapsedMs}ms`);
  assert.equal(res.statusCode, 202);

  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  assert.equal(body.status, "PENDING");
  assert.equal(body.total, 1);
  assert.ok(body.jobId);
  assert.equal(body.statusUrl, `/verify/jobs/${body.jobId}`);

  const db = getDatabase();

  const jobRow = await db.query(`SELECT status FROM verification_jobs WHERE id = $1`, [body.jobId]);
  assert.equal(jobRow.rows[0]?.status, "PENDING", "the job must stay PENDING - the route must not call markJobRunning anymore");

  const itemRow = await db.query(
    `SELECT status, email FROM verification_job_items WHERE job_id = $1`,
    [body.jobId]
  );
  assert.equal(itemRow.rows.length, 1);
  assert.equal(itemRow.rows[0]?.status, "PENDING");
  assert.equal(itemRow.rows[0]?.email, "outbox-regression-test@example.com");

  const outboxRow = await db.query(
    `SELECT status FROM verification_outbox WHERE job_id = $1`,
    [body.jobId]
  );
  assert.equal(outboxRow.rows.length, 1, "exactly one outbox row must exist for the one email submitted");
  assert.equal(outboxRow.rows[0]?.status, "PENDING");

  await app.close();
});

test("GET /verify/jobs/:jobId reflects PENDING immediately after creation (truthful status, not a false RUNNING)", async () => {
  const app = Fastify({ logger: false });
  await app.register(verifyBatchRoutes);

  const createRes = await app.inject({
    method: "POST",
    url: "/verify/batch/async",
    payload: { emails: ["status-truthfulness-test@example.com"] },
  });

  const { jobId } = JSON.parse(createRes.body);

  const statusRes = await app.inject({
    method: "GET",
    url: `/verify/jobs/${jobId}`,
  });

  const body = JSON.parse(statusRes.body);

  assert.equal(statusRes.statusCode, 200);
  assert.equal(body.job.status, "PENDING");
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].status, "PENDING");

  await app.close();
});

test("POST /verify/batch/async still returns 400 for an invalid body (validation happens before any Postgres write)", async () => {
  const app = Fastify({ logger: false });
  await app.register(verifyBatchRoutes);

  const res = await app.inject({
    method: "POST",
    url: "/verify/batch/async",
    payload: { emails: "not-an-array" },
  });

  assert.equal(res.statusCode, 400);

  await app.close();
});

test.after(async () => {
  const { closeDatabase } = await import("../database/database.js");
  await closeDatabase();
});
