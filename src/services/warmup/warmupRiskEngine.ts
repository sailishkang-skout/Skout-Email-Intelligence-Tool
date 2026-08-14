import { WarmupNotImplementedError } from "./warmupEngine.js";

export function evaluateWarmupRisk(): never {
  throw new WarmupNotImplementedError("risk engine");
}
