import { ethers } from 'ethers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

enum OrderStatus {
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
  baseAmount: number;
  quoteAmount: number;
  price_e18: number;
  maxPrice_e18: number;
  auctionDuration: number;
  orderValueInUSD_e18: number;
  liquidationReceiver: string;
}

interface Order {
  status: OrderStatus;
  user: string;
  solver: string;
  baseParams: BaseParams;
  quoteParams: QuoteParams;
  pricingParams: PricingParams;
  updatedAt: number;
  createdAt: number;
}

interface NetworkParams {
  gasLimit: number;
}

export interface OrderEngineContract extends ethers.Contract {

  createOrder(params: {
    orderId: string;
    baseNetworkId: string;
    baseTokenAddress: string;
    quoteNetworkId: string;
    quoteTokenAddress: string;
    userAddress: string;
    baseAmount: ethers.BigNumberish;
    quoteAmount: ethers.BigNumberish;
    orderValueInUSD_e18: ethers.BigNumberish;
    maxPrice_e18: ethers.BigNumberish;
    auctionDuration: ethers.BigNumberish;
    liquidationReceiver: string;
  }, networkParams?: NetworkParams): Promise<ethers.ContractTransaction>;

  getOrder(orderId: string): Promise<Order>;

  solverReact(orderId: string, amount: ethers.BigNumberish, price: ethers.BigNumberish, params?: NetworkParams): Promise<ethers.ContractTransaction>;

  setUserTxOnBaseNetwork(orderId: string, txHash: string, params?: NetworkParams): Promise<ethers.ContractTransaction>;

  setSolverTxOnQuoteNetwork(orderId: string, txHash: string, params?: NetworkParams): Promise<ethers.ContractTransaction>;

  setOracleConfirmUserTx(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransaction>;

  setOracleConfirmSolverTx(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransaction>;

  executeUserTimeout(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransaction>;

  executeSolverTimeout(orderId: string, params?: NetworkParams): Promise<ethers.ContractTransaction>;
}

export function initOrderEngine(orderEngineAddress: string, provider: ethers.providers.JsonRpcProvider | ethers.Signer): OrderEngineContract {
  return new ethers.Contract(
    orderEngineAddress,
    JSON.parse(fs.readFileSync(path.join(__dirname, '../abi/OrderEngine.json'), 'utf8')),
    provider
  ) as OrderEngineContract;
}

export function initOracleAggregator(oracleAggregatorAddress: string, provider: ethers.providers.JsonRpcProvider | ethers.Signer): ethers.Contract {
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
