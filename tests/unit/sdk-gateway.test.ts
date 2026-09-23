import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayFailure } from "../../src/companion/gateway.ts";
import type { TurnEvent } from "../../src/companion/gateway.ts";
import { createSdkGateway } from "../../src/companion/sdk-gateway.ts";
import { MAX_MODELS } from "../../src/protocol/messages.ts";

const sdk = vi.hoisted(() => {
  type SdkEvent = Record<string, unknown>;

  const script = {
    start: async () => {},
    authStatus: async (): Promise<Record<string, unknown>> => ({ isAuthenticated: true, login: "octocat" }),
    models: async (): Promise<unknown[]> => [],
    stop: async (): Promise<Error[]> => [],
  };

  class FakeSession {
    readonly config: Record<string, unknown>;
    readonly handlers = new Set<(event: SdkEvent) => void>();
    readonly send = vi.fn(async (_options: { prompt: string }) => "message-1");
    readonly abort = vi.fn(async () => {});
    readonly disconnect = vi.fn(async () => {});

    constructor(config: Record<string, unknown>) {
      this.config = config;
    }

    on(handler: (event: SdkEvent) => void) {
      this.handlers.add(handler);
      return () => {
        this.handlers.delete(handler);
      };
    }

    emit(event: SdkEvent) {
      for (const handler of [...this.handlers]) handler(event);
    }
  }

  class FakeCopilotClient {
    static readonly instances: FakeCopilotClient[] = [];
    readonly options: Record<string, unknown>;
    readonly sessions: FakeSession[] = [];
    readonly start = vi.fn(() => script.start());
    readonly getAuthStatus = vi.fn(() => script.authStatus());
    readonly listModels = vi.fn(() => script.models());
    readonly createSession = vi.fn(async (config: Record<string, unknown>) => {
      const session = new FakeSession(config);
      this.sessions.push(session);
      return session;
    });
    readonly stop = vi.fn(() => script.stop());
    readonly forceStop = vi.fn(async () => {});

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeCopilotClient.instances.push(this);
    }
  }

  const RuntimeConnection = {
    forStdio: (options: Record<string, unknown>) => ({ kind: "stdio", ...options }),
  };

  return { script, FakeCopilotClient, RuntimeConnection };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: sdk.FakeCopilotClient,
  RuntimeConnection: sdk.RuntimeConnection,
}));

const token = `github_pat_${"Q".repeat(82)}`;

function onlyClient() {
  expect(sdk.FakeCopilotClient.instances).toHaveLength(1);
  const [client] = sdk.FakeCopilotClient.instances;
  if (!client) throw new Error("expected a client");
  return client;
}

function homeOf(client: InstanceType<typeof sdk.FakeCopilotClient>) {
  const home = client.options.baseDirectory;
  if (typeof home !== "string") throw new Error("expected a base directory");
  return home;
}

async function connectedGateway() {
  const gateway = createSdkGateway();
  await gateway.connect(token);
  return { gateway, client: onlyClient() };
}

async function startedTurn() {
  const { gateway, client } = await connectedGateway();
  const events: TurnEvent[] = [];
  const turn = gateway.startTurn({ model: "gpt-5-mini", prompt: "Say hi", onEvent: (event) => events.push(event) });
  await vi.waitFor(() => expect(client.sessions[0]?.send).toHaveBeenCalled());
  const [session] = client.sessions;
  if (!session) throw new Error("expected a session");
  return { gateway, client, session, turn, events };
}

