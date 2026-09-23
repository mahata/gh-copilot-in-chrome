import { endianness } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createFrameDecoder, encodeFrame, MAX_INBOUND_FRAME_BYTES } from "../../src/companion/framing.ts";
import type { CopilotGateway, Turn, TurnRequest } from "../../src/companion/gateway.ts";
import { runCompanion } from "../../src/companion/run.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";
import { FIXED_TEST_PROMPT } from "../../src/protocol/messages.ts";

const token = `github_pat_${"R".repeat(82)}`;

function lengthPrefix(length: number) {
  const prefix = Buffer.alloc(4);
  if (endianness() === "LE") prefix.writeUInt32LE(length);
  else prefix.writeUInt32BE(length);
  return prefix;
}

function rawFrame(payload: string) {
  const bytes = Buffer.from(payload, "utf8");
  return Buffer.concat([lengthPrefix(bytes.length), bytes]);
}

function fakeGateway(overrides: Partial<CopilotGateway> = {}) {
  return {
    connect: vi.fn(async (_token: string) => ({
      login: "octocat",
      models: [{ id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 }],
    })),
    startTurn: vi.fn(({ onEvent }: TurnRequest): Turn => {
      let abortRequested = false;
      queueMicrotask(() => onEvent({ type: "delta", text: "Connection confirmed." }));
      return {
        outcome: new Promise((resolve) => setTimeout(() => resolve(abortRequested ? "stopped" : "complete"), 0)),
        abort: vi.fn(async () => {
          abortRequested = true;
        }),
      };
    }),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function startCompanion({ args = [EXTENSION_ORIGIN], gateway = fakeGateway() }: { args?: string[]; gateway?: CopilotGateway } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const frames: unknown[] = [];
  const outputChunks: Buffer[] = [];
  const decoder = createFrameDecoder((frame) => frames.push(frame));
  stdout.on("data", (chunk: Buffer) => {
    outputChunks.push(chunk);
    decoder.push(chunk);
  });
  let errorText = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => (errorText += chunk));
  const createGateway = vi.fn(() => gateway);
  const companion = runCompanion({ stdin, stdout, stderr, args, createGateway, sdkVersion: "1.0.14" });
  return {
    stdin,
    stdout,
    frames,
    createGateway,
    companion,
    output: () => Buffer.concat(outputChunks),
    errorText: () => errorText,
  };
}

const hello = { type: "hello", protocolVersion: 1, sdkVersion: "1.0.14" };
const connected = { type: "connected", login: "octocat", models: [{ id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 }] };

describe("runCompanion", () => {
  it.each([
    ["no caller origin", []],
    ["another extension's origin", ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]],
    ["a manual invocation", ["--help"]],
  ])("refuses to run for %s without writing protocol output", async (_description, args) => {
    const { companion, output, errorText, createGateway } = startCompanion({ args });
    await expect(companion.done).resolves.toBe(1);
    expect(output()).toHaveLength(0);
    expect(errorText()).toMatch(/only runs when Chrome starts it/);
    expect(createGateway).not.toHaveBeenCalled();
  });

  it("greets the panel with the protocol and SDK versions without starting the SDK", async () => {
    const { frames, createGateway, stdin, companion } = startCompanion();
    await vi.waitFor(() => expect(frames).toEqual([hello]));
    stdin.end();
    await expect(companion.done).resolves.toBe(0);
    expect(createGateway).not.toHaveBeenCalled();
  });

  it("connects through a frame split across chunks", async () => {
    const gateway = fakeGateway();
    const { frames, stdin, companion } = startCompanion({ gateway });
    const connectFrame = encodeFrame({ type: "connect", token });
    stdin.write(connectFrame.subarray(0, 3));
    stdin.write(connectFrame.subarray(3));

    await vi.waitFor(() => expect(frames).toEqual([hello, connected]));
    expect(gateway.connect).toHaveBeenCalledWith(token);
    stdin.end();
    await companion.done;
  });

  it("handles frames batched in one chunk in order", async () => {
    const gateway = fakeGateway();
    const { frames, stdin, companion } = startCompanion({ gateway });
    stdin.write(encodeFrame({ type: "connect", token }));
    await vi.waitFor(() => expect(frames).toEqual([hello, connected]));

    stdin.write(Buffer.concat([encodeFrame({ type: "send", model: "gpt-5-mini" }), encodeFrame({ type: "stop" })]));
    await vi.waitFor(() =>
      expect(frames).toEqual([hello, connected, { type: "delta", text: "Connection confirmed." }, { type: "done", outcome: "stopped" }]),
    );
    expect(gateway.startTurn).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5-mini", prompt: FIXED_TEST_PROMPT }));
    stdin.end();
    await companion.done;
  });

  it.each([
    ["a payload that is not JSON", rawFrame("{not json"), "invalid_message"],
    ["a payload that is not UTF-8", Buffer.concat([lengthPrefix(2), Buffer.from([0xc3, 0x28])]), "invalid_message"],
    ["an unknown message", rawFrame(JSON.stringify({ type: "shell", command: "id" })), "invalid_message"],
    ["a classic token", rawFrame(JSON.stringify({ type: "connect", token: "ghp_classicToken" })), "invalid_message"],
    ["an extra field", rawFrame(JSON.stringify({ type: "stop", reason: "now" })), "invalid_message"],
    ["an oversized length prefix", lengthPrefix(MAX_INBOUND_FRAME_BYTES + 1), "frame_too_large"],
  ])("reports %s as a fatal protocol error and ignores the frames after it", async (_description, badInput, code) => {
    const { frames, stdin, createGateway, companion } = startCompanion();
    stdin.write(Buffer.concat([badInput, encodeFrame({ type: "connect", token })]));

    await expect(companion.done).resolves.toBe(1);
    expect(frames).toEqual([hello, { type: "error", stage: "protocol", code }]);
    expect(createGateway).not.toHaveBeenCalled();
    expect(stdin.destroyed).toBe(true);
  });

  it("closes a connected runtime after a protocol error", async () => {
    const gateway = fakeGateway();
    const { frames, stdin, companion } = startCompanion({ gateway });
    stdin.write(encodeFrame({ type: "connect", token }));
    await vi.waitFor(() => expect(frames).toEqual([hello, connected]));
    stdin.write(rawFrame("[]"));

    await expect(companion.done).resolves.toBe(1);
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("closes the runtime once when the panel disconnects", async () => {
    const gateway = fakeGateway();
    const { frames, stdin, companion } = startCompanion({ gateway });
    stdin.write(encodeFrame({ type: "connect", token }));
    await vi.waitFor(() => expect(frames).toEqual([hello, connected]));
    stdin.end();

    await expect(companion.done).resolves.toBe(0);
    await expect(companion.shutdown()).resolves.toBe(0);
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("stops reading and closes the runtime when asked to shut down", async () => {
    const gateway = fakeGateway();
    const { frames, stdin, companion } = startCompanion({ gateway });
    stdin.write(encodeFrame({ type: "connect", token }));
    await vi.waitFor(() => expect(frames).toEqual([hello, connected]));

    await expect(companion.shutdown()).resolves.toBe(0);
    await expect(companion.done).resolves.toBe(0);
    expect(stdin.destroyed).toBe(true);
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["its output pipe breaks", (streams: { stdout: PassThrough }) => streams.stdout.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))],
    ["its input pipe breaks", (streams: { stdin: PassThrough }) => streams.stdin.destroy(new Error("read ECONNRESET"))],
  ])("closes the runtime when %s", async (_description, breakPipe) => {
    const gateway = fakeGateway();
    const started = startCompanion({ gateway });
    started.stdin.write(encodeFrame({ type: "connect", token }));
    await vi.waitFor(() => expect(started.frames).toEqual([hello, connected]));
    breakPipe(started);

    await expect(started.companion.done).resolves.toBe(1);
    expect(gateway.close).toHaveBeenCalledOnce();
  });

  it("never writes the token to its output streams", async () => {
    const gateway = fakeGateway({ connect: vi.fn(async () => Promise.reject(new Error(`Bad credentials for ${token}`))) });
    const { frames, stdin, companion, output, errorText } = startCompanion({ gateway });
    stdin.write(encodeFrame({ type: "connect", token }));
    await vi.waitFor(() => expect(frames).toEqual([hello, { type: "error", stage: "connect", code: "sdk_start_failed" }]));
    stdin.end();
    await companion.done;

    expect(output().toString("utf8")).not.toContain(token);
    expect(errorText()).not.toContain(token);
  });
});
