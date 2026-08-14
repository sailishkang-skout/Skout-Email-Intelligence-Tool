import { WarmupNotImplementedError } from "./warmupEngine.js";

export function monitorWarmupDelivery(): never {
  throw new WarmupNotImplementedError("delivery monitor");
}
