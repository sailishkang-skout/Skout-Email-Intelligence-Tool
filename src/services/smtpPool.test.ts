import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
Regression test for a real race condition found via load testing
(Phase 10): SMTPPool.acquire() found an idle connection and returned
it to the caller synchronously within its own scan, but the
connection was only marked busy later, inside
SMTPConnection.verifyRecipient() - which the caller doesn't reach
until after an `await` back in execute(). That gap was enough for a
second concurrent acquire() call for the same host to find the exact
same "idle" connection before the first caller's verifyRecipient()
had set busy=true, handing the same connection to two callers at
once. Confirmed live: 20 concurrent verifications across 2 real
domains produced a "SMTP connection is busy" failure for a perfectly
good mailbox, purely from internal pool contention rather than
anything the remote server did.

SMTPPool always connects on port 25 (not configurable through its
public API), so this test replaces SMTPConnection with an in-memory
fake that mimics its busy/connected semantics and a small artificial
delay around the transaction - enough to widen the race window - so
the pool's own claiming logic can be exercised deterministically
without a real network connection.
*/

let activeTransactions = 0;
let maxConcurrentTransactions = 0;
let busyErrors = 0;

class FakeSMTPConnection {
  private connected = false;
  private busy = false;

  constructor(_options: unknown) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async verifyRecipient(_email: string): Promise<{ code: number; message: string }> {
    if (this.busy) {
      busyErrors++;
      throw new Error("SMTP connection is busy");
    }

    this.busy = true;
    activeTransactions++;
    maxConcurrentTransactions = Math.max(maxConcurrentTransactions, activeTransactions);

    try {
      // Simulate real network latency, widening the window in which a
      // second acquire() for the same host could (if the claiming bug
      // were present) be handed this same connection before this
      // transaction finishes.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { code: 250, message: "250 OK" };
    } finally {
      activeTransactions--;
      this.busy = false;
    }
  }

  async reset(): Promise<void> {}

  async close(): Promise<void> {
    this.connected = false;
  }
}

mock.module("./smtpConnection.js", {
  namedExports: {
    SMTPConnection: FakeSMTPConnection
  }
});

const { SMTPPool } = await import("./smtpPool.js");

test("smtpPool: concurrent verifyRecipient() calls against a host capped at one connection never see 'SMTP connection is busy'", async () => {
  const pool = new SMTPPool({
    maxConnectionsPerHost: 1,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 30_000,
    maxQueueSize: 50
  });

  activeTransactions = 0;
  maxConcurrentTransactions = 0;
  busyErrors = 0;

  const attempts = 15;

  const results = await Promise.allSettled(
    Array.from({ length: attempts }, (_, i) =>
      pool.verifyRecipient("race-test.local", `probe${i}@race-test.local`)
    )
  );

  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  );

  assert.equal(
    busyErrors,
    0,
    `expected zero internal pool-contention failures, got ${busyErrors} ` +
      `("SMTP connection is busy" from two callers sharing one connection)`
  );

  assert.equal(
    failures.length,
    0,
    `expected all ${attempts} attempts to succeed, got failures: ${failures
      .map((f) => String(f.reason))
      .join("; ")}`
  );

  assert.equal(
    maxConcurrentTransactions,
    1,
    `maxConnectionsPerHost: 1 must mean at most one transaction in flight at a time, saw ${maxConcurrentTransactions}`
  );

  await pool.close();
});
