---
name: grizzle
description: Load after editing a grizzle schema, role, login, workload or grizzle.config.ts, before running grizzle
  generate or grizzle migrate, or when a grizzle migration needs review, tuning or a data step.
---

# grizzle migrations

grizzle drafts plain SQL migrations from a committed snapshot, never from the live database. You read the SQL, tune it
if needed, resolve its markers, run `grizzle check grizzle.config.ts`, and commit. `grizzle migrate grizzle.config.ts`
applies it. Edits are allowed;
drift is not: whatever the SQL does, the catalog must end where `snapshot.json` says.

## Config

The config file, `grizzle.config.ts` by convention, sits in the package root. Every command names it as its one
argument, a path relative to the directory grizzle runs in (`grizzle generate grizzle.config.ts`); no command reads a
file it isn't given, and grizzle reads no environment variable for where to connect.

```ts
import net from "node:net"
import { CredentialError, defineConfig } from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pgDriver from "pg"
import { Blog, caPem, EtlJob, Web } from "./src/db.ts"

export default defineConfig({
	/** Required: each declared schema, in its own PostgreSQL schema. */
	schemas: [Blog],
	/** Required: every login, and through them every role a Db opens and every workload whose access paths earn indexes. */
	logins: [Web, EtlJob],
	/** Required: the migrations directory, relative to this file. */
	migrations: "migrations",
	/** Required: the bytes of the longest role prefix an installation is under, 0 where none is (a test harness states its own). */
	rolePrefixBytes: 0,
	/** Required: where grizzle migrate and grizzle drift connect, as the role that owns the schemas, built only when they run. */
	connection: () => ({
		driver: pgDriver,
		transport: {
			kind: "sslRequest",
			host: "db.internal",
			port: 5432,
			open: () => new net.Socket(),
			ca: caPem,
			servername: "db.internal"
		},
		database: "app",
		role: "app_owner",
		password: Config.Redacted("MIGRATION_PASSWORD").pipe(
			Effect.mapError((cause) => new CredentialError({ cause }))
		)
	})
})
```

- Every key is required, and nothing else is configurable: an unknown key is refused.
- Always `export default defineConfig({ ... })`. A plain object is refused.
- `schemas` lists each installation once, by its top level: `schema.extend([Qti], "Ledger", ...)` listed as `[Ledger]`
  installs `Qti` and `Ledger` together, each level in its own PostgreSQL schema, under one migrations directory named
  by the root, `migrations/qti/`. Listing `Qti` beside `Ledger`, or two schemas over one root, is refused.
- Every role is in exactly one login. A login may be over any level of a listed installation (`login(Qti, ...)` beside
  `login(Ledger, ...)`). The config refuses a login over a schema no listed installation holds (or over another
  version of it), and two logins or roles of one installation whose names convert alike. A login missing from `logins`
  is not installed, nor are its roles: their PostgreSQL roles don't exist, so a Db's first call through them is refused
  at stage `acquire`.
- A schema's relations are a list: `schema("App", [Item, Note], [...])`, `schema.extend([Qti], "Ledger", [Sitting],
  [...])`. Join a library's relations to the app's by concatenating lists, `[...own, ...library.relations]`, never by
  spreading records, which drops one of two relations of a name. A name is one relation across every level: a relation
  listed twice or an identical copy is one declaration, two that differ are `DuplicateIdentity` naming both, and so is
  a law built over a relation of a declared name other than the one declared.
- A level's bases are a list, of one base: `schema.extend([base], ...)`. A level over several bases is not built yet,
  and a second base is refused, `Refusal<"schema.extend takes one base: a level over several bases is not built yet">`.
- A read of no relation, a row of its parameters and constants alone, is written over `schema.empty`, the empty level
  below every root, which every role holds whole: the role serving it holds nothing for it. Never declare an empty
  schema or a level of no relation for it; a level that declares nothing over a base holds the base's relations.
- A package's level over whatever base its installation hands it is a function of that base, bounded by the least
  level it reads: `<Base extends SchemaOver<typeof Qti>>(base: Base) => schema.extend([base], "Ledger", ...)`, or
  `AnySchema`, which knows no relation's name and admits no derived relation. The call checks the level over the bound;
  the same checks over the base wait for the call with it, whose result, refused, carries `Refusal<"...">` and is
  refused wherever it is taken as a schema.
- A library's relations and laws can be one value, `fragment(relations, statements)`, which an application lists
  among its relations, `schema("App", [...own, Jobs], laws)`. The fragment is a level of every schema that lists it:
  queries and ChangeSets written over it (`query(Jobs)`, `ChangeSet.empty(Jobs)`) stand in that schema's workloads, and
  in a role's that holds every relation of the fragment whole. generate compiles them per login, as any program. Only
  the fragment states a key, `mutable`, `race`, a unit or a series over its relations, a family, a tree or
  a fold. An application
  that adds one is `FragmentRefused`; it may add containments, row checks and rules over queries, which only refuse.
- A level reaches the levels below it only by a containment of fields into a key, its other side the level's own, a
  lower side every fact or a selection (`on(select(Item, (i) => ...), "id")`, its terms generated columns PostgreSQL
  computes on the lower table), a row check over a lower relation (written as that relation's own, its CHECK on the
  lower table, installed and validated by the level's migration), or through a rule over a query; any other law over a
  lower relation, a containment between two lower relations among them, is `LevelRefused` when the schema is built. A process over a lower level serves its login's file, which holds what its programs may meet of the levels
  above, and a refusal by a law above it is `refused.kind` `above`, `refused.laws[0]` the law
  `{ kind: "above", level, law }`, beside every law of its own the host finds the stated row breaking (`refused.own`).
- A login owns its workloads: `login(Blog, "web", [AnonBlog, MemberBlog], { workload: [anonReads, memberReads] })`.
  A workload, `workload(schemaOrRole, { name: program })`, is over the login's base, a level of it, or one of its
  roles, and names queries, ordered queries, ChangeSets and relation keys. Every member is called the same
  way: `once(input)`, its value (a read's keyed list, in its order, its key's where it states none, a write's
  outcome), and `watch(input)`, its events, live
  for a read; `input` is `{ params, facts }`, both always present, `{}` where the program takes none. An ordered query
  the application pages is the member `paged(query)`, whose input adds `window: { anchor, size }`, the anchor
  `{ kind: "start" }`, `{ kind: "after", key }`, `{ kind: "end" }`, `{ kind: "before", key }` or
  `{ kind: "at", position }`, a key a row's `RowKey` and a position the count of rows before the window (page `n` of
  size `m` is position `(n - 1) * m`; its statement is OFFSET, linear in the position, so page by key wherever the API
  allows); generate compiles a page template for no other member. The member `answered(read)`, of a query, an ordered
  query, a `paged(...)` one or a key, is answered at its call's instant alone and never live: its handle holds `once`
  and its explains, no `watch`, over HTTP it is reset, upserts, ready then end, its CLI has no `--follow`, and a login
  whose reads are all answered needs no `LiveSource` (a serverless route's ops login). The member
  `clocked(program, { now: "millis" })`
  binds the bigint parameter `now` of a query, an ordered query or a ChangeSet to the database's clock, the instant
  the call's transaction began, in `"micros"` or `"millis"`, a parameter of a consumer's contract under its key by the
  parameter's name, `clocked(program, { now: "millis" }, { now: millisKey })`: the input omits it, every statement of the call reads the
  one instant, and a clocked read is an answered one with its clock, answering `once` alone, never live. Bind a lease's, a timer's or a due instant's `now`
  so, never the host's clock; a reading lies in PostgreSQL's timestamptz range in its unit, so `now + delay`, the delay a
  contract its predicate bounds, casts into its field with no guard where those bounds fit (millis: into a bigint).
  Rows an array or a Stream inserts take such a field from the call: `insertAllComputed({ Claim: [] }, { until:
  Type.cast(Num.add(Type.base(param("now", Instant)), Type.base(param("budget", Budget))), Instant, instantKey) })`, its rows
  leaving `until` out, the record evaluated once per call in the statement that writes the rows, a nested owner's
  members carrying a computed key field holding the owner's one value (docs/reads-and-writes.md "Writes"). A
  reading is a value, a `bigint`, never an `instant`: a row records when it was written
  by a field of type `instant`, which no caller states. Key the row by its natural fields and the instant after them,
  `relation("SignIn", { user, at: instant, ... }, ["user", "at"])`: its `at` is a clock of child `user`, which an
  insert leaving it out stamps with the call's instant at the user, `greatest(clock, the user's latest + 1)`, from
  the user's head row, which two calls of one user take in turn, so a user's instants increase in the order their
  calls commit at every level, and calls of different users never wait on each other. A clock of a relation under a
  unit stamps from the unit's one head instead, keyed by its heading, so every clock of one unit at one key is
  commit-ordered with every other: an end stamped after a learner's snapshots is above each of them. No writer states a
  clock otherwise: a direct SQL writer, the owner and a migration's data step call the scope's stamp function first and
  state the instant it returns, or the insert is refused (23514, `__clocked`). An instant a
  containment carries into another relation's instant is a reference, stamped beside an insert of its clock or stated
  from a stored instant (docs/reads-and-writes.md "Instants"). A read delivers an instant as an `Instant`, a bigint only a read mints;
  `instant.stored` is a field of instant's type its caller writes as it read it, the database drawing nothing, so a
  read's rows can be kept with their instants: a bare bigint at it is a type error. Kept beside it, a read's search
  document is `tsvector(configuration)`, its `SearchDocument` written back as PostgreSQL printed it (any other text
  `searchDocumentForm`), and a read's sum or mean is `numeric.within(digits, scale)`, numeric of no typmod checked to
  the bound its query proves, a `Numeric` past it `numericBound`; numeric's own limits are `numeric` (docs/schema.md "Tables
  and types"). A row's place in its group is `place`, last in its primary key after the
  group: an insert leaving it out stamps one past the group's greatest, 0 first, so a group's places are gapless from 0
  in commit order; no put writes its relation, and a delete only whole groups, its rows stating fields of the group
  alone. A nested insert's members carry their owner's stamped place in
  their group, the owner and its members one family statement that stamps it once, and a read-back of the owner's
  `delta.added` returns the place stamped; a generated field over a carried place is PostgreSQL's, a fold, copy or step
  reading one is refused (`UnfillableField`, `stamped`), and two owners of one call in one group meet at the owner's
  key. A migration adding `place` to stored rows gives each place 0
  where the new key holds the old one, and is refused elsewhere; `place.by(field)`, beside a key within the group and
  the field, numbers the stored rows by the field (docs/reads-and-writes.md "Places"). A read runs SERIALIZABLE READ ONLY, one statement:
  it answers at once and may fail retryably. Nothing refreshes a stored derived relation: the rule judge keeps its table
  equal to its definition at every COMMIT that writes what it reads. Two programs of one name across a login's workloads
  are refused when the login is built. A ChangeSet member
  whose `insert`, `insertAll`, `delete` or `put` was given its facts as an array takes them as its input's `facts`:
  under each such member's op (`insert`, which `insertAll`'s members are too, `put` or `delete`) and then its
  relation's name one array, typed and checked as that member's own facts, as in
  `once({ params: {}, facts: { put: { Blob: stated }, delete: { Blob: removed } } })`; every other member's facts are
  `{}`. Two array members of one op and one relation in two strata are refused: merge them into one.
- Declare the key each family of rows sits under, a sitting, a learner, a package, a workflow's step, as a unit among
  the statements: `unit("Sitting", { number: AssignmentNo })`. Every stored relation whose primary key leads with the
  heading's fields, by name and type in order, sits under it, at its level or any above, which states nothing more; so
  lead each member's key with the unit's fields, and give the key a named domain (a contract of its own,
  `contract<typeof assignmentNoKey>()("AssignmentNo", int8, …)`), since a field of the same name and type that means something else joins the
  unit too, a coarser lock. A write of a unit's rows holds its key exclusively and a read of a unit it does not write
  holds it shared, as generate derives from the ChangeSet: no borrow is written. Refused (`MalformedDescription`): a unit
  whose heading leads with another's or that another's leads with (no unit nests: each relation sits under one at
  most), one name over two headings, and a unit stated above a level whose relation leads with its heading (state it at
  that level). A gapless number, one past the greatest, is `series(R)` over a relation keyed by one field of a type
  grizzle draws, `natural` or a contract over an integer (an int4 number keeps its `contract<typeof key>()(…, int4, …)`, whose
  CHECK refuses one past its bound): it states the predecessor law itself and every write of R holds its one lock, the
  only lock no key splits (docs/schema.md "Units").
