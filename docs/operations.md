# Operations reference

The reference grizzle's source and tests cite by heading (test/unit/dev/references.test.ts). A claim here that the code contradicts is a bug of this page, fixed here.

## Requirements in full

- **Peer dependencies.** `effect` 4.1.2 or a later 4.x, and `pg` (node-postgres) 8.23.1 or a later 8.x: install one copy of each beside grizzle. grizzle imports no driver: you pass the `pg` you import as each connection's `driver`, and a `pg` without pipeline mode, which every call's one round trip needs, is a type error there. `@types/pg`, where TypeScript reads `pg`'s types, is an optional peer.
- **TypeScript.** Your tsconfig typechecks grizzle's source as part of your program, so it needs `allowImportingTsExtensions` (grizzle's modules import each other by their `.ts` paths) and `moduleResolution` `nodenext` or `bundler`, which read the packages' `exports` and `imports`. grizzle's own tsconfigs extend only files inside its repository, so a tool that reads the nearest tsconfig of each module, as Vite does, needs nothing else of yours.
- **A refusal beside a TypeScript error.** A grizzle refusal reported beside a TypeScript error at its source, such as TS2552 or TS2304 (a name no module declares), is that error's cascade: the unresolved name reads as `any`, and a check downstream of it can no longer read what it states. Fix the first TypeScript error.
- **Hardened Node.** grizzle runs under `--disable-proto=delete` and `--disable-sigusr1`: it never touches `Object.prototype.__proto__`, the `grizzle` command starts with both flags, and every test runs under both.
- **The database.** UTF8 with the builtin `C.UTF-8` locale, on a server host that has the `C.UTF-8` operating-system locale. `btree_gist` must be available; a migration creates it when a no-overlap key or a coverage rule needs it. pgvector 0.8.7 is needed only for vector fields; it is not a trusted extension, so a superuser creates `vector` first where the migration role cannot.

### A migration role that owns the database

