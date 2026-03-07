import type { KieProvider, KieTaskInfo } from "@nakedapi/kie";

export async function pollKieTask(
  provider: KieProvider,
  taskId: string,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<KieTaskInfo> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const taskInfo = await provider.getTask(taskId);

    if (taskInfo.state === "success" || taskInfo.state === "fail") {
      return taskInfo;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Task ${taskId} timed out after ${timeoutMs}ms`);
}
