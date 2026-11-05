# grizzle's limit mechanism

This is how grizzle records what `SKILL.md` requires. `SKILL.md`'s rules hold here; this file names where each lives.

grizzle chooses no number on its caller's behalf. A number that bounds something is the caller's input or the `.value`
of a `Limit`: a frozen, branded value that carries its own evidence, minted only by `published`, `measured` or
`derived` of `packages/engine/src/core/limits.ts` (imported as `#compiler/core/limits.ts`). superlint's
`limit-evidence` gate refuses a bare number where it bounds something. The JSDoc `@limitKind` tags are retired, and no
gate reads them.

## Bound, choice or fact, in grizzle

- **No bound**, as the gate counts it: 0 anywhere; 1 anywhere but a time a value sets, where one unit of time is a
  choice; -1 where a value is compared or counts from the end; 2 in `n < 2` and `n >= 2`; a data length the code reads
  (`xs.length`, a prefix's `.length`); index arithmetic against a data length (`i + 4 <= text.length`,
  `text.slice(i + 2, i + 6)`, a loop's start); a factor that scales, shifts, masks or reduces data (`ms * 1000`,
  `b & 0x3f`, `n % 2`, `2 ** k`); a unit conversion named for its two time units and holding their exact ratio
  (`millisPerSecond = 1000`); a code unit or a bit pattern, written in hexadecimal (`c >= 0x30`); a member of a closed
  vocabulary (a parameter typed `0 | 1 | 2`); and a format's defining width, a named constant whose JSDoc names the
  format with `@formatConstant` (`@formatConstant a SQLSTATE: five characters`).
- **A choice is the caller's input**, required and without a default. A pool's `{ max, min, idleTimeoutMs }`, a
  connection's `connectTimeoutMs` and a page's size are the caller's. Delete a default rather than mint it, and never
  write `options.max ?? 10` or `(ms = 250) =>`. Check the input against the published limit that bounds it, as
  `connectTimeoutMs` is admitted from 1 to `timerMaxMs.value`, and name that range in the refusal.
- **Published** is a fact of PostgreSQL, V8, Node, a protocol or a file system. **Measured** is an operating point
  between two genuinely different forms (the LATERAL probe against the whole-relation pass) or a budget on grizzle's
  own work. **Derived** is arithmetic over other limits.
- A number the machine reports, such as `availableParallelism()`, is read where it is needed, never minted.

## The Limit

`Limit<N extends number | bigint = number>` states four things every kind shares, then its kind's evidence:

- `value`: the number, as a `number` or, for `Limit<bigint>`, a `bigint`. `AnyLimit` is either.
- `owner`: who sets it. Another system by its pinned version ("PostgreSQL 19rc1", "V8 14.6, Node 26.13.0's JavaScript
  engine"), or grizzle's own unit by file and function ("grizzle's take(k) lowering (lower/shapes/take)").
- `unit`: what it counts, plural: "bytes", "columns", "bound parents", "NFA positions", "milliseconds".
- `scope`: exactly what one instance of the bound covers: "one table, view or materialized view, its dropped columns
  included", not "tables".

Only the three mints make a Limit; never build or cast one by hand. Read `.value` where the bound acts: a constant that
holds exactly `someLimit.value`, or `BigInt(someLimit.value)`, is that limit. Spell each limit once: declare it beside
its one owner (`collapseLimit` in `lower/optimize/existence`, `timerMaxMs` in the shell's connection config), or in
`core/limits.ts` when several modules read it, and a second reader imports it instead of minting the number again. The
test tiers' times are in `test/support/limits.ts` and the benchmarks' in `bench/harness/limits.ts`.

The JSDoc above a limit says what it bounds, where it is refused and why that is the place, as `tableMaxColumns` does:
"refused as ResourceBound (tableColumns) where it is emitted, since PostgreSQL refuses the statement with 54011". The
evidence lives in the fields, never only in the prose. A function that decides by a threshold takes the threshold as a
parameter where a test drives that decision with a smaller value; production passes the limit.

### published

```ts
const postgresSource = "https://github.com/postgres/postgres/blob/REL_19_RC1"

export const regexMaxRepeat = published({
	value: 255,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "repetitions",
	scope: "each bound of a counted repetition in one str.regex pattern",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/regex/regguts.h#L95`,
	quote: "#define _POSIX2_RE_DUP_MAX\t255",
	verified: "2026-11-05"
})
```

- `source`: an `https://` URL pinned to the exact release grizzle runs (a tag such as `REL_19_RC1` or `v26.13.0`, a
  versioned docs path such as `/docs/19/`), anchored to the line that states the number. A moving branch is no source.
