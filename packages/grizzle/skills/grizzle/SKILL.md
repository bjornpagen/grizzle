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
		),
		connectTimeoutMs: 10_000
	})
})
```

- Every key is required, and nothing else is configurable: an unknown key is refused.
- Always `export default defineConfig({ ... })`. A plain object is refused.
- `schemas` lists each installation once, by its top level: `schema.extend(Qti, "Ledger", ...)` listed as `[Ledger]`
  installs `Qti` and `Ledger` together, each level in its own PostgreSQL schema, under one migrations directory named
  by the root, `migrations/qti/`. Listing `Qti` beside `Ledger`, or two schemas over one root, is refused.
- Every role is in exactly one login. A login may be over any level of a listed installation (`login(Qti, ...)` beside
  `login(Ledger, ...)`). The config refuses a login over a schema no listed installation holds (or over another
  version of it), and two logins or roles of one installation whose names convert alike. A login missing from `logins`
  is not installed, nor are its roles: their PostgreSQL roles don't exist, so a Db's first call through them is refused
  at stage `acquire`.
- A level reaches the levels below it only by a containment of plain fields into a key, a row check over a lower
  relation (written as that relation's own, its CHECK on the lower table, installed and validated by the level's
  migration), or through a rule over a query; any other law over a lower relation is `LevelRefused` when the schema is
  built. A process over a lower level serves its login's file, which holds what its programs may meet of the levels
  above, and a refusal by a law above it is `refused.kind` `above`, `refused.laws[0]` the law
  `{ kind: "above", level, law }`, beside every law of its own the host finds the stated row breaking (`refused.own`).
- A login owns its workloads: `login(Blog, "web", [AnonBlog, MemberBlog], { workload: [anonReads, memberReads] })`.
  A workload, `workload(schemaOrRole, { name: program })`, is over the login's base, a level of it, or one of its
  roles, and names queries, ordered queries, ChangeSets, relation keys and refreshes. An ordered query the application
  pages is the member `paged(query)`: only its handle (`db.workload.<name>.page`) pages, and generate compiles a page
  template for no other member. The member `refresh(tables)`, of a nonempty list, refreshes materialized derived tables the role's
  `refresh` list names: its handle is one Effect, `db.workload.<name>.refresh`, which refreshes them all in one
  transaction, lower levels first. Two programs of one name across a login's workloads are refused when the login is
  built. A ChangeSet member whose `insert`, `insertAll`, `delete` or `put` was given its facts as an array takes them
  with each call, `db.workload.<name>.apply(facts, params)`: under each such member's op (`insert`, which
  `insertAll`'s members are too, `put` or `delete`) and then its relation's name one array, typed and checked as that
  member's own facts, as in `apply({ put: { Blob: stated }, delete: { Blob: removed } }, {})`; every other member is
  `apply(params)`. Two array members of one op and one relation in two strata are refused: merge them into one.
- `connection` is the migration role's: `driver` (the pg module), `transport` (`kind: "sslRequest"`, `host`, `port`,
  `open`, which returns a new socket, `ca` and `servername`; TLS is always verify-full, the server certificate chaining
  to `ca` and naming `servername`), `database`, `role`, `password` (a Redacted, or an Effect yielding one, evaluated for
  each connection attempt: an RDS IAM token, a secret manager's lookup) and `connectTimeoutMs`, the bound of each
  connection attempt. README's Deploying shows the RDS IAM password with `@aws-sdk/rds-signer`.
- Never write a credential into the config file: read it where the config runs, as the password Effect does.
- `connection` is a function: only `migrate` and `drift` call it, so `generate`, `check` and `names` read no cluster
  setting and no CA file, and `check` runs in CI where no cluster is reachable. `migrate` and `drift` refuse a process environment that
  sets `PGOPTIONS` or `PGREPLICATION`, which node-postgres would send at their session's startup, at the stage
  environment.

## The loop

1. Edit the schema, its roles and logins in code. Every program the application runs belongs in a workload of its
   login: its access paths earn indexes, and `grizzle generate` compiles it for every role of its login and commits
   the login's compiled workload as `migrations/<root>/served/<login>.json`, which the application serves
   (`served<typeof Login>(file, name)`) and compiles nothing. A program that does not compile fails generate with its
   CompileError, naming the role and the program.
2. Run `grizzle generate grizzle.config.ts`, declaring what became of every name the schema no longer holds: a
   `--rename <old>=<new>` for each rename and a `--drop <old>` for each drop ([Renames and drops](#renames-and-drops)).
   It prints one line per written file, then each marker to resolve as `<file>:<line>: <kind>: <what to do>`, its
   kind `placeholder` or `confirm`, then each loss to decide as `<file>: data loss: <what it loses>: <what to do>`,
   then `next: resolve the markers, then run grizzle check`. With no change it writes nothing and prints `no changes`,
   unless the derived facts snapshot.json records are out of date or missing: then it writes `snapshot.json` and
   `manifest.json` again, drafts no folder, and prints `next: commit snapshot.json, then run grizzle check`. Beside the
   snapshot it writes `served/<login>.json` for every login of the configuration over the schema: the login's
   workload compiled under that snapshot, every program for every role it runs on, which is what the application
   serves. It writes a served file whose text changed, removes the one of a login the configuration no longer lists,
   prints each, and prints `next: commit the served files, then run grizzle check` when nothing else changed. A login
   whose workload does not compile refuses generate, naming the login, the role and the program. A name the previous snapshot
   holds that the schema no longer does and no declaration names refuses the draft before anything is written:
   `<name> is dropped but not declared: declare it with --drop <name>, or --rename it`.
3. Read every drafted SQL file, and resolve each marker:
   - **Placeholder** (`-- grizzle: placeholder` above a `__GRIZZLE_PLACEHOLDER__`): a value for a new NOT NULL column
     on a table with rows, or the conversion for a changed type. Write the value or the UPDATE, then delete the marker
     line.
   - **Confirm** (`-- grizzle: confirm:` and the instruction line below it): a holder set aside, a relation or roster
     whose name a declared rename takes or that moves to another kind, renamed aside with every index, identity
     sequence and statistics object it owns, so a declared rename takes it from there or the end of the migration
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
7. Run `grizzle migrate grizzle.config.ts` from CI or the deploy, where its connection reaches the database. It prints
   `<schema>: applied <n> migrations, now at <fingerprint>` and each folder's files, or `<schema>: up to date at
   <fingerprint>`.

For data-only work: `grizzle generate grizzle.config.ts --custom --name <name>`, write the SQL files, then `check`,
commit and `migrate`.

Commands: `grizzle generate <config> [--name <name>] [--schema <schema>] [--rename <old>=<new>]... [--drop <old>]...`,
`grizzle generate <config> --custom --name <name> [--schema <schema>]`, `grizzle check <config>`, `grizzle migrate
<config>`, `grizzle drift <config>`, `grizzle names <config>`, `grizzle roles <config>` (the installation's roles in
the cluster), `grizzle uninstall <config>` (drops the installation's schemas, every row they hold, and its roles, in
one transaction). Flags come anywhere after the command, as `--flag value`
or `--flag=value`. A name is lowercase words joined by `_` or `-`, at most 240 characters, so that the folder
`<timestamp>_<name>` fits one file name (NAME_MAX, 255 bytes). Without `--name`, a drafted folder is named after its
change (`init`, `add_task_note`, `<first change>_and_more`); a custom one needs `--name`. `--schema` is accepted only
when the config lists several installations, each by its top level's name; there it is required with `--custom`,
`--rename` or `--drop`. Exit codes: 0 ok, 1
refused, 2 usage error, 130 interrupted.

## Reading a draft

`migrations/<root>/<UTC timestamp>_<name>/` holds `NN-<phase>.sql` files and `meta.json`, `<root>` the PostgreSQL schema
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
  names constant, a set's `bit(n)` domain over `live`, n its codes rounded up to whole hex digits, and the contract
  and text domains, one per distinct definition.
- **structure**: tables, columns, constraints (`NOT VALID` on a table that may hold rows), materialized views. Each term
  of a selected side, and each `pred` term, is a STORED generated column, `CASE WHEN φ THEN t END` (`__<field>_…`,
  `__pred_<field>_…`), and a rule's key over them is `UNIQUE NULLS DISTINCT` and its foreign key `MATCH SIMPLE`; a
  selected target's constant is a generated column too, `__tag_<field>_<value>_…`. A family's hidden columns, which
  grizzle fills on every write, are each their own `ADD COLUMN` (`__index_<count>_…`, `__copy_<count>_…`,
  `__before_<count>_<plane>_…`, `__after_<count>_<plane>_…`, `__predecessor_<count>_…`), and each CHECK over them its
  own `ADD CONSTRAINT`. A family new to a table that may hold rows is backfilled here: its columns are added under
  placeholder defaults, `SET CONSTRAINTS ALL IMMEDIATE`, SQL over the stored rows draws each index, count, fold value
  and interval (window functions, and one recursive step for a tree), each default is dropped, and only then are the
  constraints that read them added, `NOT VALID`, for Validate to prove the values. A field whose filler changed (its
  fold steps over another field, its copy reads another field, its family's group or order changed) is dropped and
  backfilled the same way: `snapshot.json` records what fills each drawn or accumulated field. An ordered family's
  or a tree's index is the exception: a stored index is the caller's order, so when only the family's group changes
  (its owner re-keyed, a group field dropped and added) the index column is kept, the count, copies and folds are
  drawn again over the kept order after the data step, and Validate refuses a data step that leaves an owner's
  indices other than 0 … n − 1. `--drop M.at` while the schema still declares `M.at` gives the stored order up and
  draws the index anew in member-key order. A fold added to or
  changed on a tree that holds rows is drawn in the tree's stored sibling order. A family whose values the stored rows
  alone don't give is refused, naming it: copies that read each other, or a fold over a copy. A roster whose names changed has its domain's CHECK dropped and added `NOT VALID` against the new names constant,
  validated in Validate; a set over a roster that grew is converted to the new size's domain by its cast, the new
  handles absent. A table CHECK or generated field over a changed closed relation is replaced the same way, or takes its
  new expression (`SET EXPRESSION`). A field whose type changes is converted in place, `ALTER COLUMN ... TYPE ... USING`
  with a placeholder for the conversion, or by its cast, with no placeholder, when the new type holds the old one's
  values (a pattern changed, a contract added, removed or swapped for another over the same base), after the
  constraints, indexes and statistics over it are dropped; they are built again as on any table with rows, but a key
  over it, which is added again right after the conversion in the same transaction, so it holds throughout. A domain is
  named by its whole definition, so a contract's changed predicate, like a changed pattern, is another domain: each
  field it types is converted to it by its cast, which refuses a stored value the new definition doesn't admit (23514).
  Every world object an existing role relies on (a view, a policy, a filter function, a
  key or unique probe) that changes, or that reads anything the migration changes or drops (a relation, a column, a
  type, a materialized view, a function), is dropped at the start of this transaction and created again, with its
  grants, at its end, so no committed state lacks it.
- **indexes**: `CREATE INDEX CONCURRENTLY` on tables that may hold rows, in a no-transaction file, so writes keep
  flowing. A table this migration creates gets an ordinary build. The extended statistics a workload program earns are
  created here too, on a table or a materialized view, each followed by an `ANALYZE` of a relation that may hold rows.
- **validate**: `VALIDATE CONSTRAINT` and key swaps. A key replaced by another over the same fields (a candidate key
  that becomes the primary key) is dropped here once the new key is attached, and the foreign keys over those fields
  are added after it, so each depends on the new key. A roster domain's VALIDATE refuses every row that still holds a
  removed handle's code, naming the table and column, never the row: change or delete those rows in a data step
  before it. A rule over a query (a side over a derived relation) that is new, or whose rule or definition changed,
  is checked here once every row the migration writes is written: a DO block running its violation query over the
  stored rows, raising 23000 with the rule's name where a row breaks it. Its functions and its deferred constraint
  triggers, one on each table its query reads, are created or replaced here too, and a renamed table's trigger is
  created again.
- **publish**: the refined constants' casts to their domains, so each is judged by the target's CHECK (one it refuses
  rolls the whole file back); the worlds: logins and roles, their memberships and settings, each role's schema of
  views (a security-barrier view for a query entry, a plain one for a whole entry, each closed id followed by its
  decoded `<field>_name`), its grants (EXECUTE on each constant its statements call among them), row-security policies
  and filter functions; and last every object the schema no longer has, dropped: indexes, roles, statistics, views,
  functions (a constant by `DROP FUNCTION ... RESTRICT`, so PostgreSQL refuses a migration that left a reader of it
  standing), columns, tables, then types. A declared drop of a stored relation or field is drafted live. A world object
  holds no data, so a changed world needs no marker; a role the migration creates gets its views, policies and
  functions here, after the role.

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
  The draft refuses a declaration that names what the snapshot or the schema does not hold as it says.

What a declaration drafts:

- **A relation or roster renamed** is renamed in place in Setup, first aside and then to its new name, with its
  constraints, so its rows stay where they are, and a swap (`A=B` and `B=A`) or a chain (`A=B` and `B=C`) is free of the
  names it moves into. A name a rename takes ends its previous holder, which is dropped as declared.
- **A field renamed** is renamed in place, through its own aside name. PostgreSQL carries the rename into what is built
  over it, and each key, index, statistics object, CHECK and foreign key over it, or on a renamed relation, or
  referencing one, that the schema declares by the same definition is renamed to the name the schema gives it
  (`RENAME CONSTRAINT`, `ALTER INDEX ... RENAME TO`), never built or validated again; what the schema declares otherwise
  is built again. A new field of a table with rows takes a placeholder, and a field whose type changed is converted in
  place, as any field is.
- **A family's hidden columns** (`__copy_…`, `__index_…`, `__parent_start_…`, `__before_…`, `__after_…`,
  `__predecessor_…`, `__pred_…`) are named by the laws whose values they hold, so a rename of the owner, the member, the
  count, or a roster or handle a fold's or a side's selection reads, a swap or a chain among them included, renames
  them in place too, `ALTER TABLE ... RENAME COLUMN` through an aside name: no backfill, no table rewrite, every drawn
  value kept. A column whose law the migration changes otherwise is a new column, drawn again.
- **A handle renamed** keeps its code, so every row holding it holds the new name: the migration installs the
  roster's new names constant and points its domain at it.
- **A handle dropped** leaves a hole: its code is never reused, and the roster's domain, validated against the new names
  constant, refuses every row still holding it, naming its table and column. Change or delete those rows in a data
  step first. Handles reordered are refused before anything is drafted, by `generate` at the stage codes and by
  `check`: a stored code never changes meaning, so append new handles; a roster's order is its codes' order.
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
  names) sets the old holder aside first, in Setup, under its aside name, with every index, identity sequence and
  statistics object it owns, under one confirm marker. A declared rename takes it from there; otherwise the end of the
  migration drops it there, as declared.
- **The schema's name names its PostgreSQL schema.** A schema renamed in code is a new, empty schema. When the
  migrations directory holds a schema the config no longer lists, the new schema's first migration drafts its `CREATE
  SCHEMA` commented, as a data loss: the old schema keeps its rows and is never migrated again. Uncomment it to start
  the new schema empty; to keep the rows, keep the old name and delete the folder.

meta.json records the declarations a folder was drafted under, and every drafted statement of every file in its place,
so `check` refuses a confirmed group kept in part and a loss left undecided, and reads every reviewed statement back
as PostgreSQL's scanner reads it: whitespace, comments and the case of unquoted words are yours.

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
  reads each changed statement as one changed line.
- `served/<login>.json`: a login's workload compiled under the snapshot beside it, which the application serves.
  `check` compiles every login again and holds each file to it byte for byte: the login's served file differs from
  what its workload compiles to under snapshot.json (an ungenerated change), naming the login and the first program
  where they part; run grizzle generate, which writes the served file again.
- `meta.json`: it records the folder's place in the chain, the renames and drops it was drafted under, every
  drafted statement of every file in its place, its confirmed groups and data losses among them, which `check` reads
  every reviewed file against, and the law of each constraint the folder installs, by which `migrate` names the law a
  refused statement of the folder breaks. `check` says: meta.json does not decode as a
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

## Custom migrations

Use one for data work the schema doesn't describe: purges, cutovers, rows that hold a handle you are about to drop, a
backfill before a contract base changes. `grizzle generate <config> --custom --name <name>` writes a folder with only
`meta.json`, whose source and target are the current snapshot. Add `01-<words>.sql`, `02-<words>.sql` and so on; each is
a transaction unless its first line is `-- grizzle: no-transaction`. The catalog must still end at the snapshot.
`grizzle migrate` runs every migration file at SERIALIZABLE, so a reviewer's data step or a custom migration writes like
any direct writer.

## Refusals

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
| the login's served file differs from what its workload compiles to under snapshot.json (an ungenerated change) | run grizzle generate, which writes the served file again |
| the login has no served file beside snapshot.json (an ungenerated change) | run grizzle generate, which writes the served file |
| the served file is of a login the configuration does not list over the schema | run grizzle generate, which removes the served file |
| the schema or a login's workload does not compile | fix the schema or workload it names, then run grizzle generate |
| the schema no longer holds a name snapshot.json holds, and no --drop or --rename declares what became of it | run grizzle generate <config> --drop <name>, or --rename <old>=<new> where it was renamed |
| a roster declares a handle before one that holds a lower code in snapshot.json | append new handles; a roster's order is its codes' order |
| unresolved placeholder | write the value or the UPDATE, then delete the marker line |
| unconfirmed group | keep every statement below the marker as drafted, then delete the two marker lines |
| unresolved data loss: a schema's first migration starts it empty beside a schema the configuration no longer lists, and the statement that loses that schema's rows is still commented | to start the new schema empty, uncomment the statement below its -- grizzle: data loss line; to keep the rows, keep the old schema's name and delete the folder |
| snapshot.json and manifest.json do not decode as a snapshot, or are the snapshot of another schema | restore them from git |
| meta.json does not decode as a migration's meta.json, or names another schema | restore it from git |
| broken chain: this migration does not start where the previous one ends | regenerate; never hand-edit meta.json |
| broken chain: the newest migration does not reach snapshot.json | regenerate; never hand-edit meta.json |
| a migration folder is named <YYYYMMDDHHMMSS>_<name> | fix the file: rename the folder, or move it out of the migrations directory |
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
| server | have a superuser raise the server's max_stack_depth to at least 2MB, its default |
| owner | connect as the role that owns the schema |
| input | run grizzle check and fix what it reports |
| busy | wait for the other grizzle migrate to finish, then run it again |
| ledger | the ledger was changed by hand; restore it from a backup |
| edited | restore the applied files from git; put new steps in a new migration |
| order | restore the migrations directory from git, then run grizzle check |
| marker | resolve the markers, delete the marker lines, then run grizzle check |
| decision | decide each data loss as its -- grizzle: data loss line says, then run grizzle check |
| statement | fix the failing file (an applied file stays as it is), then run grizzle migrate again |
| record | run grizzle migrate again: the failed file rolled back with its ledger row |
| commit | run grizzle migrate again: the ledger tells whether the file committed |
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

A direct SQL writer, psql included, meets these refusals of its own, among the others README's Direct SQL access lists:

| Refusal | Fix |
| --- | --- |
| 25000: a write to a grizzle table requires SERIALIZABLE | write at SERIALIZABLE: BEGIN ISOLATION LEVEL SERIALIZABLE; (a table whose every writer is certified READ COMMITTED has no guard) |
| 42501: permission denied, or a new row violating a row-security policy | SET ROLE to a role whose world holds the relation and the row |
| 40001 or 40P01: a serialization failure or a deadlock | run the transaction again |

The command line's own refusals, by stage:

| Stage | Fix |
| --- | --- |
| usage | run grizzle --help for the commands |
| config | fix the configuration file: export default defineConfig({ schemas: [...], logins: [...], migrations: "...", connection: () => ({ ... }) }) |
| environment | unset the variable it names in the environment grizzle runs in, then run the command again |
| filesystem | fix the migrations directory, then run grizzle check |
| snapshot | restore snapshot.json, manifest.json and the migration folders from git |
| codes | append new handles; a roster's order is its codes' order |
| generate | fix the schema or workload it names, then run grizzle generate again |

## Deploy

- Run `grizzle migrate` as the role that owns the schema and the database. No snapshot or migration names that role,
  so dev and prod may use different ones; a schema owned by another role is refused at the stage owner. The first
  migration's Setup sets the database's default isolation, which only the database's owner may: as any other role
  it fails at the stage statement with 42501. Each file first takes the ledger's exclusive lock, which waits for the
  `Db` transactions in flight; from then until the migration's last file commits, no `Db` call runs and no `Db` opens,
  so plan migrations as downtime.
- Every transaction runs at SERIALIZABLE, a direct SQL writer's included. grizzle sets it as the database's default,
  so psql sessions get it without asking, and a write below it on a grizzle table is refused with 25000 by the table's
  guard trigger. A table some role writes, every writer of which is certified READ COMMITTED and holds only INSERT and
  SELECT on it, has no guard: a direct writer there meets its role's grants and the table's constraints alone. A
  migration that changes whether a table qualifies drops or creates its guard.
- Set `max_pred_locks_per_transaction = 2048` on the server (a server-start setting): under load PostgreSQL may
  report 53200, out of shared memory, with a HINT to raise it, and that failure is not retryable. Keep transactions
  short everywhere on the cluster: a committed write's locks are held until every older transaction ends, in any
  database and at any isolation level (a DROP DATABASE waiting on its checkpoint included), and a long one also
  brings more 40001s.
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
  const feed = yield* db.workload.memberFeed.execute({})
  ```

  `connection` is the config's connection without its `role` and its password, which are the migration role's
  (`DbLayer.make` refuses a `role` as an unknown setting): `driver: pgDriver` (`import pgDriver from "pg"`), the
  `transport` (`{ kind: "sslRequest", host, port, open: () => new net.Socket(), ca, servername }`, always
  verify-full), the `database` and `connectTimeoutMs`. `password` is the login's own, and `pool` is
  `{ max, min, idleTimeoutMs }`. grizzle states no number of its own: a `Db` call waits for a session until it gets
  one or is interrupted, and an interrupted statement sends one CancelRequest and destroys its session.

  `DbLayer.make` loads the served file once and compiles nothing; it refuses, at stage `config`, a file of another
  login than the name `served` was given. `grizzle check` refuses a served file that is not its login's compile under
  the committed snapshot: a program added, renamed, dropped or edited since the file was generated; run `grizzle
  generate`. `roleNameOf(WebServed, connection)` is the login's PostgreSQL role, the file's stem under the connection's
  `rolePrefix`. `Db.open` contacts nothing and
  checks nothing of the database: grizzle assumes it is the one the snapshot was migrated to, and the request's first
  call is its first round trip. `token` is required exactly when the role's
  relations read a context; the layer's `verify` refuses one at the stage `token`, and a claim of a refined field is
  judged by its domain where a statement reads it. `grizzle migrate` judges the database after every apply and when
  nothing is pending, and refuses drift: the login's and the role's settings and privileges exactly the snapshot's,
  the login LOGIN NOINHERIT and the role NOLOGIN with no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS, a
  role's members its login and the migration identity PostgreSQL makes a member of each role it creates, row security
  enabled and not forced on every table the role writes through a query entry that leaves rows out, view definitions
  and policies. A table no role writes that way has no row security and no policy: each policy would be true, and the
  grants alone decide its writes. `grizzle drift` runs that same check alone and applies nothing (a folder not yet
  applied is a mismatch of its own), so it can watch a production database from CI or a schedule; it connects as the
  migration identity, since the check replays the snapshot into a scratch schema in a transaction it rolls back.
