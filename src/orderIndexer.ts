import { ethers, LogDescription, EventLog, FetchRequest } from 'ethers';
import WebSocket from 'ws';

import { sleep, log } from './utils.js';
import { EventQueue } from './eventQueue.js';
import { initOrderEngine, OrderEngineContract } from './contracts.js';
import { IntentsConfig } from './config.js';
import { configureProxy, getProxyAgent } from './proxy.js';

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
  private wsOrderEngine: ethers.Contract | null;
  private readonly orderEngine: OrderEngineContract & ethers.Contract;
  private readonly eventQueue: EventQueue<OrderStatusChangedEvent>;
  private readonly processors: EventProcessor[];
  private isRunning: boolean;
  private lastProcessedBlock: number;
  private readonly rpcTimeoutMs: number;
  private isProcessingQueue: boolean;
  private reconnectTimeout: NodeJS.Timeout | null;
  private healthCheckInterval: NodeJS.Timeout | null;

  constructor(config: IntentsConfig) {
    this.config = config;

    configureProxy(config.proxyUrl);

    const req = new FetchRequest(config.rpcUrl);

    if (config.rpcAuthToken) {
      req.setHeader('x-api-key', config.rpcAuthToken);
    }

    const agent = getProxyAgent();

    if (agent) {
      req.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
    }

    this.httpProvider = new ethers.JsonRpcProvider(req, undefined, { staticNetwork: true });

    void this.httpProvider.on('debug', this.debugTrace('RPC'));

    this.wsProvider = null;
    this.wsOrderEngine = null;

    this.orderEngine = initOrderEngine(
      config.orderEngineAddress,
      this.httpProvider
    );

    this.eventQueue = new EventQueue<OrderStatusChangedEvent>();
    this.processors = [];
    this.isRunning = false;
    this.lastProcessedBlock = 0;
    this.isProcessingQueue = false;
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

    log.info(`Starting indexer with offset -${this.config.startBlockOffset} blocks`);

    try {
      await this.startWebSocketListener();
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

    if (this.wsOrderEngine) {
      void this.wsOrderEngine.removeAllListeners();
      this.wsOrderEngine = null;
    }

    if (this.wsProvider) {
      void this.wsProvider.removeAllListeners();
      void this.wsProvider.destroy();
      this.wsProvider = null;
    }

    const maxWaitTime = 30000;
    const startTime = Date.now();

    while (!this.eventQueue.isEmpty() && (Date.now() - startTime) < maxWaitTime) {
      log.info(`Waiting for ${this.eventQueue.size()} events to complete before stopping`);
      await sleep(1000);
    }

    if (!this.eventQueue.isEmpty()) {
      log.warn(`Stopping indexer with ${this.eventQueue.size()} unprocessed events after timeout`);
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
      await this.processBlockRange(this.lastProcessedBlock + 1, currentBlock);
    }
  }

  private async startWebSocketListener(): Promise<void> {
    await this.processHistoricalEvents(); // Process historical events first

    try {
      const wsAgent = getProxyAgent();
      const wsOptions = wsAgent ? { agent: wsAgent } : undefined;
      const ws = new WebSocket(this.config.rpcUrl.replace(/^https?:\/\//, 'wss://'), wsOptions);

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

      void this.wsProvider.on('debug', this.debugTrace('WS'));

      this.wsOrderEngine = new ethers.Contract(
        this.config.orderEngineAddress,
        this.orderEngine.interface,
        this.wsProvider
      );

      void this.wsOrderEngine.on('OrderStatusChanged', async (orderId: string, status: bigint, event: EventLog) => {
        if (!this.isRunning) return;

        this.eventQueue.add({
          type: 'OrderStatusChanged',
          data: {
            orderId,
            status: Number(status)
          },
          event,
          retries: 0
        });

        this.lastProcessedBlock = event.blockNumber;

        if (this.isRunning && !this.eventQueue.isEmpty()) {
          await this.processEventQueue();
        }
      });

      this.monitorWebSocketHealth();

      log.info('WebSocket listener started');
    } catch (error) {
      log.error('Error starting WebSocket:', error);
      this.reconnectWebSocket();
    }
  }

  private monitorWebSocketHealth(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (!this.isRunning || !this.wsProvider) {
        return;
      }

      try {
        await this.withTimeout(
          this.wsProvider.getBlockNumber(),
          'wsProvider.getBlockNumber (health check)'
        );
      } catch (error) {
        log.warn('WebSocket health check failed:', error);
        this.reconnectWebSocket();
      }
    }, 60_000);
  }

  private reconnectWebSocket(): void {
    if (!this.isRunning || this.reconnectTimeout) return;

    if (this.wsOrderEngine) {
      void this.wsOrderEngine.removeAllListeners();
      this.wsOrderEngine = null;
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
        } catch (error) {
          log.error('Error reconnecting WebSocket:', error);
          this.reconnectWebSocket();
        }
      }
    }, 5000);
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`RPC timeout in ${label} after ${this.rpcTimeoutMs}ms`)), this.rpcTimeoutMs))
    ]);
  }

  private async processBlockRange(fromBlock: number, toBlock: number): Promise<void> {
    const chunkSize = 2000;

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

  private debugTrace = (prefix: string) => (info: any) => {
    if (info.action !== 'receiveRpcResult') {
      log.debug(`${prefix}: ${info.action} -> ${info.payload?.method}`);
    }
  };
}