It owns the schema and the database, and has CREATEROLE to create the PostgreSQL roles of your logins and roles. It needs no superuser. A role without CREATE on the database fails the first migration with 42501 ("permission denied for database") at its first statement, the CREATE SCHEMA of the installed schema: the database's owner holds CREATE on it, and another role only where it is granted. A migration that creates `btree_gist`, a trusted extension, needs it too. It also holds `pg_signal_backend` (`GRANT pg_signal_backend TO <migration role>`, which a superuser gives, or a role holding it WITH ADMIN): a migration that drops a role first ends the sessions holding that role's temporary tables ([Deploying](#deploying)), and PostgreSQL lets a role end a session only where it holds the privileges of the session's login or pg_signal_backend's. Without it, such a migration fails with 42501 ("permission denied to terminate process") and rolls back, as it fails with 2BP01 when nothing ends them.

- **A password for each login role**, which you set, or, for RDS IAM authentication, membership in `rds_iam`, and one for the installation's decoder login where a login serves a read: the role a reading login's served file names, `roleNameOf(WebServed.decoder, connection)` (Connecting). Each connection authenticates with exactly the password its configuration names: node-postgres never reads `PGPASSWORD` or `~/.pgpass` for one.
- **TLS with verify-full**, the only mode. Plaintext is refused.
- **A direct connection.** PgBouncer is not supported.
- **`max_pred_locks_per_transaction = 2048`**, recommended: a server-start setting, about 115 MB of shared memory at 200 connections. SERIALIZABLE writes and reads take predicate locks.

## Plan advice

grizzle carries each statement's proven plan to PostgreSQL as plan advice, which PostgreSQL 19's contrib module `pg_plan_advice` enforces; without the library loaded, PostgreSQL ignores the advice silently and plans by its own costs. A superuser loads it once, for the database (`ALTER DATABASE <db> SET session_preload_libraries = 'pg_plan_advice'`, read by each new session) or for the server (`shared_preload_libraries = 'pg_plan_advice'`, a restart); never on a role, whose own settings are drift. It has no extension to create. `grizzle migrate` refuses a session that has not loaded it before anything runs (stage `advice`), and every transaction of a Db checks first and fails with `AdviceUnloaded` before any statement. Leave `pg_plan_advice.feedback_warnings` off, its default.

## Migrations

`grizzle.config.ts`, whose default export is `defineConfig({ ... })`, and which every command names as its argument:

```ts
import net from "node:net"
import * as g from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pgDriver from "pg"
import { Blog, caPem, EtlJob, Web } from "./src/blog.ts"

export default g.defineConfig({
	schemas: [Blog],
	logins: [Web, EtlJob],
	migrations: "migrations",
	rolePrefixBytes: 0,
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
			Effect.mapError((cause) => new g.CredentialError({ cause }))
		)
	})
})
```

Every setting is required, and nothing else is configurable:

- **`schemas`**: the installations, at least one, each listed by its top level, which installs every level below it.
  Two listed schemas over one root, one a level of the other among them, are refused.
- **`logins`**: every login, and through them every role and workload, each over a level of a listed schema. A login
  over a schema no listed one holds is refused; a login not listed is not installed, nor are its roles. Login and role
  names are unique across an installation.
- **`migrations`**: the directory, absolute or relative to the config file's directory.
- **`rolePrefixBytes`**: the bytes of the longest role prefix any installation of the config is under, a fact of the
  deployment: the bytes of the prefix production's roles run under (`0` where they are at their stems, `9` for a
  prefix like `r20261120`); a test harness that installs each case under a prefix of its own states the longest such
  prefix's length. Every command
  refuses a login or role whose PostgreSQL role, `<prefix>__<stem>`, would pass PostgreSQL's
  63 bytes under a prefix that long, naming the role, its bytes and the limit, before anything is written, so
  `generate` never drafts a role `migrate` would cut short; and every command that connects refuses a connection whose
  `rolePrefix` is longer.
- **`connection`**: a function returning where `migrate`, `drift`, `roles` and `uninstall` connect, as the
  role that owns the schemas. Only they call it, so `generate`, `check` and `names` read no cluster setting and no CA file, and
  run in CI where no cluster is reachable. Its password is a `Redacted` or an Effect evaluated for each connection
  attempt. Its `rolePrefix`, which `DbLayer.make` takes too, is the installation's own, optional: see "Two
  installations on one cluster" below.

grizzle reads no file you don't name and no environment variable for where to connect: the config reads its own
credentials.

```text
grizzle generate <config> [--name <name>] [--schema <schema>] [--rename <old>=<new>]... [--drop <old>]...
    draft the next migration from the schemas' changes
grizzle generate <config> --custom --name <name> [--schema <schema>]
    an empty migration for data steps
grizzle draft-key <config> [generate's options]
    the key of the draft generate makes with these options: the SHA-256 of every input it reads
grizzle check <config>
    generated, resolved and untampered? (offline)
grizzle migrate <config>
    apply pending migrations, then check the database against the snapshot as drift does
grizzle drift <config>
    does the database match the snapshot? (applies nothing; migrate ends with this check)
grizzle names <config>
    each hashed object's PostgreSQL name and what it is
grizzle roles <config>
    the installation's PostgreSQL roles in the cluster
grizzle uninstall <config>
    drop the installation's schemas, with every row they hold, and its roles
```

`--name` is lowercase ASCII letters and digits in words joined by `_` or `-`, at most 240 characters, so that the folder `<timestamp>_<name>` fits
one file name (NAME_MAX, 255 bytes); without it, a drafted folder is named after its change. The timestamp is the
committed chain's, never a clock's: a schema's first folder is `19700101000000`, each later one the second after the
newest folder's, so two drafts on one chain (two lines of work merged) share a timestamp, which `generate`, `check` and
`migrate` refuse as a forked chain. `--schema` is accepted only when the config lists several schemas, and required
there with `--custom`, `--rename` or `--drop`. Exit codes: 0 ok, 1 refused, 2 usage error, 130 interrupted.

The loop: change the schema in code, run `grizzle generate grizzle.config.ts`, read the SQL it drafts and resolve its
markers, run `grizzle check grizzle.config.ts`, commit, and run `grizzle migrate grizzle.config.ts` from CI or the
deploy.

- **Drafted from a snapshot, never from a live database.** `generate` compares your schemas, their roles and logins,
  and every login's workloads with the committed snapshot, and writes the new snapshot and a folder
  `migrations/<root>/<timestamp>_<name>/` of numbered SQL files and a `meta.json`, `<root>` the PostgreSQL schema of
  the installation's root level. A snapshot is two files in `migrations/<root>/`, one value under the one fingerprint
  `snapshot.json` records: `snapshot.json` (the fingerprint, the levels, the constraints' laws and the rosters' codes)
  and `manifest.json`, the rest. Beside them, `served/<login>.json` holds each login's workloads compiled under the
  snapshot, the one file an app imports for `DbLayer.make`. Commit all of them.
- **A draft is a function of its inputs, and `grizzle draft-key` prints their key.** `grizzle generate <config>
  [flags]` leaves the migrations directory byte for byte the same, folder names included, wherever and whenever it
  runs, given the same inputs, which grizzle names in one roster (`packages/grizzle/src/cli/draft-inputs.ts`) and reads
  and digests by one code:
  1. the command line's flags: `--name`, `--custom`, `--schema`, and each `--rename` and `--drop` in order, as
     generate reads them, never the configuration file's path or `--phases`, which writes to stderr alone;
  2. the configuration: the configuration file's bytes, and every module its import loads but grizzle's and a
     package's, each by its path from the configuration file's directory and its bytes;
  3. the lockfile: the `pnpm-lock.yaml` nearest above the configuration file, by its bytes, which names every package
     a module loads through `node_modules`, grizzle's dependencies among them;
  4. the committed migrations directory: every visible entry of the directory the configuration's `migrations` names,
     by its path there and a file's bytes; an entry whose name starts with `.`, an editor's or the scratch a write
     passes through, is none;
  5. grizzle: each of its packages' `package.json` and every file under its `src/` (text, engine, openapi and
     grizzle), by its path in the checkout and its bytes, which a commit of grizzle names;
  6. Node: the version of the Node that runs it; the variables its own code reads (`NODE_COMPILE_CACHE`,
     `NODE_COMPILE_CACHE_PORTABLE`, `NODE_COMPILE_CACHE_READONLY`, `NODE_V8_COVERAGE`, `WATCH_REPORT_DEPENDENCIES`)
     configure the runtime, never what a draft holds.

  `grizzle draft-key <config> [generate's flags]` prints the SHA-256 of exactly these, in hex on one line, each input
  by what names it in its member, never by an absolute path: a cache of generate's output keys by it and keeps no list
  of its own, so a change of the roster reaches every cache in grizzle's own commit. Nothing else reaches a draft: no
  clock, no time zone, locale or other environment variable but the ones Node reads of its own, no directory it runs
  in, no host, CPU count or randomness, and no order a file system lists a directory in (every listing is sorted). A
  configuration module that reads a file, a variable or a clock as it loads makes an input no key sees: keep the
  configuration a function of its modules. `test/unit/cli/draft-determinism.test.ts` holds the draft to its inputs:
  one source drafted from nothing and then on its committed chain by two real processes at two absolute paths, from
  three directories, in two time zones and two locales, one after the other, writes one tree byte for byte.
  `test/unit/cli/draft-key.test.ts` holds the key to them: twin projects give one key, a change of any one input moves
  it while a change of nothing the roster names leaves it, and a real `generate` under a read trace loads, reads and
  consults nothing outside the roster, and no clock.
- **`manifest.json` is the record of what is installed**, which a draft reads of the installation it migrates from,
  where only the record can say what is installed, and the drift check judges a database by: each installed
  statement compact on a line of its own, but a PL/pgSQL function and a constant, each recorded by its header alone, a
  function with the SHA-256 of its source as PostgreSQL stores it (`pg_proc.prosrc`), a constant by its name, which
  digests its content. Their whole text is in the migration file that installed them, never twice in a file of its
  size. Each object lists what it is created after, `after`, one identity a line, so a dependency is stated once,
  under the object that has it. It records no object's reasons, state or phase, which only the compile reads, and
  carries its own seal, the digest of both files, so a file edited, corrupted or merged, or one of another snapshot,
  is refused; `check` holds the record to the one the schemas compile to.
