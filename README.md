# Feed

A BB plugin that shows the threads that need you in one panel on a manager thread. The Feed lists the manager's direct children and the visible root threads in two sidebar sections. Each row gets a one-line summary of the thread's latest result, written by one direct model call.

BB owns thread titles, lifecycle state, queued-work state, archive state, sections, and parent relationships. The plugin stores one-line summaries, `needs_response` marks, and pauses in its SQLite database.

## Install

```bash
bb plugin install https://github.com/ryanbbrown/bb-plugin-feed.git
```

The plugin ID is `feed`.

## Set up

1. Create two sidebar sections in BB: one for threads you talk to yourself (the user managed section), and one for threads the manager starts (the children section).
2. Create the manager thread. Any provider works. The Feed panel opens only as a tab on this thread.
3. Set the settings below with `bb plugin config feed set <key> <value>`, or in the plugin settings in BB.
4. Run `bb plugin reload feed`.
5. In the manager thread, ask the agent to load the `feed` skill. The skill binds the thread and opens the Feed tab.

### Settings

- `managerThreadId` (required): the ID of the one manager thread that owns the Feed. Inside the thread, run `bb status` or read `$BB_THREAD_ID`. In the `feed` skill, the agent sets this value itself.
- `userManagedSectionId` (required): the sidebar section for threads you talk to yourself. Its rows show a filled star.
- `childrenSectionId` (required): the sidebar section for threads the manager starts. It must differ from `userManagedSectionId`.
- `summarizerProvider`: where the summary call runs, `codex` or `claude-code`. Default: `codex`.
- `summarizerModel`: the model for the summary call. Empty uses the provider's default: `gpt-6-luna` for `codex`, `claude-haiku-5-5` for `claude-code`.
- `summaryInstructions`: the style of the one-line summary: who to speak to, what to put first, tone, and length. Empty uses the default. The plugin always sends its fixed transcript framing first and cuts the line at 240 characters.

To find a section ID, move any thread into the section and run `bb thread show <thread-id> --json`. The `sectionId` field holds the ID. A section ID does not change when you rename the section.

If the plugin reports a missing setting, or a missing, archived, or deleted manager, correct the setting and run `bb plugin reload feed`. The plugin cannot clear its `needs-configuration` status without a reload.

### Logins for summaries

With `summarizerProvider` set to `codex`, the summary call uses the Codex login on the machine that runs the BB server. Run `codex login` there, with a ChatGPT account or an OpenAI API key.

With `claude-code`, the call runs the `claude` CLI found on the `PATH` of the BB server, with the login of the user who runs the server. Run `claude login` there. The CLI runs with no tools, no project instructions, and no saved session.

Without a login, the Feed still works: line 2 of each row shows the first sentence of the agent's latest message instead of a summary.

## Feed rows

A feed thread is a thread that is not archived or deleted and is either a managed child (a direct child of the manager, visible or hidden) or a visible root thread in one of the two sections. The manager is never a feed thread. Descendants do not get rows; a running descendant makes its feed thread In progress.

Sections, in order:

- Needs your response: an idle root thread; a managed child whose latest result the manager marked with `feed_mark`; a thread whose session failed or whose queued work failed.
- In progress: a thread whose session is active, whose queued work waits, that has an active BB terminal, an active background agent or command, or a running descendant; and a managed child with no mark on its latest result ("With manager").
- Paused: every row you paused, whatever its state. The row still shows its live status. A result does not unpause it; a message sent to the thread after the pause (from BB, a Feed reply, or the manager) does. A provider's own follow-up turn, for example after a background task ends, does not.

Every section sorts by the time of the thread's latest result. The sort button at the bottom of the Feed switches between newest first (default) and oldest first; the browser keeps the choice.

A row has two lines. Line 1: the title pill (opens the thread), the star, the expand area with the time of the latest result, the status when it is not Idle, and Archive. Line 2: the one-line summary, with Reply and Pause or Unpause. The expand area shows the card: the thread's latest agent message as Markdown. The row stays open until you close it or the card changes. A filled star means the thread is in the user managed section. Clicking the star moves a root thread to the other section, or detaches a managed child into the user managed section. A reply starts with `[Re: "<one-line summary>"]` and a blank line.

## Summary call

Each result of a feed thread starts one model call from the plugin's server process. It uses the local Codex login (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`) and the same Responses endpoint as BB's Codex helper for thread titles: `chatgpt.com/backend-api/codex/responses` for a ChatGPT login, `api.openai.com/v1/responses` for an API key. The call gets the user's latest message to the thread, the agent's messages since then, and the previous one-line summary. It returns one or two sentences, at most 240 characters, that answer the user's latest message first. The call times out after 15 seconds.

The summary records the result it describes. When a newer result's call starts, an older call's answer is dropped. A failed call is not retried; line 2 then shows the first sentence of the agent's latest message until the next result. While the newest result has no summary, line 2 shows "Summarizing…". A result that the plugin did not see, for example during a reload, starts its call when the Feed next loads.

## Manager

The manager gets `feed_mark` and the `feed` skill. `feed_mark` takes a managed child's thread ID and marks its latest result `needs_response`. The manager instructions include the children section ID, so the manager spawns new work as root threads in that section by default.

Use `bb feed show [--json]` inside the manager thread to read the rows. The command does not change threads. The panel's Clear context button clears the manager context only when it is idle with no queued work or pending interaction. The post-clear message tells the manager to load the `feed` skill, skip Bind, run `bb feed show` and `bb thread history <managerId> --limit 5`, then reply in one line that it is ready.

## Summary call

Each result of a feed thread starts one model call from the plugin's server process. It uses the local Codex login (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`) and the same Responses endpoint as BB's Codex helper for thread titles: `chatgpt.com/backend-api/codex/responses` for a ChatGPT login, `api.openai.com/v1/responses` for an API key. The call gets the user's latest message to the thread, the agent's messages since then, and the previous one-line summary. It returns one or two sentences, at most 240 characters, that answer the user's latest message first. The call times out after 15 seconds.

The summary records the result it describes. When a newer result's call starts, an older call's answer is dropped. A failed call is not retried; line 2 then shows the first sentence of the agent's latest message until the next result. While the newest result has no summary, line 2 shows "Summarizing…". A result that the plugin did not see, for example during a reload, starts its call when the Feed next loads.

## Manager

The manager gets `feed_mark` and the `feed` skill. `feed_mark` takes a managed child's thread ID and marks its latest result `needs_response`. The manager instructions include the children section ID, so the manager spawns new work as root threads in that section by default.

Use `bb feed show [--json]` inside the manager thread to read the rows. The command does not change threads. The panel's Clear context button clears the manager context only when it is idle with no queued work or pending interaction. The post-clear message tells the manager to load the `feed` skill, skip Bind, run `bb feed show` and `bb thread history <managerId> --limit 5`, then reply in one line that it is ready.

## Development

The package pins `@get-bb/plugin-sdk` to the exact version the running BB reports. A clean checkout installs deterministically:

```bash
npm ci
npm test
npm run typecheck
bb plugin types --check .
bb plugin build .
```

When BB or its Plugin SDK version changes, update `engines` in `package.json`, run `bb plugin types .` to repin the SDK, then run `npm install`, `bb plugin types --check .`, the tests, and the build.

## License

MIT. See [LICENSE](LICENSE).
