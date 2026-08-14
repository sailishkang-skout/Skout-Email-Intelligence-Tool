import { WarmupNotImplementedError } from "./warmupEngine.js";

export function providerWarmupCaps(): never {
  throw new WarmupNotImplementedError("provider policy");
}
