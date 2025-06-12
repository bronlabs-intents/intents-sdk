class EventQueue {
  constructor() {
    this.queue = [];
  }

  add(event) {
    this.queue.push(event);
  }

  peek() {
    return this.queue[0];
  }

  remove() {
    return this.queue.shift();
  }

  isEmpty() {
    return this.queue.length === 0;
  }

  size() {
    return this.queue.length;
  }
}

module.exports = { EventQueue };
