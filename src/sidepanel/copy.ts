import type { BridgeFailure } from "./companion.ts";
import { MAX_OUTPUT_LENGTH, OPERATION_TIMEOUT_MS } from "../protocol/messages.ts";
import type { ErrorCode, ModelSummary } from "../protocol/messages.ts";

const REINSTALL_HINT = "run npm run companion:install in this repository's checkout, then choose Check again.";
const OPERATION_TIMEOUT_SECONDS = OPERATION_TIMEOUT_MS / 1000;
const OUTPUT_LIMIT = MAX_OUTPUT_LENGTH.toLocaleString("en-US");

export const STATUS_TEXT = {
  detecting: "Looking for the local companion…",
  unavailable: "Companion unavailable.",
  connecting: "Live: starting the Copilot SDK and checking the PAT with GitHub…",
  sending: "Live: waiting for the test response…",
  stopping: "Stopping… Output may be incomplete.",
  complete: "Response complete.",
  stopped: "Stopped. Output may be incomplete.",
  sendFailed: "The request did not finish. You are still connected.",
} as const;

export const MODEL_PLACEHOLDER_TEXT = {
  disconnected: "Connect first",
  choose: "Choose a model",
  none: "No enabled models were returned",
} as const;

export const NO_RESPONSE_TEXT = "No response yet.";

export const NOT_FINE_GRAINED_PAT = {
  code: "not_fine_grained_pat",
  text: "Only fine-grained PATs are accepted, and they start with github_pat_. The token was not sent.",
} as const;

export const BRIDGE_FAILURE_TEXT: Record<BridgeFailure, string> = {
  companion_not_installed: `The local companion is not installed. To install it, ${REINSTALL_HINT}`,
  companion_forbidden: `Chrome refused to start the companion for this extension. To repair it, ${REINSTALL_HINT}`,
  companion_start_failed: `Chrome could not start the companion. If you moved this checkout or changed Node.js, ${REINSTALL_HINT}`,
  companion_exited: "The companion stopped unexpectedly, discarding its PAT and SDK session. Choose Check again to start a fresh one.",
  companion_protocol: `The companion sent a message this panel does not accept, so the panel disconnected it. To update it, ${REINSTALL_HINT}`,
};

export const CONNECT_ERROR_TEXT: Record<ErrorCode<"connect">, string> = {
  busy: "A connection attempt is already running.",
  already_connected: "The companion is already connected. Clear to use a different PAT.",
  sdk_start_failed: "The Copilot SDK runtime could not start on this computer.",
  auth_failed:
    "GitHub did not accept this PAT. Use an unexpired fine-grained PAT owned by your personal account with the Copilot Requests permission.",
  models_unavailable: "The PAT was accepted, but the Copilot SDK could not list models for this account.",
  timeout: `Connecting took longer than ${OPERATION_TIMEOUT_SECONDS} seconds, so the companion gave up.`,
};

export const SEND_ERROR_TEXT: Record<ErrorCode<"send">, string> = {
  busy: "A request is already running.",
  not_connected: "Connect with a PAT before sending.",
  unknown_model: "That model is not in the list returned for this account.",
  auth_failed: "GitHub rejected the PAT during the request.",
  not_authorized: "This account is not allowed to use that model.",
  quota_exceeded: "The Copilot allowance for this model is used up.",
  rate_limited: "GitHub is rate-limiting requests. Wait before trying again.",
  send_failed: "The request failed before the response finished.",
  output_limit: `The response passed ${OUTPUT_LIMIT} characters, so the companion stopped it. Output is incomplete.`,
  timeout: `The response did not finish within ${OPERATION_TIMEOUT_SECONDS} seconds, so the companion stopped it. Output may be incomplete.`,
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
  return multiplier === undefined
    ? `${name} (premium request multiplier not reported)`
    : `${name} (${multiplier}× premium requests)`;
}

export function usageReport(model: string, cost: number | undefined) {
  const multiplier = cost === undefined ? "not reported" : `${cost}×`;
  return `SDK usage report: ${model}, billing multiplier ${multiplier}.`;
}
