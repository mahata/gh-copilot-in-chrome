import { CopilotProbe, PROBE_PROMPT } from "../copilot/client";
import type { Model } from "../copilot/client";
import { createDemoProbe, DEMO_PAT } from "../copilot/demo";
import { safeError } from "../copilot/errors";
import "./style.css";

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing interface element: ${id}`);
  return found;
}

const pat = element("pat", HTMLInputElement);
const authConsent = element("auth-consent", HTMLInputElement);
const inferenceConsent = element("inference-consent", HTMLInputElement);
const model = element("model", HTMLSelectElement);
const connectButton = element("connect", HTMLButtonElement);
const sendButton = element("send", HTMLButtonElement);
const demoButton = element("demo", HTMLButtonElement);
const stopButton = element("stop", HTMLButtonElement);
const output = element("output", HTMLPreElement);
const status = element("status", HTMLParagraphElement);
const errorNotice = element("error", HTMLParagraphElement);
const client = new CopilotProbe();
let models: Model[] = [];
let busy = false;
let generation = 0;
let controller: AbortController | undefined;

element("prompt", HTMLPreElement).textContent = PROBE_PROMPT;

function updateControls() {
  pat.disabled = busy;
  authConsent.disabled = busy;
  connectButton.disabled = busy || !authConsent.checked || !pat.value;
  model.disabled = busy || models.length === 0;
  inferenceConsent.disabled = busy || !model.value;
  sendButton.disabled = busy || !model.value || !inferenceConsent.checked;
  demoButton.disabled = busy;
  stopButton.disabled = !busy;
}

function setModels(next: Model[]) {
  models = next;
  const placeholder = new Option(models.length ? "Choose a model" : "Check your PAT first", "");
  model.replaceChildren(placeholder, ...models.map((value) => new Option(value.name, value.id)));
  inferenceConsent.checked = false;
  updateControls();
}

function clear() {
  generation++;
  controller?.abort();
  client.clear();
  controller = undefined;
  busy = false;
  pat.value = "";
  authConsent.checked = false;
  inferenceConsent.checked = false;
  setModels([]);
  output.textContent = "No response yet.";
  errorNotice.textContent = "";
  errorNotice.hidden = true;
  status.textContent = "Cleared. Credentials and output were removed from this panel.";
  updateControls();
}

async function run(label: string, task: (signal: AbortSignal) => Promise<string>) {
  if (busy) return;
  const current = ++generation;
  const operation = new AbortController();
  controller = operation;
  busy = true;
  status.textContent = label;
  errorNotice.hidden = true;
  errorNotice.textContent = "";
  output.textContent = "";
  updateControls();
  status.scrollIntoView({ block: "nearest" });
  try {
    const message = await task(operation.signal);
    operation.signal.throwIfAborted();
    if (current === generation) status.textContent = message;
  } catch (error) {
    if (current === generation) {
      const failure = safeError(error, operation.signal);
      status.textContent = failure.code === "cancelled" ? "Stopped. Output may be incomplete." : "Experiment stopped.";
      errorNotice.textContent = `${failure.message} (${failure.code})`;
      errorNotice.hidden = false;
    }
  } finally {
    if (current === generation) {
      busy = false;
      controller = undefined;
      updateControls();
    }
  }
}

element("auth-form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  if (connectButton.disabled) return;
  const token = pat.value;
  pat.value = "";
  authConsent.checked = false;
  setModels([]);
  void run("Live: exchanging the PAT and discovering models...", async (signal) => {
    const available = await client.connect(token, signal);
    signal.throwIfAborted();
    setModels(available);
    return "Discovery succeeded. Inference and billing are still unverified.";
  });
});

sendButton.addEventListener("click", () => {
  if (sendButton.disabled) return;
  const modelId = model.value;
  inferenceConsent.checked = false;
  void run("Live: waiting for the test response...", async (signal) => {
    for await (const text of client.stream(modelId, signal)) {
      signal.throwIfAborted();
      output.textContent += text;
    }
    return "Live response complete. Verify account usage separately; public API support remains unverified.";
  });
});

demoButton.addEventListener("click", () => {
  if (busy) return;
  clear();
  void run("Offline: streaming synthetic data...", async (signal) => {
    const demo = createDemoProbe();
    try {
      await demo.connect(DEMO_PAT, signal);
      for await (const text of demo.stream("synthetic-demo", signal)) {
        signal.throwIfAborted();
        output.textContent += text;
      }
      return "Offline demo complete. No GitHub request was made; live compatibility is unverified.";
    } finally {
      demo.clear();
    }
  });
});

stopButton.addEventListener("click", () => controller?.abort());
element("clear", HTMLButtonElement).addEventListener("click", clear);
pat.addEventListener("input", updateControls);
authConsent.addEventListener("change", updateControls);
inferenceConsent.addEventListener("change", updateControls);
model.addEventListener("change", () => {
  inferenceConsent.checked = false;
  updateControls();
});
window.addEventListener("pagehide", clear);
updateControls();
