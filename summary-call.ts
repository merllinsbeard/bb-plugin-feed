import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The same helper-inference call that BB's bundled Codex plugin makes for thread titles.
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CHATGPT_AUTH_CLAIM_PATH = "https://api.openai.com/auth";
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const ONE_LINE_SCHEMA = {
  type: "object",
  properties: { oneLine: { type: "string" } },
  required: ["oneLine"],
  additionalProperties: false,
};

type JsonObject = Record<string, unknown>;

type CodexCredentials =
  | { type: "apiKey"; apiKey: string }
  | {
      type: "chatgpt";
      accessToken: string;
      accountId: string;
      isFedrampAccount: boolean;
    };

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function chatGptClaims(token: string): JsonObject | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const decoded = asObject(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return asObject(decoded?.[CHATGPT_AUTH_CLAIM_PATH]);
  } catch {
    return null;
  }
}

/** Reads the local Codex login, as BB's Codex host does; the token is used as stored. */
async function readCodexCredentials(): Promise<CodexCredentials> {
  const codexHome = path.resolve(
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
  );
  const authPath = path.join(codexHome, "auth.json");
  let parsed: JsonObject | null;
  try {
    parsed = asObject(JSON.parse(await readFile(authPath, "utf8")));
  } catch {
    throw new Error(`Codex auth file at ${authPath} is missing or not valid JSON. Run codex login.`);
  }
  const authMode = nonEmptyString(parsed?.auth_mode);
  const apiKey = nonEmptyString(parsed?.OPENAI_API_KEY);
  if (authMode === "apikey" || authMode === "apiKey" || (authMode === null && apiKey !== null)) {
    if (apiKey === null) throw new Error(`Codex auth file at ${authPath} has no API key.`);
    return { type: "apiKey", apiKey };
  }
  const tokens = asObject(parsed?.tokens);
  const accessToken = nonEmptyString(tokens?.access_token);
  if (accessToken === null) {
    throw new Error(`Codex auth file at ${authPath} has no access token. Run codex login.`);
  }
  const claims = chatGptClaims(accessToken);
  const idToken = nonEmptyString(tokens?.id_token);
  const idClaims = idToken === null ? null : chatGptClaims(idToken);
  const accountId =
    nonEmptyString(tokens?.account_id) ??
    nonEmptyString(claims?.chatgpt_account_id) ??
    nonEmptyString(idClaims?.chatgpt_account_id);
  if (accountId === null) {
    throw new Error("Codex auth tokens have no ChatGPT account ID. Run codex login.");
  }
  return {
    type: "chatgpt",
    accessToken,
    accountId,
    isFedrampAccount:
      claims?.chatgpt_account_is_fedramp === true ||
      idClaims?.chatgpt_account_is_fedramp === true,
  };
}

function requestHeaders(credentials: CodexCredentials): Headers {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": "bb-host-daemon",
  });
  if (credentials.type === "apiKey") {
    headers.set("Authorization", `Bearer ${credentials.apiKey}`);
    return headers;
  }
  headers.set("Authorization", `Bearer ${credentials.accessToken}`);
  headers.set("chatgpt-account-id", credentials.accountId);
  headers.set("originator", "bb");
  headers.set("OpenAI-Beta", "responses=experimental");
  if (credentials.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
  return headers;
}

function outputText(response: JsonObject): string | null {
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    const content = asObject(item)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const object = asObject(part);
      const text = nonEmptyString(object?.text) ?? nonEmptyString(object?.output_text);
      if ((object?.type === "output_text" || object?.type === "text") && text !== null) {
        return text;
      }
    }
  }
  return null;
}

function streamFailure(event: JsonObject): string | null {
  if (event.type === "error") {
    return nonEmptyString(event.message) ?? nonEmptyString(event.code) ?? "The model call failed.";
  }
  const error = asObject(asObject(event.response)?.error);
  if (event.type === "response.failed" || error !== null) {
    return nonEmptyString(error?.message) ?? nonEmptyString(error?.code) ?? "The model call failed.";
  }
  return null;
}