beforeEach(() => {
  sdk.FakeCopilotClient.instances.length = 0;
  sdk.script.start = async () => {};
  sdk.script.authStatus = async () => ({ isAuthenticated: true, login: "octocat" });
  sdk.script.models = async () => [];
  sdk.script.stop = async () => [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connect", () => {
  it("starts an empty-mode runtime with only the panel's token and a private temporary home", async () => {
    vi.stubEnv("GH_TOKEN", "gho_ambient");
    vi.stubEnv("GITHUB_TOKEN", "ghp_ambient");
    vi.stubEnv("COPILOT_CLI_PATH", "/tmp/other-runtime");
    const { gateway, client } = await connectedGateway();
    const home = homeOf(client);

    expect(client.options).toEqual({
      mode: "empty",
      connection: { kind: "stdio", env: { HOME: home, TMPDIR: home, COPILOT_HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      baseDirectory: home,
      workingDirectory: home,
      gitHubToken: token,
      useLoggedInUser: false,
      logLevel: "error",
      clientInfo: { applicationName: "gh-copilot-in-chrome" },
    });
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(client.start).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("returns the login and only enabled, well-formed models", async () => {
    sdk.script.models = async () => [
      { id: "gpt-5-mini", name: "GPT-5 mini", policy: { state: "enabled", terms: "" }, billing: { multiplier: 0 } },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", policy: { state: "enabled", terms: "" }, billing: { multiplier: 1 } },
      { id: "o3", name: "o3", policy: { state: "disabled", terms: "" }, billing: { multiplier: 1 } },
      { id: "gpt-4.1", name: "GPT-4.1", policy: { state: "unconfigured", terms: "" } },
      { id: "no-policy", name: "No policy" },
      { id: "", name: "Nameless id", policy: { state: "enabled", terms: "" } },
      { id: "odd-billing", name: "Odd billing", policy: { state: "enabled", terms: "" }, billing: { multiplier: -1 } },
    ];
    const gateway = createSdkGateway();
    await expect(gateway.connect(token)).resolves.toEqual({
      login: "octocat",
      models: [
        { id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 },
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1 },
        { id: "odd-billing", name: "Odd billing" },
      ],
    });
    await gateway.close();
  });

  it("caps the model list and omits a missing login", async () => {
    sdk.script.authStatus = async () => ({ isAuthenticated: true });
    sdk.script.models = async () =>
      Array.from({ length: MAX_MODELS + 5 }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
        policy: { state: "enabled", terms: "" },
      }));
    const gateway = createSdkGateway();
    const account = await gateway.connect(token);
    expect(account.login).toBeUndefined();
    expect(account.models).toHaveLength(MAX_MODELS);
    await gateway.close();
  });

  it.each([
    ["the runtime fails to start", { start: async () => Promise.reject(new Error(`spawn failed ${token}`)) }, "sdk_start_failed"],
    ["the token is not authenticated", { authStatus: async () => ({ isAuthenticated: false, statusMessage: "Not authenticated" }) }, "auth_failed"],
    ["auth status cannot be read", { authStatus: async () => Promise.reject(new Error("rpc closed")) }, "auth_failed"],
    ["models cannot be listed", { models: async () => Promise.reject(new Error("403 Forbidden: {body}")) }, "models_unavailable"],
  ] as const)("reports a coded failure when %s", async (_description, override, code) => {
    Object.assign(sdk.script, override);
    const gateway = createSdkGateway();
    const failure = await gateway.connect(token).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayFailure);
    expect(failure).toMatchObject({ code, message: code });
    await gateway.close();
  });

  it("does not start a runtime when closed before the SDK is ready", async () => {
    const gateway = createSdkGateway();
    const connecting = gateway.connect(token);
    await gateway.close();
    await expect(connecting).rejects.toBeInstanceOf(GatewayFailure);
    expect(sdk.FakeCopilotClient.instances).toHaveLength(0);
  });

  it("stops a runtime that was closed while starting", async () => {
    let finishStart = () => {};
    sdk.script.start = () => new Promise<void>((resolve) => (finishStart = resolve));
    const gateway = createSdkGateway();
    const connecting = gateway.connect(token);
    await vi.waitFor(() => expect(sdk.FakeCopilotClient.instances[0]?.start).toHaveBeenCalled());
    const client = onlyClient();
    await gateway.close();
    finishStart();

    await expect(connecting).rejects.toBeInstanceOf(GatewayFailure);
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.getAuthStatus).not.toHaveBeenCalled();
    expect(existsSync(homeOf(client))).toBe(false);
  });
});

