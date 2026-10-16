---
name: tdd
description: Test-driven development loop (red, green, refactor) with the project's own test runner. Use when writing or changing any behaviour, fixing a bug, or when asked to add tests.
---

# Test-driven development

1. **Red.** Write one small test for the next behaviour, through the public interface. Run it and confirm it fails for the reason you expect (not a typo or import error).
2. **Green.** Write the simplest code that passes. Run the single test, then the whole suite.
3. **Refactor.** Remove duplication and clarify names with the suite green. Run it again.
4. Repeat for the next behaviour.

For bugs: first write a test that reproduces the bug and fails. The fix is done when that test passes and stays in the suite.

Commands come from `factory.json` (`test`, and `lint` before you finish). Typical runners: Vitest (`npx vitest run path`), pytest (`uv run pytest path -q`).

Good tests:

- Name the behaviour: `returns 404 when the patient does not exist`.
- One reason to fail per test. Arrange, act, assert.
- Deterministic: fake timers and network; no sleeps; no shared mutable state between tests.
- Synthetic fixtures only (see the `synthetic-data` skill).
