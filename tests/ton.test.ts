import { describe, expect, it, vi } from 'vitest';

import { beginCell } from '@ton/ton';

import { TonNetwork } from '../src/networks/ton.js';

const raw = (n: number) => `0:${n.toString(16).padStart(64, '0').toUpperCase()}`;

const OWNER_WALLET = raw(1);
const MULTISIG = raw(2);
const RECIPIENT = raw(3);
const OTHER = raw(4);
const SINK = raw(5);

const AMOUNT = '2500000000';

let ids = 0;

const message = (source: string | null, destination: string | null, value: string | null) => ({ hash: `msg-${ids++}`, source, destination, value });

const transaction = (account: string, inMsg: any, outMsgs: any[] = []) => ({
  account,
  hash: `tx-${ids++}`,
  mc_block_seqno: 50,
  now: 1700000000,
  description: { aborted: false },
  in_msg: inMsg,
  out_msgs: outMsgs
});

const consume = (msg: any, outMsgs: any[] = []) => transaction(msg.destination, msg, outMsgs);

function mockedNetwork(root: any, consumers: any[]): TonNetwork {
  const network = new TonNetwork('http://rpc', 1);
  const byMessage = new Map(consumers.map(tx => [tx.in_msg.hash, tx]));

  vi.spyOn(network as any, 'request').mockImplementation(async (...args: any[]) => {
    const path = args[0] as string;

    if (path === '/v3/masterchainInfo') {
      return { last: { seqno: 100 } };
    }

    if (path.startsWith('/v3/transactionsByMessage')) {
      const consumer = byMessage.get(decodeURIComponent(path.match(/msg_hash=([^&]+)/)![1]));
      return { transactions: consumer ? [consumer] : [] };
    }

    if (path.startsWith('/v3/transactions')) {
      return { transactions: [root] };
    }

    throw new Error(`Unexpected request ${path}`);
  });

  return network;
}

