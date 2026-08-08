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
}

export class SMTPConnection {

  private socket: net.Socket | null = null;

  private connected = false;

  private busy = false;

  private lastUsedAt = Date.now();

  private readonly host: string;

  private readonly port: number;

  private readonly timeoutMs: number;

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

    socket.setTimeout(
      this.timeoutMs
    );

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

        socket.once(
          "connect",
          onConnect
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

    return this.readResponse();

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

        socket.on(
          "data",
          onData
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