# Distributed API Rate Limiter

A distributed API rate limiting service built with **Node.js, Express, Redis, Docker, and Lua scripting**.

This project explores how rate limiting can be implemented in a distributed environment while handling concurrent requests, shared state, and service failures.

## 🚀 Features

- Token Bucket rate limiting
- Sliding Window rate limiting
- Redis-based distributed state management
- Atomic Redis operations using Lua scripts
- Express middleware integration
- Rate limit response headers
- Request ID middleware
- Circuit Breaker for fault tolerance
- Docker and Docker Compose support
- Automated testing with Jest and Supertest
- Load testing with k6
- Redis fallback handling

## 🏗️ Architecture

```text
Client
   |
   v
Express API
   |
   v
Rate Limiter Middleware
   |
   v
Redis
   |
   v
API Controller
```

## ⚙️ Technologies

- **Node.js**
- **Express.js**
- **Redis**
- **Lua**
- **Docker**
- **Jest**
- **Supertest**
- **k6**

## 🧠 Rate Limiting Algorithms

### Token Bucket

The Token Bucket algorithm maintains a bucket of tokens for each client.

A request consumes a token. If no tokens are available, the request is rate limited.

### Sliding Window

The Sliding Window algorithm tracks requests over a rolling time interval.

Redis sorted sets are used to maintain request timestamps and remove expired requests.

## 🔐 Distributed Rate Limiting

Redis provides shared state between API instances.

This allows the rate limiter to work consistently even when multiple instances of the API are running.

Lua scripts are used for atomic Redis operations to reduce race conditions when multiple requests access the same rate limit data concurrently.

## 🛡️ Circuit Breaker

The service includes a Circuit Breaker with three states:

- **CLOSED** — requests operate normally
- **OPEN** — requests are stopped temporarily after repeated failures
- **HALF_OPEN** — limited requests are allowed to check whether the dependency has recovered

## 🐳 Running Locally

### 1. Clone the repository

```bash
git clone https://github.com/yasharthgangwar-cell/distributed-api-rate-limiter.git
cd distributed-api-rate-limiter
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file using `.env.example` as a reference.

Do not commit `.env` or other files containing secrets.

### 4. Start the application

```bash
docker compose up
```

### 5. Run tests

```bash
npm test
```

## 📊 Load Testing

The project includes k6-based load testing to evaluate the behaviour of the rate limiter under concurrent requests.

Metrics such as request throughput, latency, and rate-limited requests can be observed during testing.

## 📁 Project Structure

```text
src/
├── algorithms/
├── config/
├── controllers/
├── middleware/
└── routes/

tests/
```

## 🎯 Learning Objectives

This project is being used to study and understand:

- API rate limiting
- Redis
- Distributed systems
- Concurrency and race conditions
- Atomic operations
- Lua scripting
- Fault tolerance
- Circuit breakers
- Docker
- Automated testing
- Load testing

