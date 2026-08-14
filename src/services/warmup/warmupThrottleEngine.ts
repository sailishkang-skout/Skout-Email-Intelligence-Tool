import { WarmupNotImplementedError } from "./warmupEngine.js";

export function applyWarmupThrottle(): never {
  throw new WarmupNotImplementedError("throttle");
}
