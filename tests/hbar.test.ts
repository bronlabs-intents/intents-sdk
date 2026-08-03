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
const TOKEN = '0.0.5449';

const TX_ID = `${PAYER}-1785741956-431173749`;
const SDK_TX_ID = `${PAYER}@1785741956.431173749`;

const NATIVE_HASH = `0x${'ab'.repeat(48)}`;
const BASE64_HASH = `${'q80'.repeat(21)}A`;
const ETHEREUM_HASH = `0x${'cd'.repeat(32)}`;

const PAYER_ALIAS = new ethers.Wallet(ethers.id('hbar-payer')).address;
const RECIPIENT_ALIAS = new ethers.Wallet(ethers.id('hbar-recipient')).address;

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
  consensus_timestamp: '1785741962.184710419',
  result: 'SUCCESS',
  nonce: 0,
  scheduled: false,
  transfers: [
    { account: '0.0.802', amount: 144403 },
    { account: RECIPIENT, amount: 2588995597 },
    { account: PAYER, amount: -2589140000 }
  ]
};

const tokenEntry = {
  consensus_timestamp: '1785741962.184710419',
  result: 'SUCCESS',
  nonce: 0,
  scheduled: false,
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

const withEntriesAt = (path: string, ...transactions: any[]) => ({ [`transactions/${path}`]: { transactions } });

const withEntries = (...transactions: any[]) => withEntriesAt(TX_ID, ...transactions);

const withAlias = (alias: string, account: string) => ({ [`accounts/${alias.toLowerCase()}?limit=1`]: { account } });

const accountLookups = (network: HbarNetwork) =>
  (network as any).apiGet.mock.calls.filter(([path]: [string]) => path.startsWith('accounts/'));

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

  it('passes a native transaction hash through in both encodings', () => {
    expect(toMirrorTxId(NATIVE_HASH)).toBe(NATIVE_HASH);
    expect(toMirrorTxId(BASE64_HASH)).toBe(BASE64_HASH);
  });

  it('rejects anything that is not a transaction id or a native hash', () => {
    expect(toMirrorTxId('0xdeadbeef')).toBeUndefined();
    expect(toMirrorTxId(ETHEREUM_HASH)).toBeUndefined();
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

  it('ignores fee and reward debits when attributing the sender', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [...nativeEntry.transfers, { account: '0.0.800', amount: -12345 }]
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

  it('refuses a raw amount that JSON parsing rounded even when a reward nets it back into range', async () => {
    const entry = {
      ...nativeEntry,
      transfers: [
        { account: PAYER, amount: -9007199254740993 },
        { account: RECIPIENT, amount: 9007199254740993 }
      ],
      staking_reward_transfers: [{ account: RECIPIENT, amount: 9007199254740000 }]
    };

    await expect(mockedNetwork(withEntries(entry)).getTxData(TX_ID, '0x0', RECIPIENT))
      .rejects.toThrow(/exceeds safe integer range/);
  });

  it('picks the successful submission when the id was submitted twice', async () => {
    const duplicate = { ...nativeEntry, result: 'DUPLICATE_TRANSACTION', transfers: [] };

    const tx = await mockedNetwork(withEntries(duplicate, nativeEntry)).getTxData(TX_ID, '0x0', RECIPIENT);
    expect(tx?.amount).toBe(2588995597n);
  });

  it('reads the settlement from the scheduled sibling of the schedule create', async () => {
    const scheduleCreate = {
      ...nativeEntry,
      transfers: [
        { account: '0.0.802', amount: 144403 },
        { account: PAYER, amount: -144403 }
      ]
    };

    const executed = {
      ...nativeEntry,
      consensus_timestamp: '1785742061.184710419',
      scheduled: true,
      transfers: [
        { account: RECIPIENT, amount: 2588995597 },
        { account: PAYER, amount: -2588995597 }
      ]
    };

    const tx = await mockedNetwork(withEntries(scheduleCreate, executed)).getTxData(TX_ID, '0x0', RECIPIENT);

    expect(tx).toEqual({
      from: PAYER,
      to: RECIPIENT,
      token: '0x0',
      amount: 2588995597n,
      confirmed: true,
      timestamp: 1785742061
    });
  });

  it('prefers the payer entry over a scheduled sibling that credits as well', async () => {
    const scheduled = {
      ...nativeEntry,
      consensus_timestamp: '1785742061.184710419',
      scheduled: true,
      transfers: [
        { account: RECIPIENT, amount: 777 },
        { account: PAYER, amount: -777 }
      ]
    };

    const tx = await mockedNetwork(withEntries(scheduled, nativeEntry)).getTxData(TX_ID, '0x0', RECIPIENT);

    expect(tx?.amount).toBe(2588995597n);
    expect(tx?.timestamp).toBe(1785741962);
  });

  it('returns nothing when the response carries no top-level entry', async () => {
    const child = { ...nativeEntry, nonce: 1, transfers: [{ account: RECIPIENT, amount: 999 }] };

    expect(await mockedNetwork(withEntries(child)).getTxData(TX_ID, '0x0', RECIPIENT)).toBeUndefined();
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

  it('returns nothing for an unknown transaction, a malformed id or an NFT', async () => {
    expect(await mockedNetwork({}).getTxData(TX_ID, '0x0', RECIPIENT)).toBeUndefined();
    expect(await mockedNetwork(withEntries(nativeEntry)).getTxData('0xdeadbeef', '0x0', RECIPIENT)).toBeUndefined();
    expect(await mockedNetwork(withEntries(nativeEntry)).getTxData(TX_ID, TOKEN, RECIPIENT, 1n)).toBeUndefined();
  });
});

describe('getTxData by transaction hash', () => {
  it('looks up a native hash directly, in both encodings', async () => {
    const hex = mockedNetwork(withEntriesAt(NATIVE_HASH, nativeEntry));
    const base64 = mockedNetwork(withEntriesAt(BASE64_HASH, nativeEntry));

    expect((await hex.getTxData(NATIVE_HASH, '0x0', RECIPIENT))?.amount).toBe(2588995597n);
    expect((await base64.getTxData(BASE64_HASH, '0x0', RECIPIENT))?.amount).toBe(2588995597n);
  });

  it('resolves an Ethereum hash through its contract result', async () => {
    const network = mockedNetwork({
      [`contracts/results/${ETHEREUM_HASH}`]: { transaction_id: TX_ID },
      ...withEntries(tokenEntry)
    });

    expect((await network.getTxData(ETHEREUM_HASH, TOKEN, RECIPIENT))?.amount).toBe(21397915n);
  });

  it('returns nothing while the contract result is not indexed yet', async () => {
    const network = mockedNetwork(withEntries(nativeEntry));

    expect(await network.getTxData(ETHEREUM_HASH, '0x0', RECIPIENT)).toBeUndefined();
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

  it('reads token transfers a contract call recorded on a child entry', async () => {
    const parent = { ...tokenEntry, token_transfers: [] };

    const approval = {
      ...tokenEntry,
      consensus_timestamp: '1785741962.184710420',
      nonce: 1,
      transfers: [],
      token_transfers: [
        { token_id: '0.0.2340890', account: RECIPIENT, amount: 500 },
        { token_id: '0.0.2340890', account: OTHER, amount: -500 }
      ]
    };

    const settlement = {
      ...tokenEntry,
      consensus_timestamp: '1785741962.184710421',
      nonce: 2,
      transfers: [],
      token_transfers: [
        { token_id: TOKEN, account: RECIPIENT, amount: 21397915 },
        { token_id: TOKEN, account: OTHER, amount: -21397915 }
      ]
    };

    const tx = await mockedNetwork(withEntries(parent, settlement, approval)).getTxData(TX_ID, TOKEN, RECIPIENT);

    expect(tx).toEqual({
      from: OTHER,
      to: RECIPIENT,
      token: TOKEN,
      amount: 21397915n,
      confirmed: true,
      timestamp: 1785741962
    });
  });

  it('zeroes a transaction that moves another token only', async () => {
    const tx = await mockedNetwork(withEntries(tokenEntry)).getTxData(TX_ID, '0.0.9999', RECIPIENT);

    expect(tx).toEqual({ from: '', to: '', token: '', amount: 0n, confirmed: true, timestamp: 1785741962 });
  });
});

describe('getTxData with EVM alias addresses', () => {
  it('matches the credit by the account id the recipient alias resolves to', async () => {
    const network = mockedNetwork({ ...withEntries(nativeEntry), ...withAlias(RECIPIENT_ALIAS, RECIPIENT) });

    expect(await network.getTxData(TX_ID, '0x0', RECIPIENT_ALIAS)).toEqual({
      from: PAYER,
      to: RECIPIENT_ALIAS,
      token: '0x0',
      amount: 2588995597n,
      confirmed: true,
      timestamp: 1785741962
    });
  });

  it('matches an HTS credit by the resolved account id', async () => {
    const network = mockedNetwork({ ...withEntries(tokenEntry), ...withAlias(RECIPIENT_ALIAS, RECIPIENT) });
    const tx = await network.getTxData(TX_ID, TOKEN, RECIPIENT_ALIAS);

    expect(tx?.amount).toBe(21397915n);
    expect(tx?.to).toBe(RECIPIENT_ALIAS);
  });

  it('returns nothing while the mirror node does not know the recipient alias', async () => {
    expect(await mockedNetwork(withEntries(nativeEntry)).getTxData(TX_ID, '0x0', RECIPIENT_ALIAS)).toBeUndefined();
  });

  it('zeroes a transaction that credits another account than the alias', async () => {
    const network = mockedNetwork({ ...withEntries(nativeEntry), ...withAlias(RECIPIENT_ALIAS, OTHER) });

    expect(await network.getTxData(TX_ID, '0x0', RECIPIENT_ALIAS)).toEqual({
      from: '',
      to: '',
      token: '',
      amount: 0n,
      confirmed: true,
      timestamp: 1785741962
    });
  });

  it('echoes the alias form of the declared payer back as the sender', async () => {
    const network = mockedNetwork({ ...withEntries(nativeEntry), ...withAlias(PAYER_ALIAS, PAYER) });

    expect((await network.getTxData(TX_ID, '0x0', RECIPIENT, undefined, PAYER_ALIAS))?.from).toBe(PAYER_ALIAS);
  });

  it('keeps the native sender when the declared payer resolves to another account', async () => {
    const other = mockedNetwork({ ...withEntries(nativeEntry), ...withAlias(PAYER_ALIAS, OTHER) });
    expect((await other.getTxData(TX_ID, '0x0', RECIPIENT, undefined, PAYER_ALIAS))?.from).toBe(PAYER);
  });

  it('keeps the native sender when the declared payer alias has no account', async () => {
    const unknown = mockedNetwork(withEntries(nativeEntry));
    expect((await unknown.getTxData(TX_ID, '0x0', RECIPIENT, undefined, PAYER_ALIAS))?.from).toBe(PAYER);
  });

  it('still refuses to attribute an ambiguous sender to the declared payer', async () => {
    const entry = { ...nativeEntry, transfers: [...nativeEntry.transfers, { account: OTHER, amount: -100 }] };
    const network = mockedNetwork({ ...withEntries(entry), ...withAlias(PAYER_ALIAS, PAYER) });

    expect((await network.getTxData(TX_ID, '0x0', RECIPIENT, undefined, PAYER_ALIAS))?.from).toBe('');
  });

  it('does not ask the mirror node about addresses that are already native ids', async () => {
    const network = mockedNetwork(withEntries(nativeEntry));

    expect((await network.getTxData(TX_ID, '0x0', RECIPIENT, undefined, PAYER))?.from).toBe(PAYER);
    expect(accountLookups(network)).toHaveLength(0);
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

  it('rejects an address that is neither a native id nor an EVM alias', async () => {
    const network = mockedNetwork(account({ _type: 'ECDSA_SECP256K1', key: compressed }));

    expect(await attestationKeyMatchesAddress(network, publicKey, `0.1.${PAYER.split('.')[2]}`)).toBe(false);
    expect(await attestationKeyMatchesAddress(network, publicKey, wallet.address.slice(0, -2))).toBe(false);
  });

  it('binds a key to its own EVM alias without asking the mirror node', async () => {
    const network = mockedNetwork({});

    expect(await attestationKeyMatchesAddress(network, publicKey, wallet.address)).toBe(true);
    expect(await attestationKeyMatchesAddress(network, publicKey, wallet.address.toLowerCase())).toBe(true);
    expect(accountLookups(network)).toHaveLength(0);
  });

  it('rejects the EVM alias of another key', async () => {
    expect(await attestationKeyMatchesAddress(mockedNetwork({}), publicKey, PAYER_ALIAS)).toBe(false);
  });

  it('falls back to the mirror key for an alias the key does not derive', async () => {
    const network = mockedNetwork({
      [`accounts/${PAYER_ALIAS.toLowerCase()}?limit=1`]: { account: PAYER, key: { _type: 'ECDSA_SECP256K1', key: compressed } }
    });

    expect(await attestationKeyMatchesAddress(network, publicKey, PAYER_ALIAS)).toBe(true);
  });

  it('rejects an account that does not exist without retrying', async () => {
    const network = mockedNetwork({});

    expect(await attestationKeyMatchesAddress(network, publicKey, PAYER)).toBe(false);
    expect(accountLookups(network)).toHaveLength(1);
  });

  it('retries a rate-limited account lookup before answering', async () => {
    const network = new HbarNetwork(MIRROR_URL);
    const apiGet = vi.spyOn(network as any, 'apiGet')
      .mockRejectedValueOnce(new Error('HBAR mirror node error 429: too many requests'))
      .mockResolvedValue({ account: PAYER, key: { _type: 'ECDSA_SECP256K1', key: compressed } });

    expect(await attestationKeyMatchesAddress(network, publicKey, PAYER)).toBe(true);
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('propagates a transient mirror node failure instead of reporting an unbound key', async () => {
    const network = new HbarNetwork(MIRROR_URL);
    const apiGet = vi.spyOn(network as any, 'apiGet').mockRejectedValue(new Error('HBAR mirror node error 503'));

    await expect(attestationKeyMatchesAddress(network, publicKey, PAYER)).rejects.toThrow(/503/);
    expect(apiGet).toHaveBeenCalledTimes(3);
  });
});
