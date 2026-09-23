import { CONNECT_FAILURE_CODES, GatewayFailure, TURN_FAILURE_CODES } from "./gateway.ts";
import type { ConnectFailureCode, CopilotGateway, Turn, TurnEvent, TurnFailureCode } from "./gateway.ts";
import { FIXED_TEST_PROMPT, MAX_OUTPUT_LENGTH, OPERATION_TIMEOUT_MS } from "../protocol/messages.ts";
import type { CompanionMessage, ErrorCode, PanelMessage } from "../protocol/messages.ts";

export const ABORT_TIMEOUT_MS = 5_000;

type CompanionServiceOptions = {
  createGateway: () => CopilotGateway;
  emit: (message: CompanionMessage) => void;
  onRuntimeStuck: () => void;
};

type Connecting = { phase: "connecting"; gateway: CopilotGateway };
type Connected = { phase: "connected"; gateway: CopilotGateway; modelIds: ReadonlySet<string> };
type Sending = { phase: "sending"; gateway: CopilotGateway; modelIds: ReadonlySet<string>; turn: Turn; outputLength: number };
type Stopping = { phase: "stopping"; gateway: CopilotGateway; modelIds: ReadonlySet<string> };
type Closing = { phase: "closing"; cleanup: Promise<void> };
type Closed = { phase: "closed"; cleanup: Promise<void> };
type ServiceState = { phase: "ready" } | Connecting | Connected | Sending | Stopping | Closing | Closed;
type AbandonReason = "output_limit" | "timeout";

