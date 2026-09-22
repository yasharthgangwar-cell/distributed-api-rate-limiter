'use strict';

/**
 * apiRoutes.js
 * Public API routes — all protected by the rate limiter.
 */

const { Router } = require('express');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { testEndpoint } = require('../controllers/apiController');

const router = Router();

// Apply rate limiter to all /api routes
// Tier is resolved per-request from the X-User-Tier header (defaults to FREE)
router.use(createRateLimiter());

/**
 * GET /api/test
 * A simple protected endpoint to verify rate limiting is working.
 */
router.get('/test', testEndpoint);

module.exports = router;
