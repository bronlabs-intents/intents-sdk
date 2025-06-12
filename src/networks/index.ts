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
  readonly retryDelay: number;
}

export * from './evm.js';
