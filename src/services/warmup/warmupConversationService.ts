import { WarmupNotImplementedError } from "./warmupEngine.js";

export function runWarmupConversation(): never {
  throw new WarmupNotImplementedError("conversation");
}
