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
  constructor(host: string, reason: string) {
    super(`Refusing to connect to ${host}: ${reason}`);
    this.name = "SsrfBlockedError";
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

/**
 * Resolves `hostname` to a concrete IP address and verifies it is a
 * public, routable address. Returns the resolved IP — callers must
 * connect to that IP (not the original hostname) to avoid DNS
 * rebinding between this check and the actual connection.
 *
 * Throws SsrfBlockedError if the host resolves to a private,
 * loopback, link-local, or otherwise reserved address.
 */
export async function resolvePublicAddress(
  hostname: string
): Promise<string> {
  const trimmed = hostname.trim();

  if (!trimmed) {
    throw new SsrfBlockedError(hostname, "empty host");
  }

  // Already a literal IP address.
  if (net.isIP(trimmed)) {
    if (isPrivateAddress(trimmed)) {
      throw new SsrfBlockedError(
        trimmed,
        "target address is private/reserved"
      );
    }

    return trimmed;
  }

  let resolved: string;

  try {
    const result = await dns.lookup(trimmed);
    resolved = result.address;
  } catch (error) {
    throw new SsrfBlockedError(
      trimmed,
      `DNS resolution failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (isPrivateAddress(resolved)) {
    throw new SsrfBlockedError(
      trimmed,
      `resolved to private/reserved address ${resolved}`
    );
  }

  return resolved;
}
