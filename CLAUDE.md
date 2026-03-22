# CLAUDE.md

## Commit Rules
- Do NOT add "Co-Authored-By" trailers to commits
- Do NOT add AI attribution (e.g., "Generated with Claude") to code or commit messages

## Build
pnpm install && pnpm build

## Test
pnpm --filter @slice/tests test

## Start
pnpm --filter @slice/app start
