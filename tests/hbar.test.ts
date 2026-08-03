import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import { HbarNetwork, toMirrorTxId } from '../src/networks/hbar.js';
import {
  attestationKeyMatchesAddress,
  buildAttestationPreimage,
  isAttestationCapable,
  secp256k1Digest,
  AttestationMessageParams
} from '../src/attestation.js';

const MIRROR_URL = 'https://testnet.mirrornode.hedera.com';

const PAYER = '0.0.4400001';
const RECIPIENT = '0.0.4400002';
const OTHER = '0.0.4400003';
const NODE = '0.0.4';
const TOKEN = '0.0.5449';

const TX_ID = `${PAYER}-1785741956-431173749`;
const SDK_TX_ID = `${PAYER}@1785741956.431173749`;

const params: AttestationMessageParams = {
  orderEngine: '0x1111111111111111111111111111111111111111',
  leg: 'user',
  orderId: 'order-abc',
  counterparty: RECIPIENT,
  token: '0x0',
  baseAmount: 1000000n,
  quoteAmount: 0n,
  price: 2000000000000000000n
};

const nativeEntry = {
  transaction_id: TX_ID,
  consensus_timestamp: '1785741962.184710419',
  result: 'SUCCESS',
  nonce: 0,
  scheduled: false,
  node: NODE,
  transfers: [
    { account: '0.0.802', amount: 144403 },
    { account: RECIPIENT, amount: 2588995597 },
    { account: PAYER, amount: -2589140000 }
  ],
  token_transfers: []
};

const tokenEntry = {
  transaction_id: TX_ID,
  consensus_timestamp: '1785741962.184710419',
  result: 'SUCCESS',
  nonce: 0,
  scheduled: false,
  node: NODE,
  transfers: [
    { account: '0.0.802', amount: 1444041 },
    { account: PAYER, amount: -1444041 }
  ],
  token_transfers: [
    { token_id: TOKEN, account: RECIPIENT, amount: 21397915 },
    { token_id: TOKEN, account: PAYER, amount: -21397915 },
    { token_id: '0.0.2340890', account: RECIPIENT, amount: 500 },
    { token_id: '0.0.2340890', account: OTHER, amount: -500 }
  ]
};

function mockedNetwork(responses: Record<string, any>): HbarNetwork {
  const network = new HbarNetwork(MIRROR_URL);

  vi.spyOn(network as any, 'apiGet').mockImplementation(async (...args: any[]) => {
    const path = args[0] as string;

    if (!(path in responses)) {
      return undefined;
    }

    const response = responses[path];

    if (response instanceof Error) {
      throw response;
    }

    return response;
  });

  return network;
}

const withEntries = (...transactions: any[]) => ({ [`transactions/${TX_ID}`]: { transactions } });

describe('toMirrorTxId', () => {
  it('converts the SDK form to the mirror path form', () => {
    expect(toMirrorTxId(SDK_TX_ID)).toBe(TX_ID);
  });

  it('keeps the mirror path form', () => {
    expect(toMirrorTxId(TX_ID)).toBe(TX_ID);
  });

  it('left-pads an unpadded nanosecond count in both forms', () => {
    expect(toMirrorTxId('0.0.5-1785741845-9474185')).toBe('0.0.5-1785741845-009474185');
    expect(toMirrorTxId('0.0.5@1785741845.9474185')).toBe('0.0.5-1785741845-009474185');
    expect(toMirrorTxId('0.0.5-1785741845-5')).toBe('0.0.5-1785741845-000000005');
    expect(toMirrorTxId('0.0.5@1785741845.5')).toBe('0.0.5-1785741845-000000005');
  });

  it('rejects anything that is not a transaction id', () => {
    expect(toMirrorTxId('0xdeadbeef')).toBeUndefined();
    expect(toMirrorTxId('0.0.5-1785741845')).toBeUndefined();
    expect(toMirrorTxId('0.0.5@1785741845.1234567890')).toBeUndefined();
    expect(toMirrorTxId('')).toBeUndefined();
  });
});

