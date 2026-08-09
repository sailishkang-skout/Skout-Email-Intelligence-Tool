import { test } from "node:test";
import assert from "node:assert/strict";

import { extractErrorMessage } from "./errorMessage.js";

test("extractErrorMessage: a plain Error returns its message", () => {
  assert.equal(
    extractErrorMessage(new Error("boom")),
    "boom"
  );
});

test("extractErrorMessage: a non-Error value is stringified", () => {
  assert.equal(extractErrorMessage("plain string"), "plain string");
  assert.equal(extractErrorMessage(42), "42");
});

test("extractErrorMessage: an AggregateError with an empty .message falls back to its sub-errors (the real Postgres-down / dual-stack ECONNREFUSED shape)", () => {
  const aggregate = new AggregateError(
    [
      Object.assign(new Error("connect ECONNREFUSED ::1:5432"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })
    ]
  );

  assert.equal(aggregate.message, "", "sanity check: AggregateError.message is empty by default");

  const message = extractErrorMessage(aggregate);

  assert.match(message, /ECONNREFUSED ::1:5432/);
  assert.match(message, /ECONNREFUSED 127\.0\.0\.1:5432/);
});

test("extractErrorMessage: an AggregateError with a set message uses it directly", () => {
  const aggregate = new AggregateError([new Error("inner")], "outer message");

  assert.equal(extractErrorMessage(aggregate), "outer message");
});
