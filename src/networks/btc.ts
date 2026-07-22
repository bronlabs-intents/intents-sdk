import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { log } from '../utils.js';
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

// True when every signature in the input commits to all outputs (SIGHASH_ALL; taproot 64-byte =
// SIGHASH_DEFAULT). Any other flag (NONE/SINGLE/ANYONECANPAY) lets a third party graft the input
// into a tx its owner never authorized, so sender attribution must fail closed.
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

  // Canonical (display) address is P2WPKH; sigBound matching is broader — see matchesAddress.
  addressFromPublicKey(publicKey: string): string {
    return bitcoin.payments.p2wpkh({ pubkey: this.compressedPubkey(publicKey), network: bitcoin.networks.bitcoin }).address!;
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  // One secp256k1 key controls several single-sig address formats, and the same key encodes to a
  // different string on mainnet vs test networks (bech32 HRP, base58 version byte). sigBound accepts
  // any single-sig format on either network; the order's from-address pins which encoding actually
  // matches, so widening the candidate set can't bind a key to an address it doesn't control. Taproot
  // (P2TR) is excluded — it signs with Schnorr, which this ECDSA verifyAttestation can't check.
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

  async getTxData(txHash: string, tokenAddress: string, recipientAddress: string, _tokenId?: bigint, senderAddress?: string): Promise<TransactionData | undefined> {
    if (tokenAddress !== "0x0") {
      throw new Error("Don't support tokens for BTC network");
    }

    try {
      const tx = await this.rpcCall('getrawtransaction', [txHash, true]) as BtcTransaction;
      if (!tx) return;

      // UTXO has no single canonical sender. All inputs from one address → that address is `from`
      // (no other party funded the tx). Several distinct addresses (HD-wallet change outputs) →
      // attribute the expected senderAddress, but only when it owns an input and every signature is
      // SIGHASH_ALL, so each input owner authorized exactly this payment; otherwise fail closed for
      // the senderValid → sigBound chain.
      let from = "";

      const inputs = await this.resolveInputs(tx);
      if (!inputs) {
        log.warn(`Transaction ${txHash} has unresolvable inputs; refusing to attribute a sender`);
      } else {
        const distinct = [...new Set(inputs.map(i => i.address))];

        if (distinct.length === 1) {
          from = distinct[0];
        } else if (senderAddress && distinct.includes(senderAddress) && inputs.every(i => inputSignsAllOutputs(i.vin, i.prevOutType))) {
          from = senderAddress;
          log.info(`Transaction ${txHash}: expected sender ${senderAddress} owns an input and all ${tx.vin.length} inputs are SIGHASH_ALL; attributing it as sender`);
        } else {
          log.warn(`Transaction ${txHash} has ${distinct.length} distinct input addresses; refusing to attribute a sender`);
        }
      }

      const outputs = tx.vout.filter(vout =>
        vout.scriptPubKey.address === recipientAddress || vout.scriptPubKey.addresses?.includes(recipientAddress)
      );

      if (outputs.length === 0) {
        log.warn(`Transaction ${txHash} has no output to ${recipientAddress}: ${JSON.stringify(tx.vout, null, 2)}`);

        return {
          from,
          to: recipientAddress,
          token: tokenAddress,
          amount: 0n,
          confirmed: tx.confirmations >= this.confirmations,
          timestamp: tx.blocktime ?? 0
        };
      }

      log.info(`Confirmations ${txHash}: ${tx.confirmations}`);

      const amount = outputs.reduce((sum, o) => sum + BigInt(Math.round(Number(o.value) * 1e8)), 0n);

      return {
        from,
        to: recipientAddress,
        token: tokenAddress,
        amount,
        confirmed: tx.confirmations >= this.confirmations,
        timestamp: tx.blocktime ?? 0
      };
    } catch (error) {
      log.warn(`Failed to get transaction data for ${txHash}: ${error}`);
      return;
    }
  }

  private async resolveInputs(tx: BtcTransaction): Promise<Array<{ vin: BtcTxInput; address: string; prevOutType?: string }> | undefined> {
    if (tx.vin.length === 0 || tx.vin.some(v => v.coinbase || !v.txid || v.vout === undefined)) return;

    try {
      const prevTxs = new Map<string, BtcTransaction>();
      await Promise.all([...new Set(tx.vin.map(v => v.txid!))].map(async txid => {
        prevTxs.set(txid, await this.rpcCall('getrawtransaction', [txid, true]) as BtcTransaction);
      }));

      const inputs: Array<{ vin: BtcTxInput; address: string; prevOutType?: string }> = [];
      for (const vin of tx.vin) {
        const prevOut = prevTxs.get(vin.txid!)?.vout[vin.vout!];
        const address = prevOut?.scriptPubKey.address || prevOut?.scriptPubKey.addresses?.[0];
        if (!address) return;

        inputs.push({ vin, address, prevOutType: prevOut!.scriptPubKey.type });
      }

      return inputs;
    } catch (e) {
      log.warn(`Failed to resolve input addresses for ${tx.txid}: ${e}`);
      return;
    }
  }

  /**
   * @deprecated Signs from a raw private key — do not use in production. Kept for local tooling/tests.
   */
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
