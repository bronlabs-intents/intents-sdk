import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { addDelta, chargeMint, log, provableContribution, settlement, sleep, unpaid } from '../utils.js';
import { proxyFetch } from '../proxy.js';

interface HbarTransfer {
  account: string;
  amount: number;
}

interface HbarTokenTransfer extends HbarTransfer {
  token_id: string;
}

interface HbarTransaction {
  consensus_timestamp: string;
  transaction_id?: string;
  charged_tx_fee?: number;
  result: string;
  nonce: number;
  scheduled: boolean;
  transfers?: HbarTransfer[];
  token_transfers?: HbarTokenTransfer[];
  staking_reward_transfers?: HbarTransfer[];
}

const ENTITY_ID = /^0\.0\.\d+$/;
const EVM_ALIAS = /^0x[0-9a-fA-F]{40}$/;
const SDK_TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d{1,9})$/;
const MIRROR_TX_ID = /^(\d+\.\d+\.\d+)-(\d+)-(\d{1,9})$/;
const NATIVE_TX_HASH = /^0x[0-9a-fA-F]{96}$/;
const BASE64_TX_HASH = /^[A-Za-z0-9+/_-]{64}$/;
const ETHEREUM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const NETWORK_ACCOUNTS = ['0.0.98', '0.0.800', '0.0.801', '0.0.802'];

const RETRY_DELAYS = [300, 1000];

class MirrorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function toMirrorTxId(txId: string): string | undefined {
  const id = txId.trim();
  const match = SDK_TX_ID.exec(id) ?? MIRROR_TX_ID.exec(id);

  if (match) {
    return `${match[1]}-${match[2]}-${match[3].padStart(9, '0')}`;
  }

  return NATIVE_TX_HASH.test(id) || BASE64_TX_HASH.test(id) ? encodeURIComponent(id) : undefined;
}

const consensusSeconds = (tx: HbarTransaction): number => parseInt(tx.consensus_timestamp.split('.')[0], 10);

function safeAmount(amount: number): number {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`HBAR transfer amount exceeds safe integer range: ${amount}`);
  }

  return amount;
}

function nettedTransfers(tx: HbarTransaction): HbarTransfer[] {
  const rewards = new Map<string, number>((tx.staking_reward_transfers ?? []).map(r => [r.account, safeAmount(r.amount)]));

  return (tx.transfers ?? []).map(t => ({ ...t, amount: safeAmount(t.amount) - (rewards.get(t.account) ?? 0) }));
}

