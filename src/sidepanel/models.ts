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

export function pickModel(models: readonly ModelSummary[], preferredId?: string): ModelSummary | undefined {
  return models.find((model) => model.id === preferredId) ?? pickDefaultModel(models);
}

export function savedModelKey(login: string) {
  return `model:${login}`;
}

function isPriced(model: ModelSummary): model is PricedModel {
  return model.multiplier !== undefined;
}
