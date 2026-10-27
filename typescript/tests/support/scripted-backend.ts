import { Usage } from "@openai/agents";
import type { ModelRequest } from "@openai/agents";
import type { ModelBackend, ModelIntent } from "../../src/models/backend.js";

/**
 * A model backend with no shaping of its own, the seam's test adapter: it records each intent an
 * agent hands it and sends every request to its base as the SDK built it.
 */
export const scriptedBackend = () => {
  const agents: ModelIntent[] = [];
  const calls: { model: string | undefined; intent: ModelIntent; request: ModelRequest }[] = [];
  const backend: ModelBackend = {
    model: (role) => `scripted-${role}`,
    agent: (_role, intent) => {
      agents.push(intent);
      return { modelSettings: { parallelToolCalls: intent.parallelToolCalls }, capabilities: [] };
    },
    provider: (_role, intentOf, base) => ({
      getModel: async (name) => {
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
    prewarm: async (_role, intent, base, run) => {
      agents.push(intent);
      await run(base);
      return new Usage();
    },
  };
  return { backend, agents, calls };
};
