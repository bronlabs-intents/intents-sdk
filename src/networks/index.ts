import { NetworkConfig } from '../config.js';

import { EvmNetwork } from './evm.js';
import { TrxNetwork } from './trx.js';
import { SolNetwork } from './sol.js';
import { TonNetwork } from './ton.js';
import { BronCantonNetwork } from './bron-canton.js';
import { BtcNetwork } from './btc.js';
import { CosmosNetwork } from "./cosmos.js";
import { XrpNetwork } from './xrp.js';
import { HbarNetwork } from './hbar.js';
import { TaoNetwork } from './tao.js';

export { BronCantonNetwork, BtcNetwork, CosmosNetwork, EvmNetwork, HbarNetwork, SolNetwork, TaoNetwork, TonNetwork, TrxNetwork, XrpNetwork };

export interface TransactionData {
  from: string;
  to: string;
  token: string;
  tokenId?: bigint;
  amount: bigint;
  confirmed: boolean;
  timestamp: number;
  envelopeFrom?: string;
  txId?: string;
}

export interface Network {

  ping(): Promise<void>;

  getDecimals(tokenAddress: string, tokenId?: bigint): Promise<number>;

  // tokenId and, on mint-hosting networks, envelopeFrom MUST be populated or the oracle's id and method-2 checks fail.
  getTxData(txHash: string, tokenAddress: string, recipientAddress: string, tokenId: bigint | undefined, senderAddress: string, notBefore?: number): Promise<TransactionData | undefined>;

  transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string>;

  readonly retryDelay: number;

  reconcileInterval?: number;
  TBAWaitPeriodSeconds?: number;
}

const networkBuilders = {
  "testBTC": (cf: NetworkConfig) => new BtcNetwork(cf.rpcUrl, 1),
  "testETH": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 1),
  "testOP": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 10),
  "testTRX": (cf: NetworkConfig) => new TrxNetwork(cf.rpcUrl, 10),
  "testSOL": (cf: NetworkConfig) => new SolNetwork(cf.rpcUrl, 10),
  "testCC": (cf: NetworkConfig) => new BronCantonNetwork("testCC", cf.bronApiUrl, cf.bronApiKey, cf.daUtilitiesApiUrl),
  "testXRP": (cf: NetworkConfig) => new XrpNetwork(cf.rpcUrl, 1),
  "testGNK": (cf: NetworkConfig) => new CosmosNetwork(cf.rpcUrl, 'ngonka', 'gonka', 0, 1),
  "testHBAR": (cf: NetworkConfig) => new HbarNetwork(cf.rpcUrl),
  
  "BTC": (cf: NetworkConfig) => new BtcNetwork(cf.rpcUrl, 2),
  "ETH": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 4),
  "OP": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 20),
  "BSC": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 15),
  "BASE": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 2),
  "POL": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 30),
  "ARB": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 2),
  "hyperEVM": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 2),
  "TRX": (cf: NetworkConfig) => new TrxNetwork(cf.rpcUrl, 20),
  "SOL": (cf: NetworkConfig) => new SolNetwork(cf.rpcUrl, 20),
  "TON": (cf: NetworkConfig) => new TonNetwork(cf.rpcUrl, 20),
  "CC": (cf: NetworkConfig) => new BronCantonNetwork("CC", cf.bronApiUrl, cf.bronApiKey, cf.daUtilitiesApiUrl),
  "GNK": (cf: NetworkConfig) => new CosmosNetwork(cf.rpcUrl, 'ngonka', 'gonka', 0, 1),
  "XRP": (cf: NetworkConfig) => new XrpNetwork(cf.rpcUrl, 1),
  "HBAR": (cf: NetworkConfig) => new HbarNetwork(cf.rpcUrl),
  "MON": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 10),
  "AVAXC": (cf: NetworkConfig) => new EvmNetwork(cf.rpcUrl, 2),
  "TAO": (cf: NetworkConfig) => new TaoNetwork(cf.rpcUrl),
}

export const initNetworks = (configs: { [key: string]: NetworkConfig }, filter?: (cfg: NetworkConfig) => boolean) =>
  Object.entries(networkBuilders).reduce((acc, [networkName, builder]) => {
    if ((configs[networkName]?.rpcUrl || configs[networkName]?.bronApiUrl) && (!filter || filter(configs[networkName]))) {
      acc[networkName] = builder(configs[networkName])
      acc[networkName].reconcileInterval = configs[networkName].reconcileInterval;
      acc[networkName].TBAWaitPeriodSeconds = configs[networkName].TBAWaitPeriodSeconds;
    }

    return acc;
  }, {} as Record<string, Network>)
