import Big from 'big.js';
import { Wallet } from 'xrpl';

import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';
import { proxyFetch } from '../proxy.js';

const DEFAULT_ISSUED_CURRENCY_DECIMALS = 15;

export class XrpNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly authHeaders: Record<string, string> = {};
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 6;
  readonly retryDelay: number = 10000;

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

  async ping(): Promise<void> {
    await this.rpcCall('server_info');
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    const { issuer, currency } = this.parseTokenAddress(tokenAddress);

    try {
      const accountInfo = await this.rpcCall('account_info', { account: issuer, ledger_index: 'validated' });
      const domainHex = accountInfo?.account_data?.Domain;

      if (!domainHex) {
        log.warn(`XRP issuer ${issuer} has no Domain field, using default decimals ${DEFAULT_ISSUED_CURRENCY_DECIMALS}`);
        return DEFAULT_ISSUED_CURRENCY_DECIMALS;
      }

      const domain = Buffer.from(domainHex, 'hex').toString('utf-8');
      const tomlUrl = `https://${domain}/.well-known/xrp-ledger.toml`;

      const resp = await proxyFetch(tomlUrl);

      if (!resp.ok) {
        log.warn(`Failed to fetch ${tomlUrl}: ${resp.status}, using default decimals`);
        return DEFAULT_ISSUED_CURRENCY_DECIMALS;
      }

      const toml = await resp.text();
      const decimals = this.parseTomlDecimals(toml, currency);

      if (decimals !== null) {
        log.info(`Fetched decimals for ${currency}:${issuer} from ${tomlUrl}: ${decimals}`);
        return decimals;
      }

      log.warn(`No display_decimals found for ${currency} in ${tomlUrl}, using default ${DEFAULT_ISSUED_CURRENCY_DECIMALS}`);
      return DEFAULT_ISSUED_CURRENCY_DECIMALS;
    } catch (e) {
      log.warn(`Failed to fetch decimals for ${tokenAddress}: ${e}, using default ${DEFAULT_ISSUED_CURRENCY_DECIMALS}`);
      return DEFAULT_ISSUED_CURRENCY_DECIMALS;
    }
  }

  async getTxData(
    txHash: string,
    tokenAddress: string,
    recipientAddress: string
  ): Promise<TransactionData | undefined> {
    const result = await this.rpcCall('tx', { transaction: txHash, binary: false });

    if (!result || result.error || result.status === 'error') {
      return;
    }

    if (result.TransactionType !== 'Payment') {
      log.warn(`Transaction ${txHash} is not a Payment: ${result.TransactionType}`);
      return;
    }

    if (!result.validated) {
      return;
    }

    const meta = result.meta || result.metaData;

    const currentLedger = await this.getCurrentValidatedLedger();
    const confirmed = currentLedger - result.ledger_index >= this.confirmations;

    if (!meta || meta.TransactionResult !== 'tesSUCCESS') {
      log.warn(`Transaction ${txHash} failed: ${meta?.TransactionResult}`);
      return { from: "", to: "", token: "", amount: 0n, confirmed };
    }

    if (result.Destination !== recipientAddress) {
      log.warn(`Transaction ${txHash} destination ${result.Destination} does not match ${recipientAddress}`);
      return { from: "", to: "", token: "", amount: 0n, confirmed };
    }

    const deliveredAmount = meta.delivered_amount;

    if (deliveredAmount === undefined || deliveredAmount === null) {
      log.warn(`Transaction ${txHash} has no delivered_amount`);
      return;
    }

    log.info(`Confirmations ${txHash}: ${currentLedger - result.ledger_index}`);

    if (tokenAddress === "0x0") {
      if (typeof deliveredAmount !== 'string') {
        log.warn(`Transaction ${txHash} native delivered_amount is not a string: ${typeof deliveredAmount}`);
        return;
      }

      return {
        from: result.Account,
        to: result.Destination,
        token: tokenAddress,
        amount: BigInt(deliveredAmount),
        confirmed
      };
    }

    if (typeof deliveredAmount !== 'object' || !deliveredAmount.value || !deliveredAmount.currency || !deliveredAmount.issuer) {
      log.warn(`Transaction ${txHash} issued delivered_amount is malformed`);
      return;
    }

    const { currency, issuer } = this.parseTokenAddress(tokenAddress);

    if (deliveredAmount.currency !== currency || deliveredAmount.issuer !== issuer) {
      log.warn(`Transaction ${txHash} delivered ${deliveredAmount.currency}:${deliveredAmount.issuer} does not match ${currency}:${issuer}`);
      return { from: "", to: "", token: "", amount: 0n, confirmed };
    }

    const decimals = await this.getDecimals(tokenAddress);

    const amount = BigInt(
      new Big(deliveredAmount.value)
        .times(new Big(10).pow(decimals))
        .toFixed(0)
    );

    return {
      from: result.Account,
      to: result.Destination,
      token: tokenAddress,
      amount,
      confirmed
    };
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

  private parseTomlDecimals(toml: string, currency: string): number | null {
    const sections = toml.split('[[CURRENCIES]]');

    for (const section of sections) {
      const codeMatch = section.match(/code\s*=\s*"([^"]+)"/);
      const decimalsMatch = section.match(/display_decimals\s*=\s*(\d+)/);

      if (codeMatch && codeMatch[1] === currency && decimalsMatch) {
        return parseInt(decimalsMatch[1]);
      }
    }

    return null;
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