describe('getTxData native HBAR', () => {
  it('reads amount, sender and consensus time of a successful transfer', async () => {
    const tx = await mockedNetwork(withEntries(nativeEntry)).getTxData(TX_ID, '0x0', RECIPIENT);

    expect(tx).toEqual({
      from: PAYER,
      to: RECIPIENT,
      token: '0x0',
      amount: 2588995597n,
      confirmed: true,
      timestamp: 1785741962
    });
  });

  it('accepts the SDK transaction id form', async () => {
    const tx = await mockedNetwork(withEntries(nativeEntry)).getTxData(SDK_TX_ID, '0x0', RECIPIENT);
    expect(tx?.amount).toBe(2588995597n);
  });

  it('ignores fee, reward and node debits when attributing the sender', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [
        ...nativeEntry.transfers,
        { account: '0.0.800', amount: -12345 },
        { account: NODE, amount: -1 }
      ]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, '0x0', RECIPIENT);
    expect(tx?.from).toBe(PAYER);
  });

  it('refuses to attribute a sender when several accounts are debited', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [...nativeEntry.transfers, { account: OTHER, amount: -100 }]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, '0x0', RECIPIENT);
    expect(tx?.from).toBe('');
    expect(tx?.amount).toBe(2588995597n);
  });

  it('sums several credits to the recipient', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [...nativeEntry.transfers, { account: RECIPIENT, amount: 403 }]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, '0x0', RECIPIENT);
    expect(tx?.amount).toBe(2588995597n + 403n);
  });

  it('nets a staking reward out of the recipient credit', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [
        { account: '0.0.800', amount: -5316612 },
        { account: '0.0.802', amount: 145004 },
        { account: PAYER, amount: -10000145004 },
        { account: RECIPIENT, amount: 10005316612 }
      ],
      staking_reward_transfers: [{ account: RECIPIENT, amount: 5316612 }]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, '0x0', RECIPIENT);

    expect(tx?.amount).toBe(10000000000n);
    expect(tx?.from).toBe(PAYER);
  });

  it('attributes the sender whose net change a staking reward turned positive', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [
        { account: '0.0.800', amount: -200000000 },
        { account: '0.0.802', amount: 144403 },
        { account: PAYER, amount: 99855597 },
        { account: RECIPIENT, amount: 100000000 }
      ],
      staking_reward_transfers: [{ account: PAYER, amount: 200000000 }]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, '0x0', RECIPIENT);

    expect(tx?.from).toBe(PAYER);
    expect(tx?.amount).toBe(100000000n);
  });

  it('zeroes a transaction whose only credit to the recipient is a staking reward', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [
        { account: '0.0.800', amount: -5316612 },
        { account: '0.0.802', amount: 145004 },
        { account: PAYER, amount: -145004 },
        { account: RECIPIENT, amount: 5316612 }
      ],
      staking_reward_transfers: [{ account: RECIPIENT, amount: 5316612 }]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, '0x0', RECIPIENT);

    expect(tx).toEqual({ from: '', to: '', token: '', amount: 0n, confirmed: true, timestamp: 1785741962 });
  });

  it('picks the successful submission when the id was submitted twice', async () => {
    const duplicate = { ...nativeEntry, result: 'DUPLICATE_TRANSACTION', node: '0.0.5', transfers: [], token_transfers: [] };

    const tx = await mockedNetwork(withEntries(duplicate, nativeEntry)).getTxData(TX_ID, '0x0', RECIPIENT);
    expect(tx?.amount).toBe(2588995597n);
  });

  it('ignores child and scheduled entries', async () => {
    const child = { ...nativeEntry, nonce: 1, transfers: [{ account: RECIPIENT, amount: 999 }] };
    const scheduled = { ...nativeEntry, scheduled: true, transfers: [{ account: RECIPIENT, amount: 777 }] };

    const tx = await mockedNetwork(withEntries(child, scheduled, nativeEntry)).getTxData(TX_ID, '0x0', RECIPIENT);
    expect(tx?.amount).toBe(2588995597n);

    expect(await mockedNetwork(withEntries(child, scheduled)).getTxData(TX_ID, '0x0', RECIPIENT)).toBeUndefined();
  });

  it('zeroes a failed transaction but keeps its finality', async () => {
    const failed = { ...nativeEntry, result: 'INSUFFICIENT_ACCOUNT_BALANCE' };

    expect(await mockedNetwork(withEntries(failed)).getTxData(TX_ID, '0x0', RECIPIENT)).toEqual({
      from: '',
      to: '',
      token: '',
      amount: 0n,
      confirmed: true,
      timestamp: 1785741962
    });
  });

  it('zeroes a transaction that does not credit the recipient', async () => {
    const tx = await mockedNetwork(withEntries(nativeEntry)).getTxData(TX_ID, '0x0', OTHER);

    expect(tx).toEqual({ from: '', to: '', token: '', amount: 0n, confirmed: true, timestamp: 1785741962 });
  });

  it('reports no finality when the entry has not reached consensus', async () => {
    const pending = { ...nativeEntry, consensus_timestamp: undefined };
    const tx = await mockedNetwork(withEntries(pending)).getTxData(TX_ID, '0x0', RECIPIENT);

    expect(tx?.confirmed).toBe(false);
    expect(tx?.timestamp).toBe(0);
  });

  it('returns nothing for an unknown transaction, a malformed id or an NFT', async () => {
    expect(await mockedNetwork({}).getTxData(TX_ID, '0x0', RECIPIENT)).toBeUndefined();
    expect(await mockedNetwork(withEntries(nativeEntry)).getTxData('0xdeadbeef', '0x0', RECIPIENT)).toBeUndefined();
    expect(await mockedNetwork(withEntries(nativeEntry)).getTxData(TX_ID, TOKEN, RECIPIENT, 1n)).toBeUndefined();
  });
});

