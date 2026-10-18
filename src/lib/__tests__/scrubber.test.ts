// scrubber.test.ts — Phase 4: secret scrubbing of untrusted tool output.
// Detection patterns are mirrored from src/lib/plugins/builtin/
// secret-scanner-plugin.ts (its regexes are file-private) — tests here pin
// the mirrored set to the shapes the plugin covers, plus the output-only
// shapes (Bearer/JWT/PEM/.env).

import {
  SCRUB_MAX_CHARS,
  scrubEnvFileContent,
  scrubSecrets,
} from "../reliability/scrubber";

describe("provider key shapes", () => {
  it("redacts sk- keys keeping first/last 4 chars", () => {
    const key = "sk-proj1234567890abcdefgh";
    const { text, redactions } = scrubSecrets(`key: ${key}`);
    expect(text).toContain("[REDACTED:provider_key:sk-p…efgh]");
    expect(text).not.toContain(key);
    expect(redactions).toEqual([{ kind: "provider_key", count: 1 }]);
  });

  it("redacts gsk_ (Groq) keys", () => {
    const { text } = scrubSecrets("key = gsk_abcdefghijklmnopqrst");
    expect(text).not.toContain("gsk_abcdefghijklmnopqrst");
    expect(text).toContain("[REDACTED:provider_key:gsk_…qrst]");
  });

  it("redacts nvapi- keys", () => {
    const { text } = scrubSecrets("nvapi-abcdefghijklmnopqr");
    expect(text).toContain("[REDACTED:provider_key:nvap…opqr]");
    expect(text).not.toContain("nvapi-abcdefghijklmnopqr");
  });

  it("redacts AKIA access keys", () => {
    const { text } = scrubSecrets("aws_access_key_id=AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("aws_access_key_id=[REDACTED:aws_key:AKIA…MPLE]");
  });

  it("redacts 36-char GitHub ghp_ tokens (plugin's exact length)", () => {
    const token = "ghp_" + "W".repeat(36);
    const { text } = scrubSecrets(`${token},`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:github_token:ghp_…" + token.slice(-4) + "]");
  });

  it("redacts api_key= / password= / token= assignments keeping the key readable", () => {
    const apiKey = scrubSecrets('api_key = "abcdefghijklmnop"');
    expect(apiKey.text).toBe("api_key = [REDACTED:api_key:abcd…mnop]");
    expect(scrubSecrets("password=hunter2secret").text).toContain("[REDACTED:password:hunt…cret]");
    expect(scrubSecrets("auth_token: abcdefghijklmnop").text).toContain(
      "auth_token: [REDACTED:token:abcd…mnop]",
    );
  });
});

describe("bearer tokens and JWTs", () => {
  it("redacts Authorization Bearer headers", () => {
    const token = "abcdefghij0123456789";
    const { text, redactions } = scrubSecrets(`Authorization: Bearer ${token}`);
    expect(text).toContain("Bearer [REDACTED:bearer_token:abcd…6789]");
    expect(text).not.toContain(token);
    expect(redactions.find((r) => r.kind === "bearer_token")?.count).toBe(1);
  });

  it("redacts JWTs (three base64url segments)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmZ1Kb4OdQ";
    const { text } = scrubSecrets(`token: ${jwt}`);
    expect(text).not.toContain(jwt);
    expect(text).toContain("[REDACTED:jwt:eyJh…4OdQ]");
  });
});

describe("PEM blocks and .env style assignments", () => {
  it("redacts a whole PEM private key block", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIICXQIBAAKBgQC5cH2hTtD1",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text } = scrubSecrets(`cert:\n${pem}\n`);
    expect(text).not.toContain("MIICXQIBAAKBgQC5cH2hTtD1");
    expect(text).toContain("[REDACTED:private_key]");
  });

  it("redacts sensitive .env-style KEY=value assignments", () => {
    const { text, redactions } = scrubSecrets(
      ["DATABASE_PASSWORD=s3cr3tValue123", "MY_API_KEY=sk-abcdefghij0123456789"].join("\n"),
    );
    expect(text).not.toContain("s3cr3tValue123");
    expect(text).not.toContain("sk-abcdefghij0123456789");
    expect(text).toContain("[REDACTED:");
    expect(redactions.length).toBeGreaterThan(0);
  });
});

describe("scrubEnvFileContent", () => {
  it("redacts ALL .env values, keeping keys and structure", () => {
    const env = [
      "# comment stays",
      "export DEBUG=true",
      "DATABASE_URL=postgres://user:pass@localhost:5432/db",
      "PORT=3000",
      'SECRET_TOKEN="long-secret-token-value"',
      "EMPTY_VALUE=",
    ].join("\n");
    const scrubbed = scrubEnvFileContent(env);
    expect(scrubbed).toContain("# comment stays");
    expect(scrubbed).toContain("export DEBUG=");
    expect(scrubbed).toContain("DATABASE_URL=");
    expect(scrubbed).toContain("PORT=");
    expect(scrubbed).toContain("SECRET_TOKEN=");
    expect(scrubbed).toContain("EMPTY_VALUE=");
    expect(scrubbed).not.toContain("postgres://user:pass@localhost:5432/db");
    expect(scrubbed).not.toContain("long-secret-token-value");
    expect(scrubbed).toContain("[REDACTED:env_value");
    expect(scrubbed.match(/\[REDACTED:env_value/g)?.length).toBe(5);
  });
});

describe("SCRUB_MAX_CHARS truncation", () => {
  it("is exactly 20000", () => {
    expect(SCRUB_MAX_CHARS).toBe(20000);
  });

  it("truncates over-long input with an explicit marker before scanning", () => {
    const big = `prefix ${"x".repeat(SCRUB_MAX_CHARS + 5000)} sk-bee9876543210fedcba tail`;
    const { text, truncated } = scrubSecrets(big);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(SCRUB_MAX_CHARS + 200);
    expect(text).toContain(
      `[SCRUB_TRUNCATED: original ${big.length} chars, truncated to ${SCRUB_MAX_CHARS} chars before scanning]`,
    );
    // the tail that was cut away must not have been scanned in
    expect(text).not.toContain("sk-bee9876543210fedcba");
  });
});

describe("multi-secret scrubbing", () => {
  it("redacts several different kinds in one pass, with per-kind counts", () => {
    const body = [
      "key1: sk-wwwwwwwwxxxxxxxxyyyyyy",
      `key2: ${"ghp_" + "W".repeat(32) + "abcd"}`,
      "key3: Bearer zzzzzzzzzz0123456789",
    ].join("\n");
    const { text, redactions } = scrubSecrets(body);
    expect(text).not.toContain("sk-wwwwwwwwxxxxxxxxyyyyyy");
    expect(text).not.toContain("ghp_WWWWWWWW");
    expect(text).not.toContain("zzzzzzzzzz0123456789");
    const kinds = redactions.map((r) => r.kind);
    expect(kinds).toContain("provider_key");
    expect(kinds).toContain("github_token");
    expect(kinds).toContain("bearer_token");
    // textual echo of the meta-redaction itself contains no rescrubbed secret
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  });

  it("leaves clean text byte-for-byte unchanged", () => {
    const clean = "all good here: npm test && npx tsc --noEmit";
    expect(scrubSecrets(clean).text).toBe(clean);
    expect(scrubSecrets(clean).redactions).toEqual([]);
    expect(scrubSecrets(clean).truncated).toBe(false);
  });

  it("tolerates empty input", () => {
    expect(scrubSecrets("").text).toBe("");
    expect(scrubSecrets("").redactions).toEqual([]);
  });
});
