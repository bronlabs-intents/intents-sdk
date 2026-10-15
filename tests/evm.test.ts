import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import { proxyFetch } from '../src/proxy.js';
import { EvmNetwork } from '../src/networks/evm.js';

vi.mock('../src/proxy.js', () => ({ proxyFetch: vi.fn() }));

const RELAYER = '0x1000000000000000000000000000000000000001';
const WALLET = '0x2000000000000000000000000000000000000002';
const IMPLEMENTATION = '0x3000000000000000000000000000000000000003';
const RECIPIENT = '0x4000000000000000000000000000000000000004';
const OTHER = '0x5000000000000000000000000000000000000005';
const ROUTER = '0x6000000000000000000000000000000000000006';
const TOKEN = '0x7000000000000000000000000000000000000007';
const ZERO = '0x0000000000000000000000000000000000000000';

const AMOUNT = 50000000000000000n;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const hex = (value: bigint) => '0x' + value.toString(16);
const topic = (address: string) => ethers.zeroPadValue(address, 32);

const transferLog = (from: string, to: string, amount: bigint) => ({
  address: TOKEN,
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: ethers.toBeHex(amount, 32)
});

const walletPayout = (overrides: any = {}) => ({
  type: 'CALL',
  from: RELAYER,
  to: WALLET,
  value: '0x0',
  calls: [
    {
      type: 'DELEGATECALL',
      from: WALLET,
      to: IMPLEMENTATION,
      calls: [{ type: 'CALL', from: WALLET, to: RECIPIENT, value: hex(AMOUNT), ...overrides }]
    }
  ]
});

function mockRpc(options: { logs?: any[]; trace?: any; traceError?: any; traceHangs?: boolean; traceNotJson?: boolean; blockTimestamp?: number }) {
  vi.mocked(proxyFetch).mockImplementation((_url: string, init?: any) => {
    const { method } = JSON.parse(init?.body ?? '{}');

    const respond = (body: any) => Promise.resolve({ json: () => Promise.resolve(body) }) as any;

    switch (method) {
      case 'eth_getTransactionReceipt':
        return respond({ result: { status: '0x1', from: RELAYER, to: WALLET, blockNumber: '0x10', logs: options.logs ?? [] } });
      case 'eth_getBlockByNumber':
        return respond({ result: { timestamp: hex(BigInt(options.blockTimestamp ?? 1700000000)) } });
      case 'debug_traceTransaction':
        if (options.traceHangs) {
          return new Promise(() => undefined) as any;
        }

        if (options.traceNotJson) {
          return Promise.resolve({ json: () => Promise.reject(new SyntaxError('Unexpected token <')) }) as any;
        }

        return respond(options.traceError ? { error: options.traceError } : { result: options.trace });
      default:
        throw new Error(`Unexpected RPC ${method}`);
    }
  });
}

function network(): EvmNetwork {
  const evm = new EvmNetwork('http://rpc', 1);
  vi.spyOn((evm as any).provider, 'getBlockNumber').mockResolvedValue(100);
  return evm;
}

describe('EvmNetwork.getTxData native', () => {
  beforeEach(() => { vi.mocked(proxyFetch).mockReset(); });

  it('attributes the payer forwarding ETH it unwrapped in the same call', async () => {
    mockRpc({
      trace: {
        type: 'CALL', from: RELAYER, to: WALLET, value: '0x0',
        calls: [
          { type: 'CALL', from: TOKEN, to: WALLET, value: hex(AMOUNT) },
          { type: 'CALL', from: WALLET, to: RECIPIENT, value: hex(AMOUNT) }
        ]
      }
    });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: AMOUNT });
  });

  it('attributes a direct transfer from the payer', async () => {
    mockRpc({ trace: { type: 'CALL', from: WALLET, to: RECIPIENT, value: hex(AMOUNT) } });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, to: RECIPIENT, amount: AMOUNT });
  });

  it('counts only what the recipient keeps when it sends part of the payment back', async () => {
    mockRpc({
      trace: {
        type: 'CALL', from: WALLET, to: RECIPIENT, value: hex(AMOUNT),
        calls: [{ type: 'CALL', from: RECIPIENT, to: WALLET, value: hex(AMOUNT / 2n) }]
      }
    });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: AMOUNT / 2n });
  });

  it('attributes a contract wallet paying the recipient from an internal call', async () => {
    mockRpc({ trace: walletPayout() });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, to: RECIPIENT, amount: AMOUNT, envelopeFrom: RELAYER });
  });

  it('ignores value moved by a reverted inner frame', async () => {
    mockRpc({ trace: walletPayout({ error: 'execution reverted' }) });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', to: '', amount: 0n });
  });

  it('never counts the value of a CALLCODE frame', async () => {
    mockRpc({ trace: walletPayout({ type: 'CALLCODE' }) });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a third party paying the recipient while the wallet pays elsewhere', async () => {
    mockRpc({
      trace: {
        type: 'CALL', from: RELAYER, to: ROUTER, value: '0x0',
        calls: [
          { type: 'CALL', from: OTHER, to: RECIPIENT, value: hex(AMOUNT) },
          { type: 'CALL', from: WALLET, to: ROUTER, value: hex(AMOUNT) }
        ]
      }
    });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('retries a fresh transaction while the node cannot trace it', async () => {
    mockRpc({ traceError: { code: -32601, message: 'the method debug_traceTransaction does not exist' }, blockTimestamp: Math.floor(Date.now() / 1000) });

    await expect(network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET)).rejects.toThrow('unavailable');
  });

  it('gives up on a trace error past the retry window without attributing anything', async () => {
    mockRpc({ traceError: { code: -32000, message: 'historical state unavailable' } });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('retries a fresh transaction whose trace never answers', async () => {
    vi.useFakeTimers();
    mockRpc({ traceHangs: true, blockTimestamp: Math.floor(Date.now() / 1000) });

    const pending = network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);
    const assertion = expect(pending).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(8000);
    await assertion;

    vi.useRealTimers();
  });

  it('gives up once the trace keeps timing out past the retry window', async () => {
    vi.useFakeTimers();
    mockRpc({ traceHangs: true });

    const pending = network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    await vi.advanceTimersByTimeAsync(8000);

    expect(await pending).toMatchObject({ from: '', amount: 0n });

    vi.useRealTimers();
  });

  it('retries a fresh transaction whose trace answer is not JSON', async () => {
    mockRpc({ traceNotJson: true, blockTimestamp: Math.floor(Date.now() / 1000) });

    await expect(network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET)).rejects.toThrow('Unexpected token');
  });

  it('refuses a trace over the frame cap', async () => {
    const calls = Array.from({ length: 2001 }, () => ({ type: 'CALL', from: WALLET, to: RECIPIENT, value: '0x1' }));
    mockRpc({ trace: { type: 'CALL', from: RELAYER, to: WALLET, value: '0x0', calls } });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });
});

