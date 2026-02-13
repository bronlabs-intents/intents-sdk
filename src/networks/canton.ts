import { HttpsProxyAgent } from 'https-proxy-agent';
import * as ed25519 from '@noble/ed25519';
import fetch from 'node-fetch';

import { Network, TransactionData } from './index.js';
import { log, expRetry, memoize } from '../utils.js';
import { Big } from 'big.js';
import { ethers } from "ethers";


export class CantonNetwork implements Network {
  private readonly scanApiUrl: string;
  private readonly validatorApiUrl: string;
  private readonly ledgerApiUrl?: string;
  private readonly authUrl: string;

  private readonly daUtilitiesApiUrl: string;

  private readonly nativeAssetDecimals: number = 10;
  readonly retryDelay: number = 5000;

  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly senderPartyId?: string;

  private readonly proxyAgent?: HttpsProxyAgent<string>;

  private accessToken?: string;
  private accessTokenExpiresAt: number = 0;

  constructor(
    validatorApiUrl: string,
    ledgerApiUrl?: string,
    scanApiUrl?: string,
    authUrl?: string,
    clientId?: string,
    clientSecret?: string,
    senderPartyId?: string,
    daUtilitiesApiUrl?: string
  ) {
    this.validatorApiUrl = validatorApiUrl;
    this.scanApiUrl = scanApiUrl || validatorApiUrl;
    this.ledgerApiUrl = ledgerApiUrl;
    this.authUrl = authUrl || 'https://mainnet-canton-mpch.eu.auth0.com';
    this.daUtilitiesApiUrl = daUtilitiesApiUrl || 'https://api.utilities.digitalasset.com';

    this.proxyAgent = process.env.HTTP_PROXY ? new HttpsProxyAgent(process.env.HTTP_PROXY, {
      rejectUnauthorized: false
    }) : undefined;

    this.clientId = clientId;
    this.clientSecret = clientSecret;

    this.senderPartyId = senderPartyId;
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    if (tokenAddress === '0x0') {
      return this.nativeAssetDecimals;
    }

    const [tokenIssuer, tokenInstrumentId] = tokenAddress.split(':::')

    return await memoize(`cc-decimals-${tokenIssuer}-${tokenInstrumentId}`, 86_400_000, async () => {
      const resp = await fetch(`${this.daUtilitiesApiUrl}/api/token-standard/v0/registrars/${tokenIssuer}/registry/metadata/v1/instruments/${tokenInstrumentId}`, {
        method: 'GET',
        agent: this.proxyAgent
      });

      if (!resp.ok) {
        throw new Error(`Failed to get token metadata from ${this.daUtilitiesApiUrl}/api/token-standard/v0/registrars/${tokenIssuer}/registry/metadata/v1/instruments/${tokenInstrumentId}: ${resp.status} - ${await resp.text()}`);
      }

      return (await resp.json()).decimals;
    });
  }

