import dns from "node:dns/promises";
import net from "node:net";

/*
==================================================
SSRF GUARD
==================================================

Purpose:

This service opens raw TCP/SMTP connections to
hostnames that ultimately come from untrusted
input: either directly (the /smtp/verify debug
route accepts a client-supplied mxHost) or
indirectly (a malicious domain can point its MX
record at an internal address).

Before connecting anywhere, resolve the target
hostname to a concrete IP and verify that IP is
not a private, loopback, link-local, or otherwise
reserved address. The resolved IP (not the original
hostname) must then be used for the actual
connection, so the check cannot be bypassed by DNS
rebinding between validation and connect.

This module does NOT perform the network call
itself — callers connect to the IP this returns.
==================================================
*/

export class SsrfBlockedError extends Error {
  /*
  Raw reason string, kept separate from the combined `.message` so
  callers that need to classify the failure (e.g. distinguishing a
  DNS resolution failure from a private-address policy block, for
  SMTP transport-error classification) don't have to regex-parse
  the human-readable message.
  */
  public readonly reason: string;

  /*
  True when this block originated from DNS resolution itself
  failing (NXDOMAIN, timeout, etc.), as opposed to a successful
  resolution landing on a private/reserved address. The two are
  different failure classes for retry/observability purposes.
  */
  public readonly isDnsFailure: boolean;

  constructor(host: string, reason: string) {
    super(`Refusing to connect to ${host}: ${reason}`);
    this.name = "SsrfBlockedError";
    this.reason = reason;
    this.isDnsFailure = reason.startsWith("DNS resolution failed");
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true; // fail closed on anything unparseable
  }

  const [a, b] = parts as [number, number, number, number];

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast/reserved (224.0.0.0+)

  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd"))
    return true; // unique local (fc00::/7)
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 address; validate the embedded IPv4 address.
    const mapped = normalized.split(":").pop() ?? "";
    if (net.isIPv4(mapped)) {
      return isPrivateIPv4(mapped);
    }
  }

  return false;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return isPrivateIPv4(ip);
  }

  if (net.isIPv6(ip)) {
    return isPrivateIPv6(ip);
  }

  return true; // fail closed for anything we don't recognize
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves `hostname` to EVERY concrete address it currently answers
 * with (both A and AAAA when available), independently validates
 * each one against the exact same public/private classification
 * `resolvePublicAddress` uses, drops any that are private/loopback/
 * link-local/reserved, and de-duplicates. Callers must connect to
 * one of the returned addresses directly (never the original
 * hostname) to avoid DNS rebinding between this check and the
 * actual connection — each address in the returned list has already
 * passed SSRF validation individually, so any of them is safe to
 * connect to.
 *
 * Throws SsrfBlockedError if DNS resolution itself fails, or if
 * every candidate address DNS returned is private/reserved (i.e.
 * there is nothing safe left to connect to).
 */
export async function resolvePublicAddresses(
  hostname: string,
  options?: {
    /*
    4 = IPv4 only, 6 = IPv6 only, 0/undefined = either family.
    Lets callers honor an operator's address-family preference
    (SMTP_ALLOW_IPV4/SMTP_ALLOW_IPV6 - see config.ts) instead of
    always taking every family the resolver returns.
    */
    family?: 0 | 4 | 6;
  }
): Promise<ResolvedAddress[]> {
  const trimmed = hostname.trim();

  if (!trimmed) {
    throw new SsrfBlockedError(hostname, "empty host");
  }

  // Already a literal IP address - a single-candidate "resolution".
  if (net.isIP(trimmed)) {
    if (isPrivateAddress(trimmed)) {
      throw new SsrfBlockedError(
        trimmed,
        "target address is private/reserved"
      );
    }

    return [
      {
        address: trimmed,
        family: net.isIPv4(trimmed) ? 4 : 6,
      },
    ];
  }

  let results: { address: string; family: number }[];

  try {
    /*
    all: true - return every answer, not just one. verbatim: true -
    return them in the order the resolver gave them (no implicit
    IPv4-first reordering), since this function's whole purpose is
    to hand every real candidate to the caller and let ITS ordering
    policy decide, not have that decision silently made here.
    */
    results = await dns.lookup(trimmed, {
      all: true,
      verbatim: true,
      family: options?.family ?? 0,
    });
  } catch (error) {
    throw new SsrfBlockedError(
      trimmed,
      `DNS resolution failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const seen = new Set<string>();
  const validated: ResolvedAddress[] = [];

  for (const result of results) {
    const address = result.address;

    // De-duplicate - a resolver can legitimately return the same
    // address twice (e.g. once per nameserver response merged).
    if (seen.has(address)) {
      continue;
    }
    seen.add(address);

    /*
    Every DNS answer is validated independently and dropped (not
    thrown on) if private/reserved - a malicious or misconfigured
    domain could mix a legitimate public MX with an internal
    decoy address; the fix is to never connect to the bad one, not
    to refuse the whole hostname when a good candidate also exists.
    */
    if (isPrivateAddress(address)) {
      continue;
    }

    validated.push({
      address,
      family: net.isIPv4(address) ? 4 : 6,
    });
  }

  if (validated.length === 0) {
    throw new SsrfBlockedError(
      trimmed,
      `no public/routable address found (DNS returned ${results.length} candidate(s), none usable)`
    );
  }

  return validated;
}

/**
 * Resolves `hostname` to a single concrete, validated public IP
 * address. Thin compatibility wrapper around
 * `resolvePublicAddresses` (the first validated candidate) for
 * callers that only ever need/want one address - see that function
 * for the full validation contract. Throws SsrfBlockedError under
 * the exact same conditions.
 */
export async function resolvePublicAddress(
  hostname: string,
  options?: { family?: 0 | 4 | 6 }
): Promise<string> {
  const addresses = await resolvePublicAddresses(hostname, options);

  return addresses[0].address;
}
