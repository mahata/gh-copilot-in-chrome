import { describe, expect, it } from "vitest";
import { HOST_NAME } from "../../src/protocol/identity.ts";
import {
  BRIDGE_FAILURE_TEXT,
  CONNECT_ERROR_TEXT,
  CREDENTIAL_ERROR_TEXT,
  modelOptionLabel,
  promptTooLongText,
  SAVED_TOKEN_REJECTED_TEXT,
  SEND_ERROR_TEXT,
} from "../../src/sidepanel/copy.ts";

describe("side panel copy", () => {
  it("labels models with the billing multiplier the SDK reports", () => {
    expect(modelOptionLabel({ id: "gpt-5", name: "GPT-5", multiplier: 0.33 })).toBe("GPT-5 (0.33×)");
    expect(modelOptionLabel({ id: "gpt-4.1", name: "GPT-4.1", multiplier: 0 })).toBe("GPT-4.1 (0×)");
  });

  it("says when a model's multiplier was not reported", () => {
    expect(modelOptionLabel({ id: "mystery", name: "Mystery" })).toBe("Mystery (multiplier not reported)");
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

  it("tells the user how to install a missing companion and retry", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_not_installed).toContain("npm run companion:install");
    expect(BRIDGE_FAILURE_TEXT.companion_not_installed).toContain("Try again");
  });

  it("tells the user to rebuild and reload the extension when the companion speaks another protocol", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_protocol).toContain("npm run build");
    expect(BRIDGE_FAILURE_TEXT.companion_protocol).toContain("chrome://extensions");
  });

  it("points to Sign out before connecting with a different PAT", () => {
    expect(CONNECT_ERROR_TEXT.already_connected).toContain("Sign out");
  });

  it("asks for a new PAT when GitHub rejects the saved one", () => {
    expect(SAVED_TOKEN_REJECTED_TEXT).toContain("saved PAT");
    expect(SAVED_TOKEN_REJECTED_TEXT).toMatch(/paste a new PAT/i);
  });

  it("asks for a pasted PAT when the saved one is gone or unreadable", () => {
    expect(CONNECT_ERROR_TEXT.no_saved_token).toMatch(/paste a PAT/i);
    expect(CONNECT_ERROR_TEXT.keychain_read_failed).toContain("Try again");
    expect(CONNECT_ERROR_TEXT.keychain_read_failed).toContain("Sign out");
  });

  it("says the PAT is still in use but must be pasted again when saving fails", () => {
    expect(CREDENTIAL_ERROR_TEXT.save_failed).toContain("still connected");
    expect(CREDENTIAL_ERROR_TEXT.save_failed).toContain("next time");
  });

  it("names the Keychain Access item to delete when signing out cannot remove the PAT", () => {
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain("Keychain Access");
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain(HOST_NAME);
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain("Sign out");
  });
});
