import { BigNumber, ethers } from 'ethers';

import { Network, TransactionData } from './index.js';
import { log } from '../utils.js';
import * as ed25519 from '@noble/ed25519';

export class CantonNetwork implements Network {
  private readonly rpcUrl: string;
  private readonly node: string;
  private readonly nativeAssetDecimals: number = 18;
  readonly retryDelay: number = 5000;
  private readonly nativeAssetAddress: string = "00b5aad80a523ce3ca2e1e3c7b622df84efd37c5cfd00f112a64a4c48b27ad1062ca101220409710acc9bdb03ac71876b747c090d00270891ad9836ed60a6e4b8b41d8dfae";
  private accessToken: string;
  private accessTokenExpiresAt: Date;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly partyHint: string;

  constructor(rpcUrl: string, node: string, clientId: string, clientSecret: string, partyHint: string) {
    this.rpcUrl = rpcUrl;
    this.node = node;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.partyHint = partyHint;
    this.accessTokenExpiresAt = new Date(0);
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === '0x0') {
      return this.nativeAssetDecimals;
    }
    throw new Error("Canton does not support tokens");
  }

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {

    const result = await fetch(`${this.rpcUrl}/api/update/${txHash}`).then((res) => res.json());

    if (!result || result.error) {
      throw new Error(`Couldnt get Canton tx data for ${txHash}`);
    }

    const fetchedEvent = result.events_by_id.find((event: any) => event.event_type === "exercised_event" && event.choice === "AmuletRules_Transfer");
    const to = fetchedEvent.choice_argument.transfer.outputs[0].receiver;
    const amount = fetchedEvent.choice_argument.transfer.outputs[0].amount;

    // Native token - Canton
    if (tokenAddress === '0x0') {
      return {
        to: to,
        token: tokenAddress,
        amount: BigNumber.from(amount),
        confirmed: true
      };
    }

    // ERC20 token
    throw new Error("Canton does not support tokens");
  }

  async transfer(privateKey: string, to: string, value: BigNumber, tokenAddress: string): Promise<string> {

    if (this.partyHint === "" || this.node === "" || this.clientId === "" || this.clientSecret === "") {
      throw new Error("Canton network config is not set");
    }

    if (this.accessTokenExpiresAt < new Date()) {
      await this.getAccessToken();
    }

    if (tokenAddress != '0x0') {
      throw new Error("Canton does not support tokens");
    }

    // Setup
    const publicKey = (await ed25519.utils.getExtendedPublicKey(privateKey)).point.toHex().toUpperCase();

    const topology = await fetch(`${this.node}/v0/admin/external-party/topology/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({
        "party_hint": this.partyHint,
        "public_key": publicKey,
      })
    }).then((res) => res.json());

    const submitTopology = await fetch(`${this.node}/v0/admin/external-party/topology/submit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({
        "public_key": publicKey,
        "signed_topology_txs": [
          {
            "topology_tx": topology.topology_txs[0].topology_tx,
            "signed_hash": await ed25519.sign(topology.topology_txs[0].topology_tx, privateKey)
          },
          {
            "topology_tx": topology.topology_txs[1].topology_tx,
            "signed_hash": await ed25519.sign(topology.topology_txs[1].topology_tx, privateKey)
          },
          {
            "topology_tx": topology.topology_txs[2].topology_tx,
            "signed_hash": await ed25519.sign(topology.topology_txs[2].topology_tx, privateKey)
          }
        ]
      })
    }).then((res) => res.json());
    const address = submitTopology.party_id

    // const preApprovalDeploy = await fetch(`${this.node}/v0/admin/external-party/setup-proposal`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${this.accessToken}`
    //   },
    //   body: JSON.stringify({
    //      "user_party_id": address,
    //   })
    // }).then((res) => res.json());

    // const prepareAccept = await fetch(`${this.node}/v0/admin/external-party/setup-proposal/prepare-accept`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${this.accessToken}`
    //   },
    //   body: JSON.stringify({
    //      "contract_id": preApprovalDeploy.contract_id,
    //      "user_party_id": address
    //   })
    // }).then((res) => res.json());

    // const submitAccept = await fetch(`${this.node}/v0/admin/external-party/setup-proposal/submit-accept`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${this.accessToken}`
    //   },
    //   body: JSON.stringify({
    //     "submission": {
    //       "party_id": address,
    //       "transaction": prepareAccept.transaction,
    //       "signed_tx_hash": await ed25519.sign(prepareAccept.tx_hash, privateKey),
    //       "public_key": publicKey
    //     }
    //   })
    // }).then((res) => res.json());

    // Transfer
    const nonce = await fetch(`${this.node}/v0/scan-proxy/transfer-command-counter/${address}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    }).then((res) => res.json());

    const prepareSend = await fetch(`${this.node}/v0/admin/external-party/transfer-preapproval/prepare-send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({
        "sender_party_id": address,
        "receiver_party_id": to,
        "amount": value.toString(),
        "expires_at": new Date(Date.now() + 86400000).toISOString(),
        "nonce": nonce.nonce // nonce in LONG
      })
    }).then((res) => res.json());

    const submitSend = await fetch(`${this.node}/v0/admin/external-party/transfer-preapproval/submit-send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({
        "submission": {
          "party_id": address,
          "transaction": prepareSend.transaction,
          "signed_tx_hash": await ed25519.sign(prepareSend.tx_hash, privateKey),
          "public_key": publicKey
        }
      })
    }).then((res) => res.json());

    return submitSend.tx_hash;
  }

  private async getAccessToken(): Promise<void> {
    const response = await fetch(`${this.node}/oauth/token`, {
      method: 'POST',
      body: JSON.stringify({
        "client_id": this.clientId,  
        "client_secret": this.clientSecret,
        "audience": "https://canton.network.global",
        "grant_type": "client_credentials"
      })
    });
    
    const accessToken = await response.json();
    this.accessToken = accessToken.access_token;
    this.accessTokenExpiresAt = new Date(Date.now() + accessToken.expires_in * 1000);
  }
}
