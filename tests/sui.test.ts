import { afterEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { ethers } from 'ethers';
import { GrpcTypes, RpcError } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { isCanonicalSuiDigest, SuiNetwork } from '../src/networks/sui.js';
import { configureProxy } from '../src/proxy.js';
import {
  allowedSettlementMethods,
  AttestationMessageParams,
  buildAttestationPreimage,
  encodePayerSignatureProof,
  encodeSuiPersonalMessageProof,
  SettlementMethod,
  verifySettlementProof
} from '../src/attestation.js';

const { Input_InputKind, FundsWithdrawal_Source, TransactionKind_Kind } = GrpcTypes;

const payerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
const otherKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9));

const PAYER = payerKey.toSuiAddress();
const RECIPIENT = normalizeSuiAddress('0xb0b');
const SPONSOR = normalizeSuiAddress('0x5905');
const OTHER = normalizeSuiAddress('0xa11ce');

const SUI = '0x2::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

const DIGEST = bs58.encode(new Uint8Array(32).fill(3));

const MAINNET = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

const GAS = { computationCost: 750n, storageCost: 2000n, storageRebate: 978n, nonRefundableStorageFee: 10n };
const GAS_NET = 1772n;

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

const pure = { kind: Input_InputKind.PURE, pure: new Uint8Array(8) };
const owned = { kind: Input_InputKind.IMMUTABLE_OR_OWNED, objectId: normalizeSuiAddress('0xc01') };
const withdrawal = (source = FundsWithdrawal_Source.SENDER) => ({ kind: Input_InputKind.FUNDS_WITHDRAWAL, fundsWithdrawal: { amount: 5n, coinType: USDC, source } });

const moveCall = (target: string) => {
  const [pkg, module, fn] = target.split('::');
  return { command: { oneofKind: 'moveCall', moveCall: { package: pkg, module, function: fn, typeArguments: [], arguments: [] } } };
};

const splitAndTransfer = [
  { command: { oneofKind: 'splitCoins', splitCoins: { amounts: [] } } },
  { command: { oneofKind: 'transferObjects', transferObjects: { objects: [] } } }
];

const ptb = (commands: any[] = splitAndTransfer, inputs: any[] = [pure, owned]) => ({
  kind: TransactionKind_Kind.PROGRAMMABLE_TRANSACTION,
  data: { oneofKind: 'programmableTransaction', programmableTransaction: { inputs, commands } }
});

interface TxShape {
  sender?: string;
  gasOwner?: string;
  success?: boolean;
  checkpoint?: bigint | undefined;
  kind?: any;
  changes: [address: string, coinType: string, amount: bigint][];
}

const executed = ({ sender = PAYER, gasOwner = sender, success = true, checkpoint = 1000n, kind = ptb(), changes }: TxShape) => ({
  digest: DIGEST,
  transaction: { sender, gasPayment: { objects: [], owner: gasOwner }, kind },
  effects: { status: { success, error: success ? undefined : { description: 'InsufficientCoinBalance' } }, gasUsed: GAS },
  checkpoint,
  timestamp: { seconds: 1785741962n, nanos: 184000000 },
  balanceChanges: changes.map(([address, coinType, amount]) => ({ address, coinType, amount: amount.toString() })),
  signatures: []
});

function mockedNetwork(transaction: any) {
  const getTransaction = vi.fn(async () => {
    if (transaction instanceof Error) {
      throw transaction;
    }

    return { response: { transaction } };
  });

  const client = {
    ledgerService: { getTransaction, getServiceInfo: vi.fn(async () => ({ response: { chainId: MAINNET } })) },
    stateService: { getCoinInfo: vi.fn(async () => ({ response: { metadata: { decimals: 6 } } })) }
  };

  const network = new SuiNetwork('http://localhost:9000/sui');
  (network as any).grpcClient = client;

  return { network, getTransaction };
}

const nativeTransfer = (amount: bigint) => executed({
  changes: [[PAYER, SUI, -(amount + GAS_NET)], [RECIPIENT, SUI, amount]]
});

