import net from "node:net";

import {
  resolvePublicAddresses,
  SsrfBlockedError,
  type ResolvedAddress,
} from "./ssrfGuard.js";

/*
Floor on the per-address connect timeout when multiple validated
candidates (e.g. an IPv6 and an IPv4 address for the same hostname)
must be attempted in sequence within the same overall connect
budget. Without a floor, a hostname with many candidates could give
each one an unreasonably short window; without a cap on the other
side (handled by dividing the overall timeoutMs across candidates
below), trying every candidate at the FULL timeout each would
multiply worst-case connect latency by the candidate count instead
of staying within the configured budget.
*/
const MIN_PER_ADDRESS_CONNECT_TIMEOUT_MS = 3_000;

export interface SMTPServerResponse {
  code: number | null;
  message: string;
}

/*
==================================================
TRANSPORT ERROR CLASSIFICATION
==================================================

Every failure mode this connection can encounter that is NOT a
real SMTP protocol response (a definitive 2xx/4xx/5xx) falls into
exactly one of these kinds. This is what lets callers upstream
(smtpChecker.ts) tell "the server said no" apart from "we never
got an answer" instead of both collapsing into the same generic
Error with only a message string to go on.

  DNS_FAILURE      - hostname could not be resolved
  TCP_REFUSED      - remote actively refused the connection (ECONNREFUSED)
  TCP_TIMEOUT      - no response at all within the connect/idle timeout
  TCP_CLOSED       - remote closed the TCP connection cleanly, no data
  BANNER_TIMEOUT   - connected, but no 220 greeting within the timeout
  BANNER_FAILURE   - a greeting was received but wasn't a usable 2xx
  COMMAND_TIMEOUT  - connected + greeted, but a command response
                     (HELO/MAIL FROM/RCPT TO) never arrived in time
  POLICY_BLOCKED   - refused by this service's own SSRF/security policy,
                     not by the remote server or the network
  PROTOCOL_ERROR   - anything else unexpected at the transport layer
==================================================
*/

export type SmtpTransportErrorKind =
  | "DNS_FAILURE"
  | "TCP_REFUSED"
  | "TCP_TIMEOUT"
  | "TCP_CLOSED"
  | "BANNER_TIMEOUT"
  | "BANNER_FAILURE"
  | "COMMAND_TIMEOUT"
  | "POLICY_BLOCKED"
  | "PROTOCOL_ERROR";

export class SmtpTransportError extends Error {
  public readonly kind: SmtpTransportErrorKind;

  /*
  Underlying Node error code (ECONNREFUSED, ETIMEDOUT, ...) when
  available, preserved for observability/debugging even though
  `kind` is what the rest of the pipeline branches on.
  */
  public readonly code: string | null;

  constructor(
    kind: SmtpTransportErrorKind,
    message: string,
    code: string | null = null
  ) {
    super(message);
    this.name = "SmtpTransportError";
    this.kind = kind;
    this.code = code;
    Object.setPrototypeOf(this, SmtpTransportError.prototype);
  }
}

function classifySocketErrorCode(
  code: string | undefined
): SmtpTransportErrorKind {
  switch (code) {
    case "ECONNREFUSED":
      return "TCP_REFUSED";
    case "ETIMEDOUT":
      return "TCP_TIMEOUT";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "DNS_FAILURE";
    case "ENETUNREACH":
    case "EHOSTUNREACH":
    case "ECONNRESET":
      return "TCP_REFUSED";
    default:
      return "PROTOCOL_ERROR";
  }
}

export interface SMTPConnectionOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  heloDomain?: string;

  /*
  Distinct idle-timeout budgets for each connection phase. All
  default to `timeoutMs` when not provided, preserving the
  previous single-timeout behavior — these only diverge when a
  caller explicitly configures them differently (see
  config.smtp.* in config.ts).
  */
  bannerTimeoutMs?: number;
  commandTimeoutMs?: number;

  /*
  Address-family preference passed through to SSRF-guarded DNS
  resolution. 4/6 restrict to that family, 0/undefined allows
  either.
  */
  addressFamily?: 0 | 4 | 6;

  /*
  Absolute upper bound on this connection's total lifetime, from
  connect through the final RCPT TO response, regardless of
  activity. `timeoutMs` (via socket.setTimeout) is an IDLE timeout —
  it resets on any byte sent or received, so a server that trickles
  data slowly (or a deliberate SMTP tarpit designed to stall
  verification bots) can keep a connection "active" indefinitely
  without ever completing. This is a separate, unconditional
  backstop.
  */
  hardTimeoutMs?: number;
}