describe('EvmNetwork.getTxData ERC20', () => {
  beforeEach(() => { vi.mocked(proxyFetch).mockReset(); });

  it('keeps a direct transfer from the payer untouched', async () => {
    mockRpc({ logs: [transferLog(WALLET, RECIPIENT, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: 500n });
  });

  it('attributes the payer when the transfer is routed through a router', async () => {
    mockRpc({ logs: [transferLog(WALLET, ROUTER, 500n), transferLog(ROUTER, RECIPIENT, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: 500n, token: TOKEN });
  });

  it('refuses a third party paying the recipient while the payer pays elsewhere', async () => {
    mockRpc({ logs: [transferLog(OTHER, RECIPIENT, 500n), transferLog(WALLET, ROUTER, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a transfer to the recipient from anyone but the payer', async () => {
    mockRpc({ logs: [transferLog(OTHER, RECIPIENT, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('attributes the payer forwarding tokens it received in the same transaction', async () => {
    mockRpc({ logs: [transferLog(OTHER, WALLET, 500n), transferLog(WALLET, RECIPIENT, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: 500n });
  });

  it('attributes the payer forwarding swap output through a router', async () => {
    mockRpc({ logs: [transferLog(OTHER, WALLET, 500n), transferLog(WALLET, ROUTER, 500n), transferLog(ROUTER, RECIPIENT, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: 500n });
  });

  it('counts only the payer share of a router fed by someone else as well', async () => {
    mockRpc({ logs: [transferLog(WALLET, ROUTER, 100n), transferLog(OTHER, ROUTER, 400n), transferLog(ROUTER, RECIPIENT, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: 100n });
  });

  it('nets out what the recipient sends back to the payer', async () => {
    mockRpc({ logs: [transferLog(WALLET, RECIPIENT, 500n), transferLog(RECIPIENT, WALLET, 200n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, amount: 300n });
  });

  it('does not report a third party forwarding minted tokens as a mint', async () => {
    mockRpc({ logs: [transferLog(ZERO, OTHER, 500n), transferLog(OTHER, RECIPIENT, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('keeps a mint reported with a zero sender for the envelope path', async () => {
    mockRpc({ logs: [transferLog(ZERO, RECIPIENT, 500n), transferLog(WALLET, ROUTER, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: ZERO, envelopeFrom: RELAYER });
  });
});

describe('EvmNetwork.ping', () => {
  it('accepts an RPC that serves debug_traceTransaction', async () => {
    mockRpc({ traceError: { code: -32000, message: 'transaction not found' } });

    await expect(network().ping()).resolves.toBeUndefined();
  });

  it('accepts an RPC that answers an unknown trace with null', async () => {
    mockRpc({ trace: null });

    await expect(network().ping()).resolves.toBeUndefined();
  });

  it.each([
    { code: -32601, message: 'Method not found' },
    { code: -32000, message: 'rpc method is not whitelisted' },
    { code: -32004, message: 'debug namespace is not supported' },
    { code: -32000, message: 'debug_traceTransaction is not available on the Free tier' }
  ])('refuses an RPC without debug_traceTransaction: $message', async (traceError) => {
    mockRpc({ traceError });

    await expect(network().ping()).rejects.toThrow('does not serve debug_traceTransaction');
  });
});
