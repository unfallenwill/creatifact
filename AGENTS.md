# Creatifact

Creatifact is a TypeScript CLI project (bundled by tsdown, tested with Vitest; tsc performs strict type-checking only, and Biome handles linting/formatting).

## Commands

- `npm run dev` - run src/index.ts directly via tsx, no build needed
- `npm run typecheck` - strict type-checking with tsc (check only, no output)
- `npm test` - single Vitest run
- `npm run coverage` - Vitest coverage report (v8)

`src/__tests__/cli.test.ts` in `npm test` spawns `dist/index.mjs` for integration tests; it builds automatically when dist is missing.
- `npm run build` - bundle to dist/ with tsdown
- `npm run lint` - Biome check over src and config files
- `npm run format` - Biome format and write
- `npm run smoke` - run the built artifact `dist/index.mjs --version` to verify it executes
- `npm run qa` - full gate: typecheck + build + test + lint + smoke (must pass before every commit/CI run)
- `npm run clean` - delete dist/

## Code style

Enforced by Biome, not Prettier: 2-space indent, double quotes, no semicolons. `useLiteralKeys` is off because tsconfig's `noPropertyAccessFromIndexSignature` requires bracket access to `process.env` — the two rules conflict.

## Tooling conventions

- Use context7 when looking up library/framework/CLI documentation.
- Use firecrawl skills for web search, scraping, parsing, and bulk content extraction.