export class SMTPConnection {

  private socket: net.Socket | null = null;

  private connected = false;

  private busy = false;

  private lastUsedAt = Date.now();

  private hardDeadlineTimer: NodeJS.Timeout | null = null;

  private readonly host: string;

  private readonly port: number;

  private readonly timeoutMs: number;

  private readonly bannerTimeoutMs: number;

  private readonly commandTimeoutMs: number;

  private readonly addressFamily: 0 | 4 | 6;

  private readonly hardTimeoutMs: number;

  private readonly heloDomain: string;

  /*
  Which phase of the SMTP exchange is currently in flight. Used
  only to classify a hard-deadline timeout with the correct
  SmtpTransportErrorKind, since the hard-deadline timer is shared
  across the whole connection lifetime rather than scoped to a
  single awaited operation.
  */
  private phase: "CONNECT" | "BANNER" | "COMMAND" = "CONNECT";

  constructor(
    options: SMTPConnectionOptions
  ) {

    this.host =
      options.host;

    this.port =
      options.port ?? 25;

    this.timeoutMs =
      options.timeoutMs ?? 10000;

    this.bannerTimeoutMs =
      options.bannerTimeoutMs ?? this.timeoutMs;

    this.commandTimeoutMs =
      options.commandTimeoutMs ?? this.timeoutMs;

    this.addressFamily =
      options.addressFamily ?? 0;

    this.hardTimeoutMs =
      options.hardTimeoutMs ?? this.timeoutMs * 3;

    this.heloDomain =
      options.heloDomain ?? "skout.ai";

  }

  get isConnected(): boolean {

    return (
      this.connected &&
      this.socket !== null &&
      !this.socket.destroyed
    );

  }

  get isBusy(): boolean {

    return this.busy;

  }

  get lastUsed(): number {

    return this.lastUsedAt;

  }

  /*
  Attempts a TCP connection to exactly ONE already-validated address
  (never the original hostname - the caller is responsible for
  passing something that already passed resolvePublicAddresses'
  SSRF check, so this method itself performs no validation). Mirrors
  connect()'s previous single-address logic exactly, just
  parameterized so connect() can try several validated candidates in
  sequence without duplicating this event-handling logic per
  candidate.

  Sets this.socket to the newly created socket immediately (before
  the connect attempt even starts, not just on success) so the hard
  deadline timer set up by connect() - which is shared across the
  whole candidate loop, not restarted per attempt - always has a
  live reference to destroy, including while a candidate attempt is
  still in flight.
  */
  private attemptOneAddress(
    address: string,
    family: 4 | 6,
    connectTimeoutMs: number
  ): Promise<net.Socket> {

    return new Promise<net.Socket>(
      (resolve, reject) => {

        const socket =
          new net.Socket();

        this.socket =
          socket;

        /*
        Permanent baseline listener for this socket's entire
        lifetime - see the identical comment this replaced in
        connect() for the full crash-prevention reasoning. Applies
        per attempted candidate now, not just the eventual winner,
        since a discarded (destroyed but not yet fully torn down)
        losing candidate could still theoretically emit a stray
        'error' after this promise has settled and its own
        operation-scoped listener has been removed.
        */

        socket.on(
          "error",
          (error: Error) => {

            console.error(
              `[SMTPConnection] Socket error for ${this.host} (${address}):`,
              error.message
            );

          }
        );

        socket.setTimeout(
          connectTimeoutMs
        );

        let settled = false;

        const cleanup = () => {

          socket.removeListener(
            "connect",
            onConnect
          );

          socket.removeListener(
            "error",
            onError
          );

          socket.removeListener(
            "timeout",
            onTimeout
          );

          socket.removeListener(
            "close",
            onClose
          );

        };

        const onConnect = () => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          resolve(socket);

        };

        const onError =
          (error: Error & { code?: string }) => {

            if (settled) {

              return;

            }

            settled = true;

            cleanup();

            socket.destroy();

            if (error instanceof SmtpTransportError) {

              reject(error);

              return;

            }

            reject(
              new SmtpTransportError(
                classifySocketErrorCode(error.code),
                error.message,
                error.code ?? null
              )
            );

          };

        const onTimeout = () => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          socket.destroy();

          reject(
            new SmtpTransportError(
              "TCP_TIMEOUT",
              "SMTP connection timeout"
            )
          );

        };

        /*
        A remote server can close the TCP connection cleanly (FIN,
        no error) before we ever get a 'connect'/'error'/'timeout'
        event — e.g. rejecting the connection outright. Without this
        listener, 'close' fires but nothing is listening for it, so
        this promise (and the caller awaiting it) hangs forever: the
        socket handle is gone, so it stops keeping the event loop
        alive, but the promise itself never settles.
        */

        const onClose = () => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          reject(
            new SmtpTransportError(
              "TCP_CLOSED",
              "SMTP connection closed before connecting"
            )
          );

        };

