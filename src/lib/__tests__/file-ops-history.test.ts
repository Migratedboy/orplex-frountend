import { getLocalPendingChanges } from "../file-history";
import { writeFileAudited, type FileOpsCounters, type FileOpsFs } from "../agent/file-ops";

describe("audited file writes", () => {
  it("records an existing empty file as an empty snapshot, not a new file", async () => {
    const path = `empty-${Date.now()}.txt`;
    // Mock FS that actually stores writes, so the post-write read-back
    // verification in writeFileAudited sees the persisted content.
    const files = new Map<string, string>();
    const fs: FileOpsFs = {
      readFile: async (p) => files.get(p) ?? "",
      writeFile: async (p, c) => {
        files.set(p, c);
        return true;
      },
      editFile: null,
      directoryName: "workspace",
    };
    const counters: FileOpsCounters = {
      writtenFiles: new Map(),
      getTotalWrites: () => 0,
      setTotalWrites: () => undefined,
      setFilesChanged: () => undefined,
      bumpStat: () => undefined,
    };

    await expect(writeFileAudited(path, "content", fs, counters)).resolves.toBe(true);
    expect(getLocalPendingChanges().find((change) => change.path === path)).toMatchObject({
      previousContent: "",
      newContent: "content",
    });
  });
});
