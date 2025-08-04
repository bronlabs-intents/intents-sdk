import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';

import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';
import { randomUUID } from 'node:crypto';

interface BtcTransaction {
  txid: string;
  vout: Array<{
    value: bigint;
    scriptPubKey: {
      addresses: string[];
    };
  }>;
  confirmations: number;
}

interface BtcUtxo {
  txid: string;
  vout: number;
  value: bigint;
  scriptPubKey: string;
}

const ECPair = ECPairFactory(ecc);

export class BtcNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 8;
  readonly retryDelay: number = 5000;

  constructor(rpcUrl: string, confirmations: number = 6) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress !== "0x0") {
      throw new Error("Don't support tokens for BTC network");
    }
    return this.nativeAssetDecimals;
  }

  async getTxData(txHash: string, tokenAddress: string, recipientAddress: string): Promise<TransactionData | undefined> {
    if (tokenAddress !== "0x0") {
      throw new Error("Don't support tokens for BTC network");
    }

    try {
      const tx = await this.rpcCall('getrawtransaction', [txHash, true]) as BtcTransaction;
      if (!tx) return;

      const output = tx.vout.find(vout =>
        vout.scriptPubKey.addresses?.includes(recipientAddress)
      );

      if (!output) {
        log.warn(`Transaction ${txHash} has no output to ${recipientAddress}`);
        return {
          to: recipientAddress,
          token: tokenAddress,
          amount: 0n,
          confirmed: tx.confirmations >= this.confirmations
        };
      }

      log.info(`Confirmations ${txHash}: ${tx.confirmations}`);

      return {
        to: recipientAddress,
        token: tokenAddress,
        amount: BigInt(Math.round(Number(output.value) * 1e8)),
        confirmed: tx.confirmations >= this.confirmations
      };
    } catch (error) {
      log.warn(`Failed to get transaction data for ${txHash}: ${error}`);
      return;
    }
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    if (tokenAddress !== "0x0") {
      throw new Error("Don't support tokens for BTC network");
    }

    const keyPair = ECPair.fromWIF(privateKey);
    const fromAddress = this.getAddressFromPrivateKey(privateKey);
    const utxos = await this.getUtxos(fromAddress);

    if (utxos.length === 0) {
      throw new Error("No UTXOs available");
    }

    const targetAmount = value;
    let inputAmount = 0n;
    const feeRate = await this.getFeeRate();
    const selectedUtxos: BtcUtxo[] = [];

    for (const utxo of utxos) {
      selectedUtxos.push(utxo);
      inputAmount += utxo.value;

      const estimatedFee = BigInt(selectedUtxos.length * 148 + 2 * 34 + 10) * feeRate;
      if (inputAmount >= targetAmount + estimatedFee) break;
    }

    const estimatedFee = BigInt(selectedUtxos.length * 148 + 2 * 34 + 10) * feeRate;
    const changeAmount = inputAmount - targetAmount - estimatedFee;

    if (inputAmount < targetAmount + estimatedFee) {
      throw new Error(`Insufficient funds. Need ${targetAmount + estimatedFee}, have ${inputAmount}`);
    }

    const psbt = new bitcoin.Psbt();

    for (const utxo of selectedUtxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(await this.rpcCall('getrawtransaction', [utxo.txid]), 'hex')
      });
    }

    psbt.addOutput({ address: to, value: Number(targetAmount) });

    if (changeAmount > 546) {
      psbt.addOutput({ address: fromAddress, value: Number(changeAmount) });
    }

    selectedUtxos.forEach((_, index) => psbt.signInput(index, keyPair));
    psbt.finalizeAllInputs();

    return await this.rpcCall('sendrawtransaction', [psbt.extractTransaction().toHex()]);
  }

  private async getFeeRate(): Promise<bigint> {
    try {
      const feeEstimate = await this.rpcCall('estimatesmartfee', [6]);
      return feeEstimate?.feerate ? BigInt(Math.ceil(feeEstimate.feerate * 100000000 / 1000)) : 10n;
    } catch {
      return 10n;
    }
  }

  private async getUtxos(address: string): Promise<BtcUtxo[]> {
    const utxos = await this.rpcCall('listunspent', [1, 9999999, [address]]);
    return utxos.map((utxo: any) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: BigInt(Math.round(Number(utxo.amount) * 1e8)),
      scriptPubKey: utxo.scriptPubKey
    }));
  }

  private getAddressFromPrivateKey(privateKey: string): string {
    return bitcoin.payments.p2pkh({ pubkey: ECPair.fromWIF(privateKey).publicKey }).address!;
  }

  private async rpcCall(method: string, params: any[] = []): Promise<any> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: randomUUID(),
        method,
        params
      })
    });

    const { result, error } = await response.json();
    if (error) throw new Error(`RPC Error: ${error.message}`);
    return result;
  }
}
