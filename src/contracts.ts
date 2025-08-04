import { ethers } from 'ethers';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export enum OrderStatus {
  NOT_EXIST,
  USER_INITIATED,
  AUCTION_IN_PROGRESS,
  WAIT_FOR_USER_TX,
  WAIT_FOR_ORACLE_CONFIRM_USER_TX,
  WAIT_FOR_SOLVER_TX,
  WAIT_FOR_ORACLE_CONFIRM_SOLVER_TX,
  COMPLETED,
  LIQUIDATED,
  CANCELLED
}

interface BaseParams {
  networkId: string;
  tokenAddress: string;
  solverAddress: string;
  userTxHash: string;
}

interface QuoteParams {
  networkId: string;
  tokenAddress: string;
  userAddress: string;
  solverTxHash: string;
}

interface PricingParams {
  baseAmount: bigint;
  quoteAmount: bigint;
  price_e18: bigint;
  maxPrice_e18: bigint;
  auctionDuration: bigint;
  orderValueInUSD_e18: bigint;
  liquidationReceiver: string;
}

export interface Order {
  status: bigint;
  user: string;
  solver: string;
  baseParams: BaseParams;
  quoteParams: QuoteParams;
  pricingParams: PricingParams;
  updatedAt: bigint;
  createdAt: bigint;
}

interface NetworkParams {
  gasLimit: bigint;
}

export interface OrderEngineContract {

  createOrder(params: {
    orderId: string;
    baseNetworkId: string;
    baseTokenAddress: string;
    quoteNetworkId: string;
    quoteTokenAddress: string;
    userAddress: string;
    baseAmount: bigint;
    quoteAmount: bigint;
    orderValueInUSD_e18: bigint;
    maxPrice_e18: bigint;
    auctionDuration: bigint;
    liquidationReceiver: string;
  }, networkParams?: NetworkParams): Promise<ethers.ContractTransactionResponse>;

  getOrder(orderId: string): Promise<Order>;

  solverReact(orderId: string, solverAddressOnBaseChain: string, price: bigint, params?: NetworkParams): Promise<ethers.ContractTransactionResponse>;

  setUserTxOnBaseNetwork(orderId: string, txHash: string, params?: NetworkParams): Promise<ethers.ContractTransactionResponse>;

  setSolverTxOnQuoteNetwork(orderId: string, txHash: string, params?: NetworkParams): Promise<ethers.ContractTransactionResponse>;

  setOracleConfirmUserTx(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransactionResponse>;

  setOracleConfirmSolverTx(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransactionResponse>;

  executeUserTimeout(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransactionResponse>;

  executeSolverTimeout(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransactionResponse>;
}

export function initOrderEngine(orderEngineAddress: string, provider: ethers.JsonRpcProvider | ethers.Signer): OrderEngineContract & ethers.Contract {
  return new ethers.Contract(
    orderEngineAddress,
    JSON.parse(fs.readFileSync(path.join(__dirname, '../abi/OrderEngine.json'), 'utf8')),
    provider
  ) as OrderEngineContract & ethers.Contract;
}

export function initOracleAggregator(oracleAggregatorAddress: string, provider: ethers.JsonRpcProvider | ethers.Signer): ethers.Contract {
  return new ethers.Contract(
    oracleAggregatorAddress,
    JSON.parse(fs.readFileSync(path.join(__dirname, '../abi/OracleAggregator.json'), 'utf8')),
    provider
  );
}

export function printOrder(baseParams: BaseParams, quoteParams: QuoteParams, pricingParams: PricingParams): string {
  return JSON.stringify({
    baseParams: {
      networkId: baseParams.networkId,
      tokenAddress: baseParams.tokenAddress,
      solverAddress: baseParams.solverAddress,
      userTxHash: baseParams.userTxHash
    },
    quoteParams: {
      networkId: quoteParams.networkId,
      tokenAddress: quoteParams.tokenAddress,
      userAddress: quoteParams.userAddress,
      solverTxHash: quoteParams.solverTxHash
    },
    pricingParams: {
      baseAmount: pricingParams.baseAmount.toString(),
      quoteAmount: pricingParams.quoteAmount.toString(),
      price_e18: pricingParams.price_e18.toString(),
      maxPrice_e18: pricingParams.maxPrice_e18.toString(),
      auctionDuration: pricingParams.auctionDuration.toString(),
      orderValueInUSD_e18: pricingParams.orderValueInUSD_e18.toString(),
      liquidationReceiver: pricingParams.liquidationReceiver
    }
  }, null, 2);
}
