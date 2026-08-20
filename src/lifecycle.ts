import { shutdownEvidenceCache } from "./evidenceCache.js";

type LifecycleProcess = Pick<NodeJS.Process, "exit" | "off" | "once">;

export function installEvidenceCacheLifecycle(
  target: LifecycleProcess = process,
  shutdown: () => void = shutdownEvidenceCache,
): () => void {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    shutdown();
  };
  const onSigint = () => {
    stop();
    target.exit(130);
  };
  const onSigterm = () => {
    stop();
    target.exit(143);
  };

  target.once("SIGINT", onSigint);
  target.once("SIGTERM", onSigterm);
  target.once("beforeExit", stop);
  target.once("exit", stop);

  return () => {
    target.off("SIGINT", onSigint);
    target.off("SIGTERM", onSigterm);
    target.off("beforeExit", stop);
    target.off("exit", stop);
  };
}
