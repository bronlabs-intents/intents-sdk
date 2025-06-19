import { BigNumber } from 'ethers';
import { NetworkConfig } from '../config.js';

import { EvmNetwork } from './evm.js';
import { TrxNetwork } from './trx.js';
import { SolNetwork } from './sol.js';

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

const networkBuilders = {
  "testETH": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 1),
  "testTRX": (cf: NetworkConfig) => new TrxNetwork(cf.rpcUrl, 1),
  "testSOL": (cf: NetworkConfig) => new SolNetwork(cf.rpcUrl, 1),

  "ETH": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl),
  "TRX": (cf: NetworkConfig) => new TrxNetwork(cf.rpcUrl),
  "SOL": (cf: NetworkConfig) => new SolNetwork(cf.rpcUrl)
}

export const initNetworks = (configs: { [key: string]: NetworkConfig }, filter?: (cfg: NetworkConfig) => boolean) =>
  Object.entries(networkBuilders).reduce((acc, [networkName, builder]) => {
    if (configs[networkName]?.rpcUrl && (!filter || filter(configs[networkName]))) {
      acc[networkName] = builder(configs[networkName])
    }

    return acc;
  }, {} as Record<string, Network>)
