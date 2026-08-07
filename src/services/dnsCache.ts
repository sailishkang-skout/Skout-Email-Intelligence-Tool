import { resolveMx } from "node:dns/promises";

export interface CachedMXRecord {
  priority: number;
  exchange: string;
}

interface CacheEntry {
  records: CachedMXRecord[];
  expiresAt: number;
  hits: number;
}

const cache = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 30 * 60 * 1000;

let cacheHits = 0;
let cacheMisses = 0;

function normalizeDomain(domain: string): string {
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.trim() ?? "";

  if (!normalized) {
    throw new Error("Invalid domain");
  }

  return normalized;
}

export async function getMX(
  domain: string
): Promise<CachedMXRecord[]> {
  const normalizedDomain = normalizeDomain(domain);
  const now = Date.now();

  const cached = cache.get(normalizedDomain);

  if (
    cached &&
    cached.expiresAt > now
  ) {
    cached.hits += 1;
    cacheHits += 1;

    return [...cached.records];
  }

  cacheMisses += 1;

  const records = await resolveMx(
    normalizedDomain
  );

  const normalizedRecords: CachedMXRecord[] =
    records
      .map((record) => ({
        priority: Number(record.priority),
        exchange: String(record.exchange)
          .trim()
          .toLowerCase()
          .replace(/\.$/, "")
      }))
      .filter(
        (record) =>
          record.exchange.length > 0 &&
          Number.isFinite(record.priority)
      )
      .sort(
        (a, b) =>
          a.priority - b.priority
      );

  cache.set(
    normalizedDomain,
    {
      records: normalizedRecords,
      expiresAt:
        now + DEFAULT_TTL_MS,
      hits: 1
    }
  );

  return [...normalizedRecords];
}

export function cleanupDNSCache(): void {
  const now = Date.now();

  for (
    const [domain, entry]
    of cache.entries()
  ) {
    if (
      entry.expiresAt <= now
    ) {
      cache.delete(domain);
    }
  }
}

export function getDNSCacheStats(): {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
} {
  const total =
    cacheHits + cacheMisses;

  return {
    entries: cache.size,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate:
      total === 0
        ? 0
        : Number(
            (
              (cacheHits / total) *
              100
            ).toFixed(2)
          )
  };
}

export function clearDNSCache(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}