describe('isCanonicalSuiDigest', () => {
  it('accepts a base58 32-byte digest', () => {
    expect(isCanonicalSuiDigest(DIGEST)).toBe(true);
  });

  it('rejects other spellings and lengths', () => {
    expect(isCanonicalSuiDigest(`1${DIGEST}`)).toBe(false);
    expect(isCanonicalSuiDigest(bs58.encode(new Uint8Array(31).fill(3)))).toBe(false);
    expect(isCanonicalSuiDigest(`0x${'03'.repeat(32)}`)).toBe(false);
    expect(isCanonicalSuiDigest('')).toBe(false);
  });
});

describe('getTxData native SUI', () => {
  it('reads the recipient credit of a plain transfer, net of gas', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));

    expect(await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER)).toEqual({
      from: PAYER,
      to: RECIPIENT,
      token: '0x0',
      amount: 1000n,
      confirmed: true,
      timestamp: 1785741962,
      txId: DIGEST
    });
  });

  it('credits a sponsored transfer whose gas the sponsor paid', async () => {
    const { network } = mockedNetwork(executed({
      gasOwner: SPONSOR,
      changes: [[SPONSOR, SUI, -GAS_NET], [PAYER, SUI, -1000n], [RECIPIENT, SUI, 1000n]]
    }));

    expect((await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER))?.amount).toBe(1000n);
  });

  it('does not credit the sponsor funding the recipient beyond gas', async () => {
    const { network } = mockedNetwork(executed({
      gasOwner: SPONSOR,
      changes: [[SPONSOR, SUI, -(GAS_NET + 1000n)], [RECIPIENT, SUI, 1000n]]
    }));

    expect((await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER))?.amount).toBe(0n);
  });

  it('counts only the payer share when another address funds the recipient too', async () => {
    const { network } = mockedNetwork(executed({
      changes: [[PAYER, SUI, -(1000n + GAS_NET)], [OTHER, SUI, -100n], [RECIPIENT, SUI, 1100n]]
    }));

    expect((await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER))?.amount).toBe(1000n);
  });

  it('accepts upper-case order addresses and rejects the short form', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));
    const upper = (address: string) => `0x${address.slice(2).toUpperCase()}`;

    const tx = await network.getTxData(DIGEST, '0x0', upper(RECIPIENT), undefined, upper(PAYER));

    expect(tx?.amount).toBe(1000n);
    expect(tx?.to).toBe(upper(RECIPIENT));
    expect((await network.getTxData(DIGEST, '0x0', '0xb0b', undefined, PAYER))?.amount).toBe(0n);
  });

  it('rejects a transfer sent by another address', async () => {
    const { network } = mockedNetwork(executed({
      sender: OTHER,
      changes: [[OTHER, SUI, -(1000n + GAS_NET)], [RECIPIENT, SUI, 1000n]]
    }));

    expect(await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER)).toEqual({ from: '', to: '', token: '', amount: 0n, confirmed: true, timestamp: 1785741962 });
  });

  it('rejects an invalid payer address', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));
    expect((await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, 'not-an-address'))?.amount).toBe(0n);
  });

  it('pays nothing to another recipient', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));
    expect((await network.getTxData(DIGEST, '0x0', OTHER, undefined, PAYER))?.amount).toBe(0n);
  });

  it('marks a failed transaction as definitively unpaid', async () => {
    const { network } = mockedNetwork(executed({ success: false, changes: [[PAYER, SUI, -GAS_NET]] }));
    expect(await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER)).toEqual({ from: '', to: '', token: '', amount: 0n, confirmed: true, timestamp: 1785741962 });
  });

  it('waits for a transaction that is not checkpointed yet', async () => {
    const { network } = mockedNetwork(executed({ checkpoint: undefined, changes: [] }));
    expect(await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER)).toBeUndefined();
  });

  it('waits for a transaction the node does not know', async () => {
    const { network } = mockedNetwork(new RpcError('not found', 'NOT_FOUND'));
    expect(await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER)).toBeUndefined();
  });

  it('rethrows node errors other than not-found', async () => {
    const { network } = mockedNetwork(new RpcError('unavailable', 'UNAVAILABLE'));
    await expect(network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER)).rejects.toThrow('unavailable');
  });

  it('rejects a non-canonical digest without querying it', async () => {
    const { network, getTransaction } = mockedNetwork(nativeTransfer(1000n));

    expect((await network.getTxData(`1${DIGEST}`, '0x0', RECIPIENT, undefined, PAYER))?.amount).toBe(0n);
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('adds gas back for the struct-tag spelling of native SUI', async () => {
    const { network } = mockedNetwork(executed({
      gasOwner: SPONSOR,
      changes: [[SPONSOR, SUI, -GAS_NET], [PAYER, SUI, -1000n], [RECIPIENT, SUI, 1000n]]
    }));

    expect((await network.getTxData(DIGEST, SUI, RECIPIENT, undefined, PAYER))?.amount).toBe(1000n);
  });

  it('rejects NFTs', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));
    expect(await network.getTxData(DIGEST, '0x0', RECIPIENT, 1n, PAYER)).toBeUndefined();
  });
});

