# AgentWatch Code & Style Guide

This document defines the architectural standards, code style, performance guidelines, and conventions for the `@agentwatch-ai/bridge` package.

Everything here that can be machine-checked is enforced by `eslint.config.js`. `npm run lint` is expected to report **zero errors and zero warnings**; a warning nobody fixes is a rule nobody follows.

---

## 1. Core Principles

1. **Pure Functional Style**:
   - Write pure, deterministic functions: $f(x) \to y$.
   - **Zero side-effects** in core logic / transformations.
   - Do **NOT** mutate arguments. Return new values instead — including accumulators: a helper that "adds to the stats" takes no stats, it returns its own delta and the caller folds them (see `mergeDeltas` in `src/transport/queue.ts`).
   - Separate pure computation (core) from impure I/O (adapters, network, file system).

2. **Control Flow: Guard Clauses Only (No `if-else`)**:
   - **Never** use `else` or `else if`.
   - Use early returns / guard clauses at the top of functions.
   - Format:
     ```typescript
     // ❌ BAD
     function process(item?: Item) {
       if (item) {
         return item.value;
       } else {
         return null;
       }
     }

     // ✅ GOOD
     function process(item?: Item): string | null {
       if (!item) {
         return null;
       }

       return item.value;
     }
     ```

3. **Padding Lines & Formatting**:
   - Always leave an empty line before `return`.
   - Always leave an empty line before and after control structures (`if`, `for`, `switch`, `try`).
   - Leave an empty line between declarations and logic.

4. **Flows, not call graphs**:
   - An entry point is expressed as an ordered list of **named stages**, each a pure function of one immutable state value, composed with `runFlow` from `src/core/pipe.ts`.
   - A stage returns `next(state)` to continue or `stop(state, reason)` to end the flow. "Stop" is a value, never a thrown error or a nullable return.
   - The canonical example is `src/pipeline/hook-pipeline.ts`: the whole hook contract is five lines you read top to bottom, and reordering a step is a change to that array.
   - `pipe(...)` composes plain value transformations left to right for the same reason: a derivation should read in the order it happens.

---

## 2. Directory & File Organization

Organize each domain module cleanly into isolated components:

```text
src/
├── <module>/
│   ├── types/                   # Domain TypeScript types & interfaces (*.types.ts)
│   ├── constants/               # Constants, regex, lookup sets (*.constants.ts)
│   ├── schemas/                 # Runtime validators (zod) — *.schema.ts
│   ├── <module>.adapter.ts      # I/O or provider-specific transformations
│   ├── <module>.ts              # Pure domain business logic
│   └── index.ts                 # Explicit public exports
```

- **Types (`types/`)**:
  - Keep types and interfaces in dedicated type files, suffixed `.types.ts`.
  - Declare fields as `readonly` by default for zero-cost compile-time immutability. This is what actually forces purity: a readonly `AgentWatchEvent` is why provider adapters build events from patches instead of editing them field by field.
  - Where a type is *derived* from a validator (`z.infer`), the types file imports the schema — never the other way round. That is the whole reason `schemas/` exists as its own layer.
- **Constants (`constants/`)**:
  - Store configuration constants, lookup tables, static sets, and pre-compiled regex in `constants/` or `*.constants.ts`.
  - Use `as const` for objects and arrays, and `ReadonlySet` / `ReadonlyMap` for membership tables.
- **Schemas (`schemas/`)**:
  - zod schemas are *logic* (they validate), so they do not belong in `types/`; and their inferred types are *contracts*, so they do not belong beside the logic that uses them. They get their own layer: `schemas/` depends on nothing, `types/` depends on `schemas/`, logic depends on both.
- **Public surface (`index.ts`)**:
  - Every module exports its public surface explicitly from `index.ts`, with a file-level comment saying what the module is *for*. Deep imports remain possible; the index is the documented contract.

---

## 3. High Performance & Engine (V8) Optimizations

1. **Pre-compiled Regular Expressions**:
   - Never create `new RegExp(...)` or `/.../` inside hot function bodies.
   - Define them once in constants:
     ```typescript
     // constants/feature.constants.ts
     export const RE_TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
     ```
   - A pattern that genuinely depends on runtime data (a repository root, a home directory) is compiled **once per pass** and threaded through, never once per value — see `buildPathRewriter` in `src/events/enrich.ts`.
   - A `g`-flagged pattern is stateful: share it with `String.prototype.replace`, never with `.test()`.

2. **$O(1)$ Lookups over Array Scans**:
   - Use `Set.prototype.has` or `Map.prototype.get` instead of `.includes()`, `.some()`, or `.indexOf()` for recurring checks.
   - Anything the hook path resolves per invocation is indexed at module load (`src/providers/registry.ts`).

3. **Avoid Unnecessary Intermediate Allocations in Hot Paths**:
   - In performance-critical loops (telemetry stream processing, parsing transcripts), prefer a single-pass `for (const item of list)` over multi-pass `.map().filter().reduce()` chains.

4. **Object Shape Monomorphism**:
   - Initialize objects with a stable shape.
   - Do not use `delete obj.key` — it transitions the object to dictionary mode and deoptimizes every access site sharing its hidden class. Build a new object without the key: `omitKeys()` in `src/core/object.ts`. The lint config bans the operator outright.

---

## 4. TypeScript Best Practices

- **Explicit Return Types**:
  - Every function declaration must declare an explicit return type:
    ```typescript
    export function normalizeTimestamp(raw: string): number { ... }
    ```
- **Type-Only Imports**:
  - Use `import type { ... }` or `import { type Foo, bar }` to optimize bundler output and avoid runtime import overhead.
- **No `any`**:
  - Use `unknown` with type guards, generic type parameters, or `zod` schemas.

---

## 5. Documentation (JSDoc)

- Document every **exported** function, class and interface with JSDoc, including `@param` and `@returns` descriptions:
  ```typescript
  /**
   * Transforms raw OTLP log records into AgentWatch canonical events.
   *
   * @param record - The incoming raw OTLP log record.
   * @param context - Execution environment and agent metadata.
   * @returns Normalized canonical event, or null if the record is filtered.
   */
  export function normalizeOtlpRecord(record: RawOtlpLog, context: AdapterContext): AgentWatchEvent | null {
    if (!record.body) {
      return null;
    }

    return buildCanonicalEvent(record, context);
  }
  ```
- **Say why, not what.** The signature already states what a function takes and returns. The prose exists for the reason the code is shaped the way it is — the failure it prevents, the agent quirk it works around, the guarantee it upholds. A comment that restates the code is worse than none.
- **Scope is the public surface.** Private helpers carry a comment when their *why* is not obvious and stay bare when it is. A rule requiring a block on every local helper produced 171 empty `/** */` stubs in this package, which is strictly worse than no doc at all — hence `publicOnly: true`.

---

## 6. Linting & Validation

Run all three before calling anything done:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # must be clean: 0 errors, 0 warnings
npm test            # vitest run
```

`npm run lint:fix` fixes the stylistic and padding violations automatically.
