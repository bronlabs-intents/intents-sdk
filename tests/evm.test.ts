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

function mockRpc(options: { logs?: any[]; tx?: any; trace?: any; traceError?: any; traceHangs?: boolean }) {
  vi.mocked(proxyFetch).mockImplementation((_url: string, init?: any) => {
    const { method } = JSON.parse(init?.body ?? '{}');

    const respond = (body: any) => Promise.resolve({ json: () => Promise.resolve(body) }) as any;

    switch (method) {
      case 'eth_getTransactionReceipt':
        return respond({ result: { status: '0x1', from: RELAYER, to: WALLET, blockNumber: '0x10', logs: options.logs ?? [] } });
      case 'eth_getBlockByNumber':
        return respond({ result: { timestamp: '0x6553f100' } });
      case 'eth_getTransactionByHash':
        return respond({ result: options.tx ?? { from: RELAYER, to: WALLET, value: '0x0' } });
      case 'debug_traceTransaction':
        if (options.traceHangs) {
          return new Promise(() => undefined) as any;
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

  it('keeps a direct transfer from the payer untouched and does not trace it', async () => {
    mockRpc({ tx: { from: WALLET, to: RECIPIENT, value: hex(AMOUNT) } });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, to: RECIPIENT, amount: AMOUNT });
    expect(vi.mocked(proxyFetch).mock.calls.some(([, init]: any) => init.body.includes('debug_traceTransaction'))).toBe(false);
  });

  it('attributes a contract wallet paying the recipient from an internal call', async () => {
    mockRpc({ trace: walletPayout() });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: WALLET, to: RECIPIENT, amount: AMOUNT, envelopeFrom: RELAYER });
  });

  it('ignores value moved by a reverted inner frame', async () => {
    mockRpc({ trace: walletPayout({ error: 'execution reverted' }) });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: RELAYER, to: WALLET, amount: 0n });
  });

  it('never counts the value of a CALLCODE frame', async () => {
    mockRpc({ trace: walletPayout({ type: 'CALLCODE' }) });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx?.from).toBe(RELAYER);
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

    expect(tx?.from).toBe(RELAYER);
  });

  it('falls back to the top-level reading when the node has no tracer', async () => {
    mockRpc({ traceError: { code: -32601, message: 'the method debug_traceTransaction does not exist' } });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: RELAYER, to: WALLET, amount: 0n });
  });

  it('falls back on any other trace error rather than retrying forever', async () => {
    mockRpc({ traceError: { code: -32000, message: 'historical state unavailable' } });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx?.from).toBe(RELAYER);
  });

  it('times out a trace that never answers', async () => {
    vi.useFakeTimers();
    mockRpc({ traceHangs: true });

    const pending = network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);
    const assertion = expect(pending).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(8000);
    await assertion;

    vi.useRealTimers();
  });

  it('falls back when the trace is over the frame cap', async () => {
    const calls = Array.from({ length: 2001 }, () => ({ type: 'CALL', from: WALLET, to: RECIPIENT, value: '0x1' }));
    mockRpc({ trace: { type: 'CALL', from: RELAYER, to: WALLET, value: '0x0', calls } });

    const tx = await network().getTxData('0xhash', '0x0', RECIPIENT, undefined, WALLET);

    expect(tx?.from).toBe(RELAYER);
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

    expect(tx?.from.toLowerCase()).toBe(OTHER);
  });

  it('keeps a mint reported with a zero sender for the envelope path', async () => {
    mockRpc({ logs: [transferLog(ZERO, RECIPIENT, 500n), transferLog(WALLET, ROUTER, 500n)] });

    const tx = await network().getTxData('0xhash', TOKEN, RECIPIENT, undefined, WALLET);

    expect(tx).toMatchObject({ from: ZERO, envelopeFrom: RELAYER });
  });
});
