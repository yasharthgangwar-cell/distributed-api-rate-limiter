'use strict';

/**
 * slidingWindow.js
 * Sliding Window Counter rate limiting algorithm.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  Sliding Window Model                                        │
 * │                                                              │
 * │  • Tracks timestamps of every request in the last N seconds  │
 * │  • `windowSize` = duration of the window in seconds          │
 * │  • `requestLimit` = max allowed requests within the window   │
 * │  • More accurate than Fixed Window (no burst at boundaries)  │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Modes:
 *   • In-memory — stores timestamps in a JS Map
 *   • Redis     — uses a sorted set (ZADD / ZREMRANGEBYSCORE / ZCARD)
 *                 with atomic pipeline
 */

const { nowInMs } = require('../utils/timeUtils');
const { getClient } = require('../services/redisClient');
const { redisKeyPrefix } = require('../config/rateLimitConfig');

// ─── In-memory store ──────────────────────────────────────────────────────────
// Map<identifier, number[]>  — array of request timestamps (ms)
const memoryStore = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * In-memory sliding window check.
 */
function _memoryConsume(identifier, windowSize, requestLimit) {
    const nowMs = nowInMs();
    const windowStartMs = nowMs - windowSize * 1000;

    let timestamps = memoryStore.get(identifier) || [];

    // Remove timestamps outside the current window
    timestamps = timestamps.filter((ts) => ts > windowStartMs);

    const count = timestamps.length;
    const allowed = count < requestLimit;
    const remaining = Math.max(0, requestLimit - count - (allowed ? 1 : 0));

    if (allowed) {
        timestamps.push(nowMs);
    }

    memoryStore.set(identifier, timestamps);

    // resetAt = earliest timestamp + windowSize (when the oldest entry ages out)
    const oldest = timestamps.length > 0 ? timestamps[0] : nowMs;
    const resetAt = Math.ceil((oldest + windowSize * 1000) / 1000);

    return { allowed, count: allowed ? count + 1 : count, requestLimit, remaining, resetAt };
}

/**
 * Redis sliding window using sorted set + pipeline (atomic).
 * Score = timestamp in ms.
 */
async function _redisConsume(identifier, windowSize, requestLimit, ttl) {
    const redisClient = getClient();
    if (!redisClient) return null;

    const key = `${redisKeyPrefix}:sw:${identifier}`;
    const nowMs = nowInMs();
    const windowStartMs = nowMs - windowSize * 1000;

    try {
        // Use a pipeline for atomicity across the read-write sequence
        const pipeline = redisClient.multi();
        pipeline.zRemRangeByScore(key, '-inf', windowStartMs); // purge old entries
        pipeline.zAdd(key, [{ score: nowMs, value: String(nowMs) }]);
        pipeline.zCard(key);                                    // count after add
        pipeline.expire(key, ttl);

        const results = await pipeline.exec();
        const count = results[2]; // ZCARD result

        const allowed = count <= requestLimit;
        if (!allowed) {
            // Remove the entry we just added since we're denying the request
            await redisClient.zRem(key, String(nowMs));
        }

        const oldest = await redisClient.zRange(key, 0, 0, { BY: 'RANK' });
        const oldestScore = oldest.length > 0 ? parseFloat(oldest[0]) : nowMs;
        const resetAt = Math.ceil((oldestScore + windowSize * 1000) / 1000);
        const remaining = Math.max(0, requestLimit - (allowed ? count : count - 1));

        return {
            allowed,
            count: allowed ? count : count - 1,
            requestLimit,
            remaining,
            resetAt,
        };
    } catch (_err) {
        return null; // fall back to memory
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a request from `identifier` is allowed within the sliding window.
 *
 * @param {string} identifier
 * @param {object} opts
 * @param {number} opts.windowSize    — window duration in seconds
 * @param {number} opts.requestLimit  — max requests per window
 * @param {number} [opts.ttl=7200]    — Redis key TTL in seconds
 * @returns {Promise<{ allowed: boolean, count: number, requestLimit: number, remaining: number, resetAt: number }>}
 */
async function consume(identifier, { windowSize, requestLimit, ttl = 7200 }) {
    try {
        const redisResult = await _redisConsume(identifier, windowSize, requestLimit, ttl);
        if (redisResult) return redisResult;
    } catch (_err) {
        // fall through
    }

    return _memoryConsume(identifier, windowSize, requestLimit);
}

/**
 * Reset the sliding window for an identifier.
 *
 * @param {string} identifier
 */
async function reset(identifier) {
    memoryStore.delete(identifier);

    const redisClient = getClient();
    if (redisClient) {
        await redisClient.del(`${redisKeyPrefix}:sw:${identifier}`);
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
        const key = `${redisKeyPrefix}:sw:${identifier}`;
        const nowMs = nowInMs();
        const windowStartMs = nowMs - 3600 * 1000; // use default window
        const count = await redisClient.zCount(key, windowStartMs, '+inf');
        return count !== null ? { store: 'redis', count } : null;
    }

    const timestamps = memoryStore.get(identifier);
    if (timestamps) {
        return { store: 'memory', count: timestamps.length };
    }

    return null;
}

/**
 * Flush all in-memory state (useful in tests).
 */
function flushMemory() {
    memoryStore.clear();
}

module.exports = { consume, reset, getState, flushMemory };
