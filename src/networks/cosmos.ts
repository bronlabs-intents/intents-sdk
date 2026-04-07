import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';
import { proxyFetch } from '../proxy.js';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';

export class CosmosNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly nativeDenom: string;
  private readonly confirmations: number;
  readonly retryDelay: number = 15000;
  private readonly bech32: string;
  private readonly gasPrice: number;

  constructor(rpcUrl: string, nativeDenom: string, bech32: string, gasPrice: number, confirmations: number = 1) {
    this.rpcUrl = rpcUrl;
    this.confirmations = confirmations;
    this.gasPrice = gasPrice;
    this.nativeDenom = nativeDenom;
    this.bech32 = bech32
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

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {
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
        confirmed: false
      }
    }

    const events = result.tx_result.events || [];
    const transferEvent = events.find((e: any) => e.type === 'transfer');

    if (!transferEvent) {
      log.warn(`Transaction ${txHash} has no transfer event`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed: false
      }
    }

    const attrs = this.parseEventAttributes(transferEvent.attributes);

    let denom = tokenAddress;
    if (tokenAddress === "0x0") {
      denom = this.nativeDenom;
    }

    const amountStr = attrs.amount || '';
    const amountMatch = amountStr.match(new RegExp(`(\\d+)${denom}`));

    if (!amountMatch) {
      log.warn(`Transaction ${txHash} has no amount for denom ${denom}: ${amountStr}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed: false
      }
    }

    const blockResult = await this.rpcGet('block');
    const currentBlock = parseInt(blockResult.block.header.height);
    const txBlock = parseInt(result.height);

    const confirmed = (currentBlock - txBlock) >= this.confirmations;

    log.info(`Confirmations ${txHash}: ${currentBlock}, confirmed: ${confirmed}`)

    return {
      from: attrs.sender || '',
      to: attrs.recipient || '',
      token: tokenAddress,
      amount: BigInt(amountMatch[1]),
      confirmed
    }
  }

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

  private parseEventAttributes(attributes: any[]): Record<string, string> {
    const result: Record<string, string> = {};

    for (const attr of attributes) {
      const key = this.isBase64(attr.key) ? Buffer.from(attr.key, 'base64').toString('utf-8') : attr.key;
      const value = attr.value
        ? (this.isBase64(attr.value) ? Buffer.from(attr.value, 'base64').toString('utf-8') : attr.value)
        : '';

      result[key] = value;
    }

    return result;
  }

  private isBase64(str: string): boolean {
    return /^[A-Za-z0-9+/]+=*$/.test(str) && str.length % 4 === 0 && str.length >= 4;
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
