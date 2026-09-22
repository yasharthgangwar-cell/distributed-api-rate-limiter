'use strict';

/**
 * adminRoutes.js
 * Administrative routes for inspecting and resetting rate limit state.
 * These routes should be protected by auth/IP-whitelisting in production.
 */

const { Router } = require('express');
const tokenBucket = require('../algorithms/tokenBucket');
const slidingWindow = require('../algorithms/slidingWindow');
const circuitBreaker = require('../services/circuitBreaker');
const { isConnected } = require('../services/redisClient');
const rateLimitConfig = require('../config/rateLimitConfig');
const logger = require('../utils/logger');

const router = Router();

/**
 * POST /admin/reset
 * Reset rate limit counters for a specific identifier.
 *
 * Body: { "identifier": "ip:127.0.0.1" }
 *       or just { "identifier": "user:alice" }
 */
router.post('/reset', async (req, res) => {
    const { identifier } = req.body;

    if (!identifier) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'identifier is required in the request body',
        });
    }

    try {
        await tokenBucket.reset(identifier);
        await slidingWindow.reset(identifier);

        logger.info('Rate limit reset', { identifier, requestId: req.requestId });

        return res.status(200).json({
            success: true,
            message: `Rate limit counters reset for "${identifier}"`,
            identifier,
        });
    } catch (err) {
        logger.error('Failed to reset rate limit', { identifier, error: err.message });
        return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
});

/**
 * GET /admin/status
 * Inspect the current rate limit state for a specific identifier.
 *
 * Query: ?identifier=ip:127.0.0.1&algorithm=tokenBucket
 */
router.get('/status', async (req, res) => {
    const { identifier, algorithm } = req.query;

    if (!identifier) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'identifier query param is required',
        });
    }

    const algo = algorithm || rateLimitConfig.defaultAlgorithm;

    try {
        let state;
        if (algo === 'slidingWindow') {
            state = await slidingWindow.getState(identifier);
        } else {
            state = await tokenBucket.getState(identifier);
        }

        return res.status(200).json({
            identifier,
            algorithm: algo,
            redis: isConnected() ? 'connected' : 'disconnected (using in-memory)',
            state: state || { message: 'No state found — identifier has not made any requests yet' },
        });
    } catch (err) {
        logger.error('Failed to get rate limit status', { identifier, error: err.message });
        return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
});

/**
 * GET /health
 * Health check endpoint — returns server and Redis status.
 */
router.get('/health', (_req, res) => {
    return res.status(200).json({
        status: 'ok',
        redis: isConnected() ? 'connected' : 'disconnected',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /admin/circuit-status
 * Inspect the current circuit breaker state for a specific identifier.
 *
 * Query: ?identifier=ip:127.0.0.1
 */
router.get('/circuit-status', async (req, res) => {
    const { identifier } = req.query;

    if (!identifier) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'identifier query param is required',
        });
    }

    try {
        const state = await circuitBreaker.getState(identifier);
        return res.status(200).json({
            identifier,
            state: state.state,
            failures: state.failures,
            blockLevel: state.blockLevel,
            blockedUntil: state.blockedUntil,
            halfOpenHits: state.halfOpenHits,
            redis: isConnected() ? 'connected' : 'disconnected (using in-memory)',
        });
    } catch (err) {
        logger.error('Failed to get circuit breaker status', { identifier, error: err.message });
        return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
});

/**
 * POST /admin/circuit-reset
 * Manually reset the circuit breaker for an identifier.
 *
 * Body: { "identifier": "ip:127.0.0.1" }
 */
router.post('/circuit-reset', async (req, res) => {
    const { identifier } = req.body;

    if (!identifier) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'identifier is required in the request body',
        });
    }

    try {
        await circuitBreaker.reset(identifier);
        logger.info('Circuit breaker manually reset via admin', { identifier, requestId: req.requestId });
        return res.status(200).json({
            success: true,
            message: `Circuit breaker reset for "${identifier}"`,
            identifier,
        });
    } catch (err) {
        logger.error('Failed to reset circuit breaker', { identifier, error: err.message });
        return res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
});

module.exports = router;