        socket.once(
          "connect",
          onConnect
        );

        socket.once(
          "close",
          onClose
        );

        socket.once(
          "error",
          onError
        );

        socket.once(
          "timeout",
          onTimeout
        );

        /*
        Connects to the validated literal IP address directly, with
        an explicit family - never the original hostname, and never
        a second, unvalidated resolution. This is what keeps IP
        pinning (and therefore DNS-rebinding protection) intact even
        though multiple candidates may now be attempted.
        */

        socket.connect({
          host: address,
          port: this.port,
          family
        });

      }
    );

  }

  async connect(): Promise<void> {

    if (this.isConnected) {

      return;

    }

    await this.close();

    this.phase = "CONNECT";

    /*
    Resolve to EVERY concrete, validated public address for this
    hostname (not just one) - this protects against both direct
    host injection (e.g. a debug endpoint accepting a raw host) and
    indirect SSRF via a malicious MX record pointing at an internal
    address, exactly as before. The difference from the previous
    single-address version: a dual-stack hostname can now offer both
    an IPv6 and an IPv4 candidate, and if the family that's actually
    reachable in this deployment isn't the first one tried, the
    connection layer below can fail over to the next validated
    candidate instead of reporting a timeout despite a working
    address being available.

    This can throw SsrfBlockedError before any socket-level
    machinery below even exists — reclassify it into the same
    SmtpTransportError taxonomy so callers don't need a second
    error type to handle.
    */

    let candidates: ResolvedAddress[];

    try {

      candidates =
        await resolvePublicAddresses(
          this.host,
          { family: this.addressFamily }
        );

    } catch (error) {

      if (error instanceof SsrfBlockedError) {

        throw new SmtpTransportError(
          error.isDnsFailure ? "DNS_FAILURE" : "POLICY_BLOCKED",
          error.message
        );

      }

      throw error;

    }

    /*
    Deterministic ordering: IPv6 candidates before IPv4, not because
    IPv6 is universally better, but because in this deployment
    outbound IPv4 SMTP (TCP/25) is known to be blocked while IPv6 is
    not (see docs/smtp-connectivity.md) - trying the family that
    actually works first avoids paying a doomed IPv4 attempt's
    timeout before every single connection. Stable within each
    family (preserves the resolver's own answer order).
    */

    const orderedCandidates =
      [...candidates].sort(
        (a, b) => {

          if (a.family === b.family) {

            return 0;

          }

          return a.family === 6 ? -1 : 1;

        }
      );

    /*
    Splits the overall connect budget across every candidate that
    might need to be tried, instead of paying the full timeoutMs
    for each one in sequence (which would multiply worst-case
    connect latency by the candidate count). A single candidate
    (the common case: IPv4-only or IPv6-only resolution, or a
    literal IP) still gets the full timeoutMs, unchanged from
    before this change.
    */

    const perAddressTimeoutMs =
      Math.max(
        MIN_PER_ADDRESS_CONNECT_TIMEOUT_MS,
        Math.floor(
          this.timeoutMs / orderedCandidates.length
        )
      );

    /*
    Unconditional deadline for this connection's entire lifetime -
    covers the whole candidate loop below AND the eventual banner/
    command phases, not just one attempt. Fires regardless of the
    idle-timeout resets on whichever socket is currently active
    (this.socket, kept up to date by attemptOneAddress for every
    candidate it tries, not just the eventual winner) — a server
    that never completes a response but keeps trickling bytes (or
    just holds the TCP connection open without ever writing) would
    otherwise stall verification indefinitely. Passing an explicit
    Error to destroy() ensures it surfaces through the same 'error'
    handling that attemptOneAddress()/readResponse() already listen
    for, rather than requiring new 'close' listeners everywhere.
    */

    this.hardDeadlineTimer =
      setTimeout(() => {

        const kind: SmtpTransportErrorKind =
          this.phase === "BANNER"
            ? "BANNER_TIMEOUT"
            : this.phase === "COMMAND"
              ? "COMMAND_TIMEOUT"
              : "TCP_TIMEOUT";

        this.socket?.destroy(
          new SmtpTransportError(
            kind,
            `SMTP connection exceeded hard deadline of ${this.hardTimeoutMs}ms`
          )
        );

      }, this.hardTimeoutMs);

    this.hardDeadlineTimer.unref();

    let socket: net.Socket | null = null;
    let lastError: SmtpTransportError | null = null;

    for (const candidate of orderedCandidates) {

      try {

        socket =
          await this.attemptOneAddress(
            candidate.address,
            candidate.family,
            perAddressTimeoutMs
          );

        break;

      } catch (error) {

        lastError =
          error instanceof SmtpTransportError
            ? error
            : new SmtpTransportError(
                "PROTOCOL_ERROR",
                error instanceof Error ? error.message : String(error)
              );

        // Try the next validated candidate, if any remain.

      }

    }

    if (!socket) {

      if (this.hardDeadlineTimer) {

        clearTimeout(this.hardDeadlineTimer);

        this.hardDeadlineTimer = null;

      }

      this.socket = null;

      throw (
        lastError ??
        new SmtpTransportError(
          "PROTOCOL_ERROR",
          "No validated address candidates were available to attempt"
        )
      );

    }

    this.connected = true;

    this.lastUsedAt =
      Date.now();

    /*
      SMTP servers send a 220
      greeting immediately after
      TCP connection.

      Read it before sending HELO.
    */

    this.phase = "BANNER";

    socket.setTimeout(
      this.bannerTimeoutMs
    );

    const greeting =
      await this.readResponse();

    if (
      greeting.code === null ||
      greeting.code < 200 ||
      greeting.code >= 400
    ) {

      await this.close();

      throw new SmtpTransportError(
        "BANNER_FAILURE",
        `SMTP greeting failed: ${greeting.message}`
      );

    }

  }

  async verifyRecipient(
    email: string
  ): Promise<SMTPServerResponse> {

    if (!this.isConnected) {

      await this.connect();

    }

    if (this.busy) {

      throw new Error(
        "SMTP connection is busy"
      );

    }

    this.busy = true;

    try {

      this.lastUsedAt =
        Date.now();

      await this.sendCommand(
        `HELO ${this.heloDomain}`
      );

      await this.sendCommand(
        "MAIL FROM:<verify@skout.ai>"
      );

      const response =
        await this.sendCommand(
          `RCPT TO:<${email}>`
        );

      this.lastUsedAt =
        Date.now();

      return response;

    } finally {

      this.busy = false;

    }

  }

  async reset(): Promise<void> {

    if (!this.isConnected) {

      return;

    }

    try {

      await this.sendCommand(
        "RSET"
      );

    } catch {

      await this.close();

    }

  }

  async quit(): Promise<void> {

    if (!this.isConnected) {

      return;

    }

    try {

      await this.sendCommand(
        "QUIT"
      );

    } catch {

      // Ignore QUIT errors.

    } finally {

      await this.close();

    }

  }

  async close(): Promise<void> {

    if (this.hardDeadlineTimer) {

      clearTimeout(
        this.hardDeadlineTimer
      );

      this.hardDeadlineTimer = null;

    }

    this.connected = false;

    this.busy = false;

    const socket =
      this.socket;

    this.socket = null;

    if (
      socket &&
      !socket.destroyed
    ) {

      socket.destroy();

    }

  }

  private async sendCommand(
    command: string
  ): Promise<SMTPServerResponse> {

    if (
      !this.socket ||
      !this.isConnected
    ) {

      throw new Error(
        "SMTP connection is not connected"
      );

    }

    const socket =
      this.socket;

    this.phase = "COMMAND";

    socket.setTimeout(
      this.commandTimeoutMs
    );

    socket.write(
      `${command}\r\n`
    );

    const response = await this.readResponse();

    return response;

  }

  private async readResponse(): Promise<SMTPServerResponse> {

    const socket =
      this.socket;

    if (!socket) {

      throw new Error(
        "SMTP socket unavailable"
      );

    }

    return new Promise<SMTPServerResponse>(
      (resolve, reject) => {

        let settled = false;

        let dataBuffer = "";

        const cleanup = () => {

          socket.removeListener(
            "data",
            onData
          );

          socket.removeListener(
            "error",
            onError
          );

          socket.removeListener(
            "timeout",
            onTimeout
          );

          socket.removeListener(
            "close",
            onClose
          );

        };

        const finish = (
          result: SMTPServerResponse
        ) => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          resolve(result);

        };

        const onData =
          (chunk: Buffer) => {

            if (settled) {

              return;

            }

            dataBuffer +=
              chunk.toString();

            /*
              SMTP responses can be
              multiline.

              Example:

              250-example.com
              250-SIZE 52428800
              250 OK

              We only finish when we
              receive the terminating
              response line.
            */

            const lines =
              dataBuffer.split(
                /\r?\n/
              );

            for (
              let i = 0;
              i < lines.length;
              i++
            ) {

              /*
                Strict TypeScript can
                consider array indexing
                potentially undefined.
              */

              const line =
                lines[i];

              if (
                line === undefined
              ) {

                continue;

              }

              const match =
                line.match(
                  /^(\d{3})([ -])(.*)$/
                );

              if (!match) {

                continue;

              }

              const code =
                Number(
                  match[1]
                );

              const separator =
                match[2];

              /*
                "-" means more SMTP
                response lines are
                coming.

                " " means this is
                the final line.
              */

              if (
                separator === "-"
              ) {

                continue;

              }

              finish({

                code,

                message:
                  line.trim()

              });

              return;

            }

          };

        const onError =
          (error: Error & { code?: string }) => {

            if (settled) {

              return;

            }

            settled = true;

            cleanup();

            if (error instanceof SmtpTransportError) {

              reject(error);

              return;

            }

            reject(
              new SmtpTransportError(
                classifySocketErrorCode(error.code),
                error.message,
                error.code ?? null
              )
            );

          };

        const onTimeout = () => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          socket.destroy();

          reject(
            new SmtpTransportError(
              this.phase === "BANNER"
                ? "BANNER_TIMEOUT"
                : "COMMAND_TIMEOUT",
              "SMTP response timeout"
            )
          );

        };

        /*
        A remote server can close the connection cleanly (FIN, no
        error) mid-transaction instead of responding — e.g. after
        rejecting an earlier command it may just hang up rather than
        answering the next one. Without this listener, 'close' fires
        but nothing reacts to it: the socket handle disappears (so it
        stops keeping the event loop alive) while this promise stays
        pending forever, hanging the caller indefinitely.
        */

        const onClose = () => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          reject(
            new SmtpTransportError(
              this.phase === "BANNER"
                ? "BANNER_TIMEOUT"
                : "TCP_CLOSED",
              "SMTP connection closed before response"
            )
          );

        };

        socket.on(
          "data",
          onData
        );

        socket.once(
          "close",
          onClose
        );

        socket.once(
          "error",
          onError
        );

        socket.once(
          "timeout",
          onTimeout
        );

      }
    );

  }

}