import { ethers, LogDescription, EventLog, FetchRequest } from 'ethers';
import WebSocket from 'ws';

import { sleep, log } from './utils.js';
import { EventQueue } from './eventQueue.js';
import { initOrderEngine, OrderEngineContract } from './contracts.js';
import { IntentsConfig } from './config.js';

export interface OrderStatusChangedEvent {
  type: 'OrderStatusChanged';
  data: {
    orderId: string;
    status: number;
  };
  event: ethers.EventLog;
  retries: number;
}

type EventProcessor = (event: OrderStatusChangedEvent) => Promise<void>;

export class OrderIndexer {

  private readonly config: IntentsConfig;
  private readonly httpProvider: ethers.JsonRpcProvider;
  private wsProvider: ethers.WebSocketProvider | null;
  private readonly orderEngine: OrderEngineContract & ethers.Contract;
  private readonly eventQueue: EventQueue<OrderStatusChangedEvent>;
  private readonly processors: EventProcessor[];
  private isRunning: boolean;
  private lastProcessedBlock: number;
  private readonly rpcTimeoutMs: number;
  private targetBlock: number;
  private isProcessingQueue: boolean;
  private isWorkerRunning: boolean;
  private reconnectTimeout: NodeJS.Timeout | null;
  private healthCheckInterval: NodeJS.Timeout | null;

  constructor(config: IntentsConfig) {
    this.config = config;

    const req = new FetchRequest(config.rpcUrl);

    if (config.rpcAuthToken) {
      req.setHeader('x-api-key', config.rpcAuthToken);
    }

    this.httpProvider = new ethers.JsonRpcProvider(req, undefined, { staticNetwork: true });
    this.wsProvider = null;

    this.orderEngine = initOrderEngine(
      config.orderEngineAddress,
      this.httpProvider
    );

    this.eventQueue = new EventQueue<OrderStatusChangedEvent>();
    this.processors = [];
    this.isRunning = false;
    this.lastProcessedBlock = 0;
    this.targetBlock = 0;
    this.isProcessingQueue = false;
    this.isWorkerRunning = false;
    this.reconnectTimeout = null;
    this.rpcTimeoutMs = 15_000;
    this.healthCheckInterval = null;
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

    log.info(`Starting indexer from offset ${this.config.startBlockOffset}`);

    try {
      await this.processHistoricalEvents();
      await this.startWebSocketListener();
      this.startCatchupWorker();
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

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.wsProvider) {
      void this.wsProvider.removeAllListeners();
      void this.wsProvider.destroy();
      this.wsProvider = null;
    }

    const maxWaitTime = 30000;
    const startTime = Date.now();

    while ((this.isWorkerRunning || !this.eventQueue.isEmpty()) && (Date.now() - startTime) < maxWaitTime) {
      log.info(`Waiting for worker and ${this.eventQueue.size()} events to complete before stopping`);
      await sleep(1000);
    }

    if (this.isWorkerRunning || !this.eventQueue.isEmpty()) {
      log.warn(`Stopping indexer with worker still running or ${this.eventQueue.size()} unprocessed events after timeout`);
    }

    log.info('Indexer stopped');
  }

  private async processHistoricalEvents(): Promise<void> {
    const currentBlock = await this.withTimeout(this.httpProvider.getBlockNumber(), 'httpProvider.getBlockNumber');

    if (!this.lastProcessedBlock) {
      this.lastProcessedBlock = currentBlock - this.config.startBlockOffset;
    }

    if (currentBlock > this.lastProcessedBlock) {
      log.info(`Processing historical events from ${this.lastProcessedBlock + 1} to ${currentBlock}`);
      this.targetBlock = currentBlock;
      await this.processBlockRange(this.lastProcessedBlock + 1, currentBlock);
    } else {
      this.targetBlock = this.lastProcessedBlock;
    }
  }

