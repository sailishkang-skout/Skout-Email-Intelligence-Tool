import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePublicAddress, SsrfBlockedError } from "./ssrfGuard.js";

test("ssrfGuard: blocks loopback IPv4 addresses", async () => {
  await assert.rejects(
    () => resolvePublicAddress("127.0.0.1"),
    SsrfBlockedError
  );
});

test("ssrfGuard: blocks RFC1918 private ranges", async () => {
  await assert.rejects(() => resolvePublicAddress("10.0.0.5"), SsrfBlockedError);
  await assert.rejects(() => resolvePublicAddress("192.168.1.1"), SsrfBlockedError);
  await assert.rejects(() => resolvePublicAddress("172.16.0.1"), SsrfBlockedError);
});

test("ssrfGuard: blocks the cloud metadata link-local address", async () => {
  await assert.rejects(
    () => resolvePublicAddress("169.254.169.254"),
    SsrfBlockedError
  );
});

test("ssrfGuard: blocks IPv6 loopback and unique-local addresses", async () => {
  await assert.rejects(() => resolvePublicAddress("::1"), SsrfBlockedError);
  await assert.rejects(() => resolvePublicAddress("fd00::1"), SsrfBlockedError);
});

test("ssrfGuard: allows a public IPv4 address through unchanged", async () => {
  const result = await resolvePublicAddress("8.8.8.8");

  assert.equal(result, "8.8.8.8");
});

test("ssrfGuard: rejects empty host", async () => {
  await assert.rejects(() => resolvePublicAddress("   "), SsrfBlockedError);
});
