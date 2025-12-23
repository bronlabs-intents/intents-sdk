export interface NetworkConfig {
  rpcUrl: string;
  rpcAuthToken?: string;
  walletAddress?: string
  walletPrivateKey?: string;
  scanApiUrl?: string;
  ledgerApiUrl?: string;
  authUrl?: string;
  clientId?: string;
  clientSecret?: string;
  daUtilitiesApiUrl?: string;
  reconcileInterval?: number;
}

export interface IntentsConfig {
  rpcUrl: string;
  rpcAuthToken?: string;
  orderEngineAddress: string;
  oracleAggregatorAddress?: string;
  oraclePrivateKey?: string;
  solverPrivateKey?: string;
  startBlockOffset: number;
  pollingInterval: number;
  maxRetries: number;
  retryDelay: number;

  networks?: {
    [key: string]: NetworkConfig;
  };
}
