import { ChannelCredentials } from '@grpc/grpc-js';
import { GrpcStatusCode, GrpcTypes, RpcError, SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress, SUI_TYPE_ARG } from '@mysten/sui/utils';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import bs58 from 'bs58';
import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifyEd25519 } from '../attestation.js';
import { addDelta, chargeMint, log, memoize, provableContribution, settlement, unpaid } from '../utils.js';
import { getProxyAgentForUrl } from '../proxy.js';

const SUI_MAINNET_CHAIN_ID = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

const SUI_FRAMEWORK = normalizeSuiAddress('0x2');

const SUI_COIN_TYPE = normalizeStructTag(SUI_TYPE_ARG);

const TRANSFER_CALLS = new Set([
  'coin::send_funds',
  'coin::redeem_funds',
  'coin::zero',
  'coin::destroy_zero',
  'coin::into_balance',
  'coin::from_balance',
  'balance::send_funds',
  'balance::redeem_funds',
  'balance::zero',
  'balance::destroy_zero',
  'balance::split',
  'balance::join',
  'coin::put',
  'funds_accumulator::withdrawal_split',
  'pay::split',
  'pay::split_vec',
  'pay::split_and_transfer',
  'pay::join',
  'pay::join_vec',
  'transfer::public_transfer',
]);

const TX_READ_MASK = [
  'digest',
  'transaction.sender',
  'transaction.gas_payment.owner',
  'transaction.kind',
  'effects.status',
  'effects.gas_used',
  'checkpoint',
  'timestamp',
  'balance_changes',
];

const REQUEST_TIMEOUT_MS = 30_000;

export function isCanonicalSuiDigest(digest: string): boolean {
  const bytes = bs58.decodeUnsafe(digest);
  return bytes?.length === 32 && bs58.encode(bytes) === digest;
}

function normalizedAddress(address: string): string | undefined {
  return isValidSuiAddress(address) ? normalizeSuiAddress(address) : undefined;
}

function normalizedCoinType(tokenAddress: string): string | undefined {
  try {
    return normalizeStructTag(tokenAddress === '0x0' ? SUI_TYPE_ARG : tokenAddress);
  } catch {
    return undefined;
  }
}

function disallowedPart(kind: GrpcTypes.TransactionKind | undefined): string | undefined {
  if (kind?.kind !== GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION || kind.data.oneofKind !== 'programmableTransaction') {
    return `transaction kind ${kind?.kind}`;
  }

  const { inputs, commands } = kind.data.programmableTransaction;

  const input = inputs.find(input => !(
    input.kind === GrpcTypes.Input_InputKind.PURE ||
    input.kind === GrpcTypes.Input_InputKind.IMMUTABLE_OR_OWNED ||
    (input.kind === GrpcTypes.Input_InputKind.FUNDS_WITHDRAWAL && input.fundsWithdrawal?.source === GrpcTypes.FundsWithdrawal_Source.SENDER)
  ));

  if (input) {
    return `input kind ${input.kind}`;
  }

  for (const { command } of commands) {
    switch (command.oneofKind) {
      case 'splitCoins':
      case 'mergeCoins':
      case 'transferObjects':
        continue;
      case 'moveCall': {
        const { package: pkg, module, function: fn } = command.moveCall;

        if (pkg && normalizeSuiAddress(pkg) === SUI_FRAMEWORK && TRANSFER_CALLS.has(`${module}::${fn}`)) {
          continue;
        }

        return `call ${pkg}::${module}::${fn}`;
      }
      default:
        return `command ${command.oneofKind}`;
    }
  }

  return undefined;
}

