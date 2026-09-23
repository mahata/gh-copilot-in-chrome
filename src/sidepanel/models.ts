import type { ModelSummary } from "../protocol/messages.ts";

type PricedModel = ModelSummary & { multiplier: number };

export function pickDefaultModel(models: readonly ModelSummary[]): ModelSummary | undefined {
  let cheapest: PricedModel | undefined;
  for (const model of models) {
    if (!isPriced(model)) continue;
    if (cheapest === undefined || model.multiplier < cheapest.multiplier) cheapest = model;
  }
  return cheapest ?? models[0];
}

function isPriced(model: ModelSummary): model is PricedModel {
  return model.multiplier !== undefined;
}
