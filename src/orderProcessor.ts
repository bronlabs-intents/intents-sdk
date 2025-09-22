import { EventQueue } from './eventQueue.js';
import { log, sleep } from './utils.js';

type OrderEvent = {
  orderId: string;
  status: bigint;
  attempts?: number;
  nextAttemptAt?: number;
};

export abstract class OrderProcessor {
  protected isRunning: boolean = true;
  protected delayedQueue: EventQueue<OrderEvent>;

  protected constructor() {
    this.delayedQueue = new EventQueue<OrderEvent>();
    this.processDelayedQueue().then(() => undefined);
  }

  abstract process(orderId: string, status: bigint): Promise<void>;

  async stop(): Promise<void> {
    if (!this.isRunning) {
      log.warn('Order processor already stopped');
      return;
    }

    log.info('Stopping Order processor...');

    this.isRunning = false;

    await sleep(3000);

    log.info('Order processor stopped.');
  }

  private async processDelayedQueue(): Promise<void> {
    const start = this.delayedQueue.peek();
    let looped = false;

    while (!this.delayedQueue.isEmpty() && this.isRunning) {
      const event = this.delayedQueue.peek();
      if (!event) break;

      event.attempts = event.attempts ?? 0;
      event.nextAttemptAt = event.nextAttemptAt ?? 0;

      if (event.nextAttemptAt > Date.now()) {
        this.delayedQueue.remove();
        this.delayedQueue.add(event);

        if (start && event.orderId === start.orderId) {
          if (looped) break;
          looped = true;
        }

        continue;
      }

      try {
        await this.process(event.orderId, event.status);
        this.delayedQueue.remove();
      } catch (error) {
        log.error(`Error processing delayed event ${event.orderId} ${event.status}:`, error);
        event.attempts += 1;
        event.nextAttemptAt = Date.now() + this.backoffMs(event.attempts);

        this.delayedQueue.remove();
        this.delayedQueue.add(event);
      }
    }

    setTimeout(async () => await this.processDelayedQueue(), 1000);
  }

  private backoffMs(attempts: number): number {
    return Math.min(60000, 3000 * 2 ** Math.max(0, attempts - 1));
  }
}
