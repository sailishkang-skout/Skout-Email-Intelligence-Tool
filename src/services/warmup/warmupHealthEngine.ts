import { WarmupNotImplementedError } from "./warmupEngine.js";

export function computeWarmupHealth(): never {
  throw new WarmupNotImplementedError("health engine");
}
