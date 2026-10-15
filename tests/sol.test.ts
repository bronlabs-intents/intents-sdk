import { beforeEach, describe, expect, it, vi } from 'vitest';

import { proxyFetch } from '../src/proxy.js';
import { allowedSettlementMethods, SettlementMethod } from '../src/attestation.js';
import { SolNetwork } from '../src/networks/sol.js';

vi.mock('../src/proxy.js', () => ({ proxyFetch: vi.fn() }));

const MINT = 'So11111111111111111111111111111111111111112';
const FEE_PAYER = 'FeePayer1111111111111111111111111111111111';
const RECEIVER = 'Receiver111111111111111111111111111111111';
const SENDER = 'Sender11111111111111111111111111111111111';

const balance = (owner: string, amount: string) => ({ mint: MINT, owner, accountIndex: [FEE_PAYER, SENDER, RECEIVER].indexOf(owner), uiTokenAmount: { amount } });

function mockTransaction(meta: any, accountKeys: string[] = [FEE_PAYER, SENDER]): void {
  vi.mocked(proxyFetch).mockImplementation((_url: string, init?: any) => {
    const method = JSON.parse(init?.body ?? '{}').method;

    const result =
      method === 'getLatestBlockhash'
        ? { context: { slot: 1000 } }
        : { slot: 900, blockTime: 1700000000, meta: { err: null, ...meta }, transaction: { message: { accountKeys } } };

    return Promise.resolve({ json: () => Promise.resolve({ result }) }) as any;
  });
}

