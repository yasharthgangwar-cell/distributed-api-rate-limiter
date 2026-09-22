'use strict';

/**
 * apiController.js
 * Handler functions for the public-facing API routes.
 */

/**
 * GET /api/test
 * Simple protected endpoint — just proves the request passed rate limiting.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function testEndpoint(req, res) {
    return res.status(200).json({
        success: true,
        message: 'Request successful!',
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        rateLimit: {
            limit: res.getHeader('X-RateLimit-Limit'),
            remaining: res.getHeader('X-RateLimit-Remaining'),
            reset: res.getHeader('X-RateLimit-Reset'),
        },
    });
}

module.exports = { testEndpoint };
