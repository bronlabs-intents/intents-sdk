import { describe, expect, it, vi } from 'vitest';

import { TonNetwork } from '../src/networks/ton.js';

const raw = (n: number) => `0:${n.toString(16).padStart(64, '0').toUpperCase()}`;

const OWNER_WALLET = raw(1);
const MULTISIG = raw(2);
const RECIPIENT = raw(3);
const OTHER = raw(4);
const SINK = raw(5);

const AMOUNT = '2500000000';

const message = (source: string | null, destination: string | null, value: string | null) => ({ source, destination, value });

const transaction = (account: string, inMsg: any, outMsgs: any[]) => ({
  account,
  mc_block_seqno: 50,
  now: 1700000000,
  description: { compute_ph: { success: true, exit_code: 0 } },
  in_msg: inMsg,
  out_msgs: outMsgs
});

const root = { ...transaction(OWNER_WALLET, message(null, OWNER_WALLET, null), [message(OWNER_WALLET, MULTISIG, '50000000')]), hash: 'hash-0', now: Math.floor(Date.now() / 1000) };

function mockedNetwork(trace: any, submitted: any = root): TonNetwork {
  const network = new TonNetwork('http://rpc', 1);

  vi.spyOn(network as any, 'request').mockImplementation(async (...args: any[]) => {
    const path = args[0] as string;

    if (path === '/v3/masterchainInfo') {
      return { last: { seqno: 100 } };
    }

    if (path.startsWith('/v3/transactions')) {
      return { transactions: [submitted] };
    }

    return { traces: [trace] };
  });

  return network;
}

const traceOf = (transactions: any[], incomplete = false) => ({
  is_incomplete: incomplete,
  trace: { tx_hash: 'hash-0' },
  transactions: Object.fromEntries(transactions.map((tx, i) => [`hash-${i}`, tx]))
});

