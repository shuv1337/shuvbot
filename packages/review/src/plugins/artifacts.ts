import type { ResolvedReviewPluginConfig, ReviewPlugin } from "./types.ts";

export interface ArtifactsPluginOptions {
  readonly critical?: boolean;
  readonly onConfigured?: (config: ResolvedReviewPluginConfig) => Promise<void>;
}

// Artifact writing is deliberately injected until the run artifact contract lands in M5.
export function createArtifactsPlugin(options: ArtifactsPluginOptions = {}): ReviewPlugin {
  return {
    id: "artifacts",
    postConfigureCritical: options.critical ?? false,
    async postConfigure({ config }) {
      await options.onConfigured?.(config);
    }
  };
}