export class SuiNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private grpcClient?: SuiGrpcClient;
  private readonly nativeAssetDecimals: number = 9;
  readonly retryDelay: number = 5000;
  readonly signatureScheme = SignatureScheme.Ed25519;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  private get client(): SuiGrpcClient {
    if (this.grpcClient) {
      return this.grpcClient;
    }

    const url = new URL(this.rpcUrl);
    const tls = url.protocol === 'https:';
    const target = `${url.hostname}:${url.port || (tls ? 443 : 80)}`;
    const chain = url.pathname.replace(/^\/+|\/+$/g, '');
    const proxy = getProxyAgentForUrl(this.rpcUrl)?.proxy;

    const tunnel = proxy ? {
      'grpc.enable_http_proxy': 0,
      'grpc.http_connect_target': `dns:///${target}`,
      'grpc.default_authority': target,
      'grpc.ssl_target_name_override': url.hostname,
      ...(proxy.username ? { 'grpc.http_connect_creds': `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` } : {}),
    } : {};

    this.grpcClient = new SuiGrpcClient({
      network: 'mainnet',
      transport: new GrpcTransport({
        host: proxy ? `${proxy.hostname}:${proxy.port || (proxy.protocol === 'https:' ? 443 : 80)}` : target,
        channelCredentials: tls ? ChannelCredentials.createSsl() : ChannelCredentials.createInsecure(),
        clientOptions: tunnel,
        meta: chain ? { 'x-chain': chain } : {},
        timeout: REQUEST_TIMEOUT_MS,
      }),
    });

    return this.grpcClient;
  }

  async ping(): Promise<void> {
    const { response } = await this.client.ledgerService.getServiceInfo({});

    if (response.chainId !== SUI_MAINNET_CHAIN_ID) {
      throw new Error(`Sui node serves chain ${response.chainId}, expected ${SUI_MAINNET_CHAIN_ID}`);
    }
  }

  addressFromPublicKey(publicKey: string): string {
    const bytes = ethers.getBytes(publicKey);

    if (bytes.length !== 32) {
      throw new Error(`Invalid Sui ed25519 public key length: ${bytes.length} (expected 32)`);
    }

    return new Ed25519PublicKey(bytes).toSuiAddress();
  }

  matchesAddress(publicKey: string, address: string): boolean {
    const expected = normalizedAddress(address);

    try {
      return !!expected && this.addressFromPublicKey(publicKey) === expected;
    } catch {
      return false;
    }
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> {
    return verifyEd25519(publicKey, signature, preimage);
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === '0x0') {
      return this.nativeAssetDecimals;
    }

    const coinType = normalizedCoinType(tokenAddress);

    if (!coinType) {
      throw new Error(`Invalid Sui coin type: ${tokenAddress}`);
    }

    return memoize(`decimals-sui-${coinType}`, 86400 * 1000, async () => {
      const { response } = await this.client.stateService.getCoinInfo({ coinType });
      const decimals = response.metadata?.decimals;

      if (decimals === undefined) {
        throw new Error(`Failed to get decimals of Sui coin ${coinType}`);
      }

      return decimals;
    });
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string,
    tokenId: bigint | undefined,
    senderAddress: string
  ): Promise<TransactionData | undefined> {
    if (tokenId !== undefined) {
      log.warn(`Don't support NFTs for SUI network: ${txHash}`);
      return;
    }

    if (!isCanonicalSuiDigest(txHash)) {
      log.error(`Transaction ${txHash} is not a canonical Sui digest`);
      return unpaid(true, 0);
    }

    const tx = await this.fetchTransaction(txHash);

    if (!tx || tx.checkpoint === undefined || !tx.timestamp) {
      return;
    }

    const confirmed = true;
    const timestamp = Number(tx.timestamp.seconds);

    if (!tx.effects?.status?.success) {
      log.warn(`Transaction ${txHash} failed on blockchain: ${tx.effects?.status?.error?.description}`);
      return unpaid(confirmed, timestamp);
    }

    const sender = normalizedAddress(senderAddress);
    const recipient = normalizedAddress(recipientAddress);
    const coinType = normalizedCoinType(tokenAddress);

    if (!sender || !recipient || !coinType || !tx.transaction?.sender || normalizeSuiAddress(tx.transaction.sender) !== sender) {
      log.warn(`Transaction ${txHash} was not sent by ${senderAddress} to ${recipientAddress} in ${tokenAddress}`);
      return unpaid(confirmed, timestamp);
    }

    const disallowed = disallowedPart(tx.transaction.kind);

    if (disallowed) {
      log.warn(`Transaction ${txHash} is not a plain Sui transfer: ${disallowed}`);
      return unpaid(confirmed, timestamp);
    }

    const deltas = new Map<string, bigint>();

    for (const change of tx.balanceChanges) {
      if (change.address && change.coinType && change.amount && normalizedCoinType(change.coinType) === coinType) {
        addDelta(deltas, normalizeSuiAddress(change.address), BigInt(change.amount));
      }
    }

    const gas = tx.effects.gasUsed;

    if (coinType === SUI_COIN_TYPE && gas) {
      const gasOwner = normalizeSuiAddress(tx.transaction.gasPayment?.owner || tx.transaction.sender);
      addDelta(deltas, gasOwner, (gas.computationCost ?? 0n) + (gas.storageCost ?? 0n) - (gas.storageRebate ?? 0n));
    }

    chargeMint(deltas);

    const paid = provableContribution(deltas, new Set([sender]), recipient);

    return settlement(senderAddress, recipientAddress, tokenAddress, paid, confirmed, timestamp, { txId: tx.digest });
  }

  private async fetchTransaction(digest: string): Promise<GrpcTypes.ExecutedTransaction | undefined> {
    try {
      const { response } = await this.client.ledgerService.getTransaction({ digest, readMask: { paths: TX_READ_MASK } });
      return response.transaction;
    } catch (e) {
      if (e instanceof RpcError && e.code === GrpcStatusCode[GrpcStatusCode.NOT_FOUND]) {
        return;
      }

      throw e;
    }
  }

  async transfer(): Promise<string> {
    throw new Error('SuiNetwork does not support transfers');
  }
}
