import type { BridgeFailure } from "./companion.ts";
import { HOST_NAME } from "../protocol/identity.ts";
import { CONNECT_TIMEOUT_MS, MAX_OUTPUT_LENGTH, MAX_PROMPT_LENGTH, TURN_TIMEOUT_MS } from "../protocol/messages.ts";
import type { ErrorCode, ModelSummary } from "../protocol/messages.ts";

const REINSTALL_HINT = "run npm run companion:install in this repository's checkout, then choose Check again.";
const CONNECT_TIMEOUT_SECONDS = CONNECT_TIMEOUT_MS / 1000;
const TURN_TIMEOUT_MINUTES = TURN_TIMEOUT_MS / 60_000;
const OUTPUT_LIMIT = formatCount(MAX_OUTPUT_LENGTH);
const PROMPT_LIMIT = formatCount(MAX_PROMPT_LENGTH);

export const STATUS_TEXT = {
  detecting: "Looking for the local companion…",
  unavailable: "Companion unavailable.",
  connecting: "Live: starting the Copilot SDK and checking the PAT with GitHub…",
  connectingWithSavedToken: "Live: starting the Copilot SDK and checking the saved PAT with GitHub…",
  sending: "Live: waiting for Copilot's response…",
  stopping: "Stopping… Output may be incomplete.",
  complete: "Response complete.",
  stopped: "Stopped. Output may be incomplete.",
  sendFailed: "The request did not finish. You are still connected.",
  newChat: "New chat started. Copilot no longer sees the earlier messages.",
} as const;

export const MODEL_PLACEHOLDER_TEXT = {
  disconnected: "Connect first",
  none: "No enabled models were returned",
} as const;

export const EMPTY_TRANSCRIPT_TEXT = "No messages yet.";
export const PROMPT_AUTHOR_LABEL = "You";
export const INTERRUPTED_TURN_NOTE = "The companion stopped before the response finished.";

export const NOT_FINE_GRAINED_PAT = {
  code: "not_fine_grained_pat",
  text: "Only fine-grained PATs are accepted, and they start with github_pat_. The token was not sent.",
} as const;

export const BRIDGE_FAILURE_TEXT: Record<BridgeFailure, string> = {
  companion_not_installed: `The local companion is not installed. To install it, ${REINSTALL_HINT}`,
  companion_forbidden: `Chrome refused to start the companion for this extension. To repair it, ${REINSTALL_HINT}`,
  companion_start_failed: `Chrome could not start the companion. If you moved this checkout or changed Node.js, ${REINSTALL_HINT}`,
  companion_exited: "The companion stopped unexpectedly, discarding its PAT and SDK session. Choose Check again to start a fresh one.",
  companion_protocol:
    "The companion sent a message this panel does not accept, so the panel disconnected it. " +
    "If you updated this checkout, run npm run build and reload the extension in chrome://extensions. " +
    `Otherwise, ${REINSTALL_HINT}`,
};

export const CONNECT_ERROR_TEXT: Record<ErrorCode<"connect">, string> = {
  busy: "A connection attempt is already running.",
  already_connected: "The companion is already connected. Disconnect to use a different PAT.",
  no_saved_token: "No PAT is saved in your macOS login keychain anymore. Paste a PAT to connect.",
  keychain_read_failed:
    "The companion could not read the saved PAT from your macOS login keychain. " +
    "Unlock the keychain and choose Connect with saved PAT, or paste a PAT to connect.",
  sdk_start_failed: "The Copilot SDK runtime could not start on this computer.",
  auth_failed:
    "GitHub did not accept this PAT. Use an unexpired fine-grained PAT owned by your personal account with the Copilot Requests permission.",
  models_unavailable: "The PAT was accepted, but the Copilot SDK could not list models for this account.",
  timeout: `Connecting took longer than ${CONNECT_TIMEOUT_SECONDS} seconds, so the companion gave up.`,
};

export const SAVED_TOKEN_REJECTED_TEXT =
  "GitHub did not accept the saved PAT. It may have expired or been revoked. " +
  "Paste a new PAT with Remember checked to replace it, or choose Forget saved PAT.";

export const CREDENTIAL_ERROR_TEXT: Record<ErrorCode<"credential">, string> = {
  save_failed:
    "You are still connected, but the companion could not save the PAT in your macOS login keychain, " +
    "so you will need to paste it next time.",
  forget_failed: `The companion could not remove the saved PAT. Delete the ${HOST_NAME} item in Keychain Access instead.`,
};

export const SEND_ERROR_TEXT: Record<ErrorCode<"send">, string> = {
  busy: "A request is already running.",
  not_connected: "Connect with a PAT before sending.",
  unknown_model: "That model is not in the list returned for this account.",
  auth_failed: "GitHub rejected the PAT during the request.",
  not_authorized: "This account is not allowed to use that model.",
  quota_exceeded: "The Copilot allowance for this model is used up.",
  rate_limited: "GitHub is rate-limiting requests. Wait before trying again.",
  context_limit: "The conversation is too long for this model's context window. Choose New chat to start over.",
  send_failed: "The request failed before the response finished.",
  output_limit: `The response passed ${OUTPUT_LIMIT} characters, so the companion stopped it. Output is incomplete.`,
  timeout: `The response did not finish within ${TURN_TIMEOUT_MINUTES} minutes, so the companion stopped it. Output may be incomplete.`,
};

export function readyStatus(sdkVersion: string) {
  return `Companion ready (Copilot SDK ${sdkVersion}). Not connected to GitHub.`;
}

export function connectedStatus(login: string | undefined, modelCount: number) {
  const account = login === undefined ? "Connected" : `Connected as ${login}`;
  if (modelCount === 0) return `${account}, but GitHub returned no enabled models, so there is nothing to send.`;
  return `${account}. ${modelCount} enabled ${modelCount === 1 ? "model" : "models"} available.`;
}

export function modelOptionLabel({ name, multiplier }: ModelSummary) {
  return `${name} (${billingMultiplier(multiplier)})`;
}

export function usageReport(model: string, cost: number | undefined) {
  return `SDK usage report: ${model}, ${billingMultiplier(cost)}.`;
}

export function replyAuthorLabel(modelName: string) {
  return `Copilot (${modelName})`;
}

export function failedTurnNote(code: ErrorCode<"send">) {
  return `The request did not finish (${code}).`;
}

export function promptTooLongText(length: number) {
  return `This prompt is ${formatCount(length)} characters. Shorten it to ${PROMPT_LIMIT} or fewer to send.`;
}

function billingMultiplier(multiplier: number | undefined) {
  return `billing multiplier ${multiplier === undefined ? "not reported" : `${multiplier}×`}`;
}

function formatCount(count: number) {
  return count.toLocaleString("en-US");
}
