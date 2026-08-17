import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/*
warmup.ts wraps src/services/warmup/* - a deliberate scaffold (see
warmupEngine.ts's header comment and docs/EXTERNAL.md's "Warmup"
section) where every function except warmupStatus() unconditionally
throws WarmupNotImplementedError. These tests exercise the route
layer only (request validation, status-code mapping, response
shape) - they intentionally do NOT mock the warmup/* modules, so a
regression that accidentally implements a real (unsafe) send path
in POST /warmup/start without also updating this test would fail
loudly here.
*/

const { default: warmupRoutes } = await import("./warmup.js");

test("POST /warmup/start returns 501 warmup_not_implemented for a valid body (scaffold engine)", async () => {
  const app = Fastify({ logger: false });
  await app.register(warmupRoutes);

  const res = await app.inject({
    method: "POST",
    url: "/warmup/start",
    payload: { domain: "example.com", mailbox: "sales@example.com" },
  });

  assert.equal(res.statusCode, 501);
  const body = JSON.parse(res.body);
  assert.equal(body.success, false);
  assert.equal(body.domain, "example.com");
  assert.equal(body.mailbox, "sales@example.com");
  assert.equal(body.error, "warmup_not_implemented");
  assert.match(body.message, /not implemented yet/i);

  await app.close();
});

test("POST /warmup/start accepts a body without mailbox (optional field)", async () => {
  const app = Fastify({ logger: false });
  await app.register(warmupRoutes);

  const res = await app.inject({
    method: "POST",
    url: "/warmup/start",
    payload: { domain: "example.com" },
  });

  assert.equal(res.statusCode, 501);
  const body = JSON.parse(res.body);
  assert.equal(body.domain, "example.com");
  assert.equal(body.mailbox, null);

  await app.close();
});

test("POST /warmup/start returns 400 when domain is missing", async () => {
  const app = Fastify({ logger: false });
  await app.register(warmupRoutes);

  const res = await app.inject({
    method: "POST",
    url: "/warmup/start",
    payload: { mailbox: "sales@example.com" },
  });

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.success, false);

  await app.close();
});

test("POST /warmup/start returns 400 when domain is an empty string", async () => {
  const app = Fastify({ logger: false });
  await app.register(warmupRoutes);

  const res = await app.inject({
    method: "POST",
    url: "/warmup/start",
    payload: { domain: "   " },
  });

  assert.equal(res.statusCode, 400);

  await app.close();
});

test("GET /warmup/status returns the scaffold-wide status for the requested domain", async () => {
  const app = Fastify({ logger: false });
  await app.register(warmupRoutes);

  const res = await app.inject({
    method: "GET",
    url: "/warmup/status?domain=example.com",
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    success: true,
    domain: "example.com",
    enabled: false,
    phase: "scaffold",
    score: null,
    dayInProgram: null,
  });

  await app.close();
});

test("GET /warmup/status returns 400 when domain query param is missing", async () => {
  const app = Fastify({ logger: false });
  await app.register(warmupRoutes);

  const res = await app.inject({
    method: "GET",
    url: "/warmup/status",
  });

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.success, false);

  await app.close();
});