- `quote`: that line's text, verbatim and short, read at the anchor.
- `value`: written as the source spells it, so a reader compares the two at a glance: `2 ** 29 - 24` for
  `(1 << 29) - 24`, `0x3fff_ffff` for `((Size) 0x3fffffff)`.
- `constraint`: one of five. `SKILL.md`'s four, `"hard quota"`, `"advisory threshold"`, `"protocol constant"` and
  `"configurable default"`, and `"compile-time constant"`, a define of the build (`MaxHeapAttributeNumber`,
  `String::kMaxLength`). A `"configurable default"` is a setting's default grizzle runs under (`join_collapse_limit`'s
  8): say it is a default in the JSDoc and the scope.
- `verified`: the day the source was opened and the number checked, `YYYY-MM-DD`. A repin re-verifies and re-dates it.

When the source states the number only as a formula over another number, mint that other number `published` and this
one `derived`, quoting the formula with its pinned URL and date in `derivation` (`messageMaxBytes`, `MaxAllocSize -
1`). A second source that corroborates the first goes in the JSDoc; `source` holds the one the value is checked
against. Strings several mints share, a source's URL prefix or one page's quote, are a constant spread into each, never
a second spelling of a number.

### measured

```ts
// Abridged from core/limits.ts; read lateralParentMax there for its complete record.
export const lateralParentMax = measured({
	value: 256,
	owner: "grizzle's take(k) lowering (lower/shapes/take, lower/shapes/index.ts runsLargeForm)",
	unit: "bound parents",
	scope:
		"the distinct parents of one execution's bound parent set, at or below which take(k) per parent is the LATERAL probe",
	evidence:
		"bench/results/gates/query-take.full.json, the uncommitted record of `pnpm bench gates --only R20` (bench/query/take.bench.ts, gate R20)",
	observed: "2026-11-05 10:01:00 to 10:07:00 UTC, one full-scale run",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0, the local PostgreSQL 19rc1 cluster (scripts/pg/pin.env), grizzle 48256f8d6148; load average 9 to 10 from other sessions on the machine",
	workload:
		"the Lab fixture's take bench: take(1) as DISTINCT ON and take(3) as row_number over every group, against the LATERAL probe of LIMIT k per parent, for group sizes 2 to 128 and bound parent sets of 1 to 16384, 15 timed samples each after a warm run",
	result:
		"execute p50 in ms, LATERAL / whole-relation, groups of 2: at 256 parents 0.573/919.829 (k 1) and 0.614/0.737 (k 3); at 1024 parents 2.056/1.303 (k 1), the first measured count at which the whole-relation form is the faster. No throttling or errors",
	decision:
		"256 is the largest measured parent count at which the LATERAL probe is no slower than the whole-relation pass at every group size and k; at the next measured count, 1024, the whole-relation pass is faster for groups of two. No headroom added: a parent count between 256 and 1024 is unmeasured",
	revalidate:
		"a PostgreSQL repin or a planner setting change; a change to either form's SQL (lower/shapes/take); a different machine or cluster configuration; a run at a parent count between 256 and 1024"
})
```

The fields are `SKILL.md`'s seven, each a required string holding what `SKILL.md` requires of it: `evidence`,
`observed`, `environment`, `workload`, `result`, `decision` and `revalidate`.