- **No generated file is larger than 50 MiB**, the size GitHub warns at (it refuses a file past 100 MiB). `manifest.json`
  and each file of a migration folder (`meta.json`, `NN-<phase>.sql`) that would be larger are written as parts,
  `manifest.1.json`, `manifest.2.json`, … or `04-validate.1.sql`, `04-validate.2.sql`, …, each at most 50 MiB and each
  ending, where it can, at a blank line between statements, else at the end of a line; every command reads the parts
  back as the one file before it reads anything of it, so a seal, a ledger digest or a statement is the whole file's.
  Commit them all, and never rename one: parts that lay out no file (one missing between two, one alone, or parts
  beside the whole file) are refused by name. `snapshot.json` and each `served/` and `openapi/` file, which an
  application imports whole by its path, are never split: `generate` refuses one larger than 50 MiB, `FileTooLarge`,
  before writing anything.
- **Every file grizzle reads back records its format**: `snapshot.json` and each served file as their `format`
  member, and `manifest.json`'s seal digests both snapshot files under it. A pair whose `snapshot.json` records another
  format, or none, is read no further: `check` reports it with the format it records and the one this grizzle reads
  and writes, and `generate`, `migrate`, `drift` and `names` refuse it at stage `format`, writing nothing. No grizzle
  reads, converts or carries forward another format's records, and no installation crosses a format: purge and
  regenerate. Drop the installation (`grizzle uninstall`), empty its migrations directory, run `grizzle generate`,
  which drafts the schema afresh as one init migration in this format, and `grizzle migrate`. A served file is written
  again by `grizzle generate`, and an application refuses one, or a `snapshot.json`, of another format where it loads
  it, `ArtifactFormat`.
- **Plain SQL you may edit**, as long as the database ends where the snapshot says, and the drift check after the apply
  judges every edit by the catalog it reaches. Any text tool may read and write a drafted file back: every constant
  whose value holds a control character or a line or paragraph separator is written as an escape string (`E'\r'`, a
  function body as one continued line by line), which PostgreSQL reads as the same value, so no line ending a tool
  rewrites sits inside a value. What the schema drops is
  dropped in the same migration, as declared. A declared rename happens in place, as does a type change of a field its
  caller writes by a cast; any other type change sets the field aside, filled by the value you write at a
  `-- grizzle: placeholder` marker in its table's fill, which may join other tables, once every new column holds its
  value. A placeholder also asks for the values of a new field its caller writes, on a table that may hold rows. Roles' views, policies and functions hold no data: one that
  changes, or reads anything the migration changes, is dropped and created again in one transaction. Privileges change
  one at a time, each privilege of one role on one object: the migration grants what the target holds and the
  previous installation did not, revokes what that held and the target does not, and touches no other grant, so a
  migration that changes one relation or one role leaves every other role's grants as they are. An object the
  migration drops takes its grants with it, and one it creates again, a view, is granted
  again what the target states on it, to every role the target grants it to.
- **No guessing.** grizzle never guesses a rename and drops nothing you didn't declare. Declare each with
  `--rename <old>=<new>` or `--drop <old>`, once per name, each side a relation (`Task`), a field (`Task.title`), a
  roster's handle (`Status#done`) or a login (`@web`); swaps and chains work. A renamed relation keeps its rows, a
  field its values, a handle its code, and a login its PostgreSQL role (`ALTER ROLE ... RENAME TO`), with its password
  and grants. A family's hidden columns (its copy of the count, a counted index, a fold's hidden accumulators, each
  `pred` term) are named by the laws they hold the values of, so renaming the owner, the member, the
  count, or a roster or handle a fold's selection reads renames them too, in place (`ALTER TABLE ... RENAME COLUMN`),
  and every key, index, CHECK and foreign key the renamed names reach is renamed to its new name by its definition,
  never built or validated again: a pure rename keeps every drawn value, with no backfill, no table rewrite and no
  index build. A name the schema dropped that no declaration names is refused, naming it: a stored relation, a field
  its caller writes, a handle, or a login, whose password and outside grants no migration can give back.
- **A schema renamed in code is a new PostgreSQL schema.** Its first migration, drafted while the migrations directory
  holds schemas the config doesn't list, carries its creating statement commented out under
  `-- grizzle: data loss`: uncomment it to start empty and leave the old rows behind, never migrated again, or keep
  the old name and delete the folder. `check` and `migrate` refuse the folder until you decide.
- **Codes are history.** The snapshot records each roster's codes: a new handle takes the next code, a renamed one
  keeps its own, and a removed one leaves a hole no handle takes again, whether the roster is ordered or not. The migration validates the roster's domain
  against its new names constant once every relation and field it drops is gone, refusing, by table and column, every
  row that holds a removed code. Change or delete those rows in a data step first: preferably a custom migration
  (`generate --custom`) drafted before the removal, so the removal applies after it in the same `migrate`. After a
  refused attempt the removal's folder is partially applied and resumes where it stopped, so no folder can go before
  it: change the rows outside any migration, a closed relation's by deleting each row and inserting it again,
  never by UPDATE, which its guard refuses. A set over a grown roster converts in place to its wider
  domain, the new handles absent. An ordered roster declared out of its codes' order is refused before anything is
  drafted: append new handles, or declare the roster `closed.unordered` where its order means nothing. An unordered
  roster has no order to keep, so its handles may be declared in any order, and a declaration that only reorders them
  is no change at all; its new handles take the next codes in the UTF-16 order of their names. Declaring an existing
  roster `closed.unordered` moves no code and installs no constant: the migration it drafts holds no SQL, only the
  snapshot that records the roster's kind. Declaring one `closed.ordered` again holds its codes too, and is refused
  unless its handles are declared in their codes' order.
