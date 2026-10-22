import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Summaries } from "./summaries.js";
import type { FeedStore } from "./store.js";

const requestOneLine = vi.hoisted(() => vi.fn());
vi.mock("./summary-call.js", () => ({ requestOneLine }));

const CARD = {
  v: 1,
  threadId: "t1",
  task: "Ship the Feed card",
  project: "Feed",
  goals: ["Summaries know the goal"],
  builtAt: 1,
  futureField: "kept by passthrough",
};

function setup(options: { provider: string; metadata: () => Promise<unknown> }) {
  const writeSummary = vi.fn();
  const writeFailure = vi.fn();
  const store = {
    getSummary: () => null,
    writeSummary,
    writeFailure,
  } as unknown as FeedStore;
  const bb = {
    log: { info: vi.fn(), warn: vi.fn() },
    realtime: { publish: vi.fn() },
    sdk: {
      threads: {
        getPluginMetadata: vi.fn(options.metadata),
        events: { list: vi.fn(async () => []) },
      },
    },
  } as unknown as BbPluginApi;
  const summaries = new Summaries(bb, store, () => options.provider, () => "", () => undefined);
  return { bb, summaries, writeSummary, writeFailure };
}

async function summarize(options: Parameters<typeof setup>[0]) {
  const host = setup(options);
  host.summaries.start("t1", 5);
  await vi.waitFor(() => expect(host.writeSummary.mock.calls.length + host.writeFailure.mock.calls.length).toBe(1));
  return host;
}

beforeEach(() => {
  requestOneLine.mockReset();
  requestOneLine.mockResolvedValue("Done: shipped.");
});

describe("thread card in the one-line summary prompt", () => {
  it("adds the card block and its instruction with claude-code", async () => {
    const host = await summarize({ provider: "claude-code", metadata: async () => ({ card: CARD }) });
    const call = requestOneLine.mock.calls[0]![0] as { prompt: string; instructions: string };
    expect(call.prompt).toContain(
      "<thread_card>\nTask: Ship the Feed card\nProject: Feed\nGoals: Summaries know the goal\n</thread_card>",
    );
    expect(call.instructions).toContain("never a source of what was done");
    expect(host.bb.sdk.threads.getPluginMetadata).toHaveBeenCalledWith({
      threadId: "t1",
      pluginId: "followups",
    });
    expect(host.writeSummary).toHaveBeenCalledWith("t1", "Done: shipped.", 5);
  });

  it("sends no card and does not read it with codex", async () => {
    const host = await summarize({ provider: "codex", metadata: async () => ({ card: CARD }) });
    const call = requestOneLine.mock.calls[0]![0] as { prompt: string; instructions: string };
    expect(call.prompt).not.toContain("thread_card");
    expect(call.instructions).not.toContain("thread_card");
    expect(host.bb.sdk.threads.getPluginMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ["the read throws", async () => { throw new Error("no such plugin"); }],
    ["there is no card key", async () => ({})],
    ["the version is unknown", async () => ({ card: { ...CARD, v: 2 } })],
    ["the task is missing", async () => ({ card: { v: 1, goals: [] } })],
  ])("still writes the summary without a card when %s", async (_name, metadata) => {
    const host = await summarize({ provider: "claude-code", metadata });
    const call = requestOneLine.mock.calls[0]![0] as { prompt: string; instructions: string };
    expect(call.prompt).not.toContain("thread_card");
    expect(call.instructions).not.toContain("thread_card");
    expect(host.writeSummary).toHaveBeenCalledWith("t1", "Done: shipped.", 5);
    expect(host.writeFailure).not.toHaveBeenCalled();
  });
});