export class HbarNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly authHeaders: Record<string, string> = {};
  private readonly nativeAssetDecimals: number = 8;
  readonly retryDelay: number = 10000;
  readonly signatureScheme = SignatureScheme.Secp256k1;

  constructor(rpcUrl: string) {
    const [baseUrl, apiKey] = rpcUrl.split('@', 2);

    this.rpcUrl = baseUrl;

    if (apiKey) {
      this.authHeaders = { 'x-api-key': apiKey };
    }
  }

  addressFromPublicKey(publicKey: string): string {
    return ethers.computeAddress(publicKey).toLowerCase();
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  async matchesAddress(publicKey: string, address: string): Promise<boolean> {
    let compressed: string;

    try {
      compressed = ethers.SigningKey.computePublicKey(publicKey, true).slice(2).toLowerCase();
    } catch {
      return false;
    }

    if (EVM_ALIAS.test(address)) {
      if (this.addressFromPublicKey(publicKey) === address.toLowerCase()) {
        return true;
      }
    } else if (!ENTITY_ID.test(address)) {
      log.warn(`HBAR address ${address} is not a native account id or an EVM alias`);
      return false;
    }

    const account = await this.apiGetWithRetry(`accounts/${address.toLowerCase()}?limit=1`);

    if (!account) {
      log.warn(`HBAR account ${address} does not exist`);
      return false;
    }

    if (account.key?._type !== 'ECDSA_SECP256K1' || typeof account.key.key !== 'string') {
      log.warn(`HBAR account ${address} is not controlled by a single ECDSA key: ${account.key?._type}`);
      return false;
    }

    return account.key.key.replace(/^0x/, '').toLowerCase() === compressed;
  }

  async ping(): Promise<void> {
    if (!(await this.apiGet('blocks?limit=1'))?.blocks?.length) {
      throw new Error('HBAR mirror node returned no blocks');
    }
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    if (!ENTITY_ID.test(tokenAddress)) {
      throw new Error(`Invalid HBAR token id: ${tokenAddress}`);
    }

    const token = await this.apiGet(`tokens/${tokenAddress}`);
    const decimals = parseInt(token?.decimals, 10);

    if (isNaN(decimals)) {
      throw new Error(`Failed to get decimals of HBAR token ${tokenAddress}`);
    }

    return decimals;
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string,
    tokenId: bigint | undefined,
    senderAddress: string
  ): Promise<TransactionData | undefined> {
    if (tokenId !== undefined) {
      log.warn(`Don't support NFTs for HBAR network: ${txHash}`);
      return;
    }

    const mirrorTxId = toMirrorTxId(txHash) ?? await this.resolveEthereumHash(txHash);

    if (!mirrorTxId) {
      log.warn(`Transaction ${txHash} is not a known HBAR transaction id or hash`);
      return;
    }

    const result = await this.apiGet(`transactions/${mirrorTxId}`);

    if (!result) {
      return;
    }

    const entries: HbarTransaction[] = result.transactions ?? [];

    const topLevel = entries.filter(t => t.nonce === 0 && !t.scheduled);
    const primary = topLevel.find(t => t.result === 'SUCCESS') ?? topLevel[0];

    if (!primary) {
      log.warn(`Transaction ${txHash} has no top-level entry`);
      return;
    }

    const confirmed = true;

    if (primary.result !== 'SUCCESS') {
      log.warn(`Transaction ${txHash} failed: ${primary.result}`);
      return unpaid(confirmed, consensusSeconds(primary));
    }

    const recipient = await this.resolveAccountId(recipientAddress);

    if (!recipient) {
      log.warn(`HBAR alias ${recipientAddress} has no account on the mirror node yet`);
      return;
    }

    const expectedSender = await this.resolveAccountId(senderAddress);

    if (!expectedSender) {
      log.warn(`HBAR alias ${senderAddress} has no account on the mirror node; it cannot have paid ${txHash}`);
      return unpaid(confirmed, consensusSeconds(primary));
    }

    const successful = entries.filter(t => t.result === 'SUCCESS');
    const deltas = new Map<string, bigint>();

    for (const entry of successful) {
      for (const [account, delta] of this.entryDeltas(entry, tokenAddress)) {
        addDelta(deltas, account, delta);
      }
    }

    const paid = provableContribution(deltas, new Set([expectedSender]), recipient);

    return settlement(senderAddress, recipientAddress, tokenAddress, paid, confirmed, Math.max(...successful.map(consensusSeconds)));
  }

  private async resolveEthereumHash(txHash: string): Promise<string | undefined> {
    const hash = txHash.trim().toLowerCase();

    if (!ETHEREUM_TX_HASH.test(hash)) {
      return undefined;
    }

    const contractResult = await this.apiGet(`contracts/results/${hash}`);

    return typeof contractResult?.transaction_id === 'string' ? toMirrorTxId(contractResult.transaction_id) : undefined;
  }

  private async resolveAccountId(address: string): Promise<string | undefined> {
    if (!EVM_ALIAS.test(address)) {
      return address;
    }

    const account = await this.apiGet(`accounts/${address.toLowerCase()}?limit=1`);

    return typeof account?.account === 'string' && ENTITY_ID.test(account.account) ? account.account : undefined;
  }

  private entryDeltas(entry: HbarTransaction, tokenAddress: string): Map<string, bigint> {
    const native = tokenAddress === "0x0";
    const transfers = native ? nettedTransfers(entry) : (entry.token_transfers ?? []).filter(t => t.token_id === tokenAddress);
    const deltas = new Map<string, bigint>();

    for (const t of transfers) {
      if (!native || !NETWORK_ACCOUNTS.includes(t.account)) {
        addDelta(deltas, t.account, BigInt(safeAmount(t.amount)));
      }
    }

    const payer = MIRROR_TX_ID.exec(entry.transaction_id ?? '')?.[1];

    if (native && payer && entry.charged_tx_fee) {
      addDelta(deltas, payer, BigInt(safeAmount(entry.charged_tx_fee)));
    }

    if (!native) {
      chargeMint(deltas);
    }

    return deltas;
  }

  async transfer(): Promise<string> {
    throw new Error('HbarNetwork does not support transfers');
  }

  // The oracle reads a throw from the sigBound check as an unbound key, so a rate-limited or
  // briefly unavailable mirror node must not reach it as one.
  private async apiGetWithRetry(path: string): Promise<any> {
    for (const delay of RETRY_DELAYS) {
      try {
        return await this.apiGet(path);
      } catch (e) {
        if (e instanceof MirrorError && e.status !== 429 && e.status < 500) {
          throw e;
        }

        log.warn(`HBAR mirror node request ${path} failed, retrying in ${delay}ms: ${e}`);

        await sleep(delay);
      }
    }

    return this.apiGet(path);
  }

  private async apiGet(path: string): Promise<any> {
    const resp = await proxyFetch(`${this.rpcUrl}/api/v1/${path}`, { headers: this.authHeaders });

    if (resp.status === 404) {
      return;
    }

    if (!resp.ok) {
      throw new MirrorError(resp.status, `HBAR mirror node error ${resp.status}: ${(await resp.text()).substring(0, 1024)}`);
    }

    return await resp.json();
  }
}
