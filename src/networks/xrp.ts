import Big from 'big.js';
import { Wallet } from 'xrpl';
import { deriveAddress } from 'ripple-keypairs';
import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { log, settlement, unpaid } from '../utils.js';
import { proxyFetch } from '../proxy.js';

const DEFAULT_ISSUED_CURRENCY_DECIMALS = 15;
const RIPPLE_EPOCH_OFFSET = 946684800;

export class XrpNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly authHeaders: Record<string, string> = {};
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 6;
  readonly retryDelay: number = 10000;
  readonly signatureScheme = SignatureScheme.Secp256k1;

  constructor(rpcUrl: string, confirmations: number = 1) {
    if (rpcUrl.includes('@')) {
      const [rpcUrlPart, apiKey] = rpcUrl.split('@', 2);

      this.rpcUrl = rpcUrlPart;
      this.authHeaders = { 'x-api-key': apiKey };
    } else {
      this.rpcUrl = rpcUrl;
    }

    this.confirmations = confirmations;
  }

  addressFromPublicKey(publicKey: string): string {
    return deriveAddress(ethers.SigningKey.computePublicKey(publicKey, true).slice(2).toUpperCase());
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  async ping(): Promise<void> {
    await this.rpcCall('server_info');
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    return DEFAULT_ISSUED_CURRENCY_DECIMALS;
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string,
    _tokenId: bigint | undefined,
    senderAddress: string
  ): Promise<TransactionData | undefined> {
    const result = await this.rpcCall('tx', { transaction: txHash, binary: false });

    if (!result || result.error || result.status === 'error' || !result.validated) {
      return;
    }

    const meta = result.meta || result.metaData;

    const currentLedger = await this.getCurrentValidatedLedger();
    const confirmed = currentLedger - result.ledger_index >= this.confirmations;
    const timestamp = typeof result.date === 'number' ? result.date + RIPPLE_EPOCH_OFFSET : 0;

    log.info(`Confirmations ${txHash}: ${currentLedger - result.ledger_index}`);

    if (meta?.TransactionResult !== 'tesSUCCESS' || result.TransactionType !== 'Payment' || result.Account !== senderAddress || result.Destination !== recipientAddress) {
      log.warn(`Transaction ${txHash} is not a successful Payment from ${senderAddress} to ${recipientAddress}`);
      return unpaid(confirmed, timestamp);
    }

    const delivered = meta.delivered_amount;

    if (tokenAddress === "0x0") {
      return settlement(senderAddress, recipientAddress, tokenAddress, typeof delivered === 'string' ? BigInt(delivered) : 0n, confirmed, timestamp);
    }

    const paid = delivered?.currency !== undefined && `${delivered.currency}.${delivered.issuer}` === tokenAddress
      ? BigInt(new Big(delivered.value).times(new Big(10).pow(await this.getDecimals(tokenAddress))).toFixed(0))
      : 0n;

    return settlement(senderAddress, recipientAddress, tokenAddress, paid, confirmed, timestamp);
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    const wallet = Wallet.fromSeed(privateKey);

    const accountInfo = await this.rpcCall('account_info', {
      account: wallet.classicAddress,
      ledger_index: 'validated'
    });

    const feeResult = await this.rpcCall('fee');
    const openLedgerFee = parseInt(feeResult.drops.open_ledger_fee);
    const fee = Math.min(openLedgerFee, 1000).toString();

    const currentLedger = await this.getCurrentValidatedLedger();

    let amount: string | { value: string; currency: string; issuer: string };

    if (tokenAddress === '0x0') {
      amount = value.toString();
    } else {
      const { currency, issuer } = this.parseTokenAddress(tokenAddress);
      const decimals = await this.getDecimals(tokenAddress);

      amount = {
        value: new Big(value.toString())
          .div(new Big(10).pow(decimals))
          .toFixed(),
        currency,
        issuer
      };
    }

    const signed = wallet.sign({
      TransactionType: 'Payment',
      Account: wallet.classicAddress,
      Destination: to,
      Amount: amount,
      Sequence: accountInfo.account_data.Sequence,
      Fee: fee,
      LastLedgerSequence: currentLedger + 20
    } as any);

    await this.rpcCall('submit', { tx_blob: signed.tx_blob });

    return signed.hash;
  }

  private parseTokenAddress(tokenAddress: string): { currency: string; issuer: string } {
    const colonIndex = tokenAddress.indexOf('.');

    if (colonIndex === -1) {
      throw new Error(`Invalid XRP token address format: ${tokenAddress}. Expected "currency:issuer"`);
    }

    return {
      currency: tokenAddress.substring(0, colonIndex),
      issuer: tokenAddress.substring(colonIndex + 1)
    };
  }

  private async getCurrentValidatedLedger(): Promise<number> {
    const result = await this.rpcCall('ledger', { ledger_index: 'validated' });
    return result.ledger_index;
  }

  private async rpcCall(method: string, params: Record<string, any> = {}): Promise<any> {
    const resp = await proxyFetch(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders
      },
      body: JSON.stringify({
        method,
        params: [params]
      })
    } as any);

    if (!resp.ok) {
      throw new Error(`XRP RPC error ${resp.status}: ${(await resp.text()).substring(0, 1024)}`);
    }

    const json = await resp.json() as any;
    return json.result;
  }
}
