import { WarmupNotImplementedError } from "./warmupEngine.js";

export function resolveWarmupPolicy(): never {
  throw new WarmupNotImplementedError("policy");
}
