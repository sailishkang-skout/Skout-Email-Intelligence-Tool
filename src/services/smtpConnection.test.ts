import { test, mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

/*
resolvePublicAddresses performs a real DNS lookup and rejects
private/loopback addresses (by design - see ssrfGuard.ts). These
tests run a local TCP server on loopback, so the SSRF check is
mocked to allow connecting to it. This does not touch production
code; it only swaps the collaborator this test needs to reach a
server it controls. Returns a single IPv4 candidate by default -
tests that specifically need multiple/failover candidates override
this per-test (see the address-family failover tests below).
*/
let resolvedAddresses: { address: string; family: 4 | 6 }[] = [
  { address: "127.0.0.1", family: 4 }
];

mock.module("./ssrfGuard.js", {
  namedExports: {
    resolvePublicAddresses: async () => resolvedAddresses,
    // smtpConnection.ts also imports SsrfBlockedError (for its
    // instanceof check when reclassifying an SSRF rejection into
    // the SmtpTransportError taxonomy) - mock.module replaces the
    // whole module's exports, so this must be re-provided even
    // though no test in this file triggers that path.
    SsrfBlockedError: class SsrfBlockedError extends Error {}
  }
});

const { SMTPConnection, SmtpTransportError } = await import("./smtpConnection.js");

async function withServer(
  handleSocket: (socket: net.Socket) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer(handleSocket);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

/*
Same as withServer, but binds to a caller-specified host/port
instead of always 127.0.0.1 on an ephemeral port - needed for the
address-family failover tests below, which run a real IPv6 (::1)
server and a real IPv4 (127.0.0.1) server on the SAME port number
(SMTPConnection applies one port to every candidate address).
*/
async function withServerOnHost(
  host: string,
  handleSocket: (socket: net.Socket) => void,
  port = 0
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer(handleSocket);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

test.beforeEach(() => {
  resolvedAddresses = [{ address: "127.0.0.1", family: 4 }];
});

test("smtpConnection: remote closing the socket mid-transaction rejects instead of hanging forever", async () => {
  const server = await withServer((socket) => {
    socket.write("220 test.local ESMTP ready\r\n");

    socket.on("data", (chunk) => {
      const line = chunk.toString();

      if (line.startsWith("HELO")) {
        socket.write("250 test.local\r\n");
      } else if (line.startsWith("MAIL FROM")) {
        socket.write("250 OK\r\n");
      } else if (line.startsWith("RCPT TO")) {
        // Simulate a remote server that hangs up instead of
        // responding to RCPT TO (the yahoo.com production case).
        socket.destroy();
      }
    });
  });

  const connection = new SMTPConnection({
    host: "test.local",
    port: server.port,
    timeoutMs: 10_000
  });

  try {
    await assert.rejects(
      Promise.race([
        connection.verifyRecipient("postmaster@test.local"),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("TEST TIMEOUT: verifyRecipient hung")),
            2_000
          )
        )
      ]),
      /SMTP connection closed before response/
    );
  } finally {
    await connection.close();
    await server.close();
  }
});

test("smtpConnection: the hard deadline firing on an idle, already-settled connection does not crash the process", async () => {
  /*
  Regression test for a real crash found via a live worker-crash-
  recovery drill: a connection that connects, completes its
  transaction, and then sits idle (e.g. pooled for reuse) has no
  per-operation 'error' listener left once that transaction settled
  - connect()/readResponse() each remove their listeners via cleanup()
  once resolved. If the hard deadline timer then fires on that idle
  socket, socket.destroy(new Error(...)) emits 'error' with zero
  listeners, which Node treats as fatal and crashes the whole
  process. A missing baseline listener here would take down this
  entire test run, not just fail an assertion.
  */
  const server = await withServer((socket) => {
    socket.write("220 test.local ESMTP ready\r\n");
    // No further response - the connection is simply left open and
    // idle after the greeting, exactly like a pooled connection
    // waiting to be reused.
  });

  const connection = new SMTPConnection({
    host: "test.local",
    port: server.port,
    timeoutMs: 10_000,
    hardTimeoutMs: 100
  });

  try {
    await connection.connect();

    // Idle past the hard deadline. Without the baseline listener,
    // the process crashes here instead of this await ever returning.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      connection.isConnected,
      false,
      "the hard deadline should have destroyed the now-idle connection"
    );
  } finally {
    await connection.close();
    await server.close();
  }
});

