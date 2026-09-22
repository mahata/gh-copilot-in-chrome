import { describe, expect, it } from "vitest";
import { readCompletion } from "../../src/copilot/stream";
import { delta, done, event, streamResponse } from "../fixtures/copilot";

async function collect(response: Response, signal = new AbortController().signal) {
  let text = "";
  for await (const value of readCompletion(response, signal)) text += value;
  return text;
}

describe("bounded completion stream", () => {
  it("handles split UTF-8, CRLF, comments, role-only events, and a final stop", async () => {
    const text = ": heartbeat\n\n" +
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      delta("日本語 <script>alert(1)</script>") + done;
    await expect(collect(streamResponse(text.replaceAll("\n", "\r\n"), 1)))
      .resolves.toBe("日本語 <script>alert(1)</script>");
  });

  it("supports multiline SSE data", async () => {
    const multiline = 'data: {"choices":\ndata: [{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n';
    await expect(collect(streamResponse(multiline + done))).resolves.toBe("OK");
  });

  it.each([
    delta("partial"), delta("partial") + "data: [DONE]\n\n",
    delta("partial") + event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  ])("never reports an incomplete stream as success", async (text) => {
    await expect(collect(streamResponse(text))).rejects.toMatchObject({ code: "incomplete" });
  });

  it("rejects empty completions", async () => {
    await expect(collect(streamResponse(done))).rejects.toMatchObject({ code: "incomplete" });
  });

  it.each([
    "data: invalid-json\n\n",
    event({ error: { message: "REMOTE SECRET" } }),
    event({ choices: [{ index: 0, delta: { tool_calls: [{ id: "shell" }] }, finish_reason: null }] }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
    event({ choices: [{ index: 0, delta: { content: 123 }, finish_reason: null }] }),
  ])("rejects malformed or unsupported data without reflecting remote content", async (text) => {
    const error = await collect(streamResponse(text)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("REMOTE SECRET");
  });

  it("bounds an event before JSON parsing", async () => {
    await expect(collect(streamResponse(`data: ${"x".repeat(70_000)}\n\n`, 70_000)))
      .rejects.toMatchObject({ code: "size" });
  });

  it("bounds total output", async () => {
    await expect(collect(streamResponse(delta("x".repeat(32_000)).repeat(3) + done)))
      .rejects.toMatchObject({ code: "size" });
  });

  it("rejects non-SSE responses", async () => {
    await expect(collect(Response.json({ text: "not a stream" })))
      .rejects.toMatchObject({ code: "stream" });
  });

  it("cancels an open response rejected before reader acquisition", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    await expect(collect(response)).rejects.toMatchObject({ code: "stream" });
    expect(cancelled).toBe(true);
  });

  it("cancels a blocked stream reader promptly", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const controller = new AbortController();
    const result = collect(response, controller.signal);
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(Error);
    expect(cancelled).toBe(true);
  });
});
