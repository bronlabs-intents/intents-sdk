import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { log } from '../utils.js';
import { proxyFetch } from '../proxy.js';

interface HbarTransfer {
  account: string;
  amount: number;
}

interface HbarTokenTransfer extends HbarTransfer {
  token_id: string;
}

interface HbarTransaction {
  consensus_timestamp?: string;
  result: string;
  nonce: number;
  scheduled: boolean;
  node?: string | null;
  transfers?: HbarTransfer[];
  token_transfers?: HbarTokenTransfer[];
  staking_reward_transfers?: HbarTransfer[];
}

const ENTITY_ID = /^0\.0\.\d+$/;
const EVM_ALIAS = /^0x[0-9a-fA-F]{40}$/;
const SDK_TX_ID = /^(\d+\.\d+\.\d+)@(\d+)\.(\d{1,9})$/;
const MIRROR_TX_ID = /^(\d+\.\d+\.\d+)-(\d+)-(\d{1,9})$/;

// Fee collection, staking and node reward accounts are never a settlement counterparty.
const NETWORK_ACCOUNTS = ['0.0.98', '0.0.800', '0.0.801', '0.0.802'];

// Both textual forms of a transaction id carry the same integer nanosecond count — the SDK form
// only prints it zero-padded, so an unpadded count is left-padded, never read as a fraction.
export function toMirrorTxId(txId: string): string | undefined {
  const id = txId.trim();
  const match = SDK_TX_ID.exec(id) ?? MIRROR_TX_ID.exec(id);

  return match ? `${match[1]}-${match[2]}-${match[3].padStart(9, '0')}` : undefined;
}

export class HbarNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly authHeaders: Record<string, string> = {};
  private readonly nativeAssetDecimals: number = 8;
  readonly retryDelay: number = 10000;
  readonly signatureScheme = SignatureScheme.Secp256k1;

  constructor(rpcUrl: string) {
    const [baseUrl, apiKey] = rpcUrl.split('@', 2);

    this.rpcUrl = baseUrl.replace(/\/+$/, '');

    if (apiKey) {
      this.authHeaders = { 'x-api-key': apiKey };
    }
  }

  // EVM alias of the key — Hedera settlement addresses are native `0.0.x` account ids, so sigBound
  // goes through matchesAddress instead.
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
    const account = await this.apiGet(`accounts/${address.toLowerCase()}?limit=1`);

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
    if (!await this.apiGet('blocks?limit=1')) {
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

    const mirrorTxId = toMirrorTxId(txHash);

    if (!mirrorTxId) {
      log.warn(`Transaction ${txHash} is not a valid HBAR transaction id`);
      return;
    }

    const result = await this.apiGet(`transactions/${mirrorTxId}`);

    if (!result) {
      return;
    }

    // The same id also covers duplicate submissions, child transactions (nonce > 0) and the
    // scheduled variant; the payer's own top-level transaction is the one that settles.
    const entries: HbarTransaction[] = (result.transactions ?? []).filter((t: HbarTransaction) => t.nonce === 0 && !t.scheduled);
    const tx = entries.find(t => t.result === 'SUCCESS') ?? entries[0];

    if (!tx) {
      log.warn(`Transaction ${txHash} has no top-level entry`);
      return;
    }

    // Hedera finality is deterministic (aBFT): an entry that reached consensus is final.
    const confirmed = !!tx.consensus_timestamp;
    const timestamp = tx.consensus_timestamp ? parseInt(tx.consensus_timestamp.split('.')[0], 10) : 0;

    if (tx.result !== 'SUCCESS') {
      log.warn(`Transaction ${txHash} failed: ${tx.result}`);
      return { from: "", to: "", token: "", amount: 0n, confirmed, timestamp };
    }

    // transfers[] is the net HBAR change per account, so a staking-reward payout triggered by this
    // transaction lands on top of the settlement — net it back out before reading the payment.
    const rewards = new Map<string, number>((tx.staking_reward_transfers ?? []).map(r => [r.account, r.amount]));

    const transfers: HbarTransfer[] = tokenAddress === "0x0"
      ? (tx.transfers ?? []).map(t => ({ ...t, amount: t.amount - (rewards.get(t.account) ?? 0) }))
      : (tx.token_transfers ?? []).filter(t => t.token_id === tokenAddress);

    // A transfer TO an alias auto-creates the account, so a missing alias mapping is transient,
    // not a terminal mismatch.
    const recipient = await this.resolveAccountId(recipientAddress);

    if (!recipient) {
      log.warn(`HBAR alias ${recipientAddress} has no account on the mirror node yet`);
      return;
    }

    const amount = this.creditedAmount(transfers, recipient);

    if (amount === 0n) {
      log.warn(`Transaction ${txHash} does not credit ${tokenAddress} to ${recipientAddress}`);
      return { from: "", to: "", token: "", amount: 0n, confirmed, timestamp };
    }

    // A transaction also debits its payer for the network fee, so more than one debited account
    // leaves the settlement sender ambiguous.
    const sender = this.soleSender(
      transfers,
      tokenAddress === "0x0" ? [...NETWORK_ACCOUNTS, ...(tx.node ? [tx.node] : [])] : []
    );

    if (!sender) {
      log.warn(`Transaction ${txHash} has no unambiguous sender of ${tokenAddress}; refusing to attribute one`);
    }

    let from = sender;

    if (sender && senderAddress) {
      // The oracle string-compares from/to against the order, which may carry either address form.
      const expectedSender = await this.resolveAccountId(senderAddress);

      if (!expectedSender) {
        log.warn(`HBAR alias ${senderAddress} has no account on the mirror node yet`);
        return;
      }

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
      timestamp
    };
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
      .reduce((sum, t) => {
        // int64 amounts arrive as JSON numbers, so anything past 2^53 is already rounded.
        if (!Number.isSafeInteger(t.amount)) {
          throw new Error(`HBAR transfer amount exceeds safe integer range: ${t.amount}`);
        }

        return sum + BigInt(t.amount);
      }, 0n);
  }

  private soleSender(transfers: HbarTransfer[], excluded: string[]): string {
    const senders = [...new Set(transfers.filter(t => t.amount < 0 && !excluded.includes(t.account)).map(t => t.account))];

    return senders.length === 1 ? senders[0] : "";
  }

  async transfer(): Promise<string> {
    throw new Error('HbarNetwork does not support transfers');
  }

  private async apiGet(path: string): Promise<any> {
    const resp = await proxyFetch(`${this.rpcUrl}/api/v1/${path}`, { headers: this.authHeaders });

    if (resp.status === 404) {
      return;
    }

    if (!resp.ok) {
      throw new Error(`HBAR mirror node error ${resp.status}: ${(await resp.text()).substring(0, 1024)}`);
    }

    return await resp.json();
  }
}