test("smtpConnection: remote closing the socket before sending a greeting rejects instead of hanging forever", async () => {
  const server = await withServer((socket) => {
    // TCP handshake completes (connect() resolves), but the server
    // hangs up before ever sending the 220 greeting.
    socket.destroy();
  });

  const connection = new SMTPConnection({
    host: "test.local",
    port: server.port,
    timeoutMs: 10_000
  });

  try {
    await assert.rejects(
      Promise.race([
        connection.connect(),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("TEST TIMEOUT: connect hung")),
            2_000
          )
        )
      ]),
      /SMTP connection closed before response/
    );
  } finally {
    await connection.close();
    await server.close();
  }
});

/*
==================================================
TRANSPORT ERROR CLASSIFICATION
==================================================

Regression coverage for the root cause of the "timeout looks like a
rejected mailbox" bug: every transport-layer failure must carry an
explicit, correct SmtpTransportErrorKind rather than being a plain
Error distinguishable only by message string.
==================================================
*/

test("smtpConnection: a TCP connection that is accepted but never sends a greeting rejects with kind BANNER_TIMEOUT (not TCP_TIMEOUT - the connect itself succeeded)", async () => {
  /*
  Note: this deliberately does NOT exercise the connect-phase
  TCP_TIMEOUT path itself - that requires a target that never
  completes the TCP handshake at all (a non-routable/blackhole
  address), which this file's mocked resolvePublicAddress (always
  127.0.0.1) can't simulate deterministically without a real,
  potentially-slow non-routable network target. TCP_TIMEOUT's
  classification logic is identical to this test's (same onTimeout
  handler, gated on `phase`) and is exercised live against real
  TCP/25-restricted infrastructure - see docs/smtp-connectivity.md.
  */
  const server = await withServer(() => {
    // Accepts the TCP connection but never writes anything at all -
    // the idle timeout must fire before any greeting arrives.
  });

  const connection = new SMTPConnection({
    host: "test.local",
    port: server.port,
    timeoutMs: 150
  });

  try {
    await assert.rejects(
      connection.connect(),
      (error: unknown) => {
        assert.ok(error instanceof SmtpTransportError);
        assert.equal(error.kind, "BANNER_TIMEOUT");
        return true;
      }
    );
  } finally {
    await connection.close();
    await server.close();
  }
});

test("smtpConnection: connecting to a port nobody is listening on rejects with kind TCP_REFUSED", async () => {
  // Bind a server, capture its port, then close it immediately - the
  // port is guaranteed free but nothing is listening on it, so the
  // OS refuses the connection outright.
  const server = await withServer(() => {});
  const { port } = server;
  await server.close();

  const connection = new SMTPConnection({
    host: "test.local",
    port,
    timeoutMs: 2_000
  });

  try {
    await assert.rejects(
      connection.connect(),
      (error: unknown) => {
        assert.ok(error instanceof SmtpTransportError);
        assert.equal(error.kind, "TCP_REFUSED");
        return true;
      }
    );
  } finally {
    await connection.close();
  }
});

test("smtpConnection: a non-2xx SMTP greeting rejects with kind BANNER_FAILURE", async () => {
  const server = await withServer((socket) => {
    socket.write("554 test.local ESMTP service unavailable\r\n");
  });

  const connection = new SMTPConnection({
    host: "test.local",
    port: server.port,
    timeoutMs: 2_000
  });

  try {
    await assert.rejects(
      connection.connect(),
      (error: unknown) => {
        assert.ok(error instanceof SmtpTransportError);
        assert.equal(error.kind, "BANNER_FAILURE");
        assert.match(error.message, /SMTP greeting failed/);
        return true;
      }
    );
  } finally {
    await connection.close();
    await server.close();
  }
});

