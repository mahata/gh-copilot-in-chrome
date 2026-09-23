export const PROTOCOL_VERSION = 1;

export const FIXED_TEST_PROMPT = "Reply with exactly: Connection confirmed.";

export const MAX_TOKEN_LENGTH = 255;
export const MAX_FIELD_LENGTH = 200;
export const MAX_MODELS = 200;
export const MAX_OUTPUT_LENGTH = 65_536;

export const ERROR_CODES_BY_STAGE = {
  connect: ["busy", "already_connected", "sdk_start_failed", "auth_failed", "models_unavailable", "timeout"],
  send: [
    "busy",
    "not_connected",
    "unknown_model",
    "auth_failed",
    "not_authorized",
    "quota_exceeded",
    "rate_limited",
    "send_failed",
    "output_limit",
    "timeout",
  ],
  protocol: ["invalid_message", "frame_too_large"],
} as const;

const TURN_OUTCOMES = ["complete", "stopped"] as const;

type ErrorCodesByStage = typeof ERROR_CODES_BY_STAGE;
export type ErrorStage = keyof ErrorCodesByStage;
export type ErrorCode<Stage extends ErrorStage> = ErrorCodesByStage[Stage][number];
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export type PanelMessage = { type: "connect"; token: string } | { type: "send"; model: string } | { type: "stop" };

export type ModelSummary = { id: string; name: string; multiplier?: number };

export type CompanionErrorMessage = {
  [Stage in ErrorStage]: { type: "error"; stage: Stage; code: ErrorCode<Stage> };
}[ErrorStage];

export type CompanionMessage =
  | { type: "hello"; protocolVersion: number; sdkVersion: string }
  | { type: "connected"; login?: string; models: ModelSummary[] }
  | { type: "delta"; text: string }
  | { type: "usage"; model: string; cost?: number }
  | { type: "done"; outcome: TurnOutcome }
  | CompanionErrorMessage;

type JsonObject = Record<string, unknown>;

const FINE_GRAINED_TOKEN_PATTERN = /^github_pat_[A-Za-z0-9_]+$/;

export function isFineGrainedPersonalAccessToken(token: string) {
  return token.length <= MAX_TOKEN_LENGTH && FINE_GRAINED_TOKEN_PATTERN.test(token);
}

export function parsePanelMessage(value: unknown): PanelMessage | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value.type) {
    case "connect":
      return hasExactlyKeys(value, ["type", "token"]) &&
        typeof value.token === "string" &&
        isFineGrainedPersonalAccessToken(value.token)
        ? { type: "connect", token: value.token }
        : undefined;
    case "send":
      return hasExactlyKeys(value, ["type", "model"]) && isBoundedText(value.model, MAX_FIELD_LENGTH)
        ? { type: "send", model: value.model }
        : undefined;
    case "stop":
      return hasExactlyKeys(value, ["type"]) ? { type: "stop" } : undefined;
    default:
      return undefined;
  }
}

export function parseCompanionMessage(value: unknown): CompanionMessage | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value.type) {
    case "hello":
      return hasExactlyKeys(value, ["type", "protocolVersion", "sdkVersion"]) &&
        isInteger(value.protocolVersion) &&
        isBoundedText(value.sdkVersion, MAX_FIELD_LENGTH)
        ? { type: "hello", protocolVersion: value.protocolVersion, sdkVersion: value.sdkVersion }
        : undefined;
    case "connected":
      return parseConnected(value);
    case "delta":
      return hasExactlyKeys(value, ["type", "text"]) && isBoundedText(value.text, MAX_OUTPUT_LENGTH)
        ? { type: "delta", text: value.text }
        : undefined;
    case "usage":
      return parseUsage(value);
    case "done":
      return hasExactlyKeys(value, ["type", "outcome"]) && isOneOf(value.outcome, TURN_OUTCOMES)
        ? { type: "done", outcome: value.outcome }
        : undefined;
    case "error":
      return parseError(value);
    default:
      return undefined;
  }
}

function parseConnected(value: JsonObject): CompanionMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "models"], ["login"])) return undefined;
  if (!Array.isArray(value.models) || value.models.length > MAX_MODELS) return undefined;
  const models = value.models.map(parseModel);
  if (!models.every((model): model is ModelSummary => model !== undefined)) return undefined;
  if (value.login === undefined) return { type: "connected", models };
  return isBoundedText(value.login, MAX_FIELD_LENGTH) ? { type: "connected", login: value.login, models } : undefined;
}

function parseModel(value: unknown): ModelSummary | undefined {
  if (!isJsonObject(value) || !hasExactlyKeys(value, ["id", "name"], ["multiplier"])) return undefined;
  if (!isBoundedText(value.id, MAX_FIELD_LENGTH) || !isBoundedText(value.name, MAX_FIELD_LENGTH)) return undefined;
  if (value.multiplier === undefined) return { id: value.id, name: value.name };
  return isNonNegativeNumber(value.multiplier) ? { id: value.id, name: value.name, multiplier: value.multiplier } : undefined;
}

function parseUsage(value: JsonObject): CompanionMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "model"], ["cost"]) || !isBoundedText(value.model, MAX_FIELD_LENGTH)) {
    return undefined;
  }
  if (value.cost === undefined) return { type: "usage", model: value.model };
  return isNonNegativeNumber(value.cost) ? { type: "usage", model: value.model, cost: value.cost } : undefined;
}

function parseError(value: JsonObject): CompanionErrorMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "stage", "code"])) return undefined;
  const { stage, code } = value;
  if (stage === "connect" && isOneOf(code, ERROR_CODES_BY_STAGE.connect)) return { type: "error", stage, code };
  if (stage === "send" && isOneOf(code, ERROR_CODES_BY_STAGE.send)) return { type: "error", stage, code };
  if (stage === "protocol" && isOneOf(code, ERROR_CODES_BY_STAGE.protocol)) return { type: "error", stage, code };
  return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf<Option extends string>(value: unknown, options: readonly Option[]): value is Option {
  return options.some((option) => option === value);
}