  private async startWebSocketListener(): Promise<void> {
    try {
      const ws = new WebSocket(this.config.rpcUrl.replace(/^https?:\/\//, 'wss://'));

      ws.on('error', error => {
        if (!this.isRunning) return;
        log.error('WebSocket transport error:', error);
        this.reconnectWebSocket();
      });

      ws.on('close', (code, reason) => {
        if (!this.isRunning) return;
        log.warn(`WebSocket transport closed: ${code} ${reason?.toString?.() ?? ''}`);
        this.reconnectWebSocket();
      });

      this.wsProvider = new ethers.WebSocketProvider(ws, undefined, { staticNetwork: true });

      void this.wsProvider.on('block', (blockNumber: number) => {
        if (!this.isRunning) return;

        if (blockNumber > this.targetBlock) {
          this.targetBlock = blockNumber;
          log.debug(`New target block: ${blockNumber}, current: ${this.lastProcessedBlock}`);
        }

        this.startCatchupWorker();
      });

      this.monitorWebSocketHealth();

      log.info('WebSocket listener started');
    } catch (error) {
      log.error('Error starting WebSocket:', error);
      this.reconnectWebSocket();
    }
  }

  private monitorWebSocketHealth(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (!this.isRunning) {
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        return;
      }

      if (!this.wsProvider) {
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        this.reconnectWebSocket();
        return;
      }

      try {
        await this.withTimeout(this.wsProvider.getBlockNumber(), 'wsProvider.getBlockNumber');
      } catch (error) {
        log.error('WebSocket health check failed:', error);
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        this.reconnectWebSocket();
      }
    }, 30000);
  }

  private reconnectWebSocket(): void {
    if (!this.isRunning || this.reconnectTimeout) return;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.wsProvider) {
      void this.wsProvider.removeAllListeners();
      void this.wsProvider.destroy();
      this.wsProvider = null;
    }

    log.info('Reconnecting WebSocket in 5 seconds...');

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      if (this.isRunning) {
        try {
          await this.startWebSocketListener();
          this.startCatchupWorker();
        } catch (error) {
          log.error('Error reconnecting WebSocket:', error);
          this.reconnectWebSocket();
        }
      }
    }, 5000);
  }

  private startCatchupWorker(): void {
    if (this.isWorkerRunning) return;

    this.isWorkerRunning = true;

    this.catchupWorkerLoop().catch(error => {
      log.error('Catchup worker error:', error);
      this.isWorkerRunning = false;
      this.reconnectWebSocket();
    });
  }

  private async catchupWorkerLoop(): Promise<void> {
    while (this.isRunning) {
      if (this.targetBlock > this.lastProcessedBlock) {
        try {
          await this.processBlockRange(this.lastProcessedBlock + 1, this.targetBlock);
        } catch (error) {
          log.error('Error in catchup worker:', error);
          this.reconnectWebSocket();
          await sleep(5000);
        }
      } else {
        await sleep(300);
      }
    }

    this.isWorkerRunning = false;
    log.info('Catchup worker stopped');
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`RPC timeout in ${label} after ${this.rpcTimeoutMs}ms`)), this.rpcTimeoutMs))
    ]);
  }

  private async processBlockRange(fromBlock: number, toBlock: number): Promise<void> {
    const chunkSize = 500;

    for (let from = fromBlock; from <= toBlock; from += chunkSize) {
      if (!this.isRunning) break;

      const to = Math.min(from + chunkSize - 1, toBlock);

      try {
        const events = await this.withTimeout(this.orderEngine.queryFilter(
          this.orderEngine.filters.OrderStatusChanged(),
          from,
          to
        ), `orderEngine.queryFilter ${from}-${to}`);

        for (const event of events) {
          const { args: { orderId, status } } = this.orderEngine.interface.parseLog({
            topics: event.topics,
            data: event.data
          }) as LogDescription;

          this.eventQueue.add({
            type: 'OrderStatusChanged',
            data: {
              orderId,
              status: Number(status)
            },
            event: event as EventLog,
            retries: 0
          });
        }

        this.lastProcessedBlock = to;

        if (this.isRunning && !this.eventQueue.isEmpty()) {
          await this.processEventQueue();
        }
      } catch (error) {
        log.error(`Error processing block range ${from}-${to}:`, error);
        throw error;
      }
    }
  }

  private async processEventQueue(): Promise<void> {
    if (this.isProcessingQueue || this.eventQueue.isEmpty() || this.processors.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (!this.eventQueue.isEmpty()) {
        const event = this.eventQueue.peek();

        if (!event) continue;

        try {
          for (const processor of this.processors) {
            await processor(event);
          }

          this.eventQueue.remove();
        } catch (error) {
          log.error(`Error processing event:`, error);

          if (event.retries < this.config.maxRetries) {
            event.retries++;
            log.info(`Retrying event processing (${event.retries}/${this.config.maxRetries})`);
            await sleep(this.config.retryDelay);
          } else {
            log.error(`Max retries reached for event, removing from queue:`, event);
            this.eventQueue.remove();
          }
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }
}
