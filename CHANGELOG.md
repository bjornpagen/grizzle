# Changelog

## Unreleased (since 1.0.0-beta.0)

Every change below is a hard cutover. No release keeps an old API, an alias, a deprecation period or a compatibility
flag. Upgrade with one sweeping codemod that applies every entry at once, then regenerate your migrations and
re-create your databases. Each entry gives the codemod's rule, before and after.

How to upgrade:

1. Run every codemod rule below over your code in one pass.
2. Typecheck. Every remaining error is a site the rules could not rewrite mechanically, and the error names what to
   write. The type system rejects every old form, so a clean typecheck means nothing old is left.
3. Delete your `migrations/` folders and re-create every database, then `grizzle generate`. snapshot.json and
   meta.json changed format, and the previous files are refused, never read.

### Breaking changes

#### A relation input of any number of rows travels as one array per column; `InputTooLarge` names its byte bound

- **A ChangeSet input and a relation parameter hold any number of rows.** The 100,000-row limit is gone, and so is the
  transport it stood for: an input traveled as one `jsonb_to_recordset` parameter, which PostgreSQL caps at 268,435,455
  bytes, or below 17 rows as a VALUES list rewritten into each execution's text. Now every input, an empty one and one
  of no column included, travels as its arrays, one text-format array literal per column read by `unnest` in one
  select list (one `generate_series` count for an input of no column), in every read, write, page and `db.explain`. A
  Stream member or parameter is collected whole before any SQL. No codemod.
- **The planner estimates an input as its length.** Each array is a constant of the execution's custom plan, so a
  join against an input plans for its true size where `jsonb_to_recordset` was always 100 rows; a statement of a
  compiled program the plan cache serves generically is estimated at 10 rows. No codemod.
- **`InputTooLarge` carries its `bound`.** It is raised only for a real transport bound, before anything is sent:
  `{ kind: "message", statement, bytes, limit }`, one statement's Bind message past PostgreSQL's longest message,
  1,073,741,822 bytes (`PQ_LARGE_MESSAGE_LIMIT`), which the server would answer by closing the connection; or
  `{ kind: "literal", input, column, limit }`, one column's array literal past JavaScript's longest string. Its stage is
  still `resource`. No codemod; a handler that matched `InputTooLarge` keeps matching and may read `error.bound`.

#### A value is only its value: `Decimal` has no display scale; float and money sums are exact (#3)

- **`Decimal` is value-only.** `1`, `1.0` and `1.00` are one `Decimal`, written `"1"`; every constructor, the decoder of
  query results included, yields that one form. `d.scale`, `d.identityText()`, `d.kind`, `d.negative` and
  `d.coefficient` are removed; `d.parts` (`{ kind: "finite", negative, coefficient, minScale }` or `{ kind: "nan" |
  "infinity" | "-infinity" }`) and `d.text` are new. `d.toString()` is the shortest exact text: a `pg.numeric(10, 2)`
  field delivers `12.5`, not `12.50`.
  - Codemod: `d.identityText()` → `d.toString()`; `d.scale` → `d.parts.minScale` after `d.isFinite()` (the least scale
    that writes the value; there is no display scale to read); `d.kind` → `d.parts.kind`; `d.negative` /
    `d.coefficient` → `d.parts.negative` / `d.parts.coefficient` after `d.isFinite()`.
  - Fix for display: print at the field's scale with
    `new Intl.NumberFormat(undefined, { minimumFractionDigits: s }).format(d.toString())`.
- **`Money.toDecimal()` returns the one form** (`"12.5"` for 1250 minor units); `Money.toString()` still writes two
  fixed digits (`"12.50"`). No codemod; a caller that printed `toDecimal().toString()` prints `toString()` instead.
- **`Compute.scale` and `Compute.trimScale` are removed.** Codemod: `Compute.scale(x)` → `Compute.minScale(x)`;
  `Compute.trimScale(x)` → `x`.
- **Quotients, powers, square roots and numeric means are computed from operand values.** `Compute.div`,
  `Compute.power` and `Compute.sqrt` over numeric, and `r.mean` over numeric, read each operand as if written without
  trailing zeros (the SQL passes it through `trim_scale`). Only results over operands stored with display scales beyond
  their significant digits change. No codemod.
- **`r.sum` over real, double precision and money, and `r.mean` over real and double precision, are exact.** A float
  sum is the double (real) nearest the exact total, ±Infinity past the largest finite value, a float mean that total
  over the count rounded once, a money sum the exact total as exact money; none depends on row order or plan, and none
  fails.
  Results change in the last digits where rounding used to accumulate. No codemod.
- **A closed-form slope over double-precision sums is no longer rewritten to `REGR_SLOPE`** (rewrite R32 is removed);
  it is computed as written, from exact sums. No codemod.
- **A float's zero is `0`.** No query delivers `-0`. No codemod.
- **`Compute.cosineDistance` is a declared exception, beside `.approximateNearest`.** It is pgvector's own float
  arithmetic: the same for the same vectors on every evaluation by one server, possibly different in the last place
  between pgvector builds or CPUs. Every other answer is a function of the facts alone. No codemod.
- **A vector field may be a key field.** A primary key or `key(...)` over a `pg.vector(n)` field is admitted where its
  B-tree entry fits: every vector has one form, its components finite and its zero `0`, so pgvector's equality is the
  key's identity, and `[-0,1]` and `[0,1]` are one key. A span key still refuses a vector field, which btree_gist has
  no operator class for (`UnrepresentableKey`, fault `gistOperatorClass`); the `vector` fault is removed. No codemod.
- **Format and state:** snapshot.json and meta.json fingerprints over decimal literals change (`~d:1.50` is refused;
  `~d:1.5` is the payload); CHECKs and expression indexes that divide, raise to a power or take a root gain
  `trim_scale(...)`, which the next `grizzle generate` redrafts; cursors over bare numeric order columns change their
  bytes (they are now a function of the value).

#### Rename candidates are a tree decided by path; meta.json records every drafted statement (#8)

- **meta.json's decisions are a complete decision record.** A drafted folder's meta.json held
  `decisions: { candidates, choices, confirms, losses }`, candidates numbered by allocation and each decided by a
  "witness" statement. It now holds `files: [{ name, steps }]`: every drafted statement of every file in its place,
  each step a `statement`, a `choice` (`keep`, `offers`, `follows`), a `loss` (`loses`, `statement`, `carriers`) or a
  `confirm` (`statements`); a candidate's own offer (`rename`, `relation rename`, a field's `nested rename` inside its
  relation's alternative) holds its `head` and its `alternative`'s steps, and every reference (`replace`, `delete`, a
  loss's `carriers`, a field's `requires`) is the candidate's path, such as
  `{ "kind": "relation", "removed": "\"s\".\"first\"", "added": "\"s\".\"third\"" }` or, nested,
  `{ "kind": "nested field", "parent": { … }, "removed": "\"value\"", "added": "\"amount\"" }`. No codemod: regenerate.
  A folder's old meta.json is refused as unreadable by `grizzle check` and `grizzle migrate`.
- **`grizzle generate` drafts rival relation renames that each rename a field.** Two removed relations that both pair
  with one added relation, each dropping a field the added one may be renamed from, failed with `internal error`; each
  rival's nested field rename is now decided only under its own relation's rename. No codemod.
- **`grizzle check` refuses a statement of a branch the review did not take, wherever it stands,** a statement inside a
  rename that is not chosen as an orphan, an untaken branch's statement or a chosen choice's kept statement as a
  split; a drafted statement no candidate decides, at the top of a file, stays yours to keep, delete or edit. A correct
  review of rival renames (one chosen, its field's drop written in) is no longer refused as an orphan of the other.
  Fix: write in only the statements of the branches you take.
- **Labels name both ends in full.** A field's candidate reads `the candidate rename of "s"."t"."a" to "s"."t"."b"`
  (was `… to "b"`), a nested field's `the candidate rename of "s"."first"."value" to "s"."third"."amount"` (was
  `"s"."third"."value" to "amount"`), and a nested field's note and its loss name the removed relation. No codemod;
  only comment lines change, never a drafted statement.
- **Format and state:** meta.json changes format (above); drafted SQL statements are unchanged.

#### Every name grizzle's SQL holds names its schema; `grizzle drift` gets stage `unchecked` (#4)

