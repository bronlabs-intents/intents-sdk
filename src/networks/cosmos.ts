import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { addDelta, log, provableContribution } from '../utils.js';
import { proxyFetch } from '../proxy.js';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { bech32 } from 'bech32';
import { ethers } from 'ethers';

export class CosmosNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly nativeDenom: string;
  private readonly confirmations: number;
  readonly retryDelay: number = 15000;
  readonly signatureScheme = SignatureScheme.Secp256k1;
  private readonly bech32: string;
  private readonly gasPrice: number;
  private readonly feeCollector: string;

  constructor(rpcUrl: string, nativeDenom: string, bech32Prefix: string, gasPrice: number, confirmations: number = 1) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.gasPrice = gasPrice;
    this.nativeDenom = nativeDenom;
    this.bech32 = bech32Prefix
    this.feeCollector = bech32.encode(bech32Prefix, bech32.toWords(ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes('fee_collector'))).slice(0, 20)));
  }

  // bech32(prefix, ripemd160(sha256(compressed secp256k1 pubkey))) — standard Cosmos account address.
  addressFromPublicKey(publicKey: string): string {
    const compressed = ethers.getBytes(ethers.SigningKey.computePublicKey(publicKey, true));
    const sha = ethers.getBytes(ethers.sha256(compressed));
    const rip = ethers.getBytes(ethers.ripemd160(sha));
    return bech32.encode(this.bech32, bech32.toWords(rip));
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  async ping(): Promise<void> {
    await this.rpcGet('status');
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    let denom = tokenAddress;
    if (tokenAddress === "0x0") {
      denom = this.nativeDenom;
    }

    const firstLetter = denom[0];

    if (firstLetter === 'u') {
      return 6;
    }

    if (firstLetter === 'a') {
      return 18;
    }

    if (firstLetter === 'n') {
      return 9;
    }

    return 0;
  }

  async getTxData(txHash: string, tokenAddress: string, recipientAddress: string, _tokenId?: bigint, senderAddress?: string): Promise<TransactionData | undefined> {
    const result = await this.rpcGet('tx', { hash: `0x${txHash}`, prove: 'false' });

    if (!result || !result.tx_result) {
      return;
    }

    if (result.tx_result.code !== 0) {
      log.warn(`Transaction ${txHash} failed on blockchain: code=${result.tx_result.code}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed: false,
        timestamp: 0
      }
    }

    let denom = tokenAddress;
    if (tokenAddress === "0x0") {
      denom = this.nativeDenom;
    }

    // A single transfer event can carry several (recipient, sender, amount) triples (multisend /
    // fan-out), so parse ordered triples and require EXACTLY ONE matching recipient+denom — otherwise
    // `from` is ambiguous and the attester could point at a payment they didn't originate.
    const matches = (result.tx_result.events || [])
      .filter((e: any) => e.type === 'transfer')
      .flatMap((e: any) => this.parseTransferTriples(e.attributes))
      .filter((t: any) =>
        t.recipient?.toLowerCase() === recipientAddress?.toLowerCase() &&
        this.parseDenomAmount(t.amount || '', denom) !== null
      );

    if (matches.length !== 1 && !senderAddress) {
      log.warn(`Transaction ${txHash} has ${matches.length} transfers of ${denom} to ${recipientAddress} (expected exactly 1)`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed: false,
        timestamp: 0
      }
    }

    const blockResult = await this.rpcGet('block');
    const currentBlock = parseInt(blockResult.block.header.height);
    const txBlock = parseInt(result.height);

    const confirmed = (currentBlock - txBlock) >= this.confirmations;

    log.info(`Confirmations ${txHash}: ${currentBlock}, confirmed: ${confirmed}`)

    const txBlockResult = await this.rpcGet('block', { height: result.height });
    const blockTime = txBlockResult?.block?.header?.time;
    const timestamp = blockTime ? Math.floor(Date.parse(blockTime) / 1000) : 0;

    const legacy = matches.length === 1
      ? {
        from: matches[0].sender || '',
        to: matches[0].recipient || '',
        token: tokenAddress,
        amount: this.parseDenomAmount(matches[0].amount || '', denom)!,
        confirmed,
        timestamp
      }
      : { from: "", to: "", token: "", amount: 0n, confirmed, timestamp };

    if (!senderAddress || legacy.from.toLowerCase() === senderAddress.toLowerCase()) {
      return legacy;
    }

    const contribution = this.contribution(result.tx_result.events || [], denom, senderAddress, recipientAddress);

    if (!contribution && matches.length !== 1) {
      log.warn(`Transaction ${txHash} has ${matches.length} transfers of ${denom} to ${recipientAddress} and no provable payment from ${senderAddress}`);
    }

    return contribution
      ? { from: senderAddress, to: recipientAddress, token: tokenAddress, amount: contribution, confirmed, timestamp }
      : legacy;
  }

  private contribution(events: any[], denom: string, senderAddress: string, recipientAddress: string): bigint {
    const deltas = new Map<string, bigint>();

    const sides: Record<string, [string, bigint]> = { coin_spent: ['spender', -1n], coin_received: ['receiver', 1n] };

    for (const event of events) {
      if (!sides[event.type]) {
        continue;
      }

      const [addressKey, sign] = sides[event.type];

      let address: string | undefined;

      for (const { key, value } of this.decodeAttributes(event.attributes || [])) {
        if (key === addressKey) {
          address = value.toLowerCase();
        } else if (key === 'amount' && address) {
          addDelta(deltas, address, sign * (this.parseDenomAmount(value, denom) ?? 0n));
        }
      }
    }

    for (const fee of events.filter((e: any) => e.type === 'transfer').flatMap((e: any) => this.parseTransferTriples(e.attributes))) {
      if (fee.recipient?.toLowerCase() === this.feeCollector && fee.sender) {
        const amount = this.parseDenomAmount(fee.amount || '', denom) ?? 0n;

        addDelta(deltas, fee.sender.toLowerCase(), amount);
        addDelta(deltas, this.feeCollector, -amount);
      }
    }

    return provableContribution(deltas, new Set([senderAddress.toLowerCase()]), recipientAddress.toLowerCase());
  }

  /**
   * @deprecated Signs from a raw private key — do not use in production. Kept for local tooling/tests.
   */
  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string) {
    const wallet = await DirectSecp256k1Wallet.fromKey(Buffer.from(privateKey, 'hex'), this.bech32);
    const [account] = await wallet.getAccounts();
    const sender = account.address;

    const cometClient = await Tendermint37Client.create({
      execute: async (request: any) => {
        const response = await proxyFetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });

        if (!response.ok) {
          throw new Error(`Cosmos RPC error: ${response.status}`);
        }

        const json = await response.json() as any;

        if (json.error) {
          throw new Error(JSON.stringify(json.error));
        }

        return json;
      },
      disconnect: () => {}
    } as any);

    const gasPrice = GasPrice.fromString(`${this.gasPrice}${this.nativeDenom}`);
    const client = await SigningStargateClient.createWithSigner(cometClient, wallet, { gasPrice });

    const denom = tokenAddress === "0x0" ? this.nativeDenom : tokenAddress;
    const amount = [{ denom, amount: value.toString() }];
    const resultAuto = await client.sendTokens(sender, to, amount, "auto");

    return resultAuto.transactionHash
  }

  private parseDenomAmount(amountStr: string, denom: string): bigint | null {
    for (const coin of amountStr.split(',')) {
      const match = coin.trim().match(/^(\d+)(.+)$/);

      if (match && match[2] === denom) {
        return BigInt(match[1]);
      }
    }

    return null;
  }

  private decodeAttributes(attributes: any[]): { key: string; value: string }[] {
    const isPlainText = attributes.some((a: any) =>
      ['sender', 'recipient', 'amount', 'spender', 'receiver'].includes(a.key)
    );

    return attributes.map((attr: any) => isPlainText
      ? { key: attr.key, value: attr.value || '' }
      : {
          key: Buffer.from(attr.key, 'base64').toString('utf-8'),
          value: attr.value ? Buffer.from(attr.value, 'base64').toString('utf-8') : '',
        });
  }

  private parseTransferTriples(attributes: any[]): { recipient?: string; sender?: string; amount?: string }[] {
    const triples: { recipient?: string; sender?: string; amount?: string }[] = [];
    let current: { recipient?: string; sender?: string; amount?: string } = {};

    for (const { key, value } of this.decodeAttributes(attributes)) {
      if (key !== 'recipient' && key !== 'sender' && key !== 'amount') {
        continue;
      }

      if (key in current) {
        triples.push(current);
        current = {};
      }

      current[key] = value;
    }

    if (Object.keys(current).length > 0) {
      triples.push(current);
    }

    return triples;
  }

  private async rpcGet(method: string, params: Record<string, string> = {}): Promise<any> {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const url = queryString
      ? `${this.rpcUrl}/${method}?${queryString}`
      : `${this.rpcUrl}/${method}`;

    const resp = await proxyFetch(url);

    if (!resp.ok) {
      throw new Error(`Cosmos RPC error ${resp.status}: ${(await resp.text()).substring(0, 1024)}`);
    }

    const json = await resp.json() as any;

    if (json.error) {
      throw new Error(`Cosmos RPC error: ${JSON.stringify(json.error)}`);
    }

    return json.result;
  }
}