- **A roster continues one roster at most.** It continues the roster a `--rename` names, or else the roster of its own
  name or an alike spelling of it (`Status`, `status`), unless a rename of another roster takes that name, whatever
  either one's kind: a roster declared `closed.unordered` continues the ordered roster of its name with its codes, so
  it needs no `--rename` and no placeholder. Every other roster is new, its codes from 0. A closed id or a set keeps its stored codes only on the roster its own continues.
  Anywhere else its codes would name other handles, so its conversion is a `-- grizzle: placeholder`: moved to
  another roster, to or from an integer, renamed without `--rename` (that is a `--drop` and a new roster), or left on a
  name another roster takes (`--rename Draft=Status --drop Status`). The marker says why, and it offers no cast:
  compute each row's new value from what its old value means.
- **A closed relation's change is a new constant.** Constants are named by their contents, so a change installs new
  ones, replaces and validates every CHECK that reads them, gives every generated field that reads them its new
  expression (`SET EXPRESSION`), and drops the old ones `RESTRICT`, so PostgreSQL refuses a migration that missed a
  reader. `SET EXPRESSION` checks every constraint over its field against the new values in its own statement, so a
  CHECK, key or unique index over the field that the target defines otherwise, or that reads a field the backfill
  draws again, is dropped before it and added again after it. A rule over closed relations alone, new or with changed closed rows, runs as its violation query at the start
  of the migration's first file, refusing the migration before it changes anything. A key holding slots reads its
  owners' counts, never its slot roster's size: a changed count replaces its counts' and rows' constants and its
  owners' bases where they move, and a grown or renamed slot roster replaces none.
- **A family added to stored rows is backfilled** by SQL over those rows, in the migration that adds it: each member's
  index in its member key's order, each count, each fold's running values in index order, and a tree's intervals. So
  is every value whose filler changes: a fold that steps over another field, a copy that reads another field, a family
  whose group or order changes; and every value drawn from one of those, through any chain of copies and folds, such as
  a copy of a copy whose target moved. The snapshot records what fills each drawn or accumulated field, its family's,
  fold's or copy's law, so a changed filler draws the field again, and one only renamed keeps it. A copy is its pair's:
  the field it copies along its family's axis, whatever else the containment that carries it states. A copy added to
  or taken from that containment, or a field added to the relation, keeps every other copy, its column and its values;
  only the axis's foreign key and the UNIQUE it references, which read every copy the axis carries, are built again.

### A stored index is data

An ordered family's or a tree's index holds the order its caller wrote, so a migration
that re-points the family's group (its owner re-keyed, the group's fields dropped and added, a tree's parent field
replaced) keeps every stored index, as it keeps one only renamed: the field stays the index of the same owner's
count, of the same kind. Its count, copies and folds are drawn again over the kept order, each fold's running values
in that order, after your data step fills the new group. Validate then proves the kept order a sequence of each new
group: a data step that moves members between owners so that an owner's indices are no longer 0 … n − 1 is refused
by the family's own key, bound or foreign keys, naming its law, and nothing is renumbered silently. To regroup and
give up the stored order, declare it: `--drop Line.at` while the schema still declares `Line.at` drops the stored
index, and the migration draws the target's anew in member-key order. Only an index new to the migration, or one
whose family changes owner, count or kind, is drawn anew undeclared. A tree's interval is kept as its index is, so a
tree re-keyed by its root (a root field added, renamed or replaced) keeps every row's `at`, `start` and `end`, and its `parent`, drawn anew, is drawn from them: each
row's parent is the row of its own root value whose interval holds its own most tightly. Your data step fills the
new root fields before the backfill; Validate proves the kept intervals each new root's one tree, so a data step that
maps two stored trees onto one root value, or splits one across two, is refused by the tree's key or its laws. A
tree added to rows that held none, whose intervals no installed tree drew, is refused, naming it. The constraints are
added
after the backfill, `NOT VALID`, and validated, so a value drawn wrongly refuses the migration. A fold added to a
tree that holds rows, or changed on one, is drawn in the tree's stored sibling order, which is its caller's. A family
the stored rows alone don't determine is refused, naming it: copies that read each other, or a fold over a copy. A
chain is drawn by recursion: along a family's slots by the family's scan, and down a tree from its roots. The
backfill's window functions and its recursive steps are migration SQL you review; queries at run time use neither.

- **Data steps** go in a custom migration, `generate --custom`: a folder holding only `meta.json`, from the committed
  snapshot to itself.
  Add `01-<words>.sql`, `02-<words>.sql` and so on, each one transaction unless its first line is
  `-- grizzle: no-transaction`, which runs each statement alone, each ending at a semicolon where psql would end it:
  outside quotes, dollar quotes, comments, parentheses and the `BEGIN ATOMIC … END` body of a function or procedure.
  None controls its own transaction. Every file runs at SERIALIZABLE, and the database must still end at the
  snapshot. grizzle binds none of your statements and proves no plan of them, so PostgreSQL plans each by its own
  costs: a custom file's transaction runs under no plan advice (`pg_plan_advice.advice` set empty first), where a
  drafted file's runs under the advice its `meta.json` records of its data steps, each bound to read whole and join by
  a hash, a read at a constant through an index that stands where the step runs. A drafted file keeps that advice while
  its recorded statements still stand in it, in their order and as recorded: a statement you write between them, a
  data step at a draft's slot, runs under none, the advice set off just before it and set again after it in the same
  flight, so grizzle's statements keep their proven plans and none of yours meets them. A drafted file whose recorded
  statements no longer all stand, one deleted, rewritten or moved, runs under no advice at all, as a custom file does.
- **`check` reads no database.** It reports, each with its fix, a schema change you haven't generated, a drop no
  declaration names, a workload program whose index needs differ from the snapshot's (naming it), a served file that
  is not what its login's workload compiles to (naming the login and the first program where they part), one missing
  or one of a login the configuration does not list, an unresolved marker or data loss, and an edited
  `snapshot.json`, `manifest.json` or `meta.json`.
