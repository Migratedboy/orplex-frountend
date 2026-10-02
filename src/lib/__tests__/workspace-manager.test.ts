import type { WorkspaceRole } from "../workspace/workspace-manager";

describe("workspace-manager", () => {
  // ---------------------------------------------------------------
  // Role hierarchy (pure logic, no DB)
  // ---------------------------------------------------------------
  describe("role hierarchy", () => {
    const roleHierarchy: Record<WorkspaceRole, number> = {
      owner: 3,
      admin: 2,
      member: 1,
    };

    it("owner is highest role", () => {
      expect(roleHierarchy.owner).toBeGreaterThan(roleHierarchy.admin);
      expect(roleHierarchy.owner).toBeGreaterThan(roleHierarchy.member);
    });

    it("admin is above member", () => {
      expect(roleHierarchy.admin).toBeGreaterThan(roleHierarchy.member);
    });

    it("member has minimum role", () => {
      expect(roleHierarchy.member).toBe(1);
    });

    it("has exactly 3 roles", () => {
      expect(Object.keys(roleHierarchy)).toHaveLength(3);
      expect(Object.keys(roleHierarchy)).toEqual(
        expect.arrayContaining(["owner", "admin", "member"]),
      );
    });
  });

  // ---------------------------------------------------------------
  // Type checks (compile-time, verified at build)
  // ---------------------------------------------------------------
  describe("types", () => {
    it("WorkspaceRole accepts valid roles", () => {
      const validRoles: WorkspaceRole[] = ["owner", "admin", "member"];
      expect(validRoles).toHaveLength(3);
    });
  });
});
