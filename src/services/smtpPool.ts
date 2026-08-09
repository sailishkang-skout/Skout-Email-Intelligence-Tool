import {
  SMTPConnection
} from "./smtpConnection.js";

export interface SMTPPoolOptions {
  maxConnectionsPerHost?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxQueueSize?: number;
}

interface PoolEntry {
  connection: SMTPConnection;
  host: string;
  createdAt: number;
  lastUsedAt: number;

  /*
  Reserved by the pool for a specific caller. This is distinct from
  connection.isBusy, which SMTPConnection only sets once an SMTP
  transaction actually starts (inside verifyRecipient()). Between
  acquire() selecting an idle entry and the caller's first await
  landing on that connection, isBusy is still false - a second
  concurrent acquire() call for the same host would find the exact
  same "idle" entry and hand it out too. claimed closes that gap by
  being set synchronously, in the same tick the entry is selected.
  */
  claimed: boolean;
}

interface QueueItem {
  resolve: (
    connection: SMTPConnection
  ) => void;

  reject: (
    error: unknown
  ) => void;
}

export class SMTPPool {

  private readonly maxConnectionsPerHost: number;

  private readonly idleTimeoutMs: number;

  private readonly connectionTimeoutMs: number;

  private readonly maxQueueSize: number;

  private readonly pools =
    new Map<string, PoolEntry[]>();

  private readonly queues =
    new Map<string, QueueItem[]>();

  private cleanupTimer: NodeJS.Timeout;

  constructor(
    options: SMTPPoolOptions = {}
  ) {

    this.maxConnectionsPerHost =
      options.maxConnectionsPerHost ?? 5;

    this.idleTimeoutMs =
      options.idleTimeoutMs ?? 30_000;

    this.connectionTimeoutMs =
      options.connectionTimeoutMs ?? 10_000;

    this.maxQueueSize =
      options.maxQueueSize ?? 100;

    this.cleanupTimer =
      setInterval(
        () => {
          void this.cleanupIdleConnections();
        },
        10_000
      );

    this.cleanupTimer.unref();

  }

  async execute<T>(
    host: string,
    operation: (
      connection: SMTPConnection
    ) => Promise<T>
  ): Promise<T> {

    const connection =
      await this.acquire(host);

    try {

      return await operation(
        connection
      );

    } catch (error) {

      await connection.close();

      this.removeConnection(
        host,
        connection
      );

      throw error;

    } finally {

      await this.release(
        host,
        connection
      );

    }

  }

  async verifyRecipient(
    host: string,
    email: string
  ) {

    return this.execute(
      host,
      async (connection) => {

        const result =
          await connection.verifyRecipient(
            email
          );

        await connection.reset();

        return result;

      }
    );

  }

  getStats() {

    const hosts: Record<
      string,
      {
        connections: number;
        busy: number;
        idle: number;
        queued: number;
      }
    > = {};

    for (
      const [
        host,
        entries
      ] of this.pools
    ) {

      const queue =
        this.queues.get(host) ?? [];

      let busy = 0;

      for (
        const entry of entries
      ) {

        if (
          entry.claimed
        ) {

          busy++;

        }

      }

      hosts[host] = {

        connections:
          entries.length,

        busy,

        idle:
          entries.length - busy,

        queued:
          queue.length

      };

    }

    let totalConnections = 0;

    let totalQueued = 0;

    for (
      const entries of
      this.pools.values()
    ) {

      totalConnections +=
        entries.length;

    }

    for (
      const queue of
      this.queues.values()
    ) {

      totalQueued +=
        queue.length;

    }

    return {

      hosts,

      totalConnections,

      totalQueued

    };

  }

  async close(): Promise<void> {

    clearInterval(
      this.cleanupTimer
    );

    const operations:
      Promise<void>[] = [];

    for (
      const entries
      of this.pools.values()
    ) {

      for (
        const entry
        of entries
      ) {

        operations.push(
          entry.connection.close()
        );

      }

    }

    await Promise.allSettled(
      operations
    );

    this.pools.clear();

    for (
      const queue
      of this.queues.values()
    ) {

      for (
        const item
        of queue
      ) {

        item.reject(
          new Error(
            "SMTP pool closed"
          )
        );

      }

    }

    this.queues.clear();

  }

