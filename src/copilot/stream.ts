import { boundedBytes, isRecord, parseJson } from "./data";
import { ProbeError } from "./errors";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

async function* readEvents(response: Response, signal: AbortSignal) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let buffer = "";
  let lines: string[] = [];
  let eventBytes = 0;
  for await (const chunk of boundedBytes(response, signal, 1024 * 1024)) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      eventBytes += encoder.encode(line).length;
      if (eventBytes > MAX_EVENT_BYTES) throw new ProbeError("size", "A stream event exceeded the size limit.");
      if (line === "") {
        if (lines.length) yield lines.join("\n");
        lines = [];
        eventBytes = 0;
      } else if (line.startsWith("data:")) {
        lines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (encoder.encode(buffer).length + eventBytes > MAX_EVENT_BYTES) {
      throw new ProbeError("size", "A stream event exceeded the size limit.");
    }
  }
}

export async function* readCompletion(response: Response, signal: AbortSignal) {
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream") {
    await response.body?.cancel();
    throw new ProbeError("stream", "The endpoint did not return an event stream.");
  }
  let stopped = false;
  let outputBytes = 0;
  const encoder = new TextEncoder();
  for await (const event of readEvents(response, signal)) {
    signal.throwIfAborted();
    if (event === "[DONE]") {
      if (!stopped || outputBytes === 0) throw incomplete();
      return;
    }
    const value = parseJson(event);
    if (!isRecord(value) || "error" in value || !Array.isArray(value.choices)) {
      throw new ProbeError("stream", "The stream contains an unsupported response. Raw events are not logged.");
    }
    if (value.choices.length === 0 && isRecord(value.usage)) continue;
    if (value.choices.length !== 1 || stopped) throw new ProbeError("stream", "Unexpected completion sequence.");
    const choice: unknown = value.choices[0];
    if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta)) {
      throw new ProbeError("stream", "The completion event has an unsupported shape.");
    }
    if ("tool_calls" in choice.delta || "function_call" in choice.delta) {
      throw new ProbeError("tools", "Tool requests are not supported or executed by this experiment.");
    }
    const content = choice.delta.content;
    if (content !== undefined && content !== null) {
      if (typeof content !== "string") throw new ProbeError("stream", "Unsupported completion content.");
      outputBytes += encoder.encode(content).length;
      if (outputBytes > MAX_OUTPUT_BYTES) throw new ProbeError("size", "The generated output exceeded the size limit.");
      if (content) yield content;
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (choice.finish_reason !== "stop") {
        throw new ProbeError("finish", "The model did not finish normally. Output may be incomplete or filtered.");
      }
      stopped = true;
    }
  }
  throw incomplete();
}

function incomplete() {
  return new ProbeError("incomplete", "The response ended without a complete answer. Partial output is not a successful result.");
}
