import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { log, memoize } from '../utils.js';
import { proxyFetch } from '../proxy.js';

interface EthTransactionReceipt {
  status: string;
  from: string;
  to: string;
  blockNumber: string;
  logs: {
    topics: string[];
    data: string;
  }[];
}

export class EvmNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 18;
  readonly retryDelay: number = 15000;

  constructor(rpcUrl: string, confirmations: number = 6) {
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    this.confirmations = confirmations;
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    return memoize(`decimals-${this.rpcUrl}-${tokenAddress}`, 86400 * 1000, async () => {
      const { result } = await proxyFetch(this.rpcUrl, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "eth_call",
          params: [
            {
              to: tokenAddress,
              data: "0x313ce567"
            },
            "latest"
          ]
        })
      }).then((res) => res.json());

      return parseInt(result, 16);
    });
  }

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {
    const currentBlock = await this.provider.getBlockNumber();

    const { result: receiptResult } = await proxyFetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "eth_getTransactionReceipt",
        params: [txHash]
      })
    }).then((res) => res.json());

    if (!receiptResult) {
      return;
    }

    const receipt = receiptResult as EthTransactionReceipt;

    const confirmed = (currentBlock - parseInt(receipt.blockNumber, 16)) >= this.confirmations;

    log.info(`Confirmations ${txHash}: ${currentBlock - parseInt(receipt.blockNumber, 16)}, confirmed: ${confirmed}`)

    if (receipt.status !== '0x1') {
      log.warn(`Transaction ${txHash} failed on blockchain: ${JSON.stringify(receipt)}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed
      };
    }

    // Native token - ETH
    if (tokenAddress === "0x0") {
      const { result } = await proxyFetch(this.rpcUrl, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "eth_getTransactionByHash",
          params: [txHash]
        })
      }).then((res) => res.json());

      if (!result) {
        return;
      }

      const { from, to, value } = result;

      return {
        from,
        to,
        token: tokenAddress,
        amount: BigInt(value),
        confirmed
      };
    }

    // ERC20 token
    return {
      from: receipt.from,
      to: '0x' + receipt.logs[0].topics[2].slice(26),
      token: receipt.to,
      amount: BigInt(receipt.logs[0].data),
      confirmed
    };
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    const signer = new ethers.Wallet(privateKey, this.provider);

    if (tokenAddress === "0x0") {
      const { hash } = await signer.sendTransaction({ to, value });
      return hash;
    }

    const tokenContract = new ethers.Contract(tokenAddress, [
      'function transfer(address to, uint256 amount) returns (bool)'
    ], signer);

    const { hash } = await tokenContract.transfer(to, value);
    return hash;
  }
}
