import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayFailure } from "../../src/companion/gateway.ts";
import type { ConnectedAccount, CopilotGateway, TurnEvent, TurnRequest } from "../../src/companion/gateway.ts";
import { OPERATION_TIMEOUT_MS, createCompanionService } from "../../src/companion/service.ts";
import { FIXED_TEST_PROMPT, MAX_OUTPUT_LENGTH } from "../../src/protocol/messages.ts";
import type { CompanionMessage, TurnOutcome } from "../../src/protocol/messages.ts";

const token = `github_pat_${"Z".repeat(82)}`;
const account: ConnectedAccount = {
  login: "octocat",
  models: [
    { id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1 },
  ],
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function itemAt<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}`);
  return item;
}

function createFakeGateway() {
  const connection = deferred<ConnectedAccount>();
  const turns: {
    request: TurnRequest;
    outcome: ReturnType<typeof deferred<TurnOutcome>>;
    abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }[] = [];
  const gateway = {
    connect: vi.fn((_token: string) => connection.promise),
    startTurn: vi.fn((request: TurnRequest) => {
      const turn = { request, outcome: deferred<TurnOutcome>(), abort: vi.fn(async () => {}) };
      turns.push(turn);
      return { outcome: turn.outcome.promise, abort: turn.abort };
    }),
    close: vi.fn(async () => {}),
  } satisfies CopilotGateway;
  return { gateway, connection, turns };
}

function startService() {
  const gateways: ReturnType<typeof createFakeGateway>[] = [];
  const emitted: CompanionMessage[] = [];
  const service = createCompanionService({
    createGateway: () => {
      const fake = createFakeGateway();
      gateways.push(fake);
      return fake.gateway;
    },
    emit: (message) => emitted.push(message),
  });
  return { service, gateways, emitted };
}

async function startConnected() {
  const started = startService();
  started.service.handle({ type: "connect", token });
  itemAt(started.gateways, 0).connection.resolve(account);
  await settle();
  started.emitted.length = 0;
  return { ...started, gateway: itemAt(started.gateways, 0) };
}

function settle() {
  return vi.advanceTimersByTimeAsync(0);
}

function emitEvent(turn: { request: TurnRequest }, event: TurnEvent) {
  turn.request.onEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connect", () => {
  it("connects with the panel's token and reports the account and enabled models", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token });
    expect(itemAt(gateways, 0).gateway.connect).toHaveBeenCalledWith(token);
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toEqual([{ type: "connected", login: "octocat", models: account.models }]);
  });

  it("omits the login when the gateway does not know it", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token });
    itemAt(gateways, 0).connection.resolve({ models: [] });
    await settle();
    expect(emitted).toEqual([{ type: "connected", models: [] }]);
  });

  it("reports a coded failure, closes that gateway, and allows a fresh attempt", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token });
    itemAt(gateways, 0).connection.reject(new GatewayFailure("auth_failed"));
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "auth_failed" }]);
    expect(itemAt(gateways, 0).gateway.close).toHaveBeenCalledOnce();

    service.handle({ type: "connect", token });
    expect(gateways).toHaveLength(2);
  });

  it("maps unexpected failures to a code without echoing their text", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token });
    itemAt(gateways, 0).connection.reject(new Error(`401 Unauthorized for ${token}`));
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "sdk_start_failed" }]);
    expect(JSON.stringify(emitted)).not.toContain(token);
  });

  it("reports a gateway that cannot be created as an SDK start failure", () => {
    const emitted: CompanionMessage[] = [];
    const service = createCompanionService({
      createGateway: () => {
        throw new Error("mkdtemp failed");
      },
      emit: (message) => emitted.push(message),
    });
    service.handle({ type: "connect", token });
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "sdk_start_failed" }]);
  });

  it("rejects a second connect while the first is running", () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token });
    service.handle({ type: "connect", token });
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "busy" }]);
    expect(gateways).toHaveLength(1);
  });

  it("keeps one token per companion once connected", async () => {
    const { service, gateways, emitted } = await startConnected();
    service.handle({ type: "connect", token });
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "already_connected" }]);
    expect(gateways).toHaveLength(1);
  });

  it("times out, closes the gateway, and ignores a late success", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token });
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "timeout" }]);
    expect(itemAt(gateways, 0).gateway.close).toHaveBeenCalledOnce();

    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toHaveLength(1);
  });
});

describe("send", () => {
  it("requires a connection first", () => {
    const { service, emitted } = startService();
    service.handle({ type: "send", model: "gpt-5-mini" });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "not_connected" }]);
  });

  it("only accepts a model offered by this connection", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "o1-preview" });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "unknown_model" }]);
    expect(gateway.gateway.startTurn).not.toHaveBeenCalled();
  });

  it("sends only the fixed prompt and streams deltas and usage until done", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    const turn = itemAt(gateway.turns, 0);
    expect(turn.request.model).toBe("gpt-5-mini");
    expect(turn.request.prompt).toBe(FIXED_TEST_PROMPT);

    emitEvent(turn, { type: "delta", text: "Connection " });
    emitEvent(turn, { type: "delta", text: "" });
    emitEvent(turn, { type: "delta", text: "confirmed." });
    emitEvent(turn, { type: "usage", model: "gpt-5-mini", cost: 0 });
    turn.outcome.resolve("complete");
    await settle();

    expect(emitted).toEqual([
      { type: "delta", text: "Connection " },
      { type: "delta", text: "confirmed." },
      { type: "usage", model: "gpt-5-mini", cost: 0 },
      { type: "done", outcome: "complete" },
    ]);
  });

  it("accepts another send after a turn finishes", async () => {
    const { service, gateway } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    await settle();
    service.handle({ type: "send", model: "claude-sonnet-4.5" });
    expect(gateway.turns).toHaveLength(2);
  });

  it("runs one turn at a time", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    service.handle({ type: "send", model: "gpt-5-mini" });
    service.handle({ type: "connect", token });
    expect(emitted).toEqual([
      { type: "error", stage: "send", code: "busy" },
      { type: "error", stage: "connect", code: "already_connected" },
    ]);
    expect(gateway.turns).toHaveLength(1);
  });

  it("maps coded and unexpected turn failures without echoing their text", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    itemAt(gateway.turns, 0).outcome.reject(new GatewayFailure("rate_limited"));
    await settle();
    service.handle({ type: "send", model: "gpt-5-mini" });
    itemAt(gateway.turns, 1).outcome.reject(new Error(`request failed with ${token}`));
    await settle();

    expect(emitted).toEqual([
      { type: "error", stage: "send", code: "rate_limited" },
      { type: "error", stage: "send", code: "send_failed" },
    ]);
    expect(JSON.stringify(emitted)).not.toContain(token);
  });

  it("ignores a connect-only failure code from a turn", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    itemAt(gateway.turns, 0).outcome.reject(new GatewayFailure("models_unavailable"));
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "send_failed" }]);
  });

  it("reports a turn that cannot start and stays connected", async () => {
    const { service, gateway, emitted } = await startConnected();
    gateway.gateway.startTurn.mockImplementationOnce(() => {
      throw new GatewayFailure("not_authorized");
    });
    service.handle({ type: "send", model: "gpt-5-mini" });
    service.handle({ type: "send", model: "gpt-5-mini" });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "not_authorized" }]);
    expect(gateway.turns).toHaveLength(1);
  });
});

describe("stop", () => {
  it("aborts the active turn and reports the stopped outcome", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "Connec" });
    service.handle({ type: "stop" });
    expect(itemAt(gateway.turns, 0).abort).toHaveBeenCalledOnce();

    itemAt(gateway.turns, 0).outcome.resolve("stopped");
    await settle();
    expect(emitted).toEqual([
      { type: "delta", text: "Connec" },
      { type: "done", outcome: "stopped" },
    ]);
  });

  it("does nothing without an active turn", async () => {
    const { service, emitted } = await startConnected();
    service.handle({ type: "stop" });
    expect(emitted).toEqual([]);
  });
});

describe("limits", () => {
  it("keeps partial output up to the cap, then aborts with output_limit", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    const turn = itemAt(gateway.turns, 0);
    emitEvent(turn, { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 3) });
    emitEvent(turn, { type: "delta", text: "bcdef" });
    emitEvent(turn, { type: "delta", text: "ignored" });
    turn.outcome.resolve("stopped");
    await settle();

    expect(emitted).toEqual([
      { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 3) },
      { type: "delta", text: "bcd" },
      { type: "error", stage: "send", code: "output_limit" },
    ]);
    expect(turn.abort).toHaveBeenCalledOnce();
  });

  it("never splits a surrogate pair at the output cap", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 1) });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "😀" });
    expect(emitted).toEqual([
      { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 1) },
      { type: "error", stage: "send", code: "output_limit" },
    ]);
  });

  it("times out a turn, aborts it, and ignores anything it emits later", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "timeout" }]);
    expect(itemAt(gateway.turns, 0).abort).toHaveBeenCalledOnce();

    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "late" });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    await settle();
    expect(emitted).toHaveLength(1);
  });

  it("clears the operation timer when a turn finishes in time", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    await settle();
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS * 2);
    expect(emitted).toEqual([{ type: "done", outcome: "complete" }]);
  });
});

describe("shutdown", () => {
  it("closes the gateway, then ignores later messages and callbacks", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini" });
    await service.shutdown();
    expect(gateway.gateway.close).toHaveBeenCalledOnce();

    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "late" });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    service.handle({ type: "send", model: "gpt-5-mini" });
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
    await service.shutdown();
    expect(emitted).toEqual([]);
    expect(gateway.gateway.close).toHaveBeenCalledOnce();
  });

  it("closes a gateway that is still connecting", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token });
    await service.shutdown();
    expect(itemAt(gateways, 0).gateway.close).toHaveBeenCalledOnce();
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toEqual([]);
  });

  it("survives a gateway that fails to close", async () => {
    const { service, gateway } = await startConnected();
    gateway.gateway.close.mockRejectedValueOnce(new Error("runtime already gone"));
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});
