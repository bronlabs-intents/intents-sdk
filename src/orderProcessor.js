import { EventQueue } from './eventQueue.js';
import { log, sleep } from './utils.js';

export class OrderProcessor {
  constructor(config) {
    this.isRunning    = true;
    this.delayedQueue = new EventQueue();

    this.processDelayedQueue().then(r => {
    });
  }

  async process(orderId, status) {
    // implementation here
  }

  async stop() {
    if (!this.isRunning) {
      log.warn('Oracle processor already stopped');
      return;
    }

    log.info('Stopping Oracle processor...');

    this.isRunning = false;

    await sleep(3000);

    log.info('Oracle processor stopped.');
  }

  async processDelayedQueue() {
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
