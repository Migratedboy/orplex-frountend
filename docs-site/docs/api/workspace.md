---
sidebar_position: 4
---

# Workspace API

Manage multi-user workspaces. Members share context and collaborate on agent runs.

## POST /api/workspace/create

Create a new workspace. The caller becomes the owner.

### Request

```json
{
  "name": "My Team Workspace"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Workspace name (min 2 characters) |

### Response

```json
{
  "workspace": {
    "id": "ws_abc123",
    "name": "My Team Workspace",
    "ownerId": "user_xyz",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

## GET /api/workspace

List all workspaces the authenticated user belongs to.

### Response

```json
{
  "workspaces": [
    {
      "id": "ws_abc123",
      "name": "My Team Workspace",
      "ownerId": "user_xyz",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

## POST /api/workspace/invite

Invite a user to a workspace by email. Requires `admin` or `owner` role.

### Request

```json
{
  "workspaceId": "ws_abc123",
  "email": "teammate@example.com",
  "role": "member"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workspaceId` | string | Yes | Workspace ID |
| `email` | string | Yes | Email of the user to invite |
| `role` | string | No | `owner`, `admin`, or `member` (default: `member`) |

### Response

```json
{
  "member": {
    "id": "mem_xyz",
    "workspaceId": "ws_abc123",
    "userId": "user_abc",
    "role": "member",
    "joinedAt": "2025-01-01T00:00:00.000Z"
  }
}
```

## GET /api/workspace/members?workspaceId=ws_abc123

List all members of a workspace. Requires membership.

### Response

```json
{
  "members": [
    {
      "id": "mem_xyz",
      "workspaceId": "ws_abc123",
      "userId": "user_abc",
      "role": "owner",
      "joinedAt": "2025-01-01T00:00:00.000Z",
      "user": { "id": "user_abc", "name": "Alice", "email": "alice@example.com" }
    }
  ]
}
```

## PUT /api/workspace/update-member

Update a member's role. Requires `admin` or `owner` role.

### Request

```json
{
  "workspaceId": "ws_abc123",
  "userId": "user_abc",
  "role": "admin"
}
```

## DELETE /api/workspace/delete

Delete a workspace. Owner only.

### Request

```json
{
  "workspaceId": "ws_abc123"
}
```

## Roles

| Role | Permissions |
|------|-------------|
| `owner` | Full control — delete workspace, change any role, remove members |
| `admin` | Invite members, update member roles |
| `member` | View members, participate in workspace |

## Example (JavaScript)

```javascript
// Create a workspace
const res = await fetch("/api/workspace/create", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Frontend Team" }),
});
const { workspace } = await res.json();

// Invite a teammate
await fetch("/api/workspace/invite", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workspaceId: workspace.id, email: "bob@example.com" }),
});
```
