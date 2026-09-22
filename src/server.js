'use strict';

/**
 * server.js
 * Application entry point.
 *
 * Responsibilities:
 *  1. Load environment variables
 *  2. Attempt Redis connection (non-blocking)
 *  3. Configure Express (middleware, routes)
 *  4. Start HTTP server
 *  5. Graceful shutdown
 */

require('dotenv').config();

const express = require('express');
const { connect: connectRedis, disconnect: disconnectRedis } = require('./services/redisClient');
const requestId = require('./middleware/requestId');
const apiRoutes = require('./routes/apiRoutes');
const adminRoutes = require('./routes/adminRoutes');
const logger = require('./utils/logger');

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

// Trust first proxy (important for correct req.ip behind load balancers / Docker)
app.set('trust proxy', 1);

// ─── Global Middleware ────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestId); // Attach X-Request-ID to every request

// Minimal HTTP access log
app.use((req, _res, next) => {
    logger.http(`${req.method} ${req.originalUrl}`, {
        requestId: req.requestId,
        ip: req.ip,
    });
    next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);

// Health check also reachable at root (convenient for Docker / k8s probes)
app.get('/', (_req, res) =>
    res.json({ service: 'API Rate Limiter', version: '1.0.0', status: 'running' })
);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error' });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;

async function start() {
    // Connect to Redis (failure is non-fatal — service continues with in-memory)
    await connectRedis();

    const server = app.listen(PORT, () => {
        logger.serverStarted(PORT);
    });

    // ─── Graceful Shutdown ─────────────────────────────────────────────────────
    const shutdown = async (signal) => {
        logger.info(`Received ${signal} — shutting down gracefully...`);
        server.close(async () => {
            await disconnectRedis();
            logger.info('Server closed');
            process.exit(0);
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return server;
}

// Only start when run directly (not when required by tests)
if (require.main === module) {
    start().catch((err) => {
        logger.error('Failed to start server', { error: err.message });
        process.exit(1);
    });
}

module.exports = { app, start };
