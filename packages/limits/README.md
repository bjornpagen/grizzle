# @grizzle/limits

grizzle's limits: every number grizzle bounds something by, each a `Limit` of `@bjornpagen/limit` with its evidence.
The limits skill (`vendor/toolchain/packages/devtools/skills/limits/SKILL.md`, linked as `.agents/skills/limits`) is
the policy; this README is what grizzle adds to it. Read both before you mint, move or delete a limit.

- `src/limits.ts` holds every mint. Nothing else in the repository calls `published`, `measured`, `derived` or
  `provisional` (`devtools/limits-sole-mint`), and nothing else writes a bound as a bare number
  (`devtools/no-bare-limit`); code imports a limit from `@grizzle/limits` and reads `.value` where the bound acts, and
  imports the `Limit` type from `@bjornpagen/limit`. A constant that holds exactly `someLimit.value`, or
  `BigInt(someLimit.value)`, is that limit.
- The package depends on `@bjornpagen/limit` alone and imports nothing of grizzle's: the engine, the shell, the local
  cluster's package, the benches and the scripts read it, never the other way round.
- Test files (`*.test.ts`, `*.test.tsx`, `*.fixtures.ts`, and every `test/`, `tests/` and `fixtures/` directory) are
  exempt from both rules: a test's times, widths and sizes are its own inputs, and `test/support/limits.ts` mints the
  test tiers' own. `bench/` and `scripts/` are no tests.

## Should it exist?

The skill's first question decides every number before it is minted. In grizzle that leaves three kinds, and nothing
else:

- **A fact of a system grizzle compiles against or runs on**, published, or derived by arithmetic over such facts:
  PostgreSQL 19rc2's (pinned by `scripts/pg/pin.env`; its sources at `postgresSource`, `REL_19_RC2`), pgvector 0.8.7's,
  IEEE 754's, V8's, TLS's, OpenSSL's, the kernels', Node's timers'.
- **An edge of PostgreSQL's own refusal that it publishes no number for**, measured against the pinned build: the regex
  compiler's stack and memory edges (`regexMaxDepth`, `regexMaxMatchStates`, `regexMaxMatchCells`, `regexMaxAnchors`),
  each refused at compile time as `ResourceBound` because PostgreSQL would refuse the pattern at install or at a write.
- **A genuine operating point between two shapes**, measured: the take(k) lowering's LATERAL threshold
  (`lateralParentMax`), the bytes delivery's chunk (`bytesChunkLength`), the regex analysis's subset construction
  (`regexDfaMaxStates`, `regexDfaMaxWork`, past which a pattern is keyed by its IR), and the local cluster family's
  sizing (`filesPerCluster`, `clientCheckInterval`, `workerDatabaseBytes`, `workerPredicateLocks`).

A cap on grizzle's own data or on a caller's trusted input (a schema, a config, a migration folder) protects nothing:
delete it. Where the code cannot handle a size, change the representation (an iterative walk, cycle detection,
streaming), never the number, and never truncate. A limit that changes generated SQL or a domain digest (the subset
construction's, the chunk length, the LATERAL threshold) changes every installation's next migration: measure it again
rather than move it, and say so in the commit.

## Bound, choice or fact

- **No bound**, as the skill lists it: 0, 1 but as a time, -1 in a comparison, a data length and index arithmetic
  against it, a factor, a unit conversion holding its ratio, a code unit in hexadecimal, a member of a closed
  vocabulary, and a format's defining width named with `@formatConstant` (`digestChars`, a hashed name's digest). A
  limit read against a format's own widths (the identifier budget a hashed name's stem keeps, `maxIdentifierBytes`
  less its lead, separator and digest; a migration folder's name, `fileNameMaxBytes` less its timestamp prefix; a live
  batch's text, `notifyPayloadMaxBytes` less base64's and the seal's widths) is that limit, computed beside the format.
- **A choice is the caller's input**, required and without a default. A pool's `{ max, min, idleTimeoutMs }`, a
  connection's `connectTimeoutMs` and a page's size are the caller's. Check the input against the published limit that
  bounds it, as `connectTimeoutMs` is admitted from `timerMinMs.value` to `timerMaxMs.value`, and name that range in the
  refusal.
- **A number the machine reports**, `availableParallelism()` or `testWorkers`, is read where it is needed, never
  minted: the local cluster family's members and each member's sizes are functions of it (`packages/pg`).

## Where a bound acts

The JSDoc above a mint says what it bounds, where it is refused and why that is the place, as `tableMaxColumns`'s does:
"refused as ResourceBound (tableColumns) where it is emitted, since PostgreSQL refuses the statement with 54011". The
evidence lives in the fields, never only in the prose. A function that decides by a threshold takes the threshold as a
parameter where a test drives that decision with a smaller value; production passes the limit.

A bound grizzle cannot pass refuses with a typed error that names it: `ResourceBound` at compile time, `InputTooLarge`
on the host before a flight is sent. grizzle makes one attempt per call and never retries: a retry is the caller's, of
a typed error that says the call may succeed when run again, and never of a COMMIT whose outcome is unknown.

## What the rules cannot see

no-bare-limit reads syntax. Review holds the rest, in every file of `packages/*/src`, `bench/` and `scripts/`:

- a bound in a comparison or a clamp (`depth > 8`, `Math.min(n, 100)`, `Date.now() - started > 5000`), in emitted SQL
  text or any string but a duration's, or passed through a function to where it bounds;
- inside a mint: open a published source at its anchor and match quote and value (`value` written as the source
  spells it, `2 ** 29 - 24`); resolve a measured record or the command that reproduces it (`pnpm bench dfa`,
  `pnpm bench gates --only R20`, `pnpm bench bytes`) and check that `decision` follows from `result`; audit a
  derivation's inputs and factors. A measured record whose `revalidate` has fired (a PostgreSQL repin, another machine)
  is measured again or demoted to `provisional` with the old record in `origin`.

Hunt every mint and every bound left by hand:

```sh
rg -n --glob '*.ts' --glob '!**/node_modules/**' --glob '!packages/*/types/**' '\b(published|measured|derived|provisional)\(' .
```
