import { test, mock } from "node:test";
import assert from "node:assert/strict";

/*
resolvePublicAddresses() must independently validate EVERY DNS
answer (not just trust the resolver), drop private/reserved ones,
de-duplicate, and never throw away a legitimate public candidate
just because another candidate for the same hostname happens to be
bad. Mocking node:dns/promises' lookup() directly (rather than
using real DNS) makes the exact candidate set deterministic - dedup
and mixed-validity filtering can't be reliably exercised against a
real hostname without depending on that hostname's current DNS
records staying exactly as expected.
*/

let lookupResult:
  | { address: string; family: number }[]
  | Error = [];

mock.module("node:dns/promises", {
  // @types/node's MockModuleOptions doesn't yet know about the
  // newer `exports` option (only the deprecated `defaultExport`),
  // even though the Node runtime itself supports both - using
  // `defaultExport` here keeps `tsc` happy without a type-defs
  // upgrade unrelated to this change.
  defaultExport: {
    lookup: async () => {
      if (lookupResult instanceof Error) {
        throw lookupResult;
      }

      return lookupResult;
    }
  }
});

const { resolvePublicAddresses, resolvePublicAddress, SsrfBlockedError } =
  await import("./ssrfGuard.js");

test("resolvePublicAddresses: a hostname returning both IPv4 and IPv6 answers returns both, each tagged with its family", async () => {
  lookupResult = [
    { address: "2404:6800:4013:813::1b", family: 6 },
    { address: "2404:6800:4013:813::1a", family: 6 },
    { address: "192.178.158.26", family: 4 },
    { address: "192.178.158.27", family: 4 }
  ];

  const result = await resolvePublicAddresses("smtp.google.com");

  assert.deepEqual(result, [
    { address: "2404:6800:4013:813::1b", family: 6 },
    { address: "2404:6800:4013:813::1a", family: 6 },
    { address: "192.178.158.26", family: 4 },
    { address: "192.178.158.27", family: 4 }
  ]);
});

test("resolvePublicAddresses: duplicate addresses in the DNS answer are removed", async () => {
  lookupResult = [
    { address: "8.8.8.8", family: 4 },
    { address: "8.8.8.8", family: 4 },
    { address: "2001:4860:4860::8888", family: 6 }
  ];

  const result = await resolvePublicAddresses("dns.google");

  assert.equal(result.length, 2);
  assert.equal(
    result.filter((r) => r.address === "8.8.8.8").length,
    1,
    "the duplicate must be collapsed to a single entry"
  );
});

test("resolvePublicAddresses: every answer is validated independently - a private decoy mixed with a legitimate public address does not block the public one", async () => {
  lookupResult = [
    { address: "10.0.0.5", family: 4 }, // private decoy - must be dropped, not thrown on
    { address: "203.0.113.9", family: 4 }, // TEST-NET-3, treated as public by this guard's ranges
  ];

  const result = await resolvePublicAddresses("attacker-controlled.example");

  assert.deepEqual(result, [{ address: "203.0.113.9", family: 4 }]);
});

test("resolvePublicAddresses: every answer being private/reserved throws SsrfBlockedError instead of returning an empty list silently", async () => {
  lookupResult = [
    { address: "127.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
    { address: "::1", family: 6 }
  ];

  await assert.rejects(
    () => resolvePublicAddresses("all-private.example"),
    SsrfBlockedError
  );
});

test("resolvePublicAddresses: private IPv4 (RFC1918) literal is rejected", async () => {
  await assert.rejects(() => resolvePublicAddresses("192.168.1.1"), SsrfBlockedError);
});

test("resolvePublicAddresses: loopback IPv4 literal is rejected", async () => {
  await assert.rejects(() => resolvePublicAddresses("127.0.0.1"), SsrfBlockedError);
});

test("resolvePublicAddresses: loopback IPv6 literal is rejected", async () => {
  await assert.rejects(() => resolvePublicAddresses("::1"), SsrfBlockedError);
});

test("resolvePublicAddresses: IPv6 unique-local (ULA) literal is rejected under the existing fc00::/7 policy", async () => {
  await assert.rejects(() => resolvePublicAddresses("fd00::1"), SsrfBlockedError);
});

test("resolvePublicAddresses: a public IPv4 literal resolves to a single validated candidate, no DNS lookup performed", async () => {
  lookupResult = new Error("DNS should not be queried for a literal IP");

  const result = await resolvePublicAddresses("8.8.8.8");

  assert.deepEqual(result, [{ address: "8.8.8.8", family: 4 }]);
});

test("resolvePublicAddresses: DNS resolution failure is classified as SsrfBlockedError with isDnsFailure true", async () => {
  lookupResult = new Error("queryA ENOTFOUND nonexistent.invalid");

  await assert.rejects(
    () => resolvePublicAddresses("nonexistent.invalid"),
    (error: unknown) => {
      assert.ok(error instanceof SsrfBlockedError);
      assert.equal(error.isDnsFailure, true);
      return true;
    }
  );
});

test("resolvePublicAddress (singular, backward-compatible wrapper): still returns exactly one address string, the first validated candidate", async () => {
  lookupResult = [
    { address: "2404:6800:4013:813::1b", family: 6 },
    { address: "192.178.158.26", family: 4 }
  ];

  const result = await resolvePublicAddress("smtp.google.com");

  assert.equal(result, "2404:6800:4013:813::1b");
});

test("resolvePublicAddress (singular): every attempted/returned address was independently validated - a private-only answer set still throws", async () => {
  lookupResult = [{ address: "10.0.0.1", family: 4 }];

  await assert.rejects(() => resolvePublicAddress("internal.example"), SsrfBlockedError);
});
