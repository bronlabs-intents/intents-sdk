export interface NetworkConfig {
  rpcUrl: string;
  walletAddress?: string
  walletPrivateKey?: string;
}

export interface IntentsConfig {
  rpcUrl: string;
  orderEngineAddress: string;
  oracleAggregatorAddress?: string;
  oraclePrivateKey?: string;
  solverPrivateKey?: string;
  startBlockOffset: number;
  pollingInterval: number;
  maxRetries: number;
  retryDelay: number;


  networks: {
    [key: string]: NetworkConfig;
  };
}
