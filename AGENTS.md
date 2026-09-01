# AI Agent Instructions & Architectural Guidelines

When writing, refactoring, or generating code in `@agent-watch-ai/edge`, strictly follow these directives. `STYLEGUIDE.md` is the long form; this is the checklist.

## 1. Code Style & Functional Programming
- **Pure Functions**: keep functions pure, deterministic, and free of global mutations or side-effects in core domain logic. Never mutate an argument — including accumulators: return a delta and let the caller fold it.
- **No `else` / `else if`**: always use early returns (guard clauses). Handle invalid and edge-case conditions immediately at function start.
- **Padding Lines**:
  - Insert an empty newline before every `return`.
  - Insert an empty newline before and after every `if`, `for`, `switch`, `try`.
- **Flows, not call graphs**: express an entry point as an ordered list of named stages over one immutable state, composed with `runFlow` (`src/core/pipe.ts`). A stage returns `next(state)` or `stop(state, reason)`. See `src/pipeline/hook-pipeline.ts`.
- **JSDoc**: on every **exported** function, class and interface, with `@param` and `@returns`. Say *why*, not what. Private helpers get a comment only when their reason is not obvious — never an empty block.

## 2. Directory Structure & Organization
- **Types**: `src/<module>/types/<name>.types.ts`. `readonly` by default.
- **Constants**: `src/<module>/constants/<name>.constants.ts` — magic strings, static arrays, lookup tables, pre-compiled regex.
- **Schemas**: `src/<module>/schemas/<name>.schema.ts` — zod validators. Dependency direction is `schemas → types → logic`, never back.
- **Public surface**: every module has an `index.ts` with explicit exports and a comment saying what the module is for.
- **Imports**: prefer type-only imports (`import type { ... }`).

## 3. High Performance Guidelines
- **Zero-allocation in hot paths**: avoid cascading `.map().filter()` chains when processing large batches of events or logs. Use single-pass loops.
- **Regex**: define patterns at module top level or in a constants file, never inside a function. A pattern built from runtime data is compiled once per *pass*, not once per value.
- **Lookups**: `ReadonlySet` / `ReadonlyMap` for membership checks. Index anything the hook path resolves per invocation at module load.
- **No `delete`**: it deoptimizes V8 hidden classes. Use `omitKeys()` from `src/core/object.ts`. The lint config bans the operator.

## 4. Non-negotiable Runtime Invariants
These are not style; breaking one is a bug, whatever the code looks like.
- A hook **never** fails the coding agent. Every failure path degrades to the provider's safe response and exit code 0.
- A product record is **never** discarded on a failed send. It goes to the offline queue.
- Secrets are **never** transmitted. Sanitization is unconditional, independent of capture settings.
- Only AgentWatch-owned entries are ever removed from an agent's config. When ownership is unclear, refuse and tell the user.
- Usage is attributed **exactly once**. Any change touching turn windows, transcript claims or the ledger join must keep it that way.

## 5. Verification Workflow
After making any code changes, verify your work. All three must be clean — `lint` reports zero errors *and* zero warnings:
```bash
npm run typecheck
npm run lint
npm test
```
