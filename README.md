# Uptime Monitoring Engine & Backend API

A high-performance, real-time uptime monitoring backend built with the Bun JavaScript runtime, ElysiaJS, Drizzle ORM, Supabase PostgreSQL, Upstash Redis, and Resend email alerting.

The platform provides end-to-end user authentication with OTP email verification, synthetic HTTP probing with sub-millisecond network phase breakdown, cron heartbeat monitoring with Redis sorted-set deadline tracking, anti-flapping alerting mechanisms, multi-tenant user isolation, and automated data aggregation.

![Dashboard Screenshot](http://localhost:3000/_next/image?url=https%3A%2F%2Fres.cloudinary.com%2Fhdusdvo1%2Fimage%2Fupload%2Fv1789266707%2FPicsart_26-09-13_08-30-13-624.png&w=3840&q=75)

Direct Dashboard Preview: https://res.cloudinary.com/hdusdvo1/image/upload/v1789266707/Picsart_26-09-13_08-30-13-624.png

---

## End-to-End System Architecture

```
                                  USER REGISTRATION & AUTHENTICATION FLOW
                                  
  +-------------------+       +-----------------------+       +------------------------+
  |                   |       |                       |       |                        |
  |  Client / App     +------>|  POST /auth/register  +------>|   Argon2id Password    |
  |                   |       |                       |       |   Hash (Bun.password)  |
  +--------+----------+       +-----------+-----------+       +-----------+------------+
           |                              |                               |
           |                              v                               v
           |                  +-----------------------+       +------------------------+
           |                  | Save User to Supabase |       |  Generate 6-Digit OTP  |
           |                  |  (is_verified = false)|       | (crypto.getRandomValues)|
           |                  +-----------------------+       +-----------+------------+
           |                                                              |
           |                              +-------------------------------+
           |                              |
           |                              v
           |                  +-----------------------+       +------------------------+
           |                  | Store OTP in Redis    |       | Dispatch Email via     |
           |                  | (10m TTL, 60s Lock)   +------>| Resend API (HTML Code) |
           |                  +-----------------------+       +-----------+------------+
           |                                                              |
           v                                                              v
  +-------------------+       +-----------------------+       +------------------------+
  |                   |       |                       |       | Activate is_verified   |
  | Submit 6-Digit OTP+------>| POST /auth/verify-otp +------>| in Supabase PostgreSQL |
  |                   |       |                       |       +-----------+------------+
  +-------------------+       +-----------------------+                   |
                                                                          v
                                                              +------------------------+
                                                              | Issue JWT Access Token |
                                                              | (jose 30-Day Expiration)|
                                                              +------------------------+
```

```
                                MONITORING, SWEEPING & ALERTING LIFECYCLE

  +------------------------------------------------------------------------------------+
  |                               SYNTHETIC PROBE ENGINE                               |
  |                                                                                    |
  |  +-------------------+     +--------------------+     +---------------------+      |
  |  | DNS Lookup        |---->| Raw TCP Handshake  |---->| TLS Handshake &     |      |
  |  | (dns.lookup)      |     | (net.Connection)   |     | Cert Verification   |      |
  |  +-------------------+     +--------------------+     +----------+----------+      |
  |                                                                      |             |
  |  +-------------------+     +--------------------+                    v             |
  |  | Record Check Log  |<----| Calculate TTFB &   |<-------------------+             |
  |  | in PostgreSQL     |     | Total Latency      |                                  |
  |  +---------+---------+     +--------------------+                                  |
  +------------|-----------------------------------------------------------------------+
               |
               v
  +------------------------------------------------------------------------------------+
  |                           ANTI-FLAPPING ALERT DISPATCHER                           |
  |                                                                                    |
  |  Check State Change Threshold in Redis (Max 3 Flaps per 10 Minutes)                |
  |  --> Pass: Dispatch Resend Email Alert + Discord Webhook Notification              |
  |  --> Fail: Suppress Notification to Prevent Inbox Flooding                         |
  +------------------------------------------------------------------------------------+
```

---

## Detailed Architectural Components

### 1. Authentication & OTP Email Verification Pipeline

The authentication subsystem guarantees that only users with verified email addresses can obtain authorization tokens or access private dashboard resources.

#### Registration Stage (`POST /api/v1/auth/register`)
- Email Normalization: The incoming email address is converted to lower-case and trimmed.
- Password Hashing: Uses hardware-accelerated Argon2id hashing via `Bun.password.hash()`.
- Unverified Database Entry: Inserts a new user record into Supabase PostgreSQL with `is_verified = false`. If an unverified user registers again, their record is updated and a new OTP is issued.
- Access Control: No JWT token is issued during registration.

#### OTP Generation & Storage (`src/services/otp.service.ts`)
- Cryptographic Generation: A 6-digit numeric string is generated using `crypto.getRandomValues()`.
- Redis Key Caching:
  - `otp:email:<email>`: Stores the 6-digit code in Upstash Redis with a 10-minute (600 seconds) expiration.
  - `otp_cooldown:<email>`: Stores a 60-second rate-limiting key to prevent SMS/Email spamming.

#### Email Dispatch Engine (Resend Integration)
- The backend uses the Resend API SDK (`resend`) to deliver HTML email templates.
- Rich HTML Layout: Includes a clean dark-themed card containing the 6-digit code in monospace typography, request timestamp, recipient details, and expiration warnings.
- Resilience & Fallback: If sending to an unverified recipient fails due to Resend testing mode constraints, the system automatically logs a diagnostic message and sends a copy to the account owner email address (`rimu_mutasim@yahoo.com`).

#### Verification Stage (`POST /api/v1/auth/verify-otp`)
- Accepts `{ email, otp }`.
- Fetches the stored code from Upstash Redis.
- If valid:
  - Deletes the OTP key from Redis.
  - Updates `is_verified = true` in Supabase PostgreSQL.
  - Signs a 30-day JWT access token using `jose` with claims (`sub`, `email`, `role`).
  - Returns `{ status: "success", access_token, user }`.

#### Strict Login Guard (`POST /api/v1/auth/login`)
- Validates user credentials using `Bun.password.verify()`.
- Unverified User Check: If `is_verified === false`, login is blocked with HTTP 403 Forbidden. The backend automatically generates and emails a fresh 6-digit OTP code to the user.

---

### 2. Low-Level Network Socket Probing Engine

High-level HTTP libraries hide intermediate socket phases. To achieve precision timing, the probe engine directly orchestrates raw Node sockets:

- DNS Phase (`dns.lookup`): Resolves target hostnames asynchronously to retrieve IP addresses before establishing connections, recording exact DNS resolution time (`dns_ms`).
- TCP Handshake (`net.createConnection`): Opens a raw TCP socket directly to the IP address on target port 80 or 443, measuring three-way handshake latency (`tcp_ms`).
- TLS Negotiation (`tls.connect`): For HTTPS endpoints, performs TLS handshake over the established TCP socket, evaluating protocol handshake duration (`tls_ms`) and parsing SSL certificate expiration dates (`sslDaysRemaining`).
- TTFB & Total Latency: Measures Time to First Byte (`ttfb_ms`) upon receiving the first response header byte and total roundtrip duration (`total_ms`).
- Redirect Follower: Tracks up to 3 HTTP redirects automatically while maintaining precise timing boundaries.

---

### 3. Cron Heartbeat & Redis ZSET Sweeper Engine

For background jobs, cron tasks, and backup scripts that must report health periodically:

- Dynamic Slugs: Each heartbeat monitor generates a unique slug (e.g. `/api/v1/ping/nightly-backup`).
- Redis ZSET Deadlines: When a heartbeat ping is received, the system calculates `nextExpectedAt = currentTime + periodSeconds + graceSeconds` and inserts the timestamp into an Upstash Redis sorted set (`crons:deadlines`).
- Overdue Sweeper (`heartbeat.worker.ts`): Periodically queries the Redis ZSET for deadlines smaller than the current timestamp. Overdue items transition to `DOWN` and trigger alerts immediately.

---

### 4. Anti-Flapping Alert Filter & Notifications

- Flap Detection: State transitions are tracked in Redis using `flapping:<resourceId>` keys with 10-minute expirations.
- Suppression Threshold: If a target changes state more than three times within ten minutes, notifications are suppressed to prevent inbox flooding.
- Resend Email Alerts: Renders HTML status updates detailing failure reasons, timestamps, target URLs, and resolution badges.
- Discord Webhooks: Posts embed notifications to designated Discord channels.

---

## Technology Stack

- Runtime: Bun v1.1+
- Framework: ElysiaJS
- Database: Supabase PostgreSQL
- ORM: Drizzle ORM
- Key-Value Cache: Upstash Redis (REST)
- Password Hashing: Argon2id via `Bun.password`
- JWT & Security: `jose` with Redis token revocation blacklists
- Email Dispatch: Resend API

---

## Environment Configuration

Create a `.env` file in the project root:

```env
PORT=3001
PROBE_CONCURRENCY=25

# Supabase PostgreSQL Connections
DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
DIRECT_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"

# Upstash Redis REST Credentials
UPSTASH_REDIS_REST_URL="https://your-upstash-instance.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-upstash-token"

# Security & JWT
SUPABASE_JWT_SECRET="your-jwt-secret-key"

# Resend Email Configuration
RESEND_API_KEY="re_your_resend_api_key"
ALERT_FROM_EMAIL="alerts@yourdomain.com"
ALERT_TO_EMAIL="team@yourdomain.com"
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/your-webhook"
```

### Resend Email Setup Guide

1. Create an account at https://resend.com and navigate to API Keys to generate an API key.
2. Add your key to `.env` as `RESEND_API_KEY`.
3. To send emails to arbitrary recipients, navigate to Domains in Resend, add your domain, and configure the required DNS records (SPF, DKIM).
4. Update `ALERT_FROM_EMAIL` to use your verified domain address (e.g. `alerts@yourdomain.com`).

---

## Getting Started

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-org/uptime-backend.git
cd uptime-backend
bun install
```

### Database Migration

Push the Drizzle ORM schema to your PostgreSQL database:

```bash
bun run db:push
```

### Development Server

Start the application with hot reloading:

```bash
bun run dev
```

Interactive Swagger API documentation is available at `http://localhost:3001/docs`.

---

## Complete API Reference

### Authentication Routes

#### Register Account
`POST /api/v1/auth/register`

Payload:
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123",
  "fullName": "Jane Doe"
}
```

Response:
```json
{
  "status": "pending_verification",
  "requires_verification": true,
  "message": "Registration successful! A 6-digit verification code has been sent to your email.",
  "email": "user@example.com"
}
```

#### Verify OTP Code
`POST /api/v1/auth/verify-otp`

Payload:
```json
{
  "email": "user@example.com",
  "otp": "630629"
}
```

Response:
```json
{
  "status": "success",
  "message": "Email verified successfully!",
  "token_type": "Bearer",
  "access_token": "eyJhbGciOiJIUzI1NiJ9...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "isVerified": true
  }
}
```

#### Resend OTP Code
`POST /api/v1/auth/resend-otp`

Payload:
```json
{
  "email": "user@example.com"
}
```

#### User Login
`POST /api/v1/auth/login`

Payload:
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123"
}
```