describe('TonNetwork.getTxData native', () => {
  it('attributes a plain wallet payment', async () => {
    const pay = message(OWNER_WALLET, RECIPIENT, AMOUNT);
    const root = transaction(OWNER_WALLET, message(null, OWNER_WALLET, null), [pay]);

    const tx = await mockedNetwork(root, [consume(pay)]).getTxData(root.hash, '0x0', RECIPIENT, undefined, OWNER_WALLET);

    expect(tx).toMatchObject({ from: OWNER_WALLET, to: RECIPIENT, amount: BigInt(AMOUNT), confirmed: true, timestamp: 1700000000 });
  });

  it('attributes a multisig paying the recipient deeper in the message chain', async () => {
    const order = message(OWNER_WALLET, MULTISIG, '50000000');
    const pay = message(MULTISIG, RECIPIENT, AMOUNT);
    const root = transaction(OWNER_WALLET, message(null, OWNER_WALLET, null), [order]);

    const tx = await mockedNetwork(root, [consume(order, [pay]), consume(pay)]).getTxData(root.hash, '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: MULTISIG, to: RECIPIENT, amount: BigInt(AMOUNT) });
  });

  it('gives nothing for a payment routed through an intermediary', async () => {
    const hop = message(MULTISIG, SINK, AMOUNT);
    const pay = message(SINK, RECIPIENT, AMOUNT);
    const root = transaction(MULTISIG, message(null, MULTISIG, null), [hop]);

    const tx = await mockedNetwork(root, [consume(hop, [pay]), consume(pay)]).getTxData(root.hash, '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('nets a bounced payment back to the payer', async () => {
    const pay = message(MULTISIG, RECIPIENT, AMOUNT);
    const bounce = message(RECIPIENT, MULTISIG, AMOUNT);
    const root = transaction(MULTISIG, message(null, MULTISIG, null), [pay]);

    const tx = await mockedNetwork(root, [consume(pay, [bounce]), consume(bounce)]).getTxData(root.hash, '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a third party paying the recipient', async () => {
    const pay = message(OTHER, RECIPIENT, AMOUNT);
    const root = transaction(OTHER, message(null, OTHER, null), [pay]);

    const tx = await mockedNetwork(root, [consume(pay)]).getTxData(root.hash, '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('retries while a message of the chain is not processed yet', async () => {
    const pay = message(MULTISIG, RECIPIENT, AMOUNT);
    const root = transaction(MULTISIG, message(null, MULTISIG, null), [pay]);

    await expect(mockedNetwork(root, []).getTxData(root.hash, '0x0', RECIPIENT, undefined, MULTISIG)).rejects.toThrow('not processed yet');
  });

  it('retries while the transaction is not indexed yet', async () => {
    const network = new TonNetwork('http://rpc', 1);
    vi.spyOn(network as any, 'request').mockImplementation(async (...args: any[]) => args[0] === '/v3/masterchainInfo' ? { last: { seqno: 100 } } : { transactions: [] });

    expect(await network.getTxData('hash', '0x0', RECIPIENT, undefined, MULTISIG)).toBeUndefined();
  });

  it('refuses a transaction that spawns too many transactions to walk', async () => {
    const dust = Array.from({ length: 200 }, () => message(MULTISIG, SINK, '1'));
    const pay = message(MULTISIG, RECIPIENT, AMOUNT);
    const root = transaction(MULTISIG, message(null, MULTISIG, null), [...dust, pay]);

    const tx = await mockedNetwork(root, [...dust, pay].map(msg => consume(msg))).getTxData(root.hash, '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('ignores external out messages', async () => {
    const pay = message(MULTISIG, RECIPIENT, AMOUNT);
    const root = transaction(MULTISIG, message(null, MULTISIG, null), [pay, message(MULTISIG, null, null)]);

    const tx = await mockedNetwork(root, [consume(pay)]).getTxData(root.hash, '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: MULTISIG, amount: BigInt(AMOUNT) });
  });
});

const MASTER = raw(10);
const FORGED = raw(99);
const JETTON_AMOUNT = '24486953';

const walletOf = new Map([OWNER_WALLET, MULTISIG, RECIPIENT, OTHER].map((owner, i) => [owner, raw(101 + i)]));

const jettonMessage = (source: string, wallet: string, amount = JETTON_AMOUNT) => ({
  ...message(source, wallet, '50000000'),
  opcode: '0x178d4519',
  message_content: { body: beginCell().storeUint(0x178d4519, 32).storeUint(0, 64).storeCoins(BigInt(amount)).endCell().toBoc().toString('base64') }
});

function mockedJettonNetwork(transfers: any[], aborted = false): TonNetwork {
  const root = transaction(MULTISIG, message(null, MULTISIG, null), transfers);
  const consumers = transfers.map(msg => ({ ...consume(msg), description: { aborted } }));

  const network = mockedNetwork(root, consumers);
  vi.spyOn(network as any, 'jettonWallet').mockImplementation(async (...args: any[]) =>
    args[0].toUpperCase() === MASTER ? walletOf.get(args[1].toUpperCase())!.toLowerCase() : FORGED.toLowerCase()
  );

  return network;
}

describe('TonNetwork.getTxData jetton', () => {
  it('attributes a jetton payment between the master wallets of payer and recipient', async () => {
    const tx = await mockedJettonNetwork([jettonMessage(walletOf.get(MULTISIG)!, walletOf.get(RECIPIENT)!)])
      .getTxData('hash', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: MULTISIG, to: RECIPIENT, token: MASTER, amount: BigInt(JETTON_AMOUNT) });
  });

  it('gives nothing for a jetton payment routed through another owner', async () => {
    const tx = await mockedJettonNetwork([
      jettonMessage(walletOf.get(MULTISIG)!, walletOf.get(OTHER)!),
      jettonMessage(walletOf.get(OTHER)!, walletOf.get(RECIPIENT)!)
    ]).getTxData('hash', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a transfer from a wallet that is not the payer wallet of the master', async () => {
    const tx = await mockedJettonNetwork([jettonMessage(FORGED, walletOf.get(RECIPIENT)!)])
      .getTxData('hash', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a transfer into a wallet that is not the recipient wallet of the master', async () => {
    const tx = await mockedJettonNetwork([jettonMessage(walletOf.get(MULTISIG)!, FORGED)])
      .getTxData('hash', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('ignores an aborted jetton transfer', async () => {
    const tx = await mockedJettonNetwork([jettonMessage(walletOf.get(MULTISIG)!, walletOf.get(RECIPIENT)!)], true)
      .getTxData('hash', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('does not cache a failed jetton wallet lookup', async () => {
    const network = new TonNetwork('http://rpc', 1);
    const request = vi.spyOn(network as any, 'request').mockResolvedValue({ exit_code: -13, stack: [] });

    await expect((network as any).jettonWallet(MASTER, FORGED)).rejects.toThrow('exit code -13');
    await expect((network as any).jettonWallet(MASTER, FORGED)).rejects.toThrow('exit code -13');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reads the jetton wallet address from the master get-method', async () => {
    const network = new TonNetwork('http://rpc', 1);

    vi.spyOn(network as any, 'request').mockResolvedValue({
      exit_code: 0,
      stack: [{ type: 'cell', value: 'te6cckEBAQEAJAAAQ4AVhHkkM20BvtL2RVkJjA69qFG7V8C+kftvgEbGZihrSJBb2YRG' }]
    });

    expect(await (network as any).jettonWallet(MASTER, '0:A5AE7561B0BEE91CD12AD946C2359EEBB64491D4BB13FC46D6E1B0AC3F04EF74'))
      .toBe('0:ac23c9219b680df697b22ac84c6075ed428ddabe05f48fdb7c02363331435a44');
  });
});

describe('TonNetwork.ping', () => {
  const pinged = (responses: Record<string, any>) => {
    const network = new TonNetwork('http://rpc', 1);

    vi.spyOn(network as any, 'request').mockImplementation(async (...args: any[]) => {
      const response = responses[(args[0] as string).split('?')[0]];

      if (response instanceof Error) {
        throw response;
      }

      return response;
    });

    return network.ping();
  };

  it('accepts an indexer that serves message lookups and get-methods', async () => {
    await expect(pinged({ '/v3/masterchainInfo': {}, '/v3/transactionsByMessage': { transactions: [] }, '/v3/runGetMethod': { exit_code: -13, stack: [] } })).resolves.toBeUndefined();
  });

  it('refuses an indexer without /v3/transactionsByMessage', async () => {
    await expect(pinged({ '/v3/masterchainInfo': {}, '/v3/transactionsByMessage': new Error('Request failed 403') })).rejects.toThrow('403');
  });

  it('refuses an indexer without /v3/runGetMethod', async () => {
    await expect(pinged({ '/v3/masterchainInfo': {}, '/v3/transactionsByMessage': { transactions: [] }, '/v3/runGetMethod': new Error('Request failed 404') })).rejects.toThrow('404');
  });
});
