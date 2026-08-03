import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { log, sleep } from '../utils.js';
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

// Fee collection, staking and node reward accounts are never a settlement counterparty.
const NETWORK_ACCOUNTS = ['0.0.98', '0.0.800', '0.0.801', '0.0.802'];

const RETRY_DELAYS = [300, 1000];

class MirrorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Both textual forms of a transaction id carry the same integer nanosecond count — the SDK form
// only prints it zero-padded, so an unpadded count is left-padded, never read as a fraction.
export function toMirrorTxId(txId: string): string | undefined {
  const id = txId.trim();
  const match = SDK_TX_ID.exec(id) ?? MIRROR_TX_ID.exec(id);

  if (match) {
    return `${match[1]}-${match[2]}-${match[3].padStart(9, '0')}`;
  }

  // The mirror node serves the same record under its native SHA-384 hash, hex or base64 encoded.
  return NATIVE_TX_HASH.test(id) || BASE64_TX_HASH.test(id) ? encodeURIComponent(id) : undefined;
}

const consensusSeconds = (tx: HbarTransaction): number => parseInt(tx.consensus_timestamp.split('.')[0], 10);

const entryRank = (tx: HbarTransaction): number => tx.nonce === 0 ? (tx.scheduled ? 1 : 0) : 2;

// int64 amounts arrive as JSON numbers, so anything past 2^53 is already rounded.
function safeAmount(amount: number): number {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`HBAR transfer amount exceeds safe integer range: ${amount}`);
  }

  return amount;
}

// transfers[] is the net HBAR change per account, so a staking-reward payout triggered by this
// transaction lands on top of the settlement — net it back out before reading the payment.
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

  // The EVM alias is the only Hedera address form derivable from a key alone; a native `0.0.x` id
  // is bound to its key through matchesAddress instead.
  addressFromPublicKey(publicKey: string): string {
    return ethers.computeAddress(publicKey).toLowerCase();
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  // An account id is not key-derivable, so the key that controls it is read from the mirror node.
  // It reads the CURRENT key: a rotation mid-quorum can split oracles, and pinning it needs an interface change.
  async matchesAddress(publicKey: string, address: string): Promise<boolean> {
    let compressed: string;

    try {
      compressed = ethers.SigningKey.computePublicKey(publicKey, true).slice(2).toLowerCase();
    } catch {
      return false;
    }

    // An account auto-created by a transfer to an alias stays hollow — its mirror key is null until
    // it signs something — so the alias form binds offline first, against the key itself.
    if (EVM_ALIAS.test(address)) {
      if (this.addressFromPublicKey(publicKey) === address.toLowerCase()) {
        return true;
      }
    } else if (!ENTITY_ID.test(address)) {
      log.warn(`HBAR address ${address} is not a native account id or an EVM alias`);
      return false;
    }

    // Long-zero aliases and rotated keys don't match the derived alias — fall back to the
    // account's registered key.
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
    tokenId?: bigint,
    senderAddress?: string
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

    // Duplicate submissions land as extra top-level entries; the payer's own one carries the
    // network's verdict on the transaction and its consensus time.
    const topLevel = entries.filter(t => t.nonce === 0 && !t.scheduled);
    const primary = topLevel.find(t => t.result === 'SUCCESS') ?? topLevel[0];

    if (!primary) {
      log.warn(`Transaction ${txHash} has no top-level entry`);
      return;
    }

    // Hedera finality is deterministic (aBFT): an entry that reached consensus is final.
    const confirmed = true;

    if (primary.result !== 'SUCCESS') {
      log.warn(`Transaction ${txHash} failed: ${primary.result}`);
      return { from: "", to: "", token: "", amount: 0n, confirmed, timestamp: consensusSeconds(primary) };
    }

    // A transfer TO an alias auto-creates the account, so a missing alias mapping is transient,
    // not a terminal mismatch.
    const recipient = await this.resolveAccountId(recipientAddress);

    if (!recipient) {
      log.warn(`HBAR alias ${recipientAddress} has no account on the mirror node yet`);
      return;
    }

    // A scheduled transfer settles on the scheduled sibling of the payer's entry and a contract call
    // records its token transfers on child entries, so the entry that credits is the one that pays.
    const candidates = entries
      .filter(t => t.result === 'SUCCESS')
      .sort((a, b) => entryRank(a) - entryRank(b) || a.nonce - b.nonce);

    for (const entry of candidates) {
      const transfers: HbarTransfer[] = tokenAddress === "0x0"
        ? nettedTransfers(entry)
        : (entry.token_transfers ?? []).filter(t => t.token_id === tokenAddress);

      const amount = this.creditedAmount(transfers, recipient);

      if (amount === 0n) {
        continue;
      }

      // A transaction also debits its payer for the network fee, so more than one debited account
      // leaves the settlement sender ambiguous.
      const sender = this.soleSender(transfers, tokenAddress === "0x0" ? NETWORK_ACCOUNTS : []);

      if (!sender) {
        log.warn(`Transaction ${txHash} has no unambiguous sender of ${tokenAddress}; refusing to attribute one`);
      }

      let from = sender;

      if (sender && senderAddress) {
        // The oracle string-compares from/to against the order, which may carry either address form.
        const expectedSender = await this.resolveAccountId(senderAddress);

        if (expectedSender === sender) {
          from = senderAddress;
        }
      }

      return {
        from,
        to: recipientAddress,
        token: tokenAddress,
        amount,
        confirmed,
        timestamp: consensusSeconds(entry)
      };
    }

    log.warn(`Transaction ${txHash} does not credit ${tokenAddress} to ${recipientAddress}`);

    return { from: "", to: "", token: "", amount: 0n, confirmed, timestamp: consensusSeconds(primary) };
  }

  // A transaction submitted through the JSON-RPC relay is only known to its payer by the Ethereum
  // hash; the contract result maps it back to the Hedera transaction id.
  private async resolveEthereumHash(txHash: string): Promise<string | undefined> {
    const hash = txHash.trim().toLowerCase();

    if (!ETHEREUM_TX_HASH.test(hash)) {
      return undefined;
    }

    const contractResult = await this.apiGet(`contracts/results/${hash}`);

    return typeof contractResult?.transaction_id === 'string' ? toMirrorTxId(contractResult.transaction_id) : undefined;
  }

  // Mirror transfers only carry native ids.
  private async resolveAccountId(address: string): Promise<string | undefined> {
    if (!EVM_ALIAS.test(address)) {
      return address;
    }

    const account = await this.apiGet(`accounts/${address.toLowerCase()}?limit=1`);

    return typeof account?.account === 'string' && ENTITY_ID.test(account.account) ? account.account : undefined;
  }

  private creditedAmount(transfers: HbarTransfer[], recipientAddress: string): bigint {
    return transfers
      .filter(t => t.account === recipientAddress && t.amount > 0)
      .reduce((sum, t) => sum + BigInt(safeAmount(t.amount)), 0n);
  }

  private soleSender(transfers: HbarTransfer[], excluded: string[]): string {
    const senders = [...new Set(transfers.filter(t => t.amount < 0 && !excluded.includes(t.account)).map(t => t.account))];

    return senders.length === 1 ? senders[0] : "";
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
