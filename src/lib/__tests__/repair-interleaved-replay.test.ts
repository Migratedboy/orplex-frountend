/**
 * `repairInterleavedReplay` must never rewrite content it did not repair.
 *
 * The residue-cleanup rules (collapse 2+ spaces, collapse 3+ identical
 * alphanumerics) used to run over the WHOLE message once any single replay was
 * repaired. One duplicated phrase anywhere in a 50 KB answer therefore
 * flattened every indented line in every code fence and mangled every sha256
 * digest, base64 blob and padded number in the message.
 */
import { repairInterleavedReplay } from "../stream-reader";

describe("repairInterleavedReplay — collateral damage", () => {
  it("preserves code indentation and hashes far from the repaired span", () => {
    const head = "Here is the analysis.\n\n```python\ndef f():\n    return 1\n```\n\n";
    // The known gpt-oss replay signature: a doubled sentence fragment.
    const corruption = "The user has The user has asked a question about this.";
    const tail =
      "\n\nChecksum is sha256:9f8a0000000beef and token AAAAabcdef and version 1.0.00000.\n";

    const out = repairInterleavedReplay(head + corruption + tail);

    expect(out).not.toBe("");
    // The Python block must keep its 4-space indent.
    expect(out).toContain("    return 1");
    // Digests / base64 / padded numbers must survive intact.
    expect(out).toContain("sha256:9f8a0000000beef");
    expect(out).toContain("AAAAabcdef");
    expect(out).toContain("1.0.00000");
  });

  it("still performs the actual replay repair", () => {
    const out = repairInterleavedReplay("The user has The user has asked a question.");
    // Doubled fragment collapsed.
    expect(out.match(/The user has/g)?.length).toBe(1);
  });

  it("leaves a clean message completely untouched", () => {
    const clean = "Just a normal answer.\n\n```js\n  const x = 1;\n```\n";
    expect(repairInterleavedReplay(clean)).toBe(clean);
  });
});
