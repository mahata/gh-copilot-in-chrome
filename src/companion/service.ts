import { CONNECT_FAILURE_CODES, GatewayFailure, TURN_FAILURE_CODES } from "./gateway.ts";
import type { ConnectFailureCode, CopilotGateway, Turn, TurnEvent, TurnFailureCode } from "./gateway.ts";
import { FIXED_TEST_PROMPT, MAX_OUTPUT_LENGTH } from "../protocol/messages.ts";
import type { CompanionMessage, ErrorCode, PanelMessage } from "../protocol/messages.ts";

export const OPERATION_TIMEOUT_MS = 60_000;

type CompanionServiceOptions = {
  createGateway: () => CopilotGateway;
  emit: (message: CompanionMessage) => void;
};

type Connecting = { phase: "connecting"; gateway: CopilotGateway };
type Connected = { phase: "connected"; gateway: CopilotGateway; modelIds: ReadonlySet<string> };
type Sending = {
  phase: "sending";
  gateway: CopilotGateway;
  modelIds: ReadonlySet<string>;
  abortTurn: () => void;
  outputLength: number;
};
type ServiceState = { phase: "ready" } | Connecting | Connected | Sending | { phase: "closed" };

export function createCompanionService({ createGateway, emit }: CompanionServiceOptions) {
  let state: ServiceState = { phase: "ready" };
  let operationTimer: ReturnType<typeof setTimeout> | undefined;

  function startOperationTimer(onTimeout: () => void) {
    operationTimer = setTimeout(onTimeout, OPERATION_TIMEOUT_MS);
  }

  function clearOperationTimer() {
    clearTimeout(operationTimer);
    operationTimer = undefined;
  }

  function connect(token: string) {
    if (state.phase === "connecting") return emit(connectError("busy"));
    if (state.phase !== "ready") return emit(connectError("already_connected"));

    let gateway: CopilotGateway;
    try {
      gateway = createGateway();
    } catch {
      return emit(connectError("sdk_start_failed"));
    }
    const connecting: Connecting = { phase: "connecting", gateway };
    state = connecting;
    startOperationTimer(() => failConnect(connecting, "timeout"));

    gateway.connect(token).then(
      ({ login, models }) => {
        if (state !== connecting) return;
        clearOperationTimer();
        state = { phase: "connected", gateway, modelIds: new Set(models.map((model) => model.id)) };
        emit(login === undefined ? { type: "connected", models } : { type: "connected", login, models });
      },
      (error: unknown) => failConnect(connecting, connectFailureCode(error)),
    );
  }

  function failConnect(connecting: Connecting, code: ErrorCode<"connect">) {
    if (state !== connecting) return;
    clearOperationTimer();
    state = { phase: "ready" };
    void closeQuietly(connecting.gateway);
    emit(connectError(code));
  }

  function send(model: string) {
    if (state.phase === "ready") return emit(sendError("not_connected"));
    if (state.phase !== "connected") return emit(sendError("busy"));
    if (!state.modelIds.has(model)) return emit(sendError("unknown_model"));

    const { gateway, modelIds } = state;
    const sending: Sending = { phase: "sending", gateway, modelIds, abortTurn: () => {}, outputLength: 0 };
    state = sending;
    let turn: Turn;
    try {
      turn = gateway.startTurn({
        model,
        prompt: FIXED_TEST_PROMPT,
        onEvent: (event) => forwardTurnEvent(sending, event),
      });
    } catch (error) {
      return endTurn(sending, sendError(turnFailureCode(error)));
    }
    sending.abortTurn = () => void turn.abort().catch(() => {});
    startOperationTimer(() => abandonTurn(sending, "timeout"));

    turn.outcome.then(
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

  function abandonTurn(sending: Sending, code: "output_limit" | "timeout") {
    if (state !== sending) return;
    sending.abortTurn();
    endTurn(sending, sendError(code));
  }

  function endTurn(sending: Sending, message: CompanionMessage) {
    if (state !== sending) return;
    clearOperationTimer();
    state = { phase: "connected", gateway: sending.gateway, modelIds: sending.modelIds };
    emit(message);
  }

  function stop() {
    if (state.phase === "sending") state.abortTurn();
  }

  return {
    handle(message: PanelMessage) {
      if (state.phase === "closed") return;
      if (message.type === "connect") connect(message.token);
      else if (message.type === "send") send(message.model);
      else stop();
    },

    async shutdown() {
      if (state.phase === "closed") return;
      const gateway = state.phase === "ready" ? undefined : state.gateway;
      state = { phase: "closed" };
      clearOperationTimer();
      if (gateway) await closeQuietly(gateway);
    },
  };
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
