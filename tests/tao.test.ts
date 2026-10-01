import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ed25519 from '@noble/ed25519';
import { ethers } from 'ethers';
import { encodeAddress } from '@polkadot/util-crypto';

import { TaoNetwork, taoAccountId } from '../src/networks/tao.js';
import { allowedSettlementMethods, attestationKeyMatchesAddress, SettlementMethod } from '../src/attestation.js';

const MAINNET_TRANSFER_EXTRINSIC = '0x55028400a7208d10c6622f3f7eca1551de8355fde9de577dbb308d38994ace561738a51f023d6a2d163aed050afe52e4bafec921d871a738ecbe5c9e6a46b747990b0934ed7a6f610c772e6552732b81459c42824ed3bd6921db6c01f6c6649c08bfe69ec600b50236d10300000005000062ebebdc32e83a859d844c27a860dc63199093e024663fdb5f4a73808a68df760774da819805';
const MAINNET_TRANSFER_HASH = '0x5dce34e78f10634a8563ab028994f5aa3cbd0da5678ea4cfc255fd9475c927a5';

const SENDER_KEY = new Uint8Array(32).fill(1);
const RECIPIENT_KEY = new Uint8Array(32).fill(2);
const OTHER_KEY = new Uint8Array(32).fill(3);

const SENDER = encodeAddress(SENDER_KEY, 42);
const RECIPIENT = encodeAddress(RECIPIENT_KEY, 42);

const FINALIZED = 1100;
const TX_HEIGHT = 1090;
const BLOCK_TIME = 1_790_000_000;

const BLOCK_TIME_SECONDS = 12;
const WINDOW_MARGIN_BLOCKS = 50;

const transfer = (from: Uint8Array, to: Uint8Array, amount: bigint) => ({ from, to, amount });

const succeeded = (...transfers: any[]) => ({ failed: false, transfers });

function mockedNetwork(outcome: any = succeeded(transfer(SENDER_KEY, RECIPIENT_KEY, 5_000_000_000n)), txHeight = TX_HEIGHT) {
  const network = new TaoNetwork('https://tao.example');

  const rpc = vi.spyOn(network as any, 'rpcCall').mockImplementation(async (...args: any[]) => {
    const [method, params] = args as [string, any[]];

    switch (method) {
      case 'chain_getFinalizedHead':
        return '0xfinalized';
      case 'chain_getHeader':
        return { number: `0x${FINALIZED.toString(16)}` };
      case 'chain_getBlockHash':
        return `0xblock${params[0]}`;
      case 'chain_getBlock':
        return {
          block: {
            extrinsics: params[0] === `0xblock${txHeight}` ? ['0x280402000b', MAINNET_TRANSFER_EXTRINSIC] : ['0x280402000b']
          }
        };
      default:
        throw new Error(`unexpected rpc ${method}`);
    }
  });

  const extrinsicOutcome = vi.spyOn(network as any, 'extrinsicOutcome').mockResolvedValue(outcome);
  vi.spyOn(network as any, 'blockTimestamp').mockResolvedValue(BLOCK_TIME);

  return { network, rpc, extrinsicOutcome };
}

const blockFetches = (rpc: any) => rpc.mock.calls.filter(([method]: [string]) => method === 'chain_getBlock').map(([, [hash]]: [string, string[]]) => hash);

