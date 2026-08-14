/**
 * Domain warmup (planned) — separate from verification.
 *
 * Fresh domains land in spam until they build reputation. Verification already
 * tells you *whether* an address is safe to send; warmup tells you *how fast*
 * a new mailbox/domain can send.
 *
 * These modules are stubs so the folder shape is in place. They must not send
 * mail until provider policy, dummy-seed mailboxes, and throttle engines are
 * wired. Reuse SMTP/evidence from this service; do not fork verification.
 */

export class WarmupNotImplementedError extends Error {
  constructor(feature: string) {
    super(`Warmup ${feature} is not implemented yet`);
    this.name = "WarmupNotImplementedError";
  }
}

export function warmupStatus(): { enabled: boolean; phase: "scaffold" } {
  return { enabled: false, phase: "scaffold" };
}
