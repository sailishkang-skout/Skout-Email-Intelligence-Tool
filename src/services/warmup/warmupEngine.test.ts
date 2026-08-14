import { test } from "node:test";
import assert from "node:assert/strict";

import { warmupStatus } from "./warmupEngine.js";

test("warmup scaffold: is disabled until the engine is implemented", () => {
  assert.deepEqual(warmupStatus(), { enabled: false, phase: "scaffold" });
});
