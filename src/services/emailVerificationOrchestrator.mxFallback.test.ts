import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySMTPWithFallback } from "./emailVerificationOrchestrator.js";
import type { SMTPVerificationResult } from "./smtpChecker.js";

/*
Unit tests for the MX-fallback loop in isolation, via dependency injection
(the `verify` parameter) rather than a real network call or module mock.
Exercises exactly the decision this function makes: fall back on a transport
failure, stop on any real SMTP response (including a 4xx), and respect the
host cap.
*/

function transportFailure(host: string): SMTPVerificationResult {
  return {
    success: false,
    smtpValid: false,
    mailboxExists: null,
    responseCode: null,
    responseMessage: "",
    transcript: ["SMTP_POOL_ERROR", `connect ${host} failed`],
    mxHost: host,
    durationMs: 1,
    provider: "SMTP_POOL",
    retryRequired: true,
    retryReason: `connect ${host} failed`,
    error: `connect ${host} failed`,
  };
}

function realResponse(host: string, code: number, mailboxExists: boolean | null): SMTPVerificationResult {
  return {
    success: true,
    smtpValid: code >= 200 && code < 300,
    mailboxExists,
    responseCode: code,
    responseMessage: `${code} from ${host}`,
    transcript: ["SMTP_POOL", `MX: ${host}`, `RCPT RESPONSE: ${code}`],
    mxHost: host,
    durationMs: 1,
    provider: "SMTP_POOL",
    retryRequired: code >= 400 && code < 500,
    retryReason: code >= 400 && code < 500 ? `${code} from ${host}` : null,
    error: null,
  };
}

test("verifySMTPWithFallback: the top-priority host answering stops the loop immediately", async () => {
  const calls: string[] = [];
  const verify = async (_email: string, host: string) => {
    calls.push(host);
    return realResponse(host, 250, true);
  };

  const result = await verifySMTPWithFallback("a@example.com", ["mx1", "mx2"], verify);

  assert.deepEqual(calls, ["mx1"], "the second host is never tried once the first answers");
  assert.equal(result?.responseCode, 250);
  assert.equal(result?.error, null);
});

test("verifySMTPWithFallback: a transport failure on the preferred host falls back to the next one", async () => {
  const calls: string[] = [];
  const verify = async (_email: string, host: string) => {
    calls.push(host);
    return host === "mx1" ? transportFailure(host) : realResponse(host, 250, true);
  };

  const result = await verifySMTPWithFallback("a@example.com", ["mx1", "mx2"], verify);

  assert.deepEqual(calls, ["mx1", "mx2"]);
  assert.equal(result?.responseCode, 250);
  assert.equal(result?.error, null, "the final result reflects the host that actually answered");
});

test("verifySMTPWithFallback: a 4xx from a reachable host is final — it is not a reason to try a different host", async () => {
  const calls: string[] = [];
  const verify = async (_email: string, host: string) => {
    calls.push(host);
    return realResponse(host, 450, null);
  };

  const result = await verifySMTPWithFallback("a@example.com", ["mx1", "mx2"], verify);

  assert.deepEqual(calls, ["mx1"], "greylisting-style 4xx belongs to the retry scheduler, not a different MX");
  assert.equal(result?.responseCode, 450);
  assert.equal(result?.retryRequired, true);
});

test("verifySMTPWithFallback: a 5xx permanent rejection from a reachable host is also final", async () => {
  const calls: string[] = [];
  const verify = async (_email: string, host: string) => {
    calls.push(host);
    return realResponse(host, 550, false);
  };

  const result = await verifySMTPWithFallback("a@example.com", ["mx1", "mx2"], verify);

  assert.deepEqual(calls, ["mx1"]);
  assert.equal(result?.responseCode, 550);
  assert.equal(result?.mailboxExists, false);
});

test("verifySMTPWithFallback: when every host is unreachable, the last attempt's failure is returned", async () => {
  const calls: string[] = [];
  const verify = async (_email: string, host: string) => {
    calls.push(host);
    return transportFailure(host);
  };

  const result = await verifySMTPWithFallback("a@example.com", ["mx1", "mx2", "mx3"], verify);

  assert.deepEqual(calls, ["mx1", "mx2", "mx3"]);
  assert.equal(result?.error, "connect mx3 failed");
  assert.equal(result?.retryRequired, true);
});

test("verifySMTPWithFallback: the host count is capped so a domain with many MX records has bounded worst-case latency", async () => {
  const calls: string[] = [];
  const verify = async (_email: string, host: string) => {
    calls.push(host);
    return transportFailure(host);
  };

  await verifySMTPWithFallback("a@example.com", ["mx1", "mx2", "mx3", "mx4", "mx5"], verify, 3);

  assert.deepEqual(calls, ["mx1", "mx2", "mx3"], "mx4 and mx5 are never attempted");
});

test("verifySMTPWithFallback: an empty MX list returns null without calling the verifier", async () => {
  let called = false;
  const verify = async () => { called = true; return transportFailure("unused"); };

  const result = await verifySMTPWithFallback("a@example.com", [], verify);

  assert.equal(result, null);
  assert.equal(called, false);
});
