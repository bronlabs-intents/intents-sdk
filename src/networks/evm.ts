import { ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { AttestationCapable, SignatureScheme, verifySecp256k1 } from '../attestation.js';
import { decodeErc6909TransferAmount } from '../token.js';
import { log, memoize } from '../utils.js';
import { proxyFetch } from '../proxy.js';

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC6909_TRANSFER_TOPIC = ethers.id('Transfer(address,address,address,uint256,uint256)');
const ERC6909_DECIMALS_SELECTOR = '0x3f47e662';
const ERC165_SUPPORTS_INTERFACE_SELECTOR = '0x01ffc9a7';
const ERC6909_INTERFACE_ID = '0x0f632fb3';

interface EthTransactionReceipt {
  status: string;
  from: string;
  to: string;
  blockNumber: string;
  logs: {
    address: string;
    topics: string[];
    data: string;
  }[];
}

export class EvmNetwork implements Network, AttestationCapable {
  private readonly rpcUrl: string;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly confirmations: number;
  private readonly nativeAssetDecimals: number = 18;
  readonly retryDelay: number = 15000;
  readonly signatureScheme = SignatureScheme.Secp256k1;

  constructor(rpcUrl: string, confirmations: number = 6) {
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    this.confirmations = confirmations;
  }

  async ping(): Promise<void> {
    await this.provider.getBlockNumber();
  }

  addressFromPublicKey(publicKey: string): string {
    return ethers.computeAddress(publicKey);
  }

  verifyAttestation(publicKey: string, signature: string, preimage: Uint8Array): boolean {
    return verifySecp256k1(publicKey, signature, preimage);
  }

  async supportsInterface(tokenAddress: string, interfaceId: string): Promise<boolean> {
    return memoize(`supports-interface-${this.rpcUrl}-${tokenAddress}-${interfaceId}`, 86400 * 1000, async () => {
      const { result } = await proxyFetch(this.rpcUrl, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "eth_call",
          params: [
            {
              to: tokenAddress,
              data: ERC165_SUPPORTS_INTERFACE_SELECTOR + interfaceId.slice(2).padStart(8, '0').padEnd(64, '0')
            },
            "latest"
          ]
        })
      }).then((res) => res.json());

      return !!result && result !== "0x" && BigInt(result) !== 0n;
    });
  }

  async isErc6909(tokenAddress: string): Promise<boolean> {
    return this.supportsInterface(tokenAddress, ERC6909_INTERFACE_ID);
  }

  async getDecimals(tokenAddress: string, tokenId?: bigint): Promise<number> {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    if (tokenId !== undefined && !(await this.isErc6909(tokenAddress))) {
      throw new Error(`Token ${tokenAddress} carries tokenId ${tokenId} but does not support the ERC6909 interface`);
    }

    const callData = tokenId !== undefined
      ? ERC6909_DECIMALS_SELECTOR + tokenId.toString(16).padStart(64, '0')
      : "0x313ce567";

    return memoize(`decimals-${this.rpcUrl}-${tokenAddress}-${tokenId ?? ''}`, 86400 * 1000, async () => {
      const { result } = await proxyFetch(this.rpcUrl, {
        method: 'POST',
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "eth_call",
          params: [
            {
              to: tokenAddress,
              data: callData
            },
            "latest"
          ]
        })
      }).then((res) => res.json());

      if (!result || result === "0x") {
        throw new Error(`No on-chain decimals for ${tokenAddress}${tokenId !== undefined ? ` id ${tokenId}` : ''}`);
      }

      return parseInt(result, 16);
    });
  }

  async getTxData(txHash: string, tokenAddress: string, recipientAddress: string, tokenId?: bigint): Promise<TransactionData | undefined> {
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

    // ERC6909 multi-token — match the 4-topic Transfer(caller, sender, receiver, id, amount) of the
    // expected id; amount is the 2nd 32-byte data word (1st is caller), NOT BigInt(data).
    if (tokenId !== undefined) {
      if (!(await this.isErc6909(tokenAddress))) {
        throw new Error(`Token ${tokenAddress} carries tokenId ${tokenId} but does not support the ERC6909 interface`);
      }

      const idHex = '0x' + tokenId.toString(16).padStart(64, '0');

      const erc6909Log = receipt.logs.find(l =>
        l.address?.toLowerCase() === tokenAddress.toLowerCase() &&
        l.topics[0]?.toLowerCase() === ERC6909_TRANSFER_TOPIC.toLowerCase() &&
        l.topics.length === 4 &&
        ('0x' + l.topics[2].slice(26)).toLowerCase() === recipientAddress.toLowerCase() &&
        l.topics[3]?.toLowerCase() === idHex.toLowerCase()
      );

      if (!erc6909Log) {
        log.warn(`Transaction ${txHash} has no ERC6909 Transfer of ${tokenAddress} id ${tokenId} to ${recipientAddress}`);

        return {
          from: "",
          to: "",
          token: "",
          amount: 0n,
          confirmed
        };
      }

      return {
        from: '0x' + erc6909Log.topics[1].slice(26),
        to: '0x' + erc6909Log.topics[2].slice(26),
        token: erc6909Log.address,
        tokenId: BigInt(erc6909Log.topics[3]),
        amount: decodeErc6909TransferAmount(erc6909Log.data),
        confirmed
      };
    }

    // ERC20 token — trust only a Transfer emitted by the token contract itself, to the expected
    // recipient. Reading logs[0] blindly lets approve() / events from other contracts satisfy
    // validation with no real transfer.
    const transferLog = receipt.logs.find(l =>
      l.address?.toLowerCase() === tokenAddress.toLowerCase() &&
      l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase() &&
      l.topics.length === 3 &&
      ('0x' + l.topics[2].slice(26)).toLowerCase() === recipientAddress.toLowerCase()
    );

    if (!transferLog) {
      log.warn(`Transaction ${txHash} has no ERC20 Transfer of ${tokenAddress} to ${recipientAddress}`);

      return {
        from: "",
        to: "",
        token: "",
        amount: 0n,
        confirmed
      };
    }

    return {
      from: '0x' + transferLog.topics[1].slice(26),
      to: '0x' + transferLog.topics[2].slice(26),
      token: transferLog.address,
      amount: BigInt(transferLog.data),
      confirmed
    };
  }

  /**
   * @deprecated Signs from a raw private key — do not use in production. Kept for local tooling/tests.
   */
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
