import { describe, expect, it } from 'vitest';

import { directPayment, provableContribution, Transfer } from '../src/utils.js';

const PAYER = 'payer';
const RECIPIENT = 'recipient';
const ROUTER = 'router';
const OTHER = 'other';

const contribution = (deltas: [string, bigint][], payers: string[] = [PAYER]) =>
  provableContribution(new Map(deltas), new Set(payers), RECIPIENT);

describe('provableContribution', () => {
  it('credits a payment routed through an intermediary that nets to zero', () => {
    expect(contribution([[PAYER, -100n], [ROUTER, 0n], [RECIPIENT, 100n]])).toBe(100n);
  });

  it('refuses a third-party payout to the recipient paired with a payer outflow elsewhere', () => {
    expect(contribution([[OTHER, -100n], [RECIPIENT, 100n], [PAYER, -100n], ['payer-second-wallet', 100n]])).toBe(0n);
  });

  it('refuses a mint to the recipient paired with an unrelated payer outflow', () => {
    expect(contribution([['mint', -100n], [RECIPIENT, 100n], [PAYER, -100n], [ROUTER, 100n]])).toBe(0n);
  });

  it('refuses a round trip that leaves the payer whole', () => {
    expect(contribution([[PAYER, 0n], [ROUTER, 0n], [RECIPIENT, 0n]])).toBe(0n);
  });

  it('credits only what the other debits cannot have covered', () => {
    expect(contribution([[PAYER, -100n], [OTHER, -30n], [RECIPIENT, 100n], [ROUTER, 30n]])).toBe(70n);
  });

  it('caps the contribution at the payer debit', () => {
    expect(contribution([[PAYER, -60n], [RECIPIENT, 100n], ['mint', -40n]])).toBe(60n);
  });

  it('sums every account of the payer set', () => {
    expect(contribution([[PAYER, -40n], ['payer-wrapped', -60n], [RECIPIENT, 100n]], [PAYER, 'payer-wrapped'])).toBe(100n);
  });

  it('gives nothing when the recipient is not credited', () => {
    expect(contribution([[PAYER, -100n], [RECIPIENT, -5n], [OTHER, 105n]])).toBe(0n);
  });
});

describe('directPayment', () => {
  const paid = (transfers: Transfer[]) => directPayment(transfers, PAYER, RECIPIENT);

  it('counts a direct transfer', () => {
    expect(paid([[PAYER, RECIPIENT, 100n]])).toBe(100n);
  });

  it('sums several direct transfers', () => {
    expect(paid([[PAYER, RECIPIENT, 60n], [OTHER, ROUTER, 5n], [PAYER, RECIPIENT, 40n]])).toBe(100n);
  });

  it('gives nothing for a payment routed through an intermediary', () => {
    expect(paid([[PAYER, ROUTER, 100n], [ROUTER, RECIPIENT, 100n]])).toBe(0n);
  });

  it('gives nothing when a third party pays the recipient', () => {
    expect(paid([[OTHER, RECIPIENT, 100n], [PAYER, ROUTER, 100n]])).toBe(0n);
  });

  it('nets transfers back from the recipient to the payer', () => {
    expect(paid([[PAYER, RECIPIENT, 100n], [RECIPIENT, PAYER, 30n]])).toBe(70n);
  });

  it('never goes below zero', () => {
    expect(paid([[RECIPIENT, PAYER, 30n]])).toBe(0n);
  });
});