- A relation is closed or open. Closed, the default: its facts are inserted, never changed or deleted; a role that
  writes it holds SELECT and INSERT on its table and no UPDATE or DELETE, and a ChangeSet's put or delete of it is
  refused when it compiles and as a type error, `Refusal<"a put of a closed relation: ...">` (or "a delete of"); record
  a change as a fact inserted, a new row that supersedes, the current one derived. Open: `mutable(R)` inside a unit
  whose heading R's primary key leads with, its rows changed in place and deleted under the unit's exclusive borrow
  (`&mut`); `mutable(R)` over a relation in no unit is refused when the schema is built and as a type error,
  `Refusal<"mutable over a relation under a unit, ...">`. A delete of an open owner or tree removes its family whole,
  so every relation nested under it is open too (docs/schema.md "Units").
- Remove a family of rows (a finished run, a removed package, a superseded load) by a ChangeSet of deletes of its
  relations under their unit, which the call borrows exclusively, and keep what must never come back, a run's
  idempotency key, a package's name, a release's attempt numbers, in a relation no ChangeSet deletes; a foreign key into
  a row refuses its delete while a reference remains (docs/schema.md "Removing a unit's rows").
- A delete of a tree names trees by their root value (`delete(Node, [{ package, path }])`), and a delete of a relation
  that owns a family and is no family's member names its rows; each removes every row nested under them through every
  family, so a group goes whole. A replace is `delete(...)` and `insertAll(...)` in one stratum: the delete runs first,
  an identical replace answers `unchanged`, and the counts are the difference. `deleteWhere({ R: { package:
  param("package", Name) }, … })` deletes each named relation's rows whose fields equal the given parameters or
  literals, as the delete of the query that selects them, so a replace of one package is one deleteWhere record and
  one insertAll. The role's write list names every
  relation the delete reaches, every one open: a role deletes nothing its insert list names. Delete a family's other members through their owner, never one by one
  when the owner is closed.
