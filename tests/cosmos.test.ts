import { describe, expect, it, vi } from 'vitest';

import { bech32 } from 'bech32';
import { ethers } from 'ethers';

import { CosmosNetwork } from '../src/networks/cosmos.js';

const DENOM = 'ngonka';
const PAYER = 'gonka1payer';
const CONTRACT = 'gonka1contract';
const RECIPIENT = 'gonka1recipient';
const OTHER = 'gonka1other';
const FEE_COLLECTOR = bech32.encode('gonka', bech32.toWords(ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes('fee_collector'))).slice(0, 20)));

const event = (type: string, attributes: [string, string][]) => ({ type, attributes: attributes.map(([key, value]) => ({ key, value })) });

const move = (from: string, to: string, amount: string) => [
  event('coin_spent', [['spender', from], ['amount', amount]]),
  event('coin_received', [['receiver', to], ['amount', amount]]),
  event('transfer', [['recipient', to], ['sender', from], ['amount', amount]])
];

function mockedNetwork(events: any[]): CosmosNetwork {
  const network = new CosmosNetwork('http://rpc', DENOM, 'gonka', 0, 1);

  vi.spyOn(network as any, 'rpcGet').mockImplementation(async (...args: any[]) => {
    const [method, params] = args as [string, Record<string, string> | undefined];

    if (method === 'tx') {
      return { height: '50', tx_result: { code: 0, events } };
    }

    return params?.height
      ? { block: { header: { height: '50', time: '2026-01-01T00:00:00Z' } } }
      : { block: { header: { height: '100' } } };
  });

  return network;
}

describe('CosmosNetwork.getTxData', () => {
  it('keeps a direct transfer from the payer untouched', async () => {
    const tx = await mockedNetwork(move(PAYER, RECIPIENT, `700${DENOM}`)).getTxData('ab', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, to: RECIPIENT, amount: 700n, confirmed: true });
  });

  it('gives nothing for a payment a contract forwarded from the payer', async () => {
    const events = [...move(PAYER, CONTRACT, `700${DENOM}`), ...move(CONTRACT, RECIPIENT, `700${DENOM}`)];

    const tx = await mockedNetwork(events).getTxData('ab', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('reads the order denom out of a multi-denom amount', async () => {
    const events = move(PAYER, RECIPIENT, `5uatom,700${DENOM}`);

    const tx = await mockedNetwork(events).getTxData('ab', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, amount: 700n });
  });

  it('does not count a network fee paid by another account against the payer', async () => {
    const events = [...move(OTHER, FEE_COLLECTOR, `10${DENOM}`), ...move(PAYER, RECIPIENT, `700${DENOM}`)];

    const tx = await mockedNetwork(events).getTxData('ab', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, amount: 700n });
  });

  it('refuses a third party paying the recipient while the payer pays elsewhere', async () => {
    const events = [...move(OTHER, RECIPIENT, `700${DENOM}`), ...move(PAYER, CONTRACT, `700${DENOM}`)];

    const tx = await mockedNetwork(events).getTxData('ab', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('attributes the payer forwarding coins it received in the same transaction', async () => {
    const events = [...move(OTHER, PAYER, `700${DENOM}`), ...move(PAYER, RECIPIENT, `700${DENOM}`)];

    const tx = await mockedNetwork(events).getTxData('ab', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, amount: 700n });
  });

  it('refuses newly minted coins reaching the recipient while the payer pays elsewhere', async () => {
    const events = [
      event('coinbase', [['minter', CONTRACT], ['amount', `700${DENOM}`]]),
      event('coin_received', [['receiver', RECIPIENT], ['amount', `700${DENOM}`]]),
      ...move(PAYER, CONTRACT, `700${DENOM}`)
    ];

    const tx = await mockedNetwork(events).getTxData('ab', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });
});
