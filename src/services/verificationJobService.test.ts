import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
Regression tests for a real connection-leak class of bug found during
a production-hardening audit: several transaction helpers only
released their checked-out Postgres client on the SUCCESS path (or
relied on a `finally` that, while technically leak-free per JS
semantics, silently returned a possibly-corrupted connection to the
pool instead of destroying it). Confirmed live earlier this session:
a failing assertion between claiming an outbox transaction and
releasing it left real Postgres connections "idle in transaction" for
HOURS, eventually exhausting the pool.

These tests use a fake PoolClient (no real Postgres needed) so the
exact failure conditions - COMMIT/ROLLBACK/BEGIN/SELECT itself
rejecting - can be triggered deterministically.
*/

interface FakeClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: (error?: unknown) => void;
  releasedWith: () => "not-released" | "released-clean" | Error;
}

function createFakeClient(failing: Record<string, boolean> = {}): FakeClient {
  let released: "not-released" | "released-clean" | Error = "not-released";

  return {
    query: async (sql: string) => {
      const keyword = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
      if (failing[keyword]) {
        throw new Error(`${keyword} failed`);
      }
      return { rows: [] };
    },
    release: (error?: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      released = error ? (error instanceof Error ? error : new Error(String(error))) : "released-clean";
    },
    releasedWith: () => released,
  };
}

let fakeClient: FakeClient;

mock.module("../database/database.js", {
  namedExports: {
    getDatabase: () => ({
      connect: async () => fakeClient,
      query: async () => ({ rows: [] }),
    }),
  },
});

const {
  claimPendingOutboxRows,
  commitOutboxClaim,
  rollbackOutboxClaim,
  createVerificationJob,
  claimStaleProcessingItems,
  commitProcessingItemsClaim,
  rollbackProcessingItemsClaim,
} = await import("./verificationJobService.js");

test("commitOutboxClaim: releases the client cleanly when COMMIT succeeds", async () => {
  fakeClient = createFakeClient();

  await commitOutboxClaim(fakeClient as unknown as import("pg").PoolClient);

  assert.equal(fakeClient.releasedWith(), "released-clean");
});

test("commitOutboxClaim: still releases (destroying, not reusing) the client when COMMIT rejects", async () => {
  fakeClient = createFakeClient({ COMMIT: true });

  await assert.rejects(
    commitOutboxClaim(fakeClient as unknown as import("pg").PoolClient),
    /COMMIT failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "client.release() must be called with the error, not left un-released");
});

test("rollbackOutboxClaim: releases the client cleanly when ROLLBACK succeeds", async () => {
  fakeClient = createFakeClient();

  await rollbackOutboxClaim(fakeClient as unknown as import("pg").PoolClient);

  assert.equal(fakeClient.releasedWith(), "released-clean");
});

test("rollbackOutboxClaim: still releases (destroying, not reusing) the client when ROLLBACK rejects", async () => {
  fakeClient = createFakeClient({ ROLLBACK: true });

  await assert.rejects(
    rollbackOutboxClaim(fakeClient as unknown as import("pg").PoolClient),
    /ROLLBACK failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "client.release() must be called with the error, not left un-released");
});

test("claimPendingOutboxRows: releases the client when BEGIN rejects (before any OutboxClaim is ever returned to a caller who could release it)", async () => {
  fakeClient = createFakeClient({ BEGIN: true });

  await assert.rejects(
    claimPendingOutboxRows(10),
    /BEGIN failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(
    released instanceof Error,
    "a client checked out inside claimPendingOutboxRows() must be released if it fails before returning - nothing else owns it yet"
  );
});

test("claimPendingOutboxRows: releases the client when the SELECT rejects", async () => {
  fakeClient = createFakeClient({ SELECT: true });

  await assert.rejects(
    claimPendingOutboxRows(10),
    /SELECT failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error);
});

test("claimPendingOutboxRows: does not release the client on success - ownership passes to the caller via OutboxClaim.client", async () => {
  fakeClient = createFakeClient();

  const claim = await claimPendingOutboxRows(10);

  assert.equal(fakeClient.releasedWith(), "not-released");
  assert.equal(claim.client, fakeClient);
});

test("createVerificationJob: releases (destroying) the client when an INSERT fails", async () => {
  fakeClient = createFakeClient({ INSERT: true });

  await assert.rejects(
    createVerificationJob(["release-safety@example.com"]),
    /INSERT failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "client.release() must be called with the error, not left un-released");
});

test("createVerificationJob: a ROLLBACK failure does not mask the original INSERT error", async () => {
  fakeClient = createFakeClient({ INSERT: true, ROLLBACK: true });

  await assert.rejects(
    createVerificationJob(["release-safety-2@example.com"]),
    /INSERT failed/,
    "the caller must see the ORIGINAL failure, not the secondary rollback failure"
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "the connection must still be destroyed even though rollback also failed");
});

/*
Same release-safety class of regression, for the stale-PROCESSING-item
reconciliation claim added alongside the job-item reconciler (see
jobItemReconciler.ts) - a Postgres failure while claiming/committing/
rolling back a reconciliation batch must never leak a connection or
silently return a corrupted one to the pool.
*/

test("commitProcessingItemsClaim: releases the client cleanly when COMMIT succeeds", async () => {
  fakeClient = createFakeClient();

  await commitProcessingItemsClaim(fakeClient as unknown as import("pg").PoolClient);

  assert.equal(fakeClient.releasedWith(), "released-clean");
});

test("commitProcessingItemsClaim: still releases (destroying, not reusing) the client when COMMIT rejects", async () => {
  fakeClient = createFakeClient({ COMMIT: true });

  await assert.rejects(
    commitProcessingItemsClaim(fakeClient as unknown as import("pg").PoolClient),
    /COMMIT failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "client.release() must be called with the error, not left un-released");
});

test("rollbackProcessingItemsClaim: releases the client cleanly when ROLLBACK succeeds", async () => {
  fakeClient = createFakeClient();

  await rollbackProcessingItemsClaim(fakeClient as unknown as import("pg").PoolClient);

  assert.equal(fakeClient.releasedWith(), "released-clean");
});

test("rollbackProcessingItemsClaim: still releases (destroying, not reusing) the client when ROLLBACK rejects", async () => {
  fakeClient = createFakeClient({ ROLLBACK: true });

  await assert.rejects(
    rollbackProcessingItemsClaim(fakeClient as unknown as import("pg").PoolClient),
    /ROLLBACK failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "client.release() must be called with the error, not left un-released");
});

test("claimStaleProcessingItems: releases the client when BEGIN rejects (before any claim is ever returned to a caller who could release it)", async () => {
  fakeClient = createFakeClient({ BEGIN: true });

  await assert.rejects(
    claimStaleProcessingItems(10, 300_000),
    /BEGIN failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(
    released instanceof Error,
    "a client checked out inside claimStaleProcessingItems() must be released if it fails before returning - nothing else owns it yet"
  );
});

test("claimStaleProcessingItems: releases the client when the SELECT rejects", async () => {
  fakeClient = createFakeClient({ SELECT: true });

  await assert.rejects(
    claimStaleProcessingItems(10, 300_000),
    /SELECT failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error);
});

test("claimStaleProcessingItems: does not release the client on success - ownership passes to the caller via the claim's client", async () => {
  fakeClient = createFakeClient();

  const claim = await claimStaleProcessingItems(10, 300_000);

  assert.equal(fakeClient.releasedWith(), "not-released");
  assert.equal(claim.client, fakeClient);
});
