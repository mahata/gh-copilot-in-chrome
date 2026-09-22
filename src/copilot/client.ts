import { isRecord, readJson } from "./data";
import { httpError, ProbeError, safeError } from "./errors";
import { readCompletion } from "./stream";

export const PROBE_PROMPT = "Reply with exactly: Connection confirmed.";
const EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const API_ORIGINS = new Set([
  "https://api.githubcopilot.com",
  "https://api.business.githubcopilot.com",
  "https://api.enterprise.githubcopilot.com",
]);

export interface Model {
  id: string;
  name: string;
}

interface Credential {
  token: string;
  origin: string;
  refreshAt: number;
}

interface Operation {
  controller: AbortController;
  signal: AbortSignal;
}

function apiOrigin(value: unknown) {
  if (typeof value !== "string") throw new ProbeError("endpoint", "The response did not identify a supported API endpoint.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeError("endpoint", "The response contained an invalid API endpoint.");
  }
  if (!API_ORIGINS.has(url.origin) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new ProbeError("endpoint", "The returned endpoint is outside this experiment's explicit allowlist.");
  }
  return url.origin;
}

function modelsFrom(value: unknown): Model[] {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > 500) {
    throw new ProbeError("shape", "The model catalog has an unsupported shape.");
  }
  const models: Model[] = [];
  for (const entry of value.data) {
    if (!isRecord(entry) || !isRecord(entry.policy) || entry.policy.state !== "enabled" ||
        !isRecord(entry.capabilities) || entry.capabilities.type !== "chat" ||
        !Array.isArray(entry.supported_endpoints) ||
        !entry.supported_endpoints.includes("/chat/completions")) continue;
    if (typeof entry.id !== "string" || !/^[\w./:-]{1,200}$/.test(entry.id) ||
        typeof entry.name !== "string" || entry.name.length > 200) {
      throw new ProbeError("shape", "An eligible model has invalid metadata.");
    }
    if (!models.some((model) => model.id === entry.id)) models.push({ id: entry.id, name: entry.name });
  }
  if (!models.length) {
    throw new ProbeError("no_models", "No explicitly enabled Chat Completions model was found. Missing protocol or policy metadata is not assumed compatible.");
  }
  return models;
}

export class CopilotProbe {
  #pat: string | undefined;
  #credential: Credential | undefined;
  #models: Model[] = [];
  #active: Operation | undefined;

  constructor(
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly now: () => number = Date.now,
  ) {}

  clear() {
    this.#active?.controller.abort();
    this.#active = undefined;
    this.#pat = undefined;
    this.#credential = undefined;
    this.#models = [];
  }

  async connect(pat: string, signal?: AbortSignal): Promise<Model[]> {
    this.clear();
    if (!/^github_pat_[A-Za-z0-9_]{1,500}$/.test(pat)) {
      throw new ProbeError("invalid_pat", "Enter a fine-grained PAT beginning with github_pat_. Classic PATs and OAuth tokens are not part of this experiment.");
    }
    this.#pat = pat;
    const operation = this.#begin(signal);
    let stage = "Token exchange";
    try {
      const credential = await this.#exchange(operation.signal);
      stage = "Model discovery";
      const response = await this.#request(`${credential.origin}/models`, {
        headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json" },
      }, operation.signal);
      const models = modelsFrom(await readJson(response, operation.signal));
      operation.signal.throwIfAborted();
      this.#credential = credential;
      this.#models = models;
      return models.map((model) => ({ ...model }));
    } catch (error) {
      const failure = safeError(error, operation.signal);
      if (this.#active === operation) this.clear();
      throw new ProbeError(failure.code, `${stage}: ${failure.message}`);
    } finally {
      if (this.#active === operation) this.#active = undefined;
    }
  }

  async *stream(modelId: string, signal?: AbortSignal): AsyncGenerator<string> {
    if (!this.#credential || !this.#pat) throw new ProbeError("not_connected", "Check your PAT before running inference.");
    if (!this.#models.some((model) => model.id === modelId)) {
      throw new ProbeError("model", "Select an enabled, compatible model returned by discovery.");
    }
    const operation = this.#begin(signal);
    let stage = "Inference";
    try {
      if (this.now() >= this.#credential.refreshAt) {
        stage = "Token refresh";
        const credential = await this.#exchange(operation.signal);
        if (credential.origin !== this.#credential.origin) {
          throw new ProbeError("endpoint", "The API endpoint changed. Check the connection again before continuing.");
        }
        this.#credential = credential;
      }
      stage = "Inference";
      const credential = this.#credential;
      const response = await this.#request(`${credential.origin}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: modelId, stream: true,
          messages: [{ role: "user", content: PROBE_PROMPT }],
        }),
      }, operation.signal);
      yield* readCompletion(response, operation.signal);
    } catch (error) {
      const failure = safeError(error, operation.signal);
      throw new ProbeError(failure.code, `${stage}: ${failure.message}`);
    } finally {
      operation.controller.abort();
      if (this.#active === operation) this.#active = undefined;
    }
  }

  #begin(external?: AbortSignal): Operation {
    if (this.#active) throw new ProbeError("busy", "An operation is already running. Stop it before starting another.");
    const controller = new AbortController();
    const signals = [controller.signal, AbortSignal.timeout(60_000)];
    if (external) signals.push(external);
    const operation = { controller, signal: AbortSignal.any(signals) };
    this.#active = operation;
    return operation;
  }

  async #request(url: string, init: RequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await this.fetcher(url, {
      ...init, signal, redirect: "error", credentials: "omit", cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    return response;
  }

  async #exchange(signal: AbortSignal): Promise<Credential> {
    if (!this.#pat) throw new ProbeError("not_connected", "The credential has been cleared.");
    const response = await this.#request(EXCHANGE_URL, {
      headers: { Authorization: `token ${this.#pat}`, Accept: "application/json" },
    }, signal);
    const value = await readJson(response, signal);
    const now = this.now();
    if (!isRecord(value) || typeof value.token !== "string" ||
        !/^[\x21-\x7e]{1,16384}$/.test(value.token) ||
        typeof value.expires_at !== "number" || !Number.isFinite(value.expires_at) ||
        value.expires_at * 1000 <= now + 30_000 ||
        (value.refresh_in !== undefined &&
          (typeof value.refresh_in !== "number" || !Number.isFinite(value.refresh_in) || value.refresh_in <= 30))) {
      throw new ProbeError("credential", "The exchanged credential has invalid token or expiry metadata.");
    }
    const origin = apiOrigin(isRecord(value.endpoints) ? value.endpoints.api : undefined);
    const expiry = value.expires_at * 1000 - 30_000;
    const refreshAt = typeof value.refresh_in === "number"
      ? Math.min(expiry, now + value.refresh_in * 1000) : expiry;
    return { token: value.token, origin, refreshAt };
  }
}