const notBeforeBlocksAgo = (blocks: number) => Math.ceil(Date.now() / 1000) - blocks * BLOCK_TIME_SECONDS;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TaoNetwork.getTxData', () => {
  it('finds the extrinsic by its blake2 hash and returns the transfer', async () => {
    const { network, extrinsicOutcome } = mockedNetwork();

    const tx = await network.getTxData(MAINNET_TRANSFER_HASH.toUpperCase().replace('0X', '0x'), '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(20));

    expect(tx).toEqual({ from: SENDER, to: RECIPIENT, token: '0x0', amount: 5_000_000_000n, confirmed: true, timestamp: BLOCK_TIME });
    expect(extrinsicOutcome).toHaveBeenCalledWith(`0xblock${TX_HEIGHT}`, 1);
  });

  it('starts the scan a margin before notBefore', async () => {
    const { network, rpc } = mockedNetwork();

    await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(20));

    expect(blockFetches(rpc)[0]).toBe(`0xblock${FINALIZED - 20 - WINDOW_MARGIN_BLOCKS}`);
  });

  it('reuses a found location without rescanning', async () => {
    const { network, rpc } = mockedNetwork();

    await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(20));
    const fetched = blockFetches(rpc).length;

    await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(20));

    expect(blockFetches(rpc).length).toBe(fetched);
  });

  it('returns undefined when the hash is not in the window and resumes from where it stopped', async () => {
    const { network, rpc } = mockedNetwork(undefined, FINALIZED + 1);

    expect(await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(0))).toBeUndefined();
    const fetched = blockFetches(rpc).length;

    expect(await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(0))).toBeUndefined();

    expect(fetched).toBe(WINDOW_MARGIN_BLOCKS + 1);
    expect(blockFetches(rpc).length).toBe(fetched);
  });

  it('keeps separate scan progress per notBefore', async () => {
    const { network, rpc } = mockedNetwork(undefined, FINALIZED + 1);

    await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(0));
    await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(30));

    expect(blockFetches(rpc)).toContain(`0xblock${FINALIZED - 30 - WINDOW_MARGIN_BLOCKS}`);
  });

  it('stops scanning at the time box', async () => {
    const { network, rpc } = mockedNetwork(undefined, FINALIZED + 1);

    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000));

    expect(await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, Math.floor(now / 1000) - 3600)).toBeUndefined();

    expect(blockFetches(rpc).length).toBeLessThan(60);
  });

  it('rejects a failed extrinsic', async () => {
    const { network } = mockedNetwork({ failed: true, transfers: [transfer(SENDER_KEY, RECIPIENT_KEY, 1n)] });

    const tx = await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(20));

    expect(tx).toMatchObject({ from: '', amount: 0n, confirmed: true, timestamp: BLOCK_TIME });
  });

  it.each([
    ['another recipient', succeeded(transfer(SENDER_KEY, OTHER_KEY, 1n))],
    ['another sender', succeeded(transfer(OTHER_KEY, RECIPIENT_KEY, 1n))],
    ['two matching transfers', succeeded(transfer(SENDER_KEY, RECIPIENT_KEY, 1n), transfer(SENDER_KEY, RECIPIENT_KEY, 1n))]
  ])('rejects %s', async (_, outcome) => {
    const { network } = mockedNetwork(outcome);

    const tx = await network.getTxData(MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined, SENDER, notBeforeBlocksAgo(20));

    expect(tx).toMatchObject({ from: '', amount: 0n, confirmed: true });
  });

  it.each([
    ['a hash without 0x', MAINNET_TRANSFER_HASH.slice(2), '0x0', RECIPIENT, SENDER],
    ['a short hash', MAINNET_TRANSFER_HASH.slice(0, 60), '0x0', RECIPIENT, SENDER],
    ['a non-native token', MAINNET_TRANSFER_HASH, '0x1', RECIPIENT, SENDER],
    ['a bad-checksum recipient', MAINNET_TRANSFER_HASH, '0x0', `${RECIPIENT.slice(0, -1)}${RECIPIENT.endsWith('a') ? 'b' : 'a'}`, SENDER],
    ['a hex recipient', MAINNET_TRANSFER_HASH, '0x0', ethers.hexlify(RECIPIENT_KEY), SENDER],
    ['a missing sender', MAINNET_TRANSFER_HASH, '0x0', RECIPIENT, undefined]
  ])('fails %s without touching the chain', async (_, hash, token, recipient, sender) => {
    const { network, rpc } = mockedNetwork();

    const tx = await network.getTxData(hash, token, recipient, undefined, sender, notBeforeBlocksAgo(20));

    expect(tx).toMatchObject({ from: '', amount: 0n, confirmed: true });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('TaoNetwork attestation', () => {
  it('binds an ed25519 key to its SS58 address under any prefix', async () => {
    const network = new TaoNetwork('https://tao.example');
    const publicKey = ethers.hexlify(RECIPIENT_KEY);

    expect(network.addressFromPublicKey(publicKey)).toBe(RECIPIENT);
    expect(await attestationKeyMatchesAddress(network, publicKey, RECIPIENT)).toBe(true);
    expect(await attestationKeyMatchesAddress(network, publicKey, encodeAddress(RECIPIENT_KEY, 0))).toBe(true);
    expect(await attestationKeyMatchesAddress(network, publicKey, SENDER)).toBe(false);
    expect(await attestationKeyMatchesAddress(network, publicKey, `${RECIPIENT.slice(0, -1)}${RECIPIENT.endsWith('a') ? 'b' : 'a'}`)).toBe(false);
    expect(await attestationKeyMatchesAddress(network, publicKey, RECIPIENT.toLowerCase())).toBe(false);
  });

  it('verifies an ed25519 signature over the raw preimage', async () => {
    const network = new TaoNetwork('https://tao.example');
    const secret = ed25519.utils.randomSecretKey();
    const publicKey = ethers.hexlify(await ed25519.getPublicKeyAsync(secret));
    const preimage = ethers.toUtf8Bytes('preimage');
    const signature = ethers.hexlify(await ed25519.signAsync(preimage, secret));

    expect(await network.verifyAttestation(publicKey, signature, preimage)).toBe(true);
    expect(await network.verifyAttestation(publicKey, signature, ethers.toUtf8Bytes('other'))).toBe(false);
  });

  it('rejects a hex AccountId as an address', () => {
    expect(taoAccountId(ethers.hexlify(RECIPIENT_KEY))).toBeUndefined();
  });
});

describe('MON settlement methods', () => {
  it('allows payer signature and EIP-712', () => {
    expect(allowedSettlementMethods('MON')).toEqual([SettlementMethod.PayerSignature, SettlementMethod.PayerSignatureEip712]);
  });
});
