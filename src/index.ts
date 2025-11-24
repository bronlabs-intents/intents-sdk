export * from './orderIndexer.js';
export * from './orderProcessor.js';
export * from './config.js';
export * from './eventQueue.js';
export * from './contracts.js';
export * from './utils.js';
export { initNetworks } from './networks/index.js';

// Monkey-patch BigInt.prototype.toJSON
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
