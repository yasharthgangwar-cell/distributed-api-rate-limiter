'use strict';

/**
 * timeUtils.js
 * Lightweight timestamp helpers used by rate limiting algorithms.
 */

/**
 * Returns the current Unix timestamp in seconds (integer).
 * @returns {number}
 */
function nowInSeconds() {
    return Math.floor(Date.now() / 1000);
}

/**
 * Returns the current Unix timestamp in milliseconds.
 * @returns {number}
 */
function nowInMs() {
    return Date.now();
}

/**
 * Returns the number of seconds elapsed since the given timestamp.
 * @param {number} sinceSeconds — Unix timestamp in seconds
 * @returns {number}
 */
function elapsedSeconds(sinceSeconds) {
    return nowInSeconds() - sinceSeconds;
}

module.exports = { nowInSeconds, nowInMs, elapsedSeconds };