#### User Logout
`POST /api/v1/auth/logout`

#### Current Profile
`GET /api/v1/auth/me`
Requires Header: `Authorization: Bearer <access_token>`

---

### Monitor Routes

#### Create Monitor
`POST /api/v1/monitors`

Payload:
```json
{
  "name": "Production API",
  "url": "https://api.example.com/health",
  "method": "GET",
  "intervalSeconds": 60,
  "timeoutMs": 10000,
  "expectedStatus": 200
}
```

#### List User Monitors
`GET /api/v1/monitors`

#### Single Monitor Details
`GET /api/v1/monitors/:id`

#### Update Monitor
`PATCH /api/v1/monitors/:id`

#### Delete Monitor
`DELETE /api/v1/monitors/:id`

#### Execution Logs
`GET /api/v1/monitors/:id/checks?limit=50`

---

### Heartbeat Routes

#### Create Heartbeat Monitor
`POST /api/v1/heartbeats`

Payload:
```json
{
  "name": "Nightly Database Backup",
  "slug": "nightly-backup",
  "periodSeconds": 86400,
  "graceSeconds": 300
}
```

#### Record Ping
`GET /api/v1/ping/:slug` or `POST /api/v1/ping/:slug`

---

### Status Page Endpoint

`GET /api/v1/status-page/:userId`

Returns real-time status summaries, active monitors, uptime percentages, and response statistics for the specified user ID.

---

## Contributing Guidelines

Contributions are welcome from developers of all skill levels. To contribute:

1. Fork the repository and create your branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Write clean TypeScript code following existing patterns.
3. Ensure multi-tenant user scoping (`userId` filter) is preserved across all query logic.
4. Run TypeScript type checks:
   ```bash
   bun x tsc --noEmit
   ```
5. Open a Pull Request with a clear description of your changes.

---

## License

This project is released under the **MIT Lifetime Free License**. 

You are free to use, modify, distribute, host, and integrate this software in personal, commercial, or enterprise projects forever without subscription fees or licensing costs.