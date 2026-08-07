import type { FastifyInstance } from "fastify";

import {

  getDNSCacheStats,

  cleanupDNSCache,

  clearDNSCache

} from "../services/dnsCache.js";

export default async function cacheRoutes(
  app: FastifyInstance
) {

  app.get("/cache/dns", async () => {

    cleanupDNSCache();

    return {

      success: true,

      cache: getDNSCacheStats()

    };

  });

  app.delete("/cache/dns", async () => {

    clearDNSCache();

    return {

      success: true,

      message: "DNS cache cleared"

    };

  });

}