describe('getTxData plain-transfer guard', () => {
  const amountFor = async (kind: any) => {
    const { network } = mockedNetwork(executed({ kind, changes: [[PAYER, SUI, -(1000n + GAS_NET)], [RECIPIENT, SUI, 1000n]] }));
    return (await network.getTxData(DIGEST, '0x0', RECIPIENT, undefined, PAYER))?.amount;
  };

  it('accepts the framework transfer calls wallets and custody emit', async () => {
    expect(await amountFor(ptb([moveCall('0x2::coin::redeem_funds'), moveCall('0x2::coin::send_funds'), ...splitAndTransfer], [pure, withdrawal()]))).toBe(1000n);
    expect(await amountFor(ptb([moveCall('0x0000000000000000000000000000000000000000000000000000000000000002::balance::redeem_funds'), moveCall('0x2::coin::from_balance')]))).toBe(1000n);
    expect(await amountFor(ptb([moveCall('0x2::funds_accumulator::withdrawal_split'), moveCall('0x2::balance::redeem_funds'), moveCall('0x2::balance::split'), moveCall('0x2::balance::send_funds')], [pure, withdrawal()]))).toBe(1000n);
    expect(await amountFor(ptb([moveCall('0x2::pay::split_and_transfer'), moveCall('0x2::pay::join_vec'), moveCall('0x2::transfer::public_transfer')]))).toBe(1000n);
  });

  it('rejects a mint or burn through the framework', async () => {
    expect(await amountFor(ptb([moveCall('0x2::coin::mint'), ...splitAndTransfer]))).toBe(0n);
    expect(await amountFor(ptb([moveCall('0x2::coin::burn'), ...splitAndTransfer]))).toBe(0n);
  });

  it('rejects a call into any other package', async () => {
    expect(await amountFor(ptb([moveCall('0xdee9::pool::swap_exact_base_for_quote'), ...splitAndTransfer]))).toBe(0n);
    expect(await amountFor(ptb([moveCall('0x3::sui_system::request_add_stake')]))).toBe(0n);
  });

  it('rejects publish, upgrade and vector commands', async () => {
    expect(await amountFor(ptb([{ command: { oneofKind: 'publish', publish: { modules: [], dependencies: [] } } }]))).toBe(0n);
    expect(await amountFor(ptb([{ command: { oneofKind: 'makeMoveVector', makeMoveVector: { elements: [] } } }]))).toBe(0n);
  });

  it('rejects shared, receiving and foreign-funded inputs', async () => {
    expect(await amountFor(ptb(splitAndTransfer, [{ kind: Input_InputKind.SHARED, objectId: normalizeSuiAddress('0x6') }]))).toBe(0n);
    expect(await amountFor(ptb(splitAndTransfer, [{ kind: Input_InputKind.RECEIVING, objectId: normalizeSuiAddress('0xc02') }]))).toBe(0n);
    expect(await amountFor(ptb(splitAndTransfer, [withdrawal(FundsWithdrawal_Source.SPONSOR)]))).toBe(0n);
    expect(await amountFor(ptb(splitAndTransfer, [withdrawal(FundsWithdrawal_Source.SENDER_ALLOWANCE)]))).toBe(0n);
  });

  it('rejects system transactions', async () => {
    expect(await amountFor({ kind: TransactionKind_Kind.PROGRAMMABLE_SYSTEM_TRANSACTION, data: ptb().data })).toBe(0n);
    expect(await amountFor({ kind: TransactionKind_Kind.CHANGE_EPOCH, data: { oneofKind: 'changeEpoch', changeEpoch: {} } })).toBe(0n);
  });
});

