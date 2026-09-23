import { describe, expect, it } from "vitest";
import {
  BRIDGE_FAILURE_TEXT,
  connectedStatus,
  modelOptionLabel,
  readyStatus,
  SEND_ERROR_TEXT,
  usageReport,
} from "../../src/sidepanel/copy.ts";

describe("side panel copy", () => {
  it("labels models with their premium request multiplier", () => {
    expect(modelOptionLabel({ id: "gpt-5", name: "GPT-5", multiplier: 0.33 })).toBe("GPT-5 (0.33× premium requests)");
    expect(modelOptionLabel({ id: "gpt-4.1", name: "GPT-4.1", multiplier: 0 })).toBe("GPT-4.1 (0× premium requests)");
  });

  it("says when a model's multiplier was not reported", () => {
    expect(modelOptionLabel({ id: "mystery", name: "Mystery" })).toBe("Mystery (premium request multiplier not reported)");
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
    expect(SEND_ERROR_TEXT.timeout).toContain("60 seconds");
  });

  it("tells the user how to install a missing companion", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_not_installed).toContain("npm run companion:install");
  });
});
