# `cache-manager-ts`

TypeScript `cache-manager` interface.

Supports the following caching strategies:

- (wip) `no-cache`
- (wip) `memcached` (using [memcached](https://www.npmjs.com/package/memcached))
- (wip) `memoize`
- (wip) `redis` (using [redis](https://www.npmjs.com/package/redis))

##  TODOs

- [ ] complete memcached strategy (only cache/get/set available)
- [ ] memcached: consider the concurrent hashmap scenario?
- [ ] implement remaining caching strategies

## Configuration

This library reads the existing config file and scans for the following properties under the `cache` key:

```ts
{
  // ...
  cache: {
    strategy: <strategy>,
    [strategy name]: {
      [strategy options]
    }
  }
}
```

Per-strategy configs can be set by using the desired strategy name as a key.
These values are then passed down to the strategy, and must be supported by the client library to take effect.

For example, the `memcached` strategy can be configured with the following properties:

```ts
{
  // ...
  cache: {
    strategy: 'memcached',
    memcached: {
      hosts: ['localhost:11211'], // type: string | string[] | {[server: string]: number}
      options: {
        maxKeySize:    1 // type: number | undefined
        maxExpiration: 2 // type: number | undefined
        maxValue:      3 // type: number | undefined
        // ...
      }
    }
  }
}
```

## Development

```sh
yarn dev
```

## Testing

requirements:

- memcached node running locally on `localhost:11211`

```sh
yarn test
```

---

## Strategy configuration reference

### `no-cache`

(no options)

### `memcached`

```ts
interface MemcachedConfig {
  hosts: string | string[] | { [server: string]: number };
  options?: {
    /**
     * 250, the maximum key size allowed.
     */
    maxKeySize?: number | undefined;
    /**
     * 2592000, the maximum expiration time of keys (in seconds).
     */
    maxExpiration?: number | undefined;
    /**
     * 1048576, the maximum size of a value.
     */
    maxValue?: number | undefined;
    /**
     * 10, the maximum size of the connection pool.
     */
    poolSize?: number | undefined;
    /**
     * md5, the hashing algorithm used to generate the hashRing values.
     */
    algorithm?: string | undefined;
    /**
     * 18000000, the time between reconnection attempts (in milliseconds).
     */
    reconnect?: number | undefined;
    /**
     * 5000, the time after which Memcached sends a connection timeout (in milliseconds).
     */
    timeout?: number | undefined;
    /**
     * 5, the number of socket allocation retries per request.
     */
    retries?: number | undefined;
    /**
     * 5, the number of failed-attempts to a server before it is regarded as 'dead'.
     */
    failures?: number | undefined;
    /**
     * 30000, the time between a server failure and an attempt to set it up back in service.
     */
    retry?: number | undefined;
    /**
     * false, if true, authorizes the automatic removal of dead servers from the pool.
     */
    remove?: boolean | undefined;
    /**
     * undefined, an array of server_locations to replace servers that fail and that are removed from the consistent hashing scheme.
     */
    failOverServers?: string | string[] | undefined;
    /**
     * true, whether to use md5 as hashing scheme when keys exceed maxKeySize.
     */
    keyCompression?: boolean | undefined;
    /**
     * 5000, the idle timeout for the connections.
     */
    idle?: number | undefined;
    /**
     * '', sentinel to prepend to all memcache keys for namespacing the entries.
     */
    namespace?: string | undefined;
  };
}
```

###  `memoize`

###  `redis`

```ts
interface RedisClientOptions {
  url?: string;
  socket?: RedisSocketOptions;
  username?: string;
  password?: string;
  name?: string;
  database?: number;
  commandsQueueMaxLength?: number;
  disableOfflineQueue?: boolean;
  readonly?: boolean;
  legacyMode?: boolean;
  isolationPoolOptions?: PoolOptions;
  // more options available: RedisModules, RedisFunctions, RedisScripts
}
```
