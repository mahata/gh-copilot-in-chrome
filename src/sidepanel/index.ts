import { openCompanionBridge } from "./companion.ts";
import type { BridgeEvent, CompanionBridge, SessionMessage } from "./companion.ts";
import {
  BRIDGE_FAILURE_TEXT,
  CONNECT_ERROR_TEXT,
  connectedStatus,
  CREDENTIAL_ERROR_TEXT,
  MODEL_PLACEHOLDER_TEXT,
  modelOptionLabel,
  NO_RESPONSE_TEXT,
  NOT_FINE_GRAINED_PAT,
  readyStatus,
  SAVED_TOKEN_REJECTED_TEXT,
  SEND_ERROR_TEXT,
  STATUS_TEXT,
  usageReport,
} from "./copy.ts";
import { FIXED_TEST_PROMPT, isFineGrainedPersonalAccessToken } from "../protocol/messages.ts";
import type { ModelSummary } from "../protocol/messages.ts";
import "./style.css";

type PanelPhase = "detecting" | "unavailable" | "ready" | "connecting" | "connected" | "sending";
type SessionError = Extract<SessionMessage, { type: "error" }>;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing interface element: ${id}`);
  return found;
}

const statusBar = element("status-bar", HTMLDivElement);
const status = element("status", HTMLParagraphElement);
const errorNotice = element("error", HTMLParagraphElement);
const checkAgainButton = element("check-again", HTMLButtonElement);
const savedTokenControls = element("saved-token", HTMLDivElement);
const connectSavedButton = element("connect-saved", HTMLButtonElement);
const forgetButton = element("forget", HTMLButtonElement);
const authForm = element("auth-form", HTMLFormElement);
const pat = element("pat", HTMLInputElement);
const remember = element("remember", HTMLInputElement);
const connectButton = element("connect", HTMLButtonElement);
const disconnectButton = element("disconnect", HTMLButtonElement);
const model = element("model", HTMLSelectElement);
const inferenceConsent = element("inference-consent", HTMLInputElement);
const sendButton = element("send", HTMLButtonElement);
const stopButton = element("stop", HTMLButtonElement);
const output = element("output", HTMLPreElement);
const usage = element("usage", HTMLParagraphElement);

let phase: PanelPhase = "detecting";
let bridge: CompanionBridge | undefined;
let sdkVersion = "";
let stopRequested = false;
let savedToken = false;
let forgetPending = false;
let connectingWithSavedToken = false;
let autoConnect = true;

function startCompanion() {
  phase = "detecting";
  status.textContent = STATUS_TEXT.detecting;
  const openedBridge = openCompanionBridge({
    connectNative: (hostName) => chrome.runtime.connectNative(hostName),
    readLastError: () => chrome.runtime.lastError?.message,
    onEvent: (event) => {
      if (bridge === openedBridge) handleBridgeEvent(event);
    },
  });
  bridge = openedBridge;
  updateControls();
}

function resetPanel() {
  bridge?.close();
  bridge = undefined;
  pat.value = "";
  discardCompanionState();
  output.textContent = NO_RESPONSE_TEXT;
  hideUsage();
  hideError();
}

function discardCompanionState() {
  stopRequested = false;
  savedToken = false;
  forgetPending = false;
  connectingWithSavedToken = false;
  showModels([], MODEL_PLACEHOLDER_TEXT.disconnected);
}

function connectWithSavedToken() {
  hideError();
  if (bridge?.send({ type: "connect_saved" })) startConnecting({ withSavedToken: true });
}

function startConnecting({ withSavedToken }: { withSavedToken: boolean }) {
  phase = "connecting";
  connectingWithSavedToken = withSavedToken;
  status.textContent = withSavedToken ? STATUS_TEXT.connectingWithSavedToken : STATUS_TEXT.connecting;
}

function handleBridgeEvent(event: BridgeEvent) {
  switch (event.type) {
    case "ready":
      sdkVersion = event.sdkVersion;
      savedToken = event.savedToken;
      phase = "ready";
      status.textContent = readyStatus(sdkVersion);
      if (savedToken && autoConnect) connectWithSavedToken();
      break;
    case "message":
      handleSessionMessage(event.message);
      break;
    case "closed":
      bridge = undefined;
      phase = "unavailable";
      discardCompanionState();
      status.textContent = STATUS_TEXT.unavailable;
      showError(BRIDGE_FAILURE_TEXT[event.failure], event.failure);
      break;
  }
  updateControls();
}

function handleSessionMessage(message: SessionMessage) {
  switch (message.type) {
    case "connected": {
      if (phase !== "connecting") return;
      phase = "connected";
      const placeholder = message.models.length > 0 ? MODEL_PLACEHOLDER_TEXT.choose : MODEL_PLACEHOLDER_TEXT.none;
      showModels(message.models, placeholder);
      status.textContent = connectedStatus(message.login, message.models.length);
      return;
    }
    case "credential":
      savedToken = message.saved;
      if (!message.saved) forgetPending = false;
      return;
    case "delta":
      if (phase === "sending") output.append(message.text);
      return;
    case "usage":
      if (phase !== "sending") return;
      usage.textContent = usageReport(message.model, message.cost);
      usage.hidden = false;
      return;
    case "done":
      if (phase !== "sending") return;
      phase = "connected";
      status.textContent = message.outcome === "stopped" ? STATUS_TEXT.stopped : STATUS_TEXT.complete;
      return;
    case "error":
      return handleSessionError(message);
  }
}

function handleSessionError(message: SessionError) {
  switch (message.stage) {
    case "connect": {
      if (phase === "connecting") {
        phase = "ready";
        status.textContent = readyStatus(sdkVersion);
      }
      if (message.code === "no_saved_token") savedToken = false;
      const savedTokenRejected = message.code === "auth_failed" && connectingWithSavedToken;
      return showError(savedTokenRejected ? SAVED_TOKEN_REJECTED_TEXT : CONNECT_ERROR_TEXT[message.code], message.code);
    }
    case "send":
      if (phase === "sending") {
        phase = "connected";
        status.textContent = STATUS_TEXT.sendFailed;
      }
      return showError(SEND_ERROR_TEXT[message.code], message.code);
    case "credential":
      if (message.code === "forget_failed") forgetPending = false;
      return showError(CREDENTIAL_ERROR_TEXT[message.code], message.code);
  }
}

function showModels(models: readonly ModelSummary[], placeholder: string) {
  model.replaceChildren(
    new Option(placeholder, ""),
    ...models.map((summary) => new Option(modelOptionLabel(summary), summary.id)),
  );
  inferenceConsent.checked = false;
}

function showError(text: string, code: string) {
  errorNotice.textContent = `${text} (${code})`;
  errorNotice.hidden = false;
}

function hideError() {
  errorNotice.hidden = true;
  errorNotice.textContent = "";
}

function hideUsage() {
  usage.hidden = true;
  usage.textContent = "";
}

function updateControls() {
  const ready = phase === "ready";
  const connected = phase === "connected";
  const connectionOpen = phase === "connecting" || connected || phase === "sending";
  pat.disabled = !ready;
  remember.disabled = !ready;
  connectButton.disabled = !ready || pat.value.trim() === "";
  disconnectButton.hidden = !connectionOpen;
  savedTokenControls.hidden = !savedToken;
  connectSavedButton.disabled = !ready;
  forgetButton.disabled = forgetPending;
  model.disabled = !connected || model.options.length <= 1;
  inferenceConsent.disabled = !connected || model.value === "";
  sendButton.disabled = !connected || model.value === "" || !inferenceConsent.checked;
  stopButton.disabled = phase !== "sending" || stopRequested;
  checkAgainButton.hidden = phase !== "unavailable";
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (connectButton.disabled) return;
  const token = pat.value.trim();
  pat.value = "";
  hideError();
  if (!isFineGrainedPersonalAccessToken(token)) {
    showError(NOT_FINE_GRAINED_PAT.text, NOT_FINE_GRAINED_PAT.code);
  } else if (bridge?.send({ type: "connect", token, remember: remember.checked })) {
    startConnecting({ withSavedToken: false });
  }
  updateControls();
});

connectSavedButton.addEventListener("click", () => {
  if (connectSavedButton.disabled) return;
  connectWithSavedToken();
  updateControls();
});

forgetButton.addEventListener("click", () => {
  if (forgetButton.disabled) return;
  hideError();
  if (bridge?.send({ type: "forget" })) forgetPending = true;
  updateControls();
});

disconnectButton.addEventListener("click", () => {
  autoConnect = false;
  resetPanel();
  startCompanion();
});

sendButton.addEventListener("click", () => {
  if (sendButton.disabled) return;
  const modelId = model.value;
  inferenceConsent.checked = false;
  hideError();
  if (bridge?.send({ type: "send", model: modelId })) {
    phase = "sending";
    stopRequested = false;
    output.textContent = "";
    hideUsage();
    status.textContent = STATUS_TEXT.sending;
  }
  updateControls();
});

stopButton.addEventListener("click", () => {
  if (stopButton.disabled) return;
  if (bridge?.send({ type: "stop" })) {
    stopRequested = true;
    status.textContent = STATUS_TEXT.stopping;
  }
  updateControls();
});

checkAgainButton.addEventListener("click", () => {
  hideError();
  autoConnect = true;
  startCompanion();
});

pat.addEventListener("input", updateControls);
inferenceConsent.addEventListener("change", updateControls);
model.addEventListener("change", () => {
  inferenceConsent.checked = false;
  updateControls();
});
window.addEventListener("pagehide", resetPanel);
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--status-bar-height", `${statusBar.offsetHeight}px`);
}).observe(statusBar);

element("prompt", HTMLPreElement).textContent = FIXED_TEST_PROMPT;
resetPanel();
startCompanion();