test("smtpConnection: a command response that never arrives rejects with kind COMMAND_TIMEOUT, distinct from a banner timeout", async () => {
  const server = await withServer((socket) => {
    socket.write("220 test.local ESMTP ready\r\n");

    socket.on("data", (chunk) => {
      const line = chunk.toString();

      if (line.startsWith("HELO")) {
        socket.write("250 test.local\r\n");
      } else if (line.startsWith("MAIL FROM")) {
        socket.write("250 OK\r\n");
      }
      // RCPT TO deliberately never answered.
    });
  });

  const connection = new SMTPConnection({
    host: "test.local",
    port: server.port,
    timeoutMs: 10_000,
    commandTimeoutMs: 150
  });

  try {
    await assert.rejects(
      Promise.race([
        connection.verifyRecipient("postmaster@test.local"),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("TEST TIMEOUT: verifyRecipient hung")),
            2_000
          )
        )
      ]),
      (error: unknown) => {
        assert.ok(error instanceof SmtpTransportError);
        assert.equal(error.kind, "COMMAND_TIMEOUT");
        return true;
      }
    );
  } finally {
    await connection.close();
    await server.close();
  }
});

/*
==================================================
ADDRESS-FAMILY FAILOVER
==================================================

Regression coverage for the fix that lets SMTP verification benefit
from IPv6 connectivity when it's available but the deployment's
default single-address DNS resolution would otherwise have picked
IPv4 (see ssrfGuard.ts's resolvePublicAddresses and this file's
mocked replacement above). Uses real IPv6 (::1) and IPv4 (127.0.0.1)
loopback servers - not simulated/faked family labels - so these
tests prove real dual-stack behavior, not just that the code reads
a `family` field back.
==================================================
*/

test("smtpConnection: an IPv6 candidate is attempted before an IPv4 candidate, even when IPv4 is listed first", async () => {
  let connectedVia: "ipv6" | "ipv4" | null = null;

  const ipv6Server = await withServerOnHost("::1", (socket) => {
    connectedVia = "ipv6";
    socket.write("220 test.local ESMTP ready\r\n");
  });

  const ipv4Server = await withServerOnHost(
    "127.0.0.1",
    (socket) => {
      connectedVia = "ipv4";
      socket.write("220 test.local ESMTP ready\r\n");
    },
    ipv6Server.port
  );

  // Deliberately listed IPv4-first in the resolver result, to prove
  // the connection layer's own ordering (not DNS order) decides.
  resolvedAddresses = [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 }
  ];

  const connection = new SMTPConnection({
    host: "test.local",
    port: ipv6Server.port,
    timeoutMs: 5_000
  });

  try {
    await connection.connect();

    assert.equal(
      connectedVia,
      "ipv6",
      "the IPv6 candidate must be attempted first when both are validated and available"
    );
  } finally {
    await connection.close();
    await ipv6Server.close();
    await ipv4Server.close();
  }
});

test("smtpConnection: an IPv6 candidate that fails to connect falls over to a validated IPv4 candidate", async () => {
  // A real IPv4 server that will actually accept the connection.
  const ipv4Server = await withServerOnHost("127.0.0.1", (socket) => {
    socket.write("220 test.local ESMTP ready\r\n");
  });

  // Bind an IPv6 listener on the SAME port, then close it immediately -
  // nothing is listening on ::1 at that port afterward, so a connect
  // attempt there is refused quickly and deterministically (not a slow
  // timeout), exercising a real failover rather than an artificial one.
  const ipv6Placeholder = await withServerOnHost(
    "::1",
    () => {},
    ipv4Server.port
  );
  await ipv6Placeholder.close();

  resolvedAddresses = [
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 }
  ];

  const connection = new SMTPConnection({
    host: "test.local",
    port: ipv4Server.port,
    timeoutMs: 5_000
  });

  try {
    // Must not throw - the IPv6 attempt fails fast (ECONNREFUSED) and
    // the connection layer must move on to the validated IPv4 candidate
    // rather than giving up after the first failure.
    await connection.connect();

    assert.equal(connection.isConnected, true);
  } finally {
    await connection.close();
    await ipv4Server.close();
  }
});

test("smtpConnection: with only a single IPv4 candidate (IPv6 unavailable for this hostname), a connection failure surfaces normally", async () => {
  const ipv4Server = await withServerOnHost("127.0.0.1", () => {});
  const port = ipv4Server.port;
  await ipv4Server.close();

  resolvedAddresses = [{ address: "127.0.0.1", family: 4 }];

  const connection = new SMTPConnection({
    host: "test.local",
    port,
    timeoutMs: 2_000
  });

  try {
    await assert.rejects(
      connection.connect(),
      (error: unknown) => {
        assert.ok(error instanceof SmtpTransportError);
        assert.equal(error.kind, "TCP_REFUSED");
        return true;
      }
    );
  } finally {
    await connection.close();
  }
});
