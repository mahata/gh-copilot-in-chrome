import { describe, expect, it } from "vitest";
import { pickDefaultModel, pickModel, savedModelKey } from "../../src/sidepanel/models.ts";

const gpt5Mini = { id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 };
const gpt41 = { id: "gpt-4.1", name: "GPT-4.1", multiplier: 0 };
const gpt5 = { id: "gpt-5", name: "GPT-5", multiplier: 0.33 };
const sonnet = { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1 };
const mystery = { id: "mystery", name: "Mystery" };
const enigma = { id: "enigma", name: "Enigma" };

describe("default model", () => {
  it("prefers the model with the lowest reported billing multiplier", () => {
    expect(pickDefaultModel([sonnet, gpt5, gpt5Mini])).toBe(gpt5Mini);
  });

  it("keeps the first of several equally cheap models", () => {
    expect(pickDefaultModel([sonnet, gpt41, gpt5Mini])).toBe(gpt41);
  });

  it("prefers a model with a reported multiplier over one whose cost is unknown", () => {
    expect(pickDefaultModel([mystery, sonnet])).toBe(sonnet);
  });

  it("falls back to the first model when none reports a multiplier", () => {
    expect(pickDefaultModel([mystery, enigma])).toBe(mystery);
  });

  it("picks nothing from an empty list", () => {
    expect(pickDefaultModel([])).toBeUndefined();
  });
});

describe("remembered model", () => {
  it("restores an available saved model before using the default", () => {
    expect(pickModel([sonnet, gpt5Mini], sonnet.id)).toBe(sonnet);
  });

  it("falls back to the default when the saved model is unavailable", () => {
    expect(pickModel([sonnet, gpt5Mini], "retired-model")).toBe(gpt5Mini);
  });

  it("uses a distinct storage key for each login", () => {
    expect(savedModelKey("octocat")).toBe("model:octocat");
    expect(savedModelKey("hubot")).toBe("model:hubot");
  });
});
