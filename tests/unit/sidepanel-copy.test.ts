import { describe, expect, it } from "vitest";
import { HOST_NAME } from "../../src/protocol/identity.ts";
import {
  BRIDGE_FAILURE_TEXT,
  CONNECT_ERROR_TEXT,
  connectedStatus,
  CREDENTIAL_ERROR_TEXT,
  modelOptionLabel,
  promptTooLongText,
  readyStatus,
  SAVED_TOKEN_REJECTED_TEXT,
  SEND_ERROR_TEXT,
  usageReport,
} from "../../src/sidepanel/copy.ts";

describe("side panel copy", () => {
  it("labels models with the billing multiplier the SDK reports", () => {
    expect(modelOptionLabel({ id: "gpt-5", name: "GPT-5", multiplier: 0.33 })).toBe("GPT-5 (billing multiplier 0.33×)");
    expect(modelOptionLabel({ id: "gpt-4.1", name: "GPT-4.1", multiplier: 0 })).toBe("GPT-4.1 (billing multiplier 0×)");
  });

  it("says when a model's multiplier was not reported", () => {
    expect(modelOptionLabel({ id: "mystery", name: "Mystery" })).toBe("Mystery (billing multiplier not reported)");
  });

  it("names the SDK version once the companion is ready", () => {
    expect(readyStatus("1.0.14")).toBe("Companion ready (Copilot SDK 1.0.14). Not connected to GitHub.");
  });

  it("names the connected account and counts its enabled models", () => {
    expect(connectedStatus("octocat", 3)).toBe("Connected as octocat. 3 enabled models available.");
    expect(connectedStatus("octocat", 1)).toBe("Connected as octocat. 1 enabled model available.");
    expect(connectedStatus(undefined, 2)).toBe("Connected. 2 enabled models available.");
  });

  it("says explicitly when no enabled models were returned", () => {
    expect(connectedStatus("octocat", 0)).toBe(
      "Connected as octocat, but GitHub returned no enabled models, so there is nothing to send.",
    );
    expect(connectedStatus(undefined, 0)).toBe(
      "Connected, but GitHub returned no enabled models, so there is nothing to send.",
    );
  });

  it("reports the billing multiplier from SDK usage only when it was reported", () => {
    expect(usageReport("gpt-5", 1)).toBe("SDK usage report: gpt-5, billing multiplier 1×.");
    expect(usageReport("gpt-5", undefined)).toBe("SDK usage report: gpt-5, billing multiplier not reported.");
  });

  it("states the companion limits a request can hit", () => {
    expect(SEND_ERROR_TEXT.output_limit).toContain("65,536 characters");
    expect(SEND_ERROR_TEXT.timeout).toContain("5 minutes");
    expect(CONNECT_ERROR_TEXT.timeout).toContain("60 seconds");
  });

  it("explains a prompt that is too long to send", () => {
    expect(promptTooLongText(40_000)).toBe("This prompt is 40,000 characters. Shorten it to 32,768 or fewer to send.");
  });

  it("tells the user how to start over when the conversation outgrows the model's context window", () => {
    expect(SEND_ERROR_TEXT.context_limit).toContain("context window");
    expect(SEND_ERROR_TEXT.context_limit).toContain("New chat");
  });

  it("tells the user how to install a missing companion", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_not_installed).toContain("pnpm companion:install");
  });

  it("tells the user to rebuild and reload the extension when the companion speaks another protocol", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_protocol).toContain("pnpm build");
    expect(BRIDGE_FAILURE_TEXT.companion_protocol).toContain("chrome://extensions");
  });

  it("points to Disconnect before connecting with a different PAT", () => {
    expect(CONNECT_ERROR_TEXT.already_connected).toContain("Disconnect");
  });

  it("offers to replace or forget a saved PAT that GitHub rejects", () => {
    expect(SAVED_TOKEN_REJECTED_TEXT).toContain("saved PAT");
    expect(SAVED_TOKEN_REJECTED_TEXT).toContain("Remember");
    expect(SAVED_TOKEN_REJECTED_TEXT).toContain("Forget saved PAT");
  });

  it("asks for a pasted PAT when the saved one is gone or unreadable", () => {
    expect(CONNECT_ERROR_TEXT.no_saved_token).toMatch(/paste a PAT/i);
    expect(CONNECT_ERROR_TEXT.keychain_read_failed).toMatch(/paste a PAT/i);
  });

  it("says the PAT is still in use but must be pasted again when saving fails", () => {
    expect(CREDENTIAL_ERROR_TEXT.save_failed).toContain("still connected");
    expect(CREDENTIAL_ERROR_TEXT.save_failed).toContain("next time");
  });

  it("names the Keychain Access item to delete when forgetting fails", () => {
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain("Keychain Access");
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain(HOST_NAME);
  });
});
