import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { addDelta, log, provableContribution, settlement, UNATTRIBUTED } from '../utils.js';
import { proxyFetch } from '../proxy.js';
import { randomUUID } from 'node:crypto';

interface BtcTxInput {
  txid?: string;
  vout?: number;
  coinbase?: string;
  txinwitness?: string[];
  scriptSig?: { hex?: string };
}

interface BtcTransaction {
  txid: string;
  vin: BtcTxInput[];
  vout: Array<{
    value: bigint;
    scriptPubKey: {
      address?: string;
      addresses?: string[];
      type?: string;
    };
  }>;
  confirmations: number;
  blocktime?: number;
}

const SIGHASH_ALL = 0x01;

const satoshis = (value: bigint | number | string): bigint => BigInt(Math.round(Number(value) * 1e8));

// Any flag other than SIGHASH_ALL / taproot SIGHASH_DEFAULT lets a third party graft the payer's input
// into a tx its owner never authorized, so attribution must fail closed on it.
export function inputSignsAllOutputs(vin: BtcTxInput, prevOutType?: string): boolean {
  const witness = (vin.txinwitness ?? []).map(h => Buffer.from(h, 'hex'));

  if (prevOutType === 'witness_v1_taproot') {
    const items = witness.length > 1 && witness[witness.length - 1]?.[0] === 0x50 ? witness.slice(0, -1) : witness;
    if (items.length !== 1) return false;

    const sig = items[0];
    return sig.length === 64 || (sig.length === 65 && sig[64] === SIGHASH_ALL);
  }

  const scriptSigChunks = vin.scriptSig?.hex ? (bitcoin.script.decompile(Buffer.from(vin.scriptSig.hex, 'hex')) ?? []) : [];
  const candidates = [...witness, ...scriptSigChunks.filter((c): c is Buffer => Buffer.isBuffer(c))];
  const sigs = candidates.filter(b => b.length >= 9 && b.length <= 73 && b[0] === 0x30 && b[1] === b.length - 3);

  return sigs.length > 0 && sigs.every(s => s[s.length - 1] === SIGHASH_ALL);
}

interface BtcUtxo {
  txid: string;
  vout: number;
  value: bigint;
  scriptPubKey: string;
}

const ECPair = ECPairFactory(ecc);

export class BtcNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 8;
  readonly retryDelay: number = 30000;
  readonly signatureScheme = SignatureScheme.Secp256k1;

  constructor(rpcUrl: string, confirmations: number = 6) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
  }

  addressFromPublicKey(publicKey: string): string {
    return bitcoin.payments.p2wpkh({ pubkey: this.compressedPubkey(publicKey), network: bitcoin.networks.bitcoin }).address!;
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  matchesAddress(publicKey: string, address: string): boolean {
    const pubkey = this.compressedPubkey(publicKey);

    const candidates = [bitcoin.networks.bitcoin, bitcoin.networks.testnet].flatMap((net) => [
      bitcoin.payments.p2wpkh({ pubkey, network: net }).address,
      bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network: net }), network: net }).address,
      bitcoin.payments.p2pkh({ pubkey, network: net }).address,
    ]);

    return candidates.includes(address);
  }

  private compressedPubkey(publicKey: string): Buffer {
    return Buffer.from(ethers.getBytes(ethers.SigningKey.computePublicKey(publicKey, true)));
  }

  async ping(): Promise<void> {
    await this.rpcCall('getblockcount');
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress !== "0x0") {
      throw new Error("Don't support tokens for BTC network");
    }
    return this.nativeAssetDecimals;
  }

  async getTxData(txHash: string, tokenAddress: string, recipientAddress: string, _tokenId: bigint | undefined, senderAddress: string): Promise<TransactionData | undefined> {
    if (tokenAddress !== "0x0") {
      throw new Error("Don't support tokens for BTC network");
    }

    try {
      const tx = await this.rpcCall('getrawtransaction', [txHash, true]) as BtcTransaction;
      if (!tx) return;

      log.info(`Confirmations ${txHash}: ${tx.confirmations}`);

      const confirmed = tx.confirmations >= this.confirmations;
      const timestamp = tx.blocktime ?? 0;

      if (tx.vin.some(v => v.coinbase || !v.txid || v.vout === undefined)) {
        return settlement("", "", "", 0n, confirmed, timestamp);
      }

      const inputs = await this.resolveInputs(tx);

      if (!inputs.filter(i => i.address === senderAddress).every(i => inputSignsAllOutputs(i.vin, i.prevOutType))) {
        log.warn(`Transaction ${txHash} spends an input of ${senderAddress} that does not sign every output`);
        return settlement("", "", "", 0n, confirmed, timestamp);
      }

      const deltas = new Map<string, bigint>();

      for (const input of inputs) {
        addDelta(deltas, input.address, -input.value);
      }

      for (const vout of tx.vout) {
        addDelta(deltas, vout.scriptPubKey.address ?? vout.scriptPubKey.addresses?.[0] ?? UNATTRIBUTED, satoshis(vout.value));
      }

      return settlement(senderAddress, recipientAddress, tokenAddress, provableContribution(deltas, new Set([senderAddress]), recipientAddress), confirmed, timestamp);
    } catch (error) {
      log.warn(`Failed to get transaction data for ${txHash}: ${error}`);
      return;
    }
  }

  private async resolveInputs(tx: BtcTransaction): Promise<Array<{ vin: BtcTxInput; address: string; value: bigint; prevOutType?: string }>> {
    const prevTxs = new Map<string, BtcTransaction>();

    await Promise.all([...new Set(tx.vin.map(v => v.txid!))].map(async txid => {
      prevTxs.set(txid, await this.rpcCall('getrawtransaction', [txid, true]) as BtcTransaction);
    }));

    return tx.vin.map(vin => {
      const prevOut = prevTxs.get(vin.txid!)!.vout[vin.vout!];

      return {
        vin,
        address: prevOut.scriptPubKey.address ?? prevOut.scriptPubKey.addresses?.[0] ?? UNATTRIBUTED,
        value: satoshis(prevOut.value),
        prevOutType: prevOut.scriptPubKey.type
      };
    });
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
    const response = await proxyFetch(this.rpcUrl, {
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