  async getTxData(txHash: string, tokenAddress: string): Promise<TransactionData | undefined> {
    const updateId = txHash.split(':')[0];

    const baseEventFormat = {
      filtersByParty: {},
      filtersForAnyParty: {},
      verbose: false
    };

    const fetchUpdate = (id: string) =>
      this.nodeRequest({
        method: 'POST',
        node: this.ledgerApiUrl,
        uri: `/v2/updates/update-by-id`,
        body: {
          updateId: id,
          updateFormat: {
            includeTransactions: {
              transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
              eventFormat: baseEventFormat
            }
          }
        }
      });

    const json = await fetchUpdate(updateId);

    if (!json || json.error || !json.update?.Transaction) {
      throw new Error(`Couldn't get Canton tx data for ${txHash}: ${json?.error || 'unknown error'}`);
    }

    const txValue = json.update.Transaction.value;

    if (txValue.updateId !== txHash) {
      throw new Error(`Invalid Canton tx hash: order = ${txHash}, tx = ${json.update.Transaction.value?.updateId}`);
    }

    const events = txValue.events as any[];
    const transferFactoryEvent = events.find(e => e.ExercisedEvent?.choice === 'TransferFactory_Transfer');

    const transferFactoryResultTag = transferFactoryEvent?.ExercisedEvent?.exerciseResult?.output?.tag;

    if (!transferFactoryResultTag) {
      log.error(`Transaction ${txHash} has missing transferFactoryResultTag: ${JSON.stringify(txValue)}`);
      return
    }

    const isSuccess = tokenAddress === '0x0' ?
      transferFactoryResultTag === 'TransferInstructionResult_Completed' :
      transferFactoryResultTag === 'TransferInstructionResult_Pending';

    if (!isSuccess) {
      log.error(`Transaction ${txHash} failed: ${(transferFactoryResultTag ?? 'Unknown')}`);

      return {
        to: "",
        token: "",
        amount: 0n,
        confirmed: true
      };
    }

    if (tokenAddress === '0x0') {
      const transfer: any = events.find(e => e.ExercisedEvent?.choice === 'AmuletRules_Transfer');

      const output = transfer?.ExercisedEvent?.choiceArgument?.transfer?.outputs[0] || {
        receiver: '',
        amount: '0'
      };

      const amount = BigInt(Big(output.amount).mul(Big(10).pow(this.nativeAssetDecimals)).toFixed(0));

      return {
        to: output.receiver,
        token: tokenAddress,
        amount,
        confirmed: true
      };
    }

    // tokens

    const arg = transferFactoryEvent?.ExercisedEvent?.choiceArgument?.transfer;
    const resultOutput = transferFactoryEvent?.ExercisedEvent?.exerciseResult?.output;

    const contractId = resultOutput?.value?.transferInstructionCid;
    const receiver = arg?.receiver;
    const amount = arg?.amount;
    const txTokenAddress = arg?.instrumentId?.admin + ':::' + arg?.instrumentId?.id;
    const tokenDecimals = await this.getDecimals(txTokenAddress);

    const eventsByContract = await this.nodeRequest({
      node: this.ledgerApiUrl,
      method: 'POST',
      uri: `/v2/events/events-by-contract-id`,
      body: {
        contractId,
        eventFormat: { ...baseEventFormat, verbose: true }
      },
      retry: false
    });

    const offset = eventsByContract.archived?.archivedEvent?.offset;

    if (offset === undefined) {
      log.info(`No archived events found for ${txHash}, probably token transaction not accounted yet, return...`);
      return;
    }

    const filters = await this.buildIdentifierFilter({ partyIds: [receiver] });

    const receiverUpdates = await this.nodeRequest({
      node: this.ledgerApiUrl,
      method: 'POST',
      uri: `/v2/updates?limit=100&stream_idle_timeout_ms=10000`,
      body: {
        filter: filters,
        verbose: false,
        beginExclusive: offset - 1,
        endInclusive: offset
      },
      retry: false
    });

    const receiverUpdateId = receiverUpdates?.[0]?.update?.Transaction?.value?.updateId;

    const result = await fetchUpdate(receiverUpdateId);
    const resultEvents = result.update.Transaction.value?.events as any[];
    const resultAcceptEvent = resultEvents.find(e => e.ExercisedEvent?.choice === 'TransferInstruction_Accept');

    const tokenResultTag = resultAcceptEvent?.ExercisedEvent?.exerciseResult?.output?.tag

    if (!tokenResultTag) {
      log.error(`Transaction ${txHash} has missing tokenResultTag: ${JSON.stringify(resultAcceptEvent)}`);
      return
    }

    if (tokenResultTag === "TransferInstructionResult_Completed") {
      return {
        to: receiver,
        token: txTokenAddress,
        amount: ethers.parseUnits(amount, tokenDecimals),
        confirmed: true
      };
    } else {
      log.error(`Transaction ${txHash} has wrong tokenResultTag: ${tokenResultTag}`);

      return {
        to: "",
        token: "",
        amount: 0n,
        confirmed: true
      };
    }
  }

