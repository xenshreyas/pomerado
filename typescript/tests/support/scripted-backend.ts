import { Usage } from "@openai/agents";
import type { ModelRequest } from "@openai/agents";
import type { BackendFeatures, ModelBackend, ModelIntent } from "../../src/models/backend.js";

/**
 * A model backend with no shaping of its own, the seam's test adapter: it records each intent an
 * agent hands it and sends every request to its base as the SDK built it. It has every feature
 * and a prewarm unless `features` or `prewarm` is false.
 */
export const scriptedBackend = (
  options: { readonly features?: boolean; readonly prewarm?: boolean } = {},
) => {
  const agents: ModelIntent[] = [];
  const calls: { model: string | undefined; intent: ModelIntent; request: ModelRequest }[] = [];
  const features: BackendFeatures = {
    backgroundCompaction: options.features !== false,
    cacheDiagnostics: options.features !== false,
    effortChangeKeepsCache: options.features !== false,
  };
  const backend: ModelBackend = {
    id: "scripted",
    model: (role) => `scripted-${role}`,
    agent: (_role, intent) => {
      agents.push(intent);
      return { modelSettings: { parallelToolCalls: intent.parallelToolCalls }, capabilities: [] };
    },
    provider: (_role, intentOf, base) => ({
      getModel: async (name) => {
        if (base === undefined) throw new Error("A scripted backend calls the host's provider");
        const model = await base.getModel(name);
        return {
          getResponse: (request) => {
            calls.push({ model: name, intent: intentOf(request), request });
            return model.getResponse(request);
          },
          getStreamedResponse: (request) => model.getStreamedResponse(request),
        };
      },
    }),
    features,
    ...(options.prewarm === false
      ? {}
      : {
          // A prewarm is the run's ordinary request, which the provider records.
          prewarm: async (role, intent, base, run) => {
            await run(backend.provider(role, () => intent, base));
            return new Usage();
          },
        }),
  };
  return { backend, agents, calls };
};
