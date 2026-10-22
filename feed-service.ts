import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  boundedErrorText,
  isMissingThreadError,
  STALE_MANAGER_MESSAGE,
  type ThreadResponse,
} from "./backend-utils.js";
import type { FeedRow } from "./contract.js";
import { projectFeed, type ThreadFacts } from "./projection.js";
import type { FeedStore } from "./store.js";
import { latestAgentMessage } from "./summaries.js";

type ThreadListEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];
type ThreadShape = Pick<
  ThreadResponse,
  | "id"
  | "parentThreadId"
  | "sectionId"
  | "visibility"
  | "archivedAt"
  | "deletedAt"
>;

const LOOKUP_CONCURRENCY = 8;
const PAGE_SIZE = 100;

export interface FeedSettings {
  managerThreadId: string | undefined;
  userManagedSectionId: string | undefined;
  childrenSectionId: string | undefined;
  summarizerProvider: string | undefined;
  summarizerModel: string | undefined;
  summaryInstructions: string | undefined;
}

export interface FeedSnapshot {
  managerThreadId: string;
  sectionNames: { userManaged: string; children: string };
  rows: FeedRow[];
}

interface FeedEntry {
  thread: ThreadListEntry;
  managedChild: boolean;
  inUserManagedSection: boolean;
}

type MarkOutcome =
  | "updated"
  | "not_configured"
  | "wrong_caller"
  | "not_managed_child"
  | "runtime_error";

function markResult(
  outcome: MarkOutcome,
  details: Record<string, string | number> = {},
): string {
  return JSON.stringify({ outcome, ...details });
}

/** Names the first missing or invalid required setting, or null when complete. */
export function configurationProblem(settings: FeedSettings): string | null {
  const required: Array<[keyof FeedSettings, string]> = [
    ["managerThreadId", "managerThreadId"],
    ["userManagedSectionId", "userManagedSectionId"],
    ["childrenSectionId", "childrenSectionId"],
  ];
  const missing = required
    .filter(([key]) => !settings[key]?.trim())
    .map(([, name]) => name);
  if (missing.length > 0) {
    return `Set ${missing.join(", ")} in the Feed plugin settings.`;
  }
  if (
    settings.userManagedSectionId!.trim() === settings.childrenSectionId!.trim()
  ) {
    return "Set userManagedSectionId and childrenSectionId to two different sections.";
  }
  return null;
}

function requiredManager(settings: FeedSettings): string {
  const managerThreadId = settings.managerThreadId?.trim();
  if (!managerThreadId) {
    throw new Error("Feed is not configured. Set managerThreadId.");
  }
  return managerThreadId;
}

function configuredSections(settings: FeedSettings): string[] {
  return [settings.userManagedSectionId, settings.childrenSectionId]
    .map((sectionId) => sectionId?.trim())
    .filter((sectionId): sectionId is string => Boolean(sectionId));
}

async function boundedMap<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (let index = nextIndex++; index < items.length; index = nextIndex++) {
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_CONCURRENCY, items.length) }, worker),
  );
  return results;
}

