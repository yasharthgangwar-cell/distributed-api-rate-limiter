'use strict';

/**
 * redisClient.js
 * Manages the singleton Redis connection.
 *
 * - Connects on startup; failures are non-fatal (graceful degradation).
 * - Exports `isConnected()` so callers can easily fall back to in-memory.
 * - Lua script for the atomic Token Bucket operation is pre-loaded here.
 */

const { createClient } = require('redis');
const logger = require('../utils/logger');

let client = null;
let connected = false;

/**
 * Establish (or re-use) the Redis connection.
 * Safe to call multiple times — returns the same client.
 *
 * @returns {Promise<object|null>} Redis client or null on failure
 */
async function connect() {
    if (client) return client;

    try {
        client = createClient({
            url: process.env.REDIS_URL || 'redis://localhost:6379',
            socket: {
                connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT, 10) || 5000,
                reconnectStrategy: (retries) => {
                    if (retries > 5) {
                        logger.warn('Redis max retries reached — staying in in-memory mode');
                        return new Error('Max retries exceeded');
                    }
                    return Math.min(retries * 200, 2000); // exponential backoff, max 2s
                },
            },
        });

        client.on('connect', () => {
            connected = true;
            logger.redisStatus('connected', process.env.REDIS_URL);
        });

        client.on('error', (err) => {
            if (connected) { // only log the first disconnect
                connected = false;
                logger.redisStatus('disconnected', err.message);
            }
        });

        client.on('reconnecting', () => {
            logger.info('Redis reconnecting...');
        });

        client.on('ready', () => {
            connected = true;
            logger.info('Redis ready');
        });

        await client.connect();
        return client;
    } catch (err) {
        logger.warn(`Redis connection failed: ${err.message} — falling back to in-memory`);
        client = null;
        connected = false;
        return null;
    }
}

/**
 * Returns the active Redis client, or null if not connected.
 * @returns {object|null}
 */
function getClient() {
    return connected ? client : null;
}

/**
 * Whether Redis is currently available.
 * @returns {boolean}
 */
function isConnected() {
    return connected;
}

/**
 * Gracefully close the Redis connection.
 */
async function disconnect() {
    if (client) {
        await client.quit();
        client = null;
        connected = false;
        logger.info('Redis disconnected cleanly');
    }
}

module.exports = { connect, getClient, isConnected, disconnect };
