'use strict';

/**
 * tokenBucket.js
 * Token Bucket rate limiting algorithm.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │  Token Bucket Model                                      │
 * │                                                          │
 * │  • Bucket holds up to `capacity` tokens                  │
 * │  • Tokens refill at `refillRate` tokens/second           │
 * │  • Each request consumes 1 token                         │
 * │  • If tokens < 1 → deny (429)                            │
 * │  • Allows burst (up to `capacity` simultaneous requests) │
 * └──────────────────────────────────────────────────────────┘
 *
 * Modes:
 *   • In-memory — uses a JS Map (single-instance only)
 *   • Redis     — uses an atomic Lua script (distributed-safe)
 */

const { nowInSeconds } = require('../utils/timeUtils');
const { getClient } = require('../services/redisClient');
const { redisKeyPrefix } = require('../config/rateLimitConfig');

// ─── In-memory store ──────────────────────────────────────────────────────────
// Map<identifier, { tokens, capacity, refillRate, lastRefill }>
const memoryStore = new Map();

// ─── Lua script for atomic Redis Token Bucket ─────────────────────────────────
/**
 * KEYS[1]  = Redis key  e.g. "rate_limit:ip:127.0.0.1"
 * ARGV[1]  = capacity   (number)
 * ARGV[2]  = refillRate (tokens per second, float)
 * ARGV[3]  = now        (Unix timestamp seconds)
 * ARGV[4]  = ttl        (seconds)
 *
 * Returns a flat array: { allowed (0|1), tokens, capacity, resetAt }
 */
const TOKEN_BUCKET_LUA = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local ttl        = tonumber(ARGV[4])

-- Read existing state
local data       = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens     = tonumber(data[1])
local lastRefill = tonumber(data[2])

-- Bootstrap if key does not yet exist
if tokens == nil or lastRefill == nil then
  tokens     = capacity
  lastRefill = now
end

-- Refill
local elapsed = now - lastRefill
local newTokens = tokens + (elapsed * refillRate)
if newTokens > capacity then
  newTokens = capacity
end

-- Consume
local allowed = 0
if newTokens >= 1 then
  newTokens = newTokens - 1
  allowed   = 1
end

-- Persist state
redis.call('HSET', key, 'tokens', newTokens, 'lastRefill', now, 'capacity', capacity)
redis.call('EXPIRE', key, ttl)

-- secondsUntilFull = (capacity - newTokens) / refillRate
local resetAt = now + math.ceil((capacity - newTokens) / refillRate)

return { allowed, tostring(newTokens), tostring(capacity), tostring(resetAt) }
`;

// Cache the Lua SHA so we use EVALSHA on subsequent calls
let luaSha = null;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Perform in-memory token bucket check.
 */
function _memoryConsume(identifier, capacity, refillRate) {
    const now = nowInSeconds();

    let bucket = memoryStore.get(identifier);
    if (!bucket) {
        bucket = { tokens: capacity, capacity, refillRate, lastRefill: now };
        memoryStore.set(identifier, bucket);
    }

    // Refill
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    const resetAt = Math.ceil(now + (capacity - bucket.tokens) / refillRate);

    return {
        allowed,
        tokens: Math.floor(bucket.tokens),
        capacity,
        resetAt,
    };
}

/**
 * Perform Redis token bucket check using an atomic Lua script.
 */
async function _redisConsume(identifier, capacity, refillRate, ttl) {
    const redisClient = getClient();
    if (!redisClient) return null; // signal caller to fall back

    const key = `${redisKeyPrefix}:${identifier}`;
    const now = nowInSeconds();

    try {
        // Load Lua script on first call
        if (!luaSha) {
            luaSha = await redisClient.scriptLoad(TOKEN_BUCKET_LUA);
        }

        const result = await redisClient.evalSha(luaSha, {
            keys: [key],
            arguments: [
                String(capacity),
                String(refillRate),
                String(now),
                String(ttl),
            ],
        });

        const [allowedRaw, tokensRaw, capacityRaw, resetAtRaw] = result;

        return {
            allowed: allowedRaw === 1 || allowedRaw === '1',
            tokens: Math.floor(parseFloat(tokensRaw)),
            capacity: parseInt(capacityRaw, 10),
            resetAt: parseInt(resetAtRaw, 10),
        };
    } catch (err) {
        // If script was flushed from Redis (SCRIPT FLUSH), reset SHA and retry once
        if (err.message && err.message.includes('NOSCRIPT')) {
            luaSha = null;
            return _redisConsume(identifier, capacity, refillRate, ttl);
        }
        throw err;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to consume one token for `identifier`.
 *
 * @param {string} identifier  — unique key (e.g. "ip:127.0.0.1")
 * @param {object} opts
 * @param {number} opts.capacity    — max tokens (burst ceiling)
 * @param {number} opts.refillRate  — tokens refilled per second
 * @param {number} [opts.ttl=7200]  — Redis key TTL in seconds
 * @returns {Promise<{ allowed: boolean, tokens: number, capacity: number, resetAt: number }>}
 */
async function consume(identifier, { capacity, refillRate, ttl = 7200 }) {
    // Try Redis first
    try {
        const redisResult = await _redisConsume(identifier, capacity, refillRate, ttl);
        if (redisResult) return redisResult;
    } catch (_err) {
        // Redis error — fall through to memory
    }

    // In-memory fallback
    return _memoryConsume(identifier, capacity, refillRate);
}

/**
 * Reset the token bucket for an identifier (both stores).
 *
 * @param {string} identifier
 */
async function reset(identifier) {
    memoryStore.delete(identifier);

    const redisClient = getClient();
    if (redisClient) {
        await redisClient.del(`${redisKeyPrefix}:${identifier}`);
    }
}

/**
 * Inspect current state for an identifier (read-only).
 *
 * @param {string} identifier
 * @returns {Promise<object|null>}
 */
async function getState(identifier) {
    const redisClient = getClient();
    if (redisClient) {
        const key = `${redisKeyPrefix}:${identifier}`;
        const data = await redisClient.hGetAll(key);
        if (data && data.tokens !== undefined) {
            return {
                store: 'redis',
                tokens: parseFloat(data.tokens),
                capacity: parseFloat(data.capacity),
                lastRefill: parseInt(data.lastRefill, 10),
            };
        }
    }

    const bucket = memoryStore.get(identifier);
    if (bucket) {
        return { store: 'memory', ...bucket };
    }

    return null;
}

/**
 * Flush the entire in-memory store (useful in tests).
 */
function flushMemory() {
    memoryStore.clear();
}

module.exports = { consume, reset, getState, flushMemory };
