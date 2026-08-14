import { describe, expect, it } from "vitest";
import { warmupStatus } from "./warmupEngine.js";

describe("warmup scaffold", () => {
  it("is disabled until the engine is implemented", () => {
    expect(warmupStatus()).toEqual({ enabled: false, phase: "scaffold" });
  });
});
