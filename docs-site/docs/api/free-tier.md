---
sidebar_position: 5
---

# Free Tier

Orplex offers a free tier that gives users daily request quotas without needing their own API keys.

## How It Works

1. User signs in via Google or GitHub OAuth
2. User calls `/api/free/signup` to create a free-tier quota
3. Each chat request is counted against the daily limit
4. Quota resets automatically at midnight UTC
5. Users with their own API keys bypass the daily quota

## Limits

| Limit | Free Tier | Pro Tier |
|-------|-----------|----------|
| Daily requests | 1,000 | Unlimited |
| Max tokens per prompt | 4,096 | 16,384 |
| Allowed models | gpt-oss-120b | All |
| Max file uploads | 5 | 20 |
| Max messages per conversation | 50 | 200 |

## POST /api/free/signup

Create or retrieve a free-tier quota for the authenticated user.

### Request

No body required — uses the authenticated session.

### Response (new user)

```json
{
  "user": { "id": "user_xyz", "name": "Alice", "email": "alice@example.com" },
  "tier": "free",
  "isNew": true,
  "quota": {
    "requestsToday": 0,
    "dailyLimit": 1000,
    "lastResetAt": "2025-01-01T00:00:00.000Z"
  },
  "limits": {
    "dailyPrompts": 50,
    "allowedModels": ["gpt-oss-120b"],
    "maxTokensPerPrompt": 4096,
    "maxFileUploads": 5,
    "maxMessages": 50
  }
}
```

### Response (existing user)

```json
{
  "user": { "id": "user_xyz", "name": "Alice", "email": "alice@example.com" },
  "tier": "free",
  "isNew": false,
  "quota": {
    "requestsToday": 12,
    "dailyLimit": 1000,
    "lastResetAt": "2025-01-01T00:00:00.000Z"
  },
  "limits": { "..." }
}
```

## GET /api/free/usage

Get current usage and remaining quota for the authenticated user.

### Response

```json
{
  "tier": "free",
  "usage": {
    "requestsToday": 12,
    "date": "2025-01-15"
  },
  "quota": {
    "limit": 50,
    "remaining": 38,
    "allowed": true
  },
  "limits": {
    "maxTokensPerPrompt": 4096,
    "allowedModels": ["gpt-oss-120b"],
    "maxFileUploads": 5,
    "maxMessages": 50
  }
}
```

## GET /api/user/quota

Simplified quota endpoint used by the UI's `QuotaIndicator` component.

### Response

```json
{
  "remaining": 38,
  "limit": 50
}
```

## Bypassing Quota

Users can bypass the free-tier daily limit by adding their own API keys in **Settings → API Keys**. When a user has an active personal key, the daily quota is not enforced.

## Upgrading

The workspace and multi-user features are available to all tiers. For higher limits, bring your own API keys or contact us for a Pro tier.

## Example (JavaScript)

```javascript
// Sign up for free tier
const signup = await fetch("/api/free/signup", { method: "POST" });
const { tier, quota, limits } = await signup.json();

console.log(`${tier} tier: ${quota.requestsToday}/${quota.dailyLimit} requests today`);

// Check usage before sending a message
const usage = await fetch("/api/free/usage").then(r => r.json());
if (!usage.quota.allowed) {
  console.log("Daily limit reached! Add your own API key for unlimited access.");
}
```
