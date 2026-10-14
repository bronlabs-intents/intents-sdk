import { describe, expect, it } from 'vitest';

import { paymentFlow, provableContribution, Transfer } from '../src/utils.js';

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

describe('paymentFlow', () => {
  const flow = (transfers: Transfer[]) => paymentFlow(transfers, PAYER, RECIPIENT);

  it('counts a direct transfer', () => {
    expect(flow([[PAYER, RECIPIENT, 100n]])).toBe(100n);
  });

  it('follows a payment through intermediaries', () => {
    expect(flow([[PAYER, ROUTER, 100n], [ROUTER, OTHER, 100n], [OTHER, RECIPIENT, 100n]])).toBe(100n);
  });

  it('caps the flow at the narrowest hop', () => {
    expect(flow([[PAYER, ROUTER, 100n], [ROUTER, RECIPIENT, 40n]])).toBe(40n);
  });

  it('counts tokens the payer received in the same transaction', () => {
    expect(flow([[OTHER, PAYER, 100n], [PAYER, RECIPIENT, 100n]])).toBe(100n);
  });

  it('gives nothing when no transfer path leads from the payer to the recipient', () => {
    expect(flow([[OTHER, RECIPIENT, 100n], [PAYER, ROUTER, 100n]])).toBe(0n);
  });

  it('nets transfers between the same two accounts', () => {
    expect(flow([[PAYER, RECIPIENT, 100n], [RECIPIENT, PAYER, 30n]])).toBe(70n);
  });

  it('sums parallel paths', () => {
    expect(flow([[PAYER, ROUTER, 60n], [ROUTER, RECIPIENT, 60n], [PAYER, OTHER, 40n], [OTHER, RECIPIENT, 40n]])).toBe(100n);
  });

  it('gives nothing for a round trip through the recipient own funds', () => {
    expect(flow([[RECIPIENT, OTHER, 100n], [OTHER, PAYER, 100n], [PAYER, RECIPIENT, 100n]])).toBe(0n);
  });

  it('caps the flow at what the recipient keeps', () => {
    expect(flow([[PAYER, RECIPIENT, 100n], [RECIPIENT, OTHER, 30n]])).toBe(70n);
  });

  it('terminates on cycles', () => {
    expect(flow([[PAYER, ROUTER, 100n], [ROUTER, OTHER, 100n], [OTHER, ROUTER, 50n], [ROUTER, RECIPIENT, 50n]])).toBe(50n);
  });
});
