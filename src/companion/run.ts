import type { Readable, Writable } from "node:stream";
import { createFrameDecoder, encodeFrame, FrameError } from "./framing.ts";
import type { CopilotGateway } from "./gateway.ts";
import { createCompanionService } from "./service.ts";
import { EXTENSION_ORIGIN } from "../protocol/identity.ts";
import { parsePanelMessage, PROTOCOL_VERSION } from "../protocol/messages.ts";
import type { CompanionMessage, ErrorCode } from "../protocol/messages.ts";

const CLEAN_EXIT = 0;
const FAILED_EXIT = 1;
const REFUSAL_NOTICE = "This companion only runs when Chrome starts it for the gh-copilot-in-chrome extension.\n";

export type RunCompanionOptions = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  args: readonly string[];
  createGateway: () => CopilotGateway;
  sdkVersion: string;
};

export type RunningCompanion = { done: Promise<number>; shutdown: () => Promise<number> };

export function runCompanion({ stdin, stdout, stderr, args, createGateway, sdkVersion }: RunCompanionOptions): RunningCompanion {
  if (args[0] !== EXTENSION_ORIGIN) {
    stderr.write(REFUSAL_NOTICE);
    const refused = Promise.resolve(FAILED_EXIT);
    return { done: refused, shutdown: () => refused };
  }

  let exiting = false;
  let reportExit: (exitCode: number) => void = () => {};
  const done = new Promise<number>((resolve) => (reportExit = resolve));

  function emit(message: CompanionMessage) {
    if (!exiting && stdout.writable) stdout.write(encodeFrame(message));
  }

  const service = createCompanionService({ createGateway, emit, onRuntimeStuck: () => exit(FAILED_EXIT) });
  const decoder = createFrameDecoder((frame) => {
    if (exiting) return;
    const message = parsePanelMessage(frame);
    if (message) service.handle(message);
    else failProtocol("invalid_message");
  });

  function receiveChunk(chunk: Buffer) {
    try {
      decoder.push(chunk);
    } catch (error) {
      failProtocol(error instanceof FrameError ? error.code : "invalid_message");
    }
  }

  function failProtocol(code: ErrorCode<"protocol">) {
    if (exiting) return;
    emit({ type: "error", stage: "protocol", code });
    exit(FAILED_EXIT);
  }

  function exit(exitCode: number) {
    if (exiting) return;
    exiting = true;
    stdin.off("data", receiveChunk);
    stdin.destroy();
    void service.shutdown().then(() => reportExit(exitCode));
  }

  stdout.on("error", () => exit(FAILED_EXIT));
  stdin.on("error", () => exit(FAILED_EXIT));
  stdin.on("end", () => exit(CLEAN_EXIT));
  stdin.on("data", receiveChunk);
  emit({ type: "hello", protocolVersion: PROTOCOL_VERSION, sdkVersion });

  return {
    done,
    shutdown() {
      exit(CLEAN_EXIT);
      return done;
    },
  };
}
