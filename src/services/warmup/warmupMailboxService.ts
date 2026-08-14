import { WarmupNotImplementedError } from "./warmupEngine.js";

export function provisionWarmupMailbox(): never {
  throw new WarmupNotImplementedError("mailbox");
}
