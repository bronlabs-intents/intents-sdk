import { describe, expect, it, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';

import { BtcNetwork, inputSignsAllOutputs } from '../src/networks/btc.js';

const derSig = (flag: number): Buffer =>
  Buffer.concat([
    Buffer.from([0x30, 0x44, 0x02, 0x20]),
    Buffer.alloc(32, 0x11),
    Buffer.from([0x02, 0x20]),
    Buffer.alloc(32, 0x22),
    Buffer.from([flag])
  ]);

const pubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0x33)]);

describe('inputSignsAllOutputs', () => {
  it('accepts P2WPKH witness signed with SIGHASH_ALL', () => {
    const vin = { txinwitness: [derSig(0x01).toString('hex'), pubkey.toString('hex')] };
    expect(inputSignsAllOutputs(vin, 'witness_v0_keyhash')).toBe(true);
  });

  it('rejects P2WPKH witness signed with ANYONECANPAY|ALL', () => {
    const vin = { txinwitness: [derSig(0x81).toString('hex'), pubkey.toString('hex')] };
    expect(inputSignsAllOutputs(vin, 'witness_v0_keyhash')).toBe(false);
  });

  it('accepts legacy P2PKH scriptSig signed with SIGHASH_ALL', () => {
    const scriptSig = bitcoin.script.compile([derSig(0x01), pubkey]).toString('hex');
    expect(inputSignsAllOutputs({ scriptSig: { hex: scriptSig } }, 'pubkeyhash')).toBe(true);
  });

  it('rejects legacy P2PKH scriptSig signed with SIGHASH_NONE', () => {
    const scriptSig = bitcoin.script.compile([derSig(0x02), pubkey]).toString('hex');
    expect(inputSignsAllOutputs({ scriptSig: { hex: scriptSig } }, 'pubkeyhash')).toBe(false);
  });

  it('rejects multisig where one of the signatures is not SIGHASH_ALL', () => {
    const vin = { txinwitness: ['', derSig(0x01).toString('hex'), derSig(0x83).toString('hex'), 'aa'] };
    expect(inputSignsAllOutputs(vin, 'witness_v0_scripthash')).toBe(false);
  });

  it('accepts multisig where all signatures are SIGHASH_ALL', () => {
    const vin = { txinwitness: ['', derSig(0x01).toString('hex'), derSig(0x01).toString('hex'), 'aa'] };
    expect(inputSignsAllOutputs(vin, 'witness_v0_scripthash')).toBe(true);
  });

  it('accepts taproot keypath with 64-byte signature (SIGHASH_DEFAULT)', () => {
    const vin = { txinwitness: [Buffer.alloc(64, 0x44).toString('hex')] };
    expect(inputSignsAllOutputs(vin, 'witness_v1_taproot')).toBe(true);
  });

  it('accepts taproot keypath with explicit SIGHASH_ALL byte', () => {
    const sig = Buffer.concat([Buffer.alloc(64, 0x44), Buffer.from([0x01])]);
    expect(inputSignsAllOutputs({ txinwitness: [sig.toString('hex')] }, 'witness_v1_taproot')).toBe(true);
  });

  it('rejects taproot keypath with non-ALL sighash byte', () => {
    const sig = Buffer.concat([Buffer.alloc(64, 0x44), Buffer.from([0x83])]);
    expect(inputSignsAllOutputs({ txinwitness: [sig.toString('hex')] }, 'witness_v1_taproot')).toBe(false);
  });

  it('rejects taproot script-path spends', () => {
    const vin = { txinwitness: [Buffer.alloc(64, 0x44).toString('hex'), 'aabb', 'ccdd'] };
    expect(inputSignsAllOutputs(vin, 'witness_v1_taproot')).toBe(false);
  });

  it('accepts taproot keypath with annex present', () => {
    const annex = Buffer.concat([Buffer.from([0x50]), Buffer.alloc(4, 0xaa)]);
    const vin = { txinwitness: [Buffer.alloc(64, 0x44).toString('hex'), annex.toString('hex')] };
    expect(inputSignsAllOutputs(vin, 'witness_v1_taproot')).toBe(true);
  });

  it('fails closed when no signature can be extracted', () => {
    expect(inputSignsAllOutputs({}, 'pubkeyhash')).toBe(false);
    expect(inputSignsAllOutputs({ txinwitness: [pubkey.toString('hex')] }, 'witness_v0_keyhash')).toBe(false);
  });
});

const SENDER_A = 'bc1qsenderaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SENDER_B = 'bc1qsenderbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RECIPIENT = 'bc1qrecipientcccccccccccccccccccccccccccc';

function mockedNetwork(inputs: [string, number][], outputs: [string, number][], sighashFlag = 0x01): BtcNetwork {
  const network = new BtcNetwork('http://localhost', 1);

  const vin = inputs.map((_, i) => ({
    txid: `prev${i}`,
    vout: 0,
    txinwitness: [derSig(sighashFlag).toString('hex'), pubkey.toString('hex')]
  }));

  const prevTxs = Object.fromEntries(inputs.map(([address, value], i) => [
    `prev${i}`,
    { txid: `prev${i}`, vin: [], vout: [{ value, scriptPubKey: { address, type: 'witness_v0_keyhash' } }], confirmations: 10 }
  ]));

  vi.spyOn(network as any, 'rpcCall').mockImplementation(async (...args: any[]) => {
    const [method, params] = args as [string, any[]];
    if (method !== 'getrawtransaction') throw new Error(`Unexpected RPC ${method}`);
    if (params[0] === 'maintx') {
      return {
        txid: 'maintx',
        vin,
        vout: outputs.map(([address, value]) => ({ value, scriptPubKey: { address, type: 'witness_v0_keyhash' } })),
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

  it('does not count what another input funded', async () => {
    const tx = await mockedNetwork([[SENDER_A, 1], [SENDER_B, 0.5]], [[RECIPIENT, 1.2], [SENDER_A, 0.29]]).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx).toMatchObject({ from: SENDER_A, amount: 70000000n });
  });

  it('counts only the expected address of a wallet spending from several addresses', async () => {
    const tx = await mockedNetwork([[SENDER_A, 0.5], [SENDER_B, 0.5]], [[RECIPIENT, 0.9]]).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx).toMatchObject({ from: SENDER_A, amount: 40000000n });
  });

  it('refuses when the expected sender owns no input', async () => {
    const tx = await mockedNetwork([[SENDER_B, 1]], [[RECIPIENT, 0.9]]).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses when an input of the payer does not sign every output', async () => {
    const tx = await mockedNetwork([[SENDER_A, 1]], [[RECIPIENT, 0.9]], 0x81).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
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
