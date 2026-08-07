import { beforeEach, describe, expect, it, vi } from 'vitest';

import { proxyFetch } from '../src/proxy.js';
import { allowedSettlementMethods, SettlementMethod } from '../src/attestation.js';
import { SolNetwork } from '../src/networks/sol.js';

vi.mock('../src/proxy.js', () => ({ proxyFetch: vi.fn() }));

const MINT = 'So11111111111111111111111111111111111111112';
const FEE_PAYER = 'FeePayer1111111111111111111111111111111111';
const RECEIVER = 'Receiver111111111111111111111111111111111';
const SENDER = 'Sender11111111111111111111111111111111111';

const balance = (owner: string, amount: string) => ({ mint: MINT, owner, uiTokenAmount: { amount } });

function mockTransaction(meta: any, accountKeys: string[] = [FEE_PAYER, SENDER], numRequiredSignatures = 2): void {
  vi.mocked(proxyFetch).mockImplementation((_url: string, init?: any) => {
    const method = JSON.parse(init?.body ?? '{}').method;

    const result =
      method === 'getLatestBlockhash'
        ? { context: { slot: 1000 } }
        : { slot: 900, blockTime: 1700000000, meta: { err: null, ...meta }, transaction: { message: { accountKeys, header: { numRequiredSignatures } } } };

    return Promise.resolve({ json: () => Promise.resolve({ result }) }) as any;
  });
}

describe('SolNetwork.getTxData', () => {
  beforeEach(() => vi.mocked(proxyFetch).mockReset());

  it('reports an SPL mint with an empty token-level from and the fee payer as the envelope sender', async () => {
    mockTransaction({ preTokenBalances: [], postTokenBalances: [balance(RECEIVER, '1500000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER);

    expect(tx).toMatchObject({ from: '', to: RECEIVER, token: MINT, amount: 1500000n, envelopeFrom: FEE_PAYER, confirmed: true });
  });

  it('credits only the receiver delta when the mint tops up an existing balance', async () => {
    mockTransaction({ preTokenBalances: [balance(RECEIVER, '400')], postTokenBalances: [balance(RECEIVER, '1000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER);

    expect(tx).toMatchObject({ from: '', amount: 600n, envelopeFrom: FEE_PAYER });
  });

  it('does not treat a transfer whose source account was closed as a mint', async () => {
    mockTransaction({ preTokenBalances: [balance(SENDER, '1000')], postTokenBalances: [balance(RECEIVER, '1000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER);

    expect(tx).toMatchObject({ from: '', to: '', token: '', amount: 0n });
    expect(tx?.envelopeFrom).toBeUndefined();
  });

  it('keeps attributing a plain transfer to the signing sender', async () => {
    mockTransaction({
      preTokenBalances: [balance(SENDER, '1000'), balance(RECEIVER, '0')],
      postTokenBalances: [balance(SENDER, '400'), balance(RECEIVER, '600')],
    });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER);

    expect(tx).toMatchObject({ from: SENDER, to: RECEIVER, token: MINT, amount: 600n });
    expect(tx?.envelopeFrom).toBeUndefined();
  });

  it('refuses to promote a non-signing funder to the envelope sender', async () => {
    mockTransaction(
      {
        preTokenBalances: [balance(SENDER, '1000'), balance(RECEIVER, '0')],
        postTokenBalances: [balance(SENDER, '400'), balance(RECEIVER, '600')],
      },
      [FEE_PAYER, SENDER],
      1,
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER);

    expect(tx).toMatchObject({ from: '', amount: 600n });
    expect(tx?.envelopeFrom).toBeUndefined();
  });

  it('returns nothing for a mint credited to another owner', async () => {
    mockTransaction({ preTokenBalances: [], postTokenBalances: [balance(SENDER, '1000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER);

    expect(tx).toMatchObject({ from: '', to: '', token: '', amount: 0n });
  });
});

describe('allowedSettlementMethods', () => {
  it('allows mint settlements on Solana', () => {
    expect(allowedSettlementMethods('SOL')).toContain(SettlementMethod.MintPayerSignature);
    expect(allowedSettlementMethods('testSOL')).toContain(SettlementMethod.MintPayerSignature);
  });

  it('still refuses mint settlements on a network that hosts no mints', () => {
    expect(allowedSettlementMethods('testBTC')).not.toContain(SettlementMethod.MintPayerSignature);
  });
});
