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

function mockedNetwork(vinAddresses: string[], sighashFlag: number): BtcNetwork {
  const network = new BtcNetwork('http://localhost', 1);

  const vin = vinAddresses.map((_, i) => ({
    txid: `prev${i}`,
    vout: 0,
    txinwitness: [derSig(sighashFlag).toString('hex'), pubkey.toString('hex')]
  }));

  const prevTxs = Object.fromEntries(vinAddresses.map((address, i) => [
    `prev${i}`,
    { txid: `prev${i}`, vin: [], vout: [{ value: 1, scriptPubKey: { address, type: 'witness_v0_keyhash' } }], confirmations: 10 }
  ]));

  vi.spyOn(network as any, 'rpcCall').mockImplementation(async (...args: any[]) => {
    const [method, params] = args as [string, any[]];
    if (method !== 'getrawtransaction') throw new Error(`Unexpected RPC ${method}`);
    if (params[0] === 'maintx') {
      return {
        txid: 'maintx',
        vin,
        vout: [{ value: 4.6, scriptPubKey: { address: RECIPIENT, type: 'witness_v0_keyhash' } }],
        confirmations: 10,
        blocktime: 1784671109
      };
    }
    return prevTxs[params[0]];
  });

  return network;
}

describe('getTxData sender attribution', () => {
  it('attributes from when all inputs are from one address, sighash irrelevant', async () => {
    const tx = await mockedNetwork([SENDER_A, SENDER_A], 0x83).getTxData('maintx', '0x0', RECIPIENT);
    expect(tx?.from).toBe(SENDER_A);
  });

  it('attributes expected sender on multi-address inputs when it owns an input and all sigs are SIGHASH_ALL', async () => {
    const tx = await mockedNetwork([SENDER_A, SENDER_B], 0x01).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx?.from).toBe(SENDER_A);
  });

  it('refuses multi-address inputs without an expected sender', async () => {
    const tx = await mockedNetwork([SENDER_A, SENDER_B], 0x01).getTxData('maintx', '0x0', RECIPIENT);
    expect(tx?.from).toBe('');
  });

  it('refuses when the expected sender owns no input', async () => {
    const tx = await mockedNetwork([SENDER_A, SENDER_B], 0x01).getTxData('maintx', '0x0', RECIPIENT, undefined, RECIPIENT);
    expect(tx?.from).toBe('');
  });

  it('refuses multi-address inputs when a signature is not SIGHASH_ALL', async () => {
    const tx = await mockedNetwork([SENDER_A, SENDER_B], 0x81).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx?.from).toBe('');
  });

  it('sums outputs to the recipient regardless of sender attribution', async () => {
    const tx = await mockedNetwork([SENDER_A, SENDER_B], 0x01).getTxData('maintx', '0x0', RECIPIENT, undefined, SENDER_A);
    expect(tx?.amount).toBe(460000000n);
  });
});
