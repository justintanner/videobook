export interface ProviderTaskStatus {
  provider: "kie" | "fal";
  model: string | null;
  taskId: string | null;
}

export function providerStatusUrl(provider: string | null, model: string | null): string | null {
  if (provider === "kie") return "https://kie.ai/logs";
  if (provider !== "fal" || !model || !/^[a-z0-9_-]+(?:\/[a-z0-9_.-]+)+$/iu.test(model)) return null;
  if (model.split("/").some((part) => part === "." || part === "..")) return null;
  return `https://fal.ai/models/${model.split("/").map(encodeURIComponent).join("/")}/requests`;
}

export function parseProviderTaskStatus(value: unknown): ProviderTaskStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.provider !== "kie" && record.provider !== "fal") return null;
  return {
    provider: record.provider,
    model: typeof record.model === "string" ? record.model : null,
    taskId: typeof record.taskId === "string" ? record.taskId : null,
  };
}
