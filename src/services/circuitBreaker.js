'use strict';

/**
 * circuitBreaker.js
 * Circuit Breaker service — protects the system from abusive clients by
 * progressively blocking identifiers that repeatedly exceed rate limits.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                   Circuit Breaker State Machine                  │
 * │                                                                 │
 * │   CLOSED ──(failures >= threshold)──▶ OPEN                     │
 * │     ▲                                   │                       │
 * │     │                          (blockedUntil expires)           │
 * │     │                                   ▼                       │
 * │     └──(halfOpen success)──── HALF_OPEN                        │
 * │                                   │                             │
 * │                         (failures in halfOpen)                  │
 * │                                   ▼                             │
 * │                                 OPEN (escalated blockLevel)     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * State per identifier:
 *   {
 *     state:        'CLOSED' | 'OPEN' | 'HALF_OPEN'
 *     failures:     number   — consecutive rate-limit violations
 *     blockedUntil: number   — Unix timestamp (seconds) when block expires
 *     blockLevel:   number   — index into blockDurations[] for escalation
 *     halfOpenHits: number   — requests allowed in HALF_OPEN probe window
 *   }
 *
 * Storage:
 *   • Redis Hash  — `cb:{identifier}` when Redis is connected
 *   • In-memory Map — fallback for single-instance / Redis unavailable
 */

const { getClient } = require('./redisClient');
const { nowInSeconds } = require('../utils/timeUtils');
const logger = require('../utils/logger');

// ─── Configuration ─────────────────────────────────────────────────────────────
const CIRCUIT_BREAKER_CONFIG = {
    /** Number of consecutive rate-limit violations before opening the circuit */
    failureThreshold: 5,

    /**
     * Escalating block durations (seconds):
     *   Level 0 →  5 min
     *   Level 1 → 15 min
     *   Level 2 →  1 hour
     *   Level 3 → 24 hours
     */
    blockDurations: [300, 900, 3600, 86400],

    /** How many requests are allowed through in HALF_OPEN before deciding */
    halfOpenRequests: 3,

    /** Redis key prefix */
    keyPrefix: 'cb',

    /** Redis TTL — slightly longer than the longest block duration */
    redisTTL: 90000, // 25 hours
};

// ─── States ────────────────────────────────────────────────────────────────────
const STATE = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN',
};

// ─── In-memory fallback store ─────────────────────────────────────────────────
// Map<identifier, { state, failures, blockedUntil, blockLevel, halfOpenHits }>
const memoryStore = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default (clean) state for a new identifier. */
function defaultState() {
    return {
        state: STATE.CLOSED,
        failures: 0,
        blockedUntil: 0,
        blockLevel: 0,
        halfOpenHits: 0,
    };
}

/** Build the Redis key for an identifier. */
function redisKey(identifier) {
    return `${CIRCUIT_BREAKER_CONFIG.keyPrefix}:${identifier}`;
}

/**
 * Read state from Redis (returns null if key doesn't exist or Redis is down).
 */
async function _readRedis(identifier) {
    const client = getClient();
    if (!client) return null;

    const raw = await client.hGetAll(redisKey(identifier));
    if (!raw || !raw.state) return null;

    return {
        state: raw.state,
        failures: parseInt(raw.failures, 10) || 0,
        blockedUntil: parseInt(raw.blockedUntil, 10) || 0,
        blockLevel: parseInt(raw.blockLevel, 10) || 0,
        halfOpenHits: parseInt(raw.halfOpenHits, 10) || 0,
    };
}

/**
 * Persist state to Redis + refresh TTL.
 */
async function _writeRedis(identifier, st) {
    const client = getClient();
    if (!client) return;

    const key = redisKey(identifier);
    await client.hSet(key, {
        state: st.state,
        failures: String(st.failures),
        blockedUntil: String(st.blockedUntil),
        blockLevel: String(st.blockLevel),
        halfOpenHits: String(st.halfOpenHits),
    });
    await client.expire(key, CIRCUIT_BREAKER_CONFIG.redisTTL);
}

/**
 * Get state with automatic OPEN → HALF_OPEN transition when block expires.
 * Writes back to store if a state transition occurred.
 */
async function _getOrDefault(identifier) {
    // Try Redis first
    let st = await _readRedis(identifier);

    // Fall back to memory
    if (!st) {
        st = memoryStore.get(identifier) || defaultState();
    }

    // ── Auto-transition: OPEN → HALF_OPEN when block expires ──────────────────
    if (st.state === STATE.OPEN && nowInSeconds() >= st.blockedUntil) {
        st.state = STATE.HALF_OPEN;
        st.halfOpenHits = 0;
        logger.info('Circuit breaker transitioning to HALF_OPEN', { identifier });
        await _save(identifier, st);
    }

    return st;
}