describe('getTxData HTS token', () => {
  it('reads the requested token transfer only', async () => {
    const tx = await mockedNetwork(withEntries(tokenEntry)).getTxData(TX_ID, TOKEN, RECIPIENT);

    expect(tx).toEqual({
      from: PAYER,
      to: RECIPIENT,
      token: TOKEN,
      amount: 21397915n,
      confirmed: true,
      timestamp: 1785741962
    });
  });

  it('attributes the token sender, not the fee payer', async () => {
    const entry = {
      ...tokenEntry,
      token_transfers: [
        { token_id: TOKEN, account: RECIPIENT, amount: 21397915 },
        { token_id: TOKEN, account: OTHER, amount: -21397915 }
      ]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, TOKEN, RECIPIENT);
    expect(tx?.from).toBe(OTHER);
  });

  it('refuses to attribute a sender when several accounts are debited', async () => {
    const entry = {
      ...tokenEntry,
      token_transfers: [
        { token_id: TOKEN, account: RECIPIENT, amount: 21397915 },
        { token_id: TOKEN, account: PAYER, amount: -21397900 },
        { token_id: TOKEN, account: OTHER, amount: -15 }
      ]
    };

    const tx = await mockedNetwork(withEntries(entry)).getTxData(TX_ID, TOKEN, RECIPIENT);
    expect(tx?.from).toBe('');
  });

  it('refuses an amount that JSON parsing already rounded', async () => {
    const entry = {
      ...tokenEntry,
      token_transfers: [
        { token_id: TOKEN, account: RECIPIENT, amount: 9223372036854775807 },
        { token_id: TOKEN, account: PAYER, amount: -9223372036854775807 }
      ]
    };

    await expect(mockedNetwork(withEntries(entry)).getTxData(TX_ID, TOKEN, RECIPIENT))
      .rejects.toThrow(/exceeds safe integer range/);
  });

  it('zeroes a transaction that moves another token only', async () => {
    const tx = await mockedNetwork(withEntries(tokenEntry)).getTxData(TX_ID, '0.0.9999', RECIPIENT);

    expect(tx).toEqual({ from: '', to: '', token: '', amount: 0n, confirmed: true, timestamp: 1785741962 });
  });
});

