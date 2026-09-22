# API Rate Limiter Service

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7.x-DC382D?logo=redis&logoColor=white)
![Jest](https://img.shields.io/badge/Tests-32%20passing-brightgreen?logo=jest)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)

A production-quality, distributed **API Rate Limiter** built with **Node.js**, **Express.js**, and **Redis**. Implements Token Bucket and Sliding Window Counter algorithms with a Circuit Breaker protection layer.

---

## Overview

> Built a distributed API rate limiting system with Node.js, Redis, Token Bucket and Sliding Window algorithms, enhanced with a Circuit Breaker pattern to block abusive clients and protect backend services.

### What It Solves
- **Abuse prevention** — blocks clients that hammer the API
- **Fair usage** — enforces per-user/IP/API-key limits
- **Burst support** — Token Bucket allows short bursts without penalizing normal users
- **Distributed** — rate state is shared across multiple server instances via Redis
- **Resilient** — automatically falls back to in-memory when Redis is unavailable

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Rate Limiter                         │
│                                                                 │
│  ┌──────────────┐     ┌─────────────────┐    ┌───────────────┐ │
│  │  requestId   │────▶│  rateLimiter    │───▶│  Algorithm    │ │
│  │  middleware  │     │  middleware     │    │  (TB or SW)   │ │
│  └──────────────┘     └─────────────────┘    └───────┬───────┘ │
│                              │                        │         │
│                    ┌─────────▼────────┐   ┌──────────▼───────┐ │
│                    │  Circuit Breaker │   │  Redis / Memory  │ │
│                    │  (CLOSED/OPEN/   │   │  token store     │ │
│                    │   HALF_OPEN)     │   └──────────────────┘ │
│                    └──────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Algorithms

### Token Bucket
The bucket starts full (`capacity` tokens). Each request consumes one token. Tokens refill at `refillRate` tokens/second. If the bucket is empty → 429.

**Properties:** allows burst traffic · smooth long-term rate · atomic via Redis Lua script

```
FREE  tier: capacity=100,  refillRate=0.0278/s  → 100  req/hour
PRO   tier: capacity=1000, refillRate=0.2778/s  → 1000 req/hour
```

### Sliding Window Counter
Tracks exact timestamps of requests within the past `windowSize` seconds. More accurate than Fixed Window — no burst at window boundaries.

**Properties:** precise per-second accuracy · no boundary burst · Redis Sorted Sets

### Circuit Breaker
Adds a protection layer on top of rate limiting:

| State | Behaviour |
|---|---|
| `CLOSED` | Normal operation — rate limiter runs |
| `OPEN` | Client is blocked — requests rejected immediately (no rate limit consumed) |
| `HALF_OPEN` | Block expired — 3 probe requests allowed to test recovery |

**Escalating block durations** (per repeat offender):
`Level 0` → 5 min · `Level 1` → 15 min · `Level 2` → 1 hr · `Level 3` → 24 hr

---

## Request Flow

```
Client Request
     │
     ▼
X-Request-ID Middleware
(UUID per request — distributed tracing)
     │
     ▼
Rate Limiter Middleware
     │
     ├─[1] Circuit Breaker pre-check
     │       ├─ OPEN → 429 "Circuit Open" (early return)
     │       └─ CLOSED / HALF_OPEN probe → continue
     │
     ├─[2] Algorithm
     │       ├─ Token Bucket  (default)
     │       └─ Sliding Window
     │
     ├─[3] Denied → recordFailure() → may open circuit → 429
     │
     └─[4] Allowed → recordSuccess() → heal circuit → next()
                │
                ▼
        Redis / In-Memory Store
                │
                ▼
      Response (200 or 429)
      + Rate-Limit Headers
```

---

## Features

| Feature | Detail |
|---|---|
| Token Bucket | Atomic Lua script in Redis for race-free distributed ops |
| Sliding Window | Redis Sorted Set pipeline |
| Circuit Breaker | Auto-blocking with escalating durations |
| Graceful degradation | Redis → in-memory Map fallback |
| Request tracing | `X-Request-ID` on every request/response |
| Rate limit headers | `X-RateLimit-Limit/Remaining/Reset`, `Retry-After`, `X-CB-State` |
| Tiers | FREE / PRO / ENTERPRISE via `X-User-Tier` header |
| Health check | `GET /admin/health` with Redis status |
| Docker | One-command Redis + API spin-up |

---

## Project Structure

```
api-rate-limiter/
├── src/
│   ├── algorithms/
│   │   ├── tokenBucket.js      # Token Bucket (memory + Redis Lua)
│   │   └── slidingWindow.js    # Sliding Window (memory + Redis ZADD)
│   ├── middleware/
│   │   ├── rateLimiter.js      # Rate limit + Circuit Breaker integration
│   │   └── requestId.js        # X-Request-ID per request
│   ├── controllers/
│   │   └── apiController.js
│   ├── routes/
│   │   ├── apiRoutes.js        # GET /api/test
│   │   └── adminRoutes.js      # /admin/* endpoints
│   ├── services/
│   │   ├── redisClient.js      # Redis singleton + graceful fallback
│   │   └── circuitBreaker.js   # CLOSED/OPEN/HALF_OPEN state machine
│   ├── utils/
│   │   ├── identifier.js       # API key > User ID > IP priority
│   │   ├── timeUtils.js        # Timestamp helpers
│   │   └── logger.js           # Winston structured logger
│   ├── config/
│   │   └── rateLimitConfig.js  # FREE / PRO / ENTERPRISE tier config
│   └── server.js               # Express app entry point
├── tests/
│   └── rateLimiter.test.js     # 32 Jest + Supertest tests
├── Dockerfile
├── docker-compose.yml
├── .env / .env.example
└── package.json
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `development` / `production` |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `REDIS_CONNECT_TIMEOUT` | `5000` | Connect timeout (ms) |
| `RATE_LIMIT_ALGORITHM` | `tokenBucket` | `tokenBucket` or `slidingWindow` |
| `TB_CAPACITY` | `100` | Token bucket capacity (FREE tier) |
| `TB_REFILL_RATE` | `0.0278` | Tokens/second refill rate (FREE tier) |
| `SW_WINDOW_SIZE` | `3600` | Sliding window size in seconds |
| `SW_REQUEST_LIMIT` | `100` | Max requests per window |

---

## API Reference

### Public

#### `GET /api/test`
Rate-limited endpoint.

**200 OK:**
```json
{
  "success": true,
  "message": "Request successful!",
  "requestId": "550e8400-...",
  "rateLimit": { "limit": 100, "remaining": 99, "reset": 1741329466 }
}
```

**429 Too Many Requests:**
```json
{ "error": "Too Many Requests", "retryAfter": 3542, "resetAt": 1741329466 }
```

**429 Circuit Open:**
```json
{ "error": "Circuit Open", "message": "User temporarily blocked...", "retryAfter": 298, "state": "OPEN" }
```

---

### Admin

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/health` | Service health + Redis status |
| `GET` | `/admin/status?identifier=...` | Rate limit state for identifier |
| `POST` | `/admin/reset` | Reset rate limit counters |
| `GET` | `/admin/circuit-status?identifier=...` | Circuit breaker state |
| `POST` | `/admin/circuit-reset` | Manually unblock an identifier |

**Health response:**
```json
{ "status": "ok", "redis": "connected", "uptime": 42 }
```

**Circuit status response:**
```json
{
  "identifier": "ip:127.0.0.1",
  "state": "OPEN",
  "failures": 5,
  "blockedUntil": 1741329766,
  "blockLevel": 0
}
```

---

## Running Locally

```bash
# Install
npm install

# Copy env
cp .env.example .env

# Start dev server (in-memory, no Redis needed)
npm run dev
```

### With Redis

```bash
# If you have Redis installed locally
redis-server

# Then start the API
npm run dev
```

---

## Docker Setup

```bash
# Start Redis + API together
docker-compose up

# Detached
docker-compose up -d

# Stop
docker-compose down
```

---

## Testing

### Jest + Supertest

```bash
npm test              # Run all 32 tests
npm run test:coverage # With coverage report
```

**Test Suites (32 tests total):**

| Suite | Tests |
|---|---|
| `GET /api/test` | 3 |
| Rate limit 429 enforcement | 3 |
| X-Request-ID middleware | 2 |
| Admin reset + status | 4 |
| Health check | 1 |
| Sliding Window (unit) | 2 |
| Token Bucket (unit) | 2 |
| Concurrency | 1 |
| Identifier priority chain | 2 |
| **[Phase 3] CB — CLOSED state** | 2 |
| **[Phase 3] CB — opens on threshold** | 3 |
| **[Phase 3] CB — HALF_OPEN** | 2 |
| **[Phase 3] CB — recordSuccess** | 1 |
| **[Phase 3] CB — admin endpoints** | 4 |

### Load Testing with k6

```javascript
// k6-load-test.js
import http from 'k6/http';
import { check } from 'k6';

export const options = { vus: 10, duration: '30s' };

export default function () {
  const res = http.get('http://localhost:3000/api/test');
  check(res, { 'is 200 or 429': (r) => r.status === 200 || r.status === 429 });
}
```

```bash
k6 run k6-load-test.js
```

### Manual cURL

```bash
# Happy path
curl -i http://localhost:3000/api/test

# As PRO tier
curl -i -H "X-User-Tier: PRO" -H "X-API-Key: my-key" http://localhost:3000/api/test

# Health check
curl http://localhost:3000/admin/health

# Circuit breaker status
curl "http://localhost:3000/admin/circuit-status?identifier=ip:::1"

# Manually unblock
curl -X POST http://localhost:3000/admin/circuit-reset \
     -H "Content-Type: application/json" \
     -d "{\"identifier\":\"ip:::1\"}"
```

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Lua script for Token Bucket Redis ops | Atomic read-refill-consume in one round-trip — no race conditions |
| Sorted Set for Sliding Window | `ZADD`/`ZREMRANGEBYSCORE`/`ZCARD` pipeline is atomic and O(log N) |
| Circuit Breaker as middleware layer | Sits before the rate limiter — OPEN state consumes zero rate limit budget |
| Fail-open on unexpected errors | Downtime is worse than occasionally unthrottled requests |
| `trust proxy: 1` | Correct `req.ip` behind load balancers, Docker, and Nginx |

---

## Performance Considerations

- **Redis Lua scripts** ensure atomic token operations — prevent race conditions under concurrent load
- **In-memory fallback** ensures service availability when Redis is unavailable — zero downtime
- **Circuit Breaker** prevents repeated abuse from reaching the rate limiter or backend — saves compute
- **`trust proxy: 1`** enabled for accurate IP detection behind load balancers

---

## Future Improvements

- Real-time analytics dashboard (request / block rates by identifier)
- Prometheus + Grafana monitoring integration
- Redis Cluster support for horizontal scaling
- API key management service
- Dynamic rule configuration API (change limits without restart)

---

## License

ISC
