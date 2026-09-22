import { ProbeError } from "./errors";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProbeError("shape", "The service returned invalid JSON. Raw responses are not logged.");
  }
}

export async function* boundedBytes(response: Response, signal: AbortSignal, limit: number) {
  signal.throwIfAborted();
  if (!response.body) throw new ProbeError("shape", "The response has no body.");
  const reader = response.body.getReader();
  let total = 0;
  let finished = false;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (result.done) {
        finished = true;
        return;
      }
      total += result.value.byteLength;
      if (total > limit) throw new ProbeError("size", "The response exceeded the experiment's size limit.");
      yield result.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      if (!finished) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function readJson(response: Response, signal: AbortSignal) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for await (const chunk of boundedBytes(response, signal, 256 * 1024)) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return parseJson(text);
}
