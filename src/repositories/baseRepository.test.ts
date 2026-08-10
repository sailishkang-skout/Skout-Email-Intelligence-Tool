import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
Regression test for the same connection-release class of bug fixed in
verificationJobService.ts's outbox claim functions (see that file's
test for the full incident writeup): withTransaction() is the shared
transaction helper every repository built on BaseRepository relies on
- if it silently returned a possibly-corrupted connection to the pool
after a failed COMMIT/ROLLBACK, or masked the real error behind a
secondary rollback failure, every consumer would inherit that bug.
*/

interface FakeClient {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
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

const { BaseRepository } = await import("./baseRepository.js");

class TestRepository extends BaseRepository {
  runTransaction<T>(callback: (tx: import("pg").PoolClient) => Promise<T>): Promise<T> {
    return this.withTransaction(callback);
  }
}

const repo = new TestRepository();

test("withTransaction: releases the client cleanly on success", async () => {
  fakeClient = createFakeClient();

  await repo.runTransaction(async () => "ok");

  assert.equal(fakeClient.releasedWith(), "released-clean");
});

test("withTransaction: still releases (destroying, not reusing) the client when the callback throws", async () => {
  fakeClient = createFakeClient();

  await assert.rejects(
    repo.runTransaction(async () => {
      throw new Error("callback failed");
    }),
    /callback failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "client.release() must be called with the error, not left un-released");
});

test("withTransaction: a ROLLBACK failure does not mask the original callback error", async () => {
  fakeClient = createFakeClient({ ROLLBACK: true });

  await assert.rejects(
    repo.runTransaction(async () => {
      throw new Error("original failure");
    }),
    /original failure/,
    "the caller must see the ORIGINAL failure, not the secondary rollback failure"
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error, "the connection must still be destroyed even though rollback also failed");
});

test("withTransaction: still releases (destroying) the client when COMMIT itself fails", async () => {
  fakeClient = createFakeClient({ COMMIT: true });

  await assert.rejects(
    repo.runTransaction(async () => "ok"),
    /COMMIT failed/
  );

  const released = fakeClient.releasedWith();
  assert.ok(released instanceof Error);
});
