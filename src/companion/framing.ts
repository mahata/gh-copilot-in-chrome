import { endianness } from "node:os";
import type { ErrorCode } from "../protocol/messages.ts";

export const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;
export const MAX_OUTBOUND_FRAME_BYTES = 1024 * 1024;

const LENGTH_PREFIX_BYTES = 4;
const isLittleEndian = endianness() === "LE";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export class FrameError extends Error {
  readonly code: ErrorCode<"protocol">;

  constructor(code: ErrorCode<"protocol">) {
    super(code);
    this.name = "FrameError";
    this.code = code;
  }
}

export function encodeFrame(message: unknown) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_OUTBOUND_FRAME_BYTES) throw new FrameError("frame_too_large");
  const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  if (isLittleEndian) prefix.writeUInt32LE(payload.length);
  else prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

export function createFrameDecoder(onFrame: (value: unknown) => void) {
  let pending = Buffer.alloc(0);

  return {
    push(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= LENGTH_PREFIX_BYTES) {
        const payloadLength = isLittleEndian ? pending.readUInt32LE(0) : pending.readUInt32BE(0);
        if (payloadLength > MAX_INBOUND_FRAME_BYTES) throw new FrameError("frame_too_large");
        const frameLength = LENGTH_PREFIX_BYTES + payloadLength;
        if (pending.length < frameLength) return;
        const payload = pending.subarray(LENGTH_PREFIX_BYTES, frameLength);
        pending = pending.subarray(frameLength);
        onFrame(parseJsonPayload(payload));
      }
    },
  };
}

function parseJsonPayload(payload: Buffer): unknown {
  try {
    return JSON.parse(strictUtf8.decode(payload));
  } catch {
    throw new FrameError("invalid_message");
  }
}
