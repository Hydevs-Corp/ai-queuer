# AI Queuer

A TypeScript project that implements a request queuing system for multiple AI providers (Mistral, Gemini, ...)
using Hono.js.

## Features

-   Request queuing with configurable per-model, per-queue rate limits
-   Avoids head-of-line blocking: if a model hits its limits, only that model waits; others proceed
-   Two main endpoints:
    -   `/ask` - Chat with Mistral AI using conversation history
    -   `/analyze-image` - Analyze images using Mistral's vision capabilities
    -   `/usage` - Current per-queue, per-model usage for day and month
-   Built with TypeScript, Hono.js, and provider SDKs (Mistral, Gemini)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the environment file and choose an env strategy:

```bash
cp .env.example .env
```

3. Edit `.env` and configure the strategy.

### Environment strategies

Select via `ENV_STRATEGY` (default: `env`).

-   env: Read the Mistral key directly from `.env`.

    -   MISTRAL_API_KEY=your_actual_api_key_here

-   pocketbase: Authenticate to pocketbase and read a key from a collection.

    -   PB_URL=https://your-pocketbase.example.com
    -   PB_USERNAME=admin@example.com
    -   PB_PASSWORD=your_password
    -   PB_USER_COLLECTION=users (default)
    -   PB_KEYS_COLLECTIONS=keys (default)
    -   ENV_KEY_NAME=mistral (optional preferred key name)

-   fetch: Fetch a list of keys from an HTTP endpoint returning `[ { name, key } ]`.
    -   ENV_FETCH_URL=https://example.com/keys.json
    -   ENV_FETCH_TOKEN=optional_bearer_token
    -   ENV_KEY_NAME=mistral (optional preferred key name)

### Gemini provider (optional)

To enable Gemini, set:

-   `GEMINI_API_KEY=your_gemini_key`

If not set, Gemini endpoints/targets will be ignored by the router.

### Multiple keys behavior

When using `pocketbase` or `fetch` strategies, if multiple entries exist with the name `mistral_api_key`, the server will:

-   Create one queue and one Mistral client per key
-   Dispatch each incoming request to the queue with the fewest pending items (least-loaded balancing)
-   Expose per-queue status in `/` and `/queue/status` responses

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## API Documentation

All endpoints return JSON responses. The API implements CORS and request logging middleware.

### Base URL

```
http://localhost:3000
```

---

### GET `/`

**Description:** Health check endpoint that returns API status and current queue information.

**Response:**

```json
{
    "message": "AI Queuer API is running",
    "queues": [
        { "index": 0, "queueLength": 0, "isProcessing": false },
        { "index": 1, "queueLength": 0, "isProcessing": false }
    ],
    "totalQueueLength": 0
}
```

**Response Fields:**

-   `message` (string): API status message
-   `queueLength` (number): Current number of requests in queue
-   `isProcessing` (boolean): Whether a request is currently being processed

---

### POST `/ask`

**Description:** Send a chat request with conversation history to Mistral AI. Requests are queued and processed sequentially.

**Request Body:**

```json
{
    "history": [
        {
            "role": "system",
            "content": "You are a helpful assistant."
        },
        {
            "role": "user",
            "content": "Hello, how are you?"
        },
        {
            "role": "assistant",
            "content": "Hello! I'm doing well, thank you for asking."
        },
        {
            "role": "user",
            "content": "What's the weather like?"
        }
    ],
    "model": "mistral-large-latest"
}
```

**Request Fields:**

-   `history` (array, required): Array of conversation messages
    -   `role` (string, required): Message role - must be "user", "assistant", or "system"
    -   `content` (string, required): Message content
-   `model` (string, required): Mistral model to use (e.g., "mistral-large-latest", "mistral-medium", "mistral-small")

**Success Response (200):**

```json
{
    "response": "I don't have access to real-time weather data...",
    "queueLength": 0
}
```

**Success Response Fields:**

