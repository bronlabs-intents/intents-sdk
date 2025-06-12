export class EventQueue<T> {

  private readonly queue: T[];

  constructor() {
    this.queue = [];
  }

  add(event: T): void {
    this.queue.push(event);
  }

  peek(): T | undefined {
    return this.queue[0];
  }

  remove(): T | undefined {
    return this.queue.shift();
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  size(): number {
    return this.queue.length;
  }
}