  async transfer(privateKey: string, to: string, value: bigint, tokenAddress: string): Promise<string> {
    if (tokenAddress != '0x0') {
      throw new Error("Canton does not support tokens");
    }

    const publicKey = ed25519.utils.getExtendedPublicKey(Buffer.from(privateKey, 'hex')).point.toHex().toUpperCase();

    let nonce;
    try {
      const resp = await this.nodeRequest({
        method: 'GET',
        uri: `/v0/scan-proxy/transfer-command-counter/${this.senderPartyId}`,
        retry: false
      });

      nonce = parseInt(resp.transfer_command_counter.contract.payload.nextNonce, 10);
    } catch (e) {
      if (e instanceof Error && e.message.includes('No TransferCommandCounter found for party')) {
        nonce = 0;
      } else {
        throw e;
      }
    }

    const prepareSend = await this.nodeRequest({
      method: 'POST',
      uri: `/v0/admin/external-party/transfer-preapproval/prepare-send`,
      body: {
        "sender_party_id": this.senderPartyId,
        "receiver_party_id": to,
        "amount": Big(value.toString()).div(Big(10).pow(this.nativeAssetDecimals)).toFixed(this.nativeAssetDecimals),
        "expires_at": new Date(Date.now() + 86400000).toISOString(),
        "nonce": nonce
      }
    });

    const { update_id } = await this.nodeRequest({
      method: 'POST',
      uri: `/v0/admin/external-party/transfer-preapproval/submit-send`,
      body: {
        "submission": {
          "party_id": this.senderPartyId,
          "transaction": prepareSend.transaction,
          "signed_tx_hash": Buffer.from(await ed25519.sign(prepareSend.tx_hash, Buffer.from(privateKey, 'hex'))).toString('hex').toUpperCase(),
          "public_key": publicKey
        }
      }
    });

    return expRetry(async () => {
      log.info(`Waiting for transaction ${update_id} confirmation...`);

      const result = await fetch(`${this.scanApiUrl}/v2/updates/${update_id}`, {
        method: 'GET',
        agent: this.proxyAgent
      });

      if (!result.ok) {
        throw new Error(`Couldn't get Canton tx data for ${update_id}: ${result.status} ${result.statusText}`);
      }

      const json = await result.json();

      if (!json || json.error) {
        throw new Error(`Couldn't get Canton tx data for ${update_id}: ${json?.error || 'unknown error'}`);
      }

      const event: any = Object.values(json.events_by_id)
        .find((e: any) => e.event_type == 'exercised_event' && e.choice == 'ExternalPartyAmuletRules_CreateTransferCommand');

      const transferCommandCid = event?.exercise_result?.transferCommandCid;

      if (!transferCommandCid) {
        throw new Error(`Couldn't find transfer command cid in Canton tx data for ${update_id}`);
      }

      return `${update_id}:${transferCommandCid}`;
    }, 10);
  }

  private async buildIdentifierFilter(opts: {
    partyIds?: string[];
    templateIds?: string[];
    interfaceIds?: string[];
  }) {
    const { partyIds, templateIds = [], interfaceIds = [] } = opts;
    const cumulative: any[] = [];

    for (const t of templateIds) {
      cumulative.push({
        identifierFilter: {
          TemplateFilter: {
            value: {
              templateId: t,
              includeInterfaceView: true,
              includeCreatedEventBlob: false
            }
          }
        }
      });
    }
    for (const iface of interfaceIds) {
      cumulative.push({
        identifierFilter: {
          InterfaceFilter: {
            value: {
              interfaceId: iface,
              includeInterfaceView: true,
              includeCreatedEventBlob: false
            }
          }
        }
      });
    }

    if (partyIds && partyIds.length) {
      const filtersByParty: Record<string, any> = {};
      for (const p of partyIds) filtersByParty[p] = { cumulative };
      return { filtersByParty };
    }
    return { filtersForAnyParty: { cumulative } };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 30_000) {
      return this.accessToken;
    }

    const response = await fetch(`${this.authUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        'client_id': this.clientId,
        'client_secret': this.clientSecret,
        'audience': 'https://canton.network.global',
        'grant_type': 'client_credentials'
      }),
      agent: this.proxyAgent
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token from ${this.authUrl}/oauth/token: ${response.status} - ${await response.text()}`);
    }

    const data = await response.json();

    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + (data.expires_in * 1000);

    return this.accessToken!;
  }

  private async nodeRequest({ method, uri, body = undefined, node = undefined, retry = true }: {
    method: string,
    uri: string,
    body?: any,
    node?: string;
    retry?: boolean
  }): Promise<any> {
    return expRetry(async () => {
      const start = Date.now()
      const accessToken = await this.getAccessToken();

      const resp = await fetch(`${node || this.validatorApiUrl}${uri}`, {
        method,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        agent: this.proxyAgent
      })

      let msg = `${method} ${node || this.validatorApiUrl}${uri} - ${resp.status} ${resp.statusText} (${Date.now() - start}ms)`

      if (!resp.ok) {
        msg += `: ${await resp.text()}`
        log.error(msg)

        throw new Error(`Failed to ${msg}`);
      }

      log.info(msg)

      return await resp.json();
    }, retry ? 3 : 0)
  }
}
