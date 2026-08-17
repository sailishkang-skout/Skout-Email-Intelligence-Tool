import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  WarmupNotImplementedError,
  warmupStatus,
} from "../services/warmup/warmupEngine.js";
import { scheduleWarmupTick } from "../services/warmup/warmupScheduler.js";
import { extractErrorMessage } from "../utils/errorMessage.js";

/*
==================================================
WARMUP ROUTES
==================================================

HTTP surface for `src/services/warmup/*`.

IMPORTANT — read this before wiring a frontend to
these routes:

`src/services/warmup/` is a deliberate SCAFFOLD, not
a working warm-up engine. Every function in that
folder (scheduleWarmupTick, scoreWarmupMailbox,
resolveWarmupPolicy, evaluateWarmupRisk, etc.)
unconditionally throws WarmupNotImplementedError -
see warmupEngine.ts's own header comment and
docs/EXTERNAL.md's "Warmup" section:

    "Folder src/services/warmup/ is scaffold only
    (not sending mail yet)."

The only function that does not throw is
warmupStatus(), which always reports
{ enabled: false, phase: "scaffold" } regardless of
domain - there is no per-domain warm-up state yet
because nothing schedules or persists it.

These routes exist so the HTTP contract (paths,
request/response shape) can be settled and a
frontend can be built against it now, ahead of the
real engine landing. They intentionally do NOT
invent scoring/scheduling logic here - that belongs
in the warmup/* services, and per this repo's own
warning, wiring a real send path before provider
policy + throttle + mailbox provisioning exist would
be unsafe. Until then, POST /warmup/start reports
501 rather than pretending to have scheduled
anything.
==================================================
*/

const startBodySchema = z.object({
  domain: z.string().trim().min(1, "domain is required"),
  mailbox: z.string().trim().min(1).optional(),
});

const statusQuerySchema = z.object({
  domain: z.string().trim().min(1, "domain is required"),
});

export default async function warmupRoutes(app: FastifyInstance) {
  /*
  ==================================================
  POST /warmup/start
  ==================================================

  Body: { domain: string, mailbox?: string }

  Delegates to warmupScheduler's scheduleWarmupTick().
  That function is currently a stub which always
  throws WarmupNotImplementedError - this route
  surfaces that as a clean 501 rather than a raw
  crash, so callers can distinguish "not implemented
  yet" from a real 5xx failure once the engine is
  built out.
  ==================================================
  */
  app.post("/warmup/start", async (request, reply) => {
    const parsed = startBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid request body",
      });
    }

    const { domain, mailbox } = parsed.data;

    try {
      // Stub today: scheduleWarmupTick() takes no args and always
      // throws. Calling it (rather than skipping the call) keeps
      // this route wired to the real engine entrypoint so it picks
      // up real behavior automatically once warmupScheduler is
      // implemented, with no route change required.
      scheduleWarmupTick();
      // Unreachable while scheduleWarmupTick() is `(): never`, kept
      // for when the engine is implemented.
      return reply.code(202).send({
        success: true,
        domain,
        mailbox: mailbox ?? null,
        status: "scheduled",
      });
    } catch (error: unknown) {
      if (error instanceof WarmupNotImplementedError) {
        return reply.code(501).send({
          success: false,
          domain,
          mailbox: mailbox ?? null,
          error: "warmup_not_implemented",
          message: error.message,
        });
      }

      const message = extractErrorMessage(error);
      request.log.error(
        { error: message, domain, mailbox },
        "[WarmupRoute] Failed to start warmup"
      );
      return reply.code(500).send({
        success: false,
        domain,
        mailbox: mailbox ?? null,
        error: message,
      });
    }
  });

  /*
  ==================================================
  GET /warmup/status?domain=...
  ==================================================

  Returns the current warm-up state for a domain.
  Backed by warmupEngine's warmupStatus(), which is
  real (does not throw) but is not yet domain-aware -
  it always reports the scaffold-wide state because
  no per-domain scheduling/scoring exists yet. Once
  warmupScoreEngine/warmupHealthEngine are
  implemented, this handler is where their
  domain-scoped score/day-in-program output should be
  plugged in.
  ==================================================
  */
  app.get("/warmup/status", async (request, reply) => {
    const parsed = statusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid query parameters",
      });
    }

    const { domain } = parsed.data;

    try {
      const status = warmupStatus();
      return reply.code(200).send({
        success: true,
        domain,
        enabled: status.enabled,
        phase: status.phase,
        score: null,
        dayInProgram: null,
      });
    } catch (error: unknown) {
      const message = extractErrorMessage(error);
      request.log.error(
        { error: message, domain },
        "[WarmupRoute] Failed to read warmup status"
      );
      return reply.code(500).send({
        success: false,
        domain,
        error: message,
      });
    }
  });
}