describe('TonNetwork.getTxData native', () => {
  it('attributes a plain wallet payment', async () => {
    const payment = { ...transaction(OWNER_WALLET, message(null, OWNER_WALLET, null), [message(OWNER_WALLET, RECIPIENT, AMOUNT)]), hash: 'hash-0', now: root.now };
    const trace = traceOf([payment, transaction(RECIPIENT, message(OWNER_WALLET, RECIPIENT, AMOUNT), [])]);

    const tx = await mockedNetwork(trace, payment).getTxData('hash-0', '0x0', RECIPIENT, undefined, OWNER_WALLET);

    expect(tx).toMatchObject({ from: OWNER_WALLET, to: RECIPIENT, amount: BigInt(AMOUNT) });
  });

  it('attributes a multisig paying the recipient through an intermediary', async () => {
    const trace = traceOf([
      root,
      transaction(MULTISIG, message(OWNER_WALLET, MULTISIG, '50000000'), [message(MULTISIG, SINK, AMOUNT)]),
      transaction(SINK, message(MULTISIG, SINK, AMOUNT), [message(SINK, RECIPIENT, AMOUNT)]),
      transaction(RECIPIENT, message(SINK, RECIPIENT, AMOUNT), [])
    ]);

    const tx = await mockedNetwork(trace).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: MULTISIG, to: RECIPIENT, amount: BigInt(AMOUNT) });
  });

  it('attributes a multisig paying the recipient directly under the trace root', async () => {
    const trace = traceOf([
      root,
      transaction(MULTISIG, message(OWNER_WALLET, MULTISIG, '50000000'), [message(MULTISIG, RECIPIENT, AMOUNT)]),
      transaction(RECIPIENT, message(MULTISIG, RECIPIENT, AMOUNT), [])
    ]);

    const tx = await mockedNetwork(trace).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: MULTISIG, amount: BigInt(AMOUNT) });
  });

  it('retries while a fresh trace is incomplete', async () => {
    const tx = await mockedNetwork(traceOf([root], true)).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toBeUndefined();
  });

  it('stops retrying a trace that stays incomplete', async () => {
    const stale = { ...root, now: Math.floor(Date.now() / 1000) - 3600 };

    const tx = await mockedNetwork(traceOf([stale], true), stale).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('retries while a fresh trace is not indexed yet', async () => {
    const tx = await mockedNetwork(undefined).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toBeUndefined();
  });

  it('refuses a trace that is still not indexed past the retry window', async () => {
    const stale = { ...root, now: Math.floor(Date.now() / 1000) - 3600 };

    const tx = await mockedNetwork(undefined, stale).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('attributes the trace only to its root transaction', async () => {
    const payout = { ...transaction(MULTISIG, message(OWNER_WALLET, MULTISIG, '50000000'), [message(MULTISIG, RECIPIENT, AMOUNT)]), hash: 'hash-1' };
    const trace = traceOf([root, payout, transaction(RECIPIENT, message(MULTISIG, RECIPIENT, AMOUNT), [])]);

    const tx = await mockedNetwork(trace, { ...transaction(OWNER_WALLET, message(MULTISIG, OWNER_WALLET, '1'), []), hash: 'hash-2' })
      .getTxData('hash-2', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('nets a bounced payment back to the payer', async () => {
    const trace = traceOf([
      root,
      transaction(MULTISIG, message(OWNER_WALLET, MULTISIG, '50000000'), [message(MULTISIG, RECIPIENT, AMOUNT)]),
      transaction(RECIPIENT, message(MULTISIG, RECIPIENT, AMOUNT), [message(RECIPIENT, MULTISIG, AMOUNT)]),
      transaction(MULTISIG, message(RECIPIENT, MULTISIG, AMOUNT), [])
    ]);

    const tx = await mockedNetwork(trace).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a third party paying the recipient while the payer pays elsewhere', async () => {
    const trace = traceOf([
      root,
      transaction(MULTISIG, message(OWNER_WALLET, MULTISIG, '50000000'), [message(MULTISIG, SINK, AMOUNT)]),
      transaction(OTHER, message(null, OTHER, null), [message(OTHER, RECIPIENT, AMOUNT)]),
      transaction(RECIPIENT, message(OTHER, RECIPIENT, AMOUNT), [])
    ]);

    const tx = await mockedNetwork(trace).getTxData('hash-0', '0x0', RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });
});

const MASTER = raw(10);
const FORGED = raw(99);
const JETTON_AMOUNT = '24486953';

const walletOf = new Map([OWNER_WALLET, MULTISIG, RECIPIENT, OTHER].map((owner, i) => [owner, raw(101 + i)]));

const jettonTransfer = (wallet: string, source: string, from: string | null, amount = JETTON_AMOUNT, aborted = false) => ({
  ...transaction(wallet, {
    ...message(source, wallet, '50000000'),
    opcode: '0x178d4519',
    message_content: {
      decoded: {
        '@type': 'jetton_internal_transfer',
        amount: { value: amount },
        from: from ? { '@type': 'addr_std', workchain_id: '0', address: from.slice(2) } : { '@type': 'addr_none' }
      }
    }
  }, []),
  description: { aborted }
});

function mockedJettonNetwork(transfers: any[], owners: Map<string, string> = new Map([...walletOf].map(([owner, wallet]) => [wallet, owner]))): TonNetwork {
  const network = mockedNetwork(traceOf([root, ...transfers]));

  vi.spyOn(network as any, 'jettonWalletOwner').mockImplementation(async (...args: any[]) => owners.get(args[0].toUpperCase())?.toLowerCase());
  vi.spyOn(network as any, 'jettonWallet').mockImplementation(async (...args: any[]) => args[0].toUpperCase() === MASTER ? walletOf.get(args[1].toUpperCase())?.toLowerCase() : undefined);

  return network;
}

describe('TonNetwork.getTxData jetton', () => {
  it('attributes a jetton payment between genuine wallets', async () => {
    const tx = await mockedJettonNetwork([jettonTransfer(walletOf.get(RECIPIENT)!, walletOf.get(MULTISIG)!, MULTISIG)])
      .getTxData('hash-0', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: MULTISIG, to: RECIPIENT, token: MASTER, amount: BigInt(JETTON_AMOUNT) });
  });

  it('attributes a jetton payment routed through another owner', async () => {
    const tx = await mockedJettonNetwork([
      jettonTransfer(walletOf.get(OTHER)!, walletOf.get(MULTISIG)!, MULTISIG),
      jettonTransfer(walletOf.get(RECIPIENT)!, walletOf.get(OTHER)!, OTHER)
    ]).getTxData('hash-0', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: MULTISIG, amount: BigInt(JETTON_AMOUNT) });
  });

  it('refuses a transfer whose sending wallet does not belong to the claimed owner', async () => {
    const tx = await mockedJettonNetwork([jettonTransfer(walletOf.get(RECIPIENT)!, FORGED, MULTISIG)])
      .getTxData('hash-0', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a receiving wallet that is not the master\'s wallet of its owner', async () => {
    const tx = await mockedJettonNetwork([jettonTransfer(FORGED, walletOf.get(MULTISIG)!, MULTISIG)], new Map([[FORGED, RECIPIENT]]))
      .getTxData('hash-0', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a mint from the master to the recipient', async () => {
    const tx = await mockedJettonNetwork([jettonTransfer(walletOf.get(RECIPIENT)!, MASTER, null)])
      .getTxData('hash-0', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('ignores an aborted jetton transfer', async () => {
    const tx = await mockedJettonNetwork([jettonTransfer(walletOf.get(RECIPIENT)!, walletOf.get(MULTISIG)!, MULTISIG, JETTON_AMOUNT, true)])
      .getTxData('hash-0', MASTER, RECIPIENT, undefined, MULTISIG);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('does not credit a jetton transfer the indexer has not decoded', async () => {
    const undecoded = jettonTransfer(walletOf.get(RECIPIENT)!, walletOf.get(MULTISIG)!, MULTISIG);
    undecoded.in_msg.message_content = {} as any;

    expect(await mockedJettonNetwork([undecoded]).getTxData('hash-0', MASTER, RECIPIENT, undefined, MULTISIG)).toMatchObject({ from: '', amount: 0n });
  });

  it('does not cache a failed jetton wallet lookup', async () => {
    const network = new TonNetwork('http://rpc', 1);
    const request = vi.spyOn(network as any, 'request').mockResolvedValue({ exit_code: -13, stack: [] });

    expect(await (network as any).jettonWalletOwner(FORGED)).toBeUndefined();
    expect(await (network as any).jettonWalletOwner(FORGED)).toBeUndefined();
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
