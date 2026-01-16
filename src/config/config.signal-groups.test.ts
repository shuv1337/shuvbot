import { describe, expect, it, vi } from "vitest";

describe("Signal groups config validation", () => {
  it("preserves signal.groups config after validation", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: {
        signal: {
          groups: {
            "*": { requireMention: true },
            "group-123": { requireMention: false, enabled: true },
            "group-456": { enabled: false, allowFrom: ["+15550001111"] },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.signal?.groups).toBeDefined();
      expect(res.config.channels?.signal?.groups?.["*"]?.requireMention).toBe(true);
      expect(res.config.channels?.signal?.groups?.["group-123"]?.requireMention).toBe(false);
      expect(res.config.channels?.signal?.groups?.["group-123"]?.enabled).toBe(true);
      expect(res.config.channels?.signal?.groups?.["group-456"]?.enabled).toBe(false);
      expect(res.config.channels?.signal?.groups?.["group-456"]?.allowFrom).toEqual([
        "+15550001111",
      ]);
    }
  });

  it("preserves signal.accounts[].groups config after validation", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: {
        signal: {
          account: "+15559990000",
          accounts: {
            work: {
              account: "+15559991111",
              groups: {
                "*": { requireMention: false },
                "work-group": { requireMention: true },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.signal?.accounts?.work?.groups).toBeDefined();
      expect(res.config.channels?.signal?.accounts?.work?.groups?.["*"]?.requireMention).toBe(
        false,
      );
      expect(
        res.config.channels?.signal?.accounts?.work?.groups?.["work-group"]?.requireMention,
      ).toBe(true);
    }
  });

  it("accepts signal groups with allowFrom array", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: {
        signal: {
          groups: {
            "group-abc": {
              requireMention: true,
              allowFrom: ["+15550001111", "+15550002222", "*"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.signal?.groups?.["group-abc"]?.allowFrom).toEqual([
        "+15550001111",
        "+15550002222",
        "*",
      ]);
    }
  });
});
