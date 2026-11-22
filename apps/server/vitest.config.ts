import { defineConfig, configDefaults } from 'vitest/config';

// Keep the test runner to our source. `data/` holds runtime state (SQLite, git
// repos, agent worktrees) that is gitignored and can contain agent-generated
// `*.test.ts` stubs — never discover or run those.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'data/**'],
  },
});
