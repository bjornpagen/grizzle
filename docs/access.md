# Access reference

The reference grizzle's source and tests cite by heading (test/unit/dev/references.test.ts). A claim here that the code contradicts is a bug of this page, fixed here.

## Permissions

Three declarations, all in the example:

- **`context(name, fields, { claim? })`**: a claim of the session token, read by queries as a table of at most one
  row. Its fields, read from the payload's top level or from the nested object `claim` names, are text, uuid,
  bool, the integer types, domains over them, and closed ids, whose claim is a handle's name. An absent claim
  object is no row, and a payload that is not an object has none; a context read from the top level refuses such a
  payload at stage `token`. No rule reads a context, and no ChangeSet writes one.
- **`role(schema, name, entries, { insert?, write?, contexts?, scope? })`**: what one kind of user sees. An
  entry is a table of the schema, whole, or a query over it.
  Each entry the role writes is listed under the mode it writes that table by, each table once across the two lists (a
  name listed twice is a type error): `insert` the entries it only adds to, where it holds INSERT and SELECT and no
  UPDATE or DELETE, and `write` the open ones it changes, each over a table declared `mutable` inside a unit, where it
  holds UPDATE and DELETE as well. A closed table under `write` is a type error for a whole entry and
  `RoleRefused` (`writeClosed`) for any. So one role puts an open table and inserts into closed ones in one commit,
  holding UPDATE and DELETE on the open table alone. A ChangeSet of it that deletes from or puts an entry of its
  `insert` list, or adds an open member of its `insert` list to a mutable owner's family, which updates the owner's
  count, is `OutsideRole` (`insert`) when it compiles, naming the table and the operation. `contexts` lists the contexts it
  declares ([Contexts of a role](#contexts-of-a-role)), and `scope` the units its claims bind
  ([The scope of a role](#the-scope-of-a-role)). A role is no schema: `role`, `login`, `schema.extend`,
  `wholeEntriesOf`, `wholeWritesOf`, `writableNamesOf`, `lawsOf` and `lawsByStatement` take a schema, and a role
  passed to one is a type error.
- **`login(schema, name, roles, { workload? })`**: one PostgreSQL user and one pool for some roles of one schema,
  owning their workloads, each over the schema, a schema it extends, or one of the login's roles. Every role is in
  exactly one login, under a name other than the login's, and is reached through it by name, `Web.roles.member`. Two
  programs of one name across a login's workloads are a type error. A login that breaks one of these is
  `LoginRefused`.

Roles:

- **A query entry is a security-barrier view**: its filter runs before anything that could fail on a row outside it.
  It has one flat set of columns. Aggregates, negation, range comparisons, `take`, recursion, contexts and every
  scalar operation are allowed, since no expression fails on a value ([Queries](reads-and-writes.md#queries)), on the rows outside the
  role a view evaluates it on included. Its keys are the ones its query provably has.
- **A role declares no rules**: the schema's rules hold, whoever writes.
- **A role that writes a family's member** reads what grizzle reads of the owner to fill the family and, when the owner
  is mutable and the role writes the member in full (a closed member by `insert`, the one way it is written, an open
  one by `write`), changes that family's drawn count and accumulated ends on it, and nothing else of the owner unless
  `write` lists the owner too: `role(Credits, "metering", wholeEntriesOf(Credits), { insert: ["Debit"] })` spends
  grants and edits no grant's amount. An open member under `insert` is only added to: its role holds nothing of the
  owner beyond its reads, so it adds members only beside their owner's insertion.
- **A roster among a role's entries has no view:** every query reads its handles as codes.
- **A full role** is `role(S, name, wholeEntriesOf(S), wholeWritesOf(S))`. `wholeEntriesOf(S)` is every
  table of every level of `S`, whole, under its own name, except the closed relations, which every role reads and none
  holds as an entry. `writableNamesOf(S)` names, in the schema's order, every table a role writes whole: all but the
  rosters, the closed relations and the derived tables. `wholeWritesOf(S)` lists them as `S` declares each: `insert`
  every closed table, `write` every `mutable` one. Their types are exactly these, so `wholeEntriesOf` never
  holds a closed relation and `wholeWritesOf` never lists a table its list refuses. A role that holds every table
  whole, such as `role(Blog, "staff", wholeEntriesOf(Blog))`, also runs every query and ChangeSet over the schema
  itself, such as `postPage`. So does a role over a higher level for each level below it whose every table, and every
  table below it, it holds whole: a role over `Ledger` holding `wholeEntriesOf(Qti)` runs every query over `Qti`
  ([Levels](schema.md#levels)). A role with a scope runs them over its world, each member of a unit its claims bind at the keys
  they name alone ([The scope of a role](#the-scope-of-a-role)).
- **`Refused`**, when you build the role, is a whole entry under another name than its table's, or not the schema's
  own, a whole entry of a live derived table, or a query entry over a role or over any schema but the role's and those
  it extends: the rules the type errors name, in their words.
- **`RoleRefused`**, when you build the role, names the rule it breaks: a query entry reading a table the schema
  lacks, or with parameters, nested results, vector search or an `orderBy` without `take`; an `insert` or a `write`
  naming no entry of the role, a roster, a derived table or an unwritable query entry, or two entries over one table
  across both lists (`writeTwice`); or a `write` naming an entry over a closed table (`writeClosed`).

**Installed names come from the values.** `roleNameOf(Web, connection)` is a login's PostgreSQL role in the
installation `connection` names: the one its pool logs in as, a password is set on and `rds_iam` is granted to.
`roleNameOf(MemberBlog, connection)` is a role's, which a direct SQL writer's `SET ROLE` names. Each is the login's or
role's stem, the name `grizzle generate` commits, under the connection's `rolePrefix`; pass the connection, or `{}` for
an installation without one. `schemaNameOf(Blog)` is a schema's PostgreSQL schema, `wholeSchemaNameOf(Blog)` the schema
of the whole views of its tables, `__blog`, and `schemaNameOf(MemberBlog)` a role's schema of its query entries' views,
which the installation creates only for a role holding one; each is the same in every installation. Each is the name the installation creates, minted by the same
function, so take it from there and never spell one. Each throws `CompileError` for a value no builder made and for a
name the installation refuses, as `grizzle generate` does.

`served<typeof Web>(file, "web")` is a login's committed workload, `migrations/<root>/served/<login>.json`, served as
the login's type; `roleNameOf(WebServed, connection)` is its PostgreSQL role, its file's stem under the connection's
prefix. `WebServed.decoder` is the installation's decoder login as the file names it, typed by the login: a
`DecoderLogin` where its type proves it serves a read, `{ kind: "none" }` where it proves it serves none, either where it
cannot tell; `roleNameOf(WebServed.decoder, connection)` is the role `LiveSource.layer` logs in as. `WebServed.roles.member.isolation` is the level `grizzle generate` certified the role's writes at,
`readCommitted` or `serializable` ([READ COMMITTED writes](errors-and-concurrency.md#read-committed-writes)): read it there, never from the
file's JSON, whose encoding is grizzle's own. There is one `roleNameOf`, in `@bjornpagen/grizzle/runtime`: it reads
the stem a login, a role, a served login or a decoder login carries and loads no schema module. `DbLayer.make({ login: WebServed, ... })` builds the login's pool and loads its workloads, compiling nothing, and
refuses a file of another login than the name it was served as, at stage `config`. It requires `verify`
exactly when one of the login's roles declares a context of a token's claims. A layer with `verify` runs it on every
token it is handed, for a role that declares no such context too.

`Db.open(WebServed.roles.member, { token })` is the only way to open a `Db`, and only where the layer of the role's
login is provided: a role of the login itself (`Web.roles.member`) is a type error, since the app holds the login as a
type alone. It requires `token` exactly when the role declares a context of a token's claims, and `attested` exactly
when it declares one its server attests ([Contexts of a role](#contexts-of-a-role)). It runs `verify` once per `Db` and
decodes the role's token contexts from what it returns, and the `Db` keeps those claims. A `Db` opened without a token,
or on a layer without `verify`, has no rows of its token contexts. A role that declares no token context opens
whatever the payload.

**Queries for a role are written over the role.** `query(MemberBlog)` and `ChangeSet.empty(MemberBlog)` see only what
`member` does, write only the entries in its `write` list, and match only the contexts it declares. Anything else is a
type error, and another context, from a caller the types don't reach, is refused before any SQL.

### Contexts of a role

A role states the contexts its `Db`'s facts hold: `contexts: [Session, Org]` on `member`. They are the role's boundary,
read once where a `Db` opens, each from its context's one source: a `context(...)` from the token's claims, `Db.open`
decoding exactly those from what `verify` returns, each from its own claim (`Org` from the nested object `o`, so a token
without `o` has no `Org` row); an `attested(...)` from the facts the server itself attests where it opens the `Db`.
`Db.open` requires a token exactly when the role declares a context of a token's claims, and `attested` exactly when it
declares an attested one. Every query entry of the role, and every program on a `Db` of it, matches only the contexts it
declares, and nothing else makes a context available:

- **A program over the schema matches them on a full role.** `role(Blog, "staff", wholeEntriesOf(Blog), {
  ...wholeWritesOf(Blog), contexts: [Session] })` runs every query and ChangeSet over `Blog` itself, those matching
  `Session` among them, so one program serves every role that declares what it matches and needs no copy written over
  each role.
- **A query entry matching a context the role does not declare** is a type error naming the rule, and
  `RoleRefused` (`entryContext`) for a JavaScript caller, when you build the role.
- **A program matching one** is a type error in a workload over the role, and `OutsideRole` (`context`) when it
  compiles for the role, before any SQL: in `grizzle generate` for each role of a login whose workload holds it.
- **Two contexts of one name that differ**, among the declared ones or between one and what a program matches, are
  `DuplicateIdentity`; a context of a token's claims and an attested one of one name differ.
- **An attested context is the server's alone.** `attested("Origin", { address: inet })` is a fact the server states,
  `Db.open(WebServed.roles.student, { token, attested: { Origin: { address } } })` with `address` read by
  `Inet.parse` from its edge's header of the address a request reached it from, and an HTTP handler's
  `httpHandler({ logins, heartbeatMs, attest: (request) => ({ Origin: … }) })` for each request it serves, which the
  handler's config requires exactly when a served role declares one. No token's claim, request body or other client
  input reaches an attested context, so a client-stated address is no fact of one, and a token's claim of the same name
  is the token's alone. A context the server leaves out has no fact, as a token without a context's claim object has
  none; a member naming a context no served role attests, a fact of other fields, or a value its field refuses is
  `AttestationRefused`, at stage `schema`.

### The scope of a role

A role's `scope` lists the units its claims bind, each by its owner: a query over the schema whose head is the unit's
heading, by name and type, the keys the session's claims name. The role's world holds every member of each such unit at
those keys alone, and every read on the role means its evaluation over that world: a program over the schema, every
import, negation, aggregate and take in it, every derived table it reads, live or stored, and every query entry's view.
Below, `Sittings` is a level of a sitting's tables, every fact of a child's keyed leading with `child` under
`unit("Learner", { child: LearnerId })`, `ClerkAccount` among its tables, and `Session` the context of the token's claims
above.

```ts
/** The children the signed-in Clerk user signs in as: the Learner unit's keys the token names. */
const learners = g.query(Sittings).rule((r) => {
	const { sub } = g.v(Session, "session")
	const { child } = g.v(ClerkAccount, "account")
	return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, child }).find({ child })
})

export const Student = g.role(Sittings, "student", g.wholeEntriesOf(Sittings), {
	contexts: [Session],
	insert: studentInsertNames,
	scope: [learners]
})

/** A student's assignment by its number, with its status: no sign-in, no child, no guard. */
export const myAssignment = g.query(Sittings).rule((r) => {
	const { number, test } = g.v(Assignment, "assignment")
	const { status } = g.v(AssignmentStatus, "status")
	return r
		.match(Assignment, { number, test })
		.match(AssignmentStatus, { number, status })
		.where(r.eq(number, r.param("number", g.natural)))
		.find({ number, test, status })
})
```

- **The owner** reads the role's contexts, and tables at a prefix of one of their keys that literals, the contexts and
  the tables before it bind, each a table the role holds whole: `ClerkAccount` at its key `clerk`, the sign-in's one
  child; a coach's grants, `CoachOf` keyed `(coach, child)` at `coach`, every child granted. Its head is exactly one
  unit's heading, each field bound at the unit's type, and a role binds each unit by one owner, whose rules are every
  way it binds it. No negation, aggregate, import or interior. Any other owner is `ScopeRefused`, naming the rule
  (`owner`, `unit`, `unitType`, `twice`); an owner matching a context the role does not declare, or reading a table it
  does not hold whole, is `OutsideRole`.
- **The members are the unit's.** Every table whose primary key leads with the unit's heading, as the unit's own lock
  holds it ([Units](schema.md#units)), and every stored derived table the unit holds, unit-local by its admission, so its rows at
  a key are its definition's over the world's. A table keyed otherwise, such as `Grade(number)`, is no member: every
  role reads it whole. A table the schema adds later keyed by `child` joins the world as it joins the lock; none can be
  left out.
- **A read is the world's.** `myAssignment` reads `Assignment` and `AssignmentStatus`, a live derived table over the
  student's events, at the student's child: the child is bound nowhere in it, and its every read of a member is a probe
  at the child, inside each derivation too. A count of every `SittingEvent` counts the student's own; a take of the latest
  assignment takes theirs; a negation decides by their rows. A session whose claims name no child reads no member's row.
- **A write is held to the world.** A fact of a member a write states outside the units its claims bind is
  `outsideWorld`, judged before the statement that writes it, and the write stores nothing: an insert's, a put's and a
  delete's, a unit's delete and a family member's among them, whole or through a query entry. A unit's delete from a
  query reads the query once, for its judgment and its delete alike. A write whose every fact stems from the world's
  rows, an insert from a query whose child a member's row gives, states none outside it, and no statement checks it. Laws hold over every row: a key a row outside the world already holds is `refused` on that key, with the
  key you submitted as its witness.

What a scope is not: a PostgreSQL view or policy. The role holds every table whole, so a direct SQL session as the role
reads every row; a scope binds what the role's programs mean. The login is the boundary
([Security model](#security-model)): whoever holds its password can open any of its roles with any claims, so no
policy on the claims could hold them.

### Writing through a role

A query entry in `write` is writable when it has one rule, all its columns come straight from one table, every column
of that table it leaves out, a key column included, is fixed by the query to a constant or a claim, and every other
match only filters. A field the table's family draws (a count, an end, an index, a tree's start) is the exception: the
entry holds it among its columns, or leaves it out unfixed. `myPosts` qualifies: its columns come from `Post`, and the
token fixes `author` and `org`. A `write` naming any other query entry is `RoleRefused` (`writeUnwritable`), with the
reason.

- **An insert fills the fixed columns.** A row the query could never return (a filter it fails, an absent claim) is
  the error `outsideWorld`.
- **A delete of a row outside the entry does nothing**: for this role, that row does not exist.
- **An entry over a member of a unit the role's scope binds is held to the world too**, as a whole write is
  ([The scope of a role](#the-scope-of-a-role)): a fact it states outside the units the claims bind is `outsideWorld`,
  under the entry's name, a delete's among them.
- **An entry over a family's owner writes the owner as a write of the table does.** No row states its counts and ends,
  and a put updates the entry's own columns in place and leaves the family as it is. Its filter may read no field its
  family draws (a count, an end, an index, a tree's start), and no key of the table may hold one, else the role is
  `RoleRefused` (`writeUnwritable`) with `why` `filterReadsFamily` or `keyHoldsFamily`, naming the field. A tree's
  table is keyed by its root fields and its drawn start, so no query entry writes it. A delete through it is
  `UnsupportedOperation` when the ChangeSet compiles: a delete of an owner that is no family's member removes its rows
  whole with every row nested under them ([Families](schema.md#families)), which a role does only through a whole entry of the
  owner.
- **A collision with a row outside the entry**, by a put or an insert, on a key over the table or over a side of it,
  is `refused` on that rule. The witness is the key you submitted, in the entry's fields, never the other
  row. An error PostgreSQL still raises there is a typed failure, never an outcome.
- **A column the query binds directly to a claim**, like `author`, holds the claim's value in every row and is never
  updatable: the role holds no UPDATE on it, so a direct writer's `SET author = author` is refused with 42501. A
  column tied to a claim only through a join stays updatable.
- **One stratum may not write a query entry and a table its filter reads**: it is refused when the ChangeSet compiles.
  `ChangeSet.sequence` orders them.
- **A ChangeSet that writes a row outside the entry and breaks a rule** reports one of the two; which is not promised.

## CLIs for logins

`grizzle generate` writes one OpenAPI 3.2 document per login, `openapi/<login>.json` beside `served/` in each migration folder: every program of each of the login's roles as one operation, its input and its events as their schemas, and the wire form each carries (`x-grizzle-wire`). `packages/cli-generator` turns that document, or any OpenAPI 3.0, 3.1 or 3.2 document, into the source of a standalone command-line application on Effect and Node 26, one command per operation:

```sh
node packages/cli-generator/src/bin.ts generate migrations/<folder>/openapi/app.json --config acme-app.json --out acme-app
cd acme-app && pnpm install && pnpm build
```

A login's CLI is `acme-app <role> <program>`: its input's members are flags, or the whole input is `--body`; a call prints one JSON line per event, a read its `reset`, an `upsert` per row and `ready`, and `--follow` keeps it reading the live changes. The document names no server, so the base URL is `--base-url` or `<PREFIX>_BASE_URL`, and a role's bearer token is sent only to an origin the author config binds. The generated package depends on no grizzle package: it calls the login's server over HTTP as any client does. Its properties hold a generated CLI to what grizzle's own HTTP handler answers the same calls, over a login installed on the local cluster (`packages/cli-generator/test/grizzle`). [packages/cli-generator/README.md](packages/cli-generator/README.md) has the author config, the generated package and what the generator refuses.

## Direct SQL access

psql, scripts and other services may write grizzle's tables directly, under the same rules and roles as the app. Log in
as a login's role, `roleNameOf(login, connection)`, `SET ROLE` to one of its roles, `roleNameOf(role, connection)`, set the claims in the
transaction for a role that declares contexts
(`SELECT set_config('grizzle.claims', '{"Session":{"sub":"user_123"}}', true)`), and write at SERIALIZABLE. The
schema's tables are in `schemaNameOf(schema)`; a role reads a table it holds whole through the table's whole view, under
the table's name in `wholeSchemaNameOf(schema)` of the schema that declares it, which every role holding it whole reads,
and its query entries' views in `schemaNameOf(role)`.
A readable name spells what it is, and `constraintNamesOf(schema)` gives a check's from its rule
([Errors and outcomes](errors-and-concurrency.md#errors-and-outcomes)); `grizzle names` lists each hashed one with its COMMENT, which says what
it is, read offline from the committed snapshot. PostgreSQL answers:

| SQLSTATE            | When                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 42501               | a table outside the role; a row its filter refuses; an UPDATE of a closed table, or a DELETE of one through a role, or an UPDATE through a query entry of a column outside it, in a key or fixed by a claim |
| 42501               | an UPDATE or a DELETE through a role that states `insert`                                                                                                     |
| 42501               | `SET ROLE` to another login's role or the owner; `SET SESSION AUTHORIZATION` to anyone but the login; a call of another role's filter or probe function |
| 22023               | `SET ROLE` or `SET SESSION AUTHORIZATION` to a role that does not exist                                                                                      |
| 25000               | a write below SERIALIZABLE, on a table some writer of which is not certified READ COMMITTED                                                                    |
| 23502               | a NULL in a column, such as one an INSERT leaves out that is not generated (every column a writer supplies is NOT NULL, a family's hidden ones included); a generated field whose term has no value at the row, a closed read at a key its relation holds no row at; each reported by its table and column alone |
| 22P02, 22003, 23514 | a `grizzle.claims` setting PostgreSQL cannot read, where a statement reads it (below)                                                                         |
| 23514               | a row check, a family's CHECK or a rule over a closed relation, each named by its rule; a value its domain or pattern refuses, or a code or set its roster's domain refuses, as the statement casts it, before row-level security and the row's constraints |
| 23514               | a clock stated at an instant its transaction did not stamp at its scope's key: an INSERT at the statement's end (`__clocked`), an UPDATE that moves one at COMMIT (`__clock_moved`); stamp first, `SELECT * FROM <schema>.<stamp>(ARRAY[<key>], <microseconds>)`, which `grizzle names` lists, and state the `__instant` it returns ([Instants](reads-and-writes.md#instants)) |
| 23505               | at the statement: a duplicate key, over a table or over a side of one, an exact repeat included; or a key a concurrent transaction committed after this one's snapshot, which is retryable |
| 23P01               | at the statement: an overlap under a no-overlap key; or a range a concurrent transaction committed after this one's snapshot, which is retryable               |
| 23503               | a foreign key, a containment between sides included: at COMMIT when deferred (below), at the statement otherwise                                             |
| 23503, 23505, 23514 | at COMMIT, a rule over a query, a containment, a key or a check, named by the rule ([Rules over queries](schema.md#rules-over-queries))                               |
| 40001, 40P01        | a serialization failure or a deadlock: run the transaction again                                                                                             |
| 55Z03               | a write of a table a rule over a query reads, in a session that has not stood up the rule judge's tables: call the table's stand-up once in the session first, `SELECT <schema>.<stand-up>()`, which `grizzle names` lists (`__stand_<table>_…`), as a served write's session does |

### Deferred foreign keys

a family's key as its proof needs (a counted family's predecessor key, every last-slot
key, an owner key a cascade feeds); a family's key a refill writes around (the owner key of every family whose
members a refill can rewrite or whose owner a put or a delete can re-place, and the predecessor key of an ordered
family or tree and a tree's owner key a refill rewrites); any key on a cycle of the foreign keys that order a write's
statements, a family's owner key among them, as a containment from an owner into its members closes one; and any
other whose target has a field that is not one of the columns it references.

### The claims setting

The claims setting is readable exactly when it has the shape a `Db` writes: a JSON object with no key repeated
at any depth whose every member is an object of JSON strings, `{}` where it holds no fact. A setting that holds no
document, never set in the session or empty (as a transaction's own setting is once it ends), is 22P02 with
constraint `grizzle.claims` and DETAIL `c-`, never read as a document of no fact. Anything else, non-JSON text
included, is 22P02 with constraint `grizzle.claims` and DETAIL `c[]`. A context's member holding other keys than exactly its fields
is 22P02 with DETAIL `c["<Context>"]`; a member of a context the statement does not read is never judged. Each claim
is then cast to its field's type, a closed id's claim being its handle's code: one its type refuses (not a uuid, an
integer or a boolean) is 22P02, an integer out of range 22003, and a value its domain, pattern or roster refuses
23514. No DETAIL carries a claim's value. A plan that drops the row through a join or condition before reading the
claims gives that judgment's answer: 42501 for a write, no rows for a read, false from a function.

- **COMMIT** of a transaction a refusal aborted rolls it back, without an error.
- **A family's values** are the writer's to fill, as grizzle fills them: each member's hidden index, its copy of its
  owner's count and each fold's running values, and the owner's count and ends, under their installed names
  (`grizzle names` lists the hashed ones).
  PostgreSQL refuses every value that breaks the family, with 23505, 23514 or 23503.
- **A float's `-0` is a value, a vector component's a spelling.** A writer may store `-0` in a float field, and grizzle
  reads it back as `-0`, a value of its own: equal to `0` under `=`, `DISTINCT` and PostgreSQL's equality, so a key
  over the field holds `-0` and `0` as one key (23505), and apart from it as a fact's identity. A vector component's
  `-0` is a spelling of `0`: grizzle reads it as `0`, no query result depends on the spelling stored, and `[-0,1]` and
  `[0,1]` in a vector key field collide (23505).
- **A login without `SET ROLE`** holds only USAGE on its schema, SELECT on the ledger, and EXECUTE on the snapshot
  guard, the lock and the check that every `Db` transaction takes.
- **The owner and superusers bypass** every rule and role, and the owner is reserved for migrations.

## Security model

- **The login is the boundary.** Whoever holds a login's password can open any of its roles with any claims: a claim
  is what `verify` returned, and PostgreSQL cannot check a token's signature. The web login can be any user of the web
  app, but it never reaches `PostViews`, which only another login's role writes. Give each trust domain its own login.
- **A role's scope is its programs' meaning.** Every read a role's programs make of a member of a unit its claims bind
  reads the claimed keys' rows alone, and every write of one refuses a fact outside them, in the compiled statements
  themselves ([The scope of a role](#the-scope-of-a-role)). No view or policy holds it: the role holds the unit's tables
  whole, so a raw SQL session as the role reads every row, as a password holder could anyway by setting any claims.
- **Claims are verified once, then decoded.** `verify` decides the token. grizzle decodes the value it returns, never
  the token's JSON text (so a key the token repeats is `verify`'s to refuse), through the contexts' fields. A present
  claim object missing a field or holding a value its field's encoder refuses (a text holding NUL or a lone surrogate
  among them) is refused at stage `token`, on the host. A claim's pattern or domain is PostgreSQL's to judge, by the
  field's domain, where a statement reads the claim: a claim it refuses fails that call with the server's
  `ServerError`. The transaction's setting holds the decoded claims, one member per context that has a row,
  `{"<Context>":{"<field>":"<text>"}}`, each holding exactly its context's fields as JSON strings. It never holds the
  token, and it ends with the transaction.
- **PostgreSQL enforces every role.** A role holds no privilege on a table it does not write, and reads through views: a
  table it holds whole through the table's one whole view, in its schema's schema of whole views, which PostgreSQL lets
  exactly the roles holding the table whole read, by its own grants, and each query entry through a view of its own, in
  its own schema. A table some role writes through a query entry that leaves rows out is under row-level security, with
  a policy for each role that writes it: the entry's filter, or true for a role that writes every row. A table every
  writer writes whole has no row-level security and no policy, since each policy would be true: the grants alone decide
  its writes. A query entry's view is a security-barrier view; a whole-table entry hides
  nothing, so its view is plain and PostgreSQL plans through it onto the table's indexes. On a table under row-level security, constraint messages
  omit row and key detail.
- **The rule judge's session tables are its own.** A session holds the rows a transaction wrote of each table a rule
  over a query reads in temporary tables the judge's definer makes, by the table's stand-up, before the session's first
  write of it ([Rules over queries](schema.md#rules-over-queries)). PostgreSQL gives `PUBLIC` the `TEMPORARY` privilege on every
  database, so any role could make a temporary table under one of the judge's names first, and empty it before COMMIT,
  or make the table whose trigger runs the judge without the trigger, so the judge never ran. So the stand-up refuses a
  table of the judge's names some other role made, and makes last a marker, a table of no column named by the set of
  every table it made; every capture of a write reads, once per statement, that the sentinel and its table's marker
  stand and are the definer's own, and refuses the write otherwise (55Z03, naming the table and its stand-up). No role
  but the definer drops, alters or renames the definer's temporary tables, and `DISCARD TEMP` drops all of them at once,
  the marker with them, so the marker standing proves every table the write can reach stands as the definer's own. A
  table's write is so refused in a session that has not run the table's own stand-up, whatever other stand-ups made.
  Neither reads more than one row of `pg_catalog.pg_class` a table, and neither makes or plans anything after the
  session's first call.
- **What a role can learn.** Rules hold across the whole database. A delete refused by a comment you cannot see, or a
  limit that counts rows outside your view, tells you such rows exist; a collision at a key tells you a row exists at
  the key you submitted (one overlapping the range you submitted, for a no-overlap key), never any of its other columns.
- **Not offered.** A write-only role (an insert reads its rows back), a browser connecting straight to PostgreSQL (which
  cannot verify an RS256 token), and a role in two logins.
- **The owner bypasses every role.** The migration role owns the tables and bypasses row-level security. It is for
  migrations, never for the app.

<details>
<summary>Exactly what a role holds</summary>

- USAGE on the schema, the schema of whole views of each table it holds whole, its own schema where it holds a query
  entry, and the vector extension's schema when a column it reads or writes is a vector; on no domain. PostgreSQL checks
  a type's USAGE only where a statement creates an object of it, and a role creates none: a write's carriers travel in
  its transaction's settings, every column its value's base type, a set's bit(n) of its roster's width, and a value
  reaches its table through the column's domain, which judges it there.
- SELECT on the whole view of each table it holds whole and on each of its query entries' views, and on no other view
  and no stored derived table. USAGE on a schema only resolves its names: every view's own grants decide who reads it.
- On a table it writes through a whole-table entry: SELECT, INSERT and DELETE, and UPDATE when the table is mutable.
- On a table it writes through a query entry: column SELECT and INSERT on every column, column UPDATE (when the table is
  mutable) on each of the entry's columns outside every key that no claim fixes directly, and DELETE; never table-level
  SELECT, INSERT or UPDATE.
- On the owner of a family whose member it writes: column SELECT on what grizzle reads of the owner to fill the family
  (its key, its count and ends, and the fields its members copy), and, when the owner is mutable, column UPDATE on that
  family's count and ends; nothing else of the owner unless its `write` lists the owner.
- A role that states `insert` holds the same, less every UPDATE and DELETE: SELECT and INSERT on each table it
  writes, and column SELECT alone on a family's owner.
- EXECUTE on:
  - one key probe (a function that looks a key up across the whole table) per key of such a table, and one unique
    probe per key over a selected side or a `pred` term whose collisions no other probe finds, for each writable query
    entry;
  - the entry's filter function, exactly when its filter reads a table besides the written row;
  - the refusal function, whatever it writes, which only raises, in the caller's own statement: a write's refusals,
    a context's unreadable claims and a read-back's check of the bare children and options it delivers call it, and
    any role serves a read-back, one that writes nothing among them;
  - every constant a statement it runs evaluates, since PostgreSQL checks EXECUTE as the invoker: each constant reached
    through constants' bodies and through the CHECKs of every domain a value is written or cast into (a roster's names
    constant, a set's live constant), from the domains of its columns, from every CHECK, generated field, default and
    index of a table it writes, a cast into a domain inside them included, and from its policies and its views; and
    the closed constants its queries read.
- EXECUTE on the stand-up of each table it writes that a rule over a query reads, which makes the rule judge's
  temporary tables of the session, as the judge's own definer ([Rules over queries](schema.md#rules-over-queries)).
- Nothing else: no TRUNCATE, no sequence, and no other role's view or function.

</details>
