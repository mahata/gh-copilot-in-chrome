import { openCompanionBridge } from "./companion.ts";
import type { BridgeEvent, CompanionBridge, SessionMessage } from "./companion.ts";
import {
  BRIDGE_FAILURE_TEXT,
  CONNECT_ERROR_TEXT,
  connectedStatus,
  CREDENTIAL_ERROR_TEXT,
  EMPTY_TRANSCRIPT_TEXT,
  failedTurnNote,
  INTERRUPTED_TURN_NOTE,
  MODEL_PLACEHOLDER_TEXT,
  modelOptionLabel,
  NOT_FINE_GRAINED_PAT,
  promptTooLongText,
  readyStatus,
  replyAuthorLabel,
  SAVED_TOKEN_REJECTED_TEXT,
  SEND_ERROR_TEXT,
  STATUS_TEXT,
  usageReport,
} from "./copy.ts";
import { pickDefaultModel } from "./models.ts";
import { createTranscript } from "./transcript.ts";
import type { TranscriptTurn } from "./transcript.ts";
import { isFineGrainedPersonalAccessToken, MAX_PROMPT_LENGTH } from "../protocol/messages.ts";
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
const newChatButton = element("new-chat", HTMLButtonElement);
const transcript = createTranscript(element("transcript", HTMLDivElement), EMPTY_TRANSCRIPT_TEXT);
const promptForm = element("prompt-form", HTMLFormElement);
const model = element("model", HTMLSelectElement);
const promptInput = element("prompt", HTMLTextAreaElement);
const promptLimit = element("prompt-limit", HTMLParagraphElement);
const sendButton = element("send", HTMLButtonElement);
const stopButton = element("stop", HTMLButtonElement);

let phase: PanelPhase = "detecting";
let bridge: CompanionBridge | undefined;
let sdkVersion = "";
let stopRequested = false;
let savedToken = false;
let forgetPending = false;
let connectingWithSavedToken = false;
let autoConnect = true;
let modelsById = new Map<string, ModelSummary>();
let activeTurn: TranscriptTurn | undefined;

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
  promptInput.value = "";
  discardCompanionState();
  transcript.clear();
  hideError();
}

function discardCompanionState() {
  stopRequested = false;
  savedToken = false;
  forgetPending = false;
  connectingWithSavedToken = false;
  activeTurn = undefined;
  showModelPlaceholder(MODEL_PLACEHOLDER_TEXT.disconnected);
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
      finishActiveTurn(INTERRUPTED_TURN_NOTE);
      discardCompanionState();
      status.textContent = STATUS_TEXT.unavailable;
      showError(BRIDGE_FAILURE_TEXT[event.failure], event.failure);
      break;
  }
  updateControls();
}

function handleSessionMessage(message: SessionMessage) {
  switch (message.type) {
    case "connected":
      if (phase !== "connecting") return;
      phase = "connected";
      transcript.clear();
      if (message.models.length > 0) showModels(message.models);
      else showModelPlaceholder(MODEL_PLACEHOLDER_TEXT.none);
      status.textContent = connectedStatus(message.login, message.models.length);
      return;
    case "credential":
      savedToken = message.saved;
      if (!message.saved) forgetPending = false;
      return;
    case "delta":
      activeTurn?.appendReply(message.text);
      return;
    case "usage":
      activeTurn?.showUsage(usageReport(message.model, message.cost));
      return;
    case "done": {
      if (phase !== "sending") return;
      phase = "connected";
      const stopped = message.outcome === "stopped";
      finishActiveTurn(stopped ? STATUS_TEXT.stopped : undefined);
      status.textContent = stopped ? STATUS_TEXT.stopped : STATUS_TEXT.complete;
      return;
    }
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
        finishActiveTurn(failedTurnNote(message.code));
        status.textContent = STATUS_TEXT.sendFailed;
      }
      return showError(SEND_ERROR_TEXT[message.code], message.code);
    case "credential":
      if (message.code === "forget_failed") forgetPending = false;
      return showError(CREDENTIAL_ERROR_TEXT[message.code], message.code);
  }
}

function finishActiveTurn(note?: string) {
  activeTurn?.finish(note);
  activeTurn = undefined;
}

function showModels(models: readonly ModelSummary[]) {
  modelsById = new Map(models.map((summary) => [summary.id, summary]));
  const defaultModel = pickDefaultModel(models);
  model.replaceChildren(
    ...models.map((summary) => new Option(modelOptionLabel(summary), summary.id, false, summary === defaultModel)),
  );
}

function showModelPlaceholder(text: string) {
  modelsById = new Map();
  model.replaceChildren(new Option(text, ""));
}

function showError(text: string, code: string) {
  errorNotice.textContent = `${text} (${code})`;
  errorNotice.hidden = false;
}

function hideError() {
  errorNotice.hidden = true;
  errorNotice.textContent = "";
}

function updateControls() {
  const ready = phase === "ready";
  const connected = phase === "connected";
  const sending = phase === "sending";
  const hasModels = modelsById.size > 0;
  const promptLength = promptInput.value.length;
  const promptTooLong = promptLength > MAX_PROMPT_LENGTH;
  pat.disabled = !ready;
  remember.disabled = !ready;
  connectButton.disabled = !ready || pat.value.trim() === "";
  disconnectButton.hidden = !(phase === "connecting" || connected || sending);
  savedTokenControls.hidden = !savedToken;
  connectSavedButton.disabled = !ready;
  forgetButton.disabled = forgetPending;
  newChatButton.disabled = !connected || !transcript.hasTurns();
  model.disabled = !connected || !hasModels;
  promptInput.disabled = !(connected || sending) || !hasModels;
  promptLimit.textContent = promptTooLong ? promptTooLongText(promptLength) : "";
  promptLimit.hidden = !promptTooLong;
  sendButton.disabled = !connected || !modelsById.has(model.value) || promptInput.value.trim() === "" || promptTooLong;
  stopButton.disabled = !sending || stopRequested;
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

promptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const chosenModel = modelsById.get(model.value);
  if (sendButton.disabled || chosenModel === undefined) return;
  const prompt = promptInput.value;
  hideError();
  if (bridge?.send({ type: "send", model: chosenModel.id, prompt })) {
    phase = "sending";
    stopRequested = false;
    promptInput.value = "";
    activeTurn = transcript.startTurn(prompt, replyAuthorLabel(chosenModel.name));
    status.textContent = STATUS_TEXT.sending;
  }
  updateControls();
  promptInput.focus();
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
  event.preventDefault();
  promptForm.requestSubmit();
});

stopButton.addEventListener("click", () => {
  if (stopButton.disabled) return;
  if (bridge?.send({ type: "stop" })) {
    stopRequested = true;
    status.textContent = STATUS_TEXT.stopping;
  }
  updateControls();
});

newChatButton.addEventListener("click", () => {
  if (newChatButton.disabled) return;
  hideError();
  if (bridge?.send({ type: "new_chat" })) {
    transcript.clear();
    status.textContent = STATUS_TEXT.newChat;
  }
  updateControls();
  promptInput.focus();
});

checkAgainButton.addEventListener("click", () => {
  hideError();
  autoConnect = true;
  startCompanion();
});

pat.addEventListener("input", updateControls);
promptInput.addEventListener("input", updateControls);
window.addEventListener("pagehide", resetPanel);
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--status-bar-height", `${statusBar.offsetHeight}px`);
}).observe(statusBar);

resetPanel();
startCompanion();
