---
sidebar_position: 3
---

# Authentication

## Overview

Orplex uses NextAuth.js for authentication with JWT sessions.

## Providers

| Provider | Environment Variable |
|----------|---------------------|
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub OAuth | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

## JWT Authentication

API routes use JWT tokens for authentication.

### Get Token

```bash
POST /api/auth/signin
```

### Use Token

```bash
Authorization: Bearer <jwt-token>
```

## Session Management

Sessions are stored in the database and managed by NextAuth.

```javascript
import { getServerSession } from "next-auth";

const session = await getServerSession();
if (!session?.user) {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
```