export function createCompanionService({ createGateway, emit, onRuntimeStuck }: CompanionServiceOptions) {
  let state: ServiceState = { phase: "ready" };
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function startDeadline(timeoutMs: number, onExpired: () => void) {
    deadline = setTimeout(onExpired, timeoutMs);
  }

  function clearDeadline() {
    clearTimeout(deadline);
    deadline = undefined;
  }

  function connect(token: string) {
    if (state.phase === "connecting" || state.phase === "closing") return emit(connectError("busy"));
    if (state.phase !== "ready") return emit(connectError("already_connected"));

    let gateway: CopilotGateway;
    try {
      gateway = createGateway();
    } catch {
      return emit(connectError("sdk_start_failed"));
    }
    const connecting: Connecting = { phase: "connecting", gateway };
    state = connecting;
    startDeadline(OPERATION_TIMEOUT_MS, () => failConnect(connecting, "timeout"));

    gateway.connect(token).then(
      ({ login, models }) => {
        if (state !== connecting) return;
        clearDeadline();
        state = { phase: "connected", gateway, modelIds: new Set(models.map((model) => model.id)) };
        emit(login === undefined ? { type: "connected", models } : { type: "connected", login, models });
      },
      (error: unknown) => failConnect(connecting, connectFailureCode(error)),
    );
  }

  function failConnect(connecting: Connecting, code: ErrorCode<"connect">) {
    if (state !== connecting) return;
    clearDeadline();
    const closing: Closing = { phase: "closing", cleanup: closeQuietly(connecting.gateway) };
    state = closing;
    void closing.cleanup.then(() => {
      if (state !== closing) return;
      state = { phase: "ready" };
      emit(connectError(code));
    });
  }

  function send(model: string) {
    if (state.phase === "ready") return emit(sendError("not_connected"));
    if (state.phase !== "connected") return emit(sendError("busy"));
    if (!state.modelIds.has(model)) return emit(sendError("unknown_model"));

    const { gateway, modelIds } = state;
    let sending: Sending;
    try {
      const turn = gateway.startTurn({
        model,
        prompt: FIXED_TEST_PROMPT,
        onEvent: (event) => forwardTurnEvent(sending, event),
      });
      sending = { phase: "sending", gateway, modelIds, turn, outputLength: 0 };
    } catch (error) {
      return emit(sendError(turnFailureCode(error)));
    }
    state = sending;
    startDeadline(OPERATION_TIMEOUT_MS, () => abandonTurn(sending, "timeout"));

    sending.turn.outcome.then(
      (outcome) => endTurn(sending, { type: "done", outcome }),
      (error: unknown) => endTurn(sending, sendError(turnFailureCode(error))),
    );
  }

  function forwardTurnEvent(sending: Sending, event: TurnEvent) {
    if (state !== sending) return;
    if (event.type === "usage") {
      const { model, cost } = event;
      return emit(cost === undefined ? { type: "usage", model } : { type: "usage", model, cost });
    }
    if (event.text.length === 0) return;

    const remainingLength = MAX_OUTPUT_LENGTH - sending.outputLength;
    if (event.text.length <= remainingLength) {
      sending.outputLength += event.text.length;
      return emit({ type: "delta", text: event.text });
    }
    const textWithinLimit = truncateWithoutSplittingSurrogatePairs(event.text, remainingLength);
    if (textWithinLimit.length > 0) emit({ type: "delta", text: textWithinLimit });
    abandonTurn(sending, "output_limit");
  }

  function abandonTurn(sending: Sending, reason: AbandonReason) {
    if (state !== sending) return;
    clearDeadline();
    const stopping: Stopping = { phase: "stopping", gateway: sending.gateway, modelIds: sending.modelIds };
    state = stopping;
    abortQuietly(sending.turn);
    startDeadline(ABORT_TIMEOUT_MS, () => giveUpOnRuntime(stopping, reason));

    const reportOnceTurnEnds = () => {
      if (state !== stopping) return;
      clearDeadline();
      state = { phase: "connected", gateway: stopping.gateway, modelIds: stopping.modelIds };
      emit(sendError(reason));
    };
    sending.turn.outcome.then(reportOnceTurnEnds, reportOnceTurnEnds);
  }

  function giveUpOnRuntime(stopping: Stopping, reason: AbandonReason) {
    if (state !== stopping) return;
    emit(sendError(reason));
    void shutdown();
    onRuntimeStuck();
  }

  function endTurn(sending: Sending, message: CompanionMessage) {
    if (state !== sending) return;
    clearDeadline();
    state = { phase: "connected", gateway: sending.gateway, modelIds: sending.modelIds };
    emit(message);
  }

  function stop() {
    if (state.phase === "sending") abortQuietly(state.turn);
  }

  function shutdown() {
    if (state.phase !== "closed") {
      clearDeadline();
      state = { phase: "closed", cleanup: cleanupFor(state) };
    }
    return state.cleanup;
  }

  return {
    handle(message: PanelMessage) {
      if (state.phase === "closed") return;
      if (message.type === "connect") connect(message.token);
      else if (message.type === "send") send(message.model);
      else stop();
    },
    shutdown,
  };
}

function cleanupFor(state: Exclude<ServiceState, Closed>): Promise<void> {
  if (state.phase === "ready") return Promise.resolve();
  if (state.phase === "closing") return state.cleanup;
  return closeQuietly(state.gateway);
}

function abortQuietly(turn: Turn) {
  turn.abort().catch(() => {});
}

function connectError(code: ErrorCode<"connect">): CompanionMessage {
  return { type: "error", stage: "connect", code };
}

function sendError(code: ErrorCode<"send">): CompanionMessage {
  return { type: "error", stage: "send", code };
}

function connectFailureCode(error: unknown): ConnectFailureCode {
  const code = error instanceof GatewayFailure ? error.code : undefined;
  return CONNECT_FAILURE_CODES.find((candidate) => candidate === code) ?? "sdk_start_failed";
}

function turnFailureCode(error: unknown): TurnFailureCode {
  const code = error instanceof GatewayFailure ? error.code : undefined;
  return TURN_FAILURE_CODES.find((candidate) => candidate === code) ?? "send_failed";
}

function truncateWithoutSplittingSurrogatePairs(text: string, maxLength: number) {
  const truncated = text.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

async function closeQuietly(gateway: CopilotGateway) {
  try {
    await gateway.close();
  } catch {
    return;
  }
}
