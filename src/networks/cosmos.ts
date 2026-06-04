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

  async getTxData(txHash: string, tokenAddress: string, recipientAddress: string): Promise<TransactionData | undefined> {
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

    let denom = tokenAddress;
    if (tokenAddress === "0x0") {
      denom = this.nativeDenom;
    }

    // Pick the transfer event addressed to the expected recipient — the first transfer event is
    // usually the fee payment (sender → fee_collector), not the actual send.
    const transfer = (result.tx_result.events || [])
      .filter((e: any) => e.type === 'transfer')
      .map((e: any) => this.parseEventAttributes(e.attributes))
      .find((attrs: Record<string, string>) =>
        attrs.recipient?.toLowerCase() === recipientAddress?.toLowerCase() &&
        this.parseDenomAmount(attrs.amount || '', denom) !== null
      );

    if (!transfer) {
      log.warn(`Transaction ${txHash} has no transfer of ${denom} to ${recipientAddress}`);

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
      from: transfer.sender || '',
      to: transfer.recipient || '',
      token: tokenAddress,
      amount: this.parseDenomAmount(transfer.amount || '', denom)!,
      confirmed
    }
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

  private parseEventAttributes(attributes: any[]): Record<string, string> {
    const isPlainText = attributes.some((a: any) =>
      ['sender', 'recipient', 'amount', 'spender', 'receiver'].includes(a.key)
    );

    const result: Record<string, string> = {};

    for (const attr of attributes) {
      if (isPlainText) {
        result[attr.key] = attr.value || '';
      } else {
        result[Buffer.from(attr.key, 'base64').toString('utf-8')] =
          attr.value ? Buffer.from(attr.value, 'base64').toString('utf-8') : '';
      }
    }

    return result;
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
