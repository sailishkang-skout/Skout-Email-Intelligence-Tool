import { WarmupNotImplementedError } from "./warmupEngine.js";

export function scoreWarmupMailbox(): never {
  throw new WarmupNotImplementedError("score engine");
}
