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
	/** Required: where grizzle migrate and grizzle drift connect, as the role that owns the schemas. */
	connection: {
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
	}
})
```

- Every key is required, and nothing else is configurable: an unknown key is refused.
- Always `export default defineConfig({ ... })`. A plain object is refused.
- Every role is in exactly one login. The config refuses a login over a schema `schemas` doesn't list (or over another
  version of it), and two logins or roles of one schema whose names convert alike. A login missing from `logins` is
  not installed, nor are its roles, so `Db.open` refuses them: their PostgreSQL roles don't exist.
- A login owns its workloads: `login(Blog, "web", [AnonBlog, MemberBlog], { workload: [anonReads, memberReads] })`.
  A workload, `workload(schemaOrRole, { name: program })`, is over the login's base, a level of it, or one of its
  roles, and names queries, ordered queries, ChangeSets and relation keys. Two programs of one name across a login's
  workloads are refused when the login is built.
- `connection` is the migration role's: `driver` (the pg module), `transport` (`kind: "sslRequest"`, `host`, `port`,
  `open`, which returns a new socket, `ca` and `servername`; TLS is always verify-full, the server certificate chaining
  to `ca` and naming `servername`), `database`, `role`, `password` (a Redacted, or an Effect yielding one, evaluated for
  each connection attempt: an RDS IAM token, a secret manager's lookup) and `connectTimeoutMs`, the bound of each
  connection attempt. README's Deploying shows the RDS IAM password with `@aws-sdk/rds-signer`.
- Never write a credential into the config file: read it where the config runs, as the password Effect does.
- `generate`, `check` and `names` never read the connection. `migrate` and `drift` refuse a process environment that
  sets `PGOPTIONS` or `PGREPLICATION`, which node-postgres would send at their session's startup, at the stage
  environment.

## The loop

1. Edit the schema, its roles and logins in code. A program the application runs on every request belongs in a
   workload of its login: its access paths earn indexes, and DbLayer.make compiles it once, at startup. `grizzle
   generate` compiles it the same way for every role of its login first, so a program the layer would refuse fails
   generate with the same CompileError.
2. Run `grizzle generate grizzle.config.ts`. It prints one line per written file, then each marker to resolve as
   `<file>:<line>: <placeholder|rename candidate>: <what to do>`, then each loss to decide as `<file>: data loss:
   <what it loses>: <what to do>`, then `next: resolve the markers, then run grizzle check`. With no change it writes
   nothing and prints `no changes`.
3. Read every drafted SQL file, and resolve each marker:
   - **Placeholder** (`-- grizzle: placeholder` above a `__GRIZZLE_PLACEHOLDER__`): a value for a new NOT NULL column
     on a table with rows, or the conversion for a changed type. Write the value or the UPDATE, then delete the marker
     line.
   - **Rename candidate** (`-- grizzle: rename candidate`): keep the drop and add, or choose the rename; see
     [Renames](#renames). Either way, delete the marker. To keep, delete it with its instruction line.
   - **Confirm** (`-- grizzle: rename candidate:` followed by `-- Keep the ... below and delete this line`): the
     statements under it are one decision, with no other way drafted. It marks a relation or type set aside, with
     every index, identity sequence and statistics object a relation owns; an enum rebuilt; and a handle renamed in
     place. Keep every statement as drafted and delete the two marker lines; `check` refuses a group kept in part.
   - **Data loss** (`-- grizzle: data loss:` above a commented statement): the statement destroys stored data, a
     relation with its rows or a field with its values, and grizzle never decides that for you. To lose the data,
     uncomment the statement. To keep it, choose a candidate rename that carries it (the line names each one) and
     leave the statement commented. The decision is the SQL itself: `check` and `migrate` refuse the folder while a
     loss is neither written in nor carried by a chosen rename, naming what it would lose, and refuse a loss decided
     both ways. The two comment lines may stay.
4. Tune if needed: batch a large backfill, add a data fix, reorder within a file. The catalog must end where the
   snapshot says. Name a PostgreSQL type or function the way the drafts do, by its schema
   (`"pg_catalog"."text"`, `"pg_catalog"."count"(*)`) or its keyword (`integer`, `bigint`, `boolean`): a statement
   of yours runs under the session's search_path, where a relation of yours named `Text` is the type `text`, and the
   drift check judges what it built.
5. Run `grizzle check grizzle.config.ts` until it passes. It prints `<schema>: ok (<n> migrations, snapshot
   <fingerprint>)`.
6. Commit the folder and `snapshot.json`.
7. Run `grizzle migrate grizzle.config.ts` from CI or the deploy, where its connection reaches the database. It prints
   `<schema>: applied <n> migrations, now at <fingerprint>` and each folder's files, or `<schema>: up to date at
   <fingerprint>`.

For data-only work: `grizzle generate grizzle.config.ts --custom --name <name>`, write the SQL files, then `check`,
commit and `migrate`.

Commands: `grizzle generate <config> [--name <name>] [--schema <schema>]`, `grizzle generate <config> --custom --name
<name> [--schema <schema>]`, `grizzle check <config>`, `grizzle migrate <config>`, `grizzle drift <config>`,
`grizzle names <config>`. Flags come anywhere after the command, as `--flag value` or `--flag=value`. A name is
lowercase words joined by `_` or `-`, at most 240 characters, so that the folder `<timestamp>_<name>` fits one file
name (NAME_MAX, 255 bytes). Without `--name`, a drafted folder is named after its change (`init`,
`add_task_note`, `<first change>_and_more`); a custom one needs `--name`. `--schema` is accepted only when the config
lists several schemas; there it is required with `--custom`. Exit codes: 0 ok, 1 refused, 2 usage error,
130 interrupted.

## Reading a draft

`migrations/<schema>/<UTC timestamp>_<name>/` holds `NN-<phase>.sql` files and `meta.json`. Each file is one
transaction, so a migration is several small files, in order. A migration is plain ordered SQL: what the schema no
longer has is dropped in the same migration, and a rename or a type change happens in place. A breaking change may
briefly break older application instances that are still running.

- **setup**: the schema, types, enum labels and law functions. A new enum label gets a no-transaction file of its
  own, because a label can't be used until its transaction commits.
- **structure**: tables, columns, constraints (`NOT VALID` on a table that may hold rows), materialized views. Each
  term of a selected side, and each `pred` term, is a STORED generated column, `CASE WHEN φ THEN t END`
  (`__sel_<field>_…`, `__pred_<field>_…`), and a rule's key over them is `UNIQUE NULLS DISTINCT` and its foreign key
  `MATCH SIMPLE`; a selected target's constant is a generated column too, `__tag_<field>_<value>_…`. A field
  whose type changes is converted in place, `ALTER COLUMN ... TYPE ... USING` with a placeholder for the conversion,
  or by its cast, with no placeholder, when the new type holds the old one's values (a pattern changed, a contract
  added, removed or swapped for another over the same base), after the constraints, indexes and statistics over it are
  dropped; they are built again as on any table with rows, but a key over it, which is added again right after the
  conversion in the same transaction, so it holds throughout. A contract's changed predicate replaces its domain's one
  CHECK in place, `NOT VALID`, validated in Validate. A changed pattern is another pattern's domain, so each field it
  types is converted to it by its cast, which refuses a stored value the new pattern doesn't admit (23514). Every
  world object an existing role relies on (a view, a policy, a filter function, a key or unique probe) that changes, or
  that reads anything the migration changes or drops (a relation, a column, a type, a materialized view, a function),
  is dropped at the start of this transaction and created again, with its grants, at its end, so no committed state
  lacks it.
- **indexes**: `CREATE INDEX CONCURRENTLY` on tables that may hold rows, in a no-transaction file, so writes keep
  flowing. A table this migration creates gets an ordinary build. The extended statistics a workload program earns are
  created here too, on a table or a materialized view, each followed by an `ANALYZE` of a relation that may hold rows.
- **validate**: `VALIDATE CONSTRAINT`, key swaps, and one file per residual law. A key replaced by another over the same
  fields (a candidate key that becomes the primary key, or a key a rename you may choose moves onto a new key's fields)
  is dropped here once the new key is attached, whichever way you decide the renames, and the foreign keys over those
  fields are added after it, so each depends on the new key. A law's file takes a `LOCK` that excludes every writer,
  installs its triggers, and runs the law's full violation query, which raises if any row breaks it. The lock means no
  row can slip in between the check and the triggers; the per-law file means a violation rolls back alone, and a rerun
  resumes there once your data step fixed the rows.
- **publish**: the closed facts' payloads cast to their domains, so each is judged by the target's CHECK (one it
  refuses rolls the whole file back); the worlds: logins and roles, their memberships and settings, each role's
  schema of views (a security-barrier view for a query entry, a plain one for a whole entry), its grants, row-security
  policies and filter functions; the triggers and functions of a law whose meaning stays (the roles that see its
  witness changed, or `mutable` was declared or removed), changed without revalidating it; and last every object the
  schema no longer has, dropped: indexes, roles, statistics,
  views, functions, columns, tables, then types. A drop of a stored relation or field is drafted commented, a data loss
  you decide. A world object holds no data, so a changed world needs no marker; a role the migration creates gets its
  views, policies and functions here, after the role.

`-- grizzle: no-transaction` as a file's first line runs each statement alone, so each statement must be safe to
rerun: a rerun after a failure starts the file again from its first statement.

## Renames

grizzle never guesses a rename: a rename guessed wrong loses data. It drafts the drop and the add, and offers the
rename as a candidate when a removed relation has the heading (field names and types) of an added one, its primary
key, or its field names, or a removed field the type of an added field of the same relation. Keeping the add leaves the
new name empty, or holding the placeholder's value; the drop of the old one is a data loss you decide, drafted
commented at the end of the migration. Choosing the rename keeps the rows, and the drop stays commented.

- **Choosing a field rename:** replace the addition below the marker (with its placeholder and the ADD COLUMN) by the
  commented `ALTER TABLE ... RENAME COLUMN`, and an identity's `ALTER SEQUENCE ... RENAME`. A marked revoke of the old
  sequence becomes the commented revoke of the new one. Constraints and indexes over the field are drafted under their
  new names either way.
- **Choosing a relation rename:** replace the `CREATE TABLE` by the commented `ALTER TABLE ... RENAME TO` and the
  constraint, index, sequence and column statements under it. Then handle every statement marked as part of the same
  candidate, in this folder's files: delete it ("delete both") or replace it by its commented form ("replace it with
  this one"). They are what the new relation would otherwise create again, the old one's drop and what it would drop,
  and the revokes and trigger drops that name it.
- **Several candidates for one name** say so: choose at most one rename for each added and each removed name. meta.json
  records what each candidate renames, so `check` refuses two chosen candidates that rename one name. A field's rename
  nested in a relation's rename belongs to that rename: rival renames onto one name may each offer the same
  `RENAME COLUMN`, and the one you choose decides it.
- **Write each choice as drafted.** `check` reads every marked statement back against meta.json as PostgreSQL's
  scanner reads it, so whitespace, comments and the case of unquoted words are yours, but a rename written otherwise
  than drafted (another name, a quoted name left bare, an added `IF EXISTS`) is a candidate decided two ways, and
  refused.
- **Decide each candidate the same way everywhere.** meta.json records every drafted statement of every file in its
  place, each choice with its offers, each rename's alternative and every group a marker confirms, so `check` refuses
  a candidate chosen at one statement and kept at another, a marked statement deleted or edited when no choice says
  so, a confirmed group kept in part, and a statement of a branch you did not take written in, wherever you write it,
  before any file runs. A drafted statement no candidate decides, at the top of a file, is yours to keep or edit.
  Several chosen candidates may mark one statement (two renamed relations that both drop a foreign key between them):
  that is fine when they decide it the same way, and `check` refuses only a statement they decide in different ways.
- **A relation renamed while fields are added or removed** is a candidate whose alternative renames the table and its
  constraints, adds the new fields, each with a placeholder, and drops the removed ones last, each a data loss. Each
  added field that may be a removed one renamed is a candidate of its own, nested in that alternative and decided only
  with its relation's rename; see [A field renamed with its relation](#a-field-renamed-with-its-relation).
- **A field renamed while its type changes** is offered as a candidate too, against each removed field of another
  type when no removed field has the new one's type: its alternative renames the column and converts it in place,
  `ALTER COLUMN ... TYPE ... USING` with a placeholder for the conversion (such as `"<new>"::<type>`), or by its cast
  when the new type holds the old one's values. Kept, the new column takes its placeholder's value; carry the old one
  with `UPDATE <table> SET <new> = <old>::<type>` before the `DROP DEFAULT`, since the old column is dropped only at
  the end of the migration, and only if you uncomment its drop.
- **A relation renamed while a field's type changes** is a candidate whose alternative converts each such field in
  place after the rename, `ALTER COLUMN ... TYPE ... USING` with a placeholder for the conversion or by its cast, as a
  field's rename does. A serial field changes as it does in a relation you keep: the alternative drops its identity,
  converts the column, and adds the identity the target declares under its new sequence name, advanced past the
  stored maximum, so the next generated value follows the carried ones. A field declared serial, or serial no longer,
  gains or loses its identity in place the same way.
- **A relation renamed while its primary key changes** is a candidate when the two keep their field names: the
  alternative drops the old key and adds the new one. When another relation's foreign key references a key it drops,
  the alternative drops that foreign key first, and the drafted statements add it again `NOT VALID` and validate it;
  its marker says so, and the drafted drop of that foreign key is marked to delete.
- **A rename plus more changes** gets no candidate: a relation whose primary key changes while fields are added or
  removed. Its drop is a data loss with no candidate to carry it, and its marker says so: rename it alone first,
  choose the candidate, then change the rest in a later migration.
- **Swaps and chains where a name persists** (`A` and `B` exchange names, or `A` renamed to `B` while `B` is renamed
  to `C`): a relation whose name the target keeps with another heading, while another relation of the target, added
  or itself changed, has exactly the heading it held, may have moved. generate sets it aside first, as for a name
  taken by another kind (below), and offers it as a candidate rename of each added relation of its heading, its own
  name among them. Choose the candidates of the renames you made: the rows move with each relation, and each drop of
  a relation set aside stays commented. Two relations of one heading swapped are no change at all: nothing in the
  schema tells them apart, and the rows stay where they are.
- **A closed relation or a contract renamed** (the same handles in order, or the same base and predicate) is offered as
  a candidate: `ALTER TYPE ... RENAME TO` or `ALTER DOMAIN ... RENAME TO` (with its constraint dropped and added under
  the new name), so every column it types keeps its rows in place. Choosing it deletes each field's marked conversion.
  Kept, the drop and add converts each field in place: a closed id with a placeholder,
  `"<field>"::"pg_catalog"."text"::"<schema>"."<new enum>"`, and a contract by its cast, which keeps every value.
- **A name moving to an object of another kind** (a closed relation or a contract taking a removed relation's name, a
  relation taking a removed type's, a derived relation taking a stored one's, or two of them swapping names) sets the
  old holder aside first, in Setup, under its aside name, with every index, identity sequence and statistics object a
  relation owns, under one marker to confirm. A candidate rename then renames it from there; otherwise the end of the
  migration drops it there, a data loss you decide when it is a stored relation.
- **Two stored relations swapped or chained** (A renamed to B while B is renamed to A, or to C) sets each kept relation
  whose name another relation's heading moves to aside first, in Setup, under its aside name, with every index,
  identity sequence and statistics object it owns, under one marker to confirm. A candidate rename then renames it from
  there; otherwise the end of the migration drops it there, a data loss you decide.
- **A closed handle renamed in place** (as many handles before and after) is drafted as `ALTER TYPE ... RENAME VALUE`,
  so every row holding the old handle holds the new one. Its marker asks you to confirm: keep the rename and delete the
  marker. If the handle is removed rather than renamed, first change or delete the rows that hold it, before the rename.
- **Closed handles reordered** are refused before anything is drafted, by `generate` at the stage codes and by
  `check`: a stored code never changes meaning, so append new handles; a roster's order is its codes' order. A removed
  handle leaves its code unused; the migration validates the roster's domain again, which refuses every row still
  holding the removed code, naming its table and column: change or delete those rows in a data step first.
- **The schema's name names its PostgreSQL schema.** A schema renamed in code is a new, empty schema. When the
  migrations directory holds a schema the config no longer lists, the new schema's first migration drafts its `CREATE
  SCHEMA` commented, as a data loss: the old schema keeps its rows and is never migrated again. Uncomment it to start
  the new schema empty; to keep the rows, keep the old name and delete the folder.
- A derived relation holds no authored rows: renamed, it is created again and refreshed like a new one.
- **A login renamed:** each added login is offered every removed login as a candidate, `ALTER ROLE ... RENAME TO`,
  which keeps its password. Kept, the drop and add creates a new login, which needs its password again. A role is never
  renamed: it holds no data and no password, so its role, schema, views, policies and grants are dropped and created
  again under the new name. A name never moves between a login and a role in one migration, as when the two exchange
  names: its PostgreSQL role would turn from a login into a role, or back, which no statement does, so the draft stops.
  Give the name up in one migration and take it in the next.

### A field renamed with its relation

When a relation is renamed and some of its fields are renamed too, `grizzle generate` offers the relation rename as a
candidate, as usual. Inside that candidate's commented alternative, each added field that may be a removed one renamed
is a candidate of its own. The alternative renames the table and its constraints, then drafts each added field as a
new column and drops each removed one, a data loss of its own, and each field candidate offers to replace that pair
with a column rename (a hashed name's digest shown as `…`):

```sql
-- grizzle: rename candidate: "shop"."remark" has the primary key of the removed "shop"."note", which this migration drops, and its fields differ ("text" added and "body" removed): the rename adds and drops them, and offers each added field that may be a dropped one renamed as a candidate of its own inside this one; choosing the rename also decides the statements marked as part of it in this folder's files.
-- Keep the drafted statements and delete this line, or replace the addition below with this rename and delete this line:
-- ALTER TABLE "shop"."note" RENAME TO "remark";
-- ALTER TABLE "shop"."remark" RENAME CONSTRAINT "__note_pk_…" TO "__remark_pk_…";
-- -- grizzle: rename candidate: "shop"."remark"."text" has the type of the removed column "shop"."note"."body", which the rename of "shop"."note" drops.
-- -- Keep the drafted statements and delete this line, or replace the addition below with this rename and delete this line:
-- -- ALTER TABLE "shop"."remark" RENAME COLUMN "body" TO "text";
--
-- -- grizzle: placeholder: every existing row of "shop"."remark" needs a value for the new column "text" ("pg_catalog"."text"); ...
-- ALTER TABLE "shop"."remark" ADD COLUMN "text" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" DEFAULT __GRIZZLE_PLACEHOLDER__ NOT NULL;
-- ALTER TABLE "shop"."remark" ALTER COLUMN "text" DROP DEFAULT;
-- -- grizzle: data loss: the statement below drops the field "shop"."note"."body" with its values; the candidate rename of "shop"."note"."body" to "shop"."remark"."text" carries them instead.
-- -- To drop it with its values, uncomment the statement below; to keep them, choose a candidate rename that carries them and leave the statement commented. grizzle never decides a loss for you.
-- -- ALTER TABLE "shop"."remark" DROP COLUMN "body";

