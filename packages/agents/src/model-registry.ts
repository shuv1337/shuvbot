export interface ModelAlias {
  slug: string;
  provider: "anthropic" | "direct";
  model: string;
}

export type ResolvedModel = ModelAlias;

export const MODEL_ALIASES: Record<string, ModelAlias> = {
  "claude/sonnet": {
    slug: "claude/sonnet",
    provider: "anthropic",
    model: "claude-sonnet-4-5"
  },
  "claude/opus": {
    slug: "claude/opus",
    provider: "anthropic",
    model: "claude-opus-4-1"
  }
};

export function resolveModelId(value: string): ModelAlias {
  return MODEL_ALIASES[value] ?? { slug: value, provider: "direct", model: value };
}

export function resolveModel(value: string): ResolvedModel {
  return resolveModelId(value);
}
