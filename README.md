# @bronlabs/intents-sdk

TypeScript SDK for building Intents DeFi applications with order indexing, processing, and smart contract interactions.

## Installation

```bash
npm install @bronlabs/intents-sdk
```

## Core Components

### OrderIndexer

Monitors blockchain events and indexes order status changes.

```typescript
import { OrderIndexer, IntentsConfig } from '@bronlabs/intents-sdk';

const config: IntentsConfig = {
  rpcUrl: 'https://your-rpc-url',
  orderEngineAddress: '0x...',
  startBlockOffset: 100,
  pollingInterval: 5000,
  maxRetries: 3,
  retryDelay: 1000,
  networks: {}
};

const indexer = new OrderIndexer(config);

indexer.addProcessor(async (event) => {
  console.log(`Order ${event.data.orderId} status: ${event.data.status}`);
});

await indexer.start();
```

### OrderProcessor (Abstract)

Base class for implementing custom order processing logic.

```typescript
import { OrderProcessor } from '@bronlabs/intents-sdk';

class CustomOrderProcessor extends OrderProcessor {
  async process(orderId: string, status: string): Promise<void> {
    // Implement your processing logic
    console.log(`Processing order ${orderId} with status ${status}`);
  }
}

const processor = new CustomOrderProcessor();
await processor.stop();
```

### Network Configuration

```typescript
import { NetworkConfig, IntentsConfig } from '@bronlabs/intents-sdk';

const config: IntentsConfig = {
  rpcUrl: 'https://mainnet.infura.io/v3/your-key',
  orderEngineAddress: '0x123...',
  startBlockOffset: 0,
  pollingInterval: 10000,
  maxRetries: 5,
  retryDelay: 2000,
  networks: {
    ethereum: {
      rpcUrl: 'https://mainnet.infura.io/v3/your-key',
      walletAddress: '0x456...',
      walletPrivateKey: 'your-private-key'
    },
    polygon: {
      rpcUrl: 'https://polygon-rpc.com',
      walletAddress: '0x789...'
    }
  }
};
```

## Configuration Schema

```typescript
interface IntentsConfig {
  rpcUrl: string;
  orderEngineAddress: string;
  oracleAggregatorAddress?: string;
  oraclePrivateKey?: string;
  solverPrivateKey?: string;
  startBlockOffset: number;
  pollingInterval: number;
  maxRetries: number;
  retryDelay: number;
  networks: {
    [key: string]: NetworkConfig;
  };
}

interface NetworkConfig {
  rpcUrl: string;
  walletAddress?: string;
  walletPrivateKey?: string;
}
```

## Error Handling

The SDK includes built-in retry mechanisms and error handling:

- Events are retried up to `maxRetries` times
- Failed events are logged and can be monitored
- Graceful shutdown ensures all queued events are processed