describe('SolNetwork.getTxData', () => {
  beforeEach(() => {
    vi.mocked(proxyFetch).mockReset();
  });

  it('reports an SPL mint with an empty token-level from and the fee payer as the envelope sender', async () => {
    mockTransaction({ preTokenBalances: [], postTokenBalances: [balance(RECEIVER, '1500000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx).toMatchObject({ from: '', to: RECEIVER, token: MINT, amount: 1500000n, envelopeFrom: FEE_PAYER, confirmed: true });
  });

  it('credits only the receiver delta when the mint tops up an existing balance', async () => {
    mockTransaction({ preTokenBalances: [balance(RECEIVER, '400')], postTokenBalances: [balance(RECEIVER, '1000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx).toMatchObject({ from: '', amount: 600n, envelopeFrom: FEE_PAYER });
  });

  it('does not treat a transfer whose source account was closed as a mint', async () => {
    mockTransaction({ preTokenBalances: [balance(SENDER, '1000')], postTokenBalances: [balance(RECEIVER, '1000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx).toMatchObject({ from: SENDER, to: RECEIVER, amount: 1000n });
    expect(tx?.envelopeFrom).toBeUndefined();
  });

  it('attributes a plain transfer to the expected payer', async () => {
    mockTransaction({
      preTokenBalances: [balance(SENDER, '1000'), balance(RECEIVER, '0')],
      postTokenBalances: [balance(SENDER, '400'), balance(RECEIVER, '600')],
    });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx).toMatchObject({ from: SENDER, to: RECEIVER, token: MINT, amount: 600n });
    expect(tx?.envelopeFrom).toBeUndefined();
  });

  it('refuses a transfer funded by someone other than the expected payer', async () => {
    mockTransaction(
      {
        preTokenBalances: [balance(SENDER, '1000'), balance(RECEIVER, '0')],
        postTokenBalances: [balance(SENDER, '400'), balance(RECEIVER, '600')],
      },
      [FEE_PAYER, SENDER],
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, FEE_PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
    expect(tx?.envelopeFrom).toBeUndefined();
  });

  it('returns nothing for a mint credited to another owner', async () => {
    mockTransaction({ preTokenBalances: [], postTokenBalances: [balance(SENDER, '1000')] });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx).toMatchObject({ from: '', to: '', token: '', amount: 0n });
  });

  it('reads a v1 transaction, which needs maxSupportedTransactionVersion 1', async () => {
    vi.mocked(proxyFetch).mockImplementation((_url: string, init?: any) => {
      const { method, params } = JSON.parse(init?.body ?? '{}');

      if (method === 'getLatestBlockhash') {
        return Promise.resolve({ json: () => Promise.resolve({ result: { context: { slot: 1000 } } }) }) as any;
      }

      const body =
        params[1].maxSupportedTransactionVersion >= 1
          ? {
              result: {
                slot: 900,
                blockTime: 1700000000,
                version: 1,
                meta: {
                  err: null,
                  preTokenBalances: [balance(SENDER, '1000'), balance(RECEIVER, '0')],
                  postTokenBalances: [balance(SENDER, '400'), balance(RECEIVER, '600')],
                },
                transaction: { message: { accountKeys: [FEE_PAYER, SENDER], header: { numRequiredSignatures: 2 } } },
              },
            }
          : { error: { code: -32015, message: 'Transaction version (1) is not supported by the requesting client.' } };

      return Promise.resolve({ json: () => Promise.resolve(body) }) as any;
    });

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER);

    expect(tx).toMatchObject({ from: SENDER, to: RECEIVER, token: MINT, amount: 600n, confirmed: true });
  });

  it('throws on a JSON-RPC error instead of reporting the transaction as not found yet', async () => {
    vi.mocked(proxyFetch).mockImplementation((_url: string, init?: any) => {
      const { method } = JSON.parse(init?.body ?? '{}');
      const body =
        method === 'getLatestBlockhash'
          ? { result: { context: { slot: 1000 } } }
          : { error: { code: -32015, message: 'Transaction version (2) is not supported by the requesting client.' } };

      return Promise.resolve({ json: () => Promise.resolve(body) }) as any;
    });

    await expect(new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER)).rejects.toThrow('-32015');
  });
});

describe('SolNetwork.getTxData routed native payments', () => {
  const OWNER = 'Owner111111111111111111111111111111111111';
  const WRAPPED = 'Wrapped11111111111111111111111111111111111';
  const OTHER = 'Other111111111111111111111111111111111111';
  const SINK = 'Sink1111111111111111111111111111111111111';
  const AMOUNT = 2000000000;
  const FEE = 15000;

  const wrapped = (accountIndex: number, owner: string | undefined, amount: number) =>
    ({ accountIndex, mint: MINT, ...(owner ? { owner } : {}), uiTokenAmount: { amount: String(amount) } });

  function unwrapThroughFeePayer(owner: string | null = OWNER) {
    mockTransaction(
      {
        fee: FEE,
        preBalances: [1_000_000_000, 5_000_000, 0, 3_000_000_000],
        postBalances: [1_000_000_000 - FEE, 5_000_000, AMOUNT, 3_000_000_000 - AMOUNT],
        preTokenBalances: [wrapped(3, owner ?? undefined, 3_000_000_000)],
        postTokenBalances: [wrapped(3, owner ?? undefined, 3_000_000_000 - AMOUNT)],
      },
      [FEE_PAYER, OWNER, RECEIVER, WRAPPED],
    );
  }

  beforeEach(() => { vi.mocked(proxyFetch).mockReset(); });

  it('attributes a wrapped-SOL account unwrapped through the fee payer', async () => {
    unwrapThroughFeePayer();

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', '0x0', RECEIVER, undefined, WRAPPED);

    expect(tx).toMatchObject({ from: WRAPPED, to: RECEIVER, amount: BigInt(AMOUNT) });
  });

  it('attributes the owner of the unwrapped wrapped-SOL account', async () => {
    unwrapThroughFeePayer();

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', '0x0', RECEIVER, undefined, OWNER);

    expect(tx).toMatchObject({ from: OWNER, amount: BigInt(AMOUNT) });
  });

  it('does not treat a wrapped-SOL account with no recorded owner as the payer', async () => {
    unwrapThroughFeePayer(null);

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', '0x0', RECEIVER, undefined, OWNER);

    expect(tx?.from).toBe('');
  });

  it('does not adopt a wrapped-SOL account whose owner changed within the transaction', async () => {
    mockTransaction(
      {
        fee: FEE,
        preBalances: [1_000_000_000, 5_000_000, 0, 3_000_000_000],
        postBalances: [1_000_000_000 - FEE, 5_000_000, AMOUNT, 3_000_000_000 - AMOUNT],
        preTokenBalances: [wrapped(3, OTHER, 3_000_000_000)],
        postTokenBalances: [wrapped(3, OWNER, 3_000_000_000 - AMOUNT)],
      },
      [FEE_PAYER, OWNER, RECEIVER, WRAPPED],
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', '0x0', RECEIVER, undefined, OWNER);

    expect(tx?.from).toBe('');
  });

  it('resolves accounts loaded from an address lookup table', async () => {
    mockTransaction(
      {
        fee: FEE,
        loadedAddresses: { writable: [RECEIVER, WRAPPED], readonly: [] },
        preBalances: [1_000_000_000, 5_000_000, 0, 3_000_000_000],
        postBalances: [1_000_000_000 - FEE, 5_000_000, AMOUNT, 3_000_000_000 - AMOUNT],
        preTokenBalances: [wrapped(3, OWNER, 3_000_000_000)],
        postTokenBalances: [wrapped(3, OWNER, 3_000_000_000 - AMOUNT)],
      },
      [FEE_PAYER, OWNER],
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', '0x0', RECEIVER, undefined, WRAPPED);

    expect(tx).toMatchObject({ from: WRAPPED, to: RECEIVER, amount: BigInt(AMOUNT) });
  });

  it('refuses a third party funding the recipient while the payer pays elsewhere', async () => {
    mockTransaction(
      {
        fee: FEE,
        preBalances: [1_000_000_000, 0, AMOUNT, AMOUNT, 0],
        postBalances: [1_000_000_000 - FEE, AMOUNT, 0, 0, AMOUNT],
      },
      [FEE_PAYER, RECEIVER, OTHER, WRAPPED, SINK],
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', '0x0', RECEIVER, undefined, WRAPPED);

    expect(tx?.from).toBe('');
  });
});

describe('SolNetwork.getTxData routed SPL payments', () => {
  const ROUTER = 'Router11111111111111111111111111111111111';
  const OTHER = 'Other111111111111111111111111111111111111';

  const indexed = (accountIndex: number, owner: string, amount: string) => ({ ...balance(owner, amount), accountIndex });

  beforeEach(() => { vi.mocked(proxyFetch).mockReset(); });

  it('attributes a payer whose delegate signed the transfer', async () => {
    mockTransaction(
      {
        preTokenBalances: [indexed(2, SENDER, '1000'), indexed(3, RECEIVER, '0')],
        postTokenBalances: [indexed(2, SENDER, '400'), indexed(3, RECEIVER, '600')],
      },
      [FEE_PAYER, 'Delegate1111111111111111111111111111111111', 'SenderAta111111111111111111111111111111111', 'ReceiverAta11111111111111111111111111111111'],
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx).toMatchObject({ from: SENDER, to: RECEIVER, amount: 600n });
  });

  it('nets a router account that is opened and closed within the transaction', async () => {
    mockTransaction(
      {
        preTokenBalances: [indexed(2, SENDER, '1000'), indexed(3, ROUTER, '0')],
        postTokenBalances: [indexed(2, SENDER, '400'), indexed(4, RECEIVER, '600')],
      },
      [FEE_PAYER, 'Delegate1111111111111111111111111111111111', 'SenderAta111111111111111111111111111111111', 'RouterAta11111111111111111111111111111111', 'ReceiverAta11111111111111111111111111111111'],
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx).toMatchObject({ from: SENDER, amount: 600n });
  });

  it('refuses a third party funding the recipient while the payer pays elsewhere', async () => {
    mockTransaction(
      {
        preTokenBalances: [indexed(2, OTHER, '600'), indexed(3, SENDER, '600'), indexed(4, RECEIVER, '0'), indexed(5, ROUTER, '0')],
        postTokenBalances: [indexed(2, OTHER, '0'), indexed(3, SENDER, '0'), indexed(4, RECEIVER, '600'), indexed(5, ROUTER, '600')],
      },
      [FEE_PAYER, 'Delegate1111111111111111111111111111111111', 'OtherAta111111111111111111111111111111111', 'SenderAta111111111111111111111111111111111', 'ReceiverAta11111111111111111111111111111111', 'RouterAta11111111111111111111111111111111'],
    );

    const tx = await new SolNetwork('http://rpc', 10).getTxData('sig', MINT, RECEIVER, undefined, SENDER);

    expect(tx?.from).toBe('');
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
