# vX.Y — <theme>

**Status:** ⬜ not started / 🟡 in progress / ✅ done
**Depends on:** <previous release(s)>
**Demo (definition of done):** <the one thing a person can do at the end that proves this release works>

## Goals
- ...

## Scope — IN
- ...

## Scope — OUT (deferred / not this release)
- ...

## Build slices (parallelizable via worktrees)
> Slice 0 (contracts/scaffold) lands on the working branch FIRST so every worktree builds against stable interfaces. Then slices fan out into worktrees, then integrate back.

- **Slice 0 (main):** ...
- **Slice A (worktree):** ...
- **Slice B (worktree):** ...

## Checklist
- [ ] ...

## File map
- `path` — purpose

## Verification
- [ ] `pnpm typecheck` clean
- [ ] `pnpm build` clean
- [ ] manual demo passes (describe steps)

## Notes / decisions discovered
- (append as you build; promote real decisions to docs/DECISIONS.md)
