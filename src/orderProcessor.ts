import { EventQueue } from './eventQueue.js';
import { log, sleep } from './utils.js';

interface OrderEvent {
  orderId: string;
  status: string;
}

export abstract class OrderProcessor {
  protected isRunning: boolean = true;
  protected delayedQueue: EventQueue<OrderEvent>;

  protected constructor() {
    this.delayedQueue = new EventQueue<OrderEvent>();

    this.processDelayedQueue().then(() => undefined);
  }

  abstract process(orderId: string, status: string): Promise<void>;

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
    while (!this.delayedQueue.isEmpty() && this.isRunning) {
      const event = this.delayedQueue.peek();

      if (event) {
        try {
          await this.process(event.orderId, event.status);

          this.delayedQueue.remove();
        } catch (error) {
          log.error(`Error processing delayed event:`, error);
        }
      }
    }

    setTimeout(async () => await this.processDelayedQueue(), 5000);
  }
}
