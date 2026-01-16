import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { monitorSignalProvider } from "./monitor.js";

const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();
let config: Record<string, unknown> = {};
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
});

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
}));

const streamMock = vi.fn();
const signalCheckMock = vi.fn();
const signalRpcRequestMock = vi.fn();

vi.mock("./client.js", () => ({
  streamSignalEvents: (...args: unknown[]) => streamMock(...args),
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./daemon.js", () => ({
  spawnSignalDaemon: vi.fn(() => ({ stop: vi.fn() })),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOT_ACCOUNT = "+15559990000";
const BOT_UUID = "bot-uuid-1234";
const SENDER_NUMBER = "+15550001111";
const GROUP_ID = "group-abc-123";

beforeEach(() => {
  resetInboundDedupe();
  config = {
    channels: {
      signal: {
        autoStart: false,
        account: BOT_ACCOUNT,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groupAllowFrom: ["*"],
      },
    },
  };
  sendMock.mockReset().mockResolvedValue(undefined);
  replyMock.mockReset().mockResolvedValue({ text: "reply" });
  updateLastRouteMock.mockReset();
  streamMock.mockReset();
  signalCheckMock.mockReset().mockResolvedValue({ account: BOT_ACCOUNT, uuid: BOT_UUID });
  signalRpcRequestMock.mockReset().mockResolvedValue({});
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
});

function makeGroupMessage(opts: {
  message?: string;
  mentions?: Array<{ number?: string; uuid?: string; name?: string }>;
}) {
  return {
    envelope: {
      sourceNumber: SENDER_NUMBER,
      sourceName: "TestUser",
      timestamp: Date.now(),
      dataMessage: {
        message: opts.message ?? "hello",
        groupInfo: {
          groupId: GROUP_ID,
          groupName: "Test Group",
        },
        mentions: opts.mentions,
      },
    },
  };
}

describe("Signal requireMention group gating", () => {
  it("skips group message when requireMention=true and bot not mentioned", async () => {
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(makeGroupMessage({ message: "hello" })),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    expect(replyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("processes group message when mentioned via number", async () => {
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(
          makeGroupMessage({
            message: "@Bot hello",
            mentions: [{ number: BOT_ACCOUNT }],
          }),
        ),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    expect(replyMock).toHaveBeenCalled();
  });

  // Note: UUID-based mention detection requires the signal-cli UUID to be passed
  // as accountId, which currently comes from config (routing key) not signal-cli.
  // This test uses a workaround where accountId matches the mention UUID.
  it("processes group message when mentioned via uuid (with matching accountId)", async () => {
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(
          makeGroupMessage({
            message: "@Bot hello",
            mentions: [{ uuid: BOT_UUID }],
          }),
        ),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
      // Pass the UUID as accountId to simulate the lookup
      accountId: BOT_UUID,
    });

    await flush();
    expect(replyMock).toHaveBeenCalled();
  });

  it("processes group message when text matches mention regex", async () => {
    config = {
      ...config,
      messages: {
        groupChat: {
          mentionPatterns: ["@clawdbot", "clawdbot"],
        },
      },
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(
          makeGroupMessage({
            message: "hey @clawdbot what's up",
            mentions: [], // No native mentions
          }),
        ),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    expect(replyMock).toHaveBeenCalled();
  });

  it("processes all group messages when requireMention=false", async () => {
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            "*": { requireMention: false },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(makeGroupMessage({ message: "hello" })),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    expect(replyMock).toHaveBeenCalled();
  });

  it("blocks all messages when enabled=false regardless of mention", async () => {
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            [GROUP_ID]: { enabled: false, requireMention: false },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(
          makeGroupMessage({
            message: "@Bot hello",
            mentions: [{ number: BOT_ACCOUNT }],
          }),
        ),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("applies wildcard config as default", async () => {
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      // Message to a group not explicitly configured - should use "*" default
      await onEvent({
        event: "receive",
        data: JSON.stringify(makeGroupMessage({ message: "hello" })),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    // Wildcard requireMention=true should block since no mention
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("group-specific config overrides wildcard", async () => {
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          groups: {
            "*": { requireMention: true },
            [GROUP_ID]: { requireMention: false },
          },
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(makeGroupMessage({ message: "hello" })),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    // Group-specific requireMention=false should allow the message
    expect(replyMock).toHaveBeenCalled();
  });

  it("defaults to requireMention=true when no groups config", async () => {
    // No groups config at all - default behavior should be requireMention=true
    config = {
      ...config,
      channels: {
        signal: {
          ...config.channels?.signal,
          // No groups config
        },
      },
    };

    const abortController = new AbortController();
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify(makeGroupMessage({ message: "hello" })),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();
    // Default requireMention=true should block since no mention
    expect(replyMock).not.toHaveBeenCalled();
  });
});
