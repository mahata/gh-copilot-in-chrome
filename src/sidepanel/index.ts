import { openCompanionBridge } from "./companion.ts";
import type { BridgeEvent, CompanionBridge, SessionMessage } from "./companion.ts";
import {
  BRIDGE_FAILURE_TEXT,
  CONNECT_ERROR_TEXT,
  connectedStatus,
  MODEL_PLACEHOLDER_TEXT,
  modelOptionLabel,
  NO_RESPONSE_TEXT,
  NOT_FINE_GRAINED_PAT,
  readyStatus,
  SEND_ERROR_TEXT,
  STATUS_TEXT,
  usageReport,
} from "./copy.ts";
import { FIXED_TEST_PROMPT, isFineGrainedPersonalAccessToken } from "../protocol/messages.ts";
import type { ModelSummary } from "../protocol/messages.ts";
import "./style.css";

type PanelPhase = "detecting" | "unavailable" | "ready" | "connecting" | "connected" | "sending";

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing interface element: ${id}`);
  return found;
}

const statusBar = element("status-bar", HTMLDivElement);
const status = element("status", HTMLParagraphElement);
const errorNotice = element("error", HTMLParagraphElement);
const checkAgainButton = element("check-again", HTMLButtonElement);
const authForm = element("auth-form", HTMLFormElement);
const pat = element("pat", HTMLInputElement);
const authConsent = element("auth-consent", HTMLInputElement);
const connectButton = element("connect", HTMLButtonElement);
const model = element("model", HTMLSelectElement);
const inferenceConsent = element("inference-consent", HTMLInputElement);
const sendButton = element("send", HTMLButtonElement);
const stopButton = element("stop", HTMLButtonElement);
const output = element("output", HTMLPreElement);
const usage = element("usage", HTMLParagraphElement);
const clearButton = element("clear", HTMLButtonElement);

let phase: PanelPhase = "detecting";
let bridge: CompanionBridge | undefined;
let sdkVersion = "";
let stopRequested = false;

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
  authConsent.checked = false;
  forgetConnection();
  output.textContent = NO_RESPONSE_TEXT;
  hideUsage();
  hideError();
}

function forgetConnection() {
  stopRequested = false;
  showModels([], MODEL_PLACEHOLDER_TEXT.disconnected);
}

function handleBridgeEvent(event: BridgeEvent) {
  switch (event.type) {
    case "ready":
      sdkVersion = event.sdkVersion;
      phase = "ready";
      status.textContent = readyStatus(sdkVersion);
      break;
    case "message":
      handleSessionMessage(event.message);
      break;
    case "closed":
      bridge = undefined;
      phase = "unavailable";
      forgetConnection();
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
      if (message.stage === "connect") {
        if (phase === "connecting") {
          phase = "ready";
          status.textContent = readyStatus(sdkVersion);
        }
        showError(CONNECT_ERROR_TEXT[message.code], message.code);
      } else {
        if (phase === "sending") {
          phase = "connected";
          status.textContent = STATUS_TEXT.sendFailed;
        }
        showError(SEND_ERROR_TEXT[message.code], message.code);
      }
      return;
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
  pat.disabled = !ready;
  authConsent.disabled = !ready;
  connectButton.disabled = !ready || !authConsent.checked || pat.value.trim() === "";
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
  authConsent.checked = false;
  hideError();
  if (!isFineGrainedPersonalAccessToken(token)) {
    showError(NOT_FINE_GRAINED_PAT.text, NOT_FINE_GRAINED_PAT.code);
  } else if (bridge?.send({ type: "connect", token })) {
    phase = "connecting";
    status.textContent = STATUS_TEXT.connecting;
  }
  updateControls();
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
  startCompanion();
});

clearButton.addEventListener("click", () => {
  resetPanel();
  startCompanion();
});

pat.addEventListener("input", updateControls);
authConsent.addEventListener("change", updateControls);
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