export class FeedService {
  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: FeedStore,
    private readonly readSettings: () => Promise<FeedSettings>,
    private readonly onResultSeen: (threadId: string, resultSeq: number) => void,
  ) {}

  /** R4: managed children plus visible root threads in the two configured sections. */
  isFeedThreadResponse(thread: ThreadShape, settings: FeedSettings): boolean {
    const managerThreadId = settings.managerThreadId?.trim();
    if (
      !managerThreadId ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.id === managerThreadId
    ) {
      return false;
    }
    if (thread.parentThreadId === managerThreadId) return true;
    return (
      thread.parentThreadId === null &&
      thread.visibility === "visible" &&
      thread.sectionId !== null &&
      configuredSections(settings).includes(thread.sectionId)
    );
  }

  async isFeedThread(threadId: string): Promise<boolean> {
    const settings = await this.readSettings();
    const thread = await this.getThreadIfPresent(threadId);
    return thread !== null && this.isFeedThreadResponse(thread, settings);
  }

  async listFeedThreads(settings: FeedSettings): Promise<FeedEntry[]> {
    const managerThreadId = requiredManager(settings);
    const entries = new Map<string, FeedEntry>();
    for (const thread of await this.listAll({
      parentThreadId: managerThreadId,
      includeHidden: true,
    })) {
      if (this.isFeedThreadResponse(thread, settings)) {
        entries.set(thread.id, {
          thread,
          managedChild: true,
          inUserManagedSection:
            thread.sectionId !== null &&
            thread.sectionId === settings.userManagedSectionId?.trim(),
        });
      }
    }
    for (const sectionId of configuredSections(settings)) {
      for (const thread of await this.listAll({ sectionId, hasParent: false })) {
        if (
          thread.sectionId === sectionId &&
          this.isFeedThreadResponse(thread, settings) &&
          !entries.has(thread.id)
        ) {
          entries.set(thread.id, {
            thread,
            managedChild: false,
            inUserManagedSection:
              thread.sectionId === settings.userManagedSectionId?.trim(),
          });
        }
      }
    }
    return [...entries.values()];
  }

  async latestCompletion(
    threadId: string,
  ): Promise<{ seq: number; at: number | null }> {
    const events = await this.bb.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    const latest = events[0];
    return latest === undefined
      ? { seq: 0, at: null }
      : { seq: latest.seq, at: latest.createdAt };
  }

  async authorize(surfaceThreadId: string): Promise<string> {
    return this.authorizedManager(surfaceThreadId);
  }

  async canOpen(surfaceThreadId: string): Promise<{ canOpen: boolean }> {
    const managerThreadId = (await this.readSettings()).managerThreadId?.trim();
    if (!managerThreadId || surfaceThreadId.trim() !== managerThreadId) {
      return { canOpen: false };
    }
    await this.requireLiveManager(managerThreadId);
    return { canOpen: true };
  }

  async snapshot(surfaceThreadId: string): Promise<FeedSnapshot> {
    const settings = await this.readSettings();
    const managerThreadId = requiredManager(settings);
    this.assertSurface(surfaceThreadId, managerThreadId);
    await this.requireLiveManager(managerThreadId);
    const entries = await this.listFeedThreads(settings);
    const threads = entries.map((entry) => entry.thread);
    const ids = threads.map((thread) => thread.id);
    const runtimeFacts = await this.runtimeFacts(threads);
    const activeDescendantOwners = await this.activeDescendantOwners(
      managerThreadId,
      new Set(ids),
    );
    const descendantWork = await this.descendantWork(ids);
    const facts: ThreadFacts[] = entries.map((entry, index) => {
      const { thread } = entry;
      return {
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? "Untitled thread",
        status: thread.status,
        queuedWork: thread.queuedWork,
        managedChild: entry.managedChild,
        inUserManagedSection: entry.inUserManagedSection,
        latestCompletionSeq: runtimeFacts[index]?.latestCompletionSeq ?? 0,
        answeredAt: runtimeFacts[index]?.latestResultAt ?? thread.createdAt,
        hasActiveNativeTerminal:
          runtimeFacts[index]?.hasActiveNativeTerminal ?? false,
        hasBackgroundWork:
          thread.activity.activeBackgroundAgentCount > 0 ||
          thread.activity.activeBackgroundCommandCount > 0,
        hasActiveDescendant: activeDescendantOwners.has(thread.id),
        descendantTerminalTitle:
          descendantWork.get(thread.id)?.terminalTitle ?? null,
        hasDescendantBackgroundWork:
          descendantWork.get(thread.id)?.backgroundWork ?? false,
      };
    });
    // R18: a result seen without a summary call, for example one from before a reload, starts its call.
    for (const fact of facts) this.onResultSeen(fact.id, fact.latestCompletionSeq);
    const summaries = this.store.listSummaries(ids);
    const marks = this.store.listMarks(ids);
    const paused = this.store.listPaused(ids);
    return {
      managerThreadId,
      sectionNames: await this.sectionNames(settings),
      rows: projectFeed(facts, (threadId) => ({
        summary: summaries.get(threadId) ?? null,
        latestMessage:
          runtimeFacts[ids.indexOf(threadId)]?.latestMessage ?? null,
        markSeq: marks.get(threadId) ?? null,
        paused: paused.has(threadId),
      })),
    };
  }

  /** Sidebar names of the two configured sections; a failed lookup shows the section IDs. */
  private async sectionNames(
    settings: FeedSettings,
  ): Promise<FeedSnapshot["sectionNames"]> {
    const userManaged = settings.userManagedSectionId?.trim() ?? "";
    const children = settings.childrenSectionId?.trim() ?? "";
    let sections: Array<{ id: string; name: string }> = [];
    try {
      sections = await this.bb.sdk.threadSections.list();
    } catch {
      // The IDs below stand in for the names.
    }
    const nameOf = (id: string) =>
      sections.find((section) => section.id === id)?.name ?? id;
    return { userManaged: nameOf(userManaged), children: nameOf(children) };
  }

  async setPaused(input: {
    surfaceThreadId: string;
    threadId: string;
    paused: boolean;
  }): Promise<{ threadId: string; paused: boolean }> {
    await this.authorizedManager(input.surfaceThreadId);
    await this.requireFeedThread(input.threadId);
    this.store.setPaused(input.threadId, input.paused);
    this.publish(input.threadId, "pause-changed");
    return { threadId: input.threadId, paused: input.paused };
  }

  async detach(input: {
    surfaceThreadId: string;
    threadId: string;
  }): Promise<{ detached: true }> {
    const managerThreadId = await this.authorizedManager(input.surfaceThreadId);
    if ((await this.findManagedChild(managerThreadId, input.threadId)) === null) {
      throw new Error("The target is not a managed child of this manager.");
    }
    const userManagedSectionId = (
      await this.readSettings()
    ).userManagedSectionId?.trim();
    if (!userManagedSectionId) {
      throw new Error("Feed is not configured. Set userManagedSectionId.");
    }
    await this.bb.sdk.threads.update({
      threadId: input.threadId,
      parentThreadId: null,
      sectionId: userManagedSectionId,
    });
    this.publish(input.threadId, "detached");
    return { detached: true };
  }

  /** Moves a root Feed thread between the two configured sections. */
  async moveSection(input: {
    surfaceThreadId: string;
    threadId: string;
  }): Promise<{ sectionId: string }> {
    await this.authorizedManager(input.surfaceThreadId);
    const settings = await this.readSettings();
    const userManagedSectionId = settings.userManagedSectionId?.trim();
    const childrenSectionId = settings.childrenSectionId?.trim();
    const thread = await this.getThreadIfPresent(input.threadId);
    if (
      thread === null ||
      thread.parentThreadId !== null ||
      !this.isFeedThreadResponse(thread, settings)
    ) {
      throw new Error("The target is not a root Feed thread.");
    }
    const sectionId =
      thread.sectionId === userManagedSectionId
        ? childrenSectionId!
        : userManagedSectionId!;
    await this.bb.sdk.threads.update({ threadId: input.threadId, sectionId });
    this.publish(input.threadId, "section-moved");
    return { sectionId };
  }

  async archiveThread(input: {
    surfaceThreadId: string;
    threadId: string;
  }): Promise<{ archived: true }> {
    await this.authorizedManager(input.surfaceThreadId);
    await this.requireFeedThread(input.threadId);
    await this.bb.sdk.threads.archive({ threadId: input.threadId });
    return { archived: true };
  }

  async sendReply(input: {
    surfaceThreadId: string;
    threadId: string;
    text: string;
  }): Promise<{ accepted: true }> {
    await this.authorizedManager(input.surfaceThreadId);
    await this.requireFeedThread(input.threadId);
    await this.bb.sdk.threads.send({
      threadId: input.threadId,
      mode: "auto",
      input: [{ type: "text", text: input.text, mentions: [] }],
    });
    this.publish(input.threadId, "reply-sent");
    return { accepted: true };
  }

  /** R22: the manager marks the latest result of a managed child `needs_response`. */
  async writeMark(input: {
    callerThreadId: string;
    threadId: string;
  }): Promise<string> {
    const managerThreadId = (await this.readSettings()).managerThreadId?.trim();
    if (!managerThreadId) return markResult("not_configured");
    if (input.callerThreadId !== managerThreadId) {
      return markResult("wrong_caller");
    }
    if ((await this.findManagedChild(managerThreadId, input.threadId)) === null) {
      return markResult("not_managed_child");
    }
    const { seq } = await this.latestCompletion(input.threadId);
    this.store.writeMark(input.threadId, seq);
    this.publish(input.threadId, "mark-changed");
    return markResult("updated", { threadId: input.threadId, resultSeq: seq });
  }

  /** The feed thread whose row changes when this thread changes, if any. */
  async findOwningRow(threadId: string): Promise<string | null> {
    const settings = await this.readSettings();
    const managerThreadId = requiredManager(settings);
    const visited = new Set<string>();
    let currentId = threadId;
    for (;;) {
      if (currentId === managerThreadId || visited.has(currentId)) return null;
      visited.add(currentId);
      const thread = await this.getThreadIfPresent(currentId);
      if (thread === null) return null;
      if (this.isFeedThreadResponse(thread, settings)) return thread.id;
      if (thread.parentThreadId === null) return null;
      currentId = thread.parentThreadId;
    }
  }

  publish(threadId: string, reason: string): void {
    this.bb.realtime.publish("feed-invalidated", { threadId, reason });
  }

  private async listAll(
    query: Pick<
      NonNullable<Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0]>,
      "parentThreadId" | "sectionId" | "hasParent" | "includeHidden"
    >,
  ): Promise<ThreadListEntry[]> {
    const threads: ThreadListEntry[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.bb.sdk.threads.list({
        ...query,
        archived: false,
        limit: PAGE_SIZE,
        offset,
      });
      threads.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return threads;
  }

  private async authorizedManager(surfaceThreadId: string): Promise<string> {
    const managerThreadId = requiredManager(await this.readSettings());
    this.assertSurface(surfaceThreadId, managerThreadId);
    await this.requireLiveManager(managerThreadId);
    return managerThreadId;
  }

  private async requireLiveManager(managerThreadId: string): Promise<void> {
    try {
      const manager = await this.bb.sdk.threads.get({
        threadId: managerThreadId,
      });
      if (manager.archivedAt === null && manager.deletedAt === null) return;
    } catch (error) {
      this.bb.log.warn(
        `Configured manager ${managerThreadId} lookup failed: ${boundedErrorText(error)}`,
      );
      if (!isMissingThreadError(error)) {
        throw new Error("Could not verify the configured manager thread.");
      }
    }
    this.bb.log.warn(`${STALE_MANAGER_MESSAGE} Manager: ${managerThreadId}.`);
    this.bb.status.needsConfiguration(STALE_MANAGER_MESSAGE);
    throw new Error(STALE_MANAGER_MESSAGE);
  }

  private async runtimeFacts(
    threads: readonly Pick<ThreadResponse, "id">[],
  ): Promise<
    Array<{
      latestCompletionSeq: number;
      latestResultAt: number | null;
      latestMessage: string | null;
      hasActiveNativeTerminal: boolean;
    }>
  > {
    const results = new Array<{
      latestCompletionSeq: number;
      latestResultAt: number | null;
      latestMessage: string | null;
      hasActiveNativeTerminal: boolean;
    }>(threads.length);
    let nextIndex = 0;
    const worker = async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        const thread = threads[index];
        if (thread === undefined) return;
        const completion = await this.latestCompletion(thread.id);
        const terminalList = await this.bb.sdk.terminals.list({
          scope: { kind: "thread", threadId: thread.id },
        });
        results[index] = {
          latestCompletionSeq: completion.seq,
          latestResultAt: completion.at,
          latestMessage: await latestAgentMessage(this.bb.sdk, thread.id),
          hasActiveNativeTerminal: terminalList.sessions.some(
            (session) =>
              session.threadId === thread.id &&
              (session.status === "starting" || session.status === "running"),
          ),
        };
      }
    };
    const workerCount = Math.min(LOOKUP_CONCURRENCY, threads.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  /** R5: feed threads that have a running descendant. */
  /** R9: a running or starting terminal, or background work, on any descendant of each feed thread. */
  private async descendantWork(
    feedThreadIds: readonly string[],
  ): Promise<Map<string, { terminalTitle: string | null; backgroundWork: boolean }>> {
    const descendants: Array<{ ownerId: string; thread: ThreadListEntry }> = [];
    let frontier = feedThreadIds.map((id) => ({ ownerId: id, threadId: id }));
    const visited = new Set(feedThreadIds);
    while (frontier.length > 0) {
      const children = await boundedMap(frontier, ({ ownerId, threadId }) =>
        this.listAll({ parentThreadId: threadId, includeHidden: true }).then(
          (threads) => threads.map((thread) => ({ ownerId, thread })),
        ),
      );
      frontier = [];
      for (const child of children.flat()) {
        if (visited.has(child.thread.id)) continue;
        visited.add(child.thread.id);
        descendants.push(child);
        frontier.push({ ownerId: child.ownerId, threadId: child.thread.id });
      }
    }
    const terminalTitles = await boundedMap(descendants, async ({ thread }) => {
      const { sessions } = await this.bb.sdk.terminals.list({
        scope: { kind: "thread", threadId: thread.id },
      });
      return (
        sessions.find(
          (session) =>
            session.threadId === thread.id &&
            (session.status === "starting" || session.status === "running"),
        )?.title ?? null
      );
    });
    const work = new Map<string, { terminalTitle: string | null; backgroundWork: boolean }>();
    descendants.forEach(({ ownerId, thread }, index) => {
      const current = work.get(ownerId) ?? { terminalTitle: null, backgroundWork: false };
      current.terminalTitle ??= terminalTitles[index] ?? null;
      current.backgroundWork ||=
        thread.activity.activeBackgroundAgentCount > 0 ||
        thread.activity.activeBackgroundCommandCount > 0;
      work.set(ownerId, current);
    });
    return work;
  }

  private async activeDescendantOwners(
    managerThreadId: string,
    feedThreadIds: ReadonlySet<string>,
  ): Promise<Set<string>> {
    if (feedThreadIds.size === 0) return new Set();
    const runningThreadIds = [
      ...new Set(
        (await this.bb.sdk.threads.listRunning()).map((thread) => thread.id),
      ),
    ].filter((threadId) => !feedThreadIds.has(threadId));
    const ancestry = new Map<string, Promise<ThreadResponse | null>>();
    const lookup = (threadId: string): Promise<ThreadResponse | null> => {
      const cached = ancestry.get(threadId);
      if (cached !== undefined) return cached;
      const pending = this.getThreadIfPresent(threadId);
      ancestry.set(threadId, pending);
      return pending;
    };
    const owners = new Set<string>();
    let nextIndex = 0;
    const worker = async () => {
      for (;;) {
        const startId = runningThreadIds[nextIndex];
        nextIndex += 1;
        if (startId === undefined) return;
        const visited = new Set<string>();
        let threadId = startId;
        for (;;) {
          if (feedThreadIds.has(threadId)) {
            owners.add(threadId);
            break;
          }
          if (threadId === managerThreadId || visited.has(threadId)) break;
          visited.add(threadId);
          const thread = await lookup(threadId);
          if (thread === null || thread.parentThreadId === null) break;
          threadId = thread.parentThreadId;
        }
      }
    };
    const workerCount = Math.min(LOOKUP_CONCURRENCY, runningThreadIds.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return owners;
  }

  private async getThreadIfPresent(
    threadId: string,
  ): Promise<ThreadResponse | null> {
    try {
      return await this.bb.sdk.threads.get({ threadId });
    } catch (error) {
      if (isMissingThreadError(error)) return null;
      throw error;
    }
  }

  private assertSurface(surfaceThreadId: string, managerThreadId: string): void {
    if (surfaceThreadId.trim() !== managerThreadId) {
      throw new Error("Feed is only available on its configured manager thread.");
    }
  }

  private async findManagedChild(
    managerThreadId: string,
    threadId: string,
  ): Promise<ThreadResponse | null> {
    const thread = await this.getThreadIfPresent(threadId);
    return thread !== null &&
      thread.parentThreadId === managerThreadId &&
      thread.archivedAt === null &&
      thread.deletedAt === null
      ? thread
      : null;
  }

  private async requireFeedThread(threadId: string): Promise<void> {
    if (!(await this.isFeedThread(threadId))) {
      throw new Error("The target is not a Feed thread.");
    }
  }
}
