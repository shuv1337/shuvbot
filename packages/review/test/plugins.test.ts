import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../core/src/config.ts";
import {
  createReviewerConfigPlugin,
  reviewerTierAssignments
} from "../src/plugins/reviewer-config.ts";
import { runReviewPlugins } from "../src/plugins/runner.ts";
import type { ReviewPlugin } from "../src/plugins/types.ts";

describe("review plugin runner", () => {
  test("runs bootstrap concurrently and records non-fatal failures", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const plugins: ReviewPlugin[] = ["one", "two"].map((id) => ({
      id,
      async bootstrap() {
        started += 1;
        if (started === 2) release();
        await gate;
        if (id === "one") throw new Error("bootstrap failed");
      }
    }));

    const result = await runReviewPlugins({ plugins });
    expect(started).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      pluginId: "one",
      phase: "bootstrap",
      error: { message: "bootstrap failed" }
    });
  });

  test("runs configure sequentially and fails fast", async () => {
    const calls: string[] = [];
    const plugins: ReviewPlugin[] = [
      {
        id: "one",
        async configure() {
          calls.push("one");
        }
      },
      {
        id: "two",
        async configure() {
          calls.push("two");
          throw new Error("fatal");
        }
      },
      {
        id: "three",
        async configure() {
          calls.push("three");
        }
      }
    ];

    await expect(runReviewPlugins({ plugins })).rejects.toThrow("fatal");
    expect(calls).toEqual(["one", "two"]);
  });

  test("assembles six built-ins with tier assignments and no escaping mutable references", async () => {
    const reviewConfig = structuredClone(DEFAULT_CONFIG.review);
    const result = await runReviewPlugins({
      plugins: [createReviewerConfigPlugin(reviewConfig)],
      tierAssignments: reviewerTierAssignments(reviewConfig)
    });

    expect(result.config.reviewers).toHaveLength(6);
    expect(result.config.tiers.full).toHaveLength(6);
    expect(
      result.config.reviewers.every((reviewer) => reviewer.model === "subscription/default-coding")
    ).toBe(true);
    expect(result.config.reviewers.every((reviewer) => reviewer.modelOverride === false)).toBe(
      true
    );
    expect(Object.isFrozen(result.config.reviewers[0]?.tools)).toBe(true);
    reviewConfig.tiers.full.reviewers.length = 0;
    expect(result.config.tiers.full).toHaveLength(6);
    expect(() => (result.config.tiers.full as string[]).push("tests")).toThrow();
  });

  test("rejects duplicate IDs and unknown reviewer assignments", async () => {
    const duplicateProvider: ReviewPlugin = {
      id: "duplicate-provider",
      async configure(ctx) {
        ctx.registerProvider({ id: "provider", models: ["model"] });
        ctx.registerProvider({ id: "provider", models: ["model"] });
      }
    };
    await expect(runReviewPlugins({ plugins: [duplicateProvider] })).rejects.toThrow(
      "Duplicate provider ID: provider"
    );

    const duplicateReviewer: ReviewPlugin = {
      id: "duplicate-reviewer",
      async configure(ctx) {
        const reviewer = { id: "tests" as const, name: "Tests", description: "Tests" };
        ctx.registerReviewer(reviewer);
        ctx.registerReviewer(reviewer);
      }
    };
    await expect(runReviewPlugins({ plugins: [duplicateReviewer] })).rejects.toThrow(
      "Duplicate reviewer ID: tests"
    );

    await expect(
      runReviewPlugins({ plugins: [], tierAssignments: { trivial: ["tests"] } })
    ).rejects.toThrow("Unknown reviewer in trivial tier: tests");
  });

  test("repository model overrides cannot register arbitrary providers", async () => {
    const reviewConfig = structuredClone(DEFAULT_CONFIG.review);
    reviewConfig.models.standard = "openai/codex";
    await expect(
      runReviewPlugins({ plugins: [createReviewerConfigPlugin(reviewConfig)] })
    ).rejects.toThrow("subscription provider");

    // A model the configuration selects for a role is accepted here and settled
    // against the runtime's catalog when the review resolves its models.
    reviewConfig.models.standard = "subscription/anthropic:claude-sonnet-4-5";
    await expect(
      runReviewPlugins({ plugins: [createReviewerConfigPlugin(reviewConfig)] })
    ).resolves.toBeDefined();

    reviewConfig.models.standard = "subscription/default-coding";
    reviewConfig.reviewers = [
      {
        id: "security",
        paths: ["**/*"],
        ignorePaths: [],
        promptAppend: "",
        model: "subscription/not-configured-anywhere"
      }
    ];
    await expect(
      runReviewPlugins({ plugins: [createReviewerConfigPlugin(reviewConfig)] })
    ).rejects.toThrow("Unknown review model");
    reviewConfig.reviewers = [];

    reviewConfig.models.standard = "subscription/default-coding";
    reviewConfig.reviewers = [
      {
        id: "security",
        paths: ["**/*"],
        ignorePaths: [],
        promptAppend: "",
        model: "openai/codex"
      }
    ];
    await expect(
      runReviewPlugins({ plugins: [createReviewerConfigPlugin(reviewConfig)] })
    ).rejects.toThrow("subscription provider");
  });

  test("preserves explicit standard-model override provenance", async () => {
    const reviewConfig = structuredClone(DEFAULT_CONFIG.review);
    reviewConfig.reviewers = [
      {
        id: "code-quality",
        paths: ["**/*"],
        ignorePaths: [],
        promptAppend: "",
        model: reviewConfig.models.standard
      }
    ];
    const result = await runReviewPlugins({
      plugins: [createReviewerConfigPlugin(reviewConfig)]
    });

    expect(result.config.reviewers.find(({ id }) => id === "code-quality")).toMatchObject({
      model: reviewConfig.models.standard,
      modelOverride: true
    });
    expect(result.config.reviewers.find(({ id }) => id === "security")?.modelOverride).toBe(false);
  });

  test("tool contributions only narrow the read-only baseline", async () => {
    const plugin = configuredPlugin((ctx) => {
      ctx.restrictReviewerTools("tests", ["filesystem.read", "git.diff"]);
      ctx.restrictReviewerTools("tests", ["filesystem.read"]);
    });
    const result = await runReviewPlugins({ plugins: [plugin] });
    expect(result.config.reviewers[0]?.tools).toEqual(["filesystem.read"]);

    const widening = configuredPlugin((ctx) => {
      ctx.restrictReviewerTools("tests", ["filesystem.read", "shell.execute"]);
    });
    await expect(runReviewPlugins({ plugins: [widening] })).rejects.toThrow(
      "attempts to grant shell.execute"
    );

    const regrant = configuredPlugin((ctx) => {
      ctx.restrictReviewerTools("tests", ["filesystem.read"]);
      ctx.restrictReviewerTools("tests", ["filesystem.read", "git.diff"]);
    });
    await expect(runReviewPlugins({ plugins: [regrant] })).rejects.toThrow(
      "attempts to grant git.diff"
    );
  });

  test("postConfigure observes frozen config and honors criticality", async () => {
    let frozen = false;
    const base = configuredPlugin(() => undefined);
    const optional: ReviewPlugin = {
      id: "optional",
      async postConfigure({ config }) {
        frozen = Object.isFrozen(config) && Object.isFrozen(config.reviewers);
        throw new Error("optional failure");
      }
    };
    const result = await runReviewPlugins({ plugins: [base, optional] });
    expect(frozen).toBe(true);
    expect(result.failures).toHaveLength(1);

    await expect(
      runReviewPlugins({
        plugins: [base, { ...optional, id: "critical", postConfigureCritical: true }]
      })
    ).rejects.toThrow("optional failure");
  });
});

function configuredPlugin(
  contribution: Parameters<NonNullable<ReviewPlugin["configure"]>>[0] extends infer Context
    ? (ctx: Context) => void
    : never
): ReviewPlugin {
  return {
    id: "configured",
    async configure(ctx) {
      ctx.registerProvider({ id: "provider", models: ["model"] });
      ctx.registerReviewer({ id: "tests", name: "Tests", description: "Tests" });
      ctx.setReviewerModel("tests", "provider/model");
      contribution(ctx);
    }
  };
}
