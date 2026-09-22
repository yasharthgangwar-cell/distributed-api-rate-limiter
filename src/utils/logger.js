'use strict';

/**
 * logger.js
 * Centralized Winston logger for the API Rate Limiter Service.
 *
 * Log levels: error > warn > info > http > debug
 * In production (NODE_ENV=production) only warn+ logs go to the console.
 */

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, colorize, printf, json } = format;

const isProduction = process.env.NODE_ENV === 'production';

// ─── Custom console format ───────────────────────────────────────────────────
const consoleFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] ${level}: ${message}${metaStr}`;
});

const logger = createLogger({
    level: isProduction ? 'warn' : 'debug',
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), json()),
    transports: [
        // ── Console ──────────────────────────────────────────────────────────────
        new transports.Console({
            format: combine(
                colorize({ all: true }),
                timestamp({ format: 'HH:mm:ss' }),
                consoleFormat
            ),
        }),
    ],
});

// ─── Convenience wrappers ────────────────────────────────────────────────────

/** Log a rate-limit-exceeded event. */
logger.rateLimitExceeded = (identifier, remaining, resetAt) => {
    logger.warn('Rate limit exceeded', { identifier, remaining, resetAt });
};

/** Log Redis connection status changes. */
logger.redisStatus = (status, detail) => {
    if (status === 'connected') {
        logger.info('Redis connected', { detail });
    } else {
        logger.warn('Redis disconnected — switching to in-memory fallback', { detail });
    }
};

/** Log server start. */
logger.serverStarted = (port) => {
    logger.info(`Server started on port ${port}`);
};

module.exports = logger;
