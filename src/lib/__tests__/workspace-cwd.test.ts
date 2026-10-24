// workspace-cwd validation — the split-deployment regression.
//
// The route is served by the API host, which `stat()`s the submitted path. In
// a split deployment the renderer registers a folder on the USER'S machine, so
// the path is rooted on a different OS and can never be stat'd here. The old
// "must be a directory on this host" rule rejected every one of those, and the
// UI surfaced it as `Could not register <path> as the workspace (HTTP 400 —
// Invalid directory)`.
import { setWorkspaceCwd, getWorkspaceCwdForUser, clearWorkspaceCwd } from "../workspace-cwd";

jest.mock("@/lib/prisma", () => ({
  prisma: { user: { update: jest.fn().mockResolvedValue({}) } },
}));

const UID = "user-1";

afterEach(() => clearWorkspaceCwd(UID));

describe("setWorkspaceCwd", () => {
  it("rejects an empty path", async () => {
    await expect(setWorkspaceCwd("", UID)).resolves.toBe(false);
  });

  it("rejects when the userId is unusable", async () => {
    await expect(setWorkspaceCwd("C:\\Users\\me\\proj", "")).resolves.toBe(false);
  });

  it("rejects a path longer than the cap", async () => {
    await expect(setWorkspaceCwd("C:\\" + "a".repeat(600), UID)).resolves.toBe(false);
  });

  it("accepts a Windows path the host cannot stat (client-local folder)", async () => {
    // `C:\Users\me\Music` does not exist on a Linux API host — that is the
    // whole point: the folder is on the user's machine, not the server's.
    await expect(setWorkspaceCwd("C:\\Users\\me\\Music", UID)).resolves.toBe(true);
    expect(getWorkspaceCwdForUser(UID)).toBe("C:\\Users\\me\\Music");
  });

  it("accepts a UNC path (\\host\share) the host cannot stat", async () => {
    await expect(setWorkspaceCwd("\\\\nas\\share\\proj", UID)).resolves.toBe(true);
  });

  it("accepts a forward-slash Windows path (C:/Users/me/proj)", async () => {
    await expect(setWorkspaceCwd("C:/Users/me/proj", UID)).resolves.toBe(true);
  });

  it("still rejects a POSIX-looking path that is not there (checkable here)", async () => {
    // Not Windows-rooted, so the host COULD have verified it — and it is not a
    // directory. Rejecting preserves the original guard for same-host paths.
    await expect(setWorkspaceCwd("/definitely/not/a/real/dir/orplex-test", UID)).resolves.toBe(false);
    expect(getWorkspaceCwdForUser(UID)).toBeNull();
  });

  it("does not leak one user's workspace to another", async () => {
    await setWorkspaceCwd("C:\\Users\\me\\proj", UID);
    expect(getWorkspaceCwdForUser("user-2")).toBeNull();
  });

  it("clearWorkspaceCwd removes the registration", async () => {
    await setWorkspaceCwd("C:\\Users\\me\\proj", UID);
    clearWorkspaceCwd(UID);
    expect(getWorkspaceCwdForUser(UID)).toBeNull();
  });
});
