import { NetworkConfig } from '../config.js';

import { EvmNetwork } from './evm.js';
import { TrxNetwork } from './trx.js';
import { SolNetwork } from './sol.js';
import { CantonNetwork } from './canton.js';
import { BtcNetwork } from './btc.js';
import { CosmosNetwork } from "./cosmos.js";

export interface TransactionData {
  to: string;
  token: string;
  amount: bigint;
  confirmed: boolean;
}

export interface Network {

  getDecimals(tokenAddress: string): Promise<number>;

  getTxData(txHash: string, tokenAddress: string, recipientAddress: string): Promise<TransactionData | undefined>;

  transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string>;

  readonly retryDelay: number;
}

const networkBuilders = {
  "testBTC": (cf: NetworkConfig) => new BtcNetwork(cf.rpcUrl, 1),
  "testETH": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 1),
  "testOP": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 10),
  "testTRX": (cf: NetworkConfig) => new TrxNetwork(cf.rpcUrl, 10),
  "testSOL": (cf: NetworkConfig) => new SolNetwork(cf.rpcUrl, 10),
  "testCC": (cf: NetworkConfig) => new CantonNetwork(cf.rpcUrl, cf.ledgerApiUrl, cf.scanApiUrl, cf.authUrl, cf.clientId, cf.clientSecret, cf.walletAddress, cf.daUtilitiesApiUrl),

  "BTC": (cf: NetworkConfig) => new BtcNetwork(cf.rpcUrl, 2),
  "ETH": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 4),
  "OP": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 20),
  "BSC": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 15),
  "BASE": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 2),
  "POL": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 30),
  "ARB": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 2),
  "HYPE": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 15),
  "TRX": (cf: NetworkConfig) => new TrxNetwork(cf.rpcUrl, 20),
  "SOL": (cf: NetworkConfig) => new SolNetwork(cf.rpcUrl, 20),
  "CC": (cf: NetworkConfig) => new CantonNetwork(cf.rpcUrl, cf.ledgerApiUrl, cf.scanApiUrl, cf.authUrl, cf.clientId, cf.clientSecret, cf.walletAddress, cf.daUtilitiesApiUrl),
  "GNK": (cf: NetworkConfig) => new CosmosNetwork(cf.rpcUrl, 'ngonka', 'gonka', 0, 1),
  "testGNK": (cf: NetworkConfig) => new CosmosNetwork(cf.rpcUrl, 'ngonka', 'gonka', 0, 1)
}

export const initNetworks = (configs: { [key: string]: NetworkConfig }, filter?: (cfg: NetworkConfig) => boolean) =>
  Object.entries(networkBuilders).reduce((acc, [networkName, builder]) => {
    if (configs[networkName]?.rpcUrl && (!filter || filter(configs[networkName]))) {
      acc[networkName] = builder(configs[networkName])
    }

    return acc;
  }, {} as Record<string, Network>)
