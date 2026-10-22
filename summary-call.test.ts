import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestOneLine, SUMMARIZER_PROVIDERS } from "./summary-call.js";

// /tmp is mounted noexec on some hosts, so the fake executable lives under the home directory.
const SANDBOX = path.join(os.homedir(), ".cache", "feed-tests", `summary-call-${process.pid}`);
const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/args"
cat > "$FAKE_DIR/stdin"
pwd > "$FAKE_DIR/cwd"
case "$FAKE_MODE" in
  ok) printf '%s' '{"is_error":false,"result":"","structured_output":{"oneLine":"Done: fixed it."}}' ;;
  error) printf '%s' '{"is_error":true,"result":"Credit balance is too low"}'; exit 1 ;;
  empty) printf '%s' '{"is_error":false,"result":"","structured_output":{"oneLine":""}}' ;;
  malformed) printf 'not json' ;;
  hang) sleep 30 ;;
esac
`;

const request = {
  provider: "claude-code",
  model: "",
  instructions: "Summarize.",
  prompt: "<request>hi</request>",
  timeoutMs: 5_000,
};

let originalPath: string | undefined;

beforeEach(async () => {
  await mkdir(path.join(SANDBOX, "bin"), { recursive: true });
  await writeFile(path.join(SANDBOX, "bin", "claude"), FAKE_CLAUDE);
  await chmod(path.join(SANDBOX, "bin", "claude"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${path.join(SANDBOX, "bin")}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_DIR = SANDBOX;
  process.env.FAKE_MODE = "ok";
});

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_DIR;
  delete process.env.FAKE_MODE;
  await rm(SANDBOX, { recursive: true, force: true });
});

describe("requestOneLine with the claude-code provider", () => {
  it("returns structured_output.oneLine and sends the prompt on stdin", async () => {
    await expect(requestOneLine(request)).resolves.toBe("Done: fixed it.");
    expect(await readFile(path.join(SANDBOX, "stdin"), "utf8")).toBe(request.prompt);
    const args = (await readFile(path.join(SANDBOX, "args"), "utf8")).split("\n");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("Summarize.");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toMatchObject({
      required: ["oneLine"],
    });
  });

  it("runs outside the project so no CLAUDE.md is loaded", async () => {
    await requestOneLine(request);
    const cwd = (await readFile(path.join(SANDBOX, "cwd"), "utf8")).trim();
    expect(cwd).toBe(await realpath(os.tmpdir()));
  });

  it("uses the provider default model when the model is empty", async () => {
    await requestOneLine(request);
    const args = (await readFile(path.join(SANDBOX, "args"), "utf8")).split("\n");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
  });

  it("passes a configured model through", async () => {
    await requestOneLine({ ...request, model: " claude-sonnet-5-5 " });
    const args = (await readFile(path.join(SANDBOX, "args"), "utf8")).split("\n");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
  });

  it("throws the CLI's result text when is_error is true", async () => {
    process.env.FAKE_MODE = "error";
    await expect(requestOneLine(request)).rejects.toThrow(/Credit balance is too low/);
  });

  it("throws when oneLine is empty", async () => {
    process.env.FAKE_MODE = "empty";
    await expect(requestOneLine(request)).rejects.toThrow(/no oneLine/);
  });

  it("throws on output that is not JSON", async () => {
    process.env.FAKE_MODE = "malformed";
    await expect(requestOneLine(request)).rejects.toThrow(/returned no JSON/);
  });

  it("kills the child and throws when the call times out", async () => {
    process.env.FAKE_MODE = "hang";
    const startedAt = Date.now();
    await expect(requestOneLine({ ...request, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("explains a missing claude binary", async () => {
    process.env.PATH = path.join(SANDBOX, "empty");
    await expect(requestOneLine(request)).rejects.toThrow(/not on PATH/);
  });
});

describe("summarizer provider selection", () => {
  it("routes codex to the Codex login", async () => {
    process.env.CODEX_HOME = path.join(SANDBOX, "no-codex-home");
    await expect(requestOneLine({ ...request, provider: "codex" })).rejects.toThrow(
      /Codex auth file/,
    );
    delete process.env.CODEX_HOME;
  });

  it("rejects an unknown provider", async () => {
    await expect(requestOneLine({ ...request, provider: "other" })).rejects.toThrow(
      /Unknown summarizer provider/,
    );
  });

  it("keeps the documented default models", () => {
    expect(SUMMARIZER_PROVIDERS.codex.defaultModel).toBe("gpt-6-luna");
    expect(SUMMARIZER_PROVIDERS["claude-code"].defaultModel).toBe("claude-haiku-5-5");
  });
});
