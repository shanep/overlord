import { describe, expect, it } from 'vitest';

import { DEFAULT_ASSUMPTIONS, emptyClimate, estimateClimate } from './climate.js';
import type { ModelTokens } from './climate.js';

const MILLION = 1_000_000;

function tokens(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): ModelTokens {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

describe('emptyClimate', () => {
  it('is all zeros with the default assumptions', () => {
    expect(emptyClimate()).toStrictEqual({
      energyKwh: 0,
      co2eKg: 0,
      waterLiters: 0,
      drivingMiles: 0,
      homeDays: 0,
      unpricedTokens: 0,
      models: [],
      assumptions: DEFAULT_ASSUMPTIONS,
    });
  });
});

describe('estimateClimate', () => {
  it('turns list price into energy, carbon, water and equivalents', () => {
    // $5 input + $25 output + $5 cache read + $6.25 cache write = $41.25, at 40 Wh per dollar.
    const estimate = estimateClimate({
      'claude-opus-4-7': tokens(MILLION, MILLION, 10 * MILLION, MILLION),
    });
    expect(estimate.energyKwh).toBeCloseTo(1.65, 10);
    expect(estimate.co2eKg).toBeCloseTo(0.66, 10);
    expect(estimate.waterLiters).toBeCloseTo(2.97, 10);
    expect(estimate.drivingMiles).toBeCloseTo(1.65, 10);
    expect(estimate.homeDays).toBeCloseTo(1.65 / 29, 10);
    expect(estimate.unpricedTokens).toBe(0);
    expect(estimate.models).toHaveLength(1);
    expect(estimate.models[0]).toMatchObject({ model: 'claude-opus-4-7', tokens: 13 * MILLION });
    expect(estimate.models[0]?.co2eKg).toBeCloseTo(0.66, 10);
  });

  it('counts tokens from unpriced models without guessing their energy', () => {
    const estimate = estimateClimate({
      'claude-opus-4-7': tokens(0, MILLION, 0, 0),
      'some-other-model': tokens(1, 2, 3, 4),
    });
    expect(estimate.unpricedTokens).toBe(10);
    expect(estimate.models.map((row) => row.model)).toStrictEqual(['claude-opus-4-7']);
    expect(estimate.energyKwh).toBeCloseTo(1, 10);
  });

  it('sorts models by energy, then by name', () => {
    const estimate = estimateClimate({
      'claude-haiku-4-5': tokens(0, MILLION, 0, 0),
      'claude-sonnet-4-6': tokens(0, MILLION, 0, 0),
      'claude-opus-4-7': tokens(0, MILLION, 0, 0),
      'claude-opus-4-6': tokens(0, MILLION, 0, 0),
    });
    expect(estimate.models.map((row) => row.model)).toStrictEqual([
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('uses the price table and assumptions it is given', () => {
    const assumptions = {
      whPerListDollar: 1000,
      kgCo2ePerKwh: 0.5,
      litersPerKwh: 2,
      kgCo2ePerMile: 0.25,
      kwhPerHomeDay: 10,
    };
    const prices = { model: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
    const estimate = estimateClimate(
      { model: tokens(MILLION, MILLION, MILLION, MILLION) },
      prices,
      assumptions,
    );
    expect(estimate).toStrictEqual({
      energyKwh: 10,
      co2eKg: 5,
      waterLiters: 20,
      drivingMiles: 20,
      homeDays: 1,
      unpricedTokens: 0,
      models: [{ model: 'model', tokens: 4 * MILLION, energyKwh: 10, co2eKg: 5 }],
      assumptions,
    });
  });

  it('is empty for no models', () => {
    expect(estimateClimate({})).toStrictEqual(emptyClimate());
  });
});