describe('getTxData coins', () => {
  it('credits an address-balance USDC transfer and ignores other coins', async () => {
    const { network } = mockedNetwork(executed({
      kind: ptb([moveCall('0x2::coin::redeem_funds'), moveCall('0x2::coin::send_funds')], [pure, withdrawal()]),
      changes: [[PAYER, SUI, -GAS_NET], [PAYER, USDC, -5000000n], [RECIPIENT, USDC, 5000000n], [RECIPIENT, SUI, 7n]]
    }));

    const tx = await network.getTxData(DIGEST, USDC, RECIPIENT, undefined, PAYER);

    expect(tx?.amount).toBe(5000000n);
    expect(tx?.token).toBe(USDC);
  });

  it('pays nothing in a coin the payer did not send', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));
    expect((await network.getTxData(DIGEST, USDC, RECIPIENT, undefined, PAYER))?.amount).toBe(0n);
  });

  it('does not credit a supply increase as the payer payment', async () => {
    const { network } = mockedNetwork(executed({ changes: [[PAYER, SUI, -GAS_NET], [RECIPIENT, USDC, 5000000n]] }));
    expect((await network.getTxData(DIGEST, USDC, RECIPIENT, undefined, PAYER))?.amount).toBe(0n);
  });

  it('rejects a malformed coin type', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));
    expect((await network.getTxData(DIGEST, 'usdc', RECIPIENT, undefined, PAYER))?.amount).toBe(0n);
  });

  it('reads decimals from the coin registry', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));

    expect(await network.getDecimals('0x0')).toBe(9);
    expect(await network.getDecimals(USDC)).toBe(6);
  });
});

describe('node connection', () => {
  afterEach(() => configureProxy(undefined));

  const transportOptions = (network: SuiNetwork) => (network as any).client.ledgerService._transport.defaultOptions;

  it('accepts a node serving mainnet and rejects another chain', async () => {
    const { network } = mockedNetwork(nativeTransfer(1000n));

    await expect(network.ping()).resolves.toBeUndefined();

    (network as any).grpcClient.ledgerService.getServiceInfo = async () => ({ response: { chainId: 'testnet' } });

    await expect(network.ping()).rejects.toThrow('expected');
  });

  it('routes the gateway chain by header and connects directly without a proxy', () => {
    const options = transportOptions(new SuiNetwork('http://gateway.local/sui'));

    expect(options.host).toBe('gateway.local:80');
    expect(options.meta).toEqual({ 'x-chain': 'sui' });
    expect(options.clientOptions).toEqual({});
  });

  it('tunnels through the configured proxy', () => {
    configureProxy('http://oracle:p%40ss@proxy.local:3128');

    const options = transportOptions(new SuiNetwork('https://fullnode.example.org'));

    expect(options.host).toBe('proxy.local:3128');
    expect(options.meta).toEqual({});
    expect(options.clientOptions).toEqual({
      'grpc.enable_http_proxy': 0,
      'grpc.http_connect_target': 'dns:///fullnode.example.org:443',
      'grpc.default_authority': 'fullnode.example.org:443',
      'grpc.ssl_target_name_override': 'fullnode.example.org',
      'grpc.http_connect_creds': 'oracle:p@ss'
    });
  });

  it('skips the proxy for a non-proxy host', () => {
    configureProxy('http://proxy.local:3128', ['gateway.local']);

    expect(transportOptions(new SuiNetwork('http://gateway.local/sui')).host).toBe('gateway.local:80');
  });
});

