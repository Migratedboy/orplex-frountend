# Verified commits

Work is not done because the code looks right. It is done when the verification lanes pass.

---
## Rules

1. After every code change, run the project's checks (tsc --noEmit + the test suite) and read the EXIT CODES. Exit 0 is the only "passed".
2. Never summarize a task as complete while any check fails. Report the failure and the fix you attempted instead.
3. If a check was never run (no test suite, no compiler), say so explicitly — "unverified" is an honest status, a guess is not.
4. Never rewrite history: no git push --force, no git commit --no-verify, no amending commits you did not create in this session.
5. Commit small and often; every commit message says WHY, not just what.
