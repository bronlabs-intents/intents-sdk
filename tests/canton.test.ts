import { describe, expect, it, vi } from 'vitest';

import { CantonNetwork } from '../src/networks/canton.js';

const PAYER = 'payer::1220aa';
const RECIPIENT = 'recipient::1220bb';
const OTHER = 'other::1220cc';
const DSO = 'DSO::1220dd';
const AMULET = { admin: DSO, id: 'Amulet' };

function mockedNetwork(sender: string, receiver: string, tag = 'TransferInstructionResult_Completed', instrumentId: any = AMULET): CantonNetwork {
  const network = new CantonNetwork('http://validator', 'http://ledger');

  vi.spyOn(network as any, 'nodeRequest').mockImplementation(async (...args: any[]) => args[0].uri === '/v0/scan-proxy/dso-party-id' ? { dso_party_id: DSO } : ({
    update: {
      Transaction: {
        value: {
          updateId: 'update-1',
          recordTime: '2026-10-01T00:00:00Z',
          events: [{
            ExercisedEvent: {
              choice: 'TransferFactory_Transfer',
              choiceArgument: { transfer: { sender, receiver, amount: '12.5', instrumentId } },
              exerciseResult: { output: { tag } }
            }
          }]
        }
      }
    }
  }));

  return network;
}

describe('CantonNetwork.getTxData', () => {
  it('credits an amulet transfer from the payer to the recipient', async () => {
    const tx = await mockedNetwork(PAYER, RECIPIENT).getTxData('update-1', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: PAYER, to: RECIPIENT, token: '0x0', amount: 125000000000n, confirmed: true });
  });

  it('refuses a transfer sent by someone other than the payer', async () => {
    const tx = await mockedNetwork(OTHER, RECIPIENT).getTxData('update-1', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a transfer to another receiver', async () => {
    const tx = await mockedNetwork(PAYER, OTHER).getTxData('update-1', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses another token sent as native', async () => {
    const tx = await mockedNetwork(PAYER, RECIPIENT, 'TransferInstructionResult_Completed', { admin: OTHER, id: 'Amulet' })
      .getTxData('update-1', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });

  it('refuses a failed transfer', async () => {
    const tx = await mockedNetwork(PAYER, RECIPIENT, 'TransferInstructionResult_Failed').getTxData('update-1', '0x0', RECIPIENT, undefined, PAYER);

    expect(tx).toMatchObject({ from: '', amount: 0n });
  });
});
