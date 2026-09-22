'use strict';

/**
 * rateLimiter.js
 * Express middleware factory for rate limiting.
 *
 * Request flow (with Circuit Breaker):
 *   1. Extract identifier
 *   2. Check Circuit Breaker state
 *      ├─ OPEN / HALF_OPEN exhausted → reject 429 immediately (no rate limit hit)
 *      └─ CLOSED / HALF_OPEN probe  → proceed to rate limiter
 *   3. Run Token Bucket or Sliding Window algorithm
 *      ├─ Allowed  → recordSuccess() (heals circuit), call next()
 *      └─ Denied   → recordFailure() (may open circuit), return 429
 *
 * Response headers on every request:
 *   X-RateLimit-Limit     — max allowed requests in the window/bucket
 *   X-RateLimit-Remaining — tokens/requests left
 *   X-RateLimit-Reset     — Unix timestamp (seconds) when limit resets
 *   Retry-After           — seconds to wait (only on 429)
 *   X-CB-State            — current circuit breaker state (informational)
 */

const tokenBucket = require('../algorithms/tokenBucket');
const slidingWindow = require('../algorithms/slidingWindow');
const circuitBreaker = require('../services/circuitBreaker');
const { getIdentifier, getTier } = require('../utils/identifier');
const rateLimitConfig = require('../config/rateLimitConfig');
const logger = require('../utils/logger');

/**
 * Creates a rate limiter Express middleware with circuit breaker integration.
 *
 * @param {object} [options]
 * @param {'tokenBucket'|'slidingWindow'} [options.algorithm]
 * @param {'FREE'|'PRO'|'ENTERPRISE'}     [options.tier]
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(options = {}) {
    const algorithm = options.algorithm || rateLimitConfig.defaultAlgorithm;

    return async function rateLimiterMiddleware(req, res, next) {
        const identifier = getIdentifier(req);
        const tier = options.tier || getTier(req);

        // ── Step 1: Circuit Breaker pre-check ──────────────────────────────────
        let cbCheck;
        try {
            cbCheck = await circuitBreaker.allowRequest(identifier);
        } catch (err) {
            // CB error — fail open, continue to rate limiter
            logger.error('Circuit breaker check error — failing open', {
                error: err.message,
                identifier,
            });
            cbCheck = { allowed: true, state: 'CLOSED' };
        }

        // Attach circuit breaker state as an informational header
        res.setHeader('X-CB-State', cbCheck.state);

        if (!cbCheck.allowed) {
            // Circuit is OPEN — block immediately without running the rate limiter
            const { retryAfter } = cbCheck;

            logger.warn('Circuit breaker OPEN — request blocked', {
                identifier,
                retryAfter,
                state: cbCheck.state,
            });

            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit', 0);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', Math.floor(Date.now() / 1000) + retryAfter);

            return res.status(429).json({
                error: 'Circuit Open',
                message: 'User temporarily blocked due to repeated rate limit violations.',
                retryAfter,
                state: cbCheck.state,
            });
        }

        // ── Step 2: Run rate limiting algorithm ────────────────────────────────
        let result;
        try {
            if (algorithm === 'slidingWindow') {
                const { windowSize, requestLimit } = rateLimitConfig.slidingWindow[tier];
                result = await slidingWindow.consume(identifier, {
                    windowSize,
                    requestLimit,
                    ttl: rateLimitConfig.redisTTL,
                });
                res.setHeader('X-RateLimit-Limit', requestLimit);
                res.setHeader('X-RateLimit-Remaining', result.remaining);
                res.setHeader('X-RateLimit-Reset', result.resetAt);
            } else {
                // Token Bucket (default)
                const { capacity, refillRate } = rateLimitConfig.tokenBucket[tier];
                result = await tokenBucket.consume(identifier, {
                    capacity,
                    refillRate,
                    ttl: rateLimitConfig.redisTTL,
                });
                res.setHeader('X-RateLimit-Limit', result.capacity);
                res.setHeader('X-RateLimit-Remaining', result.tokens);
                res.setHeader('X-RateLimit-Reset', result.resetAt);
            }
        } catch (err) {
            // Unexpected rate limit error — fail open to avoid downtime
            logger.error('Rate limiter error — failing open', {
                error: err.message,
                identifier,
                requestId: req.requestId,
            });
            await circuitBreaker.recordSuccess(identifier); // treat as success
            return next();
        }

        // ── Step 3: Enforce result ────────────────────────────────────────────
        if (!result.allowed) {
            const resetAt = result.resetAt;
            const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));

            // Record failure → may open the circuit breaker
            try {
                await circuitBreaker.recordFailure(identifier);
            } catch (err) {
                logger.error('Circuit breaker recordFailure error', { error: err.message, identifier });
            }

            logger.rateLimitExceeded(identifier, result.remaining ?? result.tokens ?? 0, resetAt);

            res.setHeader('Retry-After', retryAfter);

            return res.status(429).json({
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Try again in ${retryAfter} second(s).`,
                retryAfter,
                resetAt,
            });
        }

        // ── Step 4: Success — heal the circuit breaker ────────────────────────
        try {
            await circuitBreaker.recordSuccess(identifier);
        } catch (err) {
            logger.error('Circuit breaker recordSuccess error', { error: err.message, identifier });
        }

        return next();
    };
}

module.exports = { createRateLimiter };