- Open a `Db` per request or handler: `Db.open` sends nothing, so this costs no round trip.
- A paged member's `page` (`db.workload.<name>.page`) takes any safe integer of at least 1 as its size: there is no
  default and no cap.
- Every transaction of a `Db` checks the ledger first, in the same round trip, and runs nothing unless the database
  holds its snapshot: while a migration runs, its calls fail with `StaleSnapshot` (reason `Migrating`), and once a
  migration to another snapshot completed, with `StaleSnapshot` (reason `Migrated`). An apply with nothing to write
  sends its transaction and meets the check too, so a stale `Db` never answers it `no-change`. Deploy the code that
  carries the new snapshot.json, and open new `Db`s with it.
- Handle a failure by its reason: grizzle's errors, the engine's `CompileError`, `EncodingFailure` and `CursorError`
  among them, carry what happened as a tagged `reason`, so `Effect.catchReason("TransientFailure", "PutTargetConflict",
  f)` handles one case and keeps every other, and an error's `stage` and `message` follow from it. Read a refusal's
  facts from its reason (a `CompileError`'s `OutsideRole` names the `role` and the `access`), never from its message,
  and a server's error by its `sqlstate` and the fields it names, never by its words, which follow `lc_messages`.
  Retry only `TransientFailure`, with `Effect.retry` and your own `Schedule`; after `CommitUnknown`, read back before running the call again.
- In a test, build a failure or an outcome with grizzle's own constructors, never a cast or an object literal in a
  class's place: every error and reason class is exported as a value, the class grizzle builds it with
  (`new ReadFailure({ reason: new InputTooLarge({ bound }) })`); a server's report is `new ServerError({ sqlstate,
  message, constraint, schema, table, column, dataType, detail, hint })`, each field stated, its `sqlstate` from
  `Sqlstate.parse(code)`, which is `undefined` for a code that is no SQLSTATE; and `ApplyOutcome.committed(counts,
  reads)`, `invariantRejected(refused, witness)` and `outsideWorld(relation)` build what `db.apply` answers.
- A broken rule is an outcome of `db.apply`, never an error. `invariant-rejected` carries `refused`,
  `{ kind: "every" | "first" | "some", laws }`, whose `laws` are never empty, each `{ law, id, by }`: `law` the law as
  the schema states it, such as `{ kind: "check", relation: "Grant", name: "WithinGrant" }`, which you match on
  directly, never on a constraint's name; `id` its identity, a LawId, or a GeneratedLawId for a generated field's law;
  and `by` the installed object that refused it, `{ kind: "constraint", table, name }`, `{ kind: "domain", domain,
  name }`, `{ kind: "statement" }` for a write statement's refusal, or `{ kind: "notNull", table, column }` for a
  generated column. A pattern's law names its field, `{ kind: "pattern", relation, field, patterns }`, each `{ source, flags }`
  spelled as that field spells it, every pattern of a `str.and` in order and one law for the field all the same, so two
  fields of one pattern are two laws. `lawsOf(schema)` lists every law a schema states,
  each once, as an outcome names it: each table's primary key, each statement's laws, each contract's, each stored
  field's pattern law and each generated field's law, none for a pattern every text matches, which grizzle drops, or
  for a contract's pattern, whose law is the contract's. Compare refusals against it with `sameLaw`, and never keep a
  list of laws by hand. `lawIdsOf(schema)` lists the same laws in the same order with their ids, each `{ law, id }`,
  the `id` a refused law carries: key your names for laws by these ids and read a refusal by `id`, never through a
  table of ids you keep. For one statement's laws, bind `const lawsOfStatement = lawsByStatement(schema)` once, which
  compiles, then look each statement up with `lawsOfStatement(statement)`: its laws from lawsOf's list, in its order, a
  mirrors' two containments, an alternatives' containments, none for `mutable`, a law two statements state each
  one's; a statement no level of the schema states throws `CompileError`. `every` names every law grizzle
  decides the write broke. `first` names the laws of the CHECK PostgreSQL tried first, where grizzle cannot decide a
  row's checks on the host (a row only PostgreSQL computes, such
  as a query's, or a check that reads a value grizzle does not hold, such as a count or an end a put keeps from the
  stored row): the row may break other checks too, and another version of grizzle may name another of them. `some`
  names two laws or more of one PostgreSQL object, a family's merged foreign key or a domain several fields share,
  where nothing decides which of them the row broke: at least one did. Its `witness` is the key of a row you stated
  that breaks them, or `unreported` where grizzle cannot tell which row did, such as two family owners the write
  inserts without reading them, either of which may be a stored one inserted again: never assume a key is there.
- No read raises an arithmetic error on a row: never catch 22003, 22012 or 2201F around a query. Integer arithmetic is
  exact and delivers `bigint`, money arithmetic exact `Money`, and floats are IEEE 754 (`x / 0.0` is ±Infinity). A
  partial operation needs its precondition proved, by a literal's type (`Compute.div(x, 7n)`), by a contract that
  declares it (`contract("Divisor", pg.bigint, (v) => v.ne(0n), { proves: ["nonzero"] })`) or by a guard:
  `Compute.when(Compute.nonzero(b), (b) => Compute.div(a, b), 0n)`, the guards `Compute.nonzero`,
  `Compute.nonnegative`, `Compute.positive`, `Compute.isFinite` and `Compute.within(x, low, high)`. A guard's subject
  may be a parameter (`Compute.when(Compute.nonzero(d), (d) => Compute.div(x, d), 0n)` over `r.param("d",
  pg.bigint)`), and a parameter of a contract that declares a fact has it, so
  `Compute.div(x, Compute.base(r.param("d", Divisor)))` needs no guard. A parameter is a term of its declared type
  everywhere, first operand included. An unproved
  divisor is a type error naming the guard; an unproved narrowing or power is `CompileError` reason
  `PartialOperation`, whose `guard` is the code to write. A contract's facts are exactly its `proves`: a fact its
  predicate implies but `proves` leaves out is refused, and the refusal names the declaration to add. Narrow an exact
  integer into an integer field with
  `Compute.cast` under `Compute.within`, and a sum, a mean or numeric arithmetic into a `pg.numeric(p, s)` field the
  same way: a ChangeSet member writes each field at its own type, a numeric of another precision or scale included.
- Test text with `Compute.matches(x, pattern)`, `Compute.startsWith` and `Compute.endsWith`, never a regex in your
  code. A pattern is `str.regex`'s grammar under `"u"`, anchored by `^` and `$`: a `Compute.pattern(source)`, made once
  as a module constant and admitted there (`const digits = Compute.pattern("^[0-9]+$")`), never a bare string; or a
  closed relation's text payload, `Compute.matches(lexical, ValueDomain.at("pattern", domain))`, every value of which
  the compiler measures; a pattern held in an ordinary field or a parameter is refused. A `Compute.pattern`'s match is a
  guard: `Compute.when(Compute.matches(x, digits), (x) => …, otherwise)`. `Compute.concat` builds text in checks,
  generated fields and folds; in a query, compare a text with a concatenation (`Compute.eq(t, Compute.concat(a, b))`)
  and it is decided without building it. Its first operand is a term: write a leading literal as
  `Compute.literal(Prose, "item-")`. Normalize text with `Compute.translate(x, from, to)`, strings of one length with
  each character of `from` once (`Compute.translate(title, "\t\n\r", "   ")` for `xs:normalizedString`), and fold
  ASCII case with `Compute.lowerAscii(x)`, never a locale's `lower`. A translation is text of the image of `x`'s
  pattern, so store it as `generated(T, Compute.cast(Compute.translate(…), T))` for any refined text `T` the image
  lies in, which compilation proves; translate in a query only over a pattern that bounds its length. For XML
  Schema's whiteSpace facets use `Compute.replaceWhitespace(x)` (tab, LF and CR to spaces) and `Compute.collapse(x)`
  (runs to one space, none at either end), never a regex of your own; cast a collapse into a refined text the same
  way, such as `str.regex("^(?:[^ \\t\\n\\r]+(?: [^ \\t\\n\\r]+)*)?$", "su")` for any text. A collapse, a
  translation and a concatenation keep their operands' byte bound, a translation to wider characters by the most its
  image can take, so a `str.bytes` text normalized from one casts back into it:
  `generated(Key, Compute.cast(Compute.lowerAscii(Compute.collapse(row.lang)), Key))` for `lang` a `Key`. A query's
  `Compute.matches`, like its translate, needs a pattern that bounds the subject's length: PostgreSQL's regex engine
  widens its subject fourfold. A collapse reads any text. Fold an ordered family's texts with `Monoid.concat`, naming
  its `(before, after)` pair, and write each member's separator into its own step value; type the accumulators by a
  bounded pattern, `str.regex("^.{0,64}$", "su")`, since the family's axes key each running text and an unbounded one
  is UnrepresentableKey. The step may be any text, a generated piece at a byte bound among them,
  `generated(T, Compute.concat(…))` for a refined `T`: a generated field and each accumulator is of its type but for
  its own pattern and byte bound, which its domain checks, refusing a write whose value lies outside it.
- Join patterns a text must all match, XML Schema's pattern facets among them, with
  `str.and(str.regex(p), str.regex(q))`, never one regex you intersect by hand: each pattern is held to PostgreSQL's
  limits alone and its domain tests each in turn, so a conjunction costs the sum of its patterns, never their product,
  and its host type is theirs intersected. Inside `Compute.when(Compute.matches(x, p), …)` the subject is text of its
  own patterns and `p` together, so nested matches prove a cast into a conjunction.
- Write a `str.regex` or `Compute.pattern` source in JavaScript's syntax under `u`, with no lookahead or lookbehind,
  `\p{…}` or `\P{…}`, `\s` or `\S`, `\b` or `\B`, backreference, named group, inline modifier, lazy quantifier or
  repetition bound above 255, and with some text it matches. TypeScript accepts each of these, but the relation,
  contract or `Compute.pattern` built over the source refuses it as `UnsupportedOperation`, naming the construct and
  its offset. Spell an explicit class instead of `\s` or `\p{…}`.
- A set of a roster's handles, `bits(X)`, has the algebra `Compute.union`, `Compute.intersection`,
  `Compute.difference`, `Compute.cardinality`, `Compute.subset`, `Compute.disjoint` and `Compute.singleton`, and no
  complement. Test a closed id's membership in a set as `Compute.subset(Compute.singleton(id), set)`:
  `Compute.singleton(id)` is the set of the id's one handle, and a NULL id gives a NULL set.
- A closed relation read at a key no row holds: `C.at(field, k…)` is NULL there, which a check refuses, as does a
  generated field's NOT NULL, on `{ kind: "generated", relation, field }` (23502 on its column to a direct writer;
  grizzle refuses a nested write or a family fill that reads the field before any SQL, with the same outcome), and
  `C.has(k…)` is false there, so say what holds where the key is absent with `has`, never with a null-object row:
  `Compute.or(Compute.not(C.has(k…)), φ(C.at(field, k…)))`, or a value there,
  `Compute.cond(C.has(k…), C.at(field, k…), d)`. Every closed read is NULL where a key value is NULL.
- A `bytes` field, a `Uint8Array`, is written and read back whole and nothing more: never in a key, a rule's side, a
  filter, a parameter, a contract, a generated or accumulated field, or a `Compute` call but `Compute.sha256(x)`, its
  SHA-256 digest as 64 lowercase hex digits. Store a digest PostgreSQL computes from the bytes, never one the caller
  sends: `generated(str.regex("^[0-9a-f]{64}$"), Compute.sha256(row.content))`. A value holds at most 1,073,741,819
  bytes (`bytesMaxLength`), PostgreSQL's longest bytea, and is read back in chunks, one round trip still; a write reads
  back only its SHA-256 digest. grizzle copies a value once, as the call is sent; one changed
  before then is `bytesChanged`. An attachment whose rows hold one is a statement of its own, so under rows that read
  `.approximateNearest` attach in a second query instead.
- A call's flight, every byte the driver writes for its one round trip, is at most 1,908,342,784 bytes
  (`flightMaxBytes`), the most one write over TLS carries. A longer one is `InputTooLarge` (`flight`) before anything is
  sent, nothing ran, and grizzle never splits it into more round trips: split the input across calls.
- Every numeric field declares its precision and scale, `pg.numeric(p, s)`; there is no bare `pg.numeric`. A sum,
  a mean or an operation's numeric result carries the digits its computation proves, and one past 131,072 integer
  digits is `ResourceBound`. Convert an integer, money or a float to numeric with `Compute.numeric(x)`, never a cast to
  a typmod you do not mean.
- Parse an `xs:decimal` text with `Compute.parseDecimal(x)`, the exact numeric of any digits, never a cast into the
  widest `pg.numeric(p, s)` with a lexical form, whose form ends at 256 integer and 255 fraction digits. Its text is
  `decimalText` within `decimalTextMaxBytes` (16,384) bytes: type it `str.bytes(16384, str.regex(decimalText.source))`, or
  guard it, `Compute.when(Compute.matches(x, decimalText), (x) => Compute.when(Compute.within(Compute.octetLength(x),
  0, 16384), () => Compute.parseDecimal(x), otherwise), otherwise)`. A double's text of any digits is
  `Compute.parseDouble(x)` over `doubleText`. Never make an `otherwise` stand for a value, an infinity or a sentinel:
  a rule over it then passes on a text that does not parse. State what the rule holds of such a text in the rule.
  Parse a padded value as XML Schema reads it, collapsed first:
  `Compute.when(Compute.matches(Compute.collapse(x), doubleText), (x) => Compute.parseDouble(x), otherwise)`.
- Each login is a PostgreSQL role, `roleNameOf(login, connection)`, and each role a PostgreSQL role that cannot log
  in, `roleNameOf(role, connection)`, with its schema of views, `schemaNameOf(role)`; the schema's own is
  `schemaNameOf(schema)`. Take every one from there, never spell or rebuild one: each is the name the installation
  creates, and each throws CompileError for a name the installation refuses. A role is its stem, which `generate`
  commits, under the connection's `rolePrefix` (`{}` for none): two installations of one schema share a cluster, each
  in its own database under its own prefix, from one committed output. Drafted SQL names each role as psql's variable
  `:"<stem>"` and the current database as `:"DBNAME"`, which `migrate` fills; write a role the same way in a data step. The migration that adds a login creates its role; the operator
  gives it a password, or, for an RDS IAM login, `GRANT rds_iam TO <role> WITH INHERIT TRUE, SET FALSE`, and the IAM
  signer's user name is `roleNameOf(login, connection)`. grizzle never sets either. A login holds only USAGE on the
  schema, SELECT on the ledger and EXECUTE on the snapshot guard, the lock and the check every transaction takes;
  everything else it does as one of its roles, one per transaction. The drift check takes a membership beyond the
  login's roles as no drift only with SET FALSE and no ADMIN, and only while the login's effective privileges on the
  installation stay exactly those three: `rds_iam` holds nothing there, so it is no drift, and a membership handing the
  login any privilege or ownership is.
- A role is over a schema and is no schema itself: `role`, `login`, `schema.extend`, `wholeEntriesOf`,
  `writableNamesOf`, `lawsOf`, `lawIdsOf` and `lawsByStatement` take a schema, and a role passed to one is a type
  error; `query`, `ChangeSet.empty` and `workload` take either. A role's `write` names each entry once: a name listed
  twice is a type error, and `RoleRefused` (`writeTwice`) for a JavaScript caller.
- A role that only inserts lists its entries as `insert` in place of `write`: it holds INSERT and SELECT on them and
  no UPDATE or DELETE, so a direct writer's UPDATE or DELETE through it is 42501, and a ChangeSet of it that deletes,
  puts, or adds a member under a mutable owner (which updates the owner's count) is `OutsideRole` (`insert`) when it
  compiles. Stating both is `RoleRefused` (`writeAndInsert`).
- A role's writes run READ COMMITTED only where `grizzle generate` certifies it from the statements its ChangeSets
  send, against every other writer (README's READ COMMITTED writes); every other role runs SERIALIZABLE, and reads are
  always SERIALIZABLE READ ONLY. generate prints each role's level, a SERIALIZABLE one with the count of each condition
  it fails: `members` (no ChangeSet), `privileges` (it states `write`, or some role updates or deletes what it writes),
  `laws` (a rule over a query over what it writes), `absence` (a read of the absence or a count of what it writes),
  `snapshot` and `pivot` (other calls' rows read across statements, as anything but whole immutable groups keyed by
  values the call states once, or by a foreign key check of a row that can change), `writers` (a SERIALIZABLE role
  writing what it writes, or writing what it reads while reading other calls' rows itself), and `facts` (an object
  the certifier cannot name). Clear one by changing the schema or the workload, never by a flag: there is none. A role
  that inserts rows referencing content another role maintains publishes the keys it references: every writer of
  that content states `insert` on it, an insert-only published relation holds the keys with a foreign key into the
  content, a `publisher` role that inserts nothing else writes it, and the referencing role's foreign keys point at
  the published relation. `compileServed` of other programs than the committed workload serves every role
  SERIALIZABLE.
- A role's `write` lists a query entry only when the entry is writable (README's Writing through a role); otherwise
  `role(...)` is refused as `RoleRefused`, its rule `writeUnwritable` naming the `entry` and the `why`. An entry over a
  family's owner writes the owner as a write of its table does: grizzle draws the owner's counts and ends, so no row
  states them, and a put leaves the family as it is. Its filter reads no count or end, and no key of the table holds
  one, or the `why` is `filterReadsFamily` or `keyHoldsFamily`, naming the field: filter the owner by the fields its
  caller writes. A family's members are written from an array or a `Stream`, never from a query or through a query
  entry.
- A direct SQL writer logs in as a login's role, runs `SET ROLE` to `roleNameOf(role, connection)` for one of its roles, reads
  the role's views in `schemaNameOf(role)`, and, for a role whose relations read a context, sets the claims in the
  transaction:
  `SELECT set_config('grizzle.claims', '{"Session":{"sub":"user_123"}}', true)`. A login holder can set any claims:
  the login is the boundary, so give each trust domain its own. A world role holds no privilege on a sequence: an
  identity default needs none, and a writer inserting explicit serial values (`OVERRIDING SYSTEM VALUE`) calls the
  field's advance function, `SELECT <schema>.<advance function>(<largest value inserted>)`, `<schema>` being
  `schemaNameOf(schema)`, in the same transaction. A `pg.uuidv7` field has no sequence: leave it out for its
  `uuidv7()` default, or write a uuid as it is.
- Every installed object is named from what it is. Declared names are snake_case: the schema, tables, derived
  relations, rosters, contracts, columns, row checks and a role's views keep their converted names, a contract's CHECK
  is `check`, and a login's or role's role and a role's schema join the schema's name and their own (roleNameOf,
  schemaNameOf). `constraintNamesOf(schema)` compiles once and gives a lookup of each check's installed name from its
  law: `const constraintNameOf = constraintNamesOf(Credits)`, then
  `constraintNameOf({ kind: "check", relation: "Grant", name: "WithinGrant" })` is `"within_grant"`, and a check over a
  derived relation's is its triggers' digest name: a direct writer or a test that matches a refusal's constraint takes it
  from there, never spelling it. Two declared names that
  convert alike are one name (two fields of a relation, two head fields of a derived relation or a role's query, two
  relations of a role, two logins or roles of a schema, a contract a context names beside a relation, roster or
  contract of the schema), a name may not start with `_`, a conversion (a login's or role's with its schema's) must
  fit 63 bytes, and a schema's must not start with `pg_`. Everything else is `__<readable part>_<digest>` and carries
  a COMMENT saying what it is: `grizzle names` prints that mapping from the committed snapshot. Write direct SQL
  against those names. A direct writer of a family's member fills its hidden columns as grizzle does (its index, its
  copy of the owner's count, each fold's running values) and the owner's count and ends; PostgreSQL refuses every
  value that breaks the family.
- This file ships in the package as `skills/grizzle/SKILL.md`: copy it to where your agent reads skills, and again
  after upgrading grizzle.