  private async acquire(
    host: string
  ): Promise<SMTPConnection> {

    const entries =
      this.getPool(host);

    /*
      Reuse an idle connection.
    */

    const idle =
      entries.find(
        (entry) =>
          entry.connection.isConnected &&
          !entry.claimed
      );

    if (idle) {

      idle.lastUsedAt =
        Date.now();

      idle.claimed =
        true;

      return idle.connection;

    }

    /*
      Remove dead connections.
    */

    for (
      const entry
      of [...entries]
    ) {

      if (
        !entry.connection.isConnected
      ) {

        this.removeConnection(
          host,
          entry.connection
        );

      }

    }

    const current =
      this.getPool(host);

    /*
      Create a new connection
      if capacity exists.
    */

    if (
      current.length <
      this.maxConnectionsPerHost
    ) {

      const connection =
        new SMTPConnection({

          host,

          port: 25,

          timeoutMs:
            this.connectionTimeoutMs,

          heloDomain:
            "skout.ai"

        });

      const entry: PoolEntry = {

        connection,

        host,

        createdAt:
          Date.now(),

        lastUsedAt:
          Date.now(),

        claimed:
          true

      };

      current.push(entry);

      try {

        await connection.connect();

        return connection;

      } catch (error) {

        this.removeConnection(
          host,
          connection
        );

        await connection.close();

        throw error;

      }

    }

    /*
      Pool is full.
      Wait for a connection.
    */

    return this.waitForConnection(
      host
    );

  }

  private async release(
    host: string,
    connection: SMTPConnection
  ): Promise<void> {

    const entries =
      this.getPool(host);

    const entry =
      entries.find(
        (item) =>
          item.connection ===
          connection
      );

    if (entry) {

      entry.lastUsedAt =
        Date.now();

      entry.claimed =
        false;

    }

    await this.processQueue(
      host
    );

  }

  private waitForConnection(
    host: string
  ): Promise<SMTPConnection> {

    const queue =
      this.getQueue(host);

    if (
      queue.length >=
      this.maxQueueSize
    ) {

      return Promise.reject(
        new Error(
          `SMTP pool queue full for ${host}`
        )
      );

    }

    return new Promise(
      (
        resolve,
        reject
      ) => {

        queue.push({

          resolve,

          reject

        });

      }
    );

  }

  private async processQueue(
    host: string
  ): Promise<void> {

    const queue =
      this.getQueue(host);

    if (!queue.length) {

      return;

    }

    const entries =
      this.getPool(host);

    const idle =
      entries.find(
        (entry) =>
          entry.connection.isConnected &&
          !entry.claimed
      );

    if (!idle) {

      return;

    }

    const item =
      queue.shift();

    if (!item) {

      return;

    }

    idle.claimed =
      true;

    item.resolve(
      idle.connection
    );

  }

  private getPool(
    host: string
  ): PoolEntry[] {

    let pool =
      this.pools.get(host);

    if (!pool) {

      pool = [];

      this.pools.set(
        host,
        pool
      );

    }

    return pool;

  }

  private getQueue(
    host: string
  ): QueueItem[] {

    let queue =
      this.queues.get(host);

    if (!queue) {

      queue = [];

      this.queues.set(
        host,
        queue
      );

    }

    return queue;

  }

  private removeConnection(
    host: string,
    connection: SMTPConnection
  ): void {

    const entries =
      this.pools.get(host);

    if (!entries) {

      return;

    }

    const index =
      entries.findIndex(
        (entry) =>
          entry.connection ===
          connection
      );

    if (index !== -1) {

      entries.splice(
        index,
        1
      );

    }

    if (!entries.length) {

      this.pools.delete(
        host
      );

    }

  }

  private async cleanupIdleConnections() {

    const now =
      Date.now();

    for (
      const [
        host,
        entries
      ] of this.pools
    ) {

      for (
        const entry
        of [...entries]
      ) {

        const idleFor =
          now -
          entry.lastUsedAt;

        if (
          !entry.claimed &&
          idleFor >
            this.idleTimeoutMs
        ) {

          await entry.connection.close();

          this.removeConnection(
            host,
            entry.connection
          );

        }

      }

      await this.processQueue(
        host
      );

    }

  }

}

/*
  Enterprise application-wide
  singleton pool.

  Existing smtpChecker.ts
  expects this export.
*/

export const smtpPool =
  new SMTPPool({

    maxConnectionsPerHost: 5,

    idleTimeoutMs: 30_000,

    connectionTimeoutMs: 10_000,

    maxQueueSize: 100

  });