- `connection` is the migration role's: `driver` (the pg module), `transport` (`kind: "sslRequest"`, `host`, `port`,
  `open`, which returns a new socket, `ca` and `servername`; TLS is always verify-full, the server certificate chaining
  to `ca` and naming `servername`), `database`, `role`, `password` (a Redacted, or an Effect yielding one, evaluated for
  each connection attempt: an RDS IAM token, a secret manager's lookup). grizzle bounds no connection attempt: it
  waits for the server's answer or the operating system's failure. README "Logins, connecting and RDS IAM" shows the RDS IAM password with `@aws-sdk/rds-signer`.
- Never write a credential into the config file: read it where the config runs, as the password Effect does.
- `connection` is a function: only `migrate` and `drift` call it, so `generate`, `check` and `names` read no cluster
  setting and no CA file, and `check` runs in CI where no cluster is reachable. `migrate` and `drift` refuse a process environment that
  sets `PGREPLICATION`, which node-postgres would send at their session's startup, at the stage environment. Every
  session grizzle opens, a login's and the migration identity's, plans generically (`plan_cache_mode` at
  `force_generic_plan`, which a login's role stores and each session sets at its startup), so `PGOPTIONS` reaches
  none.

## The loop

1. Edit the schema, its roles and logins in code. Every program the application runs belongs in a workload of its
   login: its access paths earn indexes, and `grizzle generate` compiles it for every role of its login and commits
   the login's compiled workload as `migrations/<root>/served/<login>.json`, which the application serves
   (`served<typeof Login>(file, name)`) and compiles nothing. A program that does not compile fails generate with its
   CompileError, naming the role and the program.
2. Run `grizzle generate grizzle.config.ts`, declaring what became of every name the schema no longer holds: a
   `--rename <old>=<new>` for each rename and a `--drop <old>` for each drop ([Renames and drops](#renames-and-drops)).
   It prints one line per written file, then each drafted folder's lock demand as `<folder>: locks <file> <n>, …; the
   server's lock table must hold <n> for <file>'s transaction`, then each marker to resolve as `<file>:<line>: <kind>: <what to do>`, its
   kind `placeholder` or `confirm`, then each loss to decide as `<file>: data loss: <what it loses>: <what to do>`,
   then `next: resolve the markers, then run grizzle check`. With no change it writes nothing and prints `no changes`,
   unless the derived facts snapshot.json records are out of date or missing, or `manifest.json` is not the record the
   schemas compile to: then it writes `snapshot.json` and `manifest.json` again, drafts no folder, and prints
   `next: commit snapshot.json and manifest.json, then run grizzle check`. Beside the
   snapshot it writes `served/<login>.json` for every login of the configuration over the schema: the login's
   workload compiled under that snapshot, every program for every role it runs on, which is what the application
   serves, and `openapi/<login>.json`, the login's OpenAPI 3.2 document read off that served file. It writes a served
   file or document whose text changed, removes the ones of a login the configuration no longer lists, prints each,
   and prints `next: commit the served files, then run grizzle check` when nothing else changed. A login
   whose workload does not compile refuses generate, naming the login, the role and the program. A name the previous snapshot
   holds that the schema no longer does and no declaration names refuses the draft before anything is written:
   `<name> is dropped but not declared: declare it with --drop <name>, or --rename it`.
3. Read every drafted SQL file, and resolve each marker:
   - **Placeholder** (`-- grizzle: placeholder` above a `__GRIZZLE_PLACEHOLDER__`): a value for a new NOT NULL column
     on a table with rows, or a changed type's new value in its fill's UPDATE (the row is `"t"`, its old column still
     there, and the last value may be followed by the `FROM` and `WHERE` it joins). Write the value, or an UPDATE right
     after the file's `SET CONSTRAINTS ALL IMMEDIATE`, where every data step goes, then delete the marker line.
   - **Confirm** (`-- grizzle: confirm:` and the instruction line below it): a holder set aside, a relation or roster
     whose name a declared rename takes or that moves to another kind, renamed aside with every index it owns, so a
     declared rename takes it from there or the end of the migration
     drops it, as declared. Keep every statement as drafted and delete the two marker lines; `check` refuses a group
     kept in part.
   - **Data loss** (`-- grizzle: data loss:` above a commented `CREATE SCHEMA`): a schema's first migration beside a
     schema the configuration no longer lists, which a schema renamed in code leaves; see [Renames and
     drops](#renames-and-drops). The decision is the SQL itself: `check` and `migrate` refuse the folder while it is
     commented. The two comment lines may stay.
4. Tune if needed: batch a large backfill, add a data fix, reorder within a file. The catalog must end where the
   snapshot says. Name a PostgreSQL type or function the way the drafts do, by its schema
   (`"pg_catalog"."text"`, `"pg_catalog"."count"(*)`) or its keyword (`integer`, `bigint`, `boolean`): a statement
   of yours runs under the session's search_path, where a relation of yours named `Text` is the type `text`, and the
   drift check judges what it built.
5. Run `grizzle check grizzle.config.ts` until it passes. It prints `<schema>: ok (<n> migrations, snapshot
   <fingerprint>)`.
6. Commit the folder, `snapshot.json`, `manifest.json` and the `served` directory.
7. Run `grizzle migrate grizzle.config.ts` from CI or the deploy, where its connection reaches the database. It ends
   with the drift check, so no `grizzle drift` need follow it; `drift` is for a database not just migrated. It prints
   `<schema>: applied <n> migrations, now at <fingerprint>` and each folder's files, or `<schema>: up to date at
   <fingerprint>`.

For data-only work: `grizzle generate grizzle.config.ts --custom --name <name>`, write the SQL files, then `check`,
commit and `migrate`.

Commands: `grizzle generate <config> [--name <name>] [--schema <schema>] [--rename <old>=<new>]... [--drop <old>]...`,
`grizzle generate <config> --custom --name <name> [--schema <schema>]`, `grizzle draft-key <config> [generate's flags]`
(the key of the draft generate makes with those flags: the SHA-256 of every input it reads, which a cache of its
output keys by; CONTRIBUTING "Drafts and their key"), `grizzle check <config>`, `grizzle migrate
<config>`, `grizzle drift <config>`, `grizzle names <config>`, `grizzle roles <config>` (the installation's roles in
the cluster), `grizzle uninstall <config>` (drops the installation's schemas, every row they hold, and its roles, in
one transaction). Flags come anywhere after the command, as `--flag value`
or `--flag=value`. A name is lowercase words joined by `_` or `-`, at most 240 characters, so that the folder
`<timestamp>_<name>` fits one file name (NAME_MAX, 255 bytes). Without `--name`, a drafted folder is named after its
change (`init`, `add_task_note`, `<first change>_and_more`); a custom one needs `--name`. The timestamp is the committed
chain's, never a clock's: a schema's first folder is `19700101000000`, each later one the second after the newest
folder's, so a draft is a function of the source and the committed chain, byte for byte, wherever and whenever it runs,
and two drafts on one chain share a timestamp, which generate, check and migrate refuse as a forked chain. `--schema`
is accepted only when the config lists several installations, each by its top level's name; there it is required with
`--custom`, `--rename` or `--drop`. Exit codes: 0 ok, 1
refused, 2 usage error, 130 interrupted.

## Reading a draft

`migrations/<root>/<timestamp>_<name>/` holds `NN-<phase>.sql` files and `meta.json`, `<root>` the PostgreSQL schema
of the installation's root level; one migration spans every level. Each file is one
transaction, so a migration is several small files, in order. A migration is plain ordered SQL: what the schema no
longer has is dropped in the same migration, as declared, and a declared rename or a type change happens in place. A
breaking change may briefly break older application instances that are still running.

- **setup**: first the holders a declared rename sets aside, under a confirm marker, and the declared renames
  themselves (`ALTER TABLE ... RENAME TO`, `RENAME COLUMN`, `RENAME CONSTRAINT`, through an aside name, so a swap or a
  chain is free of the names it moves into); then the violation check of each rule over closed relations alone that
  is new or whose closed rows changed, a DO block raising 23000 with the rule's name, so rows that break it refuse the
  migration before it changes anything; then extensions, each new content-addressed constant, and new domains. A
  closed relation's constant is one hex literal, `X'…'`, its cells' bits padded with 0s to a whole digit, its row
  count and content digest in a comment, which `grizzle check` decodes and holds to that digest and to its function's
  name; never edit one by hand; a roster's names constant is its handles as `name[]` in code order, `""` at a hole; a
  set's `live` constant is the hex literal of its live codes. The domains are a roster's smallint domain over its
  names constant, a set's `bit(n)` domain over `live`, n its codes rounded up to whole bytes, and the contract
  and text domains, one per distinct definition. A schema that declares functions (`fn`) gets here, after its
  domains, the installation's function owner (`__owner_<digest>`, `CREATE ROLE ... NOLOGIN`, granted to the migration
  identity `WITH INHERIT TRUE, SET TRUE`, with `USAGE` on the levels' schemas and no privilege on any table), each
  heading's row type (`CREATE TYPE <level>.__rows_<digest> AS (...)`, after the row types its fields hold, a field of
  rows an array of one and a field of `row(...)` the row type itself), and each function, callees first:
  `CREATE OR REPLACE FUNCTION ... [STRICT] SECURITY DEFINER SET search_path = pg_catalog, <level>, pg_temp AS <body>`,
  `STRICT` where its `nullInput` is `"strict"`, its body
  the application's `` fn.body`...` `` text byte for byte but for each `${heading}` it names, which is that row type's
  name, `"__rows_<digest>"`, `EXECUTE` revoked from PUBLIC, then handed to the owner (`GRANT CREATE ON
  SCHEMA`, `ALTER FUNCTION ... OWNER TO`, `REVOKE CREATE`). A changed body, volatility or null input is that same `CREATE OR
  REPLACE`; a changed signature or result drops the function first. Never edit a body here: change the schema's `fn`,
  since the drift check holds every installed body to the SHA-256 `manifest.json` records.
- **structure**: tables, columns, constraints (`NOT VALID` on a table that may hold rows), stored derived relations'
  tables, each filled by an `INSERT` of its definition's rows. Each term
  of a selected side, and each `pred` term, is a STORED generated column, `CASE WHEN φ THEN t END` (`__<field>_…`,
  `__pred_<field>_…`), and a rule's key over them is `UNIQUE NULLS DISTINCT` and its foreign key `MATCH SIMPLE`; a
  selected target's constant is a generated column too, `__tag_<field>_<value>_…`. A family's hidden columns, which
  grizzle fills on every write, are each their own `ADD COLUMN` (`__index_<count>_…`, `__copy_<count>_…`,
  `__before_<count>_<plane>_…`, `__after_<count>_<plane>_…`, `__predecessor_<count>_…`), and each CHECK over them its
  own `ADD CONSTRAINT`. A family new to a table that may hold rows is backfilled here: its columns are added under
  placeholder defaults, `SET CONSTRAINTS ALL IMMEDIATE`, SQL over the stored rows draws each index, count, fold value
  and interval (window functions, and one recursive step for a tree), each default is dropped, and only then are the
  constraints that read them added, `NOT VALID`, for Validate to prove the values. A place added to stored rows is
  backfilled the same way, numbered within its group by its `by`, and so is a column a containment carries into stored
  rows where the previous installation's containment over the same tables named each row's parent: it takes that row's
  value, then its NOT NULL (re-keying a child by its parent's place needs no data step); a clock added to stored rows
  takes the migration's instant on every one, refused where the new key does not hold the old one beside it. A field whose filler changed (its
  fold steps over another field, its copy reads another field, its family's group or order changed) is dropped and
  backfilled the same way: `snapshot.json` records what fills each drawn or accumulated field. An ordered family's
  or a tree's index is the exception: a stored index is the caller's order, so when only the family's group changes
  (its owner re-keyed, a group field dropped and added) the index column is kept, the count, copies and folds are
  drawn again over the kept order after the data step, and Validate refuses a data step that leaves an owner's
  indices other than 0 … n − 1. `--drop M.at` while the schema still declares `M.at` gives the stored order up and
  draws the index anew in member-key order. A tree's `start` and `end` are kept as its index is, so a tree re-keyed by
  its root (root fields added or replaced) keeps `at`, `start` and `end`, and its drawn `parent` is drawn from them, each row's parent the row of its
  root value whose interval holds its own most tightly: fill the new root fields in the data step before the backfill,
  and Validate refuses roots that merge or split stored trees. A tree added to rows no installed tree drew is refused.
  A fold added to or changed on a tree that holds rows is drawn in the tree's stored sibling order. A family whose values the stored rows
  alone don't give is refused, naming it: copies that read each other, or a fold over a copy. A roster whose names changed has its domain's CHECK dropped and added `NOT VALID` against the new names constant,
  validated in Validate; a set over a roster that grew is converted to the new size's domain by its cast, the new
  handles absent. A table CHECK or generated field over a changed closed relation is replaced the same way, or takes its
  new expression (`SET EXPRESSION`), which checks every constraint over the field against its new values in that
  statement: a CHECK, key or unique index over it that the target defines otherwise, or that reads a field the backfill
  draws again, is dropped before it and added again after. A field whose type changes is converted by its cast, in place, with no
  placeholder, when the new type holds the old one's values (a pattern changed, a contract added, removed or swapped
  for another over the same base); otherwise it is set aside: its table's one ALTER TABLE adds a set-aside column of the
  new type, and once every placeholder column holds its value the table's fill sets it to the value you write at its
  placeholder (a `USING` reads its own row alone, so it could not join a re-pointed reference's target), drops the old
  column and renames the set-aside one into the field's name. Either way it runs after the
  constraints and indexes over it are dropped; they are built again as on any table with rows, but a key over it,
  which is added again right after the conversion in the same transaction, so it holds throughout. A domain is
  named by its whole definition, so a contract's changed predicate, like a changed pattern, is another domain: each
  field it types is converted to it by its cast, which refuses a stored value the new definition doesn't admit (23514).
  Every world object an existing role relies on (a view, a policy, a filter function, a
  key or unique probe) that changes, or that reads anything the migration changes or drops (a relation, a column, a
  type, a stored derived relation's table, a function), is dropped at the start of this transaction and created again, with its
  grants, at its end, so no committed state lacks it.
- **indexes**: `CREATE INDEX CONCURRENTLY` on tables that may hold rows, in a no-transaction file, so writes keep
  flowing. A table this migration creates gets an ordinary build. No migration runs `ANALYZE`: grizzle carries each
  statement's plan to PostgreSQL as plan advice (docs/operations.md "Plan advice"), so no estimate chooses its access
  path.
- **validate**: `VALIDATE CONSTRAINT`, and the rules over queries, in one transaction that takes no lock that blocks a
  read, so the application reads every table while its checks read every row; writes to the tables a rule reads wait
  for it. A roster domain's VALIDATE refuses every row that still holds a removed handle's code, naming the table and
  column, never the row: change or delete those rows in a data step before it. A rule over a query (a side over a
  derived relation) that is new, or whose rule or definition changed, is checked here once every row the migration
  writes is written: a DO block running the rule's judge over every stored row, one chain of index lookups from each,
  raising 23000 with the rule's name where a row breaks it. A check's identity is its rule's meaning over what it reads, never its SQL, and the query
  reads only the columns its rule reads and each table's key: a draft whose grizzle upgrade only lowers a rule
  differently, or which drops or renames a column no rule reads, proves as it is generated that each rule means what
  it meant, so the proof its earlier check made of the rows still stands. A closed relation's facts a rule reads by
  `C.at`, `C.has` or `C.row`, its key set and each payload field a `C.at` reads, are of that meaning, so a migration
  that changes them, such as a lowered count a rule bounds stored rows by, checks the rule again. So does a migration
  that writes again a column the rule reads, which its triggers never see: a generated column re-expressed (by its
  expression, or by a closed row or roster its generation reads), converted, or dropped and added again, or a column a
  family's backfill draws again; a stored derived relation's table above that column's table is created again and
  filled. Its functions and its
  deferred constraint triggers, one on each table its query reads, are
  created or replaced here too, before the checks, so no write runs past them; a renamed table's trigger, which
  PostgreSQL drops under ACCESS EXCLUSIVE, is created again last, its table locked against writers before the checks.
  A key a check reads is enforced by the unique index the indexes file built.
- **publish**: first each key's constraint attached to its concurrently built index (`ADD CONSTRAINT ... USING
  INDEX`), and the key swaps: a key replaced by another over the same fields (a candidate key that becomes the primary
  key) is dropped once the new key is attached, the foreign keys over those fields dropped before it and added again
  after it, `NOT VALID`, so each depends on the new key; a foreign key into a key this migration attaches is added the
  same way. Then the refined constants' casts to their domains, so each is judged by the target's CHECK (one it refuses
  rolls the whole file back); the worlds: logins and roles, their memberships and settings, each role's schema of
  views (a security-barrier view for a query entry, a plain one for a whole entry, each closed id followed by its
  decoded `<field>_name`), its grants (EXECUTE on each constant its statements call among them, and on each declared function its served
  programs call, `Fn.call`, `Fn.rows` and `Fn.row`, and no other), row-security policies
  and filter functions; and last every object the schema no longer has, dropped: indexes, roles, views,
  functions (a constant by `DROP FUNCTION ... RESTRICT`, so PostgreSQL refuses a migration that left a reader of it
  standing), columns, tables, then types. A declared drop of a stored relation or field is drafted live. A world object
  holds no data, so a changed world needs no marker; a role the migration creates gets its views, policies and
  functions here, after the role. Every statement after structure that takes ACCESS EXCLUSIVE is in this short
  transaction, which reads no rows but its constants'.
- **validate**, again, when publish added a foreign key `NOT VALID`: its `VALIDATE CONSTRAINT`, in a transaction of
  its own that blocks no read; the key is enforced on every write from its addition.

`-- grizzle: no-transaction` as a file's first line runs each statement alone, each ending at a semicolon where psql
would end it: outside quotes, dollar quotes, comments, parentheses and the `BEGIN ATOMIC … END` body of a function or
procedure. Each statement must be safe to rerun: a rerun after a failure starts the file again from its first
statement.

## Renames and drops

grizzle never guesses a rename, and drops nothing you did not declare: a rename guessed wrong loses data. Declare each
name the schema no longer holds to `grizzle generate`, once per name:

- `--rename <old>=<new>` renames it, and `--drop <old>` drops it. Each side is a relation or roster (`Task`), a field
  (`Task.title`), a roster's handle (`Status#done`) or a login (`@web`); both sides of a rename are one kind of name.
  The old side names what `snapshot.json` declares and the new side what the schema declares, so `--rename R=S` beside
  `--rename R.f=S.g` renames a field of a renamed relation.
- Every drop of stored state is declared, or the draft is refused as UndeclaredDrop, naming it: a stored relation with
  its rows, a field with its values, a roster's handle, whose code stored rows hold, and a login, whose PostgreSQL role
  holds its password and whatever was granted to it outside grizzle. A generated, drawn or accumulated field, which
  grizzle draws again, a derived relation, which its definition recomputes, and a role, which grizzle creates and
  grants whole, need no declaration.
- `generate` refuses, before reading the configuration, a declaration its text alone shows wrong: a side of no such
  spelling, a rename between two kinds of name or to itself, a name renamed or dropped twice, two names renamed to one.
  The draft refuses a declaration that names what the snapshot or the schema does not hold as it says, as Misdeclared,
  naming what it misses: `--drop <name> drops nothing: the previous snapshot holds no <name>` (a handle: none live),
  which a draft run again over the folder it already wrote meets, since that folder's snapshot dropped the name, so
  reset the directory or run the draft once; `--drop <name> drops what the schema keeps`; a rename's old side the
  snapshot does not hold, or a new side the schema does not declare.

What a declaration drafts:

- **A relation or roster renamed** is renamed in place in Setup, first aside and then to its new name, with its
  constraints, so its rows stay where they are, and a swap (`A=B` and `B=A`) or a chain (`A=B` and `B=C`) is free of the
  names it moves into. A name a rename takes ends its previous holder, which is dropped as declared.
- **A field renamed** is renamed in place, through its own aside name. PostgreSQL carries the rename into what is built
  over it, and each key, index, CHECK and foreign key over it, or on a renamed relation, or
  referencing one, that the schema declares by the same definition is renamed to the name the schema gives it
  (`RENAME CONSTRAINT`, `ALTER INDEX ... RENAME TO`), never built or validated again; what the schema declares otherwise
  is built again. A new field of a table with rows takes a placeholder, and a field whose type changed is converted or
  set aside, as any field is.
- **A family's hidden columns** (`__copy_…`, `__index_…`, `__parent_start_…`, `__before_…`, `__after_…`,
  `__predecessor_…`, `__pred_…`) are named by the laws whose values they hold, so a rename of the owner, the member, the
  count, or a roster or handle a fold's or a side's selection reads, a swap or a chain among them included, renames
  them in place too, `ALTER TABLE ... RENAME COLUMN` through an aside name: no backfill, no table rewrite, every drawn
  value kept. A column whose law the migration changes otherwise is a new column, drawn again.
- **A handle renamed** keeps its code, so every row holding it holds the new name: the migration installs the
  roster's new names constant and points its domain at it.
- **A handle dropped** leaves a hole: its code is never reused, and the roster's domain, validated against the new names
  constant, refuses every row still holding it, naming its table and column. Change or delete those rows in a data
  step first. An ordered roster's handles reordered are refused before anything is drafted, by `generate` at the stage
  codes and by `check`: a stored code never changes meaning, so append new handles, since an ordered roster's order is
  its codes' order. A roster whose order means nothing is `closed.unordered`: its handles may be declared in any order,
  a reorder alone is no change, and a comparison, `orderBy`, `least`, `greatest`, `min`, `max` or a fold's `max` over
  its closed ids is a type error naming `closed.ordered` as the fix. Declaring an existing roster `closed.unordered`
  moves no code: its migration holds no SQL.
- **A variant's arms** grow in place: an arm appended to its roster takes the next code, so its fields come after
  every attribute the variant's composite holds, and the draft adds them, `ALTER TYPE ... ADD ATTRIBUTE`, rewriting no
  stored value, then replaces the variant's domain's CHECK `NOT VALID` and validates it in Publish. A handle renamed
  keeps its code and so its arm's attributes: no SQL for the composite. A handle dropped from a roster an arm's field
  holds is validated through the variant's domain, whose CHECK casts the field to the roster's domain, so a stored
  value holding it refuses the migration, 23514: change those values in a data step first. A variant holds the subset
  of its roster its arms name: an arm taken into it past every arm's code grows the composite in place, and an arm of
  no field taken in or left out changes the domain's CHECK alone, validated in Publish, so a stored value of an arm
  left out refuses the migration, 23514. A field added to an arm of a lower code, a field removed or retyped, or an arm
  with fields removed from the roster or the subset or taken into it below an arm's code would rewrite every stored
  value: the draft refuses it, and the change is a custom migration.
- **`alternatives` and `arm(field, handle)` are gone.** A sum of values, a state and the data each state carries, is a
  variant field (docs/schema.md "Variants"); a sum of relations, arms other relations refer to, is a tagged header with one
  mirrors per arm relation, selecting its handle or handles: `mirrors(on(Arm, ...key), on(select(Header, (h) =>
  h.eq(h.tag, "arm")), ...key))`, or `h.in(h.tag, ["a", "b"])` for an arm relation two handles share, which states
  the same containments `alternatives` stood for. A query attaches an arm relation plainly at the header's key,
  delivered as `"option"`.
- **A roster continues one roster at most:** the one its `--rename` names, or else the one of its own name or an alike
  spelling, unless a rename of another takes that name; any other roster is new, its codes from 0. A closed id or a
  set keeps its codes only on the roster its own continues. Moved to another roster, to or from an integer, renamed
  without `--rename` (a drop and a new roster), or left on a name another roster takes, it is converted at a
  placeholder: there its codes would name other handles, so write each row's new value from what its old one means,
  never a cast.
- **A login renamed** (`--rename @web=@site`) is its PostgreSQL role renamed in place, `ALTER ROLE ... RENAME TO`, so
  its OID, password, memberships and grants survive. A login dropped (`--drop @web`) drops its role, and a new login
  needs its password again. A role is never renamed: it holds no data and no password, so its role, schema, views,
  policies and grants are dropped and created again under the new name.
- **A relation or field dropped** is dropped with its rows or values, a live statement in Publish: the declaration is
  the decision.
- **A name moving to an object of another kind** (a relation taking a removed roster's name, or two of them swapping
  names) sets the old holder aside first, in Setup, under its aside name, with every index it owns, under one confirm
  marker. A declared rename takes it from there; otherwise the end of the
  migration drops it there, as declared.
- **The schema's name names its PostgreSQL schema.** A schema renamed in code is a new, empty schema. When the
  migrations directory holds a schema the config no longer lists, the new schema's first migration drafts its `CREATE
  SCHEMA` commented, as a data loss: the old schema keeps its rows and is never migrated again. Uncomment it to start
  the new schema empty; to keep the rows, keep the old name and delete the folder.

meta.json records the declarations a folder was drafted under, and every drafted statement of every file in its place: a
data loss's, a confirmed group's and one holding a placeholder by its text, every other by the SHA-256 digest of its
tokens. So `check` refuses a confirmed group kept in part and a loss left undecided, and reads every reviewed statement
back as PostgreSQL's scanner reads it: whitespace, comments and the case of unquoted words are yours.

## Legal edits

- Any SQL that ends at the snapshot.
- Resolving markers.
- Backfills and data fixes, batched if large.
- Adding `NN-<words>.sql` files to an unapplied folder, each NN its own.
- `SAVEPOINT` and `ROLLBACK TO`.

## Never edit

- `snapshot.json` and `manifest.json`: together they are the diff base, one snapshot under the fingerprint
  `snapshot.json` records, which every `Db` transaction and the drift check compare with. The app imports
  `snapshot.json` alone; `manifest.json` holds the rest, which only `generate`, `check`, `drift` and `migrate` read.
  `check` says: snapshot.json and manifest.json do not decode as a snapshot, or are the snapshot of another schema;
  restore them from git. They list each installed statement compact on a line of its own, so a review of their diff
  reads each changed statement as one changed line. `manifest.json` records a PL/pgSQL function and a constant by its
  header alone, a function with the SHA-256 of its source: its whole text is in the migration file that installed it.
  `snapshot.json` and each served file record grizzle's format as their `format` member, and `manifest.json`'s seal
  digests both snapshot files under it. A pair whose `snapshot.json` records another format, or none, is read no
  further: `check` says: snapshot.json records another format than this grizzle's, with the format it records and the
  one this grizzle reads and writes; purge and regenerate: drop the installation (grizzle uninstall), empty its
  migrations directory, then run grizzle generate, which drafts the schema afresh in this grizzle's format, and grizzle
  migrate: no grizzle reads another format's records. `generate`, `migrate`, `drift` and `names` refuse it at stage
  `format`, writing nothing (see A new format, below). Never edit one by hand; `grizzle generate` writes a served file
  again, and an application refuses a served file or a `snapshot.json` of another format where it loads it
  (`ArtifactFormat`).
- `served/<login>.json`: a login's workload compiled under the snapshot beside it, which the application serves.
  `check` compiles every login again and holds each file to it byte for byte: the login's served file differs from
  what its workload compiles to under snapshot.json (an ungenerated change), naming the login and the first program
  where they part; run grizzle generate, which writes the served file again.
- `openapi/<login>.json`: a login's OpenAPI 3.2 document, read off its served file alone: one
  `POST /<login>/<role>/<program>` per program of each role, its request body the program's `{ params, facts }`
  (a paged program's `{ params, facts, window }`), its answer a `text/event-stream` of the program's events, and the
  `grizzle-wire` header naming the wire's digest. `check` holds it to the one its served file gives, byte for byte: the
  login's OpenAPI document differs from the one its served file gives (an ungenerated change); run grizzle generate,
  which writes the OpenAPI document again.
- `meta.json`: it records the folder's place in the chain, the renames and drops it was drafted under, every
  drafted statement of every file in its place (by its text, or by the SHA-256 digest of its tokens), its confirmed
  groups and data losses among them, which `check` reads every reviewed file against, the law of each constraint the
  folder installs, by which `migrate` names the law a refused statement of the folder breaks, and each file's lock demand, the most objects one transaction of it locks as
  drafted, which `migrate` holds the server's lock table to before anything runs. `check` says: meta.json does not decode as a
  migration's meta.json, or names another schema; restore it from git, or broken chain: this migration does not start
  where the previous one ends; regenerate; never hand-edit meta.json.
- An applied migration: the database ran exactly that text, and the ledger holds its digest. `migrate` says
  `<folder>/<file>` was edited after it was applied; restore it from git. Put new steps in a new migration.
- Transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `END`, `ABORT`, `PREPARE TRANSACTION`): grizzle runs each file
  as one transaction and records it inside that transaction. `check` says: a migration file runs as one transaction,
  or each statement alone with -- grizzle: no-transaction, and never controls the transaction itself.
- The violation check of a rule over closed relations alone, at the start of Setup: without it the migration installs
  closed rows that break the rule, and no later statement checks them again.
- The violation check of a rule over a query, in Validate: its triggers judge only the writes after it, so without it
  the migration installs a rule the stored rows already break.
- `CONCURRENTLY` turned into a plain build: a plain build blocks every write to the table while it runs.

## A new format

A new grizzle refuses a committed snapshot of another format (stage `format`), and no installation crosses a format:
grizzle reads, converts and rebases nothing another format wrote. Purge and regenerate: drop the installation
(`grizzle uninstall <config>`), empty the schema's migrations directory, run `grizzle generate <config>`, which drafts
the schema afresh as one init migration with its snapshot and served files, commit them, run `grizzle check`, then
`grizzle migrate`.

## Custom migrations

Use one for data work the schema doesn't describe: purges, cutovers, rows that hold a handle you are about to drop, a
backfill before a contract base changes. `grizzle generate <config> --custom --name <name>` writes a folder with only
`meta.json`, whose source and target are the current snapshot. Add `01-<words>.sql`, `02-<words>.sql` and so on; each is
a transaction unless its first line is `-- grizzle: no-transaction`. The catalog must still end at the snapshot.
`grizzle migrate` runs every migration file at SERIALIZABLE, so a reviewer's data step or a custom migration writes like
any direct writer.

## Refusals

A grizzle type refusal (`Refusal<"…">`) reported beside a TypeScript error at its source, such as TS2552 or TS2304, is
that error's cascade: fix the first TypeScript error before reading the refusal.

`check` and `migrate` print each finding as `<where>: <problem>; <fix>`, an unresolved data loss as `<where>: <what
it loses>: <problem>; <fix>`. `migrate` refuses a connection or a process environment it cannot use first, then runs
every check of the committed files, and refuses before connecting. It compiles nothing and applies the files as they
are, so the findings that need the schema compiled (an ungenerated change, an undeclared drop, a roster reordered, a
schema or workload that does not compile) are `check`'s alone.

| Finding | Fix |
| --- | --- |
| the schemas or their logins differ from snapshot.json (an ungenerated change) | run grizzle generate |
| a workload program's access differs from snapshot.json (an ungenerated change) | run grizzle generate |
| the derived facts snapshot.json records differ from the ones the schemas compile to, or are missing (an ungenerated change) | run grizzle generate, which writes snapshot.json again and drafts no migration |
| manifest.json's record of the snapshot differs from the one the schemas compile to (an ungenerated change) | run grizzle generate, which writes manifest.json again and drafts no migration |
| the login's served file differs from what its workload compiles to under snapshot.json (an ungenerated change) | run grizzle generate, which writes the served file again |
| the login has no served file beside snapshot.json (an ungenerated change) | run grizzle generate, which writes the served file |
| the served file is of a login the configuration does not list over the schema | run grizzle generate, which removes the served file |
| the login's OpenAPI document differs from the one its served file gives (an ungenerated change) | run grizzle generate, which writes the OpenAPI document again |
| the login has no OpenAPI document beside snapshot.json (an ungenerated change) | run grizzle generate, which writes the OpenAPI document |
| the OpenAPI document is of a login the configuration does not list over the schema | run grizzle generate, which removes the OpenAPI document |
| the schema or a login's workload does not compile | fix the schema or workload it names, then run grizzle generate |
| grizzle mints no ids (a `serial` or `uuidv7` field) | key the relation by what identifies its fact: its parent's key and its own name or place, `sha256` of its content, a published name and version, or an outside system's id under a contract of its own (docs/schema.md "Identity: natural keys") |
| a variant's arms changed otherwise than in place: an arm of a code past every arm's (appended to its roster or taken into its subset), an arm of no field taken in or left out, or a field appended to the arm of its greatest code migrate in place; an arm with fields left out of the subset or taken in below an arm's code, and a field removed, retyped or added to another arm, rewrite every stored value: a custom migration | write a custom migration (`generate --custom`) that converts the stored values, or append the change as a new arm |
| say whose id this is (a bare `uuid` column) | `contract<typeof clerkUserKey>()("ClerkUserId", uuid)`: name the system the id is of, so two systems' ids are two types; its values are the key's mint's, `mintOf(clerkUserKey)` |
| a plain value, or another contract's, where a contract's value is written (a fact, a parameter, a closed row, `Type.literal`, a conditional's arm; a type error) | make it with the contract's key's mint, `mintOf(key)`, in the module that holds the key; a value compared with a contract's term is its base's |
| a cast, a drawn or accumulated field, a clock binding or a declared function's result makes a contract's values without its key (a type error; `MalformedDescription` from JavaScript) | pass the key where the module that holds it declares the position: `Type.cast(x, C, key)`, `drawn(C, key)`, `accumulated(C, toC(0n), key)`, `clocked(program, { now: "millis" }, { now: key })`, `fn(name, definition, { C: key })`; a contract over another takes every key of its chain, its own first |
| the schema no longer holds a name snapshot.json holds, and no --drop or --rename declares what became of it | run grizzle generate <config> --drop <name>, or --rename <old>=<new> where it was renamed |
| an ordered roster declares a handle before one that holds a lower code in snapshot.json | append new handles, since an ordered roster's order is its codes' order, or declare the roster closed.unordered where its order means nothing |
| unresolved placeholder | write the value or the UPDATE, then delete the marker line |
| unconfirmed group | keep every statement below the marker as drafted, then delete the two marker lines |
| unresolved data loss: a schema's first migration starts it empty beside a schema the configuration no longer lists, and the statement that loses that schema's rows is still commented | to start the new schema empty, uncomment the statement below its -- grizzle: data loss line; to keep the rows, keep the old schema's name and delete the folder |
| snapshot.json and manifest.json do not decode as a snapshot, or are the snapshot of another schema | restore them from git |
| snapshot.json records another format than this grizzle's | purge and regenerate: drop the installation (grizzle uninstall), empty its migrations directory, then run grizzle generate, which drafts the schema afresh in this grizzle's format, and grizzle migrate: no grizzle reads another format's records |
| meta.json does not decode as a migration's meta.json, or names another schema | restore it from git |
| broken chain: this migration does not start where the previous one ends | regenerate; never hand-edit meta.json |
| broken chain: the newest migration does not reach snapshot.json | regenerate; never hand-edit meta.json |
| a migration folder is named <YYYYMMDDHHMMSS>_<name> | fix the file: rename the folder, or move it out of the migrations directory |
| forked chain: two migrations share a timestamp, so both were drafted on one chain | keep one of the two and the snapshot.json its line reached, delete the other, and run grizzle generate again for its change (--custom --name for a custom migration's) |
| a migration file is named NN-<words>.sql, one per NN | fix the file: rename it to NN-<words>.sql with an NN of its own |
| a migration file runs as one transaction, or each statement alone with -- grizzle: no-transaction, and never controls the transaction itself | fix the file: delete the transaction control; SAVEPOINT and ROLLBACK TO are allowed |
| -- grizzle: no-transaction counts only as a file's first line | fix the file: move the marker to the first line, or delete it |
| a closed constant's literal pack was edited after it was drafted: its literal, its comment and its function's name no longer agree | restore the file from git, or regenerate; never hand-edit a literal pack |
| the migrations directory holds what grizzle generate never writes | fix the file: remove it, or move it out of the migrations directory |

Applied files, which only `migrate` can check against the ledger:

- `<folder>/<file>` was edited after it was applied; restore it from git
- `<folder>/<file>` was applied but is missing; restore it from git
- `<folder>/<file>` was added after its folder was applied; move it into a new migration (grizzle generate <config> --custom --name <name>)

`migrate`, `drift`, `roles` and `uninstall` name the stage they stopped at, and its fix:

| Stage | Fix |
| --- | --- |
| connect | check the configuration's connection: its host, port, database, role, password and CA |
| stack | have a superuser raise the server's max_stack_depth to at least 2MB, its default |
| advice | have a superuser load pg_plan_advice for the database (ALTER DATABASE <database> SET session_preload_libraries = 'pg_plan_advice') or the server (shared_preload_libraries = 'pg_plan_advice', a restart), with no role setting its own session_preload_libraries, then run grizzle migrate again |
| blocks | run grizzle migrate against a server built with PostgreSQL's default block_size, 8192 bytes: a server's block size is fixed when it is built |
| wal | have a superuser set the server's wal_level to replica, its default, or logical, and restart it |
| owner | connect as the role that owns the schema |
| input | run grizzle check and fix what it reports |
| busy | wait for the other grizzle migrate to finish, then run it again |
| ledger | the ledger was changed by hand; restore it from a backup |
| edited | restore the applied files from git; put new steps in a new migration |
| order | restore the migrations directory from git, then run grizzle check |
| marker | resolve the markers, delete the marker lines, then run grizzle check |
| decision | decide each data loss as its -- grizzle: data loss line says, then run grizzle check |
| locks | have the server's operator raise max_locks_per_transaction (a restart) or max_connections to what the refusal names, then run grizzle migrate again |
| statement | fix the failing file (an applied file stays as it is), then run grizzle migrate again |
| record | run grizzle migrate again: the failed file rolled back with its ledger row |
| commit | run grizzle migrate again: the ledger tells whether the file committed |
| replication | have a superuser give the decoder login the REPLICATION attribute, or on Amazon RDS a membership in rds_replication, then run grizzle migrate again |
| drift | undo the change made outside a migration, or reach the snapshot with a new migration (grizzle generate <config> --custom --name <name>) |
| unchecked | the check changed nothing: run grizzle drift again, and report it with this output if it is refused the same way |
| uninstall | nothing was dropped: revoke or drop what the DETAIL names in the database it names, a grant to a role of the installation made outside it, then run grizzle uninstall again |

Before `statement`, nothing ran. At `statement`, `record` or `commit`, the files before the failed one stay applied
and a rerun resumes at it. At `drift`, every folder applied but the catalog differs from the snapshot. At `unchecked`,
the drift check reached no verdict: the snapshot did not render, the ledger or the catalog could not be read, or the
snapshot could not be built beside the schema to compare; the check changed nothing, since it rolls back. At
`uninstall`, the installation's roles or schemas could not be read, or PostgreSQL refused the one transaction that drops
them, most often DROP ROLE with 2BP01 while a role holds a privilege or an object in another database, its DETAIL naming
that database; nothing was dropped. A refusal
the server raised carries its SQLSTATE, the constraint it names, and PostgreSQL's message, DETAIL and HINT as given.

A direct SQL writer, psql included, meets these refusals of its own, among the others docs/access.md "Direct SQL access" lists:

| Refusal | Fix |
| --- | --- |
| 25000: a write to a grizzle table requires SERIALIZABLE | write at SERIALIZABLE: BEGIN ISOLATION LEVEL SERIALIZABLE; (a table whose every writer is certified READ COMMITTED has no guard) |
| 42501: permission denied, or a new row violating a row-security policy | SET ROLE to a role whose world holds the relation and the row |
| 40001 or 40P01: a serialization failure or a deadlock | run the transaction again |

The command line's own refusals, by stage. A refusal at stage config states its own fix: the file, setting or export
to fix, or the compiler's refusal of a schema or login with its fix, and no line of the stage follows it.

| Stage | Fix |
| --- | --- |
| usage | run grizzle --help for the commands |
| environment | unset the variable it names in the environment grizzle runs in, then run the command again |
| filesystem | fix the migrations directory, then run grizzle check |
| snapshot | restore snapshot.json, manifest.json and the migration folders from git |
| format | purge and regenerate: drop the installation (grizzle uninstall), empty its migrations directory, then run grizzle generate, which drafts the schema afresh in this grizzle's format, and grizzle migrate: no grizzle reads another format's records |
| codes | append new handles, since an ordered roster's order is its codes' order, or declare the roster closed.unordered where its order means nothing |
| generate | fix the schema or workload it names, then run grizzle generate again |

## Deploy

- Run `grizzle migrate` as the role that owns the schema and the database. No snapshot or migration names that role,
  so dev and prod may use different ones; a schema owned by another role is refused at the stage owner. grizzle sets
  no database default.
  Each file first takes the ledger's exclusive lock, which waits for the
  `Db` transactions in flight; from then until the migration's last file commits, no `Db` call runs and no `Db` opens,
  so plan migrations as downtime.
- Every transaction grizzle opens names its level, and a direct SQL writer of a grizzle table writes at SERIALIZABLE:
  grizzle sets no database default, so psql starts at the server's default, and a write below SERIALIZABLE on a grizzle
  table is refused with 25000 by the table's guard trigger; have tools that only read state say READ ONLY. A table some role writes, every writer of which is certified READ COMMITTED and holds only INSERT and
  SELECT on it, has no guard: a direct writer there meets its role's grants and the table's constraints alone. A
  migration that changes whether a table qualifies drops or creates its guard.
- Size the server's lock table, `max_locks_per_transaction × (max_connections + autovacuum_worker_slots +
  max_worker_processes + max_wal_senders + 2 + max_prepared_transactions)` objects (a server-start setting), above the
  largest lock demand `grizzle generate` prints, plus what every other session locks while a migration runs. `migrate`
  reads those settings before anything runs and refuses at the stage locks an apply whose largest transaction (a
  file's demand as its meta.json states it, or the drift check of a schema's first migration, which replays every
  object of the snapshot) the table cannot hold, naming the least `max_locks_per_transaction` or `max_connections` that
  holds it. A file edited past its record, or a custom migration's, states no demand.
- Set `max_pred_locks_per_transaction = 2048` on the server (a server-start setting): under load PostgreSQL may
  report 53200, out of shared memory, with a HINT to raise it, and that failure is not retryable. Keep transactions
  short everywhere on the cluster: a committed write's and a read's locks are held until every older transaction
  ends, in any database and at any isolation level (a DROP DATABASE waiting on its checkpoint included), and a long one
  also brings more 40001s.
- Connect straight to PostgreSQL: PgBouncer is not supported.
- Every server setting grizzle does not pin is the database owner's, set on the database or the server: a login's
  role holds exactly its pinned defaults, and the drift check refuses one that holds any other. A login's role pins only
  what a grizzle guarantee rests on: `search_path`, `extra_float_digits = 1`, `DateStyle = 'ISO, YMD'`,
  `bytea_output = hex`, `lc_monetary`, `lc_numeric` and `lc_time` at `C.UTF-8`, and for a login whose roles search
  vectors
  `hnsw.iterative_scan = strict_order`. So `hnsw.ef_search`, `hnsw.max_scan_tuples` and `hnsw.scan_mem_multiplier`
  decide which rows an `approximateNearest` read returns and how many; JIT is the owner's too, and on a server built
  with LLVM `jit_above_cost` can make a large statement compile its plan first; and the server's messages come in its
  `lc_messages` language.
- Serve the login's committed workload, pass it to the login's `DbLayer.make`, and open each `Db` through it, all from
  `@bjornpagen/grizzle/runtime`, importing the login as a type alone, so the application evaluates no schema module:

  ```ts
  import webFile from "./migrations/blog/served/web.json" with { type: "json" }
  import type { Web } from "./schema.ts"
  export const WebServed = served<typeof Web>(webFile, "web")
  export const WebLayer = DbLayer.make({ ...connection, login: WebServed, password, pool, verify })
  const db = yield* Db.open(WebServed.roles.member, { token })
  const feed = yield* db.workload.memberFeed.once({ params: {}, facts: {} })
  ```

  `connection` is the config's connection without its `role` and its password, which are the migration role's
  (`DbLayer.make` refuses a `role` as an unknown setting): `driver: pgDriver` (`import pgDriver from "pg"`), the
  `transport` (`{ kind: "sslRequest", host, port, open: () => new net.Socket(), ca, servername }`, always
  verify-full) and the `database`. `password` is the login's own, and `pool` is `{ max }`:
  each session is kept open once opened, for the layer's life, never closed for being idle.
  grizzle states no number of its own: a `Db` call waits for a session until it gets one or is interrupted, a
  connection attempt for the server's answer or the operating system's failure, and an interrupted statement ends once
  the server has stopped it, a CancelRequest sent at the interruption and again at each answer of the server until it
  has, and its session is never used again.

  `DbLayer.make` loads the served file once and compiles nothing; it refuses, at stage `config`, a file of another
  login than the name `served` was given. `grizzle check` refuses a served file that is not its login's compile under
  the committed snapshot: a program added, renamed, dropped or edited since the file was generated; run `grizzle
  generate`. `roleNameOf(WebServed, connection)` is the login's PostgreSQL role, the file's stem under the connection's
  `rolePrefix`. `WebServed.decoder` is the installation's decoder login the file names, typed by the login: a
  `DecoderLogin` where its type proves it serves a read, so `roleNameOf(WebServed.decoder, connection)` is the role
  `LiveSource.layer` logs in as, whose password is the layer's, with no narrowing; `{ kind: "none" }` where it proves it
  serves none; either, narrowed by `kind`, where its type cannot tell (`AnyLogin`). `WebServed.roles.member.isolation` is the level generate certified the
  role's writes at, `readCommitted` or `serializable`: read a login's certificate there, never from the file's JSON,
  whose encoding is grizzle's own. `Db.open` contacts nothing and
  checks nothing of the database: grizzle assumes it is the one the snapshot was migrated to, and the request's first
  call is its first round trip. `token` is required exactly when the role
  declares a context of a token's claims, and `attested` exactly when it declares an attested one; the layer's
  `verify` refuses a token at the stage `token`, and a claim of a refined field is judged by its domain where a
  statement reads it. `grizzle migrate` judges the database after every apply and when
  nothing is pending, and refuses drift: the login's and the role's settings and privileges exactly the snapshot's,
  the login LOGIN NOINHERIT and the role NOLOGIN with no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS, a
  role's members its login and the migration identity PostgreSQL makes a member of each role it creates, row security
  enabled and not forced on every table the role writes through a query entry that leaves rows out, view definitions
  and policies. A table no role writes that way has no row security and no policy: each policy would be true, and the
  grants alone decide its writes. `grizzle drift` runs that same check alone and applies nothing (a folder not yet
  applied is a mismatch of its own), so it can watch a production database from CI or a schedule; it connects as the
  migration identity, since the check replays the snapshot into a scratch schema in a transaction it rolls back.
- Open a `Db` per request or handler: `Db.open` sends nothing, so this costs no round trip.
- A paged member's window takes any safe integer of at least 1 as its size: there is no default and no cap.
- Every transaction of a `Db` checks the ledger first, in the same round trip, and runs nothing unless the database
  holds its snapshot: while a migration runs, its calls fail with a `stale` `CallError` (reason `Migrating`), and once a
  migration to another snapshot completed, with `stale` (reason `Migrated`). A write with nothing to write sends its
  transaction and meets the check too, so a stale `Db` never answers it `unchanged`. Deploy the code that
  carries the new snapshot.json, and open new `Db`s with it.
- Handle a call's failure by its `CallError`'s `_tag`, one of a closed set (`Effect.catchTag("refused", ...)`), and
  its `retry`: `"safe"` when the same
  call may succeed run again (`transient`, its `reason` naming the concurrent work that refused it; `unavailable`, its
  `reason` a `{ _tag }` naming why no session could be had for now, the network, the server or a released layer, with
  the SQLSTATE or socket code of a cause no name classifies; `transport`; `tokenExpired`), `"never"` otherwise
  (`input`; `paramRejected`, its `param` the place whose value PostgreSQL refused by its pattern, a `str.bytes`
  bound among them, `{ kind: "scalar", name }` or `{ kind: "field", name, field }` for a relation parameter's field;
  `tokenRefused`, `refused`, `outsideWorld`, `credentialRefused`, its `reason` naming how the connection was not
  authenticated: `passwordFailed`, `passwordRefused`, `loginRefused`, `tlsUnverified`, `driverRefused`; `stale`,
  `commitUnknown`, `failed`, and over HTTP `route`). A configuration fault is `credentialRefused`; a database
  that is down is `unavailable`. Its `message` is the failure's own words, the server's report
  where the database refused; read facts from the tag's members, never from the message. grizzle runs no call again:
  a `transient` or any other `"safe"` failure is yours to run again (a den step runs again past one); after
  `commitUnknown`, read back before running the call again. `DbLayer.make` and `Db.open` fail with `OpenError`, whose tagged `reason` `Effect.catchReason`
  reaches; every error and reason class is exported as a value, so a test builds the exact value, never a cast.
- A broken rule is a write's `refused` `CallError`, its `retry` `"never"`. It carries `refused`,
  `{ kind: "every" | "first" | "some", laws }`, whose `laws` are never empty, each `{ law, id, by }`: `law` the law as
  the schema states it, such as `{ kind: "check", relation: "Grant", name: "WithinGrant" }`, which you match on
  directly, never on a constraint's name; `id` its identity, a LawId, or a GeneratedLawId for a generated field's law;
  and `by` the installed object that refused it, `{ kind: "constraint", table, name }`, `{ kind: "domain", domain,
  name }`, `{ kind: "statement" }` for a write statement's refusal, or `{ kind: "notNull", table, column }` for a
  generated column. A pattern's law names its field, `{ kind: "pattern", relation, field, patterns }`, each `{ source, flags }`
  spelled as that field spells it, every pattern of a `str.and` in order and one law for the field all the same, so two
  fields of one pattern are two laws. `lawsOf(schema)` (from `@bjornpagen/grizzle/compile`, as are `lawsByStatement`,
  `constraintNamesOf`, `rowEvaluator`, `insertPreview` and `codecText`) lists every law a schema states,
  each once, as `{ law, id }`, `law` as an outcome names it and `id` the one a refused law carries: each table's primary key, each statement's laws, each contract's, each stored
  field's pattern law and each generated field's law, none for a pattern every text matches, which grizzle drops, or
  for a contract's pattern, whose law is the contract's. Key your names for laws by these ids and read a refusal by
  `id`, never through a table of ids you keep, and never keep a list of laws by hand. For one statement's laws, bind `const lawsOfStatement = lawsByStatement(schema)` once, which
  compiles, then look each statement up with `lawsOfStatement(statement)`: its laws from lawsOf's list, in its order, a
  mirrors' two containments, none for `mutable`, a law two statements state each
  one's; a statement no level of the schema states throws `CompileError`. `every` names every law grizzle
  decides the write broke. `first` names the laws of the CHECK PostgreSQL tried first, where grizzle cannot decide a
  row's checks on the host (a row only PostgreSQL computes, such
  as a query's, or a check that reads a value grizzle does not hold, such as a count or an end a put keeps from the
  stored row): the row may break other checks too, and another version of grizzle may name another of them. `some`
  names two laws or more of one PostgreSQL object, a family's merged foreign key or a domain several fields share,
  where nothing decides which of them the row broke: at least one did. Its `witness` is the key of a row you stated
  that breaks them, or `unreported` where grizzle cannot tell which row did, such as two family owners the write
  inserts without reading them, either of which may be a stored one inserted again: never assume a key is there.
- No read raises an arithmetic error on a row, but arithmetic over a `numeric`, an `exactInteger` or an
  `exactMoney` field, whose result past numeric's own limit PostgreSQL refuses with 22003: catch no other 22003, nor
  22012 or 2201F, around a query. Integer arithmetic is
  exact and delivers `bigint`, money arithmetic exact `Money`, and floats are IEEE 754 (`x / 0.0` is ±Infinity). A
  partial operation needs its precondition proved, by a literal's type (`Num.div(x, 7n)`), by a contract that
  declares it (`contract<typeof divisorKey>()("Divisor", int8, (v) => Logic.ne(v, 0n), { proves: ["nonzero"] })`) or by a guard:
  `Logic.when(Num.nonzero(b), (b) => Num.div(a, b), 0n)`, the guards `Num.nonzero`,
  `Num.nonnegative`, `Num.positive`, `Num.isFinite` and `Num.within(x, low, high)`. A guard's subject
  may be a parameter (`Logic.when(Num.nonzero(d), (d) => Num.div(x, d), 0n)` over `r.param("d",
  int8)`), and a parameter of a contract that declares a fact has it, so
  `Num.div(x, Type.base(r.param("d", Divisor)))` needs no guard. A parameter is a term of its declared type
  everywhere, first operand included. An unproved
  divisor is a type error naming the guard; an unproved narrowing or power is `CompileError` reason
  `PartialOperation`, whose `guard` is the code to write. A contract's facts are exactly its `proves`: a fact its
  predicate implies but `proves` leaves out is refused, and the refusal names the declaration to add. Narrow an exact
  integer into an integer field with
  `Type.cast` under `Num.within`, and a sum, a mean or numeric arithmetic into a `numeric(p, s)` field the
  same way: a ChangeSet member writes each field at its own type, a numeric of another precision or scale included.
- Test text with `Text.matches(x, pattern)`, `Text.startsWith`, `Text.endsWith` and `Text.contains`, never a regex
  or a LIKE in your code. `Text.contains(haystack, needle)` reads its needle as characters, so a parameter's `%`, `_`
  and `\` need no escaping; a query filters by it with no index, and a case-blind search folds both sides:
  `Logic.eq(Text.contains(Text.lowerAscii(name), Text.lowerAscii(term)), true)`. A pattern is `str.regex`'s grammar under `"u"`, anchored by `^` and `$`: a `Text.pattern(source)`, made once
  as a module constant and admitted there (`const digits = Text.pattern("^[0-9]+$")`), never a bare string; or a
  closed relation's text payload, `Text.matches(lexical, ValueDomain.at("pattern", domain))`, every value of which
  the compiler measures; a pattern held in an ordinary field or a parameter is refused. A `Text.pattern`'s match is a
  guard: `Logic.when(Text.matches(x, digits), (x) => …, otherwise)`. `Text.concat` builds text in checks,
  generated fields and folds, and in a query over operands whose types bound its bytes within `byteaMaxLength`, a
  head among them (`find({ module: Text.concat(path, ".js") })` over a `str.bytes`-bounded `path`); over texts of any
  length, compare a text with a concatenation (`Logic.eq(t, Text.concat(a, b))`)
  and it is decided as t's equality with the concatenation built under its bytes' guard, so a probe reads t by its
  key's index, a concatenation nested in it read through as its parts
  (`Text.concat(Text.concat(a, b), c)` is a, b and c, built in order). Its first operand is a term: write a leading literal as
  `Type.literal(Prose, "item-")`. Normalize text with `Text.translate(x, from, to)`, strings of one length with
  each character of `from` once (`Text.translate(title, "\t\n\r", "   ")` for `xs:normalizedString`), and fold
  ASCII case with `Text.lowerAscii(x)`, never a locale's `lower`. A translation is text of the image of `x`'s
  pattern, so store it as `generated(T, Type.cast(Text.translate(…), T))` for any refined text `T` the image
  lies in, which compilation proves; translate in a query only over a pattern that bounds its length, though a query
  folds ASCII case (`Text.lowerAscii`) over any text, so fold an unbounded attribute in the query rather than in a
  stored copy of it. Cut a text at the first of a set of characters with `Text.cutBefore(x, chars)` and
  `Text.cutFrom(x, chars)` (`Text.cutBefore(href, "?#")` is an href's path, `Text.cutFrom` its query and fragment,
  the two concatenating to `x`), by code points, in a query over any text; replace every occurrence of a text with
  `Text.replace(x, from, to)` (`Text.replace(name, "%", "%25")`), in a query over texts whose patterns bound it. Split a
  text at a separator character in a rule with `r.split(path, "/")` (`{ at, piece }`, the empty text one empty piece)
  and take the text after a prefix with `r.rest(x, prefix)` (`{ rest }`, a row only where `x` starts with `prefix`;
  `r.not(r.rest(x, prefix), {})` for the others); split a text at the last occurrence of a separator character with
  `r.splitLast(x, ".")` (`{ before, after }`, a row only where `x` holds it, either side possibly empty), so a path's
  extension as Node's `path.posix.extname` reads it is `r.splitLast(Text.concat(Type.literal(Slash, "/"), path), "/")`'s
  `after` as `segment`, then `r.splitLast(segment, ".")`'s `{ before: stem, after: extension }` where
  `r.ne(stem, "")` and `r.ne(extension, "")`; a split's text may be any text term of the rule, computed or not;
  percent-decode a URI path with `r.decodedPath(x)` (`{ path }`, a
  row only where `x` is well-formed UTF-8 escapes with no escaped `/`, U+0000 or `%2E` dot segment), and resolve a
  reference within a base with `r.resolvedWithin(base, reference)` (`{ target }`, none where a `..` climbs above the
  base's root, an href outside a package), never a stored copy of the pieces or a host decode or resolution. For XML Schema's whiteSpace facets use `Text.replaceWhitespace(x)` (tab, LF and CR to spaces)
  and `Text.collapse(x)` (runs to one space, none at either end), never a regex of your own; cast a collapse into a
  refined text the same way, such as `str.regex("^(?:[^ \\t\\n\\r]+(?: [^ \\t\\n\\r]+)*)?$", "su")` for any
  text. A collapse, a translation and a concatenation keep their operands' byte bound, a translation to wider
  characters by the most its image can take, so a `str.bytes` text normalized from one casts back into it:
  `generated(Key, Type.cast(Text.lowerAscii(Text.collapse(row.lang)), Key))` for `lang` a `Key`. A query's
  `Text.matches`, like its translate, needs a pattern that bounds the subject's length: PostgreSQL's regex engine
  widens its subject fourfold. A collapse reads any text. Fold an ordered family's texts with `Monoid.concat`, naming
  its `(before, after)` pair, and write each member's separator into its own step value; type the accumulators by a
  bounded pattern, `str.regex("^.{0,64}$", "su")`, since the family's axes key each running text and an unbounded one
  is UnrepresentableKey. The step may be any text, a generated piece at a byte bound among them,
  `generated(T, Text.concat(…))` for a refined `T`: a generated field and each accumulator is of its type but for
  its own pattern and byte bound, which its domain checks, refusing a write whose value lies outside it.
- Read a local wall clock with `Time.wall(t, zone)`, never the host's clock or a zone text: `t` a `bigint` of
  milliseconds since the Unix epoch, a clocked `now` in `"millis"` among them, and `zone` a closed id of a zone roster,
  `closed.zones("Zone", ["America/Chicago", "Etc/UTC"])`, each handle an Area/Location IANA name (a one-component name
  such as `UTC`, `EST` or `EST5EDT` is refused: PostgreSQL reads it as an abbreviation first). It is the wall clock in
  milliseconds since the local epoch, by the server's tzdata, in a query only: the host holds no tzdata, so a check, a
  contract predicate or a generated field refuses it. The migration that installs the roster reads each handle as a zone
  first and refuses one the server lacks (22023). The local day is `(w - intoDay) / 86400000` with `intoDay = ((w %
  86400000) + 86400000) % 86400000`, its weekday `((day + 4) % 7 + 7) % 7`, Sunday 0, and its date
  `Time.dateOfEpochDay(day)`; `Time.epochDay(date)` is a date's days after 1970-01-01. A stored `instant` counts
  microseconds: pass `Type.cast(Num.div(Type.base(at), 1000n), int8)`.
- Join patterns a text must all match, XML Schema's pattern facets among them, with
  `str.and(str.regex(p), str.regex(q))`, never one regex you intersect by hand: each pattern is held to PostgreSQL's
  limits alone and its domain tests each in turn, so a conjunction costs the sum of its patterns, never their product,
  and its host type is theirs intersected. Inside `Logic.when(Text.matches(x, p), (x) => …)` the branch's
  parameter is text of its own patterns and `p` together, so nested matches prove a cast into a conjunction.
- Write a `str.regex` or `Text.pattern` source in JavaScript's syntax under `u`, with no lookahead or lookbehind,
  `\p{…}` or `\P{…}`, `\s` or `\S`, `\b` or `\B`, backreference, named group, inline modifier, lazy quantifier or
  repetition bound above 255, and with some text it matches. TypeScript accepts each of these, but the relation,
  contract or `Text.pattern` built over the source refuses it as `UnsupportedOperation`, naming the construct and
  its offset. Spell an explicit class instead of `\s` or `\p{…}`.
- A set of a roster's handles, `bits(X)`, has the algebra `Bits.union`, `Bits.intersection`,
  `Bits.difference`, `Bits.cardinality`, `Bits.subset`, `Bits.disjoint` and `Bits.singleton`, and no
  complement. Test a closed id's membership in a set as `Bits.subset(Bits.singleton(id), set)`:
  `Bits.singleton(id)` is the set of the id's one handle, and a NULL id gives a NULL set.
- A closed relation read at a key no row holds: `C.at(field, k…)` is NULL there, which a check refuses, as does a
  generated field's NOT NULL, on `{ kind: "generated", relation, field }` (23502 on its column to a direct writer;
  grizzle refuses a nested write or a family fill that reads the field before any SQL, with the same outcome), and
  `C.has(k…)` is false there, so say what holds where the key is absent with `has`, never with a null-object row:
  `Logic.or([Logic.not(C.has(k…)), φ(C.at(field, k…))])`, or a value there,
  `Logic.cond(C.has(k…), C.at(field, k…), d)`. Every closed read is NULL where a key value is NULL.
- A `bytes` field, a `Uint8Array`, is written and read back whole and nothing more: never in a key, a rule's side, a
  filter, a parameter, a contract, a generated or accumulated field, or a scalar term but `Crypto.sha256(x)`, its
  SHA-256 digest, a `sha256` value of 32 bytes (`Sha256` on the host), never a hex text. Store a digest PostgreSQL
  computes from the bytes, never one the caller sends: `generated(sha256, Crypto.sha256(row.content))`. A value holds at most 1,073,741,819
  bytes (`byteaMaxLength`), PostgreSQL's longest bytea, and is read back in chunks, one round trip still; a write reads
  back only its SHA-256 digest. grizzle copies a value once, as the call is sent; one changed
  before then is `bytesChanged`. An attachment whose rows hold one is a statement of its own, so under rows that read
  `.approximateNearest` attach in a second query instead.
- A key, a UNIQUE, a family's axis and a reference's target hold each column as itself, never by a digest grizzle
  makes: one whose widest entry, in any order of its columns, could pass PostgreSQL's 2,704-byte B-tree limit is
  UnrepresentableKey when the schema compiles, one refusal naming every such key, so one generate lists them all.
  Give each text in it a byte bound, `str.bytes(n, …)`, each numeric its
  precision, or key by a digest field you declare, `generated(sha256, Crypto.sha256(row.body))`, whose 32 bytes every
  key holds. A digest the host states is `Sha256.ofText(text)` or `Sha256.ofBytes(bytes)`; one of any other length is
  refused where it is passed (`sha256Value`).
  A lookup's index holds only the columns that fit its entry: an equality on a text of no byte bound is a filter beside
  it, which the index's comment names, so bound a text a program looks rows up by.
- A call's flight, every byte the driver writes for its one round trip, is at most 1,908,342,784 bytes
  (`flightMaxBytes`), the most one write over TLS carries. A longer one is `InputTooLarge` (`flight`) before anything is
  sent, nothing ran, and grizzle never splits it into more round trips: split the input across calls.
- Store an exact value of any size as it is: `exactInteger` (a `bigint`) holds what integer arithmetic delivers,
  `exactMoney` (a `Money` of any count of cents) what money arithmetic and a money sum deliver, so a member's head
  `{ total: Num.add(total, amount) }`, a `generated(exactInteger, Num.mul(a, b))` or a derived relation's money sum needs no
  `Type.cast`. Each is numeric of no typmod, its column CHECKed to scale 0 or to money's 2, so a direct writer's 1.5,
  5.0, NaN or infinity is 23514. Never key, UNIQUE or axis by one (`UnrepresentableKey`, exactValue): key by a
  `numeric(p, 0)` or `int8`, or a `numeric(p, 2)` or `money`. No contract is over one, and no closed
  relation's, context's or declared function's field is one. Read a `Money` past a signed 64-bit count with its
  `minorUnits`; `Money.exact(cents)` writes one.
- A numeric field declares its precision and scale, `numeric(p, s)`, or is `numeric`, PostgreSQL's numeric of
  no typmod, a `Numeric` passed as it is: type a declared function that `returns numeric` `returns: numeric`, never
  a typmod it does not state, which rounds its value. No key holds a `numeric`, which has no byte bound: key by
  `numeric(p, s)`, whose precision bounds it. A sum, a mean or an operation's
  numeric result carries the digits its computation proves, and one past 131,072 integer digits is `ResourceBound`,
  but over a `numeric` operand, where PostgreSQL's own limit refuses a value past it (22003). Convert an integer, money or a float to numeric with `Num.numeric(x)`, never a cast to
  a typmod you do not mean.
- Parse an `xs:decimal` text with `Text.parseNumeric(x)`, the exact numeric of any digits, never a cast into the
  widest `numeric(p, s)` with a lexical form, whose form ends at 256 integer and 255 fraction digits. Its text is
  `numericText` within `numericTextMaxBytes` (16,384) bytes: type it `str.bytes(16384, str.regex(numericText.source))`, or
  guard it, `Logic.when(Text.matches(x, numericText), (x) => Logic.when(Num.within(Text.octetLength(x),
  0, 16384), () => Text.parseNumeric(x), otherwise), otherwise)`. A double's text of any digits is
  `Text.parseFloat8(x)` over `float8Text`. Never make an `otherwise` stand for a value, an infinity or a sentinel:
  a rule over it then passes on a text that does not parse. State what the rule holds of such a text in the rule.
  Parse a padded value as XML Schema reads it, collapsed first:
  `Logic.when(Text.matches(Text.collapse(x), float8Text), (x) => Text.parseFloat8(x), otherwise)`.
- Each login is a PostgreSQL role, `roleNameOf(login, connection)`, and each role a PostgreSQL role that cannot log
  in, `roleNameOf(role, connection)`, with its schema of views, `schemaNameOf(role)`; the schema's own is
  `schemaNameOf(schema)`. Take every one from there, never spell or rebuild one: each is the name the installation
  creates, and each throws CompileError for a name the installation refuses. A role is its stem, which `generate`
  commits, under the connection's `rolePrefix` (`{}` for none): two installations of one schema share a cluster, each
  in its own database under its own prefix, from one committed output. A prefix is at most 43 bytes, so the decoder
  login, `__live_<digest>`, and a role set aside while logins are renamed, `__aside_<digest>`, fit under it. Drafted SQL names each role as psql's variable
  `:"<stem>"` and the current database as `:"DBNAME"`, which `migrate` fills; write a role the same way in a data step. The migration that adds a login creates its role; the operator
  gives it a password, or, for an RDS IAM login, `GRANT rds_iam TO <role> WITH INHERIT TRUE, SET FALSE`, and the IAM
  signer's user name is `roleNameOf(login, connection)`. grizzle never sets either. The migration that gives the
  installation its live source, once a login serves a read, creates its decoder login, which a reading login's served
  file names, `roleNameOf(served.decoder, connection)`; the operator gives it a password too, the one
  `LiveSource.layer` takes. Never find it by scanning `pg_roles`. A login holds only USAGE on the
  schema, SELECT on the ledger and EXECUTE on the snapshot guard, the lock and the check every transaction takes;
  everything else it does as one of its roles, one per transaction. The drift check takes a membership beyond the
  login's roles as no drift only with SET FALSE and no ADMIN, and only while the login's effective privileges on the
  installation stay exactly those three: `rds_iam` holds nothing there, so it is no drift, and a membership handing the
  login any privilege or ownership is.
- A role declares the contexts its `Db`'s facts hold, `role(S, "student", wholeEntriesOf(S), { insert, contexts:
  [Session, Acting] })`: its `Db` decodes exactly those, each from its one source, a `context(...)` from the token's
  claims (one of `{ claim: "act" }` from the nested `act` object, no row where the token has none), an
  `attested(...)` from what the server attests (`Db.open`'s `attested`, `httpHandler`'s `attest(request)`), never a
  token's claim: a fact a client must not choose, a request's address from the edge's header among them
  (`attested("Origin", { address: inet })`, `Inet.parse(header)`), is attested, never claimed. Its query entries
  and the programs on it match only those. A program over the
  schema that matches `Session` runs on every full role declaring `Session`: write it once over the schema, never once
  per role, and never add a query entry only to make a context available. A query entry matching an undeclared context
  is a type error (`RoleRefused` `entryContext`); a program matching one is a type error in a workload over the role
  and `OutsideRole` (`context`) when generate compiles it for a role that does not declare it.
- A role is over a schema and is no schema itself: `role`, `login`, `schema.extend`, `wholeEntriesOf`,
  `wholeWritesOf`, `writableNamesOf`, `lawsOf` and `lawsByStatement` take a schema, and a role passed to one is a type
  error; `query`, `ChangeSet.empty` and `workload` take either. A role's `insert` and `write` name each table once
  between them: a name listed twice is a type error, and `RoleRefused` (`writeTwice`) for a JavaScript caller.
- A role lists each entry it writes under the mode it writes that table by, least privilege per table: `insert` the
  entries it only adds to, where it holds INSERT and SELECT and no UPDATE or DELETE, and `write` the open ones it
  changes, each over a table declared `mutable` inside a unit, where it holds UPDATE and DELETE as well. A closed table
  under `write` is a type error for a whole entry and `RoleRefused` (`writeClosed`) for any, so a writer that
  puts one open table beside closed facts in one commit lists the open table under `write` and the rest under
  `insert`. A direct writer's UPDATE or DELETE of an `insert` entry is 42501, and a ChangeSet that deletes from or puts
  one, or adds an open one as a member under a mutable owner (which updates the owner's count), is `OutsideRole`
  (`insert`) when it compiles; a closed member, written by `insert` alone, recounts its mutable owner. A full role is `role(S, name, wholeEntriesOf(S), wholeWritesOf(S))`: every closed table under
  `insert`, every open one under `write`.
- A role's writes run READ COMMITTED only where `grizzle generate` certifies it from the statements its ChangeSets
  send, against every other writer (docs/errors-and-concurrency.md "READ COMMITTED writes"); every other role runs SERIALIZABLE, and reads are
  always SERIALIZABLE READ ONLY. generate prints each role's level, a SERIALIZABLE one with the count of each condition
  it fails: `form` (a ChangeSet with no READ COMMITTED form), `members` (no ChangeSet), `privileges` (it states
  `write`, or some role updates or deletes what it writes),
  `laws` (a rule over a query over what it writes), `absence` (a read of the absence or a count of what it writes),
  `snapshot` and `pivot` (other calls' rows read across statements, as anything but whole immutable groups keyed by
  values the call states once, or by a foreign key check of a row that can change), `writers` (a SERIALIZABLE role
  writing what it writes, or writing what it reads while reading other calls' rows itself), and `facts` (an object
  the certifier cannot name). Under the role's line comes why: for each reason it fails by itself, a line
  `<condition>, <where>: <what fails>; <fix>`, where is `the role`, `relation R`, `member M, relation R` or
  `member M, statement N, relation R` (N the statement's place among those a call of ChangeSet M sends); or, where it
  fails none by itself, a line `fix login L, role R first (<counts>)` per role that runs SERIALIZABLE and gives it one
  (`laws`, a SERIALIZABLE ChangeSet reading what it writes, and `writers`): fix those roles first. The fixes:
  - `form`: move each ChangeSet that inserts into a relation whose primary key holds a range to a role of its own, which runs SERIALIZABLE: such a write has no READ COMMITTED form
  - `facts`: name no table or function in the role's ChangeSets that is no relation of the installation; where grizzle named it (a function of its own, named __), report the line to grizzle
  - `members`: write through a ChangeSet in the login's workload, or state neither write nor insert on the role: a role that writes by direct SQL alone is judged to write all its grants permit
  - `privileges`: state insert, not write, on the relation, and let no role update or delete a relation the role writes: record each change as an inserted fact
  - `laws`: make each law over the relation native, a key or a foreign key PostgreSQL checks, or one the write can break only by the row it inserts, as one row of a match
  - `absence`: read no absence (NOT EXISTS, a negation) and no count of a relation the role writes, in any role's ChangeSet: state the fact as a row and read it by its key
  - `snapshot`: read every row other calls write in one statement, by a whole declared key of an insert-only relation, a family's counted members or a relation no role writes, beside no foreign key check of rows other calls write
  - `pivot`: in a ChangeSet that reads other calls' rows and writes, read them only positively, each by a whole declared key of an insert-only relation, a family's counted members or a relation no role writes, join every row it writes with each of them, and check foreign keys only of rows no role updates

  Clear one by changing the schema or the workload, never by a flag: there is none. A role
  that inserts rows referencing content another role maintains publishes the keys it references: every writer of
  that content states `insert` on it, an insert-only published relation holds the keys with a foreign key into the
  content, a `publisher` role that inserts nothing else writes it, and the referencing role's foreign keys point at
  the published relation. A published relation may also be deleted and inserted again (a content replace that
  republishes its keys) by roles that never update it: every login that deletes it fences it, so each of its
  ChangeSets that writes it sends `LOCK TABLE ... IN EXCLUSIVE MODE` on it as the login before its snapshot, migrate
  grants the login MAINTAIN on it, and generate prints `login L fences R` with the read committed roles that rely on
  it. A direct transaction of that login writing the relation begins with the same LOCK. A read committed call whose
  foreign key check reads it waits while a fenced write runs, and may meet a 40P01, a `transient` `CallError`
  whose `reason` is `Deadlock`.
  `compileServed` of other programs than the committed workload serves every role SERIALIZABLE.
- A claim of work races a key: `race(R)` among the rules makes R's primary key first come, first held, so an insertion
  at a held key meets the holder's row in `delta.met(R)` and is never refused for differing from it (docs/errors-and-concurrency.md "Races").
  The claimer names the key and a fresh holder; a member for the winner alone reads R back at that key with its own
  holder in a later statement; a reclaim inserts the next attempt from the expired one, read by its whole key. Each is
  certified READ COMMITTED; a claim that searches for its work (the next due item, a count of holders, a claimed
  item's absence) runs SERIALIZABLE. Two raced tables in two statements can be won one and met the other.
- A role's `write` lists a query entry only when the entry is writable (docs/access.md "Writing through a role"); otherwise
  `role(...)` is refused as `RoleRefused`, its rule `writeUnwritable` naming the `entry` and the `why`. An entry over a
  family's owner writes the owner as a write of its table does: grizzle draws the owner's counts and ends, so no row
  states them, and a put leaves the family as it is. Its filter reads no field its family draws (a count, an end, an
  index, a tree's start), and no key of the table holds one, or the `why` is `filterReadsFamily` or `keyHoldsFamily`,
  naming the field: filter the owner by the fields its caller writes. A tree's table is keyed by its root fields and
  its drawn start, so no query entry writes it. A family's members are written from an array or a `Stream`, never from
  a query or through a query entry.
- A direct SQL writer logs in as a login's role, runs `SET ROLE` to `roleNameOf(role, connection)` for one of its roles, reads
  the role's views in `schemaNameOf(role)`, and, for a role that declares contexts, sets the claims in the
  transaction:
  `SELECT set_config('grizzle.claims', '{"Session":{"sub":"user_123"}}', true)`. A login holder can set any claims:
  the login is the boundary, so give each trust domain its own. A writer states every field of every row it inserts:
  grizzle mints no ids, and no column has a default that draws one.
- Every installed object is named from what it is. Declared names are snake_case: the schema, tables, derived
  relations, rosters, contracts, columns, row checks and a role's views keep their converted names, a contract's CHECK
  is `check`, and a login's or role's role and a role's schema join the schema's name and their own (roleNameOf,
  schemaNameOf). `constraintNamesOf(schema)` compiles once and gives a lookup of each check's installed name from its
  law: `const constraintNameOf = constraintNamesOf(Credits)`, then
  `constraintNameOf({ kind: "check", relation: "Grant", name: "WithinGrant" })` is `"within_grant"`, and a check over a
  derived relation's is its triggers' digest name: a direct writer or a test that matches a refusal's constraint takes it
  from there, never spelling it. To know on the host what PostgreSQL computes of a row, bind
  `const evaluate = rowEvaluator(schema)` once, which compiles (Effect's `Result` over `CompileError`, as every `Result`
  grizzle answers is), admit each row once,
  `evaluate.admit(R, row)`, R any relation of the schema, stored, derived or closed, the row typed off R without its
  generated fields, each instant the `bigint` it is (an evaluation writes nothing, so a row it judges holds any instant;
  an admitted row's instant is no `Instant`): `DomainRefused` naming a field PostgreSQL's domain refuses, or the `AdmittedRow`; then
  `evaluate(R, admitted)` or `evaluate(select(R, φ), admitted)` is `{ generated, checks, selected }`, each item
  computed where it is first read and shared by every source of R over the admitted row, each generated
  value (`null` for NULL), each row check's `"holds"` or `"breaks"` by name, NULL breaking a table's check and a derived
  relation's alike, and whether the source keeps the row, each item a `Result` whose error is
  `Unevaluated`. Never restate a check, a selection or a generated expression in your own code to predict it. To know
  on the host the rows an insertion stores, bind `const preview = insertPreview(schema)` once, which compiles the law model (a
  `Result` over `CompileError`), then call `preview(rows)`, insertAll's record over every top-level relation: every writable relation's rows as `ChangeSet.empty(schema).insertAll(rows)`
  stores them in an installation holding no row, an empty array where it stores none, each row every field but the
  generated ones as host values, a closed id its handle, an instant a `bigint`, which `evaluate.admit(R, row)` reads as
  it is; or a tagged
  refusal, the write's before any SQL: `InputRefused`, `KeyConflict`, `GeneratedNull`, `OwnerAbsent`, a counted
  member whose owner the call does not insert, or `Uncompiled`, the `CompileError` of an insert of the call's families
  that does not compile. Binding compiles the law model alone; each call compiles, once, the insert of the families
  its rows write, so a preview costs what it previews. Never draw a count, an index, an interval, a fold or a copy in your own
  code to predict it. To key
  rows by their values, take each field's text from `codecText(field)`, bound once, never `String()` of a host value:
  one text per value under PostgreSQL's equality, a closed id's its handle and a set's its handles, the same in every
  installation; a whole found row's text, attachments included, is `rowText(query)`'s, framed, no JSON. To store the
  rows a query found, declare `records(stem, query, owner, ownerKey)` (its `relations` and `rules` in a level over the
  query's: each column the query's own field, each attachment at any depth a relation of its own under its
  parent's law, an array the parent's ordered family), insert `recordsFacts(level, R)(entries)` (each a row beside
  its owner; `insertAll(recordsFacts(level, R)([]))` is the member), and read them back with `recordsQuery(level, R)`,
  whose rows are the query's own type through its own decoder; never restate the columns, and name no relation of your
  own the stem and a suffix. A derived name is admitted at any length, never cut short, its table and whole view
  hashed over the name and spelled after the stem and its path; never state names only to shorten them. A library
  that derives its own relations' and rosters' names builds them with `derivedName({ stem, path })` (the root's, or
  the dynamic door's for names read at run time), whose `relation`, `generated` and `unordered` type as the root's:
  each name readable at any length, what it installs hashed over it; its test holds every identifier
  `installedIdentifiersOf(schema)` (`@bjornpagen/grizzle/compile`) lists to 63 bytes. A name stated in records' options,
  `{ names: { "<path>": "<Name>" } }`, is a declared name, readable, refused past 63 bytes. Records' relations are
  deleted as any relation's rows are. Two
  declared names that
  convert alike are one name (two fields of a relation, two head fields of a derived relation or a role's query, two
  relations of a role, two logins or roles of a schema, a contract a context names beside a relation, roster or
  contract of the schema), a name may not start with `_`, a conversion (a login's or role's with its schema's) must
  fit 63 bytes, and a schema's must not start with `pg_`. Everything else is `__<readable part>_<digest>` and carries
  a COMMENT saying what it is: `grizzle names` prints that mapping from the committed snapshot. Write direct SQL
  against those names. A direct writer of a family's member fills its hidden columns as grizzle does (its index, its
  copy of the owner's count, each fold's running values) and the owner's count and ends; PostgreSQL refuses every
  value that breaks the family.
- This file is `packages/grizzle/skills/grizzle/SKILL.md` in grizzle's repository, which you take as a git submodule:
  copy it to where your agent reads skills, and again after upgrading grizzle.