describe('getDecimals', () => {
  it('returns tinybar decimals for native HBAR', async () => {
    expect(await mockedNetwork({}).getDecimals('0x0')).toBe(8);
  });

  it('reads decimals of an HTS token', async () => {
    const network = mockedNetwork({ [`tokens/${TOKEN}`]: { token_id: TOKEN, decimals: '6' } });
    expect(await network.getDecimals(TOKEN)).toBe(6);
  });

  it('throws for an unknown or malformed token id', async () => {
    await expect(mockedNetwork({}).getDecimals(TOKEN)).rejects.toThrow(/Failed to get decimals/);
    await expect(mockedNetwork({}).getDecimals('notatoken')).rejects.toThrow(/Invalid HBAR token id/);
  });
});

describe('attestation', () => {
  const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const publicKey = wallet.signingKey.publicKey;
  const compressed = ethers.SigningKey.computePublicKey(publicKey, true).slice(2);
  const account = (key: any) => ({ [`accounts/${PAYER}?limit=1`]: { account: PAYER, key } });

  it('is attestation capable and derives the EVM alias of the key', () => {
    const network = new HbarNetwork(MIRROR_URL);

    expect(isAttestationCapable(network)).toBe(true);
    expect(network.addressFromPublicKey(publicKey)).toBe(wallet.address.toLowerCase());
  });

  it('verifies a signature over the canonical preimage', () => {
    const network = new HbarNetwork(MIRROR_URL);
    const preimage = buildAttestationPreimage(params);
    const signature = wallet.signingKey.sign(secp256k1Digest(preimage)).serialized;

    expect(network.verifyAttestation(publicKey, signature, preimage)).toBe(true);
    expect(network.verifyAttestation(publicKey, signature, buildAttestationPreimage({ ...params, leg: 'solver' }))).toBe(false);
  });

  it('binds a key to the account the mirror node says it controls', async () => {
    const network = mockedNetwork(account({ _type: 'ECDSA_SECP256K1', key: compressed }));

    expect(await attestationKeyMatchesAddress(network, publicKey, PAYER)).toBe(true);
  });

  it('rejects another key of the same account', async () => {
    const other = ethers.SigningKey.computePublicKey(new ethers.Wallet(ethers.id('hbar-other')).signingKey.publicKey, true).slice(2);
    const network = mockedNetwork(account({ _type: 'ECDSA_SECP256K1', key: other }));

    expect(await attestationKeyMatchesAddress(network, publicKey, PAYER)).toBe(false);
  });

  it('rejects accounts that are not controlled by a single ECDSA key', async () => {
    for (const key of [{ _type: 'ED25519', key: compressed }, { _type: 'ProtobufEncoded', key: compressed }, null]) {
      const network = mockedNetwork(account(key));
      expect(await attestationKeyMatchesAddress(network, publicKey, PAYER), JSON.stringify(key)).toBe(false);
    }
  });

  it('rejects a non-native address', async () => {
    const network = mockedNetwork(account({ _type: 'ECDSA_SECP256K1', key: compressed }));

    expect(await attestationKeyMatchesAddress(network, publicKey, wallet.address)).toBe(false);
    expect(await attestationKeyMatchesAddress(network, publicKey, `0.1.${PAYER.split('.')[2]}`)).toBe(false);
  });

  it('rejects an account that does not exist', async () => {
    expect(await attestationKeyMatchesAddress(mockedNetwork({}), publicKey, PAYER)).toBe(false);
  });

  it('propagates a transient mirror node failure instead of reporting an unbound key', async () => {
    const failing = mockedNetwork({ [`accounts/${PAYER}?limit=1`]: new Error('HBAR mirror node error 503') });

    await expect(attestationKeyMatchesAddress(failing, publicKey, PAYER)).rejects.toThrow(/503/);
  });
});

describe('transfer', () => {
  it('is not supported', async () => {
    await expect(new HbarNetwork(MIRROR_URL).transfer()).rejects.toThrow(/does not support transfers/);
  });
});