- **`migrate`** connects as the role that owns the schema and the database, applies the pending files, records each in
  the schema's ledger, and refuses an applied file edited, removed or added since. Then it refuses drift, a database
  that is not exactly the snapshot's, so on a database changed by hand it applies its files, then refuses, one line a
  fact: a missing or unexpected one, or a changed one by where its two definitions first differ, at which character,
  and each around it, every control character escaped. A PL/pgSQL function is judged by its definition's header and
  by its source's SHA-256 apart: one whose source differs is reported with both digests and the committed statement
  that last defines it (`statement <n> of <folder>/<file>`), the text to compare the installed source with.
  It runs that check in the session that applied, also when nothing was pending, so no `drift` need follow it.
  `drift` runs the same check alone, for a database not just migrated: from CI or a schedule. Both judge the database
  as it stands: a grant already held, or a revoke of a privilege never held, changes nothing. Both refuse a process
  environment that sets `PGOPTIONS` or `PGREPLICATION`, at stage `environment`.

### Names come from your code

A declared name is ASCII letters, digits and underscores, starting with a letter.
`TaskNote` becomes `task_note` for the schema, tables, derived tables, domains, rosters' domains, columns, row
checks, a table's whole view and a role's query entries' views; a domain's CHECK is `check`; a schema's schema of
whole views is `__` and its own. A login's or role's PostgreSQL role joins its schema's conversion and its own, its
stem, under the installation's role prefix: take it from `roleNameOf(login or role, connection)`, a schema's or a
role's schema from `schemaNameOf(schema or role)`, and a schema's schema of whole views from `wholeSchemaNameOf`,
never spell one. A relation or roster whose name a library derives is the exception, records' own among them: its
table or domain and its whole view are hashed over its name (Records of a query, `derivedName`), whatever its
length.
Refused: two names that convert to one, a conversion over 63 bytes (a login's or role's with its schema's,
and with the role prefix, which `migrate`, `DbLayer.make` and `roleNameOf` refuse before they connect), and a schema
name or a role prefix starting with `pg_`. A relation's, roster's, derived relation's or schema's name over 63 bytes
is refused by its builder, `IdentifierTooLong` naming it and its conversion's bytes, and a field's or a check's by
its schema's compilation. A program that writes declared names judges each by the same rule,
`parseDeclaredName(name)`: the name, or its `NameFault`, its characters or its conversion and that conversion's
bytes, which `nameFaultText` states. Everything else (keys, foreign keys, indexes, functions, triggers) is
named `__<readable part>_<digest>`, with a COMMENT saying what it is, and listed by `grizzle names`. grizzle's SQL
qualifies every name: a table as `"shop"."task"`, a type as `"pg_catalog"."text"` or its keyword (`integer`), a
function as `"pg_catalog"."count"`. So a relation may be called `Text` or `Uuid`, and no search_path, the
database's, a role's or a session's, changes what a migration or a query means.

- **Two installations on one cluster.** PostgreSQL roles are the cluster's, every database's, while an installation is
  one database's: two installations of one schema on one cluster need roles of their own. Give each connection its
  `rolePrefix`, used verbatim (a lowercase PostgreSQL identifier segment, `[a-z_][a-z0-9_]*`, with no `__`, not
  starting with `pg_`, and at most 43 bytes, so the installation's decoder login, `__live_<digest>`, its function owner,
  `__owner_<digest>`, and a login's role set aside while logins are renamed, `__aside_<digest>`, fit under it in
  PostgreSQL's 63; anything else is refused at
  stage `config`), beside its `database`, in `grizzle.config.ts` and in
  `DbLayer.make` alike, and state the longest in the config's `rolePrefixBytes`. Every login's and role's PostgreSQL
  role is then `<rolePrefix>__<stem>`: `a__keys__dashboard`
  in one installation, `b__keys__dashboard` in the other, `keys__dashboard` in one without a prefix, the names never
  meeting. One committed `generate` output installs into all of them: the drafted SQL names each role by its variable,
  `:"keys__dashboard"`, and the current database, which a `GRANT TEMPORARY ON DATABASE` names, by `:"DBNAME"`, as psql
  writes them, and `migrate` fills each with its installation's before it connects, refusing a variable it cannot fill;
  a statement never filled is a syntax error, never another role. Write a role in a data step the same way. The ledger
  records each file as written, so one folder's digest is the same in every installation. The snapshot and the served
  files hold the stems, and `check` reads no prefix.