- **Generated SQL names every PostgreSQL type, function and carrier by its schema.** A builtin type prints as its SQL
  keyword (`integer`, `bigint`, `boolean`, `numeric(10, 2)`, `double precision`) or qualified (`"pg_catalog"."text"`,
  `"pg_catalog"."uuid"`, `"pg_catalog"."jsonb"`, `"pg_catalog"."money"`, the ranges, `"pg_catalog"."record"`); a
  builtin function as `"pg_catalog"."<name>"(...)`, `count(*)` as `"pg_catalog"."count"(*)`; a function's return type as
  `RETURNS "pg_catalog"."trigger"` / `"pg_catalog"."void"` / `boolean`; a relation in a regclass value as
  `'"<schema>"."<name>"'::"pg_catalog"."regclass"`; a write program's carrier as `"pg_temp"."__carrier_<d>_<k>"`.
  Before: `"id" uuid NOT NULL`, `count(*)`, `'shop.seq'::regclass`. After: `"id" "pg_catalog"."uuid" NOT NULL`,
  `"pg_catalog"."count"(*)`, `'"shop"."seq"'::"pg_catalog"."regclass"`. A relation may now be named `Text`, `Uuid`,
  `Money`, `Void` or `Trigger`, and a database, role or session search_path that lists grizzle's schemas first changes
  nothing.
  - Codemod for hand-written SQL in your migrations (custom migrations and tuned drafts): qualify every builtin type
    that is not a keyword, `::text` → `::"pg_catalog"."text"`, `::uuid` → `::"pg_catalog"."uuid"`, `::jsonb` →
    `::"pg_catalog"."jsonb"`, `::money` → `::"pg_catalog"."money"`, and every builtin function call `f(` →
    `"pg_catalog"."f"(`; a statement of yours runs under the session's search_path, where a relation of yours named
    `Text` is the type `text`, and the drift check judges what it built.
- **A drift check that reaches no verdict stops at the new stage `unchecked`**, not `drift`: the snapshot did not
  render, the ledger or the catalog could not be read, or the replay that builds the snapshot beside the schema was
  refused (reported as `the snapshot of <schema> could not be built beside it to compare (statement <n> of <m> of the
  replay): ...`). Its outcome line reads `Every folder applied; the drift check reached no verdict.` (migrate) or
  `Nothing was applied; the drift check reached no verdict.` (drift), and its fix `the check changed nothing: run
  grizzle drift again, and report it with this output if it is refused the same way`. Exit code 1, as before.
  - Codemod for scripts that read the report: match `refused at stage unchecked` where they matched a `stage drift`
    refusal whose message was `the catalog of <schema> could not be read` or `the snapshot's installation ... could not
    be rendered`.
- **Format and state:** snapshot.json changes: a function's `searchPath` key is gone (every function runs under
  `pg_catalog, pg_temp`), a relation a regclass value names is a `{ "kind": "regclass", "relation": ... }` node, and
  every fingerprint changes; a pre-cutover snapshot is refused at stage snapshot. Every drafted migration file changes
  text. Re-create every database installed before.

#### Every login pins its search_path, and `Db.open` refuses a login whose search_path is not the pin (#4)

- **A login's sessions run under `search_path = pg_catalog, pg_temp`.** The first migration stores
  `ALTER ROLE <login> SET search_path = "pg_catalog", "pg_temp"` beside the login's other defaults (`jit = off`,
  `extra_float_digits = 1`, the four locale categories at `C.UTF-8`). PostgreSQL applies a role's own default over the
  database's and the server's, so an `ALTER DATABASE ... SET search_path`, or a server's, no longer reaches a `Db`'s
  sessions. No codemod.
- **`Db.open` refuses a login whose search_path default is missing or another path**, as an `OpenError` at stage
  `settings` with the mismatch `role <login> default search_path`, expected `pg_catalog, pg_temp`; one set for the
  login in this database alone is refused as any such default is. The drift check after `grizzle migrate` refuses it
  the same way. Fix: re-create the database from your migrations.
- **Every session of a login's pool sends the pinned defaults as its startup options**, all but `lc_messages`, which
  no login may set itself and which stands by its role default: `-c search_path=pg_catalog,\ pg_temp -c jit=off -c
  extra_float_digits=1 -c lc_monetary=C.UTF-8 -c lc_numeric=C.UTF-8 -c lc_time=C.UTF-8`. Before, node-postgres sent the
  environment's `PGOPTIONS` instead, whose settings silently overrode the pins. After, pg never reads `PGOPTIONS` for a
  login's session. No codemod.
- **`DbLayer.make` refuses a process environment that sets `PGREPLICATION`**, which node-postgres would send at every
  login, making each session a replication connection: `OpenError` at stage `config`, reason
  `ConnectionEnvironmentRefused`, naming the variable and never its value. grizzle reads `process.env`, the source pg
  reads, never the ConfigProvider. Fix: unset `PGREPLICATION`.
- **`grizzle migrate` and `grizzle drift` refuse a process environment that sets `PGOPTIONS` or `PGREPLICATION`**, at
  stage `config` with the same reason. A migration session sets no options of its own and starts under its role's
  and its database's defaults, so pg would send either at its startup. Fix: unset both for the command.
- **No grizzle session reads `PGPASSWORD` or `~/.pgpass`.** Before, a password given as the empty text, `noPassword`
  for trust, peer or certificate logins, or an empty `Redacted`, fell back in node-postgres to `PGPASSWORD`, then to the
  password file. After, pg is always given a function that yields the configured password, and a server that asks for
  one refuses the empty one. A `grizzle migrate` URL without a password still takes `PGPASSWORD`'s, which grizzle reads
  itself. Fix: give every login its password in `DbConfig.password`.
- **A session's client encoding and TLS negotiation are grizzle's own**, so `PGCLIENT_ENCODING` and `PGSSLNEGOTIATION`
  no longer reach a session. `DbConfig` has no `options` setting, and refuses one as any unknown setting. No codemod.
- **Format and state:** snapshot.json changes: a login default's `action` holds its setting,
  `{ "kind": "set", "setting": { "parameter": "jit", "value": "off" } }`, and the search path's names no value, since
  the pin is the only one, `{ "kind": "set", "setting": { "parameter": "search_path" } }`. Every fingerprint changes,
  and a pre-cutover snapshot is refused at stage snapshot. Re-create every database installed before.

#### Every generated text is built once, a text past JavaScript's longest string is refused, and a large schema no longer crashes (#6)

- **No admitted schema crashes `generate`, `check` or `migrate` with `grizzle: internal error`.** A schema whose law
  function, drafted file or snapshot.json ran past about 120,000 lines (an alternatives law with about 240 armed
  handles) failed with `RangeError: Maximum call stack size exceeded`. Every text is now written once into one line
  sink, and grizzle passes no list as a call's argument list, so these schemas generate. No codemod.
- **A text past V8's longest string is `ResourceBound`.** One SQL statement, migration file, `snapshot.json`,
  `meta.json` or fingerprint text may hold at most 536,870,888 UTF-16 code units (2^29 − 24, about 512 MiB of ASCII).
  Before: `generate` and `check` crashed with `RangeError: Invalid string length` (an internal error). After: they
  refuse with `ResourceBound` whose `bound` is `{ kind: "stringLength", limit, needed }`.
  - Fix: a program that switches over `CompileBound["kind"]` exhaustively gains the case `"stringLength"`; its message
    is `a text of at most 536870888 UTF-16 code units, V8's longest string (needed <n>)`.
- **A commented alternative in a drafted file comments every line PostgreSQL reads as one.** A literal holding a
  carriage return inside a commented rename or loss alternative is now followed by `-- ` after the carriage return too,
  so no part of a commented alternative is live SQL. Uncomment it as before. No codemod.
- **Format and state:** snapshot.json changes: a PL/pgSQL `perform` node's `query` is `{ body, orderBy?, limit?,
  offset? }` (no `kind`, no `with`); a set operation is `{ kind: "setOp", op, arms: [...] }` (two arms at least) where it
  was nested `left`/`right` pairs; a join is one `{ kind: "joins", first, steps: [{ kind: "on" | "cross", source,
  on? }] }` where it was nested `join`/`crossJoin` pairs; and every fingerprint changes. A pre-cutover snapshot is
  refused. The printed SQL of these statements does not change.

#### A value nests to any depth, and a write program holds any number of carriers of one column-type class

- **A description, an IR value or a canonical text nests to any depth.** The canonical serializer (`encode`, `toJson`,
  `fromJson`, `decode`) and every description and IR decoder kept the containers they were inside on the call stack,
  and refused a value inside more than 512 of them with `ResourceBound` (`{ kind: "nesting", limit: 512 }`). Each now
  keeps them on a stack on the heap, so a value 100,000 containers deep decodes on a sixth of Node's stack, and the
  bound is gone. A value that holds itself is refused as cyclic wherever it meets itself, `MalformedDescription` (`an
  acyclic value`) at that path; `fromJson` refuses a cyclic in-memory value the same way, as `MalformedArtifact`,
  where it used to stop at the depth bound.
  - Fix: a program that switches over `CompileBound["kind"]` exhaustively drops the case `"nesting"`.
- **A write program holds any number of carriers.** A carrier was named `__carrier_<n>`, n a 36-bit digest of its
  column types times 65,536 plus its ordinal, so a program with more than 65,535 carriers of one column-type class was
  refused with `ResourceBound` (`{ kind: "carriers", limit: 65535 }`). A carrier is now named `__carrier_<d>_<k>`:
  d, the first 36 hex digits (144 bits) of SHA-256 over its column types, and k, its ordinal among the program's
  carriers of those types, which no count runs out of. Two column-type classes of one program whose digests agree are
  refused with `UnsupportedOperation` rather than given one name.
  - Fix: a program that switches over `CompileBound["kind"]` exhaustively drops the case `"carriers"`; a log filter or
    a query of `pg_stat_activity` that matched `__carrier_<n>` matches `__carrier_<d>_<k>`.

#### A residual law is one deferred trigger and one function per table and event, each checking only what its event can break (#5)

- **Installed objects.** Each residual law (an alternatives law's reverse obligation, a conditional mirrors, a
  selected-source containment or coverage, a residual capacity) installs one deferred constraint trigger per
  participating table and threatening event (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE OF …`), each executing a
  function of its own. Before, one function served the whole law, behind one `AFTER INSERT OR DELETE OR UPDATE OF …`
  trigger per table. Every law trigger's and law function's name changes; each is `__law_<stem>_<digest>`, hashed
  over the law, the table and the event.
  - Fix: code that names a law trigger (`SET CONSTRAINTS <trigger> IMMEDIATE` in a direct writer or a test) names
    every trigger of the law on that table, or writes `SET CONSTRAINTS ALL IMMEDIATE`. No codemod: the names are
    compiler-derived, and `grizzle generate`'s snapshot.json lists them.