/** Save to both Redis (if available) and memory. */
async function _save(identifier, st) {
    memoryStore.set(identifier, { ...st });
    await _writeRedis(identifier, st);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current circuit state for an identifier.
 *
 * @param {string} identifier
 * @returns {Promise<{ state: string, failures: number, blockedUntil: number, blockLevel: number, halfOpenHits: number }>}
 */
async function getState(identifier) {
    return _getOrDefault(identifier);
}

/**
 * Determine whether a request should be allowed through.
 *
 * Returns:
 *   { allowed: true }                          — CLOSED or HALF_OPEN probe
 *   { allowed: false, retryAfter: number }     — OPEN or HALF_OPEN exhausted
 *
 * @param {string} identifier
 * @returns {Promise<{ allowed: boolean, retryAfter?: number, state: string }>}
 */
async function allowRequest(identifier) {
    const st = await _getOrDefault(identifier);

    if (st.state === STATE.CLOSED) {
        return { allowed: true, state: STATE.CLOSED };
    }

    if (st.state === STATE.OPEN) {
        // Still blocked
        const retryAfter = Math.max(1, st.blockedUntil - nowInSeconds());
        return { allowed: false, retryAfter, state: STATE.OPEN };
    }

    // ── HALF_OPEN: allow limited probe requests ────────────────────────────────
    if (st.halfOpenHits < CIRCUIT_BREAKER_CONFIG.halfOpenRequests) {
        st.halfOpenHits += 1;
        await _save(identifier, st);
        return { allowed: true, state: STATE.HALF_OPEN };
    }

    // HALF_OPEN probe window exhausted — treat as still blocked
    const retryAfter = Math.max(1, st.blockedUntil - nowInSeconds());
    return { allowed: false, retryAfter, state: STATE.HALF_OPEN };
}

/**
 * Record a rate-limit failure for an identifier.
 * Escalates block level if abuse continues after HALF_OPEN probing.
 *
 * @param {string} identifier
 */
async function recordFailure(identifier) {
    const st = await _getOrDefault(identifier);
    const { failureThreshold, blockDurations } = CIRCUIT_BREAKER_CONFIG;

    st.failures += 1;

    if (st.state === STATE.HALF_OPEN) {
        // Misbehaving during probe → escalate to next block level
        st.blockLevel = Math.min(st.blockLevel + 1, blockDurations.length - 1);
        _openCircuit(st);
        logger.warn('Circuit breaker re-opened (HALF_OPEN failure)', { identifier, blockLevel: st.blockLevel });
    } else if (st.state === STATE.CLOSED && st.failures >= failureThreshold) {
        // First trip
        _openCircuit(st);
        logger.warn('Circuit breaker opened', { identifier, failures: st.failures });
    }

    await _save(identifier, st);
}

/**
 * Record a successful request — resets the failure counter.
 * Fully closes the circuit if coming from HALF_OPEN.
 *
 * @param {string} identifier
 */
async function recordSuccess(identifier) {
    const st = await _getOrDefault(identifier);

    if (st.state === STATE.HALF_OPEN) {
        // Successful probe → fully restore
        logger.info('Circuit breaker closed after successful HALF_OPEN probe', { identifier });
        Object.assign(st, defaultState());
    } else if (st.state === STATE.CLOSED && st.failures > 0) {
        // Gradually heal — reset failure counter on success
        st.failures = 0;
    }

    await _save(identifier, st);
}

/**
 * Manually reset the circuit breaker for an identifier (admin action).
 *
 * @param {string} identifier
 */
async function reset(identifier) {
    memoryStore.delete(identifier);

    const client = getClient();
    if (client) {
        await client.del(redisKey(identifier));
    }

    logger.info('Circuit breaker manually reset', { identifier });
}

/**
 * Flush entire in-memory store (useful in tests).
 */
function flushMemory() {
    memoryStore.clear();
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Mutate state object into OPEN state using the current block level. */
function _openCircuit(st) {
    const duration = CIRCUIT_BREAKER_CONFIG.blockDurations[st.blockLevel];
    st.state = STATE.OPEN;
    st.blockedUntil = nowInSeconds() + duration;
    st.halfOpenHits = 0;
}

module.exports = {
    getState,
    allowRequest,
    recordFailure,
    recordSuccess,
    reset,
    flushMemory,
    STATE,
    CIRCUIT_BREAKER_CONFIG,
};
