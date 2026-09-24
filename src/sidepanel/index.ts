import { openCompanionBridge } from "./companion.ts";
import type { BridgeEvent, CompanionBridge, SessionMessage } from "./companion.ts";
import {
  BRIDGE_FAILURE_TEXT,
  CONNECT_ERROR_TEXT,
  CREDENTIAL_ERROR_TEXT,
  failedTurnNote,
  INTERRUPTED_TURN_NOTE,
  MODEL_PLACEHOLDER_TEXT,
  modelOptionLabel,
  NO_MODELS_TEXT,
  NOT_FINE_GRAINED_PAT,
  promptTooLongText,
  replyAuthorLabel,
  SAVED_TOKEN_REJECTED_TEXT,
  SEND_ERROR_TEXT,
  STATUS_TEXT,
  STOPPED_TURN_NOTE,
} from "./copy.ts";
import { pickDefaultModel } from "./models.ts";
import { createTranscript } from "./transcript.ts";
import type { TranscriptTurn } from "./transcript.ts";
import { isFineGrainedPersonalAccessToken, MAX_PROMPT_LENGTH } from "../protocol/messages.ts";
import type { ErrorCode, ModelSummary } from "../protocol/messages.ts";
import "./style.css";

type PanelPhase = "detecting" | "unavailable" | "ready" | "connecting" | "connected" | "sending";
type PanelView = "none" | "setup" | "chat";
type SessionError = Extract<SessionMessage, { type: "error" }>;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing interface element: ${id}`);
  return found;
}

const chatActions = element("chat-actions", HTMLDivElement);
const newChatButton = element("new-chat", HTMLButtonElement);
const signOutButton = element("sign-out", HTMLButtonElement);
const status = element("status", HTMLParagraphElement);
const errorNotice = element("error", HTMLParagraphElement);
const tryAgainButton = element("try-again", HTMLButtonElement);
const authForm = element("auth-form", HTMLFormElement);
const pat = element("pat", HTMLInputElement);
const connectButton = element("connect", HTMLButtonElement);
const chat = element("chat", HTMLElement);
const transcript = createTranscript(element("transcript", HTMLDivElement));
const promptForm = element("prompt-form", HTMLFormElement);
const promptInput = element("prompt", HTMLTextAreaElement);
const promptLimit = element("prompt-limit", HTMLParagraphElement);
const model = element("model", HTMLSelectElement);
const sendButton = element("send", HTMLButtonElement);
const stopButton = element("stop", HTMLButtonElement);

let phase: PanelPhase = "detecting";
// The view outlives the companion, so a crash keeps the conversation on screen until Try again.
let view: PanelView = "none";
let bridge: CompanionBridge | undefined;
let connectingWithSavedToken = false;
let signOutPending = false;
let stopRequested = false;
let modelsById = new Map<string, ModelSummary>();
let activeTurn: TranscriptTurn | undefined;
let focusAfterUpdate: HTMLElement | undefined;

function startCompanion() {
  phase = "detecting";
  status.textContent = STATUS_TEXT.starting;
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

function restartCompanion() {
  bridge?.close();
  bridge = undefined;
  discardCompanionState();
  hideError();
  startCompanion();
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
  connectingWithSavedToken = false;
  signOutPending = false;
  stopRequested = false;
  activeTurn = undefined;
  showModelPlaceholder(MODEL_PLACEHOLDER_TEXT.disconnected);
}

function finishSignOut() {
  resetPanel();
  view = "setup";
  startCompanion();
}

function connectWithSavedToken() {
  if (bridge?.send({ type: "connect_saved" })) startConnecting({ withSavedToken: true });
}

function startConnecting({ withSavedToken }: { withSavedToken: boolean }) {
  phase = "connecting";
  connectingWithSavedToken = withSavedToken;
  status.textContent = STATUS_TEXT.connecting;
}

function handleBridgeEvent(event: BridgeEvent) {
  switch (event.type) {
    case "ready":
      phase = "ready";
      status.textContent = "";
      if (event.savedToken) {
        view = "chat";
        connectWithSavedToken();
      } else {
        view = "setup";
        focusAfterUpdate = pat;
      }
      break;
    case "message":
      handleSessionMessage(event.message);
      break;
    case "closed":
      bridge = undefined;
      phase = "unavailable";
      finishActiveTurn(INTERRUPTED_TURN_NOTE);
      discardCompanionState();
      status.textContent = "";
      showError(BRIDGE_FAILURE_TEXT[event.failure], event.failure);
      focusAfterUpdate = tryAgainButton;
      break;
  }
  updateControls();
  focusAfterUpdate?.focus();
  focusAfterUpdate = undefined;
}

function handleSessionMessage(message: SessionMessage) {
  switch (message.type) {
    case "connected":
      if (phase !== "connecting") return;
      phase = "connected";
      view = "chat";
      transcript.clear();
      if (message.models.length > 0) {
        showModels(message.models);
        status.textContent = "";
        focusAfterUpdate = promptInput;
      } else {
        showModelPlaceholder(MODEL_PLACEHOLDER_TEXT.none);
        status.textContent = NO_MODELS_TEXT;
        focusAfterUpdate = tryAgainButton;
      }
      return;
    case "credential":
      if (!message.saved && signOutPending) finishSignOut();
      return;
    case "delta":
      activeTurn?.appendReply(message.text);
      return;
    case "usage":
      return;
    case "done":
      if (phase !== "sending") return;
      phase = "connected";
      finishActiveTurn(message.outcome === "stopped" ? STOPPED_TURN_NOTE : undefined);
      return;
    case "error":
      return handleSessionError(message);
  }
}

function handleSessionError(message: SessionError) {
  switch (message.stage) {
    case "connect":
      return handleConnectError(message.code);
    case "send":
      if (phase === "sending") {
        phase = "connected";
        finishActiveTurn(failedTurnNote(message.code));
      }
      return showError(SEND_ERROR_TEXT[message.code], message.code);
    case "credential":
      if (message.code === "forget_failed") {
        signOutPending = false;
        // Sign out lost focus when it disabled itself; take focus back only if the user has not moved on.
        if (document.activeElement === document.body) focusAfterUpdate = signOutButton;
      }
      return showError(CREDENTIAL_ERROR_TEXT[message.code], message.code);
  }
}

function handleConnectError(code: ErrorCode<"connect">) {
  const savedTokenUnusable = connectingWithSavedToken && (code === "auth_failed" || code === "no_saved_token");
  if (phase === "connecting") {
    phase = "ready";
    status.textContent = "";
    // A saved PAT that failed for another reason is still saved, so the chat view stays and offers Try again.
    if (!connectingWithSavedToken || savedTokenUnusable) {
      view = "setup";
      focusAfterUpdate = pat;
    } else {
      focusAfterUpdate = tryAgainButton;
    }
  }
  const savedTokenRejected = connectingWithSavedToken && code === "auth_failed";
  showError(savedTokenRejected ? SAVED_TOKEN_REJECTED_TEXT : CONNECT_ERROR_TEXT[code], code);
}

function finishActiveTurn(note?: string) {
  activeTurn?.finish(note);
  activeTurn = undefined;
  if (document.activeElement === stopButton) focusAfterUpdate = promptInput;
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
  const companionReady = phase !== "detecting" && phase !== "unavailable";
  const ready = phase === "ready";
  const connected = phase === "connected";
  const sending = phase === "sending";
  const hasModels = modelsById.size > 0;
  const promptLength = promptInput.value.length;
  const promptTooLong = promptLength > MAX_PROMPT_LENGTH;
  authForm.hidden = view !== "setup";
  chatActions.hidden = view !== "chat";
  chat.hidden = view !== "chat";
  pat.disabled = !ready;
  connectButton.disabled = !ready || pat.value.trim() === "";
  newChatButton.hidden = !transcript.hasTurns();
  newChatButton.disabled = !connected;
  signOutButton.disabled = !companionReady || signOutPending;
  model.disabled = !connected || !hasModels;
  promptInput.disabled = !(connected || sending) || !hasModels;
  promptLimit.textContent = promptTooLong ? promptTooLongText(promptLength) : "";
  promptLimit.hidden = !promptTooLong;
  sendButton.hidden = sending;
  sendButton.disabled = !connected || !modelsById.has(model.value) || promptInput.value.trim() === "" || promptTooLong;
  stopButton.hidden = !sending;
  stopButton.disabled = !sending || stopRequested;
  tryAgainButton.hidden = !(phase === "unavailable" || (ready && view === "chat") || (connected && !hasModels));
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (connectButton.disabled) return;
  const token = pat.value.trim();
  pat.value = "";
  hideError();
  if (!isFineGrainedPersonalAccessToken(token)) {
    showError(NOT_FINE_GRAINED_PAT.text, NOT_FINE_GRAINED_PAT.code);
    pat.focus();
  } else if (bridge?.send({ type: "connect", token, remember: true })) {
    startConnecting({ withSavedToken: false });
  }
  updateControls();
});

signOutButton.addEventListener("click", () => {
  if (signOutButton.disabled) return;
  hideError();
  if (bridge?.send({ type: "forget" })) signOutPending = true;
  updateControls();
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
  if (bridge?.send({ type: "stop" })) stopRequested = true;
  updateControls();
  promptInput.focus();
});

newChatButton.addEventListener("click", () => {
  if (newChatButton.disabled) return;
  hideError();
  if (bridge?.send({ type: "new_chat" })) transcript.clear();
  updateControls();
  promptInput.focus();
});

tryAgainButton.addEventListener("click", () => {
  if (!tryAgainButton.hidden) restartCompanion();
});

pat.addEventListener("input", updateControls);
promptInput.addEventListener("input", updateControls);
window.addEventListener("pagehide", resetPanel);

resetPanel();
startCompanion();