- **`roles` and `uninstall`.** `grizzle roles` lists the installation's roles in the cluster, one per line: every role
  its migrations create under its role prefix (or at their stems without one) for a level of a configured schema,
  whatever snapshot the database is at, and no other: each login's and role's, `<rolePrefix>__<level>__<name>`, and the
  decoder login and the function owner each level's schema names, `<rolePrefix>____live_<digest>` and
  `<rolePrefix>____owner_<digest>`. `grizzle uninstall` destroys the installation and every row it
  holds: in one transaction, it drops its schemas in the connection's database (each level's, each level's schema of
  whole views and each role's schema of views) with everything in them, ends every session holding a temporary object of
  one of its roles, as a migration that drops a role does ([Deploying](#deploying)), revokes what its roles still hold there and on the database (DROP OWNED, under
  the database privilege's lock), and drops the roles. The extension's schema and every other role stay. PostgreSQL
  refuses to drop a role that anything of another database still depends on (SQLSTATE 2BP01, its DETAIL naming that
  database): the transaction rolls back whole, nothing is dropped, and the report carries PostgreSQL's message and
  detail. After it, `grizzle roles` prints nothing, and `grizzle migrate` installs afresh.
- **Indexes follow the code.** Every index comes from a rule, from a workload program's queries through the roles they
  read, or from a role's write filter. Every workload program edit, addition, rename or removal is refused by `check`
  until you run `generate`, which commits the login's served file again, with the indexes the edit needs.

The [agent guide](packages/grizzle/skills/grizzle/SKILL.md) is the full workflow: markers, renames, legal edits,
refusals and deploys.

## Deploying

Size the server's lock table before a large schema's first `grizzle migrate`. A migration runs file by file, each file
one transaction, which keeps every object it locks until it commits, and PostgreSQL 19's lock table holds exactly
`max_locks_per_transaction × (max_connections + autovacuum_worker_slots + max_worker_processes + max_wal_senders + 2 +
max_prepared_transactions)` locked objects, the 2 its autovacuum launcher and slot sync worker, shared by every
transaction at once: 19 sizes it at startup with no margin past it, where 18 let a transaction run past (PostgreSQL
commit 79534f906, which doubled the default to keep the capacity). `grizzle generate` counts, from the drafted
statements, the most objects one transaction of each file locks, and records it in the file's entry of meta.json
(`locks`) and prints it: every relation the file creates, alters or drops, with its TOAST relations and row types; every
object a catalog row it writes depends on, which PostgreSQL 19 locks for the dependency it records (pg_depend.c
dependencyLockAndCheckObject): a column's domain, a CHECK's function, a key's constraint, a trigger's function, an
object's schema and owner; every object a GRANT, a REVOKE or a COMMENT names; every relation a query plans over, with
every index of it, and what each trigger of a table it writes runs; the transient table a rewrite copies a table into,
which outlives its drop as a lock. The count is an upper bound of what PostgreSQL holds, at most twice it on the
generated migrations of the suite. A fresh install of edullm's QTI database (Qti, the ledger and delivery) held 539
objects in 01-setup.sql, 2,640 in 02-structure.sql, 394 in 03-indexes.sql and 1,117 in 04-validate.sql, which a server
at PostgreSQL 19's defaults, 128 × (100 + 16 + 8 + 10 + 2) = 17,408, holds many times over; a server that keeps 18's
default of 64 holds 8,704. `grizzle migrate` reads the six settings in its survey, before anything runs, and refuses an
apply whose largest transaction, with the session's apply lock of each schema it holds through every transaction, the
table cannot hold (LockTableShort): it names the file, its count and the least max_locks_per_transaction (it takes a
restart), or max_connections, that holds it, and nothing has run. A schema's first migration counts its drift check
too, which replays every object of the snapshot beside the schema in one transaction, none yet proven. Every other
session's locks share the table and are not counted: a server where several migrations or test installs run at once
needs the count for each, and a test cluster whose workers each install the schema sizes its members by the count
times the workers a member serves (`migrationLocks` of `@bjornpagen/grizzle/locks` reads a migrations directory's
largest count). A file edited past its record and a custom migration's file state none, since no count read their
statements; a statement the server still refuses for want of shared memory stops with SQLSTATE 53200, rolled
back whole: the refusal (LockTableExhausted) keeps PostgreSQL's message, names `max_locks_per_transaction`, and states
the six settings it read from the server.

Build each `DbLayer` once per process, in module scope. Building it reads the login's served file once and rebuilds what
runs each of its programs: the parameters' codecs, the rows' readers, the refusal classifier and the prologue, under
the codes of the rosters the file holds. It compiles nothing and evaluates no schema, so it costs tens of milliseconds
however large the schema. grizzle trusts its own file: `grizzle check` refuses a served file that is not its login's
compile under the committed snapshot, a stale one or one edited by hand, and every transaction guards the database
with the file's fingerprint. `DbLayer.make` fails with an `OpenError` at stage `config` for a file of another login
than the name `served` was given.

Open a `Db` per request or handler. `Db.open` contacts nothing: it finds the role's login layer, turns the token into
claims and builds the handle on the host, so a request's first call is its first round trip. grizzle assumes the
database is the one the served file's snapshot was migrated to, and checks nothing of it at runtime beyond what every transaction
checks (below). `grizzle migrate`, which runs the drift check after every apply, and `grizzle drift` judge the rest:

- **The server:** PostgreSQL 19, the database UTF8 with the builtin `C.UTF-8` locale, and the server's
  `max_stack_depth` at least its default, 2MB, which the limits grizzle holds every pattern to rest on
  ([Limits](limits.md#limits)); `grizzle migrate` refuses a server below it. The server is built with PostgreSQL's default
  `block_size`, 8192 bytes, from which grizzle derives the bound of every key, row and index entry it admits;
  `grizzle migrate` refuses a server built with other pages at stage `blocks` (`BlockSizeMismatched`), in the same
  first read, before anything runs. The extensions the schema needs are the
  migration's to install.
- **Settings:** the login's and the role's settings exactly as the snapshot installs them; the database's own defaults
  are its owner's, none of them grizzle's. Every login's own defaults pin its sessions, each a setting a grizzle guarantee rests on:
  `search_path = pg_catalog, pg_temp`, `extra_float_digits = 1`, `DateStyle = 'ISO, YMD'`, `bytea_output = hex`, and
  `lc_monetary`, `lc_numeric` and `lc_time` at `C.UTF-8`; a login whose roles search vectors also
  `hnsw.iterative_scan = strict_order` and `hnsw.max_scan_tuples = 20000`. Every session of the login's pool sends them as startup options, so neither a
  role's, the database's or the server's default nor the environment's `PGOPTIONS` reaches it, and `DbLayer.make`
  refuses a process environment that sets `PGREPLICATION` (stage `config`). A login with one missing, changed, or set
  for it in this database alone is drift. Every other setting is the database owner's, on the database or the server,
  JIT among them: on a server built with LLVM, `jit_above_cost` can make a large statement compile its plan to machine
  code first.
- **Privileges:** the login's and the role's privileges exactly as the snapshot installs them, and the policies naming
  the role the snapshot's, by table and name. No role or login is granted `TEMPORARY`: a write's carriers travel in
  its transaction's settings. The drift check judges each role's and login's own `TEMPORARY` grant exactly, none;
  `PUBLIC`'s, which PostgreSQL gives every database, is the database owner's, which grizzle neither relies on nor
  revokes. A login that fences a relation holds MAINTAIN on its table and USAGE on its schema, which
  its fenced writes lock it by ([READ COMMITTED writes](errors-and-concurrency.md#read-committed-writes)). The login is LOGIN NOINHERIT and the
  role NOLOGIN, neither with
  SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS. A role's members are its login and the migration role; any
  other membership of the login that confers something is drift. Row-level security is enabled, not forced, on every
  table the role writes through a query entry that leaves rows out.

A value that is not a role of a served login is refused at stage `schema`. Otherwise `Db.open`'s refusal is an
`OpenError` at the first stage that fails: `role` (no provided layer holds its login, or the layer's file holds no role
of its name), `schema` (the token is not a
string) and `token` (`verify` refused or threw, or the payload does not decode through the role's contexts). A claim of
a refined field is judged by the field's domain where a statement reads it: one PostgreSQL refuses fails that call
with the server's `ServerError`, as does a statement naming an extension's type the role holds no USAGE on, or that
the database does not install.

**Migrations are downtime.** Each migration file takes the ledger's exclusive lock, which waits for the transactions in
flight. From the first file until the last commits, and while a stopped run leaves a folder unfinished, every `Db` call
fails at once with a `stale` `CallError` (`StaleSnapshot`, reason `Migrating`) before any statement runs. After the migration, a `Db` opened at the old snapshot fails with `stale` (reason `Migrated`),
and keeps failing: deploy the code that carries the new served files and open new `Db`s with them. A migration that
drops a role, a login, the decoder login or the function owner ends, right before its DROP ROLE, every session that
holds a temporary object of it, and waits for each to exit: a temporary table one of the role's transactions made
stands until its session ends, and PostgreSQL refuses to drop a role while one does (2BP01). Such a
session belongs to the installation that is ending; its pool opens a new connection at the next lease, and every other
session, of the same login among them, runs on. A migration whose
Structure holds a data step (a backfill, a fill, a reviewer's UPDATE) drops the immutability guard of every immutable
relation's table before its data steps and creates it again after them, in the same transaction, so a direct SQL reader
of any such table also waits for the migration to commit: DROP TRIGGER takes ACCESS EXCLUSIVE. Only dropped, never
disabled, does the guard leave the steps' UPDATEs as fast as the table without it: PostgreSQL counts a disabled
BEFORE ROW UPDATE trigger as one, which makes an UPDATE compute every stored generated column of every row it writes
and hold memory that grows with its rows. Without the guard a data step may delete or rewrite an immutable relation's
rows, which the rule judge is compiled never to see from any other writer: it reads no row a write removes of an
immutable relation, and no row a write adds to one where a contained relation pins its key
([Rules over queries](schema.md#rules-over-queries)). So the data step pays for it, once, in its own transaction: right after
its data steps and before the guards stand again, every stored derived relation whose definition reads an immutable
relation is made its definition's rows again by one MERGE of its table, and every rule over a query that reads an
immutable relation is checked over every row, where a step you write can move them: the data step at a placeholder,
or a custom migration's file. The steps grizzle drafts, a fill and the backfill, write columns it knows, so after
them only the rules whose checks read one of those columns are checked, and only the stored relations that read one
and stand from before the migration refilled; a draft whose steps meet no such read re-checks nothing, and a rule
re-checked there is checked in Validate no more. A data step that deletes or rewrites immutable rows against a rule is
refused before it commits, 23000 with the law as its constraint, and rolled back with its transaction; a stored
relation over immutable rows equals its definition after it. A custom migration's transactional file does the same
after its statements, through the function `__recheck` each level holds where it has such a rule or stored relation.
A migration with no data step re-checks nothing. The re-check reads each table as a rule's first migration reads it,
a bounded number of times for each law over it.

**Each transaction checks the snapshot.** Every transaction a `Db` sends starts with two statements in the same round
trip: one takes the ledger's lock without waiting, so a running migration refuses it at once and the app never waits;
one checks the snapshot and takes on the role and the claims for that transaction only. A pooled connection never
carries one request's role or claims into the next. An apply with nothing to write still sends BEGIN, those two
statements and COMMIT, so a stale `Db` never answers `unchanged`.

**Sessions on the server.** A pool keeps every session it opened until the session fails or the layer's scope closes,
so a deployment holds at most its processes times their pools' `max` sessions open on the server, each process the
most its calls ever needed at once. A platform that suspends an instance between requests, as Vercel's Fluid compute
does, suspends its sessions with it: an instance that resumes reuses them warm, and the server ends those of an
instance that stays suspended once its TCP keepalive finds no answer, after `tcp_keepalives_idle` plus
`tcp_keepalives_count` times `tcp_keepalives_interval` seconds of silence: 300 + 2 × 30 = 360 s under the defaults of
Amazon RDS for PostgreSQL, and 7,200 + 9 × 75 = 7,875 s under PostgreSQL's own, which take Linux's. Size `max` so that
it, times the instances live or suspended within that window, beside every other login's sessions and the migration's,
stays within the server's `max_connections` (on RDS, `LEAST({DBInstanceClassMemory/9531392}, 5000)` by default);
Vercel publishes no cap on its instances. Past it, the server refuses the next session, which the call that asked for
it reports as `unavailable` with the cause `tooManyConnections`. A session silent past that window, or past the
server's `idle_session_timeout` where it is set and shorter, may have been ended by its server while its instance was
suspended, unheard, so the pool probes it before a call runs anything on it, one round trip that reads the window
again: a dead one is closed and another opened in its place, and the call answers as on a live session. Each session
reads its window from its server at its first call, beside its connection, and a call on a session silent for less
sends nothing more. Silence is counted from the call that last took the session, on the process's monotonic clock and
its wall clock, the larger reading kept: a freeze neither counts goes unseen (a Firecracker microVM's guest clocks
continue from the pause until the guest sets its wall clock), and then the first call on a dead session answers
`commitUnknown` for a write, its COMMIT gone out with no answer back, and `transport` for a read. grizzle depends on
no platform's package.

**RDS with IAM authentication.** The password is an Effect that signs a token for each connection attempt;
`@aws-sdk/rds-signer` signs locally, without a network call, for the user `roleNameOf(EtlServed, connection)` names. Grant that role
`rds_iam` with `GRANT rds_iam TO <role> WITH INHERIT TRUE, SET FALSE`. `grizzle drift` judges what a login can do, not
how its memberships are spelled: a membership beyond the login's roles is no drift when it carries SET FALSE and no
ADMIN and the login's privileges on the installation stay exactly its own (USAGE on the schema, SELECT on the ledger).
`rds_iam` holds nothing in the installation, so it is no drift; a membership that would hand the login any privilege or
ownership there is.

```ts
import { Signer } from "@aws-sdk/rds-signer"
import * as gRuntime from "@bjornpagen/grizzle/runtime"
import { Redacted } from "effect"

export const RdsEtlLayer = gRuntime.DbLayer.make({
	...connection,
	login: EtlServed,
	pool: { max: 2 },
	password: Effect.tryPromise({
		try: () =>
			new Signer({
				hostname: "db.internal",
				port: 5432,
				region: "us-east-1",
				username: gRuntime.roleNameOf(EtlServed, connection)
			}).getAuthToken(),
		catch: (cause) => new g.CredentialError({ cause })
	}).pipe(Effect.map(Redacted.make))
})
```

## PostgreSQL known issues

**Imprecise GiST indexes over multibyte text.** Through PostgreSQL 19, btree_gist prices a UTF8 text key by the byte after the common prefix of its subtree's bounds, cut at a character boundary, so characters that share leading bytes, such as the CJK Unified Ideographs, price alike, and a GiST index led by such text is imprecise: a point lookup takes 14 buffers for one row of 20,000 two-ideograph keys, where ASCII keys take 3. grizzle builds such an index only for a no-overlap key or a range filter whose text field comes first. It stays valid; only its lookups cost more. PostgreSQL's master branch fixes this in commit b82d69abf6, for PostgreSQL 20, where the lookup takes 3 buffers; rebuild an older index there. No PostgreSQL 19 release carries it (a request to back-patch it is drafted, not filed, in [upstream/btree-gist-multibyte-penalty](upstream/btree-gist-multibyte-penalty)), and grizzle's tests run on the unpatched release, so the indexes the test suite builds pay this cost too.

**CHECKs and generated columns re-planned per statement.** PostgreSQL 19 parses and plans every CHECK and stored generation expression again in each statement that writes its table: it reads each literal back from the stored expression a byte at a time and evaluates each IMMUTABLE function the expression calls, copying the value in. Counted in user-mode instructions of the writing backend on 19.0, a literal costs a statement about 207 instructions a byte, and a call of a constant about 7,800 plus 0.83 a byte of its value; before grizzle answered it, each INSERT statement into qti's interaction_attribute table paid 90.6 million instructions for its CHECKs and generations, its attribute table 35.0 million. grizzle installs each CHECK and stored generation that calls a constant of the installation's data, a closed relation's, a roster's or a dictionary's ([Closed relations](schema.md#closed-relations)), that matches a pattern, or whose literals hold more than 21 bytes of text or bits together, as a row function: a PL/pgSQL function of the columns it reads, named by its definition's digest, which each backend plans once with the constants folded in, and the CHECK or the column calls it. A statement then pays the call once a row, about 4,400 instructions, where it paid the literals and the constants once a statement, so a statement of many rows into a table of many such expressions pays more than it did: qti's interaction_attribute, 72 calls a row, breaks even near 300 rows a statement. Planning CHECKs once per relcache entry, as PostgreSQL plans index expressions and domain checks, would remove both costs: a change of grizzle's own that no PostgreSQL release carries ([upstream/relcache-planned-check-and-generation](upstream/relcache-planned-check-and-generation)). A roster's domain is unaffected: a domain's check is planned once per backend. Only the cost differs, never the behaviour.

**PL/pgSQL functions with many IFs or CASE arms compile in quadratic time, unless each statement is one line.** PL/pgSQL learns an IF's, an ELSIF's and a CASE WHEN's line number after its body's statements have asked for theirs, and PostgreSQL 19 rescans the function's source from its start whenever a location lies on a line before the one it last resolved, so a function of N such statements written over lines compiles in O(N x length), at CREATE FUNCTION and again at its first call in each backend: one CASE of 40,000 arms takes about 17 s. grizzle prints every statement of a PL/pgSQL block on one line, its body with it, and spells a string constant that holds a line feed as an escape string, so no location goes back but the block's own BEGIN, and its law functions compile in time linear in their length: qti's largest, 4.3 MB of 1,764 IF and ELSIF branches, resolves its lines in one walk of its source, where printed over lines it rescanned 2.3 GB. Recording where each line starts once and finding a location's line by binary search would fix it for every function, with the same line numbers: a change of grizzle's own that no PostgreSQL release carries, prepared for pgsql-hackers in [upstream/plpgsql-lineno-rescan](upstream/plpgsql-lineno-rescan) and not yet sent.

**A BEFORE UPDATE row trigger costs every row of an UPDATE, even disabled.** Through PostgreSQL 19, an UPDATE of a table with a `BEFORE UPDATE` row trigger locks each row before it updates it, a lock record in the WAL and the lock left on the new row version, computes every stored generated column whatever the UPDATE assigns, and keeps about 41 bytes of executor memory a row until the statement ends; an `INSERT … ON CONFLICT DO UPDATE` keeps the same for each row it updates, with no trigger at all: 4 MB a 100,000 rows. A trigger disabled by `ALTER TABLE … DISABLE TRIGGER` costs all of it, since PostgreSQL still marks the table as having one: on 19.0 a disabled one made an UPDATE of 100,000 rows compute 100,000 generation expressions it needed none of, write 5.6 MB more WAL and take 730 ms where 450 ms sufficed. grizzle's immutability guard is such a trigger ([Tables and types](schema.md#tables-and-types)), so a migration's data steps drop it and create it again after them, never disable it ([Migrations](#migrations)), and meet none of this; a write's in-place rewrite of an immutable table and its inserts that meet stored rows `ON CONFLICT DO UPDATE` pay the memory. Two fixes are prepared and not sent: keeping the per-row memory in the per-tuple context, a reply to the 2023 pgsql-hackers thread that fixed its sibling ([upstream/update-lock-mode-key-columns](upstream/update-lock-mode-key-columns)), and letting a disabled trigger mark nothing, a new thread ([upstream/disabled-trigger-hint-flags](upstream/disabled-trigger-hint-flags)). Only the cost differs, never the behaviour.
