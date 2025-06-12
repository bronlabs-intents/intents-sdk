export interface NetworkConfig {
  rpcUrl: string;
}

export interface IntentsConfig {
  rpcUrl: string;
  orderEngineAddress: string;
  oracleAggregatorAddress: string;
  oraclePrivateKey: string;
  startBlockOffset: number;
  pollingInterval: number;
  maxRetries: number;
  retryDelay: number;


  networks: {
    [key: string]: NetworkConfig;
  };
}
