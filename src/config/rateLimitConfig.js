'use strict';

/**
 * Rate Limit Configuration
 * Defines tiers and algorithm defaults for the rate limiter.
 */

const config = {
  // ─── Algorithm Selection ────────────────────────────────────────────────
  // 'tokenBucket' | 'slidingWindow'
  defaultAlgorithm: process.env.RATE_LIMIT_ALGORITHM || 'tokenBucket',

  // ─── Token Bucket Tiers ─────────────────────────────────────────────────
  tokenBucket: {
    /**
     * FREE tier  → 100 req/hour
     * refillRate = 100 tokens / 3600 seconds ≈ 0.0278 tokens/sec
     */
    FREE: {
      capacity: parseInt(process.env.TB_CAPACITY, 10) || 100,
      refillRate: parseFloat(process.env.TB_REFILL_RATE) || 0.0278, // tokens per second
    },

    /**
     * PRO tier → 1000 req/hour
     * refillRate = 1000 / 3600 ≈ 0.2778 tokens/sec
     */
    PRO: {
      capacity: 1000,
      refillRate: 0.2778,
    },

    /**
     * ENTERPRISE tier → "unlimited" — extremely high cap
     * Effectively no limiting.
     */
    ENTERPRISE: {
      capacity: 1_000_000,
      refillRate: 1000,
    },
  },

  // ─── Sliding Window Tiers ────────────────────────────────────────────────
  slidingWindow: {
    /** FREE tier → 100 req/hour */
    FREE: {
      windowSize: parseInt(process.env.SW_WINDOW_SIZE, 10) || 3600, // seconds
      requestLimit: parseInt(process.env.SW_REQUEST_LIMIT, 10) || 100,
    },

    /** PRO tier → 1000 req/hour */
    PRO: {
      windowSize: 3600,
      requestLimit: 1000,
    },

    /** ENTERPRISE tier → 1 000 000 req/hour */
    ENTERPRISE: {
      windowSize: 3600,
      requestLimit: 1_000_000,
    },
  },

  // ─── Redis TTL ────────────────────────────────────────────────────────────
  // Key expiry (seconds) — covers the longest possible window
  redisTTL: 7200,

  // ─── Key Prefix ───────────────────────────────────────────────────────────
  redisKeyPrefix: 'rate_limit',
};

module.exports = config;
