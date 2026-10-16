import { describe, expect, it, vi } from 'vitest';

import { BtcNetwork } from '../src/networks/btc.js';

const SENDER_A = 'bc1qsenderaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SENDER_B = 'bc1qsenderbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RECIPIENT = 'bc1qrecipientcccccccccccccccccccccccccccc';

function mockedNetwork(inputs: [string, number][], outputs: [string, number][]): BtcNetwork {
  const network = new BtcNetwork('http://localhost', 1);

  const vin = inputs.map((_, i) => ({ txid: `prev${i}`, vout: 0 }));

  const prevTxs = Object.fromEntries(inputs.map(([address, value], i) => [
    `prev${i}`,
    { txid: `prev${i}`, vin: [], vout: [{ value, scriptPubKey: { address } }], confirmations: 10 }
  ]));

  vi.spyOn(network as any, 'rpcCall').mockImplementation(async (...args: any[]) => {
    const [method, params] = args as [string, any[]];
    if (method !== 'getrawtransaction') throw new Error(`Unexpected RPC ${method}`);
    if (params[0] === 'maintx') {
      return {
        txid: 'maintx',
        vin,
        vout: outputs.map(([address, value]) => ({ value, scriptPubKey: { address } })),
        confirmations: 10,
        blocktime: 1784671109
      };
    }
    if (!(params[0] in prevTxs)) throw new Error('prevout unavailable');
    return prevTxs[params[0]];
  });

  return network;
}

describe('getTxData', () => {
  it('credits the payer with its payment, change excluded', async () => {
    const tx = await mockedNetwork([[SENDER_A, 1]], [[RECIPIENT, 0.6], [SENDER_A, 0.39]]).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx).toMatchObject({ from: SENDER_A, to: RECIPIENT, amount: 60000000n, confirmed: true, timestamp: 1784671109 });
  });

  it('sums several inputs of the payer and several outputs to the recipient', async () => {
    const tx = await mockedNetwork([[SENDER_A, 1], [SENDER_A, 1]], [[RECIPIENT, 1.2], [RECIPIENT, 0.7]]).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx).toMatchObject({ from: SENDER_A, amount: 190000000n });
  });

  it('refuses when another address funds an input', async () => {
    const tx = await mockedNetwork([[SENDER_A, 1], [SENDER_B, 0.5]], [[RECIPIENT, 1.2], [SENDER_A, 0.29]]).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses when the expected sender owns no input', async () => {
    const tx = await mockedNetwork([[SENDER_B, 1]], [[RECIPIENT, 0.9]]).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('retries when a previous output cannot be fetched', async () => {
    const network = mockedNetwork([[SENDER_A, 1]], [[RECIPIENT, 0.9]]);
    const rpc = vi.mocked((network as any).rpcCall);
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method: string, params: any[]) => params[0] === 'prev0' ? Promise.reject(new Error('timeout')) : original(method, params));

    expect(await network.getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A)).toBeUndefined();
  });
});