describe("startTurn", () => {
  it("creates a tool-less, permission-denying session in the temporary home", async () => {
    const { gateway, client, session } = await startedTurn();
    expect(session.config).toEqual({
      model: "gpt-5-mini",
      streaming: true,
      availableTools: [],
      onPermissionRequest: expect.any(Function),
      infiniteSessions: { enabled: false },
      workingDirectory: homeOf(client),
    });
    const onPermissionRequest = session.config.onPermissionRequest as () => unknown;
    expect(onPermissionRequest()).toEqual({ kind: "reject" });
    expect(session.send).toHaveBeenCalledWith({ prompt: "Say hi" });
    await gateway.close();
  });

  it("forwards root-agent deltas and usage, then completes on idle and disconnects", async () => {
    const { gateway, session, turn, events } = await startedTurn();
    session.emit({ type: "assistant.message_delta", data: { deltaContent: "Connection ", messageId: "m1" } });
    session.emit({ type: "assistant.message_delta", agentId: "sub-agent", data: { deltaContent: "noise", messageId: "m2" } });
    session.emit({ type: "assistant.message_delta", data: { deltaContent: "confirmed.", messageId: "m1" } });
    session.emit({ type: "assistant.usage", data: { model: "gpt-5-mini", cost: 0, inputTokens: 12 } });
    session.emit({ type: "assistant.usage", data: { model: "gpt-5-mini", cost: Number.NaN } });
    session.emit({ type: "assistant.usage", agentId: "sub-agent", data: { model: "other", cost: 1 } });
    session.emit({ type: "session.idle", data: {} });

    await expect(turn.outcome).resolves.toBe("complete");
    expect(events).toEqual([
      { type: "delta", text: "Connection " },
      { type: "delta", text: "confirmed." },
      { type: "usage", model: "gpt-5-mini", cost: 0 },
      { type: "usage", model: "gpt-5-mini" },
    ]);
    expect(session.disconnect).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("ignores an idle event from a sub-agent", async () => {
    const { gateway, session, turn } = await startedTurn();
    session.emit({ type: "session.idle", agentId: "sub-agent", data: {} });
    session.emit({ type: "session.idle", data: { aborted: true } });
    await expect(turn.outcome).resolves.toBe("stopped");
    await gateway.close();
  });

  it.each([
    ["authentication", "auth_failed"],
    ["authorization", "not_authorized"],
    ["quota", "quota_exceeded"],
    ["rate_limit", "rate_limited"],
    ["context_limit", "send_failed"],
    ["query", "send_failed"],
  ])("maps a %s session error to %s without its server text", async (errorType, code) => {
    const { gateway, session, turn } = await startedTurn();
    session.emit({ type: "session.error", data: { errorType, message: `401 Unauthorized: ${token}`, statusCode: 401 } });
    session.emit({ type: "session.idle", data: {} });

    const failure = await turn.outcome.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayFailure);
    expect(failure).toMatchObject({ code, message: code });
    expect(session.disconnect).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("reports a send that the runtime rejects", async () => {
    const { gateway, client } = await connectedGateway();
    client.createSession.mockImplementationOnce(async () => Promise.reject(new Error(`SDK session authentication failed: ${token}`)));
    const turn = gateway.startTurn({ model: "gpt-5-mini", prompt: "Say hi", onEvent: () => {} });
    await expect(turn.outcome).rejects.toMatchObject({ code: "send_failed", message: "send_failed" });
    await gateway.close();
  });

  it("aborts the running session and reports the stopped outcome", async () => {
    const { gateway, session, turn } = await startedTurn();
    await turn.abort();
    expect(session.abort).toHaveBeenCalledOnce();
    session.emit({ type: "session.idle", data: { aborted: true } });
    await expect(turn.outcome).resolves.toBe("stopped");
    await gateway.close();
  });

  it("stops before sending when aborted while the session is being created", async () => {
    const { gateway, client } = await connectedGateway();
    const turn = gateway.startTurn({ model: "gpt-5-mini", prompt: "Say hi", onEvent: () => {} });
    await turn.abort();
    await expect(turn.outcome).resolves.toBe("stopped");
    const [session] = client.sessions;
    expect(session?.send).not.toHaveBeenCalled();
    expect(session?.disconnect).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("refuses to start a turn before connecting", async () => {
    const gateway = createSdkGateway();
    const turn = gateway.startTurn({ model: "gpt-5-mini", prompt: "Say hi", onEvent: () => {} });
    await expect(turn.outcome).rejects.toMatchObject({ code: "send_failed" });
  });
});

describe("close", () => {
  it("stops the runtime and removes the temporary home", async () => {
    const { gateway, client } = await connectedGateway();
    await gateway.close();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.forceStop).not.toHaveBeenCalled();
    expect(existsSync(homeOf(client))).toBe(false);
  });

  it.each([
    ["reports cleanup errors", async () => [new Error("session cleanup failed")]],
    ["throws", async () => Promise.reject(new Error("connection lost"))],
  ])("force-stops the runtime when a graceful stop %s", async (_description, stop) => {
    sdk.script.stop = stop;
    const { gateway, client } = await connectedGateway();
    await gateway.close();
    expect(client.forceStop).toHaveBeenCalledOnce();
    expect(existsSync(homeOf(client))).toBe(false);
  });
});
