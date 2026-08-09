import net from "node:net";

import { resolvePublicAddress } from "./ssrfGuard.js";

export interface SMTPServerResponse {
  code: number | null;
  message: string;
}

export interface SMTPConnectionOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  heloDomain?: string;

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

  private readonly hardTimeoutMs: number;

  private readonly heloDomain: string;

  constructor(
    options: SMTPConnectionOptions
  ) {

    this.host =
      options.host;

    this.port =
      options.port ?? 25;

    this.timeoutMs =
      options.timeoutMs ?? 10000;

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

  async connect(): Promise<void> {

    if (this.isConnected) {

      return;

    }

    await this.close();

    /*
    Resolve to a concrete, validated public IP before
    connecting. This protects against both direct
    host injection (e.g. a debug endpoint accepting a
    raw host) and indirect SSRF via a malicious MX
    record pointing at an internal address. Connecting
    to the resolved IP (rather than the hostname)
    prevents a DNS-rebinding bypass of this check.
    */

    const targetAddress =
      await resolvePublicAddress(
        this.host
      );

    const socket =
      new net.Socket();

    this.socket =
      socket;

    /*
    Permanent baseline listener for this socket's entire lifetime,
    independent of the per-operation listeners connect()/readResponse()
    attach and remove around each individual await. Without this, a
    socket that finishes connecting and sits idle in the pool (between
    verifyRecipient() calls, or waiting for SMTPPool's own idle
    cleanup) has NO 'error' listener at all once its last operation
    settled. If the hard deadline timer below then fires while the
    connection is idle - or the remote sends a stray error for any
    other reason with nothing currently awaiting a response - Node
    treats an 'error' event with zero listeners as fatal and crashes
    the entire process. This listener guarantees 'error' is always
    handled; the operation-scoped listeners (which also still fire)
    remain responsible for rejecting whatever promise is in flight.
    */

    socket.on(
      "error",
      (error: Error) => {

        console.error(
          `[SMTPConnection] Socket error for ${this.host}:`,
          error.message
        );

      }
    );

    socket.setTimeout(
      this.timeoutMs
    );

    /*
    Unconditional deadline for this connection's entire lifetime.
    Fires regardless of the idle-timeout resets above — a server
    that never completes a response but keeps trickling bytes (or
    just holds the TCP connection open without ever writing) would
    otherwise stall verification indefinitely. Passing an explicit
    Error to destroy() ensures it surfaces through the same 'error'
    handling that connect()/readResponse() already listen for,
    rather than requiring new 'close' listeners everywhere.
    */

    this.hardDeadlineTimer =
      setTimeout(() => {

        socket.destroy(
          new Error(
            `SMTP connection exceeded hard deadline of ${this.hardTimeoutMs}ms`
          )
        );

      }, this.hardTimeoutMs);

    this.hardDeadlineTimer.unref();

    await new Promise<void>(
      (resolve, reject) => {

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

          resolve();

        };

        const onError =
          (error: Error) => {

            if (settled) {

              return;

            }

            settled = true;

            cleanup();

            reject(error);

          };

        const onTimeout = () => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          socket.destroy();

          reject(
            new Error(
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
            new Error(
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

        socket.connect(
          this.port,
          targetAddress
        );

      }
    );

    this.connected = true;

    this.lastUsedAt =
      Date.now();

    /*
      SMTP servers send a 220
      greeting immediately after
      TCP connection.

      Read it before sending HELO.
    */

    const greeting =
      await this.readResponse();

    if (
      greeting.code === null ||
      greeting.code < 200 ||
      greeting.code >= 400
    ) {

      await this.close();

      throw new Error(
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
          (error: Error) => {

            if (settled) {

              return;

            }

            settled = true;

            cleanup();

            reject(error);

          };

        const onTimeout = () => {

          if (settled) {

            return;

          }

          settled = true;

          cleanup();

          socket.destroy();

          reject(
            new Error(
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
            new Error(
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