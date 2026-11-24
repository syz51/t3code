import * as NodeOS from "node:os";

const AGENT_NICE_INCREMENT = 10;

/**
 * Agents' builds and tests inherit this, so many threads at once slow each other down
 * instead of starving the server and clients that drive them.
 */
export function lowerAgentProcessPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    NodeOS.setPriority(pid, Math.min(19, NodeOS.getPriority() + AGENT_NICE_INCREMENT));
  } catch {
    // The process already exited, or the platform refuses; it then keeps the server's priority.
  }
}