- `evidence` names the run's files under the owning package's uncommitted run output (`bench/results/`) and the
  command that writes them (`pnpm bench gates --only R20`, `pnpm bench dfa`), so re-running the bench reproduces it.
- `environment` names the machine and its load, Node, the PostgreSQL pin (`scripts/pg/pin.env`) and grizzle's
  revision.
- `decision` states the unmeasured gap between the chosen point and the next measured one.
- Limits that share one run spread one constant object of its strings into each mint, as the compile-space and
  subset-construction limits do, and each states the fields that differ, its own `decision` among them.

### derived

```ts
export const messageMaxBytes = derived({
	owner: "PostgreSQL 19rc1's frontend/backend protocol",
	unit: "bytes",
	scope: "one message from client to server, as its Int32 length counts it, itself included",
	from: [maxAllocSize],
	derivation: `a protocol constant, PQ_LARGE_MESSAGE_LIMIT, which libpq.h defines as one less than MaxAllocSize: "#define PQ_LARGE_MESSAGE_LIMIT\t(MaxAllocSize - 1)" (${postgresSource}/src/include/libpq/libpq.h#L34, verified 2026-11-05)`,
	compute: ([alloc]) => alloc.value - 1
})
```

- No `value`: `compute` makes it from `from`, a nonempty tuple of the limits it derives from, and must read them. A
  compute that returns a number of its own (`compute: () => 5000`) is refused: a number with evidence of its own is
  minted as that evidence's kind.
- `derivation`: why this arithmetic bounds this resource. A formula a source states is quoted there with its pinned
  URL and verified date.
- A data length the computation reads (`carrierPrefix.length`, the digits of `Number.MAX_SAFE_INTEGER`) needs no limit
  of its own. Every other number in `compute` is an identity, a unit conversion (bits to a byte) or a limit in `from`.
- Arithmetic on a `.value` anywhere else (`nestingLimit.value * 2`) derives a bound outside `derived`: mint the result.
- When an input is re-verified or remeasured, read what derives from it.

## The limit-evidence gate

`limit-evidence` (`packages/devtools/src/lint/rules/limit-evidence.ts`) runs in `pnpm check`, and alone on paths with
`pnpm superlint <files or dirs>`. Its names (the limits module and mints, the vocabularies, the scopes) are
`superlint.limitEvidence` in the root `package.json`. A file is in the first scope that names it:

| Files                                                                 | Checks                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/`, `packages/grizzle/src/`, but `*.generated.ts` | every bound below, and every property named for a bound                                                                                                       |
| `test/`                                                               | times, concurrencies and retry policies, by a library's properties only: a test's own records are data, and a `Gen` builder's arguments are the test's inputs |
| `bench/`, `scripts/`                                                  | as `test/`, and a bench `Gate`'s arguments are its inputs too                                                                                                 |

A package no scope names (the testing library, the dev tools) is not checked. An exception is a file listed for the
rule in `superlint.exceptions`, today only the documentation mirrors whose numbers are the documented application's;
there is no inline disable.

It refuses a **bare number** (a literal that is no identity, a number constant that is no Limit's value, or arithmetic
of only those) where it bounds:

- a comparison, in a loop's condition or not: `depth > 8`, `steps < 10_000`; a comparison with a value whose name says
  a category, or with a clock's reading (`Date.now() - started > 5000`), bounds that category;
- `Math.min` or `Math.max`: `Math.min(depth, 100)`;
- a length or a count, by the library parameter it is passed as: `text.slice(0, 8)`, `padStart(4, "0")`, `repeat(3)`,
  `Array.from({ length: 9 })`, `Array(9)`, `new Uint8Array(64)`;
- a time: `Duration.seconds(5)`, `Effect.sleep(5000)`, `setTimeout(tick, 50)`, `AbortSignal.timeout(60_000)`,
  `{ duration: 50 }`, a property named for a time (`idleTimeoutMs: 5_000`), and any duration text (`"5 seconds"`);
