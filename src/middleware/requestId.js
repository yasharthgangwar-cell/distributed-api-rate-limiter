'use strict';

/**
 * requestId.js
 * Middleware that attaches a unique X-Request-ID to every request.
 *
 * In distributed systems, request IDs allow you to trace a single
 * request across multiple services and log lines.
 *
 * Flow:
 *   1. Accept X-Request-ID from the client if provided (useful for chaining)
 *   2. Otherwise, generate a new UUID v4
 *   3. Attach to req.requestId and set the response header
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Express middleware — attaches req.requestId and `X-Request-ID` header.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {Function}                   next
 */
function requestId(req, res, next) {
    const existingId = req.headers['x-request-id'];
    const id = (existingId && existingId.trim()) ? existingId.trim() : uuidv4();

    req.requestId = id;
    res.setHeader('X-Request-ID', id);

    next();
}

module.exports = requestId;
