import { BigNumber } from 'ethers';

export interface TransactionData {
  to: string;
  token: string;
  amount: BigNumber;
  confirmed: boolean;
}

export interface Network {

  getDecimals(tokenAddress: string): Promise<number>;

  getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined>;

  transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string>;

  readonly retryDelay: number;
}

export * from './evm.js';
export * from './trx.js';
export * from './sol.js';