/** Reads the server-sent events and returns the structured output text. */
async function readStreamText(response: Response): Promise<string> {
  if (response.body === null) throw new Error("The model response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaText = "";
  let finalText: string | null = null;
  let totalBytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error("The model response is too large.");
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const data = buffer
        .slice(0, index)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
      if (!data || data === "[DONE]") continue;
      const event = asObject(JSON.parse(data));
      if (event === null) continue;
      const failure = streamFailure(event);
      if (failure !== null) throw new Error(failure);
      if (event.type === "response.output_text.delta") {
        deltaText += nonEmptyString(event.delta) ?? "";
      } else if (event.type === "response.completed" || event.type === "response.done") {
        const response = asObject(event.response);
        finalText = (response === null ? null : outputText(response)) ?? finalText;
      }
    }
  }
  const text = finalText ?? deltaText;
  if (!text) throw new Error("The model response has no output text.");
  return text;
}

export interface OneLineRequest {
  model: string;
  instructions: string;
  prompt: string;
  timeoutMs: number;
}

async function requestCodexOneLine(input: OneLineRequest): Promise<string> {
  const credentials = await readCodexCredentials();
  const body = {
    model: input.model,
    instructions: input.instructions,
    reasoning: { effort: "none" },
    store: false,
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }],
    text: {
      format: {
        type: "json_schema",
        name: "result",
        strict: true,
        schema: ONE_LINE_SCHEMA,
      },
    },
  };
  const response = await fetch(
    credentials.type === "chatgpt" ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: requestHeaders(credentials),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMs),
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new Error(`The model call failed with HTTP ${response.status}: ${detail}`);
  }
  const value = asObject(JSON.parse(await readStreamText(response)));
  const oneLine = nonEmptyString(value?.oneLine);
  if (oneLine === null) throw new Error("The model response has no oneLine.");
  return oneLine;
}

/** Runs the local `claude` CLI on the user's Claude login, with no tools, no project context, and no saved session. */
async function requestClaudeOneLine(input: OneLineRequest): Promise<string> {
  const args = [
    "-p",
    "--model", input.model,
    "--system-prompt", input.instructions,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", JSON.stringify(ONE_LINE_SCHEMA),
  ];
  const { stdout, stderr, code } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve, reject) => {
    // Run outside any project so no CLAUDE.md is loaded.
    const child = spawn("claude", args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("The Claude Code call timed out."))),
      input.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > RESPONSE_MAX_BYTES) {
        finish(() => reject(new Error("The model response is too large.")));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new Error(
            error.code === "ENOENT"
              ? "The claude CLI is not on PATH. Install Claude Code and run claude login."
              : `The claude CLI failed to start: ${error.message}`,
          ),
        ),
      ),
    );
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);
  });
  let value: JsonObject | null;
  try {
    value = asObject(JSON.parse(stdout));
  } catch {
    value = null;
  }
  if (value === null) {
    throw new Error(
      `The claude CLI returned no JSON (exit ${code}): ${(stderr || stdout).trim().slice(0, 400)}`,
    );
  }
  const oneLine = nonEmptyString(asObject(value.structured_output)?.oneLine);
  if (value.is_error === false && oneLine !== null) return oneLine;
  const detail = nonEmptyString(value.result) ?? stderr.trim();
  throw new Error(`The claude CLI call failed: ${detail.slice(0, 400) || "no oneLine in the response."}`);
}

export const SUMMARIZER_PROVIDERS = {
  codex: { defaultModel: "gpt-6-luna", request: requestCodexOneLine },
  "claude-code": { defaultModel: "claude-haiku-5-5", request: requestClaudeOneLine },
} as const satisfies Record<
  string,
  { defaultModel: string; request: (input: OneLineRequest) => Promise<string> }
>;

export type SummarizerProviderId = keyof typeof SUMMARIZER_PROVIDERS;

export const SUMMARIZER_PROVIDER_IDS = Object.keys(SUMMARIZER_PROVIDERS) as [
  SummarizerProviderId,
  ...SummarizerProviderId[],
];

export const DEFAULT_SUMMARIZER_PROVIDER: SummarizerProviderId = "codex";

/** One structured model call that returns `{ oneLine }`; an empty model uses the provider's default. */
export async function requestOneLine(
  input: OneLineRequest & { provider: string },
): Promise<string> {
  if (!Object.hasOwn(SUMMARIZER_PROVIDERS, input.provider)) {
    throw new Error(`Unknown summarizer provider: ${input.provider}.`);
  }
  const provider = SUMMARIZER_PROVIDERS[input.provider as SummarizerProviderId];
  return provider.request({ ...input, model: input.model.trim() || provider.defaultModel });
}