-   `response` (string): AI-generated response
-   `queueLength` (number): Current queue length after processing

**Error Responses:**

_400 Bad Request:_

```json
{
    "error": "history is required and must be an array"
}
```

```json
{
    "error": "model is required and must be a string"
}
```

```json
{
    "error": "Invalid message role. Must be user, assistant, or system"
}
```

```json
{
    "error": "Each message must have content as a string"
}
```

_500 Internal Server Error:_

```json
{
    "error": "Internal server error",
    "details": "Failed to get response from Mistral: ..."
}
```

---

### POST `/analyze-image`

**Description:** Analyze an image using Mistral's vision capabilities. Accepts base64-encoded images.

**Request Body:**

```json
{
  "image": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "model": "magistral-
small-2509"
}
```

**Request Fields:**

-   `image` (string, required): Base64-encoded image data (without data URL prefix)
-   `model` (string, optional): Vision model to use. Defaults to "magistral-
    small-2509"

**Success Response (200):**

```json
{
    "analysis": "I can see a small 1x1 pixel transparent image. This appears to be a minimal test image...",
    "queueLength": 0
}
```

**Success Response Fields:**

-   `analysis` (string): AI-generated image analysis
-   `queueLength` (number): Current queue length after processing

**Error Responses:**

_400 Bad Request:_

```json
{
    "error": "image is required and must be a base64 string"
}
```

```json
{
    "error": "Invalid base64 image format"
}
```

_500 Internal Server Error:_

```json
{
    "error": "Internal server error",
    "details": "Failed to analyze image with Mistral: ..."
}
```

---

### GET `/queue/status`

**Description:** Get current queue status without making any requests.

**Response:**

```json
{
    "queues": [
        { "index": 0, "queueLength": 1, "isProcessing": true },
        { "index": 1, "queueLength": 1, "isProcessing": true }
    ],
    "totalQueueLength": 2
}
```

**Response Fields:**

-   `queueLength` (number): Number of requests currently in queue
-   `isProcessing` (boolean): Whether a request is currently being processed

---

### GET `/usage`

Description: Returns current usage counters per queue and per model, including rolling windows and monthly counters.

Response:

```json
{
    "now": 1734200000000,
    "queues": [
        {
            "index": 0,
            "label": "default",
            "usage": {
                "label": "default",
                "models": {
                    "mistral-large-latest": {
                        "second": { "requests": 0 },
                        "minute": {
                            "requests": 1,
                            "tokens": {
                                "count": 1200,
                                "windowStart": 1734199999000
                            }
                        },
                        "day": { "requests": 12, "windowMs": 86400000 },
                        "month": {
                            "requests": {
                                "count": 123,
                                "resetAt": 1735689600000,
                                "resetInMs": 1489600000
                            },
                            "tokens": {
                                "count": 456789,
                                "resetAt": 1735689600000,
                                "resetInMs": 1489600000
                            }
                        }
                    }
                }
            }
        }
    ],
    "totals": {
        "mistral-large-latest": {
            "second": { "requests": 0 },
            "minute": { "requests": 1, "tokens": { "count": 1200 } },
            "day": { "requests": 12 },
            "month": {
                "requests": { "count": 123 },
                "tokens": { "count": 456789 }
            }
        }
    }
}
```

Notes:

-   Monthly windows reset at the start of the next UTC month (resetAt).
-   Minute token window start is reported; it rolls every 60s per queue/model.

### GET `/models`

Description: Returns a deduplicated list of the available models per provider.

Example response:

```json
{
    "mistral": ["mistral-small-latest", "mistral-large-latest"],
    "gemini": ["gemini-2.5-flash"]
}
```

Notes:

-   The endpoint aggregates model names from the key configurations returned by the configured `ENV_STRATEGY` (env/pocketbase/fetch) and removes duplicates across keys.
-   The implementation lives in `src/index.ts` (route: `/models`).

---

### Rate Limiting & Queue Behavior

