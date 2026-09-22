'use strict';

/**
 * identifier.js
 * Extracts a unique identifier from an incoming Express request.
 *
 * Priority chain:
 *   1. X-API-Key header    — preferred in API-key-authenticated services
 *   2. X-User-ID header    — user-level limiting (after auth middleware sets it)
 *   3. req.ip              — IP-based fallback (handles proxies via trust proxy)
 */

/**
 * Returns the best available identifier for rate limiting.
 *
 * @param {import('express').Request} req
 * @returns {string} identifier string
 */
function getIdentifier(req) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey.trim()) {
        return `apikey:${apiKey.trim()}`;
    }

    const userId = req.headers['x-user-id'];
    if (userId && userId.trim()) {
        return `user:${userId.trim()}`;
    }

    // req.ip respects `app.set('trust proxy', 1)` for X-Forwarded-For
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return `ip:${ip}`;
}

/**
 * Detects the tier for the request based on its identifier or headers.
 * Extend this to perform DB lookups, JWT parsing, etc.
 *
 * @param {import('express').Request} req
 * @returns {'FREE' | 'PRO' | 'ENTERPRISE'}
 */
function getTier(req) {
    const tier = (req.headers['x-user-tier'] || '').toUpperCase();
    if (['FREE', 'PRO', 'ENTERPRISE'].includes(tier)) {
        return tier;
    }
    return 'FREE'; // safe default
}

module.exports = { getIdentifier, getTier };