describe('Sui payer signatures', () => {
  const { network } = mockedNetwork(nativeTransfer(1000n));
  const publicKey = ethers.hexlify(payerKey.getPublicKey().toRawBytes());
  const preimage = buildAttestationPreimage(params);

  const verify = (method: number, proof: string, from = PAYER, networkId = 'SUI', p = params) =>
    verifySettlementProof(network, networkId, { method, proof, mintContext: { logFromWasZero: false } }, p, from);

  it('derives the Sui address of an ed25519 key', () => {
    expect(network.addressFromPublicKey(publicKey)).toBe(PAYER);
    expect(network.matchesAddress(publicKey, `0x${PAYER.slice(2).toUpperCase()}`)).toBe(true);
    expect(network.matchesAddress(publicKey, otherKey.toSuiAddress())).toBe(false);
    expect(network.matchesAddress(publicKey, 'not-an-address')).toBe(false);
    expect(network.matchesAddress('0x1234', PAYER)).toBe(false);
  });

  it('allows the raw and the personal-message methods on SUI only', () => {
    expect(allowedSettlementMethods('SUI')).toEqual([SettlementMethod.PayerSignature, SettlementMethod.PayerSignatureSuiPersonalMessage]);
    expect(allowedSettlementMethods('SOL')).not.toContain(SettlementMethod.PayerSignatureSuiPersonalMessage);
  });

  it('verifies a raw ed25519 signature over the preimage (method 1)', async () => {
    const signature = ethers.hexlify(await payerKey.sign(preimage));

    expect((await verify(SettlementMethod.PayerSignature, encodePayerSignatureProof(publicKey, signature))).valid).toBe(true);
    expect((await verify(SettlementMethod.PayerSignature, encodePayerSignatureProof(publicKey, signature), OTHER)).valid).toBe(false);
  });

  it('verifies a wallet personal-message signature (method 4)', async () => {
    const { signature } = await payerKey.signPersonalMessage(preimage);
    const proof = encodeSuiPersonalMessageProof(signature);

    expect(await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, proof)).toEqual({ present: true, methodAllowed: true, valid: true, sigBound: true, sigValid: true });
    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, proof, OTHER)).valid).toBe(false);
    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, proof, PAYER, 'SUI', { ...params, leg: 'solver' })).valid).toBe(false);
    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, proof, PAYER, 'SOL')).methodAllowed).toBe(false);
  });

  it('keeps the two methods apart', async () => {
    const { signature } = await payerKey.signPersonalMessage(preimage);
    const serialized = ethers.decodeBase64(signature);
    const asRaw = encodePayerSignatureProof(publicKey, ethers.hexlify(serialized.slice(1, 65)));

    expect((await verify(SettlementMethod.PayerSignature, asRaw)).valid).toBe(false);

    const raw = await payerKey.sign(preimage);
    const asPersonal = ethers.hexlify(ethers.concat([new Uint8Array([0]), raw, payerKey.getPublicKey().toRawBytes()]));

    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, asPersonal)).valid).toBe(false);
  });

  it('rejects a personal-message proof from a non-ed25519 or malformed signature', async () => {
    const { signature } = await payerKey.signPersonalMessage(preimage);
    const serialized = ethers.decodeBase64(signature);

    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, ethers.hexlify(ethers.concat([new Uint8Array([1]), serialized.slice(1)])))).valid).toBe(false);
    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, ethers.hexlify(serialized.slice(0, 96)))).valid).toBe(false);
    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, '0x')).valid).toBe(false);
    expect((await verify(SettlementMethod.PayerSignatureSuiPersonalMessage, 'not-hex')).valid).toBe(false);
  });

  it('rejects a personal-message proof for a mint', async () => {
    const { signature } = await payerKey.signPersonalMessage(preimage);

    const v = await verifySettlementProof(network, 'SUI', {
      method: SettlementMethod.PayerSignatureSuiPersonalMessage,
      proof: encodeSuiPersonalMessageProof(signature),
      mintContext: { logFromWasZero: true }
    }, params, PAYER);

    expect(v.valid).toBe(false);
  });
});
