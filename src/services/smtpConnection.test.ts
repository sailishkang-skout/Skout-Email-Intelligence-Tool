import { test, mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

/*
resolvePublicAddress performs a real DNS lookup and rejects
private/loopback addresses (by design - see ssrfGuard.ts). These
tests run a local TCP server on loopback, so the SSRF check is
mocked to allow connecting to it. This does not touch production
code; it only swaps the collaborator this test needs to reach a
server it controls.
*/
mock.module("./ssrfGuard.js", {
  namedExports: {
    resolvePublicAddress: async () => "127.0.0.1"
  }
});

const { SMTPConnection } = await import("./smtpConnection.js");

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
