import { ethers, LogDescription, EventLog, FetchRequest } from 'ethers';
import WebSocket from 'ws';

import { sleep, log } from './utils.js';
import { EventQueue } from './eventQueue.js';
import { initOracleAggregator, OracleAggregatorContract } from './contracts.js';
import { IntentsConfig } from './config.js';
import { configureProxy, getProxyAgent } from './proxy.js';

export interface OracleAggregatorIndexerConfig extends IntentsConfig {
  oracleAggregatorAddress: string;
}

export interface OracleConsensusResetEvent {
  type: 'OracleConsensusReset';
  data: {
    orderId: string;
    newRoundId: number;
  };
  event: ethers.EventLog;
  retries: number;
}

type EventProcessor = (event: OracleConsensusResetEvent) => Promise<void>;

export class OracleAggregatorIndexer {

  private readonly config: OracleAggregatorIndexerConfig;
  private readonly httpProvider: ethers.JsonRpcProvider;
  private wsProvider: ethers.WebSocketProvider | null;
  private wsOracleAggregator: ethers.Contract | null;
  private readonly oracleAggregator: OracleAggregatorContract & ethers.Contract;
  private readonly eventQueue: EventQueue<OracleConsensusResetEvent>;
  private readonly processors: EventProcessor[];
  private isRunning: boolean;
  private lastProcessedBlock: number;
  private readonly rpcTimeoutMs: number;
  private isProcessingQueue: boolean;
  private reconnectTimeout: NodeJS.Timeout | null;
  private healthCheckInterval: NodeJS.Timeout | null;

  constructor(config: OracleAggregatorIndexerConfig) {
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
    this.wsOracleAggregator = null;

    this.oracleAggregator = initOracleAggregator(
      config.oracleAggregatorAddress,
      this.httpProvider
    );

    this.eventQueue = new EventQueue<OracleConsensusResetEvent>();
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
      log.warn('OracleAggregator indexer is already running');
      return;
    }

    this.isRunning = true;

    log.info(`Starting OracleAggregator indexer with offset -${this.config.startBlockOffset} blocks`);

    try {
      await this.startWebSocketListener();
    } catch (error) {
      log.error('Error starting OracleAggregator indexer:', error);
      this.isRunning = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      log.warn('OracleAggregator indexer is not running');
      return;
    }

    log.info('Stopping OracleAggregator indexer...');

    this.isRunning = false;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.wsOracleAggregator) {
      void this.wsOracleAggregator.removeAllListeners();
      this.wsOracleAggregator = null;
    }

    if (this.wsProvider) {
      void this.wsProvider.removeAllListeners();
      void this.wsProvider.destroy();
      this.wsProvider = null;
    }

    const maxWaitTime = 30000;
    const startTime = Date.now();

    while (!this.eventQueue.isEmpty() && (Date.now() - startTime) < maxWaitTime) {
      log.info(`Waiting for ${this.eventQueue.size()} OracleAggregator events to complete before stopping`);
      await sleep(1000);
    }

    if (!this.eventQueue.isEmpty()) {
      log.warn(`Stopping OracleAggregator indexer with ${this.eventQueue.size()} unprocessed events after timeout`);
    }

    log.info('OracleAggregator indexer stopped');
  }

  private async processHistoricalEvents(): Promise<void> {
    const currentBlock = await this.withTimeout(this.httpProvider.getBlockNumber(), 'httpProvider.getBlockNumber');

    if (!this.lastProcessedBlock) {
      this.lastProcessedBlock = currentBlock - this.config.startBlockOffset;
    }

    if (currentBlock > this.lastProcessedBlock) {
      log.info(`Processing historical OracleAggregator events from ${this.lastProcessedBlock + 1} to ${currentBlock}`);
      await this.processBlockRange(this.lastProcessedBlock + 1, currentBlock);
    }
  }

  private async startWebSocketListener(): Promise<void> {
    await this.processHistoricalEvents();

    try {
      const wsAgent = getProxyAgent();
      const wsOptions = wsAgent ? { agent: wsAgent } : undefined;
      const ws = new WebSocket(this.config.rpcUrl.replace(/^https?:\/\//, 'wss://'), wsOptions);

      ws.on('error', error => {
        if (!this.isRunning) return;
        log.error('OracleAggregator WebSocket transport error:', error);
        this.reconnectWebSocket();
      });

      ws.on('close', (code, reason) => {
        if (!this.isRunning) return;
        log.warn(`OracleAggregator WebSocket transport closed: ${code} ${reason?.toString?.() ?? ''}`);
        this.reconnectWebSocket();
      });

      this.wsProvider = new ethers.WebSocketProvider(ws, undefined, { staticNetwork: true });

      void this.wsProvider.on('debug', this.debugTrace('WS'));

      this.wsOracleAggregator = new ethers.Contract(
        this.config.oracleAggregatorAddress,
        this.oracleAggregator.interface,
        this.wsProvider
      );

      void this.wsOracleAggregator.on('OracleConsensusReset', async (orderId: string, newRoundId: bigint, event: EventLog) => {
        if (!this.isRunning) return;

        this.eventQueue.add({
          type: 'OracleConsensusReset',
          data: {
            orderId,
            newRoundId: Number(newRoundId)
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

      log.info('OracleAggregator WebSocket listener started');
    } catch (error) {
      log.error('Error starting OracleAggregator WebSocket:', error);
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
        log.warn('OracleAggregator WebSocket health check failed:', error);
        this.reconnectWebSocket();
      }
    }, 60_000);
  }

  private reconnectWebSocket(): void {
    if (!this.isRunning || this.reconnectTimeout) return;

    if (this.wsOracleAggregator) {
      void this.wsOracleAggregator.removeAllListeners();
      this.wsOracleAggregator = null;
    }

    if (this.wsProvider) {
      void this.wsProvider.removeAllListeners();
      void this.wsProvider.destroy();
      this.wsProvider = null;
    }

    log.info('Reconnecting OracleAggregator WebSocket in 5 seconds...');

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      if (this.isRunning) {
        try {
          await this.startWebSocketListener();
        } catch (error) {
          log.error('Error reconnecting OracleAggregator WebSocket:', error);
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
        const events = await this.withTimeout(this.oracleAggregator.queryFilter(
          this.oracleAggregator.filters.OracleConsensusReset(),
          from,
          to
        ), `oracleAggregator.queryFilter ${from}-${to}`);

        for (const event of events) {
          const { args: { orderId, newRoundId } } = this.oracleAggregator.interface.parseLog({
            topics: event.topics,
            data: event.data
          }) as LogDescription;

          this.eventQueue.add({
            type: 'OracleConsensusReset',
            data: {
              orderId,
              newRoundId: Number(newRoundId)
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
        log.error(`Error processing OracleAggregator block range ${from}-${to}:`, error);
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
          log.error(`Error processing OracleAggregator event:`, error);

          if (event.retries < this.config.maxRetries) {
            event.retries++;
            log.info(`Retrying OracleAggregator event processing (${event.retries}/${this.config.maxRetries})`);
            await sleep(this.config.retryDelay);
          } else {
            log.error(`Max retries reached for OracleAggregator event, removing from queue:`, event);
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
      log.debug(`OracleAggregator ${prefix}: ${info.action} -> ${info.payload?.method}`);
    }
  };
}
