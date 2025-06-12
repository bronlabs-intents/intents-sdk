const { BigNumber, ethers } = require('ethers');

class EvmNetwork {
  constructor(rpcUrl, nativeAssetDecimals) {
    this.rpcUrl              = rpcUrl;
    this.provider            = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.retryDelay          = 3000;
    this.confirmations       = 30;
    this.nativeAssetDecimals = nativeAssetDecimals;
  }

  async getDecimals(tokenAddress) {
    if (tokenAddress === "0x0") {
      return this.nativeAssetDecimals;
    }

    const { result } = await fetch(this.rpcUrl, {
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
    }).then(r => r.json());

    return parseInt(result, 16);
  }

  async getTxData(txHash, tokenAddress) {
    let txTo, txToken, txAmount;

    const currentBlock = await this.provider.getBlockNumber();

    // ETH
    if (tokenAddress === "0x0") {
      const { result } = await fetch(this.rpcUrl, {
        method: 'POST',
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_getTransactionByHash", params: [txHash] })
      }).then(r => r.json())

      if (!result) {
        return;
      }

      return {
        to: result.to,
        token: tokenAddress,
        amount: BigNumber.from(result.value),
        confirmed: (currentBlock - result.blockNumber) >= this.confirmations,
      };
    }

    const { result } = await fetch(this.rpcUrl, {
      method: 'POST',
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [txHash] })
    }).then(res => res.json());

    if (!result) {
      return;
    }

    return {
      to: '0x' + result.logs[0].topics[2].slice(26),
      token: result.to,
      amount: BigNumber.from(result.logs[0].data),
      confirmed: (currentBlock - result.blockNumber) >= this.confirmations,
    };
  }
}

module.exports = { EvmNetwork };