-   **Per-model, per-queue enforcement:** Limits are applied independently per model per API key/queue.
-   **Out-of-order within queue to prevent blocking:** The scheduler picks the first runnable item; items for models currently at their limit are skipped until they're eligible.
-   **Optional delay:** If no limits are configured for a key, you can set `QUEUER_DELAY` (ms) for a simple fixed delay between requests.
-   **Concurrent Safety:** Multiple requests can be submitted simultaneously but will be queued
-   **Error Handling:** Failed requests don't affect the queue processing of subsequent requests

#### Configuring limits

When using pocketbase or Fetch strategies, you can attach a `limit` object on each key record:

-   Compact default limits (applies to all models unless overridden):

```json
{
    "name": "mistral",
    "key": "...",
    "limit": { "RPS": 1 }
}
```

-   Per-model limits with defaults:

```json
{
    "name": "mistral",
    "key": "...",
    "limit": {
        "default": { "RPS": 1 },
        "codestral-2405": { "TPm": 500000, "TPM": 1000000000 },
        "mistral-embed": { "TPm": 20000000, "TPM": 200000000000 }
    }
}
```

Accepted limit types: RPS, RPm, RPD, TPM, TPm, RPM.

Notes:

-   Token limits consider the estimated tokens of the queued item to avoid overshooting the window.

---

## Usage storage strategy

Control where usage counters are stored with the `USAGE_STRATEGY` environment variable:

-   `RAM` (default): usage is kept in-memory and resets on process restart.
-   `pocketbase`: usage is persisted to a pocketbase collection so counters survive restarts.

When using pocketbase, set:

