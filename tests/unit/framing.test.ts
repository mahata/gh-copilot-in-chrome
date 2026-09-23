import { endianness } from "node:os";
import { describe, expect, it } from "vitest";
import {
  FrameError,
  MAX_INBOUND_FRAME_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
  createFrameDecoder,
  encodeFrame,
} from "../../src/companion/framing.ts";

function nativeLengthPrefix(length: number) {
  const prefix = Buffer.alloc(4);
  if (endianness() === "LE") prefix.writeUInt32LE(length);
  else prefix.writeUInt32BE(length);
  return prefix;
}

function rawFrame(payload: Buffer) {
  return Buffer.concat([nativeLengthPrefix(payload.length), payload]);
}

function collectFrames() {
  const frames: unknown[] = [];
  const decoder = createFrameDecoder((value) => frames.push(value));
  return { frames, decoder };
}

function captureFrameError(action: () => void) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected a FrameError");
}

describe("encodeFrame", () => {
  it("prefixes UTF-8 JSON with its byte length in native byte order", () => {
    const frame = encodeFrame({ type: "delta", text: "確認" });
    const payload = Buffer.from(JSON.stringify({ type: "delta", text: "確認" }), "utf8");
    expect(frame).toEqual(rawFrame(payload));
    expect(payload.length).toBeGreaterThan(JSON.stringify({ type: "delta", text: "確認" }).length);
  });

  it("refuses frames larger than Chrome accepts from a host", () => {
    const error = captureFrameError(() => encodeFrame({ type: "delta", text: "x".repeat(MAX_OUTBOUND_FRAME_BYTES) }));
    expect(error).toBeInstanceOf(FrameError);
    expect((error as FrameError).code).toBe("frame_too_large");
  });
});

describe("createFrameDecoder", () => {
  it("decodes one complete frame", () => {
    const { frames, decoder } = collectFrames();
    decoder.push(encodeFrame({ type: "stop" }));
    expect(frames).toEqual([{ type: "stop" }]);
  });

  it("reassembles a frame split inside the length prefix and the payload", () => {
    const { frames, decoder } = collectFrames();
    const frame = encodeFrame({ type: "send", model: "gpt-5-mini" });
    decoder.push(frame.subarray(0, 2));
    decoder.push(frame.subarray(2, 9));
    expect(frames).toEqual([]);
    decoder.push(frame.subarray(9));
    expect(frames).toEqual([{ type: "send", model: "gpt-5-mini" }]);
  });

  it("decodes several frames delivered in one chunk, in order", () => {
    const { frames, decoder } = collectFrames();
    decoder.push(Buffer.concat([encodeFrame({ type: "stop" }), encodeFrame({ type: "send", model: "m" }), encodeFrame(1)]));
    expect(frames).toEqual([{ type: "stop" }, { type: "send", model: "m" }, 1]);
  });

  it("rejects an oversized frame from its length prefix alone", () => {
    const { frames, decoder } = collectFrames();
    const error = captureFrameError(() => decoder.push(nativeLengthPrefix(MAX_INBOUND_FRAME_BYTES + 1)));
    expect(error).toBeInstanceOf(FrameError);
    expect((error as FrameError).code).toBe("frame_too_large");
    expect(frames).toEqual([]);
  });

  it("accepts a frame exactly at the inbound limit", () => {
    const { frames, decoder } = collectFrames();
    const text = "x".repeat(MAX_INBOUND_FRAME_BYTES - 2);
    decoder.push(rawFrame(Buffer.from(JSON.stringify(text), "utf8")));
    expect(frames).toEqual([text]);
  });

  it.each([
    ["malformed JSON", Buffer.from("{type", "utf8")],
    ["an empty payload", Buffer.alloc(0)],
    ["invalid UTF-8", Buffer.from([0x22, 0xff, 0x22])],
  ])("rejects %s as an invalid message", (_description, payload) => {
    const { decoder } = collectFrames();
    const error = captureFrameError(() => decoder.push(rawFrame(payload)));
    expect(error).toBeInstanceOf(FrameError);
    expect((error as FrameError).code).toBe("invalid_message");
  });
});
