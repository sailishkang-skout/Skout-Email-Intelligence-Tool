import { test, mock } from "node:test";
import assert from "node:assert/strict";

let response: { code: number | null; message: string } | Error = {
  code: 250,
  message: "250 2.1.5 Recipient OK",
};

mock.module("./smtpPool.js", {
  namedExports: {
    smtpPool: {
      verifyRecipient: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    },
  },
});

const { verifySMTP } = await import("./smtpChecker.js");

test("smtpChecker preserves a transport failure as structured retry evidence", async () => {
  response = new Error("SMTP connection timeout");

  const result = await verifySMTP("person@example.test", "mx.example.test");

  assert.equal(result.success, false);
  assert.equal(result.retryRequired, true);
  assert.equal(result.retryReason, "SMTP connection timeout");
  assert.equal(result.error, "SMTP connection timeout");
  assert.equal(result.provider, "SMTP_POOL");
});

test("smtpChecker marks a 4xx response retryable without turning it into an internal error", async () => {
  response = { code: 451, message: "451 4.7.1 Try again later" };

  const result = await verifySMTP("person@example.test", "mx.example.test");

  assert.equal(result.success, true);
  assert.equal(result.mailboxExists, null);
  assert.equal(result.retryRequired, true);
  assert.equal(result.retryReason, "451 4.7.1 Try again later");
  assert.equal(result.error, null);
});

test("smtpChecker keeps a definitive 250 response non-retryable", async () => {
  response = { code: 250, message: "250 2.1.5 Recipient OK" };

  const result = await verifySMTP("person@example.test", "mx.example.test");

  assert.equal(result.success, true);
  assert.equal(result.mailboxExists, true);
  assert.equal(result.smtpValid, true);
  assert.equal(result.retryRequired, false);
  assert.equal(result.retryReason, null);
  assert.equal(result.error, null);
});
