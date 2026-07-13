import { HttpClient } from '@bronlabs/bron-sdk/utils';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme } from '../attestation.js';
import { proxyFetch } from '../proxy.js';
import {
  cantonAddressFromPublicKey,
  cantonMatchesAddress,
  cantonTokenDecimals,
  DEFAULT_DA_UTILITIES_API_URL,
  verifyCantonAttestation
} from './canton-common.js';

interface BronCantonTx {
  networkId: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  amount: string;
  completed: boolean;
  completedAt?: number;
}

// Canton validated through the Bron API instead of direct ledger access: participant credentials
// cannot be shared with external oracle operators, and party-scoping hides the tx from them anyway.
export class BronCantonNetwork implements Network, AttestationCapable {
  private readonly http: HttpClient;
  private readonly basePath: string;
  private readonly daUtilitiesApiUrl: string;

  readonly retryDelay: number = 5000;
  readonly signatureScheme = SignatureScheme.Ed25519;

  reconcileInterval?: number;
  TBAWaitPeriodSeconds?: number;

  constructor(networkId: string, bronApiUrl?: string, bronApiKey?: string, daUtilitiesApiUrl?: string) {
    if (!bronApiUrl || !bronApiKey) {
      throw new Error(`${networkId} network config requires bronApiUrl and bronApiKey`);
    }

    this.http = new HttpClient(bronApiUrl, bronApiKey, proxyFetch as unknown as ConstructorParameters<typeof HttpClient>[2]);
    this.basePath = `/intents/chains/${networkId}`;
    this.daUtilitiesApiUrl = daUtilitiesApiUrl || DEFAULT_DA_UTILITIES_API_URL;
  }

  async ping(): Promise<void> {
    await this.http.request({ method: 'GET', path: `${this.basePath}/health` });
  }

  getDecimals(tokenAddress: string): Promise<number> {
    return cantonTokenDecimals(this.daUtilitiesApiUrl, tokenAddress);
  }

  async getTxData(txHash: string, tokenAddress: string, _recipientAddress: string, tokenId?: bigint): Promise<TransactionData | undefined> {
    let tx: BronCantonTx;

    try {
      tx = await this.http.request<BronCantonTx>({
        method: 'GET',
        path: `${this.basePath}/transactions/${encodeURIComponent(txHash)}`,
        query: { tokenAddress }
      });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('HTTP 404')) {
        return undefined;
      }
      throw e;
    }

    return {
      from: tx.fromAddress,
      to: tx.toAddress,
      token: tx.tokenAddress,
      tokenId,
      amount: BigInt(tx.amount),
      confirmed: tx.completed,
      timestamp: tx.completedAt != null ? Math.floor(tx.completedAt / 1000) : 0
    };
  }

  async transfer(): Promise<string> {
    throw new Error('BronCantonNetwork does not support transfers');
  }

  addressFromPublicKey(publicKey: string): string {
    return cantonAddressFromPublicKey(publicKey);
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): Promise<boolean> {
    return verifyCantonAttestation(publicKey, signature, preimage);
  }

  matchesAddress(publicKey: string, address: string): boolean {
    return cantonMatchesAddress(publicKey, address);
  }
}
