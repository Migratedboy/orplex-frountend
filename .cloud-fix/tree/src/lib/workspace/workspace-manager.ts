// workspace-manager.ts — Multi-user workspace management
// Handles workspace creation, membership, and permissions

import { prisma } from "../prisma";

export type WorkspaceRole = "owner" | "admin" | "member";

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: Date;
  user?: { id: string; name: string | null; email: string | null };
}

/**
 * Create a new workspace
 */
export async function createWorkspace(
  name: string,
  ownerId: string
): Promise<Workspace> {
  const workspace = await prisma.workspace.create({
    data: {
      name,
      ownerId,
      members: {
        create: {
          userId: ownerId,
          role: "owner",
        },
      },
    },
  });
  return workspace as Workspace;
}

/**
 * Get a workspace by ID
 */
export async function getWorkspace(id: string): Promise<Workspace | null> {
  return prisma.workspace.findUnique({ where: { id } }) as Promise<Workspace | null>;
}

/**
 * Get all workspaces for a user
 */
export async function getUserWorkspaces(userId: string): Promise<Workspace[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: true },
  });
  return memberships.map((m: any) => m.workspace as Workspace);
}

/**
 * Get workspace members
 */
export async function getWorkspaceMembers(
  workspaceId: string
): Promise<WorkspaceMember[]> {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { joinedAt: "asc" },
  });
  return members as unknown as WorkspaceMember[];
}

/**
 * Add a member to a workspace
 */
export async function addMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = "member"
): Promise<WorkspaceMember> {
  // Check if already a member
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (existing) {
    throw new Error("User is already a member of this workspace");
  }

  return prisma.workspaceMember.create({
    data: { workspaceId, userId, role },
  }) as Promise<WorkspaceMember>;
}

/**
 * Remove a member from a workspace
 */
export async function removeMember(
  workspaceId: string,
  userId: string
): Promise<void> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!member) throw new Error("User is not a member of this workspace");
  if (member.role === "owner") throw new Error("Cannot remove the workspace owner");

  await prisma.workspaceMember.delete({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole
): Promise<WorkspaceMember> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!member) throw new Error("User is not a member of this workspace");
  if (member.role === "owner") throw new Error("Cannot change the owner's role");

  return prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: { role },
  }) as Promise<WorkspaceMember>;
}

/**
 * Check if a user has a specific role in a workspace
 */
export async function hasRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole
): Promise<boolean> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!member) return false;

  const roleHierarchy: Record<WorkspaceRole, number> = {
    owner: 3,
    admin: 2,
    member: 1,
  };

  return roleHierarchy[member.role as WorkspaceRole] >= roleHierarchy[role];
}

/**
 * Delete a workspace (owner only)
 */
export async function deleteWorkspace(
  workspaceId: string,
  userId: string
): Promise<void> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!member || member.role !== "owner") {
    throw new Error("Only the workspace owner can delete it");
  }

  // Delete members first, then workspace
  await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
  await prisma.workspace.delete({ where: { id: workspaceId } });
}
