import { z } from "zod";
import type { BbPluginApi, PluginThreadEventName } from "@get-bb/plugin-sdk";
import {
  boundedErrorText,
  isMissingThreadError,
  isQuiet,
  STALE_MANAGER_MESSAGE,
} from "./backend-utils.js";
import { rpcContract } from "./contract.js";
import {
  configurationProblem,
  FeedService,
  type FeedSettings,
} from "./feed-service.js";
import { FeedStore, readRetiredSummarizerId, SCHEMA_STATEMENTS } from "./store.js";
import { DEFAULT_SUMMARY_STYLE, Summaries } from "./summaries.js";
import { DEFAULT_SUMMARIZER_PROVIDER, SUMMARIZER_PROVIDER_IDS } from "./summary-call.js";

const managerThreadIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, "Manager thread ID is required");

const markParameters = z
  .object({ threadId: z.string().min(1).max(200) })
  .strict();

function managerInstructions(settings: FeedSettings): string {
  return [
    "Feed is active for this manager thread.",
    `Spawn new work as root threads in the children section by default: pass \`--section ${settings.childrenSectionId?.trim() ?? ""}\` and no parent.`,
    "After each result of a managed child, either answer the child or call feed_mark with its thread ID. Never both in one turn. You do not write summaries; the Feed writes every row's line itself.",
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    managerThreadId: {
      type: "string",
      label: "Manager thread ID",
      description: "The one manager thread that owns this Feed.",
      experimental_schema: managerThreadIdSchema,
    },
    userManagedSectionId: {
      type: "string",
      label: "User managed section ID",
      description:
        "Sidebar section for threads you talk to yourself. Its root threads show in the Feed with a star.",
    },
    childrenSectionId: {
      type: "string",
      label: "Children section ID",
      description:
        "Sidebar section for threads the manager starts. Its root threads show in the Feed.",
    },
    summarizerProvider: {
      type: "select",
      label: "Summarizer provider",
      description:
        "Where the one-line summary call runs: codex uses the local Codex login, claude-code runs the local claude CLI.",
      options: [...SUMMARIZER_PROVIDER_IDS],
      default: DEFAULT_SUMMARIZER_PROVIDER,
    },
    summarizerModel: {
      type: "string",
      label: "Summarizer model",
      description:
        "Model for the one-line summary call. Empty uses the provider's default: gpt-6-luna for codex, claude-haiku-5-5 for claude-code.",
    },
    summaryInstructions: {
      type: "string",
      label: "Summary instructions",
      description:
        "Style of the one-line summary: who to speak to, what to put first, tone, and length. Empty uses the default. The transcript framing and the 240-character cut always apply.",
      default: DEFAULT_SUMMARY_STYLE,
    },
  });
  // The SDK requires synchronous agent configuration, so keep this cache current through onChange.
  let currentSettings: FeedSettings = await settings.get();

  const database = bb.storage.database();
  const retiredSummarizerId = readRetiredSummarizerId(database);
  bb.storage.migrate(database, SCHEMA_STATEMENTS);
  const store = new FeedStore(database);
  const summaries = new Summaries(
    bb,
    store,
    () => currentSettings.summarizerProvider?.trim() || DEFAULT_SUMMARIZER_PROVIDER,
    () => currentSettings.summarizerModel ?? "",
    () => currentSettings.summaryInstructions,
  );
  const service = new FeedService(bb, store, () => settings.get(), (threadId, seq) =>
    summaries.start(threadId, seq),
  );

  const initialProblem = configurationProblem(currentSettings);
  if (initialProblem !== null) bb.status.needsConfiguration(initialProblem);

  async function inspectManager(next: FeedSettings): Promise<void> {
    const managerThreadId = next.managerThreadId?.trim();
    if (!managerThreadId) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId: managerThreadId });
      if (thread.archivedAt === null && thread.deletedAt === null) return;
    } catch (error) {
      bb.log.warn(
        `Configured manager ${managerThreadId} lookup failed: ${boundedErrorText(error)}`,
      );
      if (!isMissingThreadError(error)) return;
    }
    bb.log.warn(`${STALE_MANAGER_MESSAGE} Manager: ${managerThreadId}.`);
    bb.status.needsConfiguration(STALE_MANAGER_MESSAGE);
  }

  // Plugin promises that reject unobserved crash the BB server, and a reloaded plugin's stale handle throws on every call.
  function guarded(work: () => unknown): Promise<void> {
    return (async () => {
      await work();
    })().catch((error: unknown) => {
      try {
        bb.log.warn(`Feed background step failed: ${boundedErrorText(error)}`);
      } catch {
        // A stale handle cannot log either.
      }
    });
  }

  function inBackground(work: () => unknown): void {
    void guarded(work);
  }

  await inspectManager(currentSettings);
  if (retiredSummarizerId !== null) {
    // The summarizer thread of an earlier version; its ID is gone after the migrations.
    inBackground(async () => {
      try {
        await bb.sdk.threads.archive({ threadId: retiredSummarizerId });
      } catch (error) {
        if (!isMissingThreadError(error)) throw error;
      }
    });
  }

  settings.onChange((next) => {
    currentSettings = next;
    inBackground(() => {
      bb.realtime.publish("feed-invalidated", {
        threadId: next.managerThreadId ?? "",
        reason: "settings-changed",
      });
      inBackground(() => inspectManager(next));
      const problem = configurationProblem(next);
      if (problem !== null) bb.status.needsConfiguration(problem);
    });
  });

  let clearInProgress = false;

  async function clearManager(
    surfaceThreadId: string,
  ): Promise<{ cleared: true }> {
    if (clearInProgress) {
      throw new Error("Manager context is already being cleared.");
    }
    clearInProgress = true;
    try {
      const managerId = await service.authorize(surfaceThreadId);
      const manager = await bb.sdk.threads.get({ threadId: managerId });
      if (!(await isQuiet(bb.sdk, manager))) {
        throw new Error(
          "The manager must be idle with no queued work or pending interaction to clear context.",
        );
      }
      await bb.sdk.threads.clearContext({ threadId: managerId });
      await bb.sdk.threads.send({
        threadId: managerId,
        mode: "auto",
        input: [{
          type: "text",
          mentions: [],
          text: [
            "[feed] Your context was cleared. Load the feed skill and follow it. This thread is already bound, so skip the Bind step.",
            `Run \`bb feed show\`, then run \`bb thread history ${managerId} --limit 5\` to read the user's 5 most recent messages. Reply in one line that you are ready.`,
          ].join("\n\n"),
        }],
      });
      return { cleared: true };
    } finally {
      clearInProgress = false;
    }
  }

  bb.cli.register({
    name: "feed",
    summary: "Read the Feed",
    commands: [{
      name: "show",
      summary: "Show Feed rows",
      usage: "bb feed show [--json]",
    }],
    async run(argv, ctx) {
      if (
        argv[0] !== "show" ||
        argv.length > 2 ||
        (argv.length === 2 && argv[1] !== "--json")
      ) {
        return {
          exitCode: 2,
          stderr: "Usage: bb feed show [--json]\n",
        };
      }
      try {
        const snapshot = await service.snapshot(ctx.threadId ?? "");
        const rows = snapshot.rows.map((row) => ({
          id: row.id,
          title: row.title,
          section: row.section,
          state: row.state,
          status: row.statusLabel,
          starred: row.starred,
          managedChild: row.managedChild,
          oneLine: row.oneLine,
          summarizing: row.summarizing,
          latestMessage: row.latestMessage,
        }));
        const stdout = argv[1] === "--json"
          ? `${JSON.stringify(rows)}\n`
          : `ID\tTITLE\tSECTION\tSTATE\tSTATUS\tSTARRED\tMANAGED\tSUMMARY\n${rows
              .map((row) =>
                [
                  row.id,
                  row.title,
                  row.section,
                  row.state,
                  row.status,
                  row.starred,
                  row.managedChild,
                  row.oneLine,
                ]
                  .map((value) => JSON.stringify(value))
                  .join("\t"),
              )
              .join("\n")}\n`;
        if (Buffer.byteLength(stdout) > 900_000) {
          return { exitCode: 1, stderr: "Feed output is too large.\n" };
        }
        return { exitCode: 0, stdout };
      } catch (error) {
        return { exitCode: 1, stderr: `${boundedErrorText(error)}\n` };
      }
    },
  });

  bb.rpc.register(rpcContract, {
    clearManager: ({ surfaceThreadId }) => clearManager(surfaceThreadId),
    canOpen: ({ surfaceThreadId }) => service.canOpen(surfaceThreadId),
    queueSnapshot: ({ surfaceThreadId }) => service.snapshot(surfaceThreadId),
    setPaused: (input) => service.setPaused(input),
    detach: (input) => service.detach(input),
    moveSection: (input) => service.moveSection(input),
    archiveThread: (input) => service.archiveThread(input),
    sendReply: (input) => service.sendReply(input),
  });

  bb.agents.registerTool({
    name: "feed_mark",
    description:
      "Mark the latest result of a managed child of this manager thread as needs_response.",
    instructions:
      "Use when the user must act on a managed child's latest result. Calls accepted by the parameter schema return a JSON object with outcome updated, not_configured, wrong_caller, not_managed_child, or runtime_error.",
    presentation: {
      label: {
        pending: "Marking Feed row",
        completed: "Marked Feed row",
      },
    },
    parameters: markParameters,
    async execute({ threadId }, context) {
      try {
        return await service.writeMark({
          callerThreadId: context.threadId,
          threadId,
        });
      } catch {
        return JSON.stringify({ outcome: "runtime_error" });
      }
    },
  });

  bb.agents.configure((context) => {
    if (context.thread.id !== currentSettings.managerThreadId?.trim()) {
      return { tools: [], skills: ["feed"] };
    }
    return {
      tools: ["feed_mark"],
      skills: ["feed"],
      instructions: managerInstructions(currentSettings),
    };
  });

  function configuredManagerId(): string | undefined {
    return currentSettings.managerThreadId?.trim() || undefined;
  }

  async function publishOwningRow(threadId: string, reason: string) {
    try {
      const owner = await service.findOwningRow(threadId);
      if (owner !== null) service.publish(owner, reason);
    } catch {
      // Missing or stale configuration has no authorized Feed to invalidate.
    }
  }

  /** R8: a message sent after the pause ends it; a provider's own follow-up turn has no turn request. */
  async function unpauseOnMessage(threadId: string): Promise<void> {
    const pausedAt = store.getPausedAt(threadId);
    if (pausedAt === null) return;
    const [request] = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "desc",
      limit: "1",
    });
    if (request === undefined || request.createdAt < pausedAt) return;
    store.setPaused(threadId, false);
    service.publish(threadId, "unpaused");
  }

  async function onThreadIdle(threadId: string): Promise<void> {
    if (configurationProblem(currentSettings) !== null) return;
    if (!(await service.isFeedThread(threadId))) return;
    const { seq } = await service.latestCompletion(threadId);
    summaries.start(threadId, seq);
  }

  bb.background.service("thread-change-listener", {
    start: (signal) => guarded(async () => {
      const unsubscribe = bb.sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          const threadId = event.id;
          if (
            threadId !== undefined &&
            (event.changes.includes("terminals-changed") ||
              event.changes.includes("title-changed") ||
              event.changes.includes("order-changed") ||
              event.metadata?.backgroundActivityChanged === true)
          ) {
            inBackground(() => publishOwningRow(threadId, "thread-changed"));
          }
        },
      });
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
          } else {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
      } finally {
        unsubscribe();
      }
    }),
  });

  function registerThreadEvent(
    event: Extract<
      PluginThreadEventName,
      | "thread.created"
      | "thread.active"
      | "thread.idle"
      | "thread.failed"
      | "thread.archived"
      | "thread.deleted"
    >,
  ): void {
    bb.events.on(event, ({ thread }) => guarded(async () => {
      const managerThreadId = configuredManagerId();
      if (
        thread.id === managerThreadId &&
        (thread.archivedAt !== null || thread.deletedAt !== null)
      ) {
        const message = `Configured manager ${thread.id} is archived or deleted.`;
        bb.log.warn(message);
        bb.status.needsConfiguration(message);
      }
      try {
        if (event === "thread.idle") await onThreadIdle(thread.id);
        if (event === "thread.active") await unpauseOnMessage(thread.id);
      } catch (error) {
        bb.log.warn(`Feed ${event} handling failed: ${boundedErrorText(error)}`);
      }
      if (event === "thread.archived" || event === "thread.deleted") {
        // An archived or deleted thread is no longer a feed thread, so check its last shape.
        const wasFeedThread = service.isFeedThreadResponse(
          { ...thread, archivedAt: null, deletedAt: null },
          currentSettings,
        );
        if (wasFeedThread) {
          service.publish(thread.id, event);
          return;
        }
      }
      await publishOwningRow(thread.id, event);
    }));
  }

  registerThreadEvent("thread.created");
  registerThreadEvent("thread.active");
  registerThreadEvent("thread.idle");
  registerThreadEvent("thread.failed");
  registerThreadEvent("thread.archived");
  registerThreadEvent("thread.deleted");
  bb.events.on("message.queued", ({ entry }) =>
    guarded(() => publishOwningRow(entry.threadId, "message.queued")),
  );
  bb.events.on("message.dispatched", ({ entry }) =>
    guarded(() => publishOwningRow(entry.threadId, "message.dispatched")),
  );
  bb.events.on("turn.failed", ({ threadId }) =>
    guarded(() => publishOwningRow(threadId, "turn.failed")),
  );
}