- **A law trigger filters its rows.** Its `WHEN` holds its event's static test: the row's selection for a guarded
  image, and for an UPDATE a change of a field its `UPDATE OF` lists. An UPDATE that changes no such field, and a row
  outside the law's selection, queue no deferred event and call no function. No codemod.
- **A write re-checks only what it can break.** A payload table's write checks only its own handles' obligations,
  never the whole roster; an UPDATE checks what deleting OLD and inserting NEW would. Outcomes do not change: the same
  23000, constraint name and DETAIL, with its role-dependent visibility. Fewer reads mean fewer 40001s. No codemod.
- **A migration that changes what a law checks under one identity revalidates it.** Moving an arm relation to another
  handle, arming or unarming a handle, a roster change, a bound or a selection: the law's Validate file runs its
  violation query again. Before, such a change replaced the function in Publish unvalidated. Declaring or removing
  `mutable` adds or drops only the law's UPDATE triggers and functions, and no longer replaces the others. No codemod.
- **A discriminator value outside the roster raises `CASE_NOT_FOUND` (20000)** instead of passing. The enum type
  refuses such a value first, so no write reaches it. No codemod.
- **Format and state:** snapshot.json writes each installed statement compact on one line of its own (a changed
  statement is one changed line), lists one `lawFunction` and one `lawTrigger` object per unit, holds the new
  statement forms (PL/pgSQL `whenAbsent`, a `case` without `else`, a constraint trigger's `event` and `when`), and
  digests each residual law's whole record; a previous snapshot.json is refused, never read. Every database installed
  before is re-created.

#### `alternatives` refuses a stray arm key and the parent as its own arm, in the types first; a shared arm relation accepts each handle's payloads (#5)

- **An arm map is keyed by handles of its roster alone, as a type error.** Before, an arm map that mixed a roster
  handle with another key (`{ Manual: ManualTask, Bogus: ManualTask }`) typechecked and was refused only when the
  statement was built (MalformedDescription, "arms keyed by Kind's handles; Bogus is not one"). It is now refused by
  the type, `Refusal<"an arm is keyed by a handle of its roster">`; the runtime refusal stays for JavaScript callers
  and for a roster whose handles are no literals.
  - Fix: drop the stray key, or add its handle to the roster. No codemod.
- **No arm is the parent itself.** Before, `alternatives(Task, "kind", Kind, { Manual: Task })` was admitted, though an
  arm is keyed by a key of its relation, so every task had to stand at `Manual` and every other handle was dead. It is
  now refused by the type, `Refusal<"an arm is a relation other than its parent">`, wherever the relation's name is a
  literal, and with MalformedDescription when the statement is built and when a description declares it.
  - Fix: declare the arm as a relation of its own, keyed like the parent. No codemod.
- **A relation that is the arm of several handles accepts each one's payloads.** Before, each handle installed its
  own constant tag and tagged foreign key on the arm, so a relation shared by two handles (`{ Manual: Task1,
  Scheduled: Task1 }`) carried two foreign keys no row meets, and no row could ever be written to it. A shared arm's
  rows now belong to a parent of any handle it is the arm of. The containment fact the query layer reads carries the
  handle only where the arm serves one. An arm relation keyed differently at two of its handles is refused
  (MalformedDescription).
- **An arm's foreign key is the law `alternativesArm`**, `{ kind: "alternativesArm", relation, field, arm, handles }`,
  one per arm relation, no longer a `mirrors` half from the arm into the parent. The reverse obligation stays
  `alternatives`.
  - Codemod: a program that switches over `Law["kind"]` exhaustively gains `"alternativesArm"`, and a match on an
    arm's `mirrors` half into its parent becomes a match on `alternativesArm` by `arm`.
  - Installed objects change only for a parent with an arm relation of several handles. It gets a STORED arm tag
    column, mapping each kind to its arm relation, and UNIQUE (key, arm tag), and that relation gets one tagged
    foreign key into it. An unshared parent installs exactly as before. Re-create every database.

#### A uuid is the uuid language, a refined text's identity is text, and a parameter carries its type (#7)

- **A uuid field's values are `Uuid`.** `uuid` is `Field<Uuid, "uuid">`, where `Uuid` is ArkRegex's inference of
  uuid_out's spelling, `${string}-${string}-${string}-${string}-${string}`, exported beside `uuid`. Every fact, head row,
  key value, parameter, binding and comparison operand of a uuid field is a `Uuid`. A uuid literal and
  `crypto.randomUUID()` typecheck as they are. A plain `string`, or a text without four hyphens, is a type error at a
  uuid position. Before: `{ readonly id: string }`. After: `{ readonly id: Uuid }`.
  - Codemod: a `string`-typed value written to a uuid position (a fact, a `db.execute`/`get`/`page` argument, a binding,
    a comparison operand) is parsed once at the boundary: `const id = Uuid.parse(text)`, which returns
    `Result<Uuid, ValueFault>` (`id.ok ? id.value : id.error`, error `"uuidSyntax"`). A function that builds an id types
    its result `Uuid` and returns a template, ``(n: number): Uuid => `00000000-0000-4000-8000-${hex12(n)}` ``.
    Type annotations of uuid values `string` → `Uuid` (`import { Uuid } from "@bjornpagen/grizzle"`). Type pins:
    `Field<string, "uuid">` → `Field<Uuid, "uuid">`, `Term<string, P, O, "uuid">` → `Term<Uuid, P, O, "uuid">`,
    `Carrier<string, "uuid">` → `Carrier<Uuid, "uuid">`.
- **A refined text's identity is text; its values are its pattern's language.** `str.regex(source)` is
  `Field<Host, "text", string>`, its host type `Host` (the pattern's inference, unchanged) its values and its language,
  and `string` its domain. A term of one pattern now meets a text column or term of any other pattern (a join, a
  comparison, a binding, a union's arms, mirrors and contained sides), as PostgreSQL compares texts and the checker
  admits. A JavaScript value at the column, opposite one of its terms, for one of its parameters or in a fact is still
  one of the pattern's language. Before: `Field<"yes" | "no", "text">`, `v(R, "r").answer: Term<"yes" | "no", …, "text">`.
  After: `Field<"yes" | "no", "text", string>`, `v(R, "r").answer: Term<string, …, "text", "yes" | "no">`.
  - Codemod: type pins only. `Field<H, "text">` for a `str.regex` field → `Field<H, "text", string>`, and
    `Term<H, P, O, "text">` → `Term<string, P, O, "text", H>`. A refused join or comparison between two patterns now
    typechecks; delete its `@ts-expect-error`.
- **A term's type has a language component.** `Term<T, P, O, Sql, V, F, L>`, `Carrier<A, Sql, D, F, L>`,
  `Scalar<T, P, O, Sql, L>` and `Operand<T, Sql, L>` gain `L`, the values of the term's type that a JavaScript value
  opposite it may be (`LanguageOf<X>`). It defaults to V, so code that writes these types positionally changes only
  where it pins a refined text or a roster constant. A comparison's, `inSet`'s, `Compute.in`'s and `Compute.literal`'s
  JavaScript values are of the met term's or descriptor's language, and `Compute.cast(x, F)` is a term of F's domain
  whose values are F's host type (before: of F's host type). Codemod: none; a pin of a cast into a refined text,
  `Term<H, P, O, "text">` → `Term<string, P, O, "text", H>`.
- **A parameter map entry is the parameter's type.** `ParamsOf<Q>` maps each scalar parameter to
  `ParamType<Domain, Sql, Language>` (exported from the query barrel), the descriptor `r.param` took. Before:
  `ParamsOf<typeof q>` was `{ readonly account: string }`. After: `{ readonly account: ParamType<Uuid, "uuid"> }`. The
  argument a caller passes is `ParamArg<ParamsOf<Q>>` (also exported), each scalar parameter's value of its language. A
  relation parameter's entry is unchanged, its facts; a named `take("batch")` contributes
  `{ readonly batch: ParamType<number, "integer"> }`. `Q.bind` takes a term for a scalar parameter only when the term
  meets the parameter's domain and SQL type: a text term never binds a uuid parameter. It takes a JavaScript value only
  when the value is of the parameter's language.
  - Codemod: `const p: ParamsOf<typeof q> = { … }` → `const p: ParamArg<ParamsOf<typeof q>> = { … }`. A pin
    `{ readonly k: X }` of a scalar parameter declared `r.param("k", F)` → `{ readonly k: ParamType<DomainOf<F>,
    SqlOf<F>, Infer<F>> }`, written out, e.g. `ParamType<Uuid, "uuid">`, `ParamType<string, "text", "yes" | "no">`,
    `ParamType<bigint & Brand<"Cents">, "bigint">`.

#### A union's arms and a matched query's constants mean one thing to the types and the engine (#7)

- **A constant that no arm of the matched source delivers is refused.** A match or an `r.not` over a query, a union, a
  bound import or an interior binds a field to a JavaScript value or a typed constant. If no arm of the source can
  deliver all the bound constants, the program is refused. An arm can deliver a constant when its head holds that
  constant at the field, or when it delivers the field by a term whose type has the value. This is a filter no fact
  meets, so a match was always empty and a negation always true. Before: `r.match(tones, { tone: "high" })`, where
  `tones`'s arms find `tone: Tone.handle("low")` and `tone: Tone.handle("mid")`, compiled and read no row. After: a
  type error, `Refusal<"no arm of the source delivers the bound constants">`, and `MalformedDescription` ("no arm of the
  source delivers the bound constants (tone)") from the compiler. The types judge every constant whose value they
  carry: a primitive JavaScript value or a handle. A `Decimal`, a `Money`, a `Compute.literal`, a value of a
  non-literal type, or a head parameter that `Q.bind` binds to a literal is refused by the compiler alone.
  - Fix: delete the dead match together with the rule it empties, or delete the dead `r.not`. Otherwise bind a value
    some arm delivers.
- **A matched union narrows by every constant it is bound to, and so does a negated one.** Before, a match selected
  the arms of a union of several headings only by constants bound to its discriminant. `r.match(u, { e: 2, f })`
  refused `f`, a field only the arm with `e: 2` delivers, unless `e` was the discriminant. An `r.not` never narrowed. A
  negated union refused every field some arm lacks. After: the constants bound to any field common to the arms select
  the arms that deliver them, for a match and a negation alike. The match may then bind the fields those arms share.
  A constant is matched against the type its arm delivers it at, before the union widened the arm, so a refined text's
  arm never delivers a value outside its pattern. Programs the compiler refused now compile, as the types already
  admitted them.
  - Fix: none needed.
- **A bare head value is typed by every arm of its union, across headings.** Before, a JavaScript value in a head took
  the type of the terms delivering its field only within arms of the same heading. Beside an arm of another heading it
  kept its JavaScript default. So `find({ id, kind: Tone.handle("low"), x })` in one arm and
  `find({ id, kind: "mid", y })` in another was `MissingDiscriminant` (text never meets an enum), and a bare `1` beside
  a bigint column of another heading left the column out of the union's heading. After: a value that is one of the
  type the union's typed arms agree on takes that type, as the types always read it. So that union is discriminated
  by `kind`, and the column is common at bigint. A union's heading can gain such a column, which changes its SQL and
  a derived relation's view over it.
  - Fix: none for a program. Regenerate migrations for a derived relation defined by such a union.
- **Arms of different headings deliver every field they share at one type.** Before, the compiler admitted
  `find({ id, d: "a", x: t })` beside `find({ id, d: "b", x: n, y: n })`, with `t` a text and `n` an integer. It left
  `x` out of the union's heading, so no match, order or attachment could read `x`. The types already refused it.
  After: `MalformedDescription` ("arms of one query with one type per column they share; x is text and integer"),
  as for arms of one heading, and the type error is `Refusal<"a union's arms deliver each field at one type">`.
  - Fix: rename the field in one arm, or cast it to the other arm's type with `Compute.cast`.
- **The types judge a union over all its arms, as the compiler does.** `Query` and `Ordered` gain an eighth type
  parameter, `Arms`, the carriers of each arm in order; the readers infer it. After a take, an approximate search or an
  attachment over a union it is one arm with no head constant. Three or more arms told apart only by a combination of
  fields (`d: "a", e: 1`; `d: "a", e: 2`; `d: "b", e: 1`) now typecheck. Two arms of one heading that hold the same
  constants still typecheck, since only arms of different headings need telling apart. Constants whose value the
  types do not carry count as different. The check sits on the arm the callback returns. A block-bodied
  arm is still refused with TS2345 at `.rule(`. An expression-bodied arm is refused with TS2322 at its body.
  - Codemod: a type pin `Query<S, H, Ev, P, IH, Hc, Cx>` of a union query → `typeof q`, or add its arms:
    `Query<S, H, Ev, P, IH, Hc, Cx, readonly [UnionArm<Hc1, never, "rule", false>, UnionArm<Hc2, never, "rule", false>]>`
    (each arm's carriers, the attachments it carries, the stage that made it and whether a take bounds it; see the
    entry on attached arms below). Delete a `@ts-expect-error` on a union arm that now typechecks.

#### Every scope is named: `v(R, "name")`, and a self-join's two scopes are two types

- **`v` takes the scope's name.** `v(source, name)` mints one variable per field of the source in the scope `name`, a
  string literal: a declared name (ASCII letters, digits and underscores, a letter first). The name is part of each
  variable's origin, `Origin<Relation, Field, Name>`, so two scopes of one relation in a rule are two types. A
  self-join's keys, `db.get` and evidence are now typed as any join's: before, a rule that matched a relation twice
  proved no key through its variables, and `db.get` of a self-join was refused even where the engine proved one row.
  `v(R)` with one argument is gone: no default name, no overload, no alias. The JavaScript view is
  `varsOver(source, name)`.
  - Before: `const { id, title } = v(Post)`; a self-join `const a = v(Post); const b = v(Post)`.
  - After: `const { id, title } = v(Post, "post")`; `const post = v(Post, "post"); const twin = v(Post, "twin")`.
- **A rule holds one scope of each name.** Two calls to `v` with one name in one rule are refused when the rule is
  built (at `.find`): `CompileError` `DuplicateIdentity`, duplicate kind `"scope"`, at the second call, with the first
  call's location as `earlier`. The types cannot refuse it: two calls with one name have one type.
- **The one-variable-per-field rule (R1) is deleted.** A second scope of a relation the rule matches once, bound at
  another relation's field, used to be `MalformedDescription` ("mint it where it is bound"). It now compiles, as a
  variable of its own scope.
- **A Description spells each variable `<scope>.<field>`** (`post.id`), and diagnostics name variables that way. The
  user's name never reaches SQL: aliases stay compiler-derived. Type pins change: `Origin<"Task", "id">` →
  `Origin<"Task", "id", "task">`, `VarsOf<R>` → `VarsOf<R, N>`, and `typeof v<typeof Task>` →
  `typeof v<typeof Task, "task">`.
- **Codemod.** Rewrite every call `v(R)`, and `varsOver(R)`, to `v(R, "<name>")`, grouping the calls by their nearest
  enclosing function, the rule callback that holds them; R is a scope's source, compared by its source text.
  - **One scope of R in its rule:** the name is R's identifier in lower camel case: the last property for a member
    expression (`Blog.relations.Post` → `"post"`), a leading acronym lowercased (`URLQueue` → `"urlQueue"`, `U4` →
    `"u4"`). A delta source `d.added(R)` or `d.removed(R)` is `"addedR"` or `"removedR"` (`"removedComment"`). Any other
    source expression is named by hand.
  - **Two or more scopes of R in one rule:** derive each name from what the call is bound to, so the names say each
    scope's role, never a number (`r1`, `r2`):
    - `const x = v(R)`: the name is `x`. Where `x` is one or two letters (`a`, `b`, `t`), name the role by hand:
      `first`/`second`, `earlier`, `lower`, `floor`/`ceil`.
    - `const { f, g } = v(R)`, every field unrenamed: R's lower camel case.
    - `const { f: alias, … } = v(R)`: the alias without its field's name as a suffix (`{ id: parentId }` →
      `"parent"`), or the alias itself (`{ id: start }` → `"start"`); the most frequent wins.
    - By hand: two scopes destructured only to pick fields one match binds (`const { id } = v(A)`,
      `const { value } = v(A)`, then `r.match(A, { id, value })`) merge into one call,
      `const { id, value } = v(A, "a")`.
    - Names that collide within a rule, and calls in any other position (an argument, `v(R).id`), are named by hand.
  - **Strings and comments:** generated source in template literals and code in comments or docs, by hand, with the
    same rules.
  - **Typecheck after.** Every remaining error names its site: a missed `v(R)` is TS2554 ("Expected 2 arguments"), and
    a name typed `string` is `Refusal<"one literal name">`. Then run the tests: a name a rule holds twice, such as a
    helper's scope beside the rule's own of one name, is `DuplicateIdentity`, which names both calls.
- **Upgrade with one sweeping hard cutover.** Apply the codemod to the whole code base at once, typecheck to zero, and
  keep no compatibility layer: no wrapper that defaults a name, no one-argument shim.

#### An attachment over a self-join is proved per scope, and a scope's name is a declared name in its type

- **Each scope of a self-join parent proves what its own fact proves.** Before, a parent that matched a relation twice
  kept no origin for any head field, so no attachment over it was the one child or an alternatives arm: `"one"` and
  `arm(field, handle)` were refused even where the engine proved them. Now each scope keeps the origins of its head
  fields, the fields of its one fact. A declared `contained` from one scope's fields proves the one child, a reflexive
  count over one scope's fields is the bare row, and `arm(field, handle)` reads the discriminator of the scope the
  arm's key is bound to. A proof never joins a field of one scope with a field of the other: a key bound to one scope's
  account and the other's label is an Option. A scope whose head fields no one match binds together, each the field
  of another fact, keeps no origin. `EvidenceOfQuery<Q>["origins"]` of a self-join now holds each scope's fields.
  - Before: over `pairs`, a TaskLabel self-join finding `{ account: first.account, label: first.label, … }`,
    `pairs.attach("color", (p) => query(S).rule(…match(Label, { account: p.account, label: p.label, color })…), "one")`
    was `Refusal<"the one child needs a child the evidence proves exactly one per parent">`. After: it typechecks, as
    the engine proves it. An `arm` keyed by the second scope's id names the second scope's kind field.
  - Fix: none for a program. A type pin of a self-join's `origins` as `{}` → each scope's `Origin<R, F, N>`; a delivery
    stated `"option"` that now proves `"one"` may be restated.
- **A scope's name is a declared name in its type.** Before, `v(source, name)` took any one literal, and the builder
  refused a name outside the declared-name rule when the rule ran. Now the type states the rule: ASCII letters, digits
  and underscores, a letter first. `v(Task, "2task")`, `v(Task, "_task")`, `v(Task, "task-peer")` and
  `v(Task, "tâche")` are type errors, `Refusal<"a declared name: ASCII letters, digits and underscores, a letter
  first">`; a JavaScript caller's is `MalformedDescription`, as before. A scope's name names variables, never a
  PostgreSQL identifier, so it no longer keeps the 63-byte limit on its conversion that a relation's or field's name
  keeps.
  - Fix: rename the scope by the codemod of `v`'s entry above.

#### An attached arm shares its heading with no other arm, under every stage that keeps it, in the types first

- **A union of an attached arm and another arm of its heading is a type error.** The compiler refuses a union in which
  several arms share a heading and one of them is attached (`UnsupportedOperation`, "attachment on an arm of a union
  whose heading several arms share"): a fact both arms deliver would carry one arm's attachment and not the other's.
  The types admitted it. Now it is `Refusal<"an attachment on an arm of a union whose heading several arms share">` at
  the arm that joins, whether the attached arm comes first or joins, and whether it is a `Finished.attach` or the
  query a `Query.attach` closes. An attached arm whose heading no other arm has still joins, told apart by its
  constants.
  - Before: `query(S).rule((r) => r.match(Task, { id, kind: "Automatic" }).find({ id }).attach("note", …, "option"))`
    `.rule((r) => r.match(Task, { id, kind: "Manual" }).find({ id }))` typechecked, and its compile was refused.
    After: a type error at the second `.rule(`.
  - Fix: attach over the whole union, `query(S).rule(…).rule(…).attach(…)`, or give the attached arm a heading of
    its own with a constant that tells it apart.
- **An arm is attached under every stage that keeps its records.** The compiler read an arm as attached only when the
  arm was the attachment itself. A take over an attached query, `q.orderBy(…).take(k).rule(…)` with the joining arm of
  `q`'s heading, passed the union's check, and the lowering refused it later ("attachments on the arm … of a union of
  several arms"). Now the compiler reads an arm's attachments off its rows, through a take, a name and an order alike,
  so the union's check refuses it by name, and so do the types. The same reading refuses two more programs: a union
  that widens a column of an attached arm under a take, whose widening projection dropped the attachment from the
  arm's records; and, from a Description, an attachment over a union named like one an arm of it carries ("one
  attachment per name"), which the builder and the types already refused.
  - Before: `q.orderBy(["id", "asc"]).take(5).rule((r) => r.match(Task, { id, kind: "Manual" }).find({ id }))`, with `q`
    the attached query above, typechecked, and its compile was refused by the lowering. After: a type error at
    `.rule(`, and the compiler's refusal is the union's.
  - Fix: as above. Attach over the whole union, or give the attached arm a heading of its own.
- **`Arms` records what each arm is to the compiler.** `Query` and `Ordered`'s eighth type parameter is each arm's
  `UnionArm<Carriers, Attached, Stage, Bounded>`: its carriers; `Attached`, the names of the attachments its records
  carry, `never` for an arm that attaches nothing, read off the records, the fields an attachment adds beside its
  carriers, so a take, an approximate search, a name and an order keep it; `Stage`, the `ArmStage` that made it
  (`"rule"`, `"union"`, `"take"`, `"attach"`, `"approximate"`, `"recursive"`); and `Bounded`, whether a take bounds its
  rows.
  - Codemod: a pin `Query<…, readonly [Hc1, Hc2]>` →
    `Query<…, readonly [UnionArm<Hc1, never, "rule", false>, UnionArm<Hc2, never, "rule", false>]>`, or `typeof q`.

#### Every combinator over a query reads the columns it delivers, in the types first

- **Order keys, parent variables and an arm over a union are the columns every arm delivers.** A union of several
  headings delivers, as a relation, the columns its arms share, which is the heading every stage over it reads; only a
  query's result delivers each heading group whole. The types now compute that heading in one place,
  `DeliveredKeys<Head, Hc>` and `DeliveredHeading<Head, Hc>`, and every combinator reads it: `orderBy`'s keys, the parent
  variables an attachment mints, and the one arm a take, an attachment or an approximate search makes. `CommonKeys` is
  gone.
  - Before: `q.orderBy(["note", "asc"])`, with `note` an attachment of `q`, typechecked and the builder refused it
    ("fields of the result heading"); over a union of two headings, `u.attach("n", (p) => …p.own…, "array")` with `own`
    a field of one arm typechecked and the compiler refused it ("a parent variable of the parent's heading"). After:
    both are type errors (TS2322 at the key, TS2339 at `p.own`).
  - Codemod: `CommonKeys<HeadOf<typeof q>>` → `DeliveredKeys<HeadOf<typeof q>, (typeof q)["heading"]>`.
  - Fix: order by a column every arm delivers, and read in an attachment only the parent's delivered columns.
- **A take or an attachment over a union of several headings is no arm of a further union.** Such a stage has the
  columns its heading groups share for its heading, so as an arm it delivered those alone while its records' type
  promised each group's own columns. The compiler refuses it (`UnsupportedOperation`, "an arm over a union of several
  headings: only a query's result delivers each heading group, and an arm would deliver the columns they share
  alone"), and the types refuse it at the joining arm,
  `Refusal<"an arm over a union of several headings: only a query's result delivers each heading group">`.
  - Before: `u.orderBy(["id", "asc"]).take(5).rule(…)`, `u` a union of two headings and the new arm of their shared
    columns, compiled and delivered the five without their own columns. After: refused.
  - Fix: add the arm to the union before the take, `u.rule(…).orderBy(…).take(5)`, or deliver the bounded union as a
    query of its own.
- **A union of several headings is bounded once.** The compiler refuses a second take over a union of several
  headings that a take bounds already, and a page over one, since each heading group is a statement of its own. The
  types now refuse both: `Refusal<"one take over a union of several headings: each heading group is a statement of
  its own, which one take bounds and the merge across them keeps">` at the take's bound, and `Refusal<"a page over a
  bounded heterogeneous union: a group statement cannot tell which of its rows are among the union's first k">` at
  `db.page` and a compiled program's `page`.
  - Before: `u.orderBy(…).take(5).orderBy(…).take(3)` and `db.page(u.orderBy(…).take(5).orderBy(…), …)` typechecked,
    and the compiler refused them when the program compiled. After: type errors.
  - Fix: take once, over the whole union; page the union unbounded.
- **`approximateNearest` is one rule's projection in the types too.** The compiler refuses a search over anything
  else; the types now name the same source: `Refusal<"approximateNearest over one rule's projection; this source is
  …">` with "a union of rules, which no single index orders", "a bounded subset, whose own order already selects among
  the rows", "a query with attachments", "another approximate search" or "a recursive relation".
  - Before: `q.attach(…).approximateNearest({ by: "distance", take: 10 })` typechecked and its compile was refused.
    After: a type error at the spec.
  - Fix: search the rule first, then attach, take or union the search's result.
- **An approximate search over a rule whose head holds a literal runs.** The optimized lowering ordered ties after the
  distance by heading columns that could include a head literal, and PostgreSQL refuses a literal ORDER BY item
  ("non-integer constant in ORDER BY"). A column the projection holds constant settles no tie and is now no order item.
  - Before: `find({ id, kind: "doc", distance: Compute.cosineDistance(…) })` searched with `approximateNearest` failed
    when PostgreSQL ran it. After: it runs.
  - Fix: none needed.

#### A JavaScript value where a first operand belongs is refused by name

- **Every first operand refuses a JavaScript value with one named refusal.** A first operand is a term: a comparison's
  (`r.eq`, `Compute.eq` and the rest, `between`, `inSet`, `in`, `allen`, `pointIn`), a Compute operation's, a
  conditional's first branch, a guard's subject, an aggregate's and a span producer's. Before, a JavaScript value
  there failed the term's shape: `r.eq(Decimal.of("1.5"), x)` and `Compute.cond(p, Money.of(150n), x)` raised TS2739
  ("missing the following properties … expr, column, sql"), and `r.eq(1, x)` or `Compute.add(1n, x)` a bare TS2345.
  Now each is TS2345, `Refusal<"a term first: a literal takes its place opposite a term, never first">`, the refusal
  a parameter in that place already raised.
  - Fix: write the term first, `r.eq(x, 1)`, or type the value, `Compute.literal(pg.numeric, "1.5")`.
  - Codemod: a `@ts-expect-error` naming the old diagnostic of a JavaScript value first →
    `// @ts-expect-error -- TS2345 refusal: a term first: a literal takes its place opposite a term, never first`.
    Explicit type arguments of these signatures gain one for the first operand, before the old ones (after the
    predicate's in `Compute.cond`).

#### A schema holds each relation under its own name, and a schema or role of thousands typechecks

- **`schema(name, relations, statements)` and `schema.extend(base, relations, statements)` hold each relation under
  its own name**, as a role's whole entries already did. `schema("Work", { Tasks: Task }, [])` is a type error,
  TS2322 `Refusal<"a schema holds each relation under its own name">`, and `MalformedDescription` ("a relation under
  its own name; Tasks holds the relation Task") from the builder where the types do not see it (a record typed
  `Record<string, …>`). The record is the level's index by name, so one level cannot declare a name twice: the same
  relation under two keys is no longer taken as one declaration.
  - Codemod: an entry `key: R` whose key is not R's name → `Name: R`, shorthand where the binding has that name; a
    record built at run time is keyed by `r.name`. A generic helper that rebuilds a schema from its record carries the
    proof, `Schema<N, R, St> & { readonly relations: UnderOwnNames<R> }`; `UnderOwnNames` is exported from the schema
    barrel.
- **A schema of thousands of statements and a role of thousands of entries typecheck.** A lookup by relation name went
  through an index remapped with `as`, whose keys TypeScript recomputes at every `keyof`, one instantiation per key,
  so `schema(...)` failed with TS2589 once its statements named 699 relations, and `role(...)` at a few hundred
  entries. Now "R is one of the level's relations" is one membership test in the union of the record's values, which
  the checker builds once per record, and candidate keys are indexed by their own domain; instantiations grow
  linearly. The type test `schema/budget` checks one schema of 2,000 relations and about 2,500 statements, a full role
  and a role through `Pick`. No codemod: delete any workaround, such as statements typed `ReadonlyArray<Statement>`
  to skip the check, or a role record written out as a literal.
- **Format and state:** none. snapshot.json and meta.json do not change, and no installed object changes.

#### A `str.regex` pattern is bounded by PostgreSQL's regex compile space alone, never by its length or nesting

- **The budget of 512 regex constructs is removed.** A pattern of any length and nesting depth parses, a group nested
  100,000 deep included, and compilation refuses one with `ResourceBound` only past grizzle's measures of PostgreSQL's
  regex compile space (`REG_MAX_COMPILE_SPACE`): 4,096 positions once counted repetitions are written out, 65,536
  pairs of positions joined by empty paths, 8 anchors, and 8,192 for anchors times positions. A pattern the budget
  refused may now be admitted, such as RFC 3986's URI-reference grammar written as one pattern.
- **`CompileBound` loses `regexConstructs`, and `regexCompileSpace.measure` is structured.** `measure` was a sentence;
  it is now a `RegexSpaceMeasure`, exported: `{ kind: "positions" | "anchors", limit, needed }`,
  `{ kind: "anchorWeight", limit, anchors, positions }`, `{ kind: "closurePairs", limit }` or `{ kind: "anchorLoop" }`.
  The error's message states the measure and names PostgreSQL's limit.
  - Codemod: a branch on `bound.kind === "regexConstructs"` → delete it; a read of `bound.measure` as text → a switch
    on `bound.measure.kind`, or the error's message.
- **Format and state:** none. A pattern the budget admitted keeps its CHECK, its canonical key and its digest, so
  snapshot.json and meta.json do not change, and no installed object changes.

#### The unit relation is a relation input: every insert of serial columns alone compiles; a relation parameter has a field (#2)

- **An insert whose every carried column is serial compiles and inserts.** Before, an insert through a writable query
  entry whose head holds only serial columns was refused before any SQL, as an array or a Stream, with its serial
  values (`[{ no: 1n }]`) or without them (`[{}]`): `MalformedDescription` ("a relation parameter or a row with at
  least one field"). A described insertion whose rows carry no column, into such an entry or into a table whose every
  column is an identity, was refused with `UnsupportedOperation` ("as an array or a Stream of empty facts"). All of
  them now compile. A row that leaves out every serial column is a new row, and equal such rows are one new row, so
  `[{}, {}]` and a query of several rows of no column each insert one row. No codemod: delete any workaround, such as
  a column added to the entry's head only to carry a value.
- **`r.relation(name, {})` is refused.** A relation parameter is a list of rows, matched like a table, so its heading
  has at least one field. Before, the program built and its compile was refused. After: a type error at the call,
  `Refusal<"a relation parameter has at least one field, as a relation does">`, and `MalformedDescription` ("a heading
  of at least one field") from the builder when the types are bypassed; a Description whose relation parameter has a
  heading of no field is refused where it is decoded. Fix: give the parameter its fields, or delete it and the match
  that reads it. No codemod.
- **A generated insert into a table whose every column is an identity reads its input.** It was a statement of its
  own, `INSERT … ("no") OVERRIDING USER VALUE SELECT 0::bigint`, tied to the facts only by a skip at run time. It is
  now the same `INSERT … SELECT FROM` its input as every other insert, of no column (`INSERT INTO t AS r SELECT FROM
  …`). Its outcome is unchanged. No codemod.
- **Format and state:** none. snapshot.json and meta.json do not change, and no installed object changes; only the
  statements a write program sends do.

#### Membership in an empty list is false (#2)

- **`r.inSet(x, [])` and `Compute.in(x, [])` build a predicate that is false.** So do a row check's and a contract's
  `.in([])` and a Compute term's `.in([])`: a membership in no value holds of no row, and `r.not` of a rule that
  filters by one holds of every row, by the ordinary rules. Before, each was refused when the program was built, with
  `MalformedDescription` ("a nonempty finite list of literals"), though the types took `[]`; the types are unchanged
  and now say exactly what is admitted. A Description whose `in` holds no value is decoded, not refused. No codemod:
  delete any guard you wrote around an empty list, such as `ids.length === 0 ? … : r.inSet(x, ids)`.
- **Format and state:** none. A row check or a contract whose predicate is `.in([])` admits no row, as its CHECK
  says.

#### An empty conjunction is true and an empty disjunction is false (#2)

- **`r.and()` and `Compute.and()` build the constant `true`; `r.or()` and `Compute.or()` build the constant `false`.**
  So do a row check's `and()` and `or()`: a conjunction of no predicate holds of every row, a disjunction of none of no
  row, and either of one predicate is that predicate. Before, each empty one was refused when the program was built,
  with `MalformedDescription` ("at least one predicate"), though the types took no argument; the types are unchanged
  and now say exactly what is admitted. A Description whose `and` or `or` holds no operand decodes to `true` or
  `false`, not refused. No codemod: delete any guard you wrote for the empty case, such as
  `filters.length === 0 ? … : r.and(...)`.
- **Format and state:** a query, row check or contract that wrote `and` or `or` of one predicate now holds that
  predicate itself in its Description, so a fingerprint over that Description changes once; none otherwise.

#### A stage a statement reads more than once is computed once, and the `nodes` budget is removed

- **No query is refused for its number of attachments or for the stages it shares.** The conservative artifact computed
  a stage again at every place its statement read it, so its size grew with the number of paths through the query,
  and a budget of 10,000 lowered nodes refused large queries: one attaching about 90 relations was refused with
  `ResourceBound`. Now a stage a statement reads more than once is one `MATERIALIZED` CTE, of the statement, or of the
  LATERAL subquery or EXISTS whose outer row it reads, so a statement grows with its query, and a query attaching 200
  relations compiles. No codemod.
- **`ResourceBound` has no `budget` bound.** `nodes` was the last compiler budget, so no compilation is metered and a
  `ResourceBound`'s bound is never `{ kind: "budget" }`.
  - Fix: a program that switches over the `kind` of a `ResourceBound`'s bound drops the case `"budget"`.
- **Format and state:** a drafted law validation (`<n>-validate.sql`, and its statement in meta.json) reads a stage
  its violation query reads more than once from one `MATERIALIZED` CTE. snapshot.json and every fingerprint are
  unchanged, so a folder drafted before keeps passing `grizzle check`.

#### `AcquisitionBudgetExceeded.saturated` is removed

- **The `saturated` getter of `AcquisitionBudgetExceeded` is removed.** It was derived from the error's own fields.
  - Codemod: `e.saturated` → `e.leased === e.max`.

#### No read raises an evaluation error: integer and money arithmetic is exact, floats are IEEE 754, partial operations are guarded (#9)

- **Integer arithmetic is exact and delivers `bigint`.** `Compute.add`, `sub`, `mul`, `neg`, `abs`, `div`, `gcd` and
  `lcm` over `smallint`, `integer` and `bigint` yield an *exact integer*: SQL `numeric` at scale 0 (`bigint` while its
  digit bound is at most 18 digits), host `bigint`, which never overflows. `Compute.div` over integers truncates.
  `Compute.width` of a span is an exact integer too. `Compute.mod` keeps its operands' type: a remainder is smaller in
  magnitude than its divisor and never overflows.
  Before: `Compute.add(a.qty, b.qty)` was `Term<number, …, "integer">` and raised 22003 past 2^31 − 1. After: it is
  `Term<bigint, …, "exact integer">`. A JavaScript literal opposite an exact integer is a `bigint`.
  - Codemod: a head or comparison literal opposite integer arithmetic, `0` → `0n`; a host read of such a column,
    `row.total: number` → `row.total: bigint`. To store an exact integer into an integer field, narrow it:
    `Compute.cast(x, pg.integer)` under a guard that proves it fits,
    `Compute.when(Compute.within(x, -2147483648n, 2147483647n), (x) => Compute.cast(x, pg.integer), 0n)`.
- **A computed integer or money value binds at a plain integer or money column.** `r.match(Tag, { w:
  Compute.mul(note.k, 2) })` binds an exact integer at an integer column: the checker compares the column with the
  value, the column widened into the exact integers, as `Compute.eq` does. Two variables still bind each other only at
  one type. No codemod.
- **Money arithmetic is exact.** `Compute.add` and `sub` over money yield *exact money*, delivered as `Money`, which
  never overflows; `r.sum` over money is exact money. Narrow it into a `pg.money` field with `Compute.cast` under a
  `Compute.within` guard. No codemod for reads: the host type is still `Money`.
- **Float arithmetic is IEEE 754.** `+`, `-`, `*`, `/` and `sqrt` over `real` and `double precision`, casts into a
  float and float sums round to the nearest value or overflow to ±Infinity: `1e308 * 10` is `Infinity`, `x / 0.0` is
  `±Infinity` by the sign of `x`, `0.0 / 0.0` and `sqrt(-1.0)` are `NaN`, where PostgreSQL raised 22003 or 2201F.
  No codemod.
- **A partial operation needs its precondition proved, by a type or by `Compute.when`.** `Compute.div`, `mod`, `quot`
  and `rem` need a divisor proved nonzero (a float's excepted); numeric `sqrt` a radicand proved nonnegative; `power`
  a base proved nonnegative and nonzero, or its exponent nonnegative; `widthBucket` and `minScale` finite operands; a
  cast from numeric or a float into an integer or money a value proved finite, and every narrowing a value proved to
  fit. An unproved divisor is a type error naming the guard to write, and compilation refuses what the types admit but
  cannot be proved (a narrowing's range, a power's magnitude) with the new `CompileError` reason `PartialOperation`
  (`{ at, operation, precondition, operand, guard }`). Facts come from a number or bigint literal's own type, from a
  contract that declares them, and from a guard.
  Before: `Compute.div(t.amount, t.count)` compiled and raised 22012 on a zero count. After: it is a type error; write
  `Compute.when(Compute.nonzero(t.count), (count) => Compute.div(t.amount, count), 0n)`.
  - Codemod: wrap each unguarded partial operation in `Compute.when(<guard>(x), (x) => <operation over x>, <your
    value>)`, the guard one of `Compute.nonzero`, `Compute.nonnegative`, `Compute.positive`, `Compute.isFinite` and
    `Compute.within(x, low, high)`. A guard is also a predicate, so `r.where(Compute.nonzero(x))` reads as `x <> 0`.
  - A contract may declare what its predicate proves, so its values need no guard:
    `contract("Divisor", pg.bigint, (v) => v.ne(0n), { proves: ["nonzero"] })`. Compilation proves each declared fact
    from the predicate, and a declaration it does not prove is `MalformedDescription`.
  - A program that switches over `CompileReason["_tag"]` exhaustively gains `"PartialOperation"`.
- **A parameter is a term of its declared type, first included.** `r.param(name, type)` is of `type` wherever it
  stands: a guard's subject (`Compute.when(Compute.nonzero(d), (d) => Compute.div(x, d), 0n)` over
  `d = r.param("d", pg.bigint)`, which delivers `0n` for `d = 0` under custom and generic plans alike), `Compute.base`'s
  operand, a first operand and a conditional's first branch. A parameter of a contract has the facts it declares, so
  `Compute.div(x, Compute.base(r.param("d", Divisor)))` needs no guard. Before: a parameter took the type of the term it
  met, never stood first, and a head parameter no other use typed was `MalformedDescription`. After: its declared type
  is its type, opposite a term it meets that term like any other (`MalformedDescription` when the types do not meet),
  and two declarations of one name must be compatible.
  - Codemod: a parameter declared at a base type opposite a contract field, `r.param("p", pg.bigint)` → `r.param("p",
    Cents)`; the types already refused the base.
  - The Description format changed for JavaScript callers who build Descriptions by hand: a scalar parameter is
    `{ kind: "param", name, type }`, `type` its field descriptor, and the decoder refuses one without `type`
    (`MalformedDescription`); an import binds a relation parameter to the importer's as `{ kind: "relationParam", name }`
    in its bind map, where it was `{ kind: "param", name }`; and a `Compute.when` is
    `{ kind: "when", guard, subject, proved, otherwise }`, `proved` the branch that receives the subject proved.
- **`Contract`'s third type argument is the tuple of the fact names it declares.** `contract(name, base, predicate,
  { proves })` has the type `Contract<Name, Base, Proves>`, `Proves` the `proves` tuple, and `Contract<Name, Base>` is a
  contract that declares none, the same type `contract(...)` without `proves` gives.
  - Codemod: a written `Contract<N, B, DeclaredFacts<readonly ["nonzero"]>>` → `Contract<N, B, readonly ["nonzero"]>`;
    `Contract<N, B>` is unchanged.
- **A recursive relation's counter types.** A recursive arm's head delivers the row by the same rule a binding meets
  its column, so `hops: Compute.add(hops, 1)` into `row: { hops: pg.integer }` typechecks, and compilation proves the
  counter fits its field from the recursion's bound, or refuses it with `PartialOperation`. An arm whose head misses a
  row field, adds one, or delivers a type that meets no field's is refused at the arm, `Refusal<"an arm's head delivers
  the row: each of its fields, at a type that meets the field's">`. No codemod.
- **A parameter is checked against its contract and pattern at bind.** A scalar or relation parameter whose declared
  type is a contract or a refined text is refused at bind, `EncodingFailure` with reason `refinedValue`, when its value
  violates them, before any SQL is sent; before, a read cast it to its domain and PostgreSQL raised 23514. A program
  that switches over the codec fault words gains `"refinedValue"`. No codemod.
- **A bare `pg.numeric` field stores at most 1,000 integer digits.** Its encoder refuses a longer value
  (`numericOverflow`), and every bare numeric column carries the installed CHECK `__<table>_bound_<column>_<digest>`,
  `abs(c) < 10^1000 OR c = 'NaN' OR abs(c) = 'Infinity'` (the bound written out in full digits), whose violation, by a computed value grizzle writes or by a
  direct SQL writer, reports the law `{ kind: "numericBound", relation, field }`. A numeric expression whose digit
  bound passes 131,072 digits is `ResourceBound` with `bound: { kind: "numericDigits", limit, needed }`.
  - Fix: a program that switches over `Law["kind"]` exhaustively gains `"numericBound"`, and one over
    `CompileBound["kind"]` gains `"numericDigits"`.
- **A role entry's arithmetic is no longer refused.** A role's query entry may compute with arithmetic, casts and
  every other Compute operation, since no operation raises; the refusal of arithmetic in a role entry is removed. No
  codemod.
- **A derived relation stores no exact value.** A derived head that delivers an exact integer or exact money is
  `DerivedRefused` with reason `exactField`; narrow it with `Compute.cast` into the field's type under a guard. An
  aggregate is a head column, never a term, so a sum is narrowed one stage later: find the sum in an interior stage
  (`r.interior`), match it, and narrow the matched variable,
  `Compute.when(Compute.within(total, least, greatest), (t) => Compute.cast(t, pg.money), Compute.literal(pg.money,
  Money.of(0n)))`. `Compute.cast(r.sum(...))` is refused and names that route.
- **`r.sum` over `bigint` is `numeric`, and over money exact money.** Sums over exact values are exact. No codemod for
  reads of `bigint` sums, which already delivered `Decimal`.
- **Format and state:** snapshot.json changes: a scalar operation node carries its precondition proof, failure
  annotations are gone, and a contract records its declared facts; every bare numeric column gains its bound CHECK.
  Re-create every database installed before.

#### Node 26 and Effect 4.1 are the floor

- **grizzle needs Node 26 or later.** `engines.node` of `@bjornpagen/grizzle` and `@bjornpagen/grizzle-engine` is
  `>=26`. No codemod: run on Node 26.
- **`effect` is a peer dependency at `^4.1.2`.** Install Effect 4.1 beside grizzle; 4.0 is outside the range. Effect
  4.1 moved its crypto services out of the `effect` barrel into `effect/crypto`. No codemod in grizzle code.

#### Effect Schema leaves grizzle's runtime: errors are `Data.TaggedError`, snapshot.json and meta.json are trusted once their digests hold

- **Every grizzle error is a `Data.TaggedError`.** `OpenError`, `ReadFailure`, `TransientFailure`,
  `TransportFailure`, `ExecutionFailure`, `CommitUnknown`, `StaleSnapshot`, `CredentialError`, `TokenError` and every
  reason class keep their `_tag`, their fields, their getters and their `message`, and `Effect.catchTag`,
  `catchReason`, `catchReasons` and `unwrapReason` reach them as before. They are no longer Effect Schema classes: no
  `.make`, no decoding or encoding, no use as a Schema, and the constructor checks nothing its type does not.
  - Codemod: `CredentialError.make({ cause })` → `new CredentialError({ cause })`; `TokenError.make({ cause })` →
    `new TokenError({ cause })`; any grizzle error `X.make(args)` → `new X(args)`, and `X.make()` of an error without
    fields → `new X()`.
  - Codemod: `Schema.is(X)(u)` of a grizzle error `X` → `u instanceof X`; a test of `_tag` needs no change.
  - Fix: a grizzle error held in a field of the application's own Schema is declared with
    `Schema.declare((u: unknown): u is X => u instanceof X)`.
- **Format and state:** snapshot.json records each installed statement as itself: every clause stated (an empty list,
  a false flag, the ascending order), which it left out before, and each placeholder as the statement holds it, so it
  grows by what it now states. Its fingerprint is the digest of the file's own JSON value, every property but the
  fingerprint, checked over that value before anything reads it as a snapshot: a snapshot.json edited by hand is still
  refused (`grizzle check`, `grizzle generate`, `DbLayer.make`), now before it is read. meta.json is
  `{ "meta": ..., "seal": ... }`, its meta sealed by the digest of its content: a meta.json edited or corrupted
  outside grizzle is refused as malformed by `grizzle check`, `grizzle generate` and `grizzle migrate` before its meta
  is read. Every snapshot fingerprint changes, and a previous snapshot.json or meta.json is refused, never read:
  delete `migrations/`, re-create every database and run `grizzle generate` (step 3 above).

#### What the full test run found and fixed: proofs PostgreSQL disagreed with, and literals, plans and checks it refused

Every one of these was reached by the suites under the witness phases (#1) and the cutovers above; none needs a
codemod unless it says so.
- **Cast proofs are PostgreSQL's conversions.** A narrowing proof reads the conversion the cast is: an exact
  conversion is not widened (so `Compute.cast(x, pg.numeric(1, 0))` under `Compute.within(x, -9n, 9n)` is proved),
  rounding to a scale widens by one unit, and a float into numeric widens outward to the float's significant digits
  (6 for `real`, 15 for `double precision`), where before a `real` near the bound was proved and PostgreSQL raised
  22003. `fits` into a numeric typmod admits NaN, which a numeric column holds; a cast into an integer or money also
  needs the value finite. Float bounds account for IEEE rounding (overflow to ±Infinity, underflow to 0), so a float
  product or divisor is no longer proved finite or nonzero where rounding makes it infinite or zero.
- **Power proofs are PostgreSQL's limits.** A numeric power with a fractional exponent is proved in range only while
  its result has at most 6000 digits (PostgreSQL's power_var); an exponent proved integral keeps the wider range of
  power_var_int. A small base with a negative exponent is bounded too (`power(1e-16383, -10)` overflows and was
  proved). Write the guard the type error names.
- **Recursive counters.** A counter is proved from the recursion's termination interval: every value the step
  computes from every state the counter holds, the step past its bound included. A walk whose arms step by 1 and 2
  is admitted, and so are mixed arms (`h: Compute.add(h, 1)` beside `h: h`). A counter seeded by data or bounded by a
  parameter can reach its carrier's extreme and is refused (`PartialOperation`); a counter without a bound is refused
  as unbounded state.
- **Float arithmetic runs natively where that is exact.** An IEEE 754 operation is sent as PostgreSQL's own
  operation where a kept proof shows its result is the IEEE result (literals, contracts, guards, conversions of
  exact integers), and otherwise as a guarded form whose operands are bound once, fenced so PostgreSQL plans it in
  linear time: a percentile over a few rows took minutes to plan, and now milliseconds.
- **An entry insert leaves out only its classed serial fields.** An insert through a writable entry may omit the
  serial fields the entry classes, and carries every serial field its filter reads, as the README states; before,
  the fill was checked against the table's whole serial list and refused. Every serial value the insert supplies, one
  its filter reads or its fill fixes, is the value stored (`OVERRIDING SYSTEM VALUE`, and the serial advances past
  it). Only the serial fields the entry classes are drawn. At `e7fd8b3` such a supplied value was replaced by a drawn
  one without an error, or refused by the entry's row-level policy (42501): a row written there through such an
  entry may hold a wrong serial, so re-create every database written at that commit.
- **A literal equality in a role or workload filter is indexed.** The index request of a filter such as
  `org = '<uuid>'` now holds that column, so it is read by an index and not a scan; an equality over a roster handle
  alone is still no index. Index names and snapshots change.
- **Writing an exact value into a plain field is a type error.** A ChangeSet member (put, insert, delete, an entry
  write) whose head writes a field a term of another SQL type than the field's, an exact integer or exact money into
  a `bigint` or `money` field above all, is refused by the types,
  `Refusal<"a member's head writes each field at its type: an exact value re-enters a plain field only by Compute.cast">`;
  before, the types admitted it and compilation refused it (`DescribedHeadingMismatch`). A JavaScript value is judged
  by its host type as before.
  - Fix: narrow the term under a guard, the way a credit into a `bigint` balance is written:
    `balance: Compute.when(Compute.within(Compute.add(balance, amount), -(2n ** 63n), 2n ** 63n - 1n), (b) => Compute.cast(b, pg.bigint), balance)`,
    with the otherwise-value your domain chooses.
- **Smaller corrections:** a rewritten WITH or target table of an INSERT is no longer lost (the SQL transformer);
  a residual law's violation probe admits a contract over text; a read's relation parameter outside its refinement
  is refused at bind (`EncodingFailure` with `refinedValue`), as a scalar parameter is; a page over a vector key
  compares by pgvector's qualified operator; `r.not` binds an exact value at a plain column; a money literal is
  written in its one form (`1.5::money`); decimal literals are never written with an exponent.
- **Format and state:** snapshot.json changes again: a cast's operation id names its source carrier
  (`cast:exactInteger->numeric`, where exact carriers shared numeric's id), an interval premise records whether it
  admits NaN, and a float operation may carry its native proof. Delete `migrations/`, re-create every database and
  run `grizzle generate`.
