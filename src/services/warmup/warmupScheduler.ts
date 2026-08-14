import { WarmupNotImplementedError } from "./warmupEngine.js";

export function scheduleWarmupTick(): never {
  throw new WarmupNotImplementedError("scheduler");
}