- a concurrency: `{ concurrency: 4 }` (`"unbounded"` is no number);
- a retry policy: `{ times: 3 }`, `Schedule.recurs(3)`, `Schedule.exponential(base, 2)`;
- a size: `{ max: 10 }`, a property named with max, min, size, limit, budget, depth, capacity, cap or threshold.

However the number is held: a constant; an object's property, through `as const`, `satisfies` and `Object.freeze`; a
computed key (`["concurrency"]: 6`); an assignment (`target.timeoutMs = 5000`); a countdown's initial value
(`let attempts = 3` compared in `while (attempts > 0)`); a parameter's default (`(ms = 250)`, `{ cap = 12 }`); an enum
member; a class's static property; a default export or a re-export; an argument of a function of the same scope, an
`Effect.fn` included, whose body puts that parameter in a bound position, however deep the calls go; and the value
such a function returns (`budget(elapsed)` returning `60_000 + 3 * spent`). A function of another scope, or of none,
is the code under test or a dependency: its arguments are the caller's inputs, and only a library's parameters named
above are bounds.

It refuses a bare number as a term of a value that reads data, too: an offset (`max - 8`, `timeoutMs + 500`), a
fallback (`max ?? 10`, either branch of `?:`), a default, a clamp, and any arithmetic with a Limit's `.value` but an
identity or a radix raised to it.

It refuses two more things:

- a `derived` whose `compute` reads none of its `from`;
- a module-level number constant whose name has a bound's word (in the library max, min, limit, bound, budget, timeout,
  deadline, retries, size, depth, cap, threshold, grace, ms, millis or seconds; in the tiers the times', concurrencies'
  and retries' words), holding a bare number, before anything reads it: `const pageMaxSize = 1_000`. A Limit's
  `.value`, `@formatConstant` and a unit conversion pass; `daySeconds = 86_400` holds its ratio, while `dayMs = 86_400`
  is refused, a day being 86,400,000 ms. In the tiers, an unexported constant that only a generator's calls read
  passes.

Its reports read:

```text
8 bounds a comparison as a bare number: a bound is a Limit or a caller's input.
10 is a fallback in a comparison, a bare number: a bound is a Limit or a caller's input.
compute reads none of the limits it derives from: a derived limit's value is computed from them.
pageMaxSize names a bound (max) and holds a bare number: a bound is a Limit's value or a caller's input.
```

Each report and admission has a line in the rule's fixtures, `packages/devtools/src/lint/fixtures/limit-evidence/`
(`violating.ts`, `clean.ts`, and `tests/` for the tiers). Read them when a report surprises you.

The gate cannot see, so review must:

- **Inside a mint.** The gate skips a mint's arguments, and the types check only their shape: every field present,
  `source` an `https://` string, `verified` shaped as a date, `constraint` one of the five, `from` nonempty. That the
  quote stands at the anchor and states the value, that the record exists and supports the decision, and that the
  derivation bounds the resource, no tool checks. Open each.
- A number inside emitted SQL text, or any string but a duration's.
- A value returned through a generator, an async function or a wrapper, and a file no scope names.

A clean gate proves that every bound reads a Limit, not that any Limit is true.

## Refusals and retries

A bound grizzle cannot pass refuses with a typed error that names it: `ResourceBound` at compile time, `InputTooLarge`
on the host before a flight is sent. grizzle makes one attempt per call and never retries: a retry is the caller's, of
a typed error that says the call may succeed when run again, and never of a COMMIT whose outcome is unknown.

## Hunt

Run `pnpm superlint` on the files you touched, then list every mint and every retired tag:

```sh
rg -n --glob '*.ts' --glob '!**/node_modules/**' --glob '!packages/*/dist/**' --glob '!packages/*/types/**' \
  '@limitKind|\b(published|measured|derived)\(' .
```

- A `@limitKind` tag left anywhere is an unminted limit: mint it, or make it the caller's input.
- For each mint: open its source at the anchor and match quote and value; resolve the measured record or the command
  that reproduces it, and check that `decision` follows from `result`; audit a derivation's inputs and factors.
- In a file no scope names, hunt bare bounds by hand, as the gate would.
