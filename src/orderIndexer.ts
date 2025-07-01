import { ethers } from 'ethers';

import { sleep, log } from './utils.js';
import { EventQueue } from './eventQueue.js';
import { initOrderEngine } from './contracts.js';
import { IntentsConfig } from './config.js';

export interface OrderStatusChangedEvent {
  type: 'OrderStatusChanged';
  data: {
    orderId: string;
    status: number;
  };
  event: ethers.Event;
  retries: number;
}

type EventProcessor = (event: OrderStatusChangedEvent) => Promise<void>;

export class OrderIndexer {

  private readonly config: IntentsConfig;
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly orderEngine: ethers.Contract;
  private readonly eventQueue: EventQueue<OrderStatusChangedEvent>;
  private readonly processors: EventProcessor[];
  private isRunning: boolean;
  private lastProcessedBlock: number;

  constructor(config: IntentsConfig) {
    this.config = config;
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);

    this.orderEngine = initOrderEngine(
      config.orderEngineAddress,
      this.provider
    );

    this.eventQueue = new EventQueue<OrderStatusChangedEvent>();
    this.processors = [];
    this.isRunning = false;
    this.lastProcessedBlock = 0;
  }

  addProcessor(processor: EventProcessor): void {
    this.processors.push(processor);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('Indexer is already running');
      return;
    }

    this.isRunning = true;

    log.info(`Starting indexer from block ${this.lastProcessedBlock}`);

    try {
      await this.startIndexingLoop();
    } catch (error) {
      log.error('Error starting indexer:', error);
      this.isRunning = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      log.warn('Indexer is not running');
      return;
    }

    log.info('Stopping indexer...');

    this.isRunning = false;

    // Wait for event queue to be processed
    while (!this.eventQueue.isEmpty()) {
      log.info(`Waiting for ${this.eventQueue.size()} events to be processed before stopping`);
      await sleep(1000);
    }

    log.info('Indexer stopped');
  }

  private async startIndexingLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {

      console.log("startIndexingLoop123");
      const currentBlock = await this.provider.getBlockNumber();
      console.log("startIndexingLoop456");

      if (!this.lastProcessedBlock) {
        this.lastProcessedBlock = currentBlock - this.config.startBlockOffset;
      }

      if (currentBlock > this.lastProcessedBlock) {
        log.info(`Indexing from block ${this.lastProcessedBlock + 1} to ${currentBlock} (${currentBlock - this.lastProcessedBlock} blocks)`);

        // Fetch historical events in chunks to avoid RPC limitations
        const chunkSize = 500;
        for (let fromBlock = this.lastProcessedBlock + 1; fromBlock <= currentBlock; fromBlock += chunkSize) {
          const toBlock = Math.min(fromBlock + chunkSize - 1, currentBlock);

          const events = await this.orderEngine.queryFilter(
            this.orderEngine.filters.OrderStatusChanged(),
            fromBlock,
            toBlock
          );

          log.info(`Found ${events.length} events between blocks ${fromBlock} and ${toBlock}`);

          for (const event of events) {
            const { args: { orderId, status } } = this.orderEngine.interface.parseLog({
              topics: event.topics,
              data: event.data,
            });

            this.eventQueue.add({
              type: 'OrderStatusChanged',
              data: {
                orderId,
                status: parseInt(status.toString(), 10)
              },
              event,
              retries: 0
            });
          }

          this.lastProcessedBlock = toBlock;

          await this.processEventQueue();
        }
      }
    } catch (error) {
      log.error('Error in indexing loop: ', error);
    }

    // Schedule next iteration
    if (this.isRunning) {
      setTimeout(() => this.startIndexingLoop(), this.config.pollingInterval);
    }
  }

  private async processEventQueue(): Promise<void> {
    if (this.eventQueue.isEmpty() || this.processors.length === 0) return;

    log.info(`Processing event queue with ${this.eventQueue.size()} events`);

    while (!this.eventQueue.isEmpty() && this.isRunning) {
      const event = this.eventQueue.peek();

      if (!event) continue;

      try {
        // Process the event with all registered processors
        for (const processor of this.processors) {
          await processor(event);
        }

        this.eventQueue.remove();
      } catch (error) {
        log.error(`Error processing event:`, error);

        // Retry logic
        if (event.retries < this.config.maxRetries) {
          event.retries++;
          log.info(`Retrying event processing (${event.retries}/${this.config.maxRetries})`);
          await sleep(this.config.retryDelay);
        } else {
          log.error(`Max retries reached for event, removing from queue:`, event);
          this.eventQueue.remove(); // Could add dead letter queue here for manual inspection
        }
      }
    }
  }
}