CREATE TABLE "shop"."remark" (
  ...
);
```

Review it in two steps:

1. Decide the relation. To keep the new relation, delete the outer marker and its instruction line. To choose the
   rename, delete the outer marker and its instruction line, remove the `CREATE TABLE` the rename replaces, and
   uncomment the alternative by removing one `-- ` from each of its lines. The nested markers are then live markers
   (`-- grizzle: rename candidate`) and data losses, and `grizzle check` refuses the folder until each is decided.
2. Decide each field the same way as a field rename outside a relation rename. To keep the new column, delete the
   field's marker and its instruction line, fill in the placeholder and delete its marker line, and decide the drop:
   uncomment it to lose the removed field's values. To choose the rename, replace the addition (the placeholder line,
   the `ADD COLUMN` and its `DROP DEFAULT`) with the uncommented `RENAME COLUMN`, and leave the drop of the removed
   column commented. If the field's type changed too, the candidate renames the column and converts it in place, with
   a placeholder for the conversion unless its cast converts it.

grizzle never chooses a field rename for you. A kept field candidate leaves the removed field's drop to you, a data loss
inside the alternative, and the new column holds the placeholder's value, or what an `UPDATE <table> SET <new> =
<old>` you add before its `DROP DEFAULT` computes. A
nested candidate counts only inside its relation's rename: if you choose a field rename while keeping its relation's
drop and add, `grizzle check` refuses the folder at that file, naming the rename that is not chosen and the statement
written inside it.

## Legal edits

- Any SQL that ends at the snapshot.
- Resolving markers.
- Backfills and data fixes, batched if large.
- Adding `NN-<words>.sql` files to an unapplied folder, each NN its own.
- `SAVEPOINT` and `ROLLBACK TO`.

## Never edit

- `snapshot.json`: it is the diff base, and its fingerprint is what `Db.open` and the drift check compare with.
  `check` says: snapshot.json does not decode as a snapshot, or is the snapshot of another schema; restore it from
  git. It lists each installed statement compact on a line of its own, so a review of its diff reads each changed
  statement as one changed line.
- `meta.json`: it records the folder's place in the chain, and in `decisions` the candidates, confirmed groups and data
  losses its files mark, which `check` reads every reviewed file against. `check` says: meta.json does not decode as a
  migration's meta.json, or names another schema; restore it from git, or broken chain: this migration does not start
  where the previous one ends; regenerate; never hand-edit meta.json.
- An applied migration: the database ran exactly that text, and the ledger holds its digest. `migrate` says
  `<folder>/<file>` was edited after it was applied; restore it from git. Put new steps in a new migration.
- Transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `END`, `ABORT`, `PREPARE TRANSACTION`): grizzle runs each file
  as one transaction and records it inside that transaction. `check` says: a migration file runs as one transaction,
  or each statement alone with -- grizzle: no-transaction, and never controls the transaction itself.
- The writer-excluding `LOCK` or the violation check in a Validate file: without them a direct writer can store a row
  that breaks the law while it is being installed, and the law is then never proven.
- `CONCURRENTLY` turned into a plain build: a plain build blocks every write to the table while it runs.

## Custom migrations

Use one for data work the schema doesn't describe: purges, cutovers, enum rebuilds, a backfill before a contract base
changes. `grizzle generate <config> --custom --name <name>` writes a folder with only `meta.json`, whose source and
target are
the current snapshot. Add `01-<words>.sql`, `02-<words>.sql` and so on; each is a transaction unless its first line is
`-- grizzle: no-transaction`. The catalog must still end at the snapshot. `grizzle migrate` runs every migration file
at SERIALIZABLE, so a reviewer's data step or a custom migration writes like any direct writer.

## Refusals

`check` and `migrate` print each finding as `<where>: <problem>; <fix>`, an unresolved data loss as `<where>: <what
it loses>: <problem>; <fix>`. `migrate` refuses a connection or a process environment it cannot use first, then runs
every check, and refuses before connecting.

| Finding | Fix |
| --- | --- |
| the schemas or their logins differ from snapshot.json (an ungenerated change) | run grizzle generate |
| a workload program's access differs from snapshot.json (an ungenerated change) | run grizzle generate |
| the schema or a login's workload does not compile | fix the schema or workload it names, then run grizzle generate |
| the schema no longer holds a name snapshot.json holds, and no --drop or --rename declares what became of it | run grizzle generate <config> --drop <name>, or --rename <old>=<new> where it was renamed |
| a roster declares a handle before one that holds a lower code in snapshot.json | append new handles; a roster's order is its codes' order |
| unresolved placeholder | write the value or the UPDATE, then delete the marker line |
| unresolved data loss: a schema's first migration starts it empty beside a schema the configuration no longer lists, and the statement that loses that schema's rows is still commented | to start the new schema empty, uncomment the statement below its -- grizzle: data loss line; to keep the rows, keep the old schema's name and delete the folder |
| snapshot.json does not decode as a snapshot, or is the snapshot of another schema | restore it from git |
| meta.json does not decode as a migration's meta.json, or names another schema | restore it from git |
| broken chain: this migration does not start where the previous one ends | regenerate; never hand-edit meta.json |
| broken chain: the newest migration does not reach snapshot.json | regenerate; never hand-edit meta.json |
| a migration folder is named <YYYYMMDDHHMMSS>_<name> | fix the file: rename the folder, or move it out of the migrations directory |
| a migration file is named NN-<words>.sql, one per NN | fix the file: rename it to NN-<words>.sql with an NN of its own |
| a migration file runs as one transaction, or each statement alone with -- grizzle: no-transaction, and never controls the transaction itself | fix the file: delete the transaction control; SAVEPOINT and ROLLBACK TO are allowed |
| -- grizzle: no-transaction counts only as a file's first line | fix the file: move the marker to the first line, or delete it |
| the migrations directory holds what grizzle generate never writes | fix the file: remove it, or move it out of the migrations directory |

Applied files, which only `migrate` can check against the ledger:

- `<folder>/<file>` was edited after it was applied; restore it from git
- `<folder>/<file>` was applied but is missing; restore it from git
- `<folder>/<file>` was added after its folder was applied; move it into a new migration (grizzle generate <config> --custom --name <name>)

`migrate` names the stage it stopped at, and its fix:

| Stage | Fix |
| --- | --- |
| connect | check the configuration's connection: its host, port, database, role, password and CA |
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

Before `statement`, nothing ran. At `statement`, `record` or `commit`, the files before the failed one stay applied
and a rerun resumes at it. At `drift`, every folder applied but the catalog differs from the snapshot. At `unchecked`,
the drift check reached no verdict: the snapshot did not render, the ledger or the catalog could not be read, or the
snapshot could not be built beside the schema to compare; the check changed nothing, since it rolls back. A refusal
the server raised carries its SQLSTATE, the constraint it names, and PostgreSQL's message, DETAIL and HINT as given.

A direct SQL writer, psql included, meets these refusals of its own, among the others README's Direct SQL access lists:

| Refusal | Fix |
| --- | --- |
| 25000: a write to a grizzle table requires SERIALIZABLE | write at SERIALIZABLE: BEGIN ISOLATION LEVEL SERIALIZABLE; |
| 42501: permission denied, or a new row violating a row-security policy | SET ROLE to a role whose world holds the relation and the row |
| 40001 or 40P01: a serialization failure or a deadlock | run the transaction again |

The command line's own refusals, by stage:

| Stage | Fix |
| --- | --- |
| usage | run grizzle --help for the commands |
| config | fix the configuration file: export default defineConfig({ schemas: [...], logins: [...], migrations: "...", connection: { ... } }) |
| environment | unset the variable it names in the environment grizzle runs in, then run the command again |
| filesystem | fix the migrations directory, then run grizzle check |
| snapshot | restore snapshot.json and the migration folders from git |
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
  so psql sessions get it without asking, and a write below it on any grizzle table is refused with 25000.
- Set `max_pred_locks_per_transaction = 2048` on the server (a server-start setting): under load PostgreSQL may
  report 53200, out of shared memory, with a HINT to raise it, and that failure is not retryable. Keep transactions
  short everywhere on the cluster: a committed write's locks are held until every older transaction ends, in any
  database and at any isolation level (a DROP DATABASE waiting on its checkpoint included), and a long one also
  brings more 40001s.
- Connect straight to PostgreSQL: PgBouncer is not supported.
- Every server setting grizzle does not pin is the database owner's, set on the database or the server: a login's
  role holds exactly its pinned defaults, and `Db.open` refuses one that holds any other. A login's role pins only
  what a grizzle guarantee rests on: `search_path`, `extra_float_digits = 1`, `lc_monetary`, `lc_numeric` and
  `lc_time` at `C.UTF-8`, and for a login whose roles search vectors `hnsw.iterative_scan = strict_order`. So
  `hnsw.ef_search`, `hnsw.max_scan_tuples` and `hnsw.scan_mem_multiplier` decide which rows an `approximateNearest`
  read returns and how many; JIT is the owner's too, and on a server built with LLVM `jit_above_cost` can make a large
  statement compile its plan first; and the server's messages come in its `lc_messages` language.
- Pass the committed snapshot to the login's `DbLayer.make`, and open each `Db` through its login:

  ```ts
  import snapshot from "./migrations/blog/snapshot.json" with { type: "json" }
  export const WebLayer = DbLayer.make({ ...connection, login: Web, snapshot, password, pool, verify })
  const db = yield* Db.open(Web.roles.member, { token })
  const feed = yield* db.workload.memberFeed.execute({})
  ```

  `connection` is the config's connection without its `role` and its password, which are the migration role's
  (`DbLayer.make` refuses a `role` as an unknown setting): `driver: pgDriver` (`import pgDriver from "pg"`), the
  `transport` (`{ kind: "sslRequest", host, port, open: () => new net.Socket(), ca, servername }`, always
  verify-full), the `database` and `connectTimeoutMs`. `password` is the login's own, and `pool` is
  `{ max, min, idleTimeoutMs }`. grizzle states no number of its own: a `Db` call waits for a session until it gets
  one or is interrupted, and an interrupted statement sends one CancelRequest and destroys its session.

  `DbLayer.make` compiles every program of the login's workloads once and compares their access paths with the
  snapshot's: a program added, renamed or dropped, or whose access paths moved, since the snapshot was generated
  fails the layer at the stage `schema`, naming the program; run `grizzle generate`. A program edit that moves no
  access path just takes effect. `Db.open` admits the database only when no migration is running or stopped part-way and its latest complete
  migration reached that snapshot, and refuses a snapshot of another schema at the stage ledger. While a migration is
  being applied, no snapshot opens; once it completes, only the new one does. It also requires the login's and the role's settings and
  privileges to be exactly the snapshot's, the login LOGIN NOINHERIT and the role NOLOGIN with no SUPERUSER, CREATEDB,
  CREATEROLE, REPLICATION or BYPASSRLS, a role's members to be its login and the migration identity PostgreSQL makes
  a member of each role it creates (any other membership of the login confers nothing), and row security enabled and
  not forced on every table the role writes through a query entry that leaves rows out (stages `settings` and
  `privileges`); a membership fault refuses every role of the login. A table no role writes that way has no row
  security and no policy: each policy would be true, and the grants alone decide its writes. `token` is required
  exactly when the role's relations read a context; the layer's `verify` refuses one at the stage `token`. It compares
  no view definition or policy predicate: `grizzle migrate` does, after every apply and when nothing is pending, and
  refuses drift. `grizzle drift` runs that same check alone and applies nothing (a folder not yet applied is a mismatch
  of its own), so it can watch a production database from CI or a schedule; it connects as the migration identity,
  since the check replays the snapshot into a scratch schema in a transaction it rolls back.
- Open a `Db` per request or handler: admission is one round trip of a few catalog reads, so this stays cheap.
- `db.page` takes any safe integer of at least 1 as its size: there is no default and no cap.
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
  Retry only `TransientFailure`, and `Db.open`'s `OpenError` whose reason is `AdmissionTransient`, with `Effect.retry`
  and your own `Schedule`; after `CommitUnknown`, read back before running the call again.
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
  `PartialOperation`, whose `guard` is the code to write. Narrow an exact integer into an integer field with
  `Compute.cast` under `Compute.within`.
- Every numeric field declares its precision and scale, `pg.numeric(p, s)`; there is no bare `pg.numeric`. A sum,
  a mean or an operation's numeric result carries the digits its computation proves, and one past 131,072 integer
  digits is `ResourceBound`. Convert an integer, money or a float to numeric with `Compute.numeric(x)`, never a cast to
  a typmod you do not mean.
- Each login is a PostgreSQL role, `<schema>__<login>`, and each world a role that cannot log in, `<schema>__<role>`.
  The migration that adds a login creates it; the operator gives it a password, or, for an RDS IAM login, `GRANT
  rds_iam TO <login> WITH INHERIT TRUE, SET FALSE`. grizzle never sets either. A login holds only USAGE on the
  schema, SELECT on the ledger and EXECUTE on the snapshot guard, the lock and the check Db.open and every transaction
  take; everything else it does as one of its roles, one per transaction. Db.open and drift admit a membership beyond
  the login's roles only with SET FALSE and no ADMIN, and only while the login's effective privileges on the
  installation stay exactly those three: `rds_iam` holds nothing there, so it is admitted, and a membership handing
  the login any privilege or ownership is refused. This has not been run against RDS.
- A direct SQL writer logs in as a login, runs `SET ROLE <role>` for one of its roles, and, for a role whose
  relations read a context, sets the claims in the transaction:
  `SELECT set_config('grizzle.claims', '{"Session":{"sub":"user_123"}}', true)`. A login holder can set any claims:
  the login is the boundary, so give each trust domain its own. A world role holds no privilege on a sequence: an
  identity default needs none, and a writer inserting explicit serial values (`OVERRIDING SYSTEM VALUE`) calls the
  field's advance function, `SELECT <schema>.<advance function>(<largest value inserted>)`, in the same transaction.
- Every installed object is named from what it is. Declared names are snake_case: the schema, tables, derived
  relations, rosters, contracts, columns, row checks and a role's views keep their converted names, a contract's CHECK
  is `check`, and a role's schema is its role's name. Two declared names that convert alike are one name (two fields
  of a relation, two head fields of a derived relation or a role's query, two relations of a role, two logins or roles
  of a schema, a contract a context names beside a relation, roster or contract of the schema), a name may not start
  with `_`, a conversion (a login's or role's with its schema's) must fit 63 bytes, and a schema's must not start with
  `pg_`. Everything else is `__<readable part>_<digest>` and carries a COMMENT saying what it is: `grizzle names`
  prints that mapping from the committed snapshot. Write direct SQL against those names. An outcome's `law` is the law
  as the schema states it, such as `{ kind: "key", relation: "User", fields: ["email"] }`: match on it directly.
- This file ships in the package as `skills/grizzle/SKILL.md`: copy it to where your agent reads skills, and again
  after upgrading grizzle.