-   `PB_URL` (e.g., https://your-pocketbase.example)
-   `PB_USERNAME`
-   `PB_PASSWORD`
-   `PB_USER_COLLECTION` (optional, defaults to `users`)
-   `PB_USAGE_COLLECTION` (optional, defaults to `usage`)

Expected schema for the usage collection:

-   `key` (text, unique recommended): queue label and model, formatted as `label::model` when a label is present, otherwise just the model name
-   `data` (json): a JSON object containing the usage bucket maintained by the queue

Notes:

-   Persistence runs best-effort after updates and periodically; transient errors are logged.
-   Monthly windows reset at the start of the next UTC month.

### Example Usage

**cURL Examples:**

```bash
# Health check
curl http://localhost:3000/

# Chat request
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{
    "history": [
      {"role": "user", "content": "Hello!"}
    ],
    "model": "mistral-large-latest"
  }'

# Image analysis (with a test image)
curl -X POST http://localhost:3000/analyze-image \
  -H "Content-Type: application/json" \
  -d '{
    "image": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
  }'

# Queue status
curl http://localhost:3000/queue/status
```

**JavaScript/TypeScript Example:**

```typescript
// Chat with Mistral
const chatResponse = await fetch("http://localhost:3000/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        history: [
            {
                role: "user",
                content: "Explain quantum computing in simple terms",
            },
        ],
        model: "mistral-large-latest",
    }),
});

const chatData = await chatResponse.json();
console.log(chatData.response);

// Analyze image
const imageResponse = await fetch("http://localhost:3000/analyze-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        image: base64ImageString, // your base64 image data
        model: "magistral-small-2509",
    }),
});

const imageData = await imageResponse.json();
console.log(imageData.analysis);
```

## Queue System

The application implements a sequential request queue where:

-   All requests are processed one at a time
-   There's a 1000ms delay between each request execution
-   Requests are processed in FIFO (First In, First Out) order
-   Queue status can be monitored through the API

## Available Scripts

-   `npm run dev` - Start development server with hot reload
-   `npm run build` - Build the project
-   `npm start` - Start production server
-   `npm run type-check` - Run TypeScript type checking

## Multi-provider support

This service now supports multiple LLM providers. Initially supported: Mistral and Gemini.

-   Mistral keys are configured via the existing ENV_STRATEGY (env/pocketbase/fetch).
-   Gemini can be enabled by setting the environment variable `GEMINI_API_KEY`.

Request body formats for `/ask` and `/analyze-image`:

-   Legacy: `{ "model": "mistral-small-latest" }` (defaults to provider `mistral`).
-   Single target: `{ "model": { "provider": "gemini", "model": "gemini-2.5-flash" } }`.
-   Multiple targets: `{ "model": [{ "provider": "mistral", "model": "mistral-small-latest" }, { "provider": "gemini", "model": "gemini-2.5-flash" }] }`.

The server chooses the queue with the lowest estimated wait among the provided targets, considering rate limits and current load.

### Gemini multi-key and limits

Gemini keys can be loaded via the same strategies as Mistral:

-   env: `GEMINI_API_KEY`
-   pocketbase/fetch: records with type/name `gemini`, and fields: `key`, optional `label`, optional `limit` (same shape as Mistral). Examples:

Compact default limits for all models:

```json
{
    "type": "gemini",
    "key": "...",
    "limit": { "RPS": 1, "TPm": 500000 }
}
```

Per-model limits:

```json
{
    "name": "gemini",
    "key": "...",
    "limit": {
        "default": { "RPS": 2 },
        "gemini-1.5-flash": { "TPm": 200000, "TPM": 100000000 },
        "gemini-2.5-flash": { "RPS": 1 }
    }
}
```

### Reloading keys

If using `pocketbase` or `fetch`, you can reload keys without restarting:

-   Reload Mistral: `POST /admin/reload-keys?provider=mistral`
-   Reload Gemini: `POST /admin/reload-keys?provider=gemini`
-   Reload both: `POST /admin/reload-keys?provider=all`

## Troubleshooting

Common issues and quick fixes:

-   Missing environment variables

    -   Symptom: Server crashes on startup with a message about a missing environment variable (e.g., `MISTRAL_API_KEY` or `PB_URL`).
    -   Fix: Ensure you copied `.env.example` to `.env` and filled required values for your chosen `ENV_STRATEGY`. For `env` strategy you need `MISTRAL_API_KEY` (and optionally `GEMINI_API_KEY`). For `pocketbase` strategy set `PB_URL`, `PB_USERNAME`, and `PB_PASSWORD`.

-   pocketbase authentication failures

    -   Symptom: Errors like `pocketbase auth failed (...)` or `pocketbase keys fetch failed (...)` in logs.
    -   Fix: Verify `PB_URL` is reachable from the server, and that `PB_USERNAME`/`PB_PASSWORD` are correct. Check the pocketbase logs or try the auth endpoint manually (POST to `/api/collections/<user_collection>/auth-with-password`). Also ensure the configured collections (`PB_USER_COLLECTION`, `PB_KEYS_COLLECTIONS`, `PB_USAGE_COLLECTION`) match your pocketbase schema.

-   ENV fetch strategy errors

    -   Symptom: `ENV fetch failed (...)` or `ENV fetch response is not an array` errors.
    -   Fix: Ensure `ENV_FETCH_URL` returns a JSON array in the expected format (e.g., `[ { "name": "mistral", "key": "..." } ]`) and, if protected, that `ENV_FETCH_TOKEN` is set correctly.

-   Missing Gemini behavior

    -   Symptom: Gemini targets are ignored.
    -   Fix: Set `GEMINI_API_KEY` for `env` strategy or configure Gemini entries in your pocketbase / fetch source (type/name `gemini`) when using those strategies.

-   Debugging tips

    -   Start the server in dev mode to get more helpful stack traces: `npm run dev`.
    -   Use `npm run type-check` to catch TypeScript errors early.
    -   Check process logs for printed errors — the server logs helpful messages for key-loading and request processing.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Copyright (c) 2025 Hydevs

## Support

For issues and questions:

-   Check the troubleshooting section
-   Review configuration options
-   Examine output files for error messages
-   Ensure AI service is properly configured
