export interface ProviderEndpoints {
  kieBaseURL?: string;
  falQueueBaseURL?: string;
  elevenlabsBaseURL?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

let endpoints: ProviderEndpoints = {};

export function providerEndpoints(): ProviderEndpoints {
  return endpoints;
}

export function configureProviderEndpoints(next: ProviderEndpoints): () => void {
  const previous = endpoints;
  endpoints = { ...next };
  return () => {
    endpoints = previous;
  };
}
