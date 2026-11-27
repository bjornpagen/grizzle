# grizzle

The relational model as a TypeScript API, compiled into PostgreSQL.

Your data has rules. Kept in app code, they hold only where that code remembers them, and only for that code. grizzle
moves them into the database. You declare relations, the laws they obey, what each kind of user may
see, and the queries and writes your app runs; grizzle compiles them into PostgreSQL 19's own domains, keys, foreign
keys, CHECKs, roles, views, row-level security policies and indexes. PostgreSQL then enforces every rule for your app,
your scripts and psql alike. Every query's result type follows from the query, every call is one SERIALIZABLE
transaction, and every failure is a typed value: a broken rule comes back naming the rule.

[Install](#install) · [Example](#example) · [Agent guide](packages/grizzle/skills/grizzle/SKILL.md) ·
[Contributing](CONTRIBUTING.md)

## Why grizzle exists

Your data has rules. A comment is on a post that exists. An organization's id starts with `org_`. A Free organization
has one seat. A member reads only their own organization's drafts.

Most codebases keep these rules in several places at once: a type in the app, an `if` in a request handler, a migration
written by hand, a trigger, a review comment that says "don't forget the org filter". Each copy holds only where someone
remembered it, and two things break them anyway:

- **Other writers.** A backfill script, a second service, an admin in psql and next quarter's data migration all write
  the same tables without going through your handlers.
- **Concurrency.** "Does this organization have a seat left? Then add the member" reads, then writes. Under READ COMMITTED,
  PostgreSQL's default, two requests both read the last free seat, and both add a member.

ORMs and query builders treat tables as storage and leave the rules to the app. The relational model, taken seriously,
sees a database differently:

- **A database is a set of facts.** Each row states something true: this post exists, in this organization, with this
  title. A fact stated twice is one fact.
- **A table is a relation**, a set of facts of one shape. Every field is required; a value that may be missing is a
  fact that may be missing, in a relation of its own.
- **A rule is a law every state must obey:** a key, a containment between relations, a check on each fact. You state it
  once, beside the relations, and it holds in every state the database commits.
- **A write is a move from one lawful state to the next, judged whole.** It commits all of its changes or none, and a
  refusal names the law the write would break.
- **What a role may see is itself a query.** A member's posts are a query over all posts, and the member reads and
  writes that query as if it were the table.
- **A query is a set expression,** and its result type follows from it: nested results, aggregates and keys included.
- **An enum is a closed relation:** rows the schema fixes, data that rules and queries read, not strings repeated
  through the code.
- **A derived value is never written by hand.** A count or a running total is filled by grizzle on every write and
  proved by PostgreSQL's constraints, and a rollup is a query read live, or stored and kept equal to it at every COMMIT.

grizzle makes that model the API, and compiles it into PostgreSQL so that PostgreSQL enforces it for every writer, not
only your app. A rule over tables becomes one of PostgreSQL's own constraints, and a rule over a query, a join no table
stores, a judge grizzle generates from the query, which runs it once at COMMIT over the rows the transaction wrote. Each role becomes a PostgreSQL role that reads
through views of its own, under row-level security where it writes only some rows.

Every call is one transaction, SERIALIZABLE unless `grizzle generate` proved its role's writes safe at READ
COMMITTED, its statements pipelined into one round trip, or two when a write must first read stored values it builds
on. There are no interactive transactions to hold open: a read that decides a write
is a query inside the write. Every transaction grizzle opens names its level, and a write below SERIALIZABLE on a
grizzle table is refused, so psql and scripts that write say SERIALIZABLE, on every table but one whose every writer is
certified to run READ COMMITTED and may only insert ([Transactions and concurrency](#transactions-and-concurrency)). Every failure is typed: a call fails with one
`CallError` of a closed set of kinds, a broken rule's `refused` naming the rule. A `transient` one changed nothing, and
grizzle never retries: whether to run it again is your code's decision.

Drizzle is a good typed SQL builder, thin by design: what you write is close to what runs. Its limits are those of the
storage view. A rule beyond keys, foreign keys and single-row CHECKs is a trigger you write in a custom migration, or a
check in app code that other writers skip and concurrent requests race past. Row-level security is policies whose
conditions are SQL strings, and a query that outgrows the builder becomes `` sql`…` `` with a result type you write by
hand. [Hard in Drizzle, one declaration here](#hard-in-drizzle-one-declaration-here) takes eight such cases one at a
time.

|                          | With Drizzle                                                    | With grizzle                                                                          |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Tables                   | `pgTable(...)`, nullable unless `.notNull()`                    | `relation(...)`, every field required                                                 |
| Rules beyond FK, unique  | `check()` on one row; triggers in custom migrations; app code   | declared beside the relations, over tables or queries, compiled for PostgreSQL to keep |
| Who sees which rows      | `where` clauses in app code, or `pgPolicy` with SQL conditions  | roles declared in TypeScript, compiled to roles, views, grants and row-level security |
| Complex queries          | often `` sql`…` `` with a hand-written result type              | one query language, every result type inferred, nested results included               |
| Indexes                  | declared by hand                                                | derived from your rules and from the queries your app runs                            |
| Transactions             | interactive, at the isolation level you pick                    | one SERIALIZABLE transaction per call, pipelined                                      |
| Migrations               | drizzle-kit generates SQL from your schema changes, or pushes them | `grizzle generate` drafts SQL that you review and commit; nothing is pushed        |

grizzle is opinionated in return. It runs on PostgreSQL 19 only, tested on the official 19.0 release, unpatched (what
19 costs it is under [PostgreSQL known issues](#postgresql-known-issues)), and it owns its database: existing schemas,
and tables created outside its migrations, are not supported. There are no nullable columns, outer joins, window
functions, interactive transactions or raw SQL at run time. Read [Limits](#limits) before you adopt it.

## The relational model, by feel

Here is a small blog for organizations that sign in through Clerk: posts, their comments, view counts, and the query a
post's page runs. Every `ts` block on this page typechecks in grizzle's test suite. This section reads the blog one
idea at a time.

```ts
import {
	closed,
	closedId,
	contained,
	instant,
	mutable,
	on,
	pg,
	query,
	relation,
	schema,
	str,
	unit,
	v
} from "@bjornpagen/grizzle"

const ClerkUser = str.regex("^user_[0-9A-Za-z]{1,64}$")
const ClerkOrg = str.regex("^org_[0-9A-Za-z]{1,64}$")
const Slug = str.regex("^[a-z0-9-]{1,96}$")
const Title = str.regex("^.{1,200}$", "su")
const Prose = str.regex("^.*$", "su")

export const Status = closed.ordered("Status", ["Draft", "Published"])
export const Post = relation(
	"Post",
	{
		org: ClerkOrg,
		slug: Slug,
		author: ClerkUser,
		title: Title,
		body: Prose,
		status: closedId(Status)
	},
	["org", "slug"]
)
export const Comment = relation(
	"Comment",
	{ org: ClerkOrg, post: Slug, author: ClerkUser, at: instant, body: Prose },
	["org", "post", "author", "at"]
)
export const PostViews = relation("PostViews", { org: ClerkOrg, post: Slug, views: pg.bigint }, [
	"org",
	"post"
])

export const Blog = schema(
	"Blog",
	[Status, Post, Comment, PostViews],
	[
		contained(on(Comment, "org", "post"), on(Post, "org", "slug")),
		contained(on(PostViews, "org", "post"), on(Post, "org", "slug")),
		unit("Org", { org: ClerkOrg }),
		mutable(Post),
		mutable(Comment),
		mutable(PostViews)
	]
)

/** A published post by its organization and slug, with its comments nested inside it. */
export const postPage = query(Blog)
	.rule((r) => {
		const { org, slug, title, body } = v(Post, "post")
		return r
			.match(Post, { org, slug, title, body, status: "Published" })
			.where(r.eq(org, r.param("org", ClerkOrg)), r.eq(slug, r.param("slug", Slug)))
			.find({ org, slug, title, body })
	})
	.attach(
		"comments",
		(post) =>
			query(Blog).rule((r) => {
				const { author, at, body } = v(Comment, "comment")
				return r
					.match(Comment, { org: post.org, post: post.slug, author, at, body })
					.find({ author, at, body })
			}),
		"array"
	)
```

Three relations, a roster of statuses, two rules, the unit the relations change under, and one query.

### Relations hold facts

`relation(name, fields, primaryKey)` declares a relation, and `schema(name, relations, rules)` gathers a list of
relations and the rules between them into one PostgreSQL schema. A relation's name is one string literal of ASCII
letters, digits and underscores, a letter first, the key the schema's types hold it under: `relation`, `closed` and
`derived` refuse a name typed `string`, or a literal of other characters, at the call that passes it, and a helper that
builds a relation takes its name as `RelationName<N>`. A schema a program generates from data, whose relations' names
it knows only at run time, declares them through `@bjornpagen/grizzle/dynamic`: its `relation`, `relation.generated`,
`closed.ordered`, `closed.unordered` and `closed.relation` take any string as a name, and their values' types say what
that loses. Each is an `AnyRelation`, `AnyRoster` or `AnyClosedRelation`, which states no name, fields or key, so a
schema that lists one holds its relations under any name and no typed statement or query reads its fields; the run
time checks its name, fields, key and rows, as it checks a JavaScript caller's. Its `records(stem, query, owner,
ownerKey, { names })` is the root's `records` (Records of a query) for such a schema: any string as the stem, `names` a
record read at run time of relation names by attachment path (`{}` states none), and its value a `GeneratedRecords`,
each relation one of any name and each law a statement. It is the door for a generated schema,
not a way around the checked API: a relation whose name a literal states is declared through the package root.

A library that derives the names of the relations and rosters it declares, as den derives `EssayItemInputValue` from
a flow's names, builds them with `derivedName({ stem, path })`, from the package root for literal names or from
`@bjornpagen/grizzle/dynamic` for names read at run time: its `relation`, `generated` and `unordered` type exactly as
`relation`, `relation.generated` and `closed.unordered` do. Each name stays readable and of any length, the key the
schema's types hold the relation under, and is refused for nothing but its characters and a collision: it meets every
name of its schema that converts alike, declared or derived, as `IdentifierCollision`. What it installs is never named
by its conversion: a relation's table and whole view and a roster's domain and whole view are hashed over the name,
which the schema keeps unique, `__<stem>_<digest>` within PostgreSQL's 63 bytes, a relation's spelled after `stem` and
`path`; a roster's constants are hashed as every roster's are. A user's ordinary relation stays declared.
`installedIdentifiersOf(schema)` from `@bjornpagen/grizzle/compile` lists every PostgreSQL identifier the schema's
installation names an object by, with what each spells out, so such a library's test holds every one to 63 bytes.

Each `Post` row is a fact: this post exists, in this organization at this slug, by this author, with this title, body
and status. Three things follow:

- **Every field is required.** There are no nullable columns. A post that has never been viewed has no `PostViews` row,
  and one that has been viewed has exactly one: a value that may be missing is a fact that may be missing.
- **A relation is a set.** A fact inserted twice is one fact, and a write that changes nothing answers `unchanged`.
- **A relation is closed or open.** A closed relation, the default, holds facts: they are inserted, never changed or
  deleted. No role holds UPDATE or DELETE on its table, its table refuses every UPDATE that would change a row, the
  owner's and psql's included, with 42501 naming the table, and a ChangeSet's put or delete of it is refused when it
  compiles, by name. A change is recorded as a fact inserted: a new row that supersedes, the current one derived. An
  open relation is `mutable(Post)` inside a unit ([Units](#units)) whose heading its primary key leads with: its rows
  are changed in place and deleted under the unit's exclusive borrow, `&mut`, and a `put` states the fact that holds at
  a key afterwards, which is what an update means. `mutable(R)` over a relation that sits in no unit is refused when
  the schema is built, by name.

### Types are sets of values

A field's type is the set of values it admits, and PostgreSQL checks it on every write, whoever writes.

- **Text always carries a pattern.** `ClerkOrg` admits `org_` followed by 1 to 64 ASCII letters or digits, so no writer stores
  `"acme"` as an organization. Its TypeScript type is the pattern's language: `string` here, and `"yes" | "no"` for
  `^(yes|no)$`.
- **A uuid is some system's id, by name.** `contract<typeof clerkUserKey>()("ClerkUserId", uuid)` holds a `Uuid`, a
  uuid's hyphenated spelling as a type, under that system's key: `Uuid.parse` reads one from a plain string, and the
  key's mint, `mintOf(clerkUserKey)`, marks it. A bare `uuid` field says no system and is refused
  ([Identity: natural keys](#identity-natural-keys)).
- **Integers keep their width.** `pg.bigint` is a `bigint` in TypeScript, never a `number` that rounds past 2^53.
- **`closedId(Status)`** holds one of `Status`'s handles: `"Draft" | "Published"` in TypeScript, a smallint code in
  PostgreSQL.

[Tables and types](#tables-and-types) lists every type with its PostgreSQL and TypeScript forms.

### Keys and containment

A key says which facts are one thing. The third argument of `relation` is the primary key: no two posts of one
organization share a slug, and no two `PostViews` rows share an organization and a post, so a post has at most one view
count. A comment is its post, its author and the instant it was written ([Identity: natural
keys](#identity-natural-keys)). `key(on(Post, "org", "title"))` would declare another: no two posts of one
organization share a title.

A containment says one set of values lies inside another. `contained(on(Comment, "org", "post"), on(Post, "org",
"slug"))` reads "every comment's organization and post are some post's organization and slug": a foreign key, written
as the inclusion it is. The same shape relates a
selection of rows, a closed relation, or spans covered by spans ([Rules](#rules)). Its sides pair field for field, each
pair of one base carrier, one SQL type once contracts are stripped: `natural`, an `instant` and a contract over
`pg.bigint` pair with `pg.bigint` and with each other, either side refining the other, since a refinement only narrows
the values and the inclusion is one law under the base's equality, the one PostgreSQL's foreign key between a domain
and its base type compares and the judge reads. `pg.integer` against `pg.bigint`, or a closed id against another
roster's, is refused: the sides' field types differ.

This is what `grizzle generate` installs for `Post` and that containment, abridged:

```sql
CREATE DOMAIN "blog"."status" AS smallint CONSTRAINT "check" CHECK (VALUE IS NULL OR (("blog"."__status_names_6zfckdmtul"())[VALUE + 1] <> ''::"pg_catalog"."name") IS TRUE);

CREATE DOMAIN "blog"."__text_ucvpb5bhvu" AS "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" CONSTRAINT "check" CHECK (VALUE IS NULL OR (VALUE ~ '\A[\u0001-\U0010FFFF]{1,200}\Z'::"pg_catalog"."text") IS TRUE);

CREATE TABLE "blog"."post" (
  "org" "blog"."__text_t2hbrv4zer" NOT NULL,
  "slug" "blog"."__text_xtmsv7734i" NOT NULL,
  "author" "blog"."__text_u2zmp7otto" NOT NULL,
  "title" "blog"."__text_ucvpb5bhvu" NOT NULL,
  "body" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  "status" "blog"."status" NOT NULL,
  CONSTRAINT "__post_pk_dyy23qj6j2" PRIMARY KEY ("org", "slug")
);

ALTER TABLE "blog"."comment" ADD CONSTRAINT "__comment_fk_org_post_5f73uubdcu" FOREIGN KEY ("org", "post") REFERENCES "blog"."post" ("org", "slug") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
```

Every column is NOT NULL. Each pattern is a domain, one per distinct pattern, so `post.author` and `comment.author`
share one. `Title`'s pattern reaches PostgreSQL spelled for its regex engine, and `Prose` admits every text, so its
column is plain `text`. The roster is a smallint domain over a function returning its names. The foreign key is deferred to COMMIT, so a write is judged on the state it leaves, not
statement by statement. All of it is PostgreSQL's own, so psql meets it as your app does:

```sql
-- psql, as a role that may write blog.post_views
INSERT INTO blog.post_views (org, post, views)
VALUES ('org_1', 'no-such-post', 1);
-- 23503 at COMMIT: org_1 has no post at that slug
```

Every key fits its index entry for every value its fields admit, in any order of its columns: a primary key, a
declared key, a UNIQUE, a family's UNIQUE or axis and every reference's target whose widest entry could pass
PostgreSQL's 2,704-byte B-tree limit, a text of no byte bound among its fields, is refused when the schema compiles,
`UnrepresentableKey`, naming the relation, the key and the field. One refusal names every such key the compile meets, so
one `grizzle generate` lists them all. grizzle never hashes a key behind your back: declare
a byte bound (`str.bytes(n)`) or a precision, or key by an explicit digest field you declare, such as a generated
`Crypto.sha256(x)` ([Keys and indexes](#keys-and-indexes)). A key that large is almost always a modelling bug. A read
that binds such a text by equality seeks by the digest its relation declares, grizzle stating the digest's equality
from the text's, or is refused alike.

### Identity: natural keys

grizzle mints no ids. A row is keyed by what makes its fact the one it is, so a fact written twice is one fact, and its
key names the same row in every database that holds it, a replica, a restore and a test's alike:

- **A child is its parent's key and its own name or place.** A lesson of a course is `(course, slug)`, a line of an
  order `(order, line)`, a member of an ordered family its owner and the index grizzle draws for it
  ([Families](#families)).
- **Content is its digest.** A file, a blob or a rendered document is keyed by `sha256`, the SHA-256 of its bytes, its
  32 bytes as they are (`Sha256`): equal bytes are one row, whoever stores them.
- **A published thing is its name and version.** A package is `(name, version)`, a QTI item its QTI identifier.
- **An outside system's id is that system's, by name.** A bare `uuid` field is a type error,
  `say whose id this is: contract<typeof key>()("ClerkUserId", uuid)`, and from JavaScript a `CompileError` with the
  same text: `contract<typeof clerkUserKey>()("ClerkUserId", uuid)` is a Clerk user's id, its own type, so a Clerk user
  is never written where a Stripe customer belongs.
- **Its time is an instant on the database's clock, never bits inside an id.** When a row was written is a field of its
  own that the database writes, and a fact that happens again later is keyed by its child and that instant. A UUIDv7's
  leading bits are its writer's clock, which another host's disagrees with, and its random bits answer uniqueness, not
  order, so no order of its ids is an order of the writes.

`pg.serial` and its kin and `pg.uuidv7` are type errors that say so, and from JavaScript a `CompileError` (`Refused`)
with the same text.

**Sharding.** The child is the shard key: every row under a parent carries the parent's key, so its subtree lives on
one shard and a write to it is that shard's transaction. Writes on several shards at once are ordered by a hybrid
logical clock, or told apart by the writer's own name joined to the key, `(child, at, writer)`, never by a minted id,
which orders nothing.

**Edges.**

- **A rename is a new fact, never a key update.** A key never changes: renaming a lesson, an open relation, deletes
  the fact at its old slug and inserts the one at its new slug in one ChangeSet, and the rows that name it move with it
  there; a closed relation records the rename as a fact inserted. A field that changes in place is outside the key, and
  `mutable(R)` inside a unit lets a put update it ([Writes](#writes)).
- **Two writes in one microsecond** are told apart by the rest of their key. Where nothing else tells them apart, they
  meet at the key, and under SERIALIZABLE the later one fails as a retryable `transient`, whose retry reads a later
  instant.

### Checks and closed relations

`Status` is a relation too. `closed.ordered("Status", ["Draft", "Published"])` is a roster: a closed relation of one field,
`id`, whose rows the schema fixes. It stands among `Blog`'s relations, a query matches it like any table, and
`closedId(Status)` refers into it. Each handle has a code, 0 … n − 1 in declared order. The API reads and writes names,
and the table stores codes under a domain that admits only live handles. A roster may list no handle,
`closed.ordered("Graders", [])`, a registry of nothing: a closed id of it is the empty type, `never`, and its domain admits
no value, so a write of a relation with such a field is refused and a read of it, or of the roster, delivers no row; a
set over it holds only the empty set, and a fold's `max` over its closed ids, which has no least value, is refused.

A closed id may hold some of its roster's handles: `closedId(Status, { only: ["Draft"] })` holds the handles it lists, and
`closedId(Status, { except: ["Draft"] })` every handle but those. Each list names live handles, each once, and `except`
leaves at least one; a subset of every handle is `closedId(Status)`. Its TypeScript type is the subset's names, and its
column is the roster's domain with a CHECK of the subset's codes, so a direct writer stores no other handle either. It
meets a closed id of the same roster, whatever that one's subset, in an equality, a join and a containment, but a value
enters its column only from a closed id whose handles it holds. A term's subset is a proof of the handles it can be: a
field's of its column's CHECK, a variant's tag of its arms (README "Variants"), a literal branch of a conditional of its
own handle, so `Logic.cond(p, x, "Draft")` holds x's handles and `Draft`, and an operation of its operands'. A cast never
narrows one: a value of a subset comes from a value of that subset. So a field PostgreSQL generates of a subset, whose
generation is admitted only within it, carries no CHECK: the compile proves what the CHECK would judge.

Every roster states whether its order means something. `closed.ordered` is a roster whose declared order is its
comparison order, so its closed ids compare, range and sort by it. `closed.unordered` is one whose order means nothing,
such as the element names of a grammar: a comparison, `between`, `orderBy`, `least`, `greatest`, `min`, `max` or a
fold's `max` over its closed ids is a type error, which names `closed.ordered` as the fix. Codes are history either
way: an added handle takes the next code and a removed one leaves its code unused. An ordered roster's reorder is
refused, and an unordered roster's handles may be declared in any order ([Migrations](#migrations)).

A closed relation can carry data too. Here is a price list for the blog's organizations, and two rules that tie it to
the blog:

```ts
import { check, natural } from "@bjornpagen/grizzle"

/** The plans an organization can be on, and the seats each allows: rows the schema fixes. */
export const Plan = closed.ordered("Plan", ["Free", "Team"])
export const PlanLimits = closed.relation(
	"PlanLimits",
	{ plan: closedId(Plan), seats: natural },
	["plan"],
	[
		{ plan: "Free", seats: 1n },
		{ plan: "Team", seats: 50n }
	]
)

/** Each organization's plan, and the seats it bought. */
export const Subscription = relation(
	"Subscription",
	{ org: ClerkOrg, plan: closedId(Plan), seats: natural },
	["org"]
)

/** The blog, billed: an organization posts once it subscribes, within its plan's seats. */
export const Billing = schema.extend(
	[Blog],
	"Billing",
	[Plan, PlanLimits, Subscription],
	[
		contained(on(Post, "org"), on(Subscription, "org")),
		check("WithinPlan", Subscription, (s) => s.le(s.seats, PlanLimits.at("seats", s.plan)))
	]
)
```

`schema.extend` builds a level named `Billing` on `Blog`: all of its relations and rules, three relations more and two
rules more. A level installs its relations in a PostgreSQL schema of its own, `billing` beside `blog`, and one
installation holds them both ([Levels](#levels)). `natural` is a count, a `bigint` that is never negative.

- **`contained(on(Post, "org"), on(Subscription, "org"))`**: an organization posts only once it has a subscription. A
  containment's target is a key, here `Subscription`'s primary key.
- **`check("WithinPlan", Subscription, ...)`**: a check is a condition every fact of one relation meets, written over
  its fields, as in `(s) => s.ge(s.seats, 1n)`. This one reads the price list: `PlanLimits.at("seats", s.plan)` is the
  seats of the subscription's plan.

`PlanLimits` has no table. Its rows become IMMUTABLE constants, which PostgreSQL folds into every statement that reads
them, and `WithinPlan` becomes a CHECK that reads them through a row function, a PL/pgSQL function of the columns the
check reads, which each backend plans once with the constants folded in, so no statement that writes `Subscription`
reads them again ([PostgreSQL known issues](#postgresql-known-issues)). Abridged from `grizzle generate`:

```sql
CREATE FUNCTION "blog"."__constant_votvjyxb73"() RETURNS bigint[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN '{"1","50"}'::bigint[];

CREATE FUNCTION "blog"."__row_thta7vjw4u"("seats" "blog"."__domain_gfw43vigph", "plan" "billing"."plan") RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = "pg_catalog", "pg_temp"
AS $$
BEGIN
  RETURN $1::"blog"."__domain_gfw43vigph" <= ("blog"."__constant_votvjyxb73"())[NULLIF("pg_catalog"."substring"("blog"."__constant_ab5qkascpx"(), $2::"billing"."plan" * 2 + 1, 2)::integer, 0) - 1 + 1];
END
$$;

CREATE TABLE "billing"."subscription" (
  "org" "blog"."__text_t2hbrv4zer" NOT NULL,
  "plan" "billing"."plan" NOT NULL,
  "seats" "blog"."__domain_gfw43vigph" NOT NULL,
  CONSTRAINT "__subscription_pk_ji5ktre5v6" PRIMARY KEY ("org"),
  CONSTRAINT "within_plan" CHECK (("blog"."__row_thta7vjw4u"("seats", "plan")) IS TRUE)
);
```

The seats are an array, and a second constant, a bit string, maps each plan's code to its row. A plan's seats are
stated once, as data, and every writer meets them. [Closed relations](#closed-relations) covers keys of several fields,
the `has` and `row` reads, and slots.

### A query is a set, typed by its shape

`postPage` is a query made of one rule and one attachment. `v(Post, "post")` makes one variable per field, in a scope
named `post`. `r.match` binds variables, and constants such as `status: "Published"`, to a relation's facts, and a
variable used in two matches joins them. `.where` filters, `.find` picks the result's fields, and `.attach` nests a
child query in each row. The result is a set, and its type follows from the query, the nested comments included:

```text
{
  readonly org: string
  readonly slug: string
  readonly title: string
  readonly body: string
  readonly comments: ReadonlyArray<{ readonly author: string; readonly at: bigint; readonly body: string }>
}
```

Nothing there is annotated by hand. grizzle also knows each result's keys. `postPage` fixes `org` and `slug`, `Post`'s
key, to its two parameters, so it returns at most one row, and served in a workload its value,
`db.workload.postPage.once({ params: { org, slug }, facts: {} })`, is a set of at most one row, keyed by nothing: every
row is keyed by the key grizzle proves of its result. An aggregate is typed as PostgreSQL computes
it: `r.count()` is a `natural`, a `bigint` never below zero, and the `r.sum` of an integer is an exact `Decimal`.
Negation is `r.not(Comment, { org, post: slug })`, a union is a second `.rule(...)`, and there is no `` sql`…` `` to
fall back to.
[Queries](#queries) has the whole language.

### A write moves between lawful states

A write is a ChangeSet: the facts to insert, delete and put, applied as one transaction. A `Db`, the handle you read and
write through, always acts as a role, and `Admin` holds all of `Billing` (the first case below is about roles that see
less):

```ts
import {
	ChangeSet,
	type Fact,
	role,
	wholeEntriesOf,
	wholeWritesOf,
	workload
} from "@bjornpagen/grizzle"
import { Db } from "@bjornpagen/grizzle/runtime"

/** A role that reads all of Billing, inserts into each closed relation and changes each open one. */
export const Admin = role(Billing, "admin", wholeEntriesOf(Billing), wholeWritesOf(Billing))

/** An organization's subscription and its first post: one write, judged as a whole. */
export const launch = ChangeSet.empty(Billing).insert(Subscription, []).insert(Post, [])
export const onboarding = workload(Admin, { launch })

export const launchOrg = (
	db: Db<typeof Admin, typeof onboarding.programs>,
	subscription: Fact<typeof Subscription>,
	post: Fact<typeof Post>
) =>
	db.workload.launch.once({
		params: {},
		facts: { insert: { Subscription: [subscription], Post: [post] } }
	})
```

A ChangeSet runs as a member of a workload, compiled by `grizzle generate`; one built with `[]` takes its rows with each
call, as its `facts`. `once` sends it as one SERIALIZABLE transaction and answers with its outcome after COMMIT,
`accepted` or `unchanged`; a rule that refuses it is the call's error, `refused`, and a row the role may not write is
`outsideWorld`. The subscription and the post go in together, in either order: the post's containment in
`Subscription` is decided at COMMIT, on the state the write leaves, and a post for an organization with no subscription
is refused on it. Launch `org_2abc` on the Free plan with 5 seats, and nothing changes. The error is:

```text
{
  kind: "refused",
  retry: "never",
  message: "the schema's laws refused the write",
  refused: {
    kind: "every",
    laws: [
      {
        law: { kind: "check", relation: "Subscription", name: "WithinPlan" },
        id: "__subscription_check_within_plan_dlbf4oactg",
        by: { kind: "constraint", table: "subscription", name: "within_plan" }
      }
    ]
  },
  witness: { kind: "key", relation: "Subscription", values: { org: "org_2abc" } }
}
```

Each entry of `refused.laws` names a broken rule as you declared it, its `law`, never as a message to parse, so
`entry.law.kind === "check" && entry.law.name === "WithinPlan"` recognizes this one. Its `id` is the rule's identity,
the one the snapshot records, and `by` the installed object that refused it. `every` means grizzle judged each rule
named there broken, and the witness is the key of the fact that broke it. psql gets the same refusal from PostgreSQL,
SQLSTATE 23514 on the constraint `within_plan`.

Every failure is one `CallError` like this one, `{ kind, retry, message }`: a dropped connection, a serialization
failure, a rule's refusal. `retry: "safe"` means nothing committed and the same call may succeed, as after a
`transient` one, whose `reason` says which concurrent transaction's work met it; your code may run the write again, and
grizzle never does. [Errors and outcomes](#errors-and-outcomes) lists every outcome and error.

That is the model in small: facts, laws over them, queries that are sets, and writes that move between lawful states.
The rest of it arrives through eight cases that are hard when tables are storage, starting with the idea that what a
role may see is itself a query: [Hard in Drizzle, one declaration here](#hard-in-drizzle-one-declaration-here).

## Hard in Drizzle, one declaration here

Drizzle is a good typed SQL builder, thin by design: what you write is close to what runs, and selects, joins and relational queries infer their types well. Its limits are those of the model it serves, the one most apps are built on: tables are storage, and app code enforces the rules. In that model:

- **You design the database by hand.** Foreign keys, CHECKs, triggers, indexes and row-level security policies are yours to write, in SQL or a SQL-shaped API, and to keep in step with the code.
- **Inference stops where queries get interesting.** A grouped aggregate nested in each row, or a recursive walk, goes into `` sql`…` ``, with a result type you write and nothing checks.
- **Rules and permissions live in handlers.** They are `where` clauses and `if`s that every code path must remember, that every other writer (a script, a psql session, a second service) skips, and that concurrent requests race.

The eight cases below are where that model breaks, each a problem a large app meets in production:

1. [Every organization sees only its own rows](#1-every-organization-sees-only-its-own-rows): a filter one handler forgets.
2. [Top three per group, with exact types](#2-top-three-per-group-with-exact-types): a result type nothing checks.
3. [A tree of any depth](#3-a-tree-of-any-depth): a query the builder can't write.
4. [No double booking](#4-no-double-booking): a rule the table builder can't state.
5. [A budget no burst of requests can overdraw](#5-a-budget-no-burst-of-requests-can-overdraw): a check that reads, then writes, and races.
6. [Books that always balance](#6-books-that-always-balance): a rule over many rows, kept by a trigger.
7. [States that carry their own data](#7-states-that-carry-their-own-data): nullable columns every reader narrows.
8. [A usage page: windows, a rollup and their indexes](#8-a-usage-page-windows-a-rollup-and-their-indexes): indexes nothing ties to their queries.

Each case runs the same way: the problem, the Drizzle way and where it falls short, the reframe that changes the problem once you see the data relationally, the declaration, and what you get. Each introduces the grizzle feature it needs.

Most cases come from an LLM API platform: organizations, API keys, metered calls, credits and invoices. The declarations continue the blog schema above, reuse its `ClerkUser`, `ClerkOrg`, `Title` and `Prose`, and import what they add. Every `ts` block on this page typechecks in the test suite, and each generated statement shown is `grizzle generate`'s output for that code, abridged where marked.

grizzle is opinionated in return: PostgreSQL 19 only, no nullable columns, no outer joins or window functions, no interactive transactions and no raw SQL at run time. Read [Limits](#limits) before you adopt it.

### 1. Every organization sees only its own rows

**The problem.** Members manage their organization's API keys from a dashboard. They must never see, create or delete another organization's keys, and one query that leaves out the organization lists every customer's keys.

**The Drizzle way.** Tenancy is `where(eq(apiKey.orgId, orgId))` in every query and `orgId` in every insert. A handler that forgets the clause compiles and ships. To move the rule into PostgreSQL, you write row-level security in SQL: `pgPolicy` declares a policy, but its condition is a `` sql`…` `` string, and every request must switch role and set the claim inside the transaction its queries run in:

```sql
ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON api_key TO app_user;
CREATE POLICY api_key_by_org ON api_key TO app_user
  USING (org_id = current_setting('app.org_id'))
  WITH CHECK (org_id = current_setting('app.org_id'));

-- and around every request, in db.transaction:
SET LOCAL ROLE app_user;
SELECT set_config('app.org_id', $1, true);
```

Nothing ties the policy's condition to the TypeScript that relies on it, and a query sent outside that transaction, or by the role that owns the table, never meets the policy.

**The reframe.** "This organization's keys" is not a filter you add to queries. It is the world the caller's session lives in: every fact of the caller's organization. Say once what an organization's facts are and what binds the caller's, and every query the role runs means its evaluation over that world. Four declarations say it:

- **A `unit`** is a key that groups facts: every table whose primary key leads with its fields is a member. `Org` groups an organization's facts, `ApiKey` keyed `(org, digest)` among them, and its `digest` stays a key of its own, so a key is one row everywhere.
- **A `context`** is a claim of the caller's verified session token, which a query reads as a table of at most one row. `Tenant` holds the token's `org`.
- **A `role`** is what one kind of user sees, laid out as tables. Each entry is a table of the schema, whole, or a query over it, `insert` lists the entries the role only adds to, `write` the open ones it changes, `contexts` the contexts it declares, the claims its `Db` holds, and `scope` the units its claims bind, each by a query whose head is the unit's key: `tenant`, the `org` of `Tenant`.
- **A `login`** is one PostgreSQL user, with its password and its own connection pool, that can act as the roles it lists.

**The declaration.**

```ts
import { context, key, login, role, sha256, wholeEntriesOf } from "@bjornpagen/grizzle"

/** An organization's API key, keyed by the SHA-256 of its secret: the table never holds a secret. */
export const ApiKey = relation("ApiKey", { org: ClerkOrg, digest: sha256, name: Title }, [
	"org",
	"digest"
])
export const Keys = schema(
	"Keys",
	[ApiKey],
	[unit("Org", { org: ClerkOrg }), key(on(ApiKey, "digest"))]
)

/** The caller's organization: the `org` claim of their verified session token. */
export const Tenant = context("Tenant", { org: ClerkOrg })

/** The organization the caller's token names: the Org unit's key its claims bind. */
export const tenant = query(Keys).rule((r) => {
	const { org } = v(Tenant, "tenant")
	return r.match(Tenant, { org }).find({ org })
})

export const KeyAdmin = role(Keys, "key_admin", wholeEntriesOf(Keys), {
	insert: ["ApiKey"],
	contexts: [Tenant],
	scope: [tenant]
})
export const Dashboard = login(Keys, "dashboard", [KeyAdmin])

/** The caller's organization's keys: no organization in it, the role's scope binds it. */
export const orgKeys = query(Keys).rule((r) => {
	const { digest, name } = v(ApiKey, "apiKey")
	return r.match(ApiKey, { digest, name }).find({ digest, name })
})
```

**What you get.** The dashboard's queries and writes are written over `Keys` itself, and on `KeyAdmin` every one of them means its evaluation over the caller's organization: `orgKeys` returns its keys, with rows `{ digest: Sha256; name: string }`, the digest its 32 bytes, though no `org` is bound in it. There is no `where` to forget, and no query can leave the organization out: a count, a negation, a take, a join and every derived table read the caller's rows alone, each read of `ApiKey` an index probe at the caller's `org`.

A write is held to the same world. An insert states its `org`, and a key of another organization's is `outsideWorld` before any statement runs. Another organization's keys don't exist for this role: an insert at a `digest` one already holds is `refused` on the digest's key, its witness the `digest` you submitted, never the other row. `ApiKey` is closed, its facts inserted and never changed or deleted, so the role names it under `insert` and holds SELECT and INSERT on its table and nothing more; naming it under `write` is `RoleRefused` (`writeClosed`). Opening a `Db` of `key_admin` through the dashboard's served login doesn't compile without a token, and opening runs your `verify` function on it once.

grizzle installs `KeyAdmin` as a PostgreSQL role that holds `ApiKey` whole: a scope binds what the role's programs mean, not what a SQL session as the role reads. The login is the trust boundary. It holds no table privilege of its own and can only switch to its roles, and whoever holds its password can act as any of them with any claims, so no policy on the claims would hold them: give each trust domain its own login ([Security model](#security-model)). `roleNameOf(Dashboard, {})` is the login's PostgreSQL role in an installation without a role prefix, here `keys__dashboard`, and `roleNameOf(KeyAdmin, {})` the role's, `keys__key_admin`. What `grizzle generate` installs for the role, abridged:

```sql
CREATE ROLE :"keys__key_admin" NOLOGIN;
GRANT :"keys__key_admin" TO :"keys__dashboard" WITH INHERIT FALSE, SET TRUE;
GRANT SELECT, INSERT ON TABLE "keys"."api_key" TO :"keys__key_admin";
```

A role is a cluster's, not a database's, so the SQL names it by a variable, psql's `:"keys__key_admin"`, which `grizzle migrate` fills with the role of the installation it migrates: `keys__key_admin` itself, or `a__keys__key_admin` in an installation whose connection gives `rolePrefix: "a"`. A query entry, a role's table that is a query over the schema, says what a role sees of a table where that is no unit's facts, such as the posts a member may read; the [example](#example) builds them, with roles, logins and Clerk tokens in full.

### 2. Top three per group, with exact types

**The problem.** A billing page shows each workspace's spend, and its three costliest models with their call counts, leaving out refunded calls. The numbers are money, so a lost digit is a support ticket.

**The Drizzle way.** This query is past what the builder infers: a LATERAL subquery (or a window function) for the top three per workspace, NOT EXISTS for the refunds, and `json_agg` to nest them. It ends up in `` sql`…` ``:

```sql
SELECT w.workspace_id, w.spend, top.models
FROM (
  SELECT c.workspace_id, sum(c.cost) AS spend
  FROM call c
  WHERE NOT EXISTS (SELECT 1 FROM refund f WHERE f.call_id = c.id)
  GROUP BY c.workspace_id
) w
CROSS JOIN LATERAL (
  SELECT coalesce(json_agg(m ORDER BY m.spend DESC, m.model), '[]') AS models
  FROM (
    SELECT c.model, count(*) AS calls, sum(c.cost) AS spend
    FROM call c
    WHERE c.workspace_id = w.workspace_id
      AND NOT EXISTS (SELECT 1 FROM refund f WHERE f.call_id = c.id)
    GROUP BY c.model
    ORDER BY spend DESC, c.model
    LIMIT 3
  ) m
) top;
```

The row type is yours to write, and nothing checks it against the query. It is easy to get subtly wrong: node-postgres returns the outer `sum` as a string, while `json_agg` turns the inner `sum` and `count` into JSON numbers, which lose precision past 2^53.

**The reframe.** A query is a set expression, and its result type follows from it. "Each workspace's spend" is a rule with an aggregate. "Its three costliest models" is a second query nested in each row, ordered and cut to three. "Not refunded" is a negation: the calls for which no `Refund` row exists, since a refund is a fact in a table of its own, not a nullable column on the call. grizzle reads the expression instead of sending a string, so the row type follows from it: a `count` is a `natural`, the bigint PostgreSQL counts in, never below zero, and a `sum` of a bigint a numeric, and the type says so.

The amounts are contracts. **A `contract`** is a named type over a base type, with an optional check, installed as a PostgreSQL domain that every writer meets. `Micros` is a bigint that is never negative. `Millis` adds no check, but is a type of its own, so an instant is never compared with an amount. A contract's values are the module's that holds its key: `mintOf(microsKey)` makes them, `toMicros(0n)`, without checking them, and the database checks every write. Where the database or grizzle makes them, a cast, a field grizzle fills, a clock reading or a declared function's result, the declaration takes the key too: `accumulated(Micros, toMicros(0n), microsKey)`.

**The declaration.**

```ts
import { contract, Logic, mintOf } from "@bjornpagen/grizzle"

/** The keys of this module's amounts and instants: whoever holds a key makes values of its contract. */
const microsKey = Symbol("Micros")
const millisKey = Symbol("Millis")
/** Millionths of a dollar, never negative; and an instant, in milliseconds since the epoch. */
const Micros = contract<typeof microsKey>()("Micros", pg.bigint, (m) => Logic.ge(m, 0n))
const Millis = contract<typeof millisKey>()("Millis", pg.bigint)
const toMicros = mintOf(microsKey)
/** The gateway's id of a request, and a workspace's slug: each the name its own system gives it. */
const RequestId = str.regex("^req_[0-9A-Za-z]{1,64}$")
const Workspace = str.regex("^ws_[0-9a-z]{1,32}$")

/** One API call, by the gateway's request id: its workspace, its model, when it ran and what it cost. */
export const Call = relation(
	"Call",
	{ id: RequestId, workspace: Workspace, model: Title, at: Millis, cost: Micros },
	["id"]
)
export const Refund = relation("Refund", { call: RequestId }, ["call"])
export const Usage = schema(
	"Usage",
	[Call, Refund],
	[contained(on(Refund, "call"), on(Call, "id"))]
)

/** Each workspace's spend, and its three costliest models, leaving out refunded calls. */
export const topModels = query(Usage)
	.rule((r) => {
		const { id, workspace, cost } = v(Call, "call")
		return r
			.match(Call, { id, workspace, cost })
			.where(r.not(Refund, { call: id }))
			.find({ workspace, spend: r.sum(cost) })
	})
	.attach(
		"models",
		(w) =>
			query(Usage)
				.rule((r) => {
					const { id, model, cost } = v(Call, "call")
					return r
						.match(Call, { id, workspace: w.workspace, model, cost })
						.where(r.not(Refund, { call: id }))
						.find({ model, calls: r.count(), spend: r.sum(cost) })
				})
				.orderBy(["spend", "desc"])
				.take(3),
		"array"
	)
```

**What you get.** Rows typed from the query, with nothing written by hand:

```text
{
  readonly workspace: string
  readonly spend: Decimal
  readonly models: ReadonlyArray<{ readonly model: string; readonly calls: bigint; readonly spend: Decimal }>
}
```

`calls` is a `bigint` and `spend` an exact `Decimal` at both levels, because that's what PostgreSQL computes. `.attach("models", (w) => ..., "array")` nests the child query in each row, and `w.workspace` is the parent row's value. `.orderBy(["spend", "desc"]).take(3)` keeps each workspace's three costliest models, and they arrive in that order, ties broken by `model`, the child query's key, which grizzle adds to the order because it knows the key.

Both levels match each call's `id`, though neither returns it. A query is a set, so an aggregate reads each row it matches once, by its key: two calls of one model and one cost are two calls, not one. A rule with an aggregate that doesn't bind each match's key is refused with `FoldOverProjection`, naming the key to bind. And `Refund` is contained in `Call`, so a refund of a call that doesn't exist is `refused` on that rule, whoever writes it.

### 3. A tree of any depth

**The problem.** Reseller billing: an account bills through its parent account, to any depth, and a reseller sees what every account under it spent.

**The Drizzle way.** Drizzle's query builder has CTEs (`$with`) but no recursive one, so this is `` db.execute(sql`…`) `` with a row type you write:

```sql
WITH RECURSIVE below(account_id) AS (
  SELECT id FROM account WHERE id = $1
  UNION
  SELECT b.child_id FROM bills_through b JOIN below ON b.parent_id = below.account_id
)
SELECT c.account_id, sum(c.amount) AS spend
FROM below JOIN charge c ON c.account_id = below.account_id
GROUP BY c.account_id;
```

**The reframe.** A hierarchy is a relation of edges, `BillsThrough(child, parent)`, and "every account below the root" is the smallest set that holds the root and, with each account in it, the accounts that bill through that account. That is a recursive query, and its answer is a fixed point: a set like any other relation, which you join, filter and aggregate.

**The declaration.**

```ts
/** A Stripe customer, and one of its charges: each Stripe's own id. */
const Customer = str.regex("^cus_[0-9A-Za-z]{1,64}$")
const StripeCharge = str.regex("^ch_[0-9A-Za-z]{1,64}$")

export const Account = relation("Account", { id: Customer }, ["id"])
/** Reseller billing: an account bills through at most one parent account. */
export const BillsThrough = relation("BillsThrough", { child: Customer, parent: Customer }, [
	"child"
])
export const Charge = relation("Charge", { id: StripeCharge, account: Customer, amount: Micros }, [
	"id"
])
export const Resellers = schema(
	"Resellers",
	[Account, BillsThrough, Charge],
	[
		contained(on(BillsThrough, "child"), on(Account, "id")),
		contained(on(BillsThrough, "parent"), on(Account, "id")),
		contained(on(Charge, "account"), on(Account, "id"))
	]
)

/** The root account and every account below it, at any depth. */
const below = query(Resellers).recursive("Below", {
	row: { account: Customer },
	base: [
		(r) => {
			const { id } = v(Account, "account")
			return r
				.match(Account, { id })
				.where(r.eq(id, r.param("root", Customer)))
				.find({ account: id })
		}
	],
	rec: [
		(r, self) => {
			const { account } = v(self, "self")
			const { child } = v(BillsThrough, "billsThrough")
			return r
				.match(self, { account })
				.match(BillsThrough, { child, parent: account })
				.find({ account: child })
		}
	]
})

/** What each account under a reseller spent. */
export const treeSpend = query(Resellers).rule((r) => {
	const tree = below.bind({ root: r.param("root", Customer) })
	const { account } = v(tree, "tree")
	const { id, amount } = v(Charge, "charge")
	return r
		.match(tree, { account })
		.match(Charge, { id, account, amount })
		.find({ account, spend: r.sum(amount) })
})
```

**What you get.** `query(S).recursive(name, { row, base, rec })` declares the recursive relation: `row` its fields, `base` the rules that seed it, and `rec` the rules that grow it from `self`, the set so far. `below.bind({ root })` passes it a parameter, and `r.match` joins it to `Charge` like a table. `treeSpend` takes `{ root: string }`, and its rows are `{ account: string; spend: Decimal }`.

The recursion compiles to `WITH RECURSIVE … UNION`, and its result is a set, so a cycle in `BillsThrough` ends the walk instead of looping forever. A recursive rule reads `self` positively, never under a negation, an aggregate or a take, so the fixed point is well defined: aggregate the finished set, as `treeSpend` does. The edges' rules hold for every writer: both ends of an edge are accounts, and a second parent for one account is `refused` on `BillsThrough`'s primary key, `child`.

A recursive rule joins `self` to stored relations, and to queries of one rule over them, each at the row it extends, which an index reads. A rule may read a recursion where the recursion keeps within one unit ([Rules over queries](#rules-over-queries)). It reads no other recursion and no union of rules, at any depth of what it matches or negates: PostgreSQL computes a recursion once as a relation with no index, and deduplicates a union before any join reaches it, so a step that read either would read all of it for every row it extends. Both are refused when the query compiles (`RecursionRefused`, cause `recursiveStep` or `unionStep`): carry the other recursion's state as columns of this walk, and match each rule of the union in a recursive rule of its own. A base rule, and a recursive rule that reads no `self`, which joins the base, read either: they run once.

When the shape is itself a rule (one root, no cycles, children in order), declare it. `tree(...)` makes PostgreSQL's constraints hold each tree's rows to one tree, every row reachable and none on a cycle, and keeps each row's pre-order interval, so a subtree is a range scan with no recursion ([Families](#families)).

### 4. No double booking

**The problem.** Meeting rooms: two bookings of one room never overlap, and a room is booked only within its opening hours. Two people pick the same free slot in the same second.

**The Drizzle way.** Neither rule fits the table builder. The first is an exclusion constraint, and the second a trigger function you write (or, on PostgreSQL 18 and later, a temporal key and a PERIOD foreign key over range columns), in a custom migration your TypeScript schema doesn't know about:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&);
-- and "within opening hours": a trigger function on booking, and another on opening_hours
```

A violation reaches the app as an error whose constraint name you match on. Without the constraint, an app-side "is the slot free?" check races: both requests see the slot free, and both insert.

**The reframe.** A booking doesn't hold two timestamps; it holds one span. With spans as values, both rules are ones you already know. "No two bookings of a room overlap" is a key: a room and a span identify a booking, and two spans that share a minute collide. "Within opening hours" is a containment, a foreign key between spans: every minute of a booking lies in an opening of its room.

**The declaration.**

```ts
import { span } from "@bjornpagen/grizzle"

const minuteKey = Symbol("Minute")
const Minute = contract<typeof minuteKey>()("Minute", pg.bigint)

/** A room is its name, unique in the building. */
export const Room = relation("Room", { name: Title }, ["name"])
export const Opening = relation("Opening", { room: Title, hours: span(Minute) }, ["room", "hours"])
export const Booking = relation("Booking", { room: Title, during: span(Minute), by: ClerkUser }, [
	"room",
	"during"
])

export const Rooms = schema(
	"Rooms",
	[Room, Opening, Booking],
	[
		contained(on(Opening, "room"), on(Room, "name")),
		contained(on(Booking, "room", "during"), on(Opening, "room", "hours"))
	]
)
```

**What you get.** A `span` in a primary key makes it a no-overlap key: rows that agree on `room` never share a point of `during`. `contained` between two spans is coverage: the room's opening hours cover each booking. A span includes its start and excludes its end, so back-to-back bookings don't overlap.

There is no timestamp type: a `Minute` is a bigint contract, minutes since the epoch, and the current time is a parameter you pass. A coverage's target needs a no-overlap key over its span, as `Opening`'s primary key is, or the schema is refused. `grizzle generate` compiles both rules to PostgreSQL's own constraints, a temporal primary key and a PERIOD foreign key:

```sql
CREATE TABLE "rooms"."booking" (
  "room" "rooms"."__text_ucvpb5bhvu" NOT NULL,
  "during" "pg_catalog"."int8range" NOT NULL,
  "by" "rooms"."__text_u2zmp7otto" NOT NULL,
  CONSTRAINT "__booking_pk_tzyi2pgieq" PRIMARY KEY ("room", "during" WITHOUT OVERLAPS)
);

ALTER TABLE "rooms"."booking" ADD CONSTRAINT "__booking_fk_room_during_254p6ghcbd" FOREIGN KEY ("room", PERIOD "during") REFERENCES "rooms"."opening" ("room", PERIOD "hours") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
```

A booking that overlaps another fails its write's `once` with `refused`, naming the rule, `{ kind: "primaryKey", relation: "Booking", fields: ["room", "during"] }`, with the room and span you submitted as its witness. A booking outside opening hours names the coverage rule, at commit. The constraints are PostgreSQL's, so two overlapping bookings sent in the same second can't both commit, whether the app, psql or a second service sends them.

### 5. A budget no burst of requests can overdraw

**The problem.** Prepaid credits: each API call debits a grant, and a grant's debits never add up to more than its amount, however many calls spend it at once. For an API, a burst of concurrent calls against a nearly spent grant is the normal case.

**The Drizzle way.** An interactive transaction that locks the grant, sums its debits and checks in app code:

```sql
BEGIN;
SELECT amount FROM credit_grant WHERE id = $1 FOR UPDATE;
SELECT coalesce(sum(amount), 0) AS spent FROM debit WHERE grant_id = $1;
-- in app code: if spent + $3 > amount, ROLLBACK
INSERT INTO debit (call_id, grant_id, amount) VALUES ($2, $1, $3);
COMMIT;
```

That is several round trips, and it holds only while every writer takes the same lock first: a backfill script or a second service that inserts a debit directly can overdraw the grant. A trigger that sums the debits doesn't close the gap under READ COMMITTED, PostgreSQL's default: two concurrent transactions each see their own debit but not the other's, and both commit.

**The reframe.** What a grant has spent isn't a number you update. It is a fold over a set of facts: the sum of the debits that name the grant. Declare the fold, and "within budget" becomes a row check on the grant, `spent <= amount`, like any other. grizzle fills `spent` as debits are written, PostgreSQL proves at every commit that it is the sum of the grant's debits, and SERIALIZABLE turns the race into a retry.

The declaration introduces families, rules over rows the caller writes:

- **`drawn(natural)` and `accumulated(type, start)`** are fields grizzle writes, never the caller: a count, and a value accumulated from members, starting at `start`. grizzle makes their values, so a consumer's contract's takes its key after the arguments, `accumulated(Micros, toMicros(0n), microsKey)`.
- **`counted(on(Debit, "grant"), fin(Grant, "debits"))`** says each grant's members are the debits that name it, and `debits` counts them. `fin(Grant, "debits")` is the slots of that count.
- **`fold(family, Monoid.sum, step, end)`** combines each member's step value, a debit's `amount`, into its owner's end, the grant's `spent`, by a monoid: here an exact sum.
- **`unit("Grant", { id: StripePayment })` and `mutable(Grant)`** open the grant: its count and total change after it is inserted, under its unit's borrow. A relation is closed by default: its facts are inserted, never changed or deleted.

`wholeEntriesOf(Credits)` is the entries of a role that sees every table whole, so `Metering` reads everything and writes only debits.

**The declaration.**

```ts
import {
	accumulated,
	ChangeSet,
	check,
	counted,
	drawn,
	type Fact,
	fin,
	fold,
	Monoid,
	mutable,
	natural,
	unit,
	wholeEntriesOf,
	workload
} from "@bjornpagen/grizzle"
import { Db } from "@bjornpagen/grizzle/runtime"

/** A grant of credits, by the Stripe payment that bought it. */
const StripePayment = str.regex("^pi_[0-9A-Za-z]{1,64}$")
export const Grant = relation(
	"Grant",
	{
		id: StripePayment,
		org: ClerkOrg,
		amount: Micros,
		debits: drawn(natural),
		spent: accumulated(Micros, toMicros(0n), microsKey)
	},
	["id"]
)
/** A debit pays for one call, by the gateway's request id. */
export const Debit = relation("Debit", { call: RequestId, grant: StripePayment, amount: Micros }, [
	"call"
])

/** A grant's debits, counted; their amounts summed into what it has spent. */
const grantDebits = counted(on(Debit, "grant"), fin(Grant, "debits"))

export const Credits = schema(
	"Credits",
	[Grant, Debit],
	[
		grantDebits,
		fold(grantDebits, Monoid.sum, on(Debit, "grant", "amount"), on(Grant, "id", "spent")),
		check("WithinGrant", Grant, (g) => g.le(g.spent, g.amount)),
		unit("Grant", { id: StripePayment }),
		mutable(Grant)
	]
)

export const Metering = role(Credits, "metering", wholeEntriesOf(Credits), { insert: ["Debit"] })

/** Debit a grant for one call: a transient refusal is the caller's to run again; grizzle never retries. */
export const debitGrant = ChangeSet.empty(Credits).insert(Debit, [])
export const metering = workload(Metering, { debitGrant })

export const spend = (
	db: Db<typeof Metering, typeof metering.programs>,
	debit: Fact<typeof Debit>
) => db.workload.debitGrant.once({ params: {}, facts: { insert: { Debit: [debit] } } })
```

**What you get.** The rule holds at commit, for every writer. A debit is written as its own row, `{ call, grant, amount }`, a `Fact<typeof Debit>`. `debits` and `spent` are grizzle's to draw, so no insert or put takes them. `grizzle generate` compiles the family, the fold and the check to PostgreSQL's own constraints, over hidden columns of each debit that grizzle fills on every write and no query reads; abridged:

```sql
CREATE TABLE "credits"."grant" (
  …
  "debits" "credits"."__domain_gfw43vigph" NOT NULL,
  "spent" "credits"."__domain_gfw43vigph" NOT NULL,
  …
  CONSTRAINT "__grant_check_grant_debits_sum_fold_to7egrdjpy" CHECK (("debits" > 0::bigint OR "spent" = 0::bigint) IS TRUE),
  CONSTRAINT "within_grant" CHECK (("spent" <= "amount") IS TRUE),
  CONSTRAINT "__grant_key_id_debits_4ie7odmi22" UNIQUE NULLS DISTINCT ("id", "debits")
);

ALTER TABLE "credits"."debit" ADD COLUMN "__after_debits_0_kkyetxwufq" bigint NOT NULL;

ALTER TABLE "credits"."debit" ADD COLUMN "__before_debits_0_7f5g7maxle" bigint NOT NULL;

ALTER TABLE "credits"."debit" ADD COLUMN "__copy_debits_t4kdfqgptg" bigint NOT NULL;

ALTER TABLE "credits"."debit" ADD COLUMN "__index_debits_mapi52ihot" bigint NOT NULL;

ALTER TABLE "credits"."debit" ADD CONSTRAINT "__debit_key_grant_index_debits_a3sm5262ii" UNIQUE NULLS DISTINCT ("grant", "__index_debits_mapi52ihot");

ALTER TABLE "credits"."debit" ADD CONSTRAINT "__debit_check_debit_counted_grant_debits_evjcz3nb5v" CHECK (("__index_debits_mapi52ihot" >= 0::bigint AND "__index_debits_mapi52ihot" < "__copy_debits_t4kdfqgptg") IS TRUE);

ALTER TABLE "credits"."debit" ADD CONSTRAINT "__debit_check_grant_debits_sum_fold_irognd552t" CHECK ((("__index_debits_mapi52ihot" > 0::bigint OR "__before_debits_0_7f5g7maxle" = 0::bigint) AND "__after_debits_0_kkyetxwufq"::numeric = "__before_debits_0_7f5g7maxle"::numeric + "amount"::numeric) IS TRUE);

ALTER TABLE "credits"."debit" ADD CONSTRAINT "__debit_fk_grant_copy_debits_izjnnom77r" FOREIGN KEY ("grant", "__copy_debits_t4kdfqgptg") REFERENCES "credits"."grant" ("id", "debits") MATCH SIMPLE ON UPDATE CASCADE;

ALTER TABLE "credits"."debit" ADD CONSTRAINT "__debit_fk_grant_predecessor_debits_before_debits_0_s7meik2v5k" FOREIGN KEY ("grant", "__predecessor_debits_qficmzynzz", "__before_debits_0_7f5g7maxle") REFERENCES "credits"."debit" ("grant", "__index_debits_mapi52ihot", "__after_debits_0_kkyetxwufq") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "credits"."grant" ADD CONSTRAINT "__grant_fk_id_pred_debits_spent_nfhty57aaq" FOREIGN KEY ("id", "__pred_debits_yizf6c6ueo", "spent") REFERENCES "credits"."debit" ("grant", "__index_debits_mapi52ihot", "__after_debits_0_kkyetxwufq") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
```

Each debit carries its slot among its grant's debits, a copy of the grant's count, and the running total before and after it. The UNIQUE and the CHECK on the slot hold a grant's slots to distinct values below its count. The fold's CHECK proves each running total is the one before it plus the amount, in exact arithmetic, from 0 at the first slot. The deferred foreign keys chain each debit's before to the after of the debit in the slot below (`__predecessor_debits_…`, a generated column, is the slot less one), and the grant's `spent` to its last debit's after.

The slot is a coordinate the proof counts by, never a multiplicity: a grant's debits are a set, one row per debit. There is no trigger, and a writer outside grizzle fills those columns as grizzle does or is refused ([Direct SQL access](#direct-sql-access)).

Every write is SERIALIZABLE: grizzle's transactions name their level, and a write below it on a grizzle table is refused, psql's included. Two calls that spend one grant both rewrite its count and total, so they can't both commit: one fails with a `transient` error that changed nothing, `retry: "safe"`. grizzle never retries on its own. `spend` runs the call again with `Effect.retry`, and the run sees the other's debit: it commits if the grant still covers it, and otherwise fails with an error you match on, never a message to parse:

```text
{
  kind: "refused",
  retry: "never",
  message: "the schema's laws refused the write",
  refused: {
    kind: "first",
    laws: [
      {
        law: { kind: "check", relation: "Grant", name: "WithinGrant" },
        id: "__grant_check_within_grant_ktgwkg3utk",
        by: { kind: "constraint", table: "grant", name: "within_grant" }
      }
    ]
  },
  witness: { kind: "unreported" }
}
```

`refused.laws` names rules as your schema states them, each entry's `law`, and is never empty. Here it is `first` and the witness `unreported`: `WithinGrant` reads `spent`, which grizzle fills on the grant from its debits, so the refused grant row is not one your ChangeSet states, and the check PostgreSQL tried first is all grizzle knows. A row check over a row you state names that row's key, and `every` rule of its table the row breaks ([Errors and outcomes](#errors-and-outcomes)).

### 6. Books that always balance

**The problem.** Double-entry bookkeeping: every journal entry's postings add up to zero. An entry is several rows, so no single row can say whether it balances.

**The Drizzle way.** A CHECK can't see other rows, and an ordinary trigger runs at the end of each statement, so an entry written in several statements fails halfway. It takes a deferred constraint trigger you write in PL/pgSQL, in a custom migration:

```sql
CREATE FUNCTION entry_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN e := OLD.entry_id; ELSE e := NEW.entry_id; END IF;
  IF (SELECT coalesce(sum(amount), 0) FROM posting WHERE entry_id = e) <> 0 THEN
    RAISE EXCEPTION 'entry % does not balance', e;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER entry_balances AFTER INSERT OR UPDATE OR DELETE ON posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION entry_balances();
-- and an UPDATE that moves a posting to another entry must check the old entry too
```

It runs once per posting row, each run summing the whole entry, and it lives outside the TypeScript schema, kept in step by review.

**The reframe.** Balance is a property of a group of rows: an aggregate over an entry's postings. That is the budget's shape again. Count the postings, fold their amounts into the entry's `total`, and check `total = 0`. A write is judged whole, one move from a lawful state to the next, so an entry written with its postings has no halfway state to check.

**The declaration.**

```ts
const AccountCode = str.regex("^[a-z][a-z_]{0,63}$")
/** A journal entry's reference, as the books number it. */
const EntryRef = str.regex("^JE-[0-9]{1,12}$")

export const Entry = relation(
	"Entry",
	{ id: EntryRef, memo: Prose, postings: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
export const Posting = relation(
	"Posting",
	{ entry: EntryRef, account: AccountCode, amount: pg.bigint },
	["entry", "account"]
)

/** An entry's postings, counted; their amounts summed into its total. */
const entryPostings = counted(on(Posting, "entry"), fin(Entry, "postings"))

export const Books = schema(
	"Books",
	[Entry, Posting],
	[
		entryPostings,
		fold(entryPostings, Monoid.sum, on(Posting, "entry", "amount"), on(Entry, "id", "total")),
		check("Balanced", Entry, (e) => e.eq(e.total, 0n))
	]
)
```

**What you get.** An entry goes in as its written row, `{ id, memo }`, and each posting as its own row naming its entry, in one ChangeSet. grizzle draws the count and the total from the postings, and `Balanced` reads the total, so a ChangeSet that leaves an entry unbalanced comes back `refused` on `Balanced`, and changes nothing. It compiles as the grant's rule does, to keys, CHECKs and foreign keys over the postings' hidden columns, and every writer meets it, psql included.

`Entry` is not `mutable`, so its postings are fixed once it is inserted: deleting one is a type error, and a correction is a reversing entry, as a ledger wants. The check states the bound: `e.eq(e.total, 0n)` is an exact total, and `i.eq(i.total, i.amount)` makes a total equal a column instead, as in "an invoice's lines add up to its amount".

### 7. States that carry their own data

**The problem.** An invoice is open, paid or void. A paid invoice has exactly one payment, with its charge id; a void one has a reason; an open one has neither. The payment provider's webhook may deliver one payment twice.

**The Drizzle way.** The usual model is nullable columns and CHECKs:

```sql
CREATE TYPE invoice_state AS ENUM ('open', 'paid', 'void');
CREATE TABLE invoice (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  state invoice_state NOT NULL,
  paid_charge_id text,
  void_reason text,
  CHECK ((state = 'paid') = (paid_charge_id IS NOT NULL)),
  CHECK ((state = 'void') = (void_reason IS NOT NULL))
);
```

Drizzle can declare those CHECKs with `check()`, in `` sql`…` ``, but the row type stays `{ state: "open" | "paid" | "void"; paidChargeId: string | null; voidReason: string | null }` in every state, so every reader narrows by hand. Moving the payment to a table of its own fixes the row type, but "a paid invoice has exactly one payment" then spans two tables: a deferred trigger, or STORED generated columns and deferred composite foreign keys like the ones below, written and kept in step by hand.

**The reframe.** A nullable column says "this value exists in some states". A state that carries data is one value of a sum: each state is an arm, and each arm holds exactly its own fields. Declare the state as a `variant` over a closed roster of its handles: the invoice holds one `state` value, which is `open`, `paid` by a charge, or `void` for a reason, and no other combination can be stated, in TypeScript or in the database. The roster is a closed relation, a fixed list of handles the database stores as data. Its states have no order, so it is `closed.unordered`: no state comes before another, and a comparison or an `orderBy` of states is a type error.

**The declaration.**

```ts
import { variant } from "@bjornpagen/grizzle"

export const InvoiceStatus = closed.unordered("InvoiceStatus", ["open", "paid", "void"])
/** An invoice, by Stripe's id of it. */
const StripeInvoice = str.regex("^in_[0-9A-Za-z]{1,64}$")
/** An invoice's state: open, paid by a charge, or void for a reason. */
export const InvoiceState = variant("InvoiceState", InvoiceStatus, {
	open: {},
	paid: { charge: StripeCharge },
	void: { reason: Prose }
})
export const Invoice = relation.generated(
	"Invoice",
	{ id: StripeInvoice, org: ClerkOrg, state: InvoiceState },
	["id"],
	(i) => ({ status: generated(closedId(InvoiceStatus), InvoiceState.tag(i.state)) })
)

export const Invoices = schema(
	"Invoices",
	[InvoiceStatus, Invoice],
	[unit("Invoice", { id: StripeInvoice }), mutable(Invoice)]
)

/** An invoice and its state, with what its state carries. */
export const invoiceCard = query(Invoices).rule((r) => {
	const { id, state } = v(Invoice, "invoice")
	return r
		.match(Invoice, { id, state })
		.where(r.eq(id, r.param("id", StripeInvoice)))
		.find({ id, state })
})

/** Pay an open invoice: its state becomes paid, holding the charge. */
export const pay = ChangeSet.empty(Invoices).put(
	Invoice,
	query(Invoices).rule((r) => {
		const { org } = v(Invoice, "invoice")
		return r.match(Invoice, { id: r.param("invoice", StripeInvoice), org, status: "open" }).find({
			id: r.param("invoice", StripeInvoice),
			org,
			state: InvoiceState.make("paid", { charge: r.param("charge", StripeCharge) })
		})
	})
)
```

**What you get.** `state` is one value of exactly one arm, and the types follow: `invoiceCard`'s row is

```text
{
  readonly id: string
  readonly state:
    | { readonly tag: "open" }
    | { readonly tag: "paid"; readonly charge: string }
    | { readonly tag: "void"; readonly reason: string }
}
```

so a reader narrows on `state.tag` and finds a paid invoice's charge right there, and a write states a paid state with its charge or not at all. `status` is the state's tag, generated from it: an ordinary closed id of `InvoiceStatus`, which a key, a filter or a law reads like any field, as `pay` does.

`pay` takes `{ invoice: string; charge: string }`. Its row is a query, and a query in a ChangeSet reads the state before the change, in the same transaction: that is how a write depends on a read, with no interactive transaction. `pay` reads the invoice and, if it was open, makes its state `paid` with the charge. On an invoice that isn't open its row is empty, so a webhook delivered twice answers `unchanged` the second time. `InvoiceState.make("paid", { charge })` is a value of one arm, made of terms.

A paid state without its charge, or a charge on an open invoice, is no value of `InvoiceState`: no write states it, and a direct writer's is refused by the state's domain, whoever writes it. In PostgreSQL, abridged from `grizzle generate`, the state is a composite of its tag, the arm's code, and every arm's fields, under a domain whose one CHECK holds the tagged arm's fields present, each judged by its own type, and every other arm's absent:

```sql
CREATE TYPE "invoices"."__invoice_state_row_cxey5gq3u5" AS ("tag" smallint, "__a1_charge_wbdzyzby2v" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8", "__a2_reason_ekhrddl4yb" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8");

CREATE DOMAIN "invoices"."invoice_state" AS "invoices"."__invoice_state_row_cxey5gq3u5" CONSTRAINT "check" CHECK (VALUE IS NULL OR (CASE (VALUE)."tag" WHEN 0::smallint THEN "pg_catalog"."num_nonnulls"((VALUE)."__a1_charge_wbdzyzby2v", (VALUE)."__a2_reason_ekhrddl4yb") = 0 WHEN 1::smallint THEN "pg_catalog"."num_nulls"((VALUE)."__a1_charge_wbdzyzby2v"::"invoices"."__text_exry3v3i7a") = 0 AND "pg_catalog"."num_nonnulls"((VALUE)."__a2_reason_ekhrddl4yb") = 0 WHEN 2::smallint THEN "pg_catalog"."num_nulls"((VALUE)."__a2_reason_ekhrddl4yb") = 0 AND "pg_catalog"."num_nonnulls"((VALUE)."__a1_charge_wbdzyzby2v") = 0 ELSE false END) IS TRUE);

CREATE TABLE "invoices"."invoice" (
  "id" "invoices"."__text_7ddtmraqex" NOT NULL,
  "org" "invoices"."__text_t2hbrv4zer" NOT NULL,
  "state" "invoices"."invoice_state" NOT NULL,
  "status" "invoices"."invoice_status" GENERATED ALWAYS AS (("state")."tag") STORED NOT NULL,
  CONSTRAINT "__invoice_pk_6v4xjquwn3" PRIMARY KEY ("id")
);
```

A state whose data is a relation of its own, one other tables refer to, is a sum of relations, not of values: keep the tag a field of its header, and mirror each arm relation with the header's rows of its tag, `mirrors(on(Payment, "invoice"), on(select(Invoice, (i) => i.eq(i.status, "paid")), "id"))`, so each paid invoice has exactly one payment and each payment's invoice is paid ([Variants](#variants)).

### 8. A usage page: windows, a rollup and their indexes

**The problem.** A usage page lists a workspace's calls newest first, 50 at a time, with next and previous links that stay correct while calls keep arriving, and a chart reads spend per model without scanning every call. Both must stay fast as the call log grows.

**The Drizzle way.** You write the keyset query and its cursor format, the rollup, and the indexes, and nothing ties them together:

```sql
-- the page after a cursor: the (at, id) of the last row shown, decoded from a string you encoded
SELECT id, model, at, cost FROM call
WHERE workspace_id = $1 AND (at, id) < ($2, $3)
ORDER BY at DESC, id DESC
LIMIT 51;  -- one extra row tells you whether there is a next page

CREATE INDEX call_by_workspace ON call (workspace_id, at DESC, id DESC);

SELECT count(*) AS calls, sum(cost) AS spend FROM call WHERE workspace_id = $1 AND model = $2;
CREATE INDEX call_by_workspace_model ON call (workspace_id, model);
```

The cursor format, the backward page and both indexes are yours, and an index that stops matching its query fails silently, as a slow page.

**The reframe.** Each piece follows from something you declare anyway. A page is a window of an ordered set, and its anchor a row's place in that order; the order is total once it ends in a key, which grizzle knows, so a row's key is its place. A rollup is a derived relation, a query with a name, and its key follows from its query. An index serves the queries that need it, so the queries your app runs decide the indexes:

- **`derived(name, query)`** names a query as a relation. Here it stores nothing, since `Usage` declares no unit its calls sit in (grizzle stores a derived relation exactly where its definition keeps within one unit: [Derived tables](#derived-tables)): a read of it reads its definition, here one workspace's calls of one model, a range of the index its read earns. `schema.extend` declares it in a level of its own over the schema it reads, here `Reporting` over `Usage`.
- **`workload(role, programs)`** names the queries and writes your app runs on its hot paths. A login owns its workloads: `grizzle generate` compiles them into the login's served file and derives the indexes they need. An ordered query your app pages is the member `paged(query)`: its input holds a `window`, and generate compiles window templates for no other member. A read answered once and never watched is the member `answered(read)`, whose login needs no live source for it ([Reading](#reading)).

**The declaration**, continuing the `Usage` schema of [case 2](#2-top-three-per-group-with-exact-types):

```ts
import { derived, paged, wholeEntriesOf, workload } from "@bjornpagen/grizzle"

/** A workspace's calls, newest first. */
export const callLog = query(Usage)
	.rule((r) => {
		const { id, model, at, cost } = v(Call, "call")
		return r
			.match(Call, { id, workspace: r.param("workspace", Workspace), model, at, cost })
			.find({ id, model, at, cost })
	})
	.orderBy(["at", "desc"])

/** Calls and spend per workspace and model: a derived relation, which every read of it reads through its definition. */
export const ModelSpend = derived(
	"ModelSpend",
	query(Usage).rule((r) => {
		const { id, workspace, model, cost } = v(Call, "call")
		return r
			.match(Call, { id, workspace, model, cost })
			.find({ workspace, model, calls: r.count(), spend: r.sum(cost) })
	})
)
export const Reporting = schema.extend([Usage], "Reporting", [ModelSpend], [])

export const Analyst = role(Reporting, "analyst", wholeEntriesOf(Reporting))

/**
 * One workspace's spend on one model: at most one row, since the rollup's key is (workspace, model). As a member of
 * the workload it is the index on Call's (workspace, model) that generate derives.
 */
export const modelSpend = query(Reporting).rule((r) => {
	const { calls, spend } = v(ModelSpend, "modelSpend")
	return r
		.match(ModelSpend, {
			workspace: r.param("workspace", Workspace),
			model: r.param("model", Title),
			calls,
			spend
		})
		.find({ calls, spend })
})

export const usage = workload(Analyst, {
	callLog: paged(callLog),
	modelSpend
})
export const UsageApi = login(Reporting, "usage_api", [Analyst], { workload: [usage] })
```

and the calls, on a Db of `Analyst` opened through `UsageApi`'s served file:

```ts
type AnalystDb = Db<typeof Analyst, typeof usage.programs>

/** Where a window of the log starts: its first calls, or after a call's key the client sent back. */
type CallAnchor = Parameters<AnalystDb["workload"]["callLog"]["once"]>[0]["window"]["anchor"]

/** The first 50 calls, and the 50 after a key the client sent back. */
export const firstCalls = (db: AnalystDb, workspace: string) =>
	db.workload.callLog.once({
		params: { workspace },
		facts: {},
		window: { anchor: { kind: "start" }, size: 50 }
	})
export const moreCalls = (db: AnalystDb, workspace: string, anchor: CallAnchor) =>
	db.workload.callLog.once({ params: { workspace }, facts: {}, window: { anchor, size: 50 } })

export const spendOn = (db: AnalystDb, workspace: string, model: string) =>
	db.workload.modelSpend.once({ params: { workspace, model }, facts: {} })
```

**What you get.**

- **Windows.** `once` answers a `KeyedList` of rows, `{ id, model, at, cost }` with `at` and `cost` the `bigint`s of their contracts' host types, in the query's order. Ties are broken by `id`, the row's key, which grizzle adds to the order, so `(at, id)` is each row's key: an entry's `key` is the anchor of the window after it, `{ kind: "after", key }`, and `{ kind: "end" }` and `{ kind: "before", key }` read backward. `{ kind: "at", position: 100 }` is the window after the order's first 100 calls, for a client that asks for page 3 of 50: its statement skips those 100 calls, so a key is the anchor to scroll by ([Reading](#reading)). A window is one statement of `size` rows: there are no cursors and no flags, and the window after the last row holding none is the end. `watch` keeps a window live: its rows change as writes change them.
- **The rollup.** `ModelSpend`'s key, `(workspace, model)`, follows from its query, so `modelSpend` returns at most one row: `spendOn` gives a set of at most one `{ calls: bigint; spend: Decimal }`. It is always current: it is the calls as they stand, read as one range of the index below, and no job keeps it.
- **The indexes.** `grizzle generate` derives one from the workload's `callLog` and one from `modelSpend`, whose read of `ModelSpend` reads `Call` at one workspace and one model:

```sql
CREATE INDEX "__call_ix_workspace_at_id_txjpwdbrfr" ON "usage"."call" USING btree ("workspace", "at", "id" DESC);
CREATE INDEX "__call_ix_model_workspace_54aly2la6z" ON "usage"."call" USING btree ("model", "workspace");
```

Change `callLog` so that it needs another index, and `grizzle check` refuses until you run `grizzle generate` again.

### Drizzle to grizzle, API by API

For porting an app, each Drizzle construct and what takes its place:

<details>
<summary>Drizzle → grizzle, API by API</summary>

| Drizzle                                                | grizzle                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `pgTable("post", { ... })`                             | `relation("Post", { ... }, ["org", "slug"])`; the third argument is the primary key            |
| `uuid("id").defaultRandom()`                           | the fields that identify the fact, or `contract<typeof key>()("ClerkUserId", uuid)` for another system's id |
| `.notNull()`                                           | every column; a value that may be missing is a row in a table of its own                        |
| `text()`, `varchar()`                                  | `str.regex(pattern)`: text always carries a pattern                                             |
| `integer()`, `bigint({ mode: "bigint" })`, `numeric()` | `pg.integer` (`number`), `pg.bigint` (`bigint`), `pg.numeric(p, s)` (an exact `Decimal`; a `bigint` at scale 0), `pg.numeric` (no typmod, a `Decimal`) |
| `pgEnum("status", [...])`                              | `closed.ordered("Status", [...])`, or `closed.unordered` where the order means nothing, with `closedId(Status)` for the column |
| `.references(() => post.id)`                           | `contained(on(Comment, "org", "post"), on(Post, "org", "slug"))`                                |
| `unique().on(t.show, t.holder)`                        | `key(on(Ticket, "show", "holder"))`                                                             |
| `` check("some_seats", sql`...`) ``                    | `check("SomeSeats", Show, (s) => s.ge(s.seats, 1n))`                                               |
| `index().on(...)`                                      | nothing: `grizzle generate` derives indexes from your rules and your `workload(...)` queries    |
| `pgPolicy(...)`, and `set_config` around each request  | `context(...)` and `role(...)`                                                                  |
| `pgMaterializedView(...)`                              | `derived(...)`, which grizzle stores where it can keep it at every COMMIT                       |
| `db.select().from(post).where(eq(post.id, id))`        | `query(Blog).rule((r) => r.match(Post, { ... }).where(r.eq(...)).find({ ... }))`                |
| `.innerJoin(comment, eq(comment.postId, post.id))`     | one variable in two matches                                                                     |
| `notExists(...)`                                       | `r.not(Comment, { org, post: slug })`                                                           |
| `count()`, `sum(...)`                                  | `r.count()`, a `natural`; `r.sum(x)`, exact (a `Decimal` for any integer)                       |
| `db.query.post.findMany({ with: { comments: true } })` | `.attach("comments", (post) => ..., "array")`                                                   |
| `.orderBy(...).limit(10)`                              | `.orderBy([...]).take(10)`, or a `paged(query)` member's windows, anchored at a row's key       |
| `db.insert(post).values(rows)`                         | `ChangeSet.empty(Blog).insert(Post, rows)`                                                      |
| `.onConflictDoUpdate(...)`, `db.update(post).set(...)` | `.put(Post, rows)`: after the change, the row at each key is the one given                      |
| `db.delete(post).where(...)`                           | `.delete(Post, rows)`, the rows given or read by a query                                        |
| `.returning()`                                         | `.read(name, (delta) => query)`                                                                 |
| `db.transaction(async (tx) => { ... })`                | one ChangeSet, a workload member, and its `apply`; a read that decides a write is a query inside it |
| `` sql`...` ``                                         | none at run time                                                                                |
| `drizzle-kit generate`, `migrate`, `check`             | `grizzle generate`, `grizzle migrate`, `grizzle check`                                          |
| `drizzle-kit push`                                     | none: every change is a migration you review                                                    |

</details>

## What grizzle builds

The whole map, from what you declare to what PostgreSQL enforces for every writer:

| You write | PostgreSQL gets |
| --- | --- |
| `relation(...)` | a table, every column NOT NULL, with its primary key, and a statement trigger that refuses any write below SERIALIZABLE, unless every writer of it is certified READ COMMITTED |
| `str.regex(...)`, `contract<typeof key>()(...)` | a domain whose CHECK every writer's value meets, one domain for each distinct definition |
| `closed.ordered(...)`, `closed.unordered(...)` | a smallint domain that admits only live handles' codes, checked against an IMMUTABLE function returning the roster's names as `name[]`; for a `bits(...)` field over the roster, a `bit(n)` domain that admits only live handles, n its codes rounded up to whole bytes |
| `closed.relation(...)` | no table: content-addressed IMMUTABLE constants for each closed relation or side a rule or query reads, and a table CHECK for each rule that reads one from an open row ([Closed relations](#closed-relations)) |
| a rule: `contained`, `key`, `check`, ... | a foreign key, unique key, no-overlap key or CHECK, over STORED generated columns where a side selects rows or reads `pred` |
| a rule over a derived relation | on each table its query reads, statement triggers that capture the rows each statement writes, and one deferred judge that runs the rule's violation query over them at COMMIT where the transaction wrote a relation it reads ([Rules over queries](#rules-over-queries)) |
| a family: `ordered`, `counted`, `tree`, `fold` | the drawn and accumulated fields grizzle fills on every write, hidden columns beside them, and the keys, CHECKs and foreign keys that prove each value it fills |
| `role(...)` | a NOLOGIN role, SELECT on the whole view of each table it holds whole (one view of each table, `__<schema>.<table>`, whichever roles hold it), a schema of its own holding its query entries' views, and its grants; on each table some role writes through a query entry that leaves rows out, row-level security and a policy for each role that writes it |
| `login(...)` | a LOGIN NOINHERIT role that can switch to its roles, holds no privilege on your tables, and pins the session settings grizzle's guarantees rest on |
| `workload(...)` | the indexes its programs need; the programs compiled by `grizzle generate` into the login's served file |
| `derived(...)` | where its definition is unit-local in one unit, a table grizzle keeps equal to its definition at every COMMIT, uniquely indexed on the keys it provably has; otherwise nothing, every query and rule over it reading its definition |
| a query | SQL, usually one statement and one more per attachment, and a decoder for its exact row type |

None of it is a trigger or a policy you keep in step by hand. Migrations are plain SQL files that `grizzle generate` drafts and you review, as with drizzle-kit.

## Install

You need PostgreSQL 19, Node 26 or later, and Effect 4.1. grizzle is tested on the official PostgreSQL 19.0 release, unpatched, as hosted providers build it; [PostgreSQL known issues](#postgresql-known-issues) says what 19 costs it. PostgreSQL 19.0 was released on 2026-11-19; until hosted providers offer 19, run the server yourself.

grizzle is not a package: you take this repository as a git submodule, pinned by commit, and add its four packages to your pnpm workspace: `@bjornpagen/grizzle`, the engine it re-exports, `@bjornpagen/grizzle-engine`, the writer and reader of a login's OpenAPI document it loads, `@bjornpagen/grizzle-openapi`, and the text package all three depend on, `@bjornpagen/grizzle-text`. Node runs grizzle's TypeScript source directly, so there is no build step, and `@bjornpagen/grizzle` and its subpaths resolve to the source with no export condition, in Node, TypeScript, Vite and Vitest alike.

```sh
git submodule add https://github.com/bjornpagen/grizzle.git vendor/grizzle
```

In `pnpm-workspace.yaml`, list the four packages, and give the catalog the versions their `catalog:` dependencies name (grizzle's own `pnpm-workspace.yaml` has the versions it is tested with):

```yaml
packages:
  - vendor/grizzle/packages/engine
  - vendor/grizzle/packages/grizzle
  - vendor/grizzle/packages/openapi
  - vendor/grizzle/packages/text
catalog:
  "@effect/platform-node": 4.1.2
  "@types/pg": 8.23.1
  arkregex: 0.0.14
  effect: 4.1.2
  pg: 8.23.1
```

Then depend on it from your package, beside its peers:

```json
"dependencies": {
	"@bjornpagen/grizzle": "workspace:*",
	"effect": "4.1.2",
	"pg": "8.23.1"
}
```

Import it as `@bjornpagen/grizzle`, `@bjornpagen/grizzle/runtime`, `@bjornpagen/grizzle/compile`, `@bjornpagen/grizzle/dynamic`, `@bjornpagen/grizzle/client`, `@bjornpagen/grizzle/http` and `@bjornpagen/grizzle/locks`. `@bjornpagen/grizzle` is the authoring entry: the builders a schema, its logins and its workloads are written with, `defineConfig` and `CredentialError`, and nothing that compiles or runs them, so a schema module or a `grizzle.config.ts` loads no compiler. A running application imports `@bjornpagen/grizzle/runtime` (`served`, `DbLayer`, `LiveSource`, `Db`, every runtime error, `roleNameOf`); a test that reads a schema's compile on the host imports `@bjornpagen/grizzle/compile` (`compileServed`, `plannedQueriesOf`, `indexesOf`, `lawsOf`, `lawsByStatement`, `constraintNamesOf`, `installedIdentifiersOf`, `rowEvaluator`, `insertPreview`, `factsDecoder`, `codecText`, `rowText`). `pnpm exec grizzle` runs the command line from `src/cli/bin.ts`, which turns on Node's compile cache before it loads the rest. To upgrade, move the submodule to a newer commit and run `pnpm install`.

The agent guide is `vendor/grizzle/packages/grizzle/skills/grizzle/SKILL.md`: copy it to where your agent reads skills, and again after upgrading grizzle.

To build grizzle's pinned PostgreSQL ([Development](#development)), add `vendor/grizzle/packages/pg` to the workspace too, and `@bjornpagen/grizzle-pg` (`workspace:*`) to your package's devDependencies. Its dependencies come from your install, so never run `pnpm install` inside `vendor/grizzle`: that gives grizzle a second copy of `effect`, and a `Redacted` made by one copy is unreadable by the other ("Unable to get redacted value"). Then `pnpm exec grizzle-pg build`, and `pnpm exec grizzle-pg source` for its source tree. A cluster of the build is the toolchain's testing library's: state it in your package's `pg.config.ts` and settle it with `toolchain-pg settle`, which runs its members as the workbench's PostgreSQL units. The pin those commands build, `scripts/pg/pin.env`, is also a typed value: `import { pin } from "@bjornpagen/grizzle-pg/pin"` gives every assignment by its name (`pin.PG_PIN_VERSION`, `pin.PG_PIN_SHA256`, `pin.GRIZZLE_PG_PREFIX`), parsed from the same file the scripts source; a pin.env that does not parse fails the import.

In full:

- **Peer dependencies.** `effect` 4.1.2 or a later 4.x, and `pg` (node-postgres) 8.23.1 or a later 8.x: install one copy of each beside grizzle. grizzle imports no driver: you pass the `pg` you import as each connection's `driver`, and a `pg` without pipeline mode, which every call's one round trip needs, is a type error there. `@types/pg`, where TypeScript reads `pg`'s types, is an optional peer.
- **TypeScript.** Your tsconfig typechecks grizzle's source as part of your program, so it needs `allowImportingTsExtensions` (grizzle's modules import each other by their `.ts` paths) and `moduleResolution` `nodenext` or `bundler`, which read the packages' `exports` and `imports`. grizzle's own tsconfigs extend only files inside its repository, so a tool that reads the nearest tsconfig of each module, as Vite does, needs nothing else of yours.
- **A refusal beside a TypeScript error.** A grizzle refusal reported beside a TypeScript error at its source, such as TS2552 or TS2304 (a name no module declares), is that error's cascade: the unresolved name reads as `any`, and a check downstream of it can no longer read what it states. Fix the first TypeScript error.
- **Hardened Node.** grizzle runs under `--disable-proto=delete` and `--disable-sigusr1`: it never touches `Object.prototype.__proto__`, the `grizzle` command starts with both flags, and every test runs under both.
- **The database.** UTF8 with the builtin `C.UTF-8` locale, on a server host that has the `C.UTF-8` operating-system locale. `btree_gist` must be available; a migration creates it when a no-overlap key or a coverage rule needs it. pgvector 0.8.7 is needed only for vector fields; it is not a trusted extension, so a superuser creates `vector` first where the migration role cannot.
- **`pg_plan_advice` in every session.** grizzle carries each statement's proven plan to PostgreSQL as plan advice, which PostgreSQL 19's contrib module `pg_plan_advice` enforces; without the library loaded, PostgreSQL ignores the advice silently and plans by its own costs. A superuser loads it once, for the database (`ALTER DATABASE <db> SET session_preload_libraries = 'pg_plan_advice'`, read by each new session) or for the server (`shared_preload_libraries = 'pg_plan_advice'`, a restart); never on a role, whose own settings are drift. It has no extension to create. `grizzle migrate` refuses a session that has not loaded it before anything runs (stage `advice`), and every transaction of a Db checks first and fails with `AdviceUnloaded` before any statement. Leave `pg_plan_advice.feedback_warnings` off, its default.
- **A migration role that owns the database.** It owns the schema and the database, and has CREATEROLE to create the PostgreSQL roles of your logins and roles. It needs no superuser. A role without CREATE on the database fails the first migration with 42501 ("permission denied for database") at its first statement, the CREATE SCHEMA of the installed schema: the database's owner holds CREATE on it, and another role only where it is granted. A migration that creates `btree_gist`, a trusted extension, needs it too. It also holds `pg_signal_backend` (`GRANT pg_signal_backend TO <migration role>`, which a superuser gives, or a role holding it WITH ADMIN): a migration that drops a role first ends the sessions holding that role's temporary tables ([Deploying](#deploying)), and PostgreSQL lets a role end a session only where it holds the privileges of the session's login or pg_signal_backend's. Without it, such a migration fails with 42501 ("permission denied to terminate process") and rolls back, as it fails with 2BP01 when nothing ends them.
- **A password for each login role**, which you set, or, for RDS IAM authentication, membership in `rds_iam`, and one for the installation's decoder login where a login serves a read: the role a reading login's served file names, `roleNameOf(WebServed.decoder, connection)` ([Connecting](#connecting)). Each connection authenticates with exactly the password its configuration names: node-postgres never reads `PGPASSWORD` or `~/.pgpass` for one.
- **TLS with verify-full**, the only mode. Plaintext is refused.
- **A direct connection.** PgBouncer is not supported.
- **`max_pred_locks_per_transaction = 2048`**, recommended: a server-start setting, about 115 MB of shared memory at 200 connections. SERIALIZABLE writes and reads take predicate locks.

## Upgrading

### A contract's values are its consumer's

`contract(name, base, …)` is gone, with no alias, and no contract is callable: a contract's values come from its
consumer's key ([Tables and types](#tables-and-types)). A caller makes each change below; the SQL is byte-identical,
since only the types and the host's spelling of a value change.

- `const X = contract("X", base, …)` → `const xKey = Symbol("X")` beside `const X = contract<typeof xKey>()("X", base, …)`,
  one key per contract, held by the module that declares it.
- `X(value)` → `toX(value)` beside `const toX = mintOf(xKey)`, in the module that holds the key, which exports the mint
  only to the modules that make values; an initial value and a closed relation's row are minted alike.
- Every place the database or grizzle makes a value of X takes the key too: `Type.cast(x, X)` → `Type.cast(x, X, xKey)`,
  `drawn(X)` → `drawn(X, xKey)`, `accumulated(X, start)` → `accumulated(X, toX(0n), xKey)`, a clock bound to a
  parameter of X, `clocked(program, { now: "millis" })` → `clocked(program, { now: "millis" }, { now: xKey })`, and a
  declared function whose result holds X, `fn(name, definition)` → `fn(name, definition, { X: xKey })`. A contract over
  another takes every key of its chain, its own first, `Type.cast(x, Outer, outerKey, centsKey)`, and is declared under a
  key apart from its base's. A contract named `natural` is refused, as one named `instant` is.
- A value's type, `base & Brand.Brand<"X">`, is `Marked<base, typeof xKey>`, still `Infer<typeof X>`: a value
  `Schema.brand("X")` decodes is no value of it, so decode the base and mint it.
- A typed constant of a contract and a conditional's other arm beside a contract's term take a minted value,
  `Type.literal(X, toX(5n))`; a value compared with a contract's term stays the base's.
- A function over a contract's term types it by the contract's domain and its values apart,
  `Term<DomainOf<typeof X>, unknown, InputOrigin, Sql, Infer<typeof X>>`, since the two are no longer one type.

### Compute became the scalar namespaces

`Compute` is gone, with no alias: its members live in eleven namespaces, each named for the domain its members read ([Scalar terms](#scalar-terms)). A caller replaces each `Compute.<member>` below and imports the namespaces it now reads in place of `Compute` (`import { Logic, Num, Text } from "@bjornpagen/grizzle"`); a binding of its own named like one of them, a field type `Text` say, is renamed or the import aliased. Nothing else changes: every term, its type and its SQL are the same, so the generated SQL is byte-identical.

- `Compute.literal` → `Type.literal`
- `Compute.base` → `Type.base`
- `Compute.cast` → `Type.cast`
- `Compute.add` → `Num.add`
- `Compute.sub` → `Num.sub`
- `Compute.mul` → `Num.mul`
- `Compute.div` → `Num.div`
- `Compute.mod` → `Num.mod`
- `Compute.neg` → `Num.neg`
- `Compute.quot` → `Num.quot`
- `Compute.rem` → `Num.rem`
- `Compute.abs` → `Num.abs`
- `Compute.sign` → `Num.sign`
- `Compute.round` → `Num.round`
- `Compute.trunc` → `Num.trunc`
- `Compute.ceil` → `Num.ceil`
- `Compute.floor` → `Num.floor`
- `Compute.gcd` → `Num.gcd`
- `Compute.lcm` → `Num.lcm`
- `Compute.power` → `Num.power`
- `Compute.sqrt` → `Num.sqrt`
- `Compute.widthBucket` → `Num.widthBucket`
- `Compute.minScale` → `Num.minScale`
- `Compute.numeric` → `Num.numeric`
- `Compute.floatBits` → `Num.floatBits`
- `Compute.nonzero` → `Num.nonzero`
- `Compute.nonnegative` → `Num.nonnegative`
- `Compute.positive` → `Num.positive`
- `Compute.isFinite` → `Num.isFinite`
- `Compute.within` → `Num.within`
- `Compute.cond` → `Logic.cond`
- `Compute.when` → `Logic.when`
- `Compute.not` → `Logic.not`
- `Compute.and` → `Logic.and`
- `Compute.or` → `Logic.or`
- `Compute.eq` → `Logic.eq`
- `Compute.ne` → `Logic.ne`
- `Compute.lt` → `Logic.lt`
- `Compute.le` → `Logic.le`
- `Compute.gt` → `Logic.gt`
- `Compute.ge` → `Logic.ge`
- `Compute.between` → `Logic.between`
- `Compute.in` → `Logic.in`
- `Compute.least` → `Logic.least`
- `Compute.greatest` → `Logic.greatest`
- `Compute.lower` → `Range.lower`
- `Compute.upper` → `Range.upper`
- `Compute.width` → `Range.width`
- `Compute.charLength` → `Text.charLength`
- `Compute.octetLength` → `Text.octetLength`
- `Compute.utf16Length` → `Text.utf16Length`
- `Compute.concat` → `Text.concat`
- `Compute.startsWith` → `Text.startsWith`
- `Compute.endsWith` → `Text.endsWith`
- `Compute.pattern` → `Text.pattern`
- `Compute.matches` → `Text.matches`
- `Compute.translate` → `Text.translate`
- `Compute.lowerAscii` → `Text.lowerAscii`
- `Compute.replaceWhitespace` → `Text.replaceWhitespace`
- `Compute.collapse` → `Text.collapse`
- `Compute.resolveReference` → `Text.resolveReference`
- `Compute.parseDouble` → `Text.parseDouble`
- `Compute.parseDecimal` → `Text.parseDecimal`
- `Compute.xsdPattern` → `Xml.pattern`
- `Compute.isXsdPattern` → `Xml.isPattern`
- `Compute.sha256` → `Crypto.sha256`
- `Distance.cosine` → `Distance.cosine`
- `Search.websearch` → `Search.websearch`
- `Compute.plainQuery` → `Search.plain`
- `Search.matches` → `Search.matches`
- `Compute.textRank` → `Search.rank`
- `Compute.textRankCd` → `Search.rankCd`
- `Compute.union` → `Bits.union`
- `Compute.intersection` → `Bits.intersection`
- `Compute.difference` → `Bits.difference`
- `Compute.cardinality` → `Bits.cardinality`
- `Compute.subset` → `Bits.subset`
- `Compute.disjoint` → `Bits.disjoint`
- `Compute.singleton` → `Bits.singleton`
- `Compute.call` → `Fn.call`
- `Compute.rowsOf` → `Fn.rows`
- `Compute.rowOf` → `Fn.row`

## Effect, briefly

grizzle is built on [Effect](https://effect.website) 4. Opening a database, reading and writing return `Effect` values: lazy descriptions of work whose success and failure types are part of their type. Inside `Effect.gen(function* () { ... })`, `yield*` runs one and gives you its result. At the edge of your app, a `ManagedRuntime` built from grizzle's layer runs them: `runtime.runPromise(effect)` returns a Promise.

The example also uses `Effect.map`, `flatMap`, `mapError`, `promise`, `tryPromise` and `retry`, whose names say what they do; `Config`, which reads an environment variable each time it runs (`Config.Redacted` as a `Redacted`, which never prints its value); and `Schema`, which decodes a request body.

## Example

A blog behind Clerk: signed-out readers, signed-in members who write in their active organization, and a nightly job that loads view counts. It continues the blog schema at the start of this page and puts the cases' pieces together: contexts and roles from [case 1](#1-every-organization-sees-only-its-own-rows), a workload and its derived indexes from [case 8](#8-a-usage-page-windows-a-rollup-and-their-indexes), typed outcomes, and a retry of a `transient` error as in [case 5](#5-a-budget-no-burst-of-requests-can-overdraw). Each block below is the same module and imports only what it adds, and the test suite typechecks every line.

### Who is asking

```ts
import { context } from "@bjornpagen/grizzle"

/** Clerk's session token: the user in `sub`, the active organization's id in the nested object `o`. */
export const Session = context("Session", { sub: ClerkUser })
export const Org = context("Org", { id: ClerkOrg }, { claim: "o" })
```

A `context` is a claim of the verified session token, which queries read as a table of at most one row. `Session` reads `sub` from the token's top level, and `Org` reads `id` from its nested object `o`. A signed-in user outside any organization has a `Session` row and no `Org` row; a signed-out visitor has neither.

A claim is typed like a column. When a `Db` opens, PostgreSQL judges `sub` against `ClerkUser`'s pattern, and a token whose `sub` is not a Clerk user id is refused at stage `token`.

### What each kind of user sees

```ts
import { role } from "@bjornpagen/grizzle"

export const published = query(Blog).rule((r) => {
	const { org, slug, title, body } = v(Post, "post")
	return r
		.match(Post, { org, slug, title, body, status: "Published" })
		.find({ org, slug, title, body })
})

/** A member reads every published post, and every post of their active organization. */
export const memberPosts = query(Blog)
	.rule((r) => {
		const { org, slug, title, body } = v(Post, "post")
		return r
			.match(Post, { org, slug, title, body, status: "Published" })
			.find({ org, slug, title, body, status: Status.handle("Published") })
	})
	.rule((r) => {
		const { org, slug, title, body, status } = v(Post, "post")
		return r
			.match(Post, { org, slug, title, body, status })
			.match(Org, { id: org })
			.find({ org, slug, title, body, status })
	})

/** The member's own posts in their active organization; an insert fills `author` and `org` from the token. */
export const myPosts = query(Blog).rule((r) => {
	const { org, slug, author, title, body, status } = v(Post, "post")
	return r
		.match(Post, { org, slug, author, title, body, status })
		.match(Session, { sub: author })
		.match(Org, { id: org })
		.find({ slug, title, body, status })
})

export const comments = query(Blog).rule((r) => {
	const { org, post, author, at, body } = v(Comment, "comment")
	return r
		.match(Comment, { org, post, author, at, body })
		.match(Post, { org, slug: post, status: "Published" })
		.find({ org, post, author, at, body })
})

export const myComments = query(Blog).rule((r) => {
	const { org, post, author, at, body } = v(Comment, "comment")
	return r
		.match(Comment, { org, post, author, at, body })
		.match(Session, { sub: author })
		.match(Post, { org, slug: post, status: "Published" })
		.find({ org, post, at, body })
})

export const postKeys = query(Blog).rule((r) => {
	const { org, slug } = v(Post, "post")
	return r.match(Post, { org, slug }).find({ org, slug })
})

export const AnonBlog = role(Blog, "anon", { Status, Post: published, Comment: comments })
export const MemberBlog = role(
	Blog,
	"member",
	{ Status, Post: memberPosts, MyPost: myPosts, Comment: comments, MyComment: myComments },
	{ write: ["MyPost", "MyComment"], contexts: [Session, Org] }
)
export const Etl = role(Blog, "etl", { Post: postKeys, PostViews }, { write: ["PostViews"] })
```

A `role` is what one kind of user sees, laid out as tables. Each entry is a table or roster of `Blog`, whole (`Status`), or a query over `Blog` (`Post: published`), `write` lists the entries the role may write, and `contexts` the contexts its token's claims carry, which its entries and programs match.

- `anon` reads published posts and their comments.
- `member` reads published posts and every post of its active organization. `memberPosts` has two rules, and a query with several rules returns the rows of all of them; `Status.handle("Published")` puts that constant in the first rule's rows, so both rules return the same columns. `myPosts` matches `Session` and `Org`, which `member` declares, so it keeps the posts whose `author` is the signed-in user and whose `org` is the active organization. Inserting into `MyPost` fills `author` and `org` from the token, and a post `myPosts` would not return is refused. `MyComment` works the same way, on published posts only.
- `etl` reads each post's organization and slug, never a title or a body, and writes `PostViews`.

grizzle installs each role as a PostgreSQL role that reads through views in a schema of its own, one for each entry but the roster. `MyPost` and `MyComment` leave rows out, so `Post` and `Comment` get row-level security with a policy for `member`; `PostViews`, which `etl` writes whole, needs none, and its grants decide. A filter forgotten in app code cannot leak a row, because the filter is not in app code: PostgreSQL applies it to every statement.

### The app's queries and its logins

```ts
import { ChangeSet, login, workload } from "@bjornpagen/grizzle"

const { Post: AnonPost } = AnonBlog.relations
const { Post: MemberPost, MyPost } = MemberBlog.relations

/** The feed each kind of user reads; the rows of both are { readonly org: string; readonly slug: string; readonly title: string }. */
export const anonFeed = query(AnonBlog).rule((r) => {
	const { org, slug, title } = v(AnonPost, "anonPost")
	return r.match(AnonPost, { org, slug, title }).find({ org, slug, title })
})

export const memberFeed = query(MemberBlog).rule((r) => {
	const { org, slug, title } = v(MemberPost, "memberPost")
	return r.match(MemberPost, { org, slug, title }).find({ org, slug, title })
})

/** A member's draft post: each call gives its fact, whose `author` and `org` the insert fills from the token. */
export const draft = ChangeSet.empty(MemberBlog).insert(MyPost, [])

/** The ETL job's view counts: each call gives the counts it puts. */
export const recordViews = ChangeSet.empty(Etl).put(PostViews, [])

export const anonReads = workload(AnonBlog, { anonFeed })
export const memberReads = workload(MemberBlog, { memberFeed })
export const memberWrites = workload(MemberBlog, { draft })
export const etlWrites = workload(Etl, { recordViews })

export const Web = login(Blog, "web", [AnonBlog, MemberBlog], {
	workload: [anonReads, memberReads, memberWrites]
})
export const EtlJob = login(Blog, "etl_job", [Etl], { workload: [etlWrites] })
```

A query for a role is written over the role and sees only what the role sees: `MemberPost` is already the member's filtered view of posts, so `memberFeed` has no filter to forget.

A `workload` names the queries and writes your app runs. `grizzle generate` compiles them, for every role of their login, derives the indexes they need and records them in the snapshot, and commits each login's compiled programs as `migrations/blog/served/<login>.json`: the app serves that file and compiles nothing, so a program that does not compile is refused by generate, never by the app. Edit `memberFeed` so that it needs another index, and `grizzle check` refuses until you run `grizzle generate` again: the index ships in the same migration as the query that needs it. One index serves an equality lookup when it is led by a column the lookup fixes that holds many values and holds the lookup's other columns after it, so an index on `(account, flagged, tenant)` serves a lookup by `account` and `tenant`; where the columns between, here `flagged`, are booleans or closed ids, PostgreSQL reads it by a skip scan over their few values, within `account`'s rows.

A served member's handle, `db.workload.memberFeed`, is a `MemberHandle<typeof memberFeed>`: `once` and `watch`, with `explain` and `explainAnalyze` beside them, without the role it runs on, which none of them reads. A function written over `MemberHandle<typeof program>` takes the handle of that program from any login whose workload serves it, a login over a level and one over a level that extends it alike, and refuses a handle of any other program.

A `login` is one PostgreSQL user, the one `roleNameOf(Web, {})` names (here `blog__web`), with its password and its own connection pool, that can act as the roles it lists. The login is the trust boundary: whoever holds its password can act as any of its roles, with any claims. So the web app and the nightly job get separate logins, and no token sent to the web app can make it write view counts.

### Connecting

```ts
import net from "node:net"
import { CredentialError } from "@bjornpagen/grizzle"
import { DbLayer, LiveSource, served, TokenRefused } from "@bjornpagen/grizzle/runtime"
import { verifyToken } from "@clerk/backend"
import { Config, Effect, Layer } from "effect"
import pgDriver from "pg"
import etlJobFile from "./migrations/blog/served/etl_job.json" with { type: "json" }
import webFile from "./migrations/blog/served/web.json" with { type: "json" }
import type { EtlJob, Web } from "./schema.ts"

declare const caPem: string

const clerkJwtKey = Config.String("CLERK_JWT_KEY")

const connection = {
	driver: pgDriver,
	transport: {
		kind: "sslRequest",
		host: "db.internal",
		port: 5432,
		open: () => new net.Socket(),
		ca: caPem,
		servername: "db.internal"
	},
	database: "app"
} as const

/** The web login's committed workload, served as its type: the app evaluates no schema module. */
export const WebServed = served<typeof Web>(webFile, "web")

/** The installation's live source, once per process: its decoder login's credential, and a login that reads. */
export const BlogLive = LiveSource.layer({
	...connection,
	login: WebServed,
	password: Config.Redacted("BLOG_DECODER_PASSWORD").pipe(
		Effect.mapError((cause) => new CredentialError({ cause }))
	)
})

export const WebLayer = DbLayer.make({
	...connection,
	login: WebServed,
	password: Config.Redacted("BLOG_WEB_PASSWORD").pipe(
		Effect.mapError((cause) => new CredentialError({ cause }))
	),
	pool: { max: 10 },
	verify: (token) =>
		clerkJwtKey.pipe(
			Effect.mapError((cause) => new TokenRefused({ cause })),
			Effect.flatMap((jwtKey) =>
				Effect.tryPromise({
					try: () => verifyToken(token, { jwtKey, authorizedParties: ["https://blog.example"] }),
					catch: (cause) => new TokenRefused({ cause })
				})
			)
		)
}).pipe(Layer.provide(BlogLive))
```

`DbLayer.make` builds one login's connection pool, which serves every role of the login. It takes the login's served workload and the connection. `served<typeof Web>(webFile, "web")` serves the file `grizzle generate` commits for the login ([Migrating and deploying](#migrating-and-deploying)), the one thing the app loads of its schema, as the login's type: `Web` is imported with `import type`, so no schema module runs in the app, and the name is the login's, which the layer checks the file against. The app imports grizzle from `@bjornpagen/grizzle/runtime`, which loads none of its compiler. The connection:

- `driver`: the `pg` you import.
- `transport`: how each connection reaches the server. `open` makes a new, unconnected socket, which pg connects to `host` and `port`; then come an SSLRequest and verify-full TLS over the socket, the server's certificate chained to `ca` and naming `servername`. `host` is a name or an IP address, never a Unix socket's path, since PostgreSQL offers no TLS over one. A tunnel connects to its local end and names the server it reaches. A CancelRequest opens its own connection the same way.
- `password`: a `Redacted`, or an Effect that yields one for each new connection, so a rotated credential needs no restart.
- `rolePrefix`, optional: the installation's, when two installations of the schema share a cluster, each login's and role's PostgreSQL role `<rolePrefix>__<stem>` ([Migrations](#migrations)); without it, each role is its stem, the name `grizzle generate` committed. The same prefix as the installation's `grizzle.config.ts` connection, used verbatim: `qti_pie_v2` makes `qti_pie_v2__blog__web`.
- `pool`: at most `max` sessions open. None is opened before a call asks for one, and each is kept open once opened, for the layer's life: grizzle closes no session for being idle, so a session's connection and its first plan of each statement are paid once, never again after a pause between requests. A call takes the idle session released last, so calls one after another run on one session.

A login whose roles read the token also needs `verify`, your function from a bearer token to its verified payload: here, Clerk's `verifyToken`, which judges a token by its key alone, so its every failure is a `TokenRefused`. A verifier that calls a service fails with `VerifierUnavailable` where the service gives no answer, so the caller retries an outage and never reads it as a refused token.

A login whose workloads serve a read requires its installation's live source, `LiveSource.layer`, which its type states: the `DbLayer` of `Web` is a layer that needs `BlogLive`, and the program does not compile until it is provided. Build it once per process for the installation and provide it to every such layer, so one process holds one of it however many logins it serves. It takes the connection of the installation's decoder login, the one login `grizzle migrate` grants REPLICATION, whose `password` is that login's credential, and any served login of the installation that reads. The served login names that decoder login, `WebServed.decoder`, its PostgreSQL role `roleNameOf(WebServed.decoder, connection)`, which the layer logs in as. Its type is the login's: a `DecoderLogin` for `Web`, whose type proves it serves a read, which `roleNameOf` takes as it is; `{ kind: "none" }` for `EtlJob`, whose type proves it serves none and whose live source reads no credential; and either, narrowed by `kind`, for a login whose type cannot tell, `AnyLogin` among them. It connects nothing until a Db's first `watch`; from then on, for its scope, it holds one listening session of the decoder login and the process's candidacy for the installation's live leader, which streams the committed changes of the tables live reads read from the installation's replication slot and fans out which rows they touched, sealed under the installation's secret. These serve every watch alike, so they run under the services the live source was built with, outside the span it was built in, and never under the first watch's: no request's trace holds them, and a request's own calls are traced under its own span. A `watch` made before the slot stands, a fresh installation's first ones, waits for it: the leader makes the slot, which PostgreSQL holds back until every transaction that holds a transaction id at its start has ended, then fans out `:stands`, and each waiting read checks the slot once more. `EtlJob` serves no read, so its layer needs no live source. A login whose type hides its workloads, `AnyLogin` among them, requires one too, since its type cannot prove it reads nothing; providing a source no layer uses is legal. Every watch ends with `stale` when the installation is migrated: the leader decodes the migration's ledger row and fans out a version notice, so a read of closed relations alone, whose rows only a migration changes, needs the live source too.

A live source decodes the WAL, which PostgreSQL 19 does at its default `wal_level = replica`, turning logical decoding on by itself when the leader makes the source's slot and off again after the server's last logical slot is dropped, or at `logical`; `grizzle migrate` refuses an installation with a live source on a server at `minimal` (`WalLevelMinimal`) before any statement runs. On Amazon RDS, `wal_level` follows `rds.logical_replication`; whether RDS lets PostgreSQL 19 turn logical decoding on with it off is unverified.

grizzle sets no `max_slot_wal_keep_size`, since how much WAL the slot may hold while no leader runs is the operator's policy, and a slot the server invalidates fails closed: the next leader fans out `:invalidated` with the WAL position it read, which ends every live read registered over a slot that stood at or before that position, and none over the slot it then makes.

The decoder login, the publication and the slot are named by the name grizzle derives for the installation's live source, and the snapshot records it. `grizzle roles` and `grizzle uninstall` read the decoder login by the name its level's schema derives.

grizzle states no number of its own, and there is no isolation level, statement timeout or retry policy to set. A call waits for a session as long as you let it: the wait has no deadline, and interrupting the Effect, your own timeout among the ways, ends it, leaving nothing behind. Closing the layer's scope ends its pool: a session in use is destroyed at once, and each idle one is sent a Terminate and waited for until its server closes the connection, which PostgreSQL does only once the backend has exited, its session's temporary tables dropped (the rule judge's deltas, seconds for a session that wrote many tables). So once the release returns no backend of the pool remains, and the database can be dropped at once; `grizzle migrate`'s own session ends the same way, so a database it migrated can be dropped as soon as it returns. That wait has no deadline either: interrupting the release ends it and destroys every connection still open.

### The route handler

```ts
import { Db } from "@bjornpagen/grizzle/runtime"
import { ManagedRuntime, Schema } from "effect"

/** A post's slug, checked as the schema's Slug checks it: lowercase letters, digits and hyphens. */
const PostSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,96}$/))

/** The client names a draft's slug, so a POST sent twice inserts it once. */
const Draft = Schema.Struct({ slug: PostSlug, title: Schema.String, body: Schema.String })

const web = ManagedRuntime.make(WebLayer)
const bearer = (request: Request) =>
	/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]

/** app/posts/route.ts: one Db per request, as the role the request's session gets. */
export const GET = (request: Request): Promise<Response> => {
	const token = bearer(request)
	const feed = Effect.gen(function* () {
		if (token === undefined) {
			const db = yield* Db.open(WebServed.roles.anon, {})
			return [...(yield* db.workload.anonFeed.once({ params: {}, facts: {} }))]
		}
		const db = yield* Db.open(WebServed.roles.member, { token })
		return [...(yield* db.workload.memberFeed.once({ params: {}, facts: {} }))]
	})
	return web.runPromise(Effect.map(feed, (rows) => Response.json(rows)))
}

export const POST = (request: Request): Promise<Response> => {
	const token = bearer(request)
	const posted = Effect.gen(function* () {
		if (token === undefined) {
			return 401
		}
		const post = yield* Effect.flatMap(
			Effect.promise(() => request.json()),
			Schema.decodeUnknownEffect(Draft)
		)
		const db = yield* Db.open(WebServed.roles.member, { token })
		return yield* db.workload.draft
			.once({ params: {}, facts: { insert: { MyPost: [{ ...post, status: "Draft" }] } } })
			.pipe(
				Effect.map((outcome) => (outcome.kind === "accepted" ? 201 : 200)),
				Effect.catchIf(
					(error) => error.kind === "outsideWorld" || error.kind === "refused",
					(error) => Effect.succeed(error.kind === "outsideWorld" ? 403 : 409)
				)
			)
	})
	return web.runPromise(Effect.map(posted, (status) => new Response(null, { status })))
}
```

`Db.open(role, { token })` opens a database handle as one role, for one request, contacting nothing: each call is one round trip. The types follow the roles: `Db.open(WebServed.roles.member, ...)` does not compile without a token, `Db.open(WebServed.roles.anon, {})` needs none, and each handle's `db.workload` holds exactly its login's workload programs for its role, compiled by `grizzle generate` and loaded when the layer was built. The draft is a member of the member role's workload, and each request gives its row as the call's facts. The handler meets Clerk's three states:

- **Signed out.** No token: the handler opens `anon` and returns published posts.
- **Signed in, no organization.** The token has `sub` and no `o`, so `Session` has a row and `Org` has none. The feed is the published posts, and a draft comes back `outsideWorld`: there is no organization to fill `org` from, so the post is not one `MyPost` can hold.
- **In an organization.** The feed adds the organization's drafts, and a draft is inserted with the user and the organization filled in.

`once` runs the ChangeSet and answers with its outcome, `accepted`, or `unchanged`, here the same draft posted again, since the client names its slug and a table holds a row once; or it fails with `outsideWorld`, a row the role may not write, or `refused`, a rule said no, naming the rule and the key that broke it. A title over 200 characters is `refused` on `Post.title`'s pattern, with the draft's `org` and `slug` as its witness, and so is a slug another post of the organization already holds, on `Post`'s primary key, whether or not the member can see that post.

Every other error stays in the Effect's error channel, and this handler lets it reject its promise; a production handler maps each `CallError` by its `kind`, and an `OpenError` at stage `token` to 401. To stop a call whose client went away, pass an `AbortSignal` as `web.runPromise(effect, { signal })`: the interrupted call ends once the server has stopped its statement, and an interrupted write may have committed, like `commitUnknown`.

### The nightly job

```ts
export const EtlServed = served<typeof EtlJob>(etlJobFile, "etl_job")

export const EtlLayer = DbLayer.make({
	...connection,
	login: EtlServed,
	password: Config.Redacted("BLOG_ETL_PASSWORD").pipe(
		Effect.mapError((cause) => new CredentialError({ cause }))
	),
	pool: { max: 2 }
})

const etl = ManagedRuntime.make(EtlLayer)

/** No token and no claims: it writes view counts, and never reads a title. */
export const loadViews = (
	views: ReadonlyArray<{ readonly org: string; readonly post: string; readonly views: bigint }>
) =>
	etl.runPromise(
		Effect.gen(function* () {
			const db = yield* Db.open(EtlServed.roles.etl, {})
			return yield* db.workload.recordViews.once({
				params: {},
				facts: { put: { PostViews: views } }
			})
		})
	)
```

`put` writes rows by primary key: after the change, the row at each key is the one given. The load is one transaction, so it lands whole or not at all: a count for a post deleted since the export is `refused` on the containment of `PostViews`' `org` and `post` in `Post`'s `org` and `slug`, and nothing is written. grizzle never retries: a `transient` error, such as a serialization failure, changed nothing, and running the write again is the caller's decision.

`EtlJob` needs no `verify` and opens with no token, since its role reads no claims. Its pool holds at most two connections and closes each five seconds after its last use.

### Why it holds up in production

Each piece is PostgreSQL's to enforce or TypeScript's to check, so the guarantees hold under load, through a shared pool and beside other writers:

- **Every writer meets the same rules.** The blog's rules and roles are constraints, grants and row-level security policies, so a script, a second service or psql logged in as `roleNameOf(Web, connection)` meets them exactly as the app does ([Direct SQL access](#direct-sql-access)).
- **No request leaks into the next.** `anon` and `member` share the web login's pool. Each transaction takes on its role and claims at its start, for that transaction only, so a pooled connection never carries one request's role or claims into the next.
- **Races resolve in PostgreSQL.** Every call of the blog is one SERIALIZABLE transaction in one round trip, and none holds a connection between awaits. PostgreSQL commits only what some serial order of the calls would; a call it cannot order fails with a `transient` `CallError` that changed nothing, which your code may run again, as the nightly job does.
- **Failures are values.** A refused write is an outcome you switch on, and anything that went wrong is a tagged error in the Effect's error channel ([Errors and outcomes](#errors-and-outcomes)). Neither is a message to parse.
- **Trust is split by login.** Whoever holds the web login's password can act as any reader or member, but never as `etl`; whoever holds the job's can write view counts and never read a title ([Security model](#security-model)).

### Migrating and deploying

Before the app's first request, install the schema. `grizzle.config.ts` names `Blog`, both logins, the migrations directory and the connection of the role that owns the database; [Migrations](#migrations) shows it in full. Then:

```sh
pnpm exec grizzle generate grizzle.config.ts   # draft migrations/blog/<timestamp>_<name>/, snapshot.json, manifest.json, served/
pnpm exec grizzle check grizzle.config.ts      # offline: generated, resolved and untampered?
pnpm exec grizzle migrate grizzle.config.ts    # apply what is pending, as the owner
```

Read the SQL `generate` drafts, edit it if you need to, and commit it with the code: it is what `migrate` runs, and the database must end where the snapshot says. The first migration creates each login's PostgreSQL role, `roleNameOf(Web, connection)` and `roleNameOf(EtlJob, connection)`, and, since `Web` serves a read, the installation's decoder login, `roleNameOf(WebServed.decoder, connection)`, each without a password: as the owner, give each its password (psql's `\password` on the role `roleNameOf` names), and set it as `BLOG_WEB_PASSWORD`, `BLOG_ETL_PASSWORD` or `BLOG_DECODER_PASSWORD` where the app or the job runs.

- **The code and the database move together.** `grizzle check` refuses a served file that is not its login's compile under the snapshot, so the app's programs are the schema's. Every `Db` transaction refuses a database whose latest migration did not reach the snapshot its served file was compiled under. `grizzle drift`, from CI or a schedule, and `grizzle migrate` after every apply compare the whole database with the snapshot: roles, settings, privileges, view definitions and policies included.
- **Migrations are downtime.** While one runs, every `Db` call fails at once with a `stale` `CallError` (reason `Migrating`); once it completes, a `Db` of the old code fails with `stale` (reason `Migrated`). Deploy the code that carries the new served files.

[Migrations](#migrations) covers the whole loop, with renames, drops, markers and data steps. [Deploying](#deploying) covers what `DbLayer.make` and every transaction check, the sessions a deployment holds on the server, and RDS IAM authentication.

## Tables and types

`relation(name, fields, primaryKey)` declares a table. `schema` groups tables and their rules into one PostgreSQL
schema.

- **A name is one relation.** A schema's relations are a list, each relation carrying its own name, and `S.relations`
  holds them by name. A library's relations join an application's by concatenating lists, `schema("App", [...own,
  ...library.relations], [...ownRules, ...library.rules])`, which drops nothing, where a spread of two records keeps
  one of two relations of a name without a word. A relation listed twice, or an identical copy of it, is one
  declaration. Two relations of one name that differ in anything are refused when the schema is built, in the types and
  with `DuplicateIdentity` naming both declarations, and so is a rule built over a relation of a declared name that is
  not the one declared, since a rule names its relations by name. A level may list a relation a level below declares,
  exactly as declared there, and nothing else of its name.
- **No nullable columns.** A value that may be missing is a row that may be missing, in a table of its own, like
  `PostViews`.
- **Closed by default.** A closed relation's rows are inserted, never updated or deleted: a role that writes it holds
  SELECT and INSERT on its table and no UPDATE or DELETE, and a ChangeSet's put or delete of it is refused when it
  compiles. Each closed table carries an immutability guard, a `BEFORE UPDATE` row trigger that refuses an UPDATE
  changing any field but the few grizzle itself rewrites in place (a family member's copy of a mutable owner's column,
  which the owner axis's ON UPDATE CASCADE carries), whoever runs it, its owner included, with 42501 naming the table.
  A migration's data steps on such a table run with the guard dropped and create it again in the same transaction:
  a draft's and the data step you write at its place, over every table the previous version guards and this one keeps,
  and a custom migration's (`generate --custom`) transactional file, over every guard the database holds as it runs. A
  `-- grizzle: no-transaction` file has no transaction to do that in, so it cannot write a guarded table. Every data
  step also stands up the rule judge's session tables first ([Rules over queries](#rules-over-queries)): a draft's by
  the previous version's stand-ups, a custom migration's file, a no-transaction one's too, by every stand-up the
  database holds as it runs, so a step's write of a table a rule over a query reads is judged at its COMMIT; and a step
  that lifts the guards re-checks every rule and stored relation over an immutable relation before it commits
  ([Migrations](#migrations)).
  An open relation is `mutable(Post)` inside a unit whose heading its key leads with ([Units](#units)): its writers hold
  UPDATE and DELETE, and its rows change in place and are deleted under the unit's exclusive borrow. A family's owner
  whose family changes after it is inserted is open too ([Families](#families)).
- **First insertion wins, by `race`.** `race(Claim)` among a schema's rules makes a table's primary key first come,
  first held: an insertion at a key another row holds meets that row instead of being refused for differing from it
  ([Races](#races)).
- **No timestamp type.** When a row was written is an `instant`, which the database alone writes ([Instants](#instants)).
  Any other time, a deadline or a due instant, is a value: a `bigint` contract, such as milliseconds since the epoch,
  and the current time is a parameter, the caller's, or the database's clock where a member binds it
  ([The database's clock](#the-databases-clock)). A calendar day is a `date`.

| Field                                              | PostgreSQL                                                          | TypeScript                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `contract<typeof key>()("ClerkUserId", uuid)`      | uuid, behind the contract's domain; a bare `uuid` column is refused | `Marked<Uuid, typeof key>`, made by `mintOf(key)`; `Uuid.parse` reads a string |
| `sha256`                                           | bytea, behind the digest domain that checks 32 bytes                | `Sha256`, a SHA-256 digest's 32 bytes, `Sha256.ofBytes` or `ofText`    |
| `pg.smallint`, `pg.integer`                        | smallint, integer                                                   | `number`                                                               |
| `pg.bigint`                                        | bigint                                                              | `bigint`                                                               |
| `natural`                                          | bigint, behind a domain that checks `>= 0`                          | `bigint`                                                               |
| `instant`                                          | bigint, behind natural's domain                                     | `Instant`, a `bigint` of microseconds since the Unix epoch, written by the database |
| `instant.stored`                                   | bigint, behind natural's domain                                     | `Instant`, an instant a read delivered, written by its caller as it is |
| `date`                                             | date, its column checked to 0001-01-01 … 9999-12-31                 | `CalendarDate`, its ISO 8601 text `"YYYY-MM-DD"`                       |
| `pg.numeric`                                       | numeric, no typmod: every value numeric holds, NaN and ±Infinity    | `Decimal`, exact, passed as it is                                      |
| `pg.numeric(p, 0)`                                 | numeric(p, 0), its column checked to hold no NaN                    | `bigint`, an integer of at most p digits                               |
| `pg.numeric(p, s)`, s not 0                        | numeric(p, s)                                                       | `Decimal`, exact, no display scale                                     |
| `pg.numeric.within(digits, scale)`                 | numeric, no typmod, its column checked to NaN, ±Infinity and the finite values below 10^digits of at most `scale` fraction digits | `Decimal`, exact, a sum's, a mean's or an operation's value stored as it was read |
| `pg.real`, `pg["double precision"]`                | real, double precision                                              | `number`                                                               |
| `pg.money`                                         | money                                                               | `Money`                                                                |
| `exactInteger`                                     | numeric, its column checked to scale 0: no fraction, NaN or infinity | `bigint` of any size, integer arithmetic's exact value                 |
| `exactMoney`                                       | numeric, its column checked to money's scale 2: no NaN or infinity  | `Money` of any count of cents, money arithmetic's exact value          |
| `pg.boolean`                                       | boolean                                                             | `boolean`                                                              |
| `pg.inet`                                          | inet                                                                | `Inet`, inet_out's text; `Inet.parse` reads any text inet_in reads     |
| `pg.cidr`                                          | cidr                                                                | `Cidr`, cidr_out's text; `Cidr.parse` reads any text cidr_in reads     |
| `str.regex(pattern, flags?)`                       | text, behind a domain that checks the pattern                       | the pattern's language: `string`, or `"yes" \| "no"` for `^(yes\|no)$` |
| `str.bytes(n, str.regex(...))`                     | text, behind a domain that checks its UTF-8 bytes, then the pattern | the pattern's                                                          |
| `str.and(str.regex(p), str.regex(q), ...)`         | text, behind a domain that checks every pattern                     | the patterns' languages intersected, `P & Q`                           |
| `closedId(X)`, for `X = closed.ordered("X", [...])` or `closed.unordered("X", [...])` | smallint, behind the roster's domain | the union of its names |
| `closedId(X, { only: [...] })`, `closedId(X, { except: [...] })` | smallint, behind the roster's domain and a CHECK of the subset's codes | the union of the subset's names |
| `bits(X)`, a set of `X`'s handles                  | bit(n), behind a domain that holds only live handles                | `Bits<typeof X>`, a `ReadonlySet` of its names; `Bits.of(X, [...])`    |
| `contract<typeof key>()(name, base, check?)`       | a domain with that CHECK                                            | the base type under the key, `Marked<base, typeof key>`                |
| `span(T, width?)`, T integer, bigint or date       | int4range, int8range or daterange                                   | `{ start, end }`, start included, end excluded                         |
| `pg.vector(n)`                                     | pgvector's vector(n)                                                | `Vector`, a Float32Array                                               |
| `searchDocument(configuration, [w, text], ...)`, generated | tsvector, a STORED generated column                            | `SearchDocument`, the text PostgreSQL prints for it                    |
| `pg.tsvector(configuration)`                       | tsvector                                                            | `SearchDocument`, a document a read delivered, written back as it is   |
| `bytes`                                            | bytea, at most 1,073,741,819 bytes                                  | `Uint8Array`, a fresh one over its own buffer                          |

Each type has one name, the one PostgreSQL prints for it: `pg.integer`, never `int4`; `pg["double precision"]`, never
`float8` or `float(p)`; `pg.numeric`, never `decimal`; `pg.boolean`, never `bool`.

- **A value is parsed exactly, once.** Every value you pass, a fact's field, a parameter or a page's boundary, is read
  as its field's type and never altered: a `Decimal` with more fractional digits than its `pg.numeric(p, s)` holds is
  an `EncodingFailure` (`numericScale`), never rounded, so `1.005` at scale 2 is refused where PostgreSQL would store
  `1.01`; a `Decimal` past a `pg.numeric.within(digits, scale)` bound is an `EncodingFailure` (`numericBound`); a
  `SearchDocument` for `pg.tsvector` is the text PostgreSQL prints for a document, its lexemes in their one order,
  each once, and anything else is an `EncodingFailure` (`searchDocumentForm`), never sent to be stored as another
  document; a `number` for `pg.real` must be a binary32 value as it is, `Math.fround(x) === x`, or it is an
  `EncodingFailure` (`realInexact`), never rounded to the nearest one. A uuid's case is a spelling of one value, a
  float's `-0` a value of its own, kept as written, and nothing else is changed. Everything else a field's type says, its pattern and contract, is
  PostgreSQL's to check ([Errors and outcomes](#errors-and-outcomes)).

- **Network types.** `pg.inet` is an address with its network's mask, `pg.cidr` a network, IPv4 and IPv6 alike, PostgreSQL's own. A value is any text PostgreSQL's inet_in or cidr_in reads, and its host value the one text inet_out or cidr_out prints of it, so `"1.2.3.4/32"` is the inet `"1.2.3.4"`, `"10/8"` the cidr `"10.0.0.0/8"`, and a cidr with a bit set right of its mask, `"10.1.2.3/8"`, is an `EncodingFailure` (`cidrHostBits`), as PostgreSQL refuses it. grizzle reads every text as PostgreSQL 19 does, quirks included, so a value means one thing on the host and in the database: `Inet.parse(text)` and `Cidr.parse(text)` read a text, such as a request's address from an edge's header, into the value, a `Result`. Both compare, order (IPv4 before IPv6, then network_cmp's order), hash, stand in a key or an index, and are a context's field; an inet has `min` and `max`, and a cidr none, since PostgreSQL has neither. Their containment is `Net`'s ([Scalar terms](#scalar-terms)).
- **A contract's values are its consumer's.** Its host type is its base's under a key the declaring module holds:
  `const centsKey = Symbol("Cents")`, then `contract<typeof centsKey>()("Cents", pg.bigint, (c) => Logic.ge(c, 0n))`,
  whose values are `Marked<bigint, typeof centsKey>`. Only the key's mint makes one, `const toCents = mintOf(centsKey)`,
  then `toCents(500n)`, without checking it; the contract makes none. Where the key lives, and whether it is exported,
  decides who makes values: a module that grades keeps its key, exports its grading function and its type,
  `Marked<Decimal, typeof gradedKey>`, and a write of a grade takes nothing else. A key is a unique symbol, one per
  contract: a key of type `symbol` is a type error, and `mintOf` refuses a registered one, which `Symbol.for` gives any
  module by its name.
- **A contract's checked mint parses a value from outside, with no compiler loaded.** A configuration that names the
  contract, `contracts: [Cents]`, has `grizzle generate` compile it into its checker file,
  `migrations/contract-checks/Cents.json`: its type as a schema's compile types it, its predicate a table the host
  evaluates, the automata of its patterns and the digest of its description, a served file's artifact kind, which
  `grizzle check` holds current. `contractParser(centsFile, Cents, centsKey)` (`@bjornpagen/grizzle/runtime`), over the
  file as an import of it yields (`import centsFile from "./migrations/contract-checks/Cents.json" with { type: "json"
  }`), reads a value of the base as PostgreSQL does before it stores it: a value of no value of the base's type is
  `ValueRefused` by the codec's fault (a bigint past int8), one outside the contract's predicate or its base's
  refinements `DomainRefused`, each at the contract, and any other value is minted under the key, `Marked<bigint, typeof
  centsKey>`; over a file compiled from another description of the contract every value is `CheckerDrifted`. Its
  `contract` is the contract, which a consumer that stores what it parses types its column by. It takes the contract's
  own key, so only the key's holder builds it, in a module of its own beside the mint (a schema module importing the
  file would load it while generate writes it), where a boundary decodes the contract's values, a request's or a step
  input's. A test builds one over `contractCheck(Cents)` (`@bjornpagen/grizzle/compile`), the same file's value.
- **Where a contract's value comes from.** A fact's field, a parameter's argument, a closed relation's row, a typed
  constant (`Type.literal(Cents, toCents(5n))`), a conditional's other arm and a variant arm's field are values of the
  host type: a plain `bigint`, or another contract's value, is a type error there. A value compared with a contract's
  term, in a filter, a comparison or a selection, is its base's, `r.ge(cents, 0n)`, since a comparison makes no value.
- **The database makes a contract's values under its key.** Every place a value of a contract is made from values of
  other types takes the key after its own arguments, as `mintOf` takes it on the host: a cast,
  `Type.cast(Num.add(a, b), Cents, centsKey)`; a field grizzle fills, `drawn(TestNumber, testNumberKey)` and
  `accumulated(Cents, toCents(0n), centsKey)`; a clock bound to a parameter of the contract, `clocked(program,
  { now: "millis" }, { now: millisKey })`, by the parameter's name; and a declared function whose result holds one at
  any depth, `fn("grade", { …, returns: row(Single) }, { QtiInteger: qtiIntegerKey })`, by the contract's name. A
  contract over another takes every key of its chain, its own first, `Type.cast(x, Outer, outerKey, centsKey)`, as the
  host makes its value only through each mint, `toOuter(toCents(0n))`, so it is declared under a key apart from its
  base's. A generated field, a derived relation's field, `r.min` and `r.max` carry values the contract already holds
  and take none, and `r.sum` and `r.mean` deliver its base. A module that does not hold the key makes no value of the
  contract: not on the host, not in a query, not in a stored computation. From JavaScript, a missing key, an extra one
  or a value that is no symbol is `MalformedDescription`, and a registered symbol `Refused`.
  A read delivers the host type, the one conversion grizzle makes unchecked, since it trusts its own database, and the
  database checks the base type and the predicate on every write. A fourth argument, `{ proves: [...] }`, declares facts
  the check implies ([Queries](#queries)).
- **`natural`** is the builtin contract over `pg.bigint`, unbranded: a count, the type of every `r.count()`, and the one
  type a rule's `pred` reads ([Rules](#rules)). Every schema holds it, since every query over it may count, so its
  domain is installed whether or not a field is natural. A count meets a natural field, parameter or literal and is
  written into a natural field as it is; a count beside a `pg.bigint` is two types, so type that side `natural`, which
  is what it holds, and an arithmetic's exact integer meets a count as `Type.base(count)`. A negative value is an
  outcome on the law `{ kind: "contract", contract: "natural" }`. No other contract may be named `natural`.
- **`exactInteger` and `exactMoney`** are the types integer and money arithmetic deliver, of any size, as stored
  fields: an exact integer, a `bigint`, and exact money, a `Money` of any count of cents, so a query's
  `Num.add(balance, amount)`, `Num.mul(a, b)` or a sum over money is written into one as it is, by a ChangeSet member,
  a generated field or a derived relation's head, and a read of one keeps every digit. Each is PostgreSQL's numeric of
  no typmod, numeric's own 131,072 integer digits, its column checked to the values its host type spells:
  `CHECK ((scale(x) = 0) IS TRUE)` for an exact integer, `= 2` for exact money, money's own fraction digits, which
  refuses a fraction, another scale (`5.0`, `1.5`), NaN and the infinities from a direct writer with 23514; grizzle's
  own writes are its host values, which hold no other. Its arithmetic is exact at numeric's own limit, PostgreSQL
  refusing a result past it with 22003, as over a `pg.numeric`. A literal or a parameter of its family meets it, a
  bigint or a `Money` among them, and a parameter of its own type takes any value of it. No key, UNIQUE, containment or family axis holds one, since its widest
  value outgrows every index entry: one there is `UnrepresentableKey` naming the precision to declare, `pg.numeric(p, 0)`
  (or `pg.bigint`) for an exact integer, `pg.numeric(p, 2)` (or `pg.money`) for exact money; a lookup leaves one out
  of its index, a filter beside it, as a `pg.numeric` of no typmod ([Keys and indexes](#keys-and-indexes)). No
  contract is over one,
  nor a closed relation's, a context's or a declared function's field of one: bound it first, with `Type.cast` under
  `Num.within`, into the type that holds it.
- **`date`** is a day of the proleptic Gregorian calendar, PostgreSQL's date, a plain type: `Type.base` of a date is
  the date. Its value is its ISO 8601 text, `"2024-02-29"`, one text per day, in calendar order; every login pins
  `DateStyle` to ISO. A CHECK on every date column holds it to 0001-01-01 … 9999-12-31 against any writer, so no
  infinity or unspellable year is stored; it is the type's range, not a rule an outcome names. Dates compare, take
  `min` and `max`, and may stand in a key or index.
- **Spans** are over integer, bigint or date, or a contract over one; `span(date)` is a span of days.
  `span(T, width)` fixes `end − start` by a CHECK on the column: a positive `number` over integer, a count of days
  over date, a positive `bigint` over bigint.
- **`bytes`** is written and read back whole, nothing more. No key, unique, containment, rule, selection, filter or
  parameter takes one, no scalar term reads one but `Crypto.sha256`, its digest ([Text](#text)), and no
  contract, generated or accumulated field is of one: each is a type error where the types see it and
  `UnsupportedOperation` when it compiles. A query's head reads one like any field. It is written in binary and read back in chunks of 16 MiB, one result row a chunk, in the same statement and
  round trip, wherever it is delivered: a query's rows, an attachment's, a window's, a family's stored members. grizzle
  writes the chunks into a fresh `Uint8Array` you own, so a value never passes through one string. A write reads back
  only a value's SHA-256 digest, which is how the host knows it: two values of one digest that differ are a SHA-256
  collision, refused as an `EncodingFailure` (`bytesCollision`) rather than taken as one. grizzle reads your array
  where it is and copies it once, into its column's binary array, as the call is sent, checking the copy against the
  digest: an array you change or detach after passing it to a write's `apply`, before the call is sent, is an
  `EncodingFailure` (`bytesChanged`) rather than sent unlike the value the write was worked out from. Its bound,
  1,073,741,819 bytes (`bytesMaxLength`), is PostgreSQL's longest bytea: a longer value is an `EncodingFailure` naming
  its field, before any SQL. An attachment whose rows hold a bytes field is a statement of its own, so one under rows
  that read `.approximateNearest` is refused: query the nearest rows, then attach to their keys in a second query.
- **Patterns.** Text always carries one, with flags `"u"` (the default) or `"su"`. The syntax is JavaScript's under
  `u`, cut to what PostgreSQL matches the same way: characters and escapes, classes and ranges, `\d`, `\w` and their
  complements, `.`, groups, `|`, `^` and `$` for the start and end of the whole text, and greedy `?`, `*`, `+` and
  `{m,n}`, each bound at most 255 (`regexMaxRepeat`). Refused: lookahead and lookbehind, `\p{…}` and `\P{…}`, `\s`
  and `\S`, `\b` and `\B`, backreferences, named groups, inline modifiers, lazy quantifiers, NUL, a lone surrogate,
  and, as a field's or a contract's type, a pattern no text matches, such as `a^b` or `[]`, which no value could hold.
  TypeScript accepts these; the first relation or contract built over the pattern refuses it with
  `UnsupportedOperation`, naming the construct and its position. As a `Text.pattern` or a value of a closed
  relation's pattern field, a pattern no text matches is the empty language, whose match holds of no text.
- **`str.bytes(n, pattern)`** is the pattern's text of at most `n` UTF-8 bytes, `n` from 0 to 2,147,483,647. Its host
  type is the pattern's, so an unbounded text of the pattern needs no cast. Its domain checks
  `octet_length(VALUE) <= n` before the pattern, so the regex engine never reads a longer value, and refuses either
  with 23514. Equal patterns and bounds share one domain; a bound the pattern already implies is dropped.
  `str.bytes(n, str.regex("^.*$", "su"))` is any text of at most `n` bytes.
- **`str.and(a, b, ...)`** is text of every pattern its texts carry at once, their intersection, as XML Schema reads
  two pattern facets: write each facet as its own `str.regex` and join them, never one regex you intersect by hand.
  Its host type is theirs intersected (`P & Q`), its byte bound the tightest of theirs, and its domain checks
  `VALUE ~ p AND VALUE ~ q`, each pattern held to PostgreSQL's limits on its own, so a conjunction costs the sum of
  its patterns, never their product. A text may be a `str.bytes` or another `str.and`, whose patterns it takes in
  order. Two conjunctions of one language, or a conjunction and a pattern of its language, share one domain wherever
  grizzle builds the intersection's automaton, within 2,048 DFA states and 2,097,152 NFA-state visits as for a parse's
  proof ([Parsing text](#parsing-text)), and a conjunction no text matches is refused there with
  `UnsupportedOperation`; past the bounds the domain still checks every pattern.
- **Text in a key** needs a byte bound. A key, a UNIQUE, a family's axis or a reference's target holds every text as
  itself, so its entry, in any order of its columns, must fit a B-tree entry for the widest value each field admits; a
  key over a text of no byte bound, or one that could outgrow the entry, is `UnrepresentableKey` when the schema
  compiles ([Keys and indexes](#keys-and-indexes)). Bound the text (`str.bytes(n)`), or key by a digest you declare, a
  generated `generated(sha256, Crypto.sha256(x))` field, whose 32 bytes any key holds. A lookup grizzle drafts holds only the columns that fit its entry. A text of no byte bound it binds
  by equality is sought by the digest its relation declares of it: wherever a rule states the text equal to a value, a
  match's constant or parameter, a variable another match binds, `Logic.eq` or `Logic.in` in its where with a term of
  its other values, or a negation's constant, grizzle states the digest equal to that value's `Crypto.sha256` too, which
  the digest's generation makes true of every such row, so the lookup's index holds the digest and the read rechecks the
  text on the rows of that digest alone. Through a query the digest goes by lineage: a query whose head copies the text,
  delivering it as its relation stores it, carries the declared digest beside it wherever its reader equates the text,
  through every query between them, and a negation that correlates the text with a column of its reader states the
  digest equal to that column's `Crypto.sha256`; only the digest the relation declares is carried, never one grizzle
  computes. A lookup that binds such a text and no digest of it, a relation that declares none, or a text a query's
  head computes rather than copies, is `UnrepresentableKey` naming the field and the digest (`undigestedText`), unless
  its other equalities bind a key, which reads one row. A bounded text too wide for the entry
  beside the lookup's other columns is a filter beside the index, never a column of it, and a text it orders, ranges or
  matches a prefix by needs the byte bound. `keyTextBytes(fields)` is the most bytes a text holds as itself beside
  `fields`, the index's other columns, in every index grizzle plans over them, in any order, any of them a hidden
  column that may be NULL: a key one byte wider is refused. For
  a family axis that carries the text, `fields` are its group fields, its natural index, its other carried values and
  a tree's `end`. So `str.bytes(keyTextBytes([uuid, natural]), str.regex("^.*$", "su"))` is held as itself in a key
  beside a uuid and a natural, declared or over a selection, and in an ordered family's axis grouped by a uuid.
  `keyTextBytes` throws `UnrepresentableKey` naming every fault at once: more fields than an index holds beside a text,
  and each field of no byte bound; or, where neither is, fields that leave a text no byte. `keyFits(fields)` is whether a key over `fields` holds every value
  they admit, each as itself, the verdict a relation keyed by them meets, as a `boolean`, never thrown.
- **A numeric in a key** needs a precision. A key's entry holds each numeric as itself, so a `pg.numeric` of no typmod,
  an `exactInteger` or `exactMoney` field, or a `pg.numeric(p, s)` of digits enough to outgrow the entry, is
  `UnrepresentableKey` in a key; a lookup leaves such a numeric out of its index, a filter beside it. An entry is sized as PostgreSQL could lay it out in any order of its
  columns: from its data offset, each datum at its widest alignment padding and its longest, the whole MAXALIGNed, so
  a key, the UNIQUE a reference lands on and the reference agree whatever order each lists the columns in.
- **Exported bounds.** `messageMaxBytes`, PostgreSQL's longest message (1,073,741,822 bytes), `maxStringLength`, V8's
  longest string (536,870,888 UTF-16 code units), `bytesMaxLength` (1,073,741,819 bytes) and `flightMaxBytes`, the most
  one write over TLS carries (1,908,342,784 bytes), refuse a call before it is sent; `regexTextMaxBytes`, the longest
  text PostgreSQL's regex engine reads (268,435,454 UTF-8 bytes), is the byte bound a text a query matches by a pattern
  must keep. Each is a `Limit`: `.value` is the
  number, with its owner, unit, scope and evidence, the source that states it or the limits it derives from. Code that
  splits an input across calls (`InputTooLarge`, [Errors and outcomes](#errors-and-outcomes)) reads the bound instead of
  restating it.
- **Rosters.** `closed.ordered("Status", ["Draft", "Published"])` is a fixed list of handles whose order means
  something, and `closed.unordered("Element", [...])` one whose order means nothing; every roster is one or the other.
  A `closedId(Status)` column holds a handle's code: an ordered roster numbers its handles 0 … n − 1 in declared order,
  which is also comparison order, and an unordered one numbers them in the UTF-16 order of their names, which nothing
  compares by. A closed id of an unordered roster has no order: a comparison, `between`, `orderBy`, `Logic.least`,
  `Logic.greatest`, `r.min`, `r.max` or a fold's `Monoid.max` over it is a type error that names the fix, declaring
  the roster `closed.ordered`. Its equality, `in`, keys, joins and sets are an ordered roster's. Where grizzle
  completes an order to break ties the caller left open (a `take`, a page), it reads a closed id's code, which never
  moves, whatever its roster's kind. The API reads and writes names. The table stores codes, under a smallint domain
  that admits only live handles' codes, and every role's view adds a decoded column, `status_name`, beside each closed
  id. A handle is at most 63 UTF-8 bytes, a PostgreSQL `name`. Codes are history: an added handle is appended, a
  removed one leaves its code unused, and an ordered roster's reorder is refused ([Migrations](#migrations)).
- **Sets.** `bits(Status)` is a `bit(n)`, one bit per code, n rounded up to whole bytes, under a domain that holds
  only live handles' bits and 0 past the last code. PostgreSQL stores a bit string in whole bytes, so the padding costs
  nothing and a roster grows into it without a wider type, which would rewrite every table that stores a set over it.
  grizzle writes a set in hex only: `X'…'` cast to its domain in SQL, `X` and its hex digits as a parameter's text. The
  algebra is `Bits.union`, `.intersection`, `.difference`, `.cardinality`, `.subset`, `.disjoint` and `.singleton`;
  for a complement, take the full set less it. Membership is `Bits.subset(Bits.singleton(id), set)`, which reads
  the one bit of the id's code. Every operation gives NULL on NULL, a NULL id's singleton included. No key holds a set:
  its bit string is too wide for an index entry.

### How a field is written

Every field has one writer. An insert or a put takes exactly the fields its caller writes, `Written<R>`.
`AdditionIn<S, R>` is R's addition in S, its sequences' members nested at their count fields.

- **The caller**, the default: a field declared by its type alone, `title: Title`. A value a read delivered is
  stored so whatever its type, so a read's rows can be kept as rows of their own: `instant.stored`, an instant as it
  was read ([Instants](#instants)), `pg.tsvector(configuration)`, a search document as it was read
  ([Full text search](#full-text-search)), and `pg.numeric.within(digits, scale)`, a sum's, a mean's or an
  operation's numeric within the bound its query proves of it.
- **PostgreSQL**: a STORED generated column,
  `relation.generated(name, written, primaryKey, (r) => ({ f: generated(type, term) }))`, or a search document PostgreSQL
  parses from the row's texts, `searchDocument(configuration, [weight, text], ...)` ([Full text search](#full-text-search)).
- **grizzle, drawn:** `drawn(natural)`, a family's count or index, and a tree's `start` and `end`
  ([Families](#families)); or `drawn(c, key)`, c a contract over `pg.smallint`, `pg.integer` or `pg.bigint` under its
  key, whose column is c's and whose CHECK bounds every value grizzle draws into it.
- **grizzle, accumulated:** `accumulated(type, start)`, a fold's end or accumulator, or a copy along a family's axis,
  `start` its value where the axis begins; a contract's under its key, `accumulated(c, start, key)`.
- **The database's clock:** `instant`, stamped by the insert that adds its row where it is its relation's clock, or a
  stored instant where it is a reference ([Instants](#instants)). The same type its caller writes is `instant.stored`.

**Generated fields.** A term reads its own row and closed relations ([Closed relations](#closed-relations)). `r` holds
every stored field of the row but the generated ones, a field grizzle draws or accumulates among them: its column holds
its final value whenever PostgreSQL generates the term, at the row's INSERT or at an UPDATE that writes it, a family's
recount, refill or cascade among them. So a value read through an accumulated copy of an owner's column, such as a
text collapsed by its owner's declared type, is one generated field every query reads. Reading a generated field is a
type error.
Compiling the schema refuses a term that breaks these rules with `GeneratedRefused` (`readsGenerated`, or `notRowLocal`
for a read beyond its row). The term has the field's type, except for a text's pattern and byte bound,
which the field's domain checks: `generated(Ids, Text.concat(row.head, row.tail))` fills a refined text, and a
generated value outside the domain refuses its row, `refused` on the pattern's rule; a term whose type shares no value with the field's, `Text.lowerAscii` of a text of capitals into a field of capitals, would refuse every row, and is `GeneratedRefused` (`disjoint`) wherever the text analysis proves it, by the two patterns together or by the tighter byte bound. Nothing is cast
implicitly: a term of another integer width, numeric typmod or contract, `natural` included, is `GeneratedRefused`
(`type`); write the `Type.cast`. A term with no value at a row, such as `C.at` at a key no row holds, refuses the
row, `refused` on `{ kind: "generated", relation, field }`, witnessed by the first row you stated whose term
has no value. It is one outcome whoever finds the NULL: grizzle, filling a nested write or a family's values that read
the field, before any SQL, or PostgreSQL's NOT NULL.

**Keys.** A fact and a query's row hold every field. A primary key holds no set, bytes, generated or accumulated field.
Another key may hold a generated field, such as a `value` generated from a text to keep two spellings of one value
apart. It is compared in the statement that writes the row, never on the host, against every row the statement writes
and every stored row: two rows of one value are `refused` on the key, witnessed by the key's values as
PostgreSQL stores them. A delete compares only at keys whose fields it states. The members a new owner nests meet such
a key at its index alone, which refuses them on the key with an `unreported` witness; a member a put appends to a
stored owner's family is compared in its statement like any other row, against the stored rows and the rows the
statement writes, and witnessed by its key.

**Fill order.** grizzle fills every value it writes in an order the schema fixes, and refuses when it compiles, never
at a write, a schema that would read a field before it is filled. An insert fills a row's own fields, counts, index,
a tree's `start` and `end` and its copies from its owner or the member before it on entering the row; then the ordered
families and trees nested under it; then, on leaving the row, its fold ends and copies along a last axis. Counted
families fill their members last, from the owner's whole row, then their fold ends; a counted family's member that the
insert nests is filled there like any nested row, and its counted families complete it afterwards. So:

- a copy along an ordered family's or a tree's owner axis reads a column its owner fills on entering it, never a
  fold's end, a copy along a last axis, or a column read from one;
- a copy along a counted family's owner axis reads any column of its owner but the end of a fold over that family;
- a counted family's count and fold ends, and the index, count and copies it fills on its members, are read only by
  that family's own members and ends, never by another family's copy, fold step or selection;
- no row's columns read each other in a cycle, as copies along a tree's owner axis can at its root;
- no predecessor copy reads its own value on a member before it, through a field generated from its row and the
  predecessor copies it meets, a chain no window over the group draws: fold such a running value instead.

A generated field is filled where the columns it reads are: after the latest of them, by the fill that writes them, a
counted family's where it reads a column that family fills. Where no one fill writes every column it reads (at a
position whose fill does not reach one, or two counted families' columns), PostgreSQL alone computes it, and a copy, a
step or a selection that reads it there is refused. So a copy of a generated field waits on what the field reads: a copy
along an owner axis of an owner's field generated from a fold's end over that family is filled after its members, and
a sequence's copy of a field generated from a counted family's copy reads a column that family fills on its own.

A schema that breaks one is refused with `UnfillableField`, naming the field, the law that fills it, the column it
reads, the axis it reads it along, and why that column is filled later. A cycle through a generated field is named at
the column that reads it. A write is refused with it too where the host would read a column the write's statement
stamps (`stamped`): a member's place carried from its owner's, or a generated field over one ([Places](#places)).

### Variants

`variant(name, roster, arms, checks?)` is a typed sum: a value is one arm, each arm named by a handle of a closed
roster and a record of typed fields. One field holds one value, its host value a TypeScript tagged union, `{ tag:
"integer", value: 3 }`: the arm's handle under `tag`, then that arm's fields.

```ts
import { closedId, generated, pg, sha256, variant } from "@bjornpagen/grizzle"

const baseTypes = ["boolean", "file", "float", "integer", "pair", "string"] as const
const BaseType = closed.unordered("BaseType", baseTypes)
const QtiValue = variant(
	"QtiValue",
	BaseType,
	{
		boolean: { value: pg.boolean },
		float: { value: pg["double precision"] },
		integer: { value: pg.integer },
		pair: { least: Identifier, greatest: Identifier },
		string: { value: Prose }
	},
	{ pair: (a) => a.le(a.least, a.greatest) }
)
const Single = relation.generated(
	"Single",
	{ variable: Name, value: QtiValue },
	["variable"],
	(r) => ({
		baseType: generated(closedId(BaseType), QtiValue.tag(r.value))
	})
)
const Multiple = relation.generated(
	"Multiple",
	{ variable: Name, value: QtiValue, count: natural },
	["variable", "image"],
	(r) => ({ image: generated(sha256, QtiValue.digest(r.value)) })
)
```

- **The arms name the subset it holds.** A variant holds the handles its arms name, every handle of its roster or
  some, as `closedId(roster, { only })` holds its subset: `QtiValue` names no arm `file`, a handle the roster keeps for
  the relations that declare one, so no value of it is a file. A handle no arm names is no value of the variant: its
  host type has no arm for it, a write of it is refused before any SQL, and its domain's CHECK refuses its code from a
  direct writer, 23514. A variant over the whole roster is the one whose arms name every handle; there is no other
  form. A variant holds at least one arm.
- **One column, judged whole.** A variant field is one column, typed by the variant's domain over its composite: the
  tag, the arm's code, then every arm's fields at their base types. The domain's one CHECK holds the tagged arm's
  fields present, each judged by its own type (a contract's, a pattern's, a roster's domain, a closed id subset's codes),
  the arm's check, and every other arm's fields absent. A value of no arm, a field under another arm's tag, or a pair out of order is refused
  wherever it is written: by a write, a cast, a parameter or direct SQL. A write's refusal names the field's one rule,
  `{ kind: "variant", relation, field, variant }`, whichever domain PostgreSQL reports, the variant's or an arm's
  field's contract's or pattern's: grizzle judges the stated row on the host by the same domain to name the field.
- **The tag is an ordinary field.** `V.tag(value)` is a closed id of the roster holding the handles the arms name, as
  a closed id of that subset is, so `generated(closedId(R), V.tag(r.value))` stores it, and so does a field of the
  subset, `generated(closedId(R, { only }), V.tag(r.value))`. A key, a reference and a law name it like any field, so
  a containment can hold each value of a declared type: `on(Single, "variable", "baseType")` into the declarations'
  `(identifier, baseType)`.
- **One equality, its identity.** Two values are equal exactly when they are of one arm and each field is one value:
  a text by its bytes, a float by its bits, -0 apart from 0, every NaN one. A key, a reference, `=`, DISTINCT, GROUP
  BY and a join all read it. Order is the tag's code, then the arm's fields in declared order.
- **A digest for a key no B-tree holds.** `V.digest(value)` is a SHA-256 of that identity, the arm's handle's digest
  then each field's fixed-width image. It is a term like any other: a generated field a key is declared over, as
  `Multiple` does where an arm holds unbounded text, a query's join or a check.
- **Case analysis is exhaustive.** `V.cases(value, { boolean: (a) => …, float: (a) => …, … })` takes a handler for
  every arm, each given its arm's fields as terms, and is one term. `V.make("pair", { least, greatest })` is a value of
  one arm. `r.match(V.arm(value, "string"), { value: text })` is a source, one row of an arm's fields where the value
  holds that arm and none where it holds another, so a rule reads an arm's fields as columns. Its key is its value: an
  arm of a cell a key fixes is at most one row, to the types as to the engine, so an attachment reading it is an
  Option. A derived relation of that one match is the relation of an arm, which a law may name.
- **Arm checks are the type's.** `checks` states at most one predicate per arm, over that arm's fields alone, with
  the row-check helpers. It is printed into the domain's CHECK under the arm's code, so every relation holding the
  variant holds it, with no check of its own.
- **Functions take variants.** A declared function's argument, result or rows heading may hold a variant. Its body
  reads one with `${V.code(handle)}`, the arm's code `(v).tag` holds, and `${V.attribute(handle, field)}`, the
  attribute a field is. It builds one with `${V.of(handle, { field: "<sql>" })}`, which writes each field at its own
  attribute and casts the value to the domain. Each handle and field name is type-checked. A function at any level,
  a library level every application composes among them, names a variant of any level its schema extends: each
  installation prints the body under its own codes, as it stores the variant's columns.
- **A sum of relations is no variant.** A variant's arms are values of one column. Where an arm's data is a relation
  of its own, one other relations refer to by its key, the sum is of relations: keep the tag a field of the header, and
  mirror each arm relation with the header's rows of its handle or handles, `mirrors(on(Arm, ...key),
  on(select(Header, (h) => h.eq(h.tag, "arm")), ...key))`, or `h.in(h.tag, ["a", "b"])` for an arm two handles share,
  one statement per arm relation. Its two containments state exactly one arm row per header of those handles and none
  of another, since the header's tag holds one value per key. A query attaches an arm plainly at the
  header's key, delivered as `"option"`: the arm's key, the header's, proves at most one row.
- **Arms grow by migration.** An arm appended to the roster takes the next code. Its fields come after every installed
  attribute, and the migration adds them in place, `ALTER TYPE … ADD ATTRIBUTE`, rewriting no stored value. A handle
  renamed keeps its code and its arm's attributes. A handle removed from a roster an arm's field holds is validated
  through the variant's domain, so a stored value holding it refuses the migration, 23514.
- **The subset widens and narrows by migration.** The composite lays the arms' fields out in their codes' order. An
  arm taken into the subset at a handle past every arm's code adds its fields after every installed attribute, in
  place, as an appended arm does; an arm of no field, taken in or left out at any handle, holds no attribute, so only
  the domain's CHECK changes. The migration replaces that CHECK and validates it against the stored values, so a stored
  value of an arm left out refuses the migration, 23514. An arm with fields left out of the subset, or taken in below
  the code of an arm the variant holds, would rewrite every stored value, as would a field removed or added to an arm
  other than the one of the greatest code: any such change to a variant's arms is refused when drafted, a custom
  migration.

### Closed relations

`closed.relation(name, fields, key, rows)` is a relation whose rows are fixed when the schema compiles, such as a
grammar or a price list. Its key is required, a nonempty list of its closed-id fields; a key of every field makes it a
set. A key field's roster may be `closed.ordered` or `closed.unordered`: its constant is indexed by codes, which are
history, and reads no roster's order. Its other fields are closed ids or open-typed values, never a span, set, vector, bytes or exact value. Its rows are a
set: a row written twice is one row, and two rows of one key with different payloads are refused, naming the key and
both payloads.
`closed.relation("Allowed", { kind: closedId(Kind), flag: closedId(Flag), weight: pg.integer }, ["kind", "flag"], rows)`
says which flags each kind admits, and at what weight.

A query reads a closed relation's rows as facts its declaration fixes. The engine keys the relation by every minimal
set of its columns whose value tuples no two rows share, its declared key among them; it treats a column that holds
one value as constant, and two columns of one type whose values agree row by row as equal. The types read only the declared key, and cannot see a value no literal types,
such as a contract's bigint. So a query whose cardinality rests on any other of these facts is typed as having many
rows where the engine proves at most one: over `Allowed`, if no two rows share a weight, a match that fixes the weight
by a parameter is at most one row to the engine and many to the types.

It has no table. The migration installs it as content-addressed IMMUTABLE constants, a bit string indexed by its key's
codes and an array of each open-typed field's values, which PostgreSQL folds into every statement that reads them. A
rule that reads one from an open row is a CHECK on that row's table, named by its rule, through a row function of the
columns it reads: a containment of a row's `(kind, flag)` into `Allowed` is one substring read of the row's own codes.

Three reads stand in a row check, a selection, a generated field's term or a query's filter, never in a value a query
delivers or binds:

- **`Allowed.at("weight", kind, flag)`**: the payload field at that key, NULL where no row holds it.
- **`Allowed.row(kind)`**: the set of the last key field's handles that complete the prefix, empty where none does.
- **`Allowed.has(kind, flag)`**: a predicate, true where a row holds the key and false where none does.

Each is NULL where a key value is NULL. `has` states what holds at an absent key:
`Logic.or([Logic.not(Allowed.has(kind, flag)), Logic.ge(Allowed.at("weight", kind, flag), 1)])` holds of every
pair `Allowed` lacks, and `Logic.cond(Allowed.has(kind, flag), Allowed.at("weight", kind, flag), 0)` is the weight,
0 where there is none. NULL follows SQL's three-valued logic: a row check, over a table or a derived relation, refuses a
row its condition leaves unknown, and holds where another arm of an `or` holds; a selection keeps only the rows its
condition is true of; and a generated field's NULL term is refused by its column's NOT NULL. Every domain admits NULL,
so no cast to a contract, pattern, roster or set refuses a read first.

A rule over closed relations alone is checked once, by PostgreSQL, in the migration that installs them: a violating
row refuses the migration and leaves nothing behind. A containment from a closed relation into an open one is
refused; those rows belong in a closed relation of their own.

**Slots.** A key field may hold slots instead of every code of its roster. `slot(closedId(Position), fin(Model,
"positions"))` is a closed id of `Position` whose codes run, for each owner, from 0 to below its count: `fin(O, "n")`
over a closed relation `O` is its natural field `n` per row. `O`'s key pairs with the key's first fields, roster for
roster and in order, and every slot follows them. So
`closed.relation("Follow", { version: closedId(Version), parent: closedId(Kind), from: slotOf, to: slotOf },
["version", "parent", "from", "to"], rows)`, with `slotOf` that slot, holds each model's positions squared, not the
widest model's for every model: its constant is one block per owner, at the owner's own counts. A row whose slot is at
or past its owner's count is refused when the installation is planned, and a read at such a key, in a rule, a
generated field or a query, finds nothing, never another key's row. `Follow.row(version, parent, from)` is the set of
`to` positions that follow, over `Position`.

**The migration file** states each constant as one hex literal, `X'…'`, four bits a digit, its cells' bits padded with
0s to a whole digit, under a comment of its row count and content digest. `grizzle check` decodes each literal and
holds it to that digest and to its function's name: a changed digit, a lowercase digit or a 1 in the padding is
refused, naming the relation, the first cell where the literal departs from the declared rows, and that cell's key.
Relations that share a constant share one literal. `Follow` over 1,217,966 rows drafts a 507,520-byte literal and
installs it in 35 ms.

## Rules

Rules are declared in a schema's list, beside its tables. A box office:

```ts
import { check, contract, counted, drawn, fin, key, Logic, mutable, natural, span, unit } from "@bjornpagen/grizzle"

const centsKey = Symbol("Cents")
const Cents = contract<typeof centsKey>()("Cents", pg.bigint, (c) => Logic.ge(c, 0n))
/** A show's production code, and a ticket's barcode, as the box office prints them. */
const ShowCode = str.regex("^[A-Z0-9]{2,12}$")
const Barcode = str.regex("^[0-9]{12}$")

export const Show = relation(
	"Show",
	{ id: ShowCode, seats: natural, price: Cents, tickets: drawn(natural) },
	["id"]
)
export const Ticket = relation("Ticket", { id: Barcode, show: ShowCode, holder: ClerkUser }, ["id"])
/** A stage is its name in the building. */
export const Stage = relation("Stage", { name: Title }, ["name"])
export const Run = relation("Run", { stage: Title, nights: span(pg.integer), show: ShowCode }, [
	"stage",
	"nights"
])

export const BoxOffice = schema(
	"BoxOffice",
	[Show, Ticket, Stage, Run],
	[
		counted(on(Ticket, "show"), fin(Show, "tickets")),
		contained(on(Run, "stage"), on(Stage, "name")),
		contained(on(Run, "show"), on(Show, "id")),
		key(on(Ticket, "show", "holder")),
		check("SomeSeats", Show, (s) => s.ge(s.seats, 1n)),
		check("NoOversell", Show, (s) => s.le(s.tickets, s.seats)),
		unit("Show", { id: ShowCode }),
		mutable(Show)
	]
)
```

A price is never negative. Every ticket's show, and every run's stage and show, exists. A person holds at most one
ticket per show. A show has at least one seat and never more tickets than seats: `tickets` is drawn, each show's count
of the tickets that name it, which grizzle keeps and `mutable(Show)`, in the show's unit, lets change. `nights` is a span in `Run`'s primary
key, so two runs on one stage never share a night.

| Rule           | Written as                                                                | Holds when                                                                    |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Primary key    | `relation`'s third argument                                               | no two rows share it                                                          |
| Unique key     | `key(on(Ticket, "show", "holder"))`                                       | no two rows share these fields                                                |
| No-overlap key | a key with a `span` field                                                 | rows that agree on the key's other fields never share a point of the span     |
| Foreign key    | `contained(on(Ticket, "show"), on(Show, "id"))`                           | every ticket's `show` is a show's `id`                                        |
| Both ways      | `mirrors(on(A, "x"), on(B, "y"))`                                         | `contained(a, b)` and `contained(b, a)`, the two rules it stands for          |
| Coverage       | `contained` between two `span` fields                                     | the target's spans cover each source span                                     |
| Row check      | `check("SomeSeats", Show, (s) => s.ge(s.seats, 1n))`                         | the condition holds on every row                                              |
| Counted family | `counted(on(Ticket, "show"), fin(Show, "tickets"))`                       | each show's `tickets` is the number of tickets that name it                   |
| Ordered family | `ordered(on(Line, "order", "at"), fin(Order, "n"))`                       | each order's lines hold `at` exactly 0 … n − 1                                |
| Tree           | `tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["doc"] })` | Node keyed (doc, start): each `doc`'s rows one tree, `[start, end)` each row's pre-order interval |
| Fold           | `fold(family, Monoid.sum, step, end)`                                     | each owner's end is its members' step values combined by the monoid           |
| Selected side  | `on(select(Ticket, (t) => φ), "show")`, in any rule                       | the rule reads only the rows where φ holds                                    |
| Predecessor    | `on(Place, "show", pred("at"))`, in any rule                              | the rule reads `at` − 1, and nothing of a row whose `at` is 0                 |
| Over a query   | `on(TypedHref, "path")`, TypedHref a derived relation, in any rule        | the rule reads the query's rows as the tables stand at commit                 |

A rule pairs its sides' terms in order. A side is `on(source, ...terms)`.

- **A source** is a table, a derived relation, or `select(T, (t) => φ)`, the rows of T where φ holds, φ written as a
  row check's condition. It is the one way to write a selection. A rule over a derived relation reads its query
  ([Rules over queries](#rules-over-queries)).
- **A term** is a field, or `pred(n)` of a `natural` field n: n − 1, defined only where n is above 0.
- **Each term once.** A side lists each term once: `on(Ticket, "show", "show")` is a type error, and refused from
  JavaScript when built. `"at"` and `pred("at")` are two terms.
- **Rows a side leaves out**, outside its selection or with its `pred` field at 0, have no tuple there: a key over the
  side doesn't hold them apart, a containment from it doesn't require them, and one into it doesn't find them.
- **Keys.** A key over a table's own fields is a candidate key of the table; one over a selected side or a `pred` term
  is not. A containment's target holds a key of its table whose selection's conditions are all the target's, its terms
  among the target's terms, or among its terms and the fields the target fixes. A target's selection fixes a field
  beyond its terms by one condition, outside the key's selection, that equates the field to a value or to one of the
  target's terms: `contained(on(A, "id"), on(select(B, (b) => b.and([b.eq(b.kind, "x"), b.eq(b.root, b.id)])), "id"))`
  holds where every A's id is a B of kind `"x"` that is its own root, and B's primary key `id` keys the target. A
  target no key holds is refused when the schema compiles.
- **Generic helpers.** A rule may be written in a helper generic over the tables it reads,
  `<T extends typeof A | typeof B>(t: T) => contained(on(t, "owner"), on(Owner, "id"))`, and typechecks exactly where
  the rule holds for each table T may be. Those tables share one heading, or one holds every field of another and
  more; a helper over tables that share none is refused. A query over such a T reads it the same way, through
  `v(t, "x")` and `r.match(t, …)`, and there tables whose headings differ only in a closed id's roster share one: each
  such field is read off the table T is, typed per instantiation at that table's own roster, ordered or unordered. One
  helper `<L extends typeof BaseTypeLexical | typeof ResourceTypeLexical>(lexical: L)` over closed relations
  `{ code: closedId(Roster), lexical }` reads `v(lexical, "lexical").code` as a closed id of L's own roster, and a
  binding of it meets only L's `code`. A helper over several tables reads every closed id so, so a constant at one is
  refused: no handle is the types' at each instantiation.

A show's waitlist, over the box office:

```ts
import { natural, pred, select } from "@bjornpagen/grizzle"

/** A show's waitlist: its places in order from 0, and whether each place's holder has been called. */
export const Place = relation(
	"Place",
	{ show: ShowCode, at: natural, holder: ClerkUser, called: pg.boolean },
	["show", "at"]
)

/** The places whose holder has not been called yet. */
const waiting = select(Place, (p) => p.eq(p.called, false))

export const Waitlist = schema.extend(
	[BoxOffice],
	"Waitlist",
	[Place],
	[
		contained(on(Place, "show"), on(Show, "id")),
		contained(on(Place, "show", pred("at")), on(Place, "show", "at")),
		key(on(waiting, "show", "holder"))
	]
)
```

A show's places run from 0 with no gap. A holder waits at most once per show, and may hold any number of places
already called.

Every rule holds at commit, for every writer. A rule over tables is PostgreSQL's own constraints, and grizzle installs
no trigger and no function for it.

- **Sides.** A selected side's guarded term, the one over its earliest field (its primary key's first), and each `pred`
  term, is a STORED generated column, `CASE WHEN φ THEN t END`, and every other term is its field's own column. A key
  over a side is `UNIQUE NULLS DISTINCT` and a containment `FOREIGN KEY … MATCH SIMPLE`, both of which pass a row with
  any of its columns there NULL, so the one guarded column keeps every row the side does not read out of both, and a
  row computes each selection once, never once per term.
- **Fixed fields.** The source holds each value a target fixes a field to as a STORED generated column, and lists its
  own field again for each field the target equates to one of its terms, so the foreign key meets the target's terms,
  then its fixed fields, which add no column to the target. The UNIQUE it references is the key the target holds, or
  one over more columns, which that key implies. The key implies a UNIQUE over the target's terms under its selection
  too, which needs no constant, and grizzle references whichever adds fewer indexes and columns to the schema: the
  target's own terms where a containment out of the same selection reads them, as each arm's mirrors' way back
  does, so one index serves both, or where the shared UNIQUE costs a constant or a column more; the shared one where
  several targets fix a field to different values, or where both cost the same.
- **Coverage.** A coverage's target needs a no-overlap key over its span, or the schema is refused: coalesce the spans,
  or key them.

A write that breaks a rule comes back as an outcome that names the rule, never as a message to parse.

### Rules over queries

A rule's side may be a derived relation, a query the schema names. A content package's resource may have an href, a
type, both or neither, each stored on its own, and the rules about a resource's href and its type together hold where
it has both:

```ts
import { derived, query, v } from "@bjornpagen/grizzle"

/** A resource's identifier, as its package's manifest names it. */
const ResourceId = str.regex("^[A-Za-z_][0-9A-Za-z_.-]{0,63}$")

/** A content package's resources, each with an href and a type, either of which it may lack. */
export const Resource = relation("Resource", { id: ResourceId }, ["id"])
export const ResourceHref = relation(
	"ResourceHref",
	{ resource: ResourceId, path: Title, internal: pg.boolean },
	["resource"]
)
export const ResourceTyped = relation("ResourceTyped", { resource: ResourceId, type: Title }, [
	"resource"
])
export const PackageFile = relation("PackageFile", { path: Title }, ["path"])
/** A catalog record of a resource, naming its href and its type. */
export const CatalogRecord = relation(
	"CatalogRecord",
	{ resource: ResourceId, path: Title, type: Title },
	["resource"]
)

export const Content = schema(
	"Content",
	[Resource, ResourceHref, ResourceTyped, PackageFile, CatalogRecord],
	[
		contained(on(ResourceHref, "resource"), on(Resource, "id")),
		contained(on(ResourceTyped, "resource"), on(Resource, "id"))
	]
)

/** The resources that have both: a join, which no table stores and no write keeps. */
export const TypedHref = derived(
	"TypedHref",
	query(Content).rule((r) => {
		const { resource, path, internal } = v(ResourceHref, "href")
		const { type } = v(ResourceTyped, "typed")
		return r
			.match(ResourceHref, { resource, path, internal })
			.match(ResourceTyped, { resource, type })
			.find({ resource, path, internal, type })
	})
)

/** The typed hrefs of items. */
const items = select(TypedHref, (t) => t.eq(t.type, "item"))

export const ContentPackage = schema.extend(
	[Content],
	"ContentPackage",
	[TypedHref],
	[
		check("ItemsInside", TypedHref, (t) =>
			t.not(t.and([t.eq(t.type, "item"), t.eq(t.internal, false)]))
		),
		contained(on(items, "path"), on(PackageFile, "path")),
		contained(
			on(CatalogRecord, "resource", "path", "type"),
			on(TypedHref, "resource", "path", "type")
		)
	]
)
```

A typed href is a resource with both parts. An item's href is inside the package and names one of its files, and
every catalog record names a typed href as it stands. A resource with an href and no type, or a type and no href, has
no typed href, so none of these rules asks anything of it. No table holds a copy of the join for the rules to read,
and no write keeps one in step: `derived(name, query)` stores nothing, and a query that matches `TypedHref` reads its
definition too.

- **What a side's query may be.** Matches, `where` conditions and the head's fields: joins, selections, projections
  and semijoins, a union of such rules, and negations. `r.not(Q, …)`, alone or inside `r.and([...])`, negates a table, a
  query of such rules or a derived relation whose query is one, which may negate in turn, so a rule can read "the rows
  of R with no S", "the rows of R that no join of S and U names" and "the sittings no ending and no standing
  invalidation names", an invalidation standing where no reinstatement names it. A negation of a union negates each of
  its rules. An aggregate (`r.count()`, `r.min(x)` and the others) is read by a unit-local rule, below, and by a rule
  its probes judge where the law reads it inside one unit: its terms hold the unit fields of every relation the
  aggregate's body matches, so a probe folds again only groups whose rows one unit holds. Any other is refused
  (`UnsupportedLawFamily`), naming the relation whose unit is left free and the remedy: where the groups span units, as
  a count of every learner's attempts at an item does, group within a unit, adding the unit's fields to the grouping;
  where the groups lie inside one unit and the law's terms leave it free, as a key at the item alone over each learner's
  count of an item does, bind the unit's fields in the law. Its probe would fold every group at its terms again at each
  write, work that grows with the units. A query that reads it is untouched, and so is a law over a derived relation
  that aggregates nothing at terms that leave its unit free, a chain of keyed reads from its terms. A recursion and a
  text's tokens, pieces, rest, decoded path, target within a base and split at its last separator (`r.tokens`,
  `r.split`, `r.rest`, `r.decodedPath`, `r.resolvedWithin`, `r.splitLast`, [Text](#text)) are read by a unit-local
  rule, below, and refused in any other: a split as `UnsupportedLawFamily` naming what the query does, and a rule over
  a recursion as `Refused`, naming the unit-locality it lacks. `orderBy(...).take(k)`, `attach` or an
  approximate search, in the query or in a query it negates, are refused the same way (`Refused` over a derived
  relation, its refusal the type error's words), and a type error where the query does it itself. A family and a fold
  read tables only. Every value a rule reads is immutable: a stable function's call (`Fn.call`,
  [Calling a function](#calling-a-function)) or a conversion that reads a setting of its session, as int4's to money
  reads `lc_monetary`, can turn the rule's verdict with nothing written, which no judge sees, so a rule whose violation
  reads one is refused (`UnsupportedOperation`, naming the rule), judged whole or by its probes alike.
- **A probe reads each relation with the polarity of the negations above it.** A rule that is not unit-local is judged
  from the rows a transaction wrote (below): a row a relation gains under no negation, or under two, can add facts of
  the side that reads it, and a row it loses under one negation can, and the judge probes exactly those, a target's the
  other way round. `key(on(Active, "student", "form"))`, `Active` the sittings no ending and no standing invalidation
  names, is so judged from each sitting a transaction adds, each ending or invalidation it deletes and each
  reinstatement it adds: each probe reads `Active` at that sitting's student and form, through the index the law model
  plans over `Sitting`'s `(form, student)` and the keys of `Ending`, `Invalidation` and `Reinstatement`, one student's
  sittings of the form and never the table, its work the same however many students the tables hold. Two
  transactions that each make one such sitting active, each alone keeping the key, read at COMMIT each other's writes
  under SERIALIZABLE, so PostgreSQL commits at most one of them and fails the other with 40001.
- **An order across relations is a row check over their join.** A sitting's visits lie after its start and, once it
  has one, before its end: `AfterStart` derives each visit beside its sitting's start, `check("VisitAfterStart",
  AfterStart, (s) => s.ge(Range.lower(s.during, Seconds), s.at))`, and `BeforeEnd` each visit beside its end, its
  check `s.le(Range.upper(s.during, Seconds), s.at)`. A sitting with no end has no fact of `BeforeEnd`, so its end
  bound asks nothing of it: an open interval is the absence of its end, never a span unbounded above, and every span
  stays bounded and non-empty. The judge holds each bound at COMMIT, whether the transaction writes a visit, a start or
  an end, and the host judges a row of either as PostgreSQL does (`rowEvaluator`).
- **Unit-local rules are judged whole.** A rule is unit-local when every stored relation its query reads is immutable,
  or every one sits in one declared unit whose key leads its own (`unit(...)`: every write of their rows, a mutable
  relation's updates and deletes among them, borrows that unit, and an update of a column the rule reads is captured
  as any write is), no field it reads one grizzle rewrites in place (a member's copy of a mutable owner's column), and
  leads its primary key with the same fields, its unit key, and its query joins within one unit: every match of a
  stored relation, in every rule of its violation query at any depth, binds those fields to the same variables, every
  negation is correlated at them, and every aggregate's groups hold them. A content package's relations keyed
  `(package, path, …)` are one such family of units, each document a unit. Every fact of such a rule's violation lies
  within one unit, so a write changes the rule's verdict only within the units it writes, and the judge reads the
  rule's violation query, the one the migration that adds the rule runs, over the units the transaction wrote alone:
  once, set-based, whatever rows of them it wrote, never a probe per row. The outermost rule of the query that binds a
  unit, from a table it matches or a query that delivers one, reads it once per written unit, as a LATERAL subquery at
  that unit's key, and every rule it reads through a query it joins or negates reads that same unit's rows, so the
  unit is bound once: every read is an index range at the unit, an aggregate groups that unit's rows alone, a negation
  reads the written units' rows whether PostgreSQL probes it or hashes it, the work grows with the units written and
  never with their square, and no estimate PostgreSQL makes, with statistics or none, widens a read past the written
  units. Within the unit, a rule that joins, or negates a query that joins, is read as a chain of lookups, as a probe
  is: each relation it reads, a derived relation's definition included, by the columns the unit and the reads before
  it bound. A dependency's negation of a derived join of its node and the resource its ref names reads that node and
  that resource by key at the dependency's row, never the two joined at `(package, path)` alone and filtered after,
  which PostgreSQL, estimating every read at one row on tables no ANALYZE has run on, nests once for each dependency.
  A definition that joins and that the rule reads more than once, counting the reads of the definitions that read it,
  is read whole instead, once per unit: a `MATERIALIZED` CTE inside the unit's LATERAL subquery, read at the unit's
  key, every read of it a join of its rows. A chain of definitions each reading the one below it twice is then one
  CTE a level, where a chain of lookups at every read doubled the statement, its planning and its reads at every
  level: edullm's assembled-catalog rules were one statement of 3798 SELECTs reading one table 1186 times, whose
  planning at a session's first COMMIT took 12.4 GB.
  The unit is as narrow as the rule's joins allow: a rule over one relation's rows by their whole key is judged a row
  at a time. Whether a rule is unit-local is decided when the schema compiles,
  from its query; any other rule is judged by its probes, below. Its outcome and its law are the same either way.
- **A recursion is unit-local** when its row carries the unit: every base rule delivers it from a stored relation's
  leading key fields, and every recursive rule binds self's unit fields and those of every relation it matches to
  the same variables and delivers them at the same fields, a derived relation it matches read through its definition.
  Every state is then derived from a seed by steps that keep its unit, so the states of one unit are the fixed point
  of the seeds at that unit, and the judge reads the recursion once per written unit, its base and each of its steps
  at that unit's key. A recursion that follows a link into another unit, as a lineage of versions across packages
  does, is no unit's, and a rule over it is refused: no probe reads a recursion.
- **The cost of a unit-local rule** is a read of each unit the transaction wrote, whole, once per rule. A write of
  whole units, as a content package's publish is, reads the rows it wrote once more for each rule. A write of a sliver
  of a large unit, one row into a package of thousands, still reads the whole unit for each rule that reads that row's
  relation: a relation written row by row into large units is better declared in a unit of a longer key than the one
  its rules join within, where no borrow of one of its units covers a rule's unit, so its rules are probed.
- **A unit-local containment with a selected side is the judge's.** A containment between two tables is a foreign key;
  one whose side is a selection, `on(select(T, φ), …)`, is a foreign key over STORED generated columns
  (`CASE WHEN φ THEN key END`), the UNIQUE it references and an index, kept on every row of the table. Where its tables
  are immutable, or all in one declared unit, its two sides join within one unit and each selection compares fields with
  literals (`eq`, `in`, ranges, `and`, `or`, `not` and a closed relation's constants), the judge holds it instead: no
  column, no UNIQUE, no index and no foreign key. Over immutable tables, at COMMIT each row the transaction added to its
  source, and each source row at the fields of a row it took from its target, probes the target at those fields, a
  lookup of its index whatever the unit's size; over a declared unit's mutable tables, whose rows change in place, it
  reads every row of each unit the transaction wrote, as a whole rule does; either way a broken one is refused with
  23503 naming the containment. It is the same law, with the same identity and the same evidence; it holds at COMMIT
  rather than at each statement. A query's rewrite reads a containment's evidence from the law itself, whatever
  discharges it, in the context its discharge holds it in: at every statement for an immediate foreign key, in a
  committed snapshot for a deferred one or the judge. A containment of two unselected sides into a target a key holds
  apart, at a declared key's fields or a superkey's: its foreign key is the same law, its source's fields NOT NULL, so
  MATCH SIMPLE checks every source row, into that key's UNIQUE or one over the superkey, which the key implies, so the
  rows a source row's values find are exactly the target facts the law asks for. It adds no column, a written row costs
  one probe of an index, and its writers keep the isolation a foreign key admits ([READ COMMITTED
  writes](#read-committed-writes)), where a rule the judge holds keeps most of them SERIALIZABLE; it holds at every
  statement where it references every field of its target off a cycle, and at COMMIT where its target holds a field it
  does not reference. So does one whose selection computes (a pattern's match, an arithmetic), whose generated column a
  query cannot always restate, and any containment over a mutable table outside its sides' one declared unit. A
  containment into a target no key holds apart, such as `on(T, "unit", "kind")` with T keyed by `(unit, id)`, has no
  UNIQUE grizzle may add, one over its columns refusing rows the schema admits: the judge holds it where it is
  unit-local as above, and it is refused (`UnsupportedLawFamily`) anywhere else. A migration that moves a containment
  from its foreign key to the judge checks no row: the foreign key held this very law on every write.
- **Judged live.** A rule reads its query as the tables stand at commit, a stored derived relation's table as its
  upkeep left it there included: the judge keeps every stored relation first, then judges the rules. A key or a check
  over a stored relation refuses there, at its table's UNIQUE or CHECK, and a served write refused so is
  `invariant-rejected` naming the law, as a write of the relation's holders changes the relation by its COMMIT.
- **A check the schema proves emits nothing.** Before a probe of the rows a write adds to a relation R is built, each
  occurrence of R in each arm of the rule, at any depth (a definition's rules, a fold's body, a negated query's arms),
  is put to the schema's containments, stated or composed, its keys and its closed relations. Where a stored relation
  S matched beside it is contained in R, `S(F) ⊆ R(G)`, and the arm binds each field of G it pins to the variable S
  binds at its pair in F, a row R gains opens no fact there that the rule's other probes do not judge: beside a row of
  S the transaction added, S's own probe reads the fact; beside one that stood, R held a row at G before the
  transaction. Where every field the occurrence reads of R is among G, that row gives the same fact, which held then.
  Where only a key of R is among G, R must be closed: no served write removes a row of a closed relation, so the row
  that stood at the key stands, and a row a served write adds is of a new key, whose children stand only where the
  same write creates them. A mutable R is covered at no key, a row it gains there one that may replace the row that
  stood. So the probe of a new sitting's rows beside its children, which pin it, is no block, no statement and no
  plan; an insert of a relation no other probe reads is captured by no rule; and the rows a write removes of a closed
  relation, which no served write does, are captured by no rule and read by no judge or upkeep: a migration's data
  step, which lifts the guards, re-checks every rule and stored relation over an immutable relation after it
  ([Migrations](#migrations)). Two more losses are proved empty. A containment's target that reads its own source at
  a key, `Assignment ⊆ AssignmentStatus` where the status of an assignment with no event reads the assignment itself,
  loses no fact by a row the source loses: the fact it withdraws needed that very row, so no rule reads the rows the
  source loses there. And a target's arm that negates a row of an immutable relation R, an open candidate session
  being one with no end, loses nothing to a row R gains where a sibling arm reads the same matches, conditions and
  negations, R at exactly the negation's fields, and R's instants only as no earlier than an instant of the arm's
  rows on the same clock at the same key (the ended session's arm, `response.at <= end.at`): every writer stamps a
  new row of R at its unit's clock, after every row it reads there, so the sibling regains every fact the arm loses,
  and no probe reads the rows R gains for it ([Instants](#instants)). A sibling that reads R at another field too, the
  end's kind, regains nothing, and its rule reads them. Each match is covered
  by one sibling, assigned in its arm's order so that no chain of covers reaches back to it: a chain of containments
  keeps its last link's probe and a cycle one link's; a containment no schema states proves nothing, however a
  procedure keeps it. The decision is the compiler's, made when the schema compiles, never a skip at run time, and
  snapshot.json records it under `derived.proved`: each rule by its law, each relation a cover spares, each cover by
  its sibling, its containment's pairs and what it pins (`read`, every field read; `fresh`, a key of a closed
  relation), or a sibling arm's regain (`clock`, the negation's fields and the instants it reads), and the sides of
  the relation a block still reads. On edullm's bar, a start's probes of qti-pie's
  "Suspended in time" over its new sitting, candidate session and item sessions read about 450 pages each and planned
  for up to 750 ms in a fresh session, all of it for rows no pause could stand beside; the rule holds none of them, and
  its probe of the pause a later write adds judges it.
- **What PostgreSQL gets.** A rule that reads only tables is a constraint, as above. A rule that reads a query is
  judged once per transaction, over the rows it wrote: a unit-local rule over the units of those rows, any other over
  the rows themselves. On each table the query reads, an AFTER statement trigger for
  each write that can break it copies the statement's rows into a temporary table of the session, `ON COMMIT PRESERVE
  ROWS`, which the judge empties once it has read it, so no COMMIT truncates one. A session makes those tables once,
  before its first write of the table, by the table's stand-up, a SECURITY DEFINER function every role that writes the
  table may run ([Writes](#writes): a served write's session calls it itself, for each table it writes that a rule of
  any level of the installation reads, a level above its login's among them; a direct writer calls it, as in
  [Direct SQL access](#direct-sql-access)), so no write's transaction makes a relation, and the plans it makes outlive
  it (PostgreSQL truncates every `ON COMMIT
  DELETE ROWS` table of a session at each COMMIT that touched a temporary table, a lock and invalidations each): for a containment,
  a write that adds rows to its source or takes rows from its target, and so also a delete from a table its source
  negates and an insert into one its target negates. The rows a transaction adds are kept as its net write: a delete,
  or an update of a column a rule reads, of a row it added cancels the row there, so the judge reads each added row as
  the transaction leaves it and never reads it again from its table. The copy arms a deferred constraint trigger,
  `DEFERRABLE INITIALLY DEFERRED`, whose function, the judge, runs at COMMIT: each rule's violation query, compiled by
  grizzle's own query compiler, read once over every row the transaction wrote, a chain of index lookups from the set of
  bindings those rows give it, each binding read once however many rows give it, or, for a unit-local rule, over the
  set of the units those rows hold. It raises 23503 for a containment, 23505 for a key and 23514 for a check, naming the rule. A
  transaction runs only the rules over the relations it wrote: the judge reads once which of its temporary tables the
  session holds, a part of the judge reads once which of its own hold a row, and a rule runs where a table its
  violation query reads holds one, over tables that hold none its region being empty. The rules stand in parts, a
  function each, the classes of the rules that read a temporary table in common, and the judge runs a part only where
  the session holds one of its tables, so a session compiles, plans and runs only the parts of the relations it writes:
  a learner's answers never run or plan the rules of a content package. Each rule's
  statement over a side is a function of its own, which its part calls where a table it reads holds a row, so a
  session compiles the statements its writes run alone: a learner's save compiles its five, never the other seventy of
  the learner's part. A stored relation's upkeep stands so too: a unit form's statements in one function, a delta form's
  removal of the facts a write withdraws and its insert of those it gains in one each, the removal first, each called
  where a table its own statements read holds a row, so a write that only adds rows never plans or runs the removal,
  nor locks the stored table it seeks. After `SET
  CONSTRAINTS ALL IMMEDIATE` the judge runs at the end of each statement. The functions are SECURITY DEFINER on a
  pinned `search_path`, no role may run them but a table's stand-up, which each role that writes the table may, and a
  temporary table another role made under the judge's names is refused.
- **Plans.** Each lookup of a judged statement's chain, a probe's after the rows the transaction wrote and a
  unit-local rule's within its unit, is a read of one table at the columns the steps before it bound, so no estimate
  turns a join the judge reads into a product it filters after.
- **Outcomes.** A write's `once` fails with `refused` naming the rule, its witness `unreported`: the row that breaks
  it may be one the transaction never wrote.
- **Concurrent writers.** Every writer is SERIALIZABLE, so PostgreSQL orders the judge's reads against the writes
  it does not see: two transactions that each keep a rule and together break it never both commit, and one fails with
  40001.
- **Migrations.** A migration that adds a rule over a query, or changes one, checks it over the stored rows, and fails
  where a row breaks it, as it validates a foreign key. The check is the judge itself, over the transaction that would
  write every stored row into an empty installation: the same chain of index lookups, from every row where the judge
  starts from the rows a transaction wrote, so its work is linear in the rows it reads whatever PostgreSQL estimates of
  them. The check's identity is the rule's meaning over what it reads, never its SQL: the rule, the definitions it
  reads, of each table the columns it reads and the key, and of each closed relation it reads by `C.at`, `C.has` or
  `C.row` the facts those read, its key set and each payload field a `C.at` reads. A draft proves, as it is generated,
  whether a migration keeps that meaning: one that only changes how grizzle lowers the rule, drops or renames a column
  the rule does not read, or changes a closed payload it does not read, keeps it, so the proof the rule's earlier check
  made of the stored rows still stands, and one that changes the rule, a definition, a column it reads or a closed fact
  it reads (a seat count lowered under the live holds it bounds) states a new identity, which its check proves over the
  rows. The proof is of the values the rule read, so a migration that writes again a column it reads checks it again
  too, whatever its identity: a generated column re-expressed (SET EXPRESSION, a closed row its generation reads among
  the causes), converted, or dropped and added again, and a column a family's backfill draws again, none of which the
  rule's triggers see. A stored derived relation above such a column's table is created again and filled for the same reason.
- **TRUNCATE** fires no capture, so a rule over a query does not judge a TRUNCATE of a table it reads, and judges
  the rows a transaction added to it before a TRUNCATE as if they stood. grizzle never truncates and no role may; a
  direct writer who truncates such a table answers for the rule itself.

### Families

A family is a rule over rows the caller writes: each owner's members, counted by a drawn field of the owner.
`fin(O, "n")`, a family's second argument, is the slots of O's drawn count `n`, never a side or a table.

A family's count and an ordered family's index are of one type: `drawn(natural)`, or `drawn(c, key)` for c a contract
over an integer under its key, `drawn(TestNumber, testNumberKey)` of
`contract<typeof testNumberKey>()("TestNumber", pg.integer, (n) => Logic.and([Logic.ge(n, 0), Logic.le(n, 2147483647)]))`, which
stores them in c's column, an int4 here, so a field of c elsewhere is contained in the indexes and they in it. An index
and a count of two types are refused when the schema compiles (`an ordered family's index is of its count's type`), and
`drawn` of any other type is a type error. A count past c's bound is `refused` on c's contract: past its CHECK by the
CHECK, and past its carrier, smallint's 32,767 or integer's 2,147,483,647, by the family's statement where it draws a
stored group, and as its input (`integerRange`) before any statement where the host draws a fresh one. No drawn value is
ever wrapped. pred reads a natural alone.

- **`ordered(on(F, g…, "at"), fin(O, "n"))`**: each owner's members, their group `g…` paired with O's primary key,
  indexed by their drawn `at` exactly 0 … n − 1, in order.
- **`counted(on(F, g…), fin(O, "n"))`**: each owner's `n` members, their group `g…` naming the owner by O's primary
  key: an unordered set, one row per member key. Its index is hidden from every field, fact and query: a coordinate,
  never a multiplicity.
- **`tree(on(T, "parent", "at"), fin(T, "children"), { root: ["doc"] })`**: T over itself, keyed by its root fields
  then its drawn `start` (here `["doc", "start"]`; `{ root: ["package", "path"] }` keys T `["package", "path",
  "start"]`), with drawn `parent`, `at`, `children`, `start` and `end`. Each value of the root fields is one tree: its
  root is its row at start 0, its own parent, every other row is a member of its parent's ordered family, `parent` is
  its parent's start in its own tree, and `[start, end)` is each row's pre-order interval. PostgreSQL's own constraints
  keep each tree one tree, every row reachable and none on a cycle, each constraint led by the root fields. The primary
  key `(doc, start)` is the document order: a document in order is one scan of it, and a row's descendants, its tree's
  rows whose `start` lies in its interval, one range scan, with no recursion. A fold over the tree steps on
  `on(T, "doc", "parent", …)` and ends on `on(T, "doc", "start", …)`; a copy down the tree is
  `contained(on(select(T, (t) => t.gt(t.start, 0n)), "doc", "parent", "x"), on(T, "doc", "start", "y"))`, `x`
  accumulated: the root, which has no parent, holds `x`'s start.
- **A chain is a fold whose step is a field.** A copy may read a field that reads the copy back through its row, a
  generated field over it: `was` accumulated from the predecessor's `state` along
  `contained(on(F, "o", pred("at"), "was"), on(F, "o", "at", "state"))`, `state` generated from `was` and the row,
  holds at each member the step applied to every member before it, from `was`'s start at slot 0; a copy down a tree of
  its parent's generated field so folds down the tree from the root's start. grizzle draws a chain as any copy, on
  every write, and in SQL one member after another.
- **`fold(family, Monoid.m, step, end)`**: the members' step values, `step` a side of the member, combined by the
  monoid into the owner's `end` fields, each `accumulated`.

An ordered family or a tree is a sequence. The monoids:

| Monoid          | Step value                                                           | Identity               |
| --------------- | -------------------------------------------------------------------- | ---------------------- |
| `Monoid.count`  | none; the end is a `natural`                                         | 0                      |
| `Monoid.sum`    | an integer type or a numeric, summed exactly; no float or money      | 0                      |
| `Monoid.or`     | a set, by union                                                      | the empty set          |
| `Monoid.twos`   | a set; two planes, the handles seen at least once and at least twice | the empty set, twice   |
| `Monoid.max`    | an integer type, a closed id or money                                | its type's least value |
| `Monoid.concat` | text, each step after the running text                               | the empty text         |

- **Accumulators and ends start at the identity**, which an empty family's end holds. They are of the step value's
  type, each with its own text pattern and byte bound: concat's pieces may be any text, generated or written, and its
  accumulators of a pattern of the text they spell. Each one's domain checks every value grizzle fills into it: a
  value outside its pattern is `refused` on that pattern's rule. Another integer width, numeric typmod or
  contract is another type, and such a fold is `Refused` when the schema compiles.
- **Running values.** A fold over a sequence may name each member's running `before` and `after`; one over a counted
  family names only its step value and end, its order being hidden. concat folds only a sequence, and names its pair.
  The family's axes key each running text: one that fits the axes' UNIQUE beside their other columns rides them as
  itself, and a fold refused for one names the largest byte bound that fits ([Limits](#limits)).
- **A running text of any length rides the axes by its digest.** Declare each running text's SHA-256 digest, a
  generated field `Crypto.sha256(row.v)` over the accumulated text `v`, and name the digests in the fold where the texts
  stand: `fold(lines, Monoid.concat, on(Line, "doc", "piece", "beforeDigest", "afterDigest"), on(Doc, "id",
  "textDigest"))`. The texts stay the fold's values, filled by grizzle and proved by its CHECK and pins, and PostgreSQL
  stores each digest beside its text; the predecessor axis pairs each member's `beforeDigest` with its predecessor's
  `afterDigest` and the last axis the owner's `textDigest` with its last member's `afterDigest`, so a text is its
  predecessor's after wherever their digests are equal, short of a SHA-256 collision. A plane's before, after and end
  name their digests alike or none; any other generation is refused, since only a digest's equality is its text's.
- **A separator belongs to the step**, never to the monoid: write each member's token with the separator before it,
  except at index 0, and the end is the tokens joined by it.

A relation is a member of at most one sequence, which orders it, and of any number of counted families, each with its
own hidden columns and foreign keys. A counted family's member may also be a sequence's member or owner, or a tree's
node. One count counts one family. Ordered families that nest each other in a cycle, an ordered family of a relation
over itself among them, are refused when the schema compiles (`UnwritableRelation`, `nestingCycle`), and so are
families, ordered or counted, that nest relations in a cycle below a relation that owns a family and is no family's
member (`unitCycle`): a delete of that relation removes every row nested under its rows, and through a cycle a row may
be nested again under another of them or another unit's, so no delete could remove its groups whole. A family's or a
tree's member side is a table, never a selection: `counted(on(select(Ticket, φ), "show"), fin(Show, "tickets"))` is a
type error, and from JavaScript refused when you build it. A fold's step may still select the members it reads.

grizzle owns every value a family holds: each count, index, interval, copy and accumulator is drawn by grizzle on
every write and proved by PostgreSQL, never written by the caller. A fold's running `after` is no generated column:
grizzle fills it and `CHECK ((after = combine(before, x)) IS TRUE)` proves it in exact arithmetic, so a sum is never
narrowed into its column's type unproved.

Each group is drawn by one engine of one set of fill rules. A sequence's members, nested under their owner, are drawn on
the host as the write walks them. A counted family's group is fresh where the write inserts its owner and stores none of
its members: the call holds the group whole, so the host draws it, the owner's count and ends and every member's index,
copies and fold planes, and the write inserts the members as drawn. Every other group holds a stored member or a stored
owner, which only the database holds, so the family's statement draws it in SQL, by a window over the group in slot
order, past its stored members. Whether a group holds a stored member is a fact of the database, so the statement
decides it as it runs: an exact repeat of a stored owner beside an append to its group is drawn in SQL past the stored
members, as any append to a stored group is, and under a closed owner refused by the family's count, as before. Where
the closed owner restated holds the very count the host drew, the new member meets a stored member at its family's
slot, and the member's insert, which takes every row it meets as data rather than an error, refuses it on that
family's rule in its own statement, witnessed by the member's key, in the call's one round trip.
A fresh group's members are walked in their key's order, each key field by the host's order of its values, which is
PostgreSQL's `ORDER BY` of them (test/pg/values/order.test.ts holds the two equal for every type), so a member's hidden
index is the one the window gives it, and a migration that draws a family over stored rows draws the same values again.

#### Writing a family

- **A sequence is written nested**: its members under their owner, in order, at its count field, without their group
  and drawn fields: `insert(Order, [{ id, n: [{ qty }, { qty }] }])`. No tree row names its key or its `parent`, and only
  the root names the root fields: `{ doc, children: [{ children: [] }] }`. A nested member, at any depth, states no
  field its nesting supplies, grizzle draws or accumulates, or its relation lacks: a type error, and from JavaScript an
  `EncodingFailure` (`factShape`) before any SQL. An ordered member inserted alone is a type error. A tree is written
  whole: a put of one of its rows is a type error, and from JavaScript refused when the ChangeSet compiles.
- **A group is deleted whole, through its owner.** A delete of a tree names trees by their root value,
  `delete(Node, [{ package, path }])`, and a delete of a relation that owns a family and is no family's member names its
  rows as any delete does; each removes its rows and every row nested under them, through every family, to any depth:
  the members of each family the removed rows own, the rows those own, and a tree's every node. So no count, index,
  fold end or tree interval ever describes a partial group, and the delete is of open relations alone, its own and every
  one it removes rows of, a closed one refused when the ChangeSet compiles, by name. Its
  rows may come from a query, as `delete(Node, query(…).find({ package, path }))`. Its write list names every
  relation it removes rows of. A delete of a tree whose nodes are another family's members is a type error, and so is a
  put or a delete of a family's member that owns a sequence, and a put in its stratum of the relation it deletes or of
  one nested under it, before or after the delete or through a union. Refused when the ChangeSet compiles: a delete
  whose nested rows include a member of a family whose owner it does not remove; one through a query entry. Families
  that nest its relations in a cycle are refused earlier, when the schema compiles. A delete of a family's member beside it in one stratum removes that member's
  named rows too, as an edit of its family after the whole delete: a row inside the deleted groups is gone already,
  one outside them is removed as any member's is. A delete of any other family's member is an edit of its family, as
  before.
- **A replace is a delete and an insert in one stratum**: `ChangeSet.empty(S).delete(Node, roots).insertAll(rows)`.
  The delete runs first, as one statement, so the inserts meet no stored row at a key it removed, and the outcome is
  the difference of the two states: an identical replace answers `no-change`, and the counts are the rows each
  relation lost and gained. A row the replace adds again unchanged is never written: the delete keeps it where every
  column grizzle draws on it is the same, every owner of it is kept, a counted family's group is the same set of rows,
  and every row before it in its sequence, and every node on its tree path and before one of those among its
  siblings, is kept too. So a replace that changes one value rewrites that row's group from its first changed row on,
  and leaves every other row in place. A delta of a relation the delete removes rows of is refused when the ChangeSet
  compiles (read the relation itself after the change).
- **A put and an insert of one sequence owner at one key in one stratum are two rows** at that key, since the insert
  states the owner's members and the put leaves them as they are. They are `refused` on the key before any
  SQL is sent; at different keys each is written.
- **A counted member is a row**, inserted, put and deleted like any row, its group key naming its owner. One that is
  also a sequence's member or a tree's node is inserted nested there, stating its counted group key; one that owns a
  sequence is inserted with that sequence's members nested under it. grizzle reads each of its counted families'
  stored groups and appends it there, as it does a row inserted on its own.
- **A change rewrites what it shifts.** Each change to one owner's family is one edit of it. An append takes the slots
  after the last; a counted member's removal moves the last member into the freed slot and refills from there; an
  update that changes a step value, or a value a selection or a copy reads, refills from its slot; one that changes
  the group key leaves the old owner's family and joins the new one's; any other update is in place. In an ordered
  family an insertion or a removal rewrites the later siblings, so a change near the start of a long family costs the
  members after it. An edit of an owner already stored reads its stored values first
  ([Transactions and concurrency](#transactions-and-concurrency)).
- **A changed owner column reaches its copies.** A put of an owner updates its row in place, and an edit of one of its
  families its count and ends. A member's copy of a changed column follows by cascade; a member appended in the same
  ChangeSet takes the new value.
- **A value drawn from a changed column is refilled.** A fold's step or selection, a predecessor or last copy, and a
  tree node's copy of its parent's are drawn when their row is written. A put of a relation no family has as a member
  that changes a column one of them reads, on a stored row, through such a copy, refills that value's family: grizzle
  finds every group the change reaches along the copies that carry it, draws each value there again and rewrites those
  rows in place, members first, before the change cascades into them, so a fold's CHECK holds at every statement, and
  the same ChangeSet may put, delete and append those members too. A family member's own write refills two values only:
  its re-placed rows' copies that its owned families' members hold, and the copy of a count or an end its own family's
  stored members hold, which an append recounts. Any other value a member's put, delete or append reaches, through an
  owner axis or as its owner's count or end, is refused when the ChangeSet compiles (`StaleDerivedRead`, cause `edit`).
  A value that reads what a refill itself changes, an owner's ends or last copy or a member's predecessor copy or fold,
  is not refilled in turn: such a change is refused when the ChangeSet compiles (`StaleDerivedRead`, cause `chained`). A
  tree's values are not refilled either: a node's copy of its parent's, a sibling's predecessor copy or fold, and a
  parent's ends and last copy are drawn only when the node is written, so a change that reaches one on a stored tree is
  refused when the ChangeSet compiles (`StaleDerivedRead`, cause `tree`).
- **A re-placed row is drawn whole.** A put that moves a member to another group or changes what its ordered family
  reads of it, and a delete of an ordered family's member, delete rows and insert them again, which no cascade
  follows. Every family the re-placed rows own is refilled where its members copy a column the ChangeSet changes
  there, the count among them, and each re-placed row is drawn with its owners' values as the ChangeSet leaves them.
- **Some axes are checked at commit**, decided once for the schema: the owner axis of every family, a tree among them,
  whose members a refill can rewrite or whose owner a put or a delete can re-place, and the predecessor axis of every
  sequence a refill rewrites.
- **A refill is planned in the first stratum**, beside every edit of a family's members; a ChangeSet that needs one
  elsewhere is `UnsupportedOperation` when it compiles. A refill is refused when the ChangeSet compiles
  (`StaleDerivedRead`) only where grizzle cannot draw it: a put whose rows a query states; refills that reach a family
  they refill again; a refill of a closed relation's rows or a closed owner's family; a refill of a tree's
  values; a refill of a value that reads what another refill changes; a refill of a value a family member's own write
  reaches beyond the two it refills; and a refill no statement of its stratum draws: a put's cascade that passes a
  member the same stratum puts or deletes (cause `passed`), a member's write whose refilled member the same stratum
  puts or deletes (cause `rewritten`), and a member the edits of two relations reach (cause `edits`). Every refill is
  drawn by the write's own statements, in process exactly as in a served file. A role refills only relations it holds
  whole: the members it rewrites in its `write` list, and every relation the refill's cascade passes among its entries
  (`OutsideRole`).
- **A closed owner's family is fixed when the owner is inserted.** Declare the owner open, `mutable(Owner)` inside its
  unit, for a family that changes later, or an owner you put. A delete of a member of a closed owner's family and a put
  or a delete of a closed owner are type errors, and from JavaScript refused when the ChangeSet compiles; a delete of an
  open owner removes its family whole, every member open too. An insert of such a member in a
  stratum that inserts no such owner is a type error where a workload declares the ChangeSet, since a later insert or
  a union may still add the owner. One that names a stored closed owner in a stratum that inserts others of its
  relation, or restates it, is `refused` `every` on the family's rule alone, the owner standing and every containment
  into it holding, witnessed by the member's key.
- **A ChangeSet writes family members in one stratum**: writing them in a second is a type error at the call that
  makes it, and from JavaScript `UnsupportedOperation` when the ChangeSet compiles.

### Units

A unit is the key a family of rows sits under: a sitting, a learner, a package, a step of a workflow. Each value of
it is one lock: a ChangeSet that writes a unit's rows holds their key exclusively, from before its first read until it
commits; one that reads a unit's rows and writes none of them holds the key shared; and calls of different keys never
meet. That is what lets every write run READ COMMITTED: a read inside a unit the call holds sees each earlier holder's
commit and no concurrent writer, and a law whose rows stay inside one unit is judged with none. `unit(name, heading)`
among a schema's statements declares one:

```ts
/** An assignment's number, a sitting's key: a contract of its own, so no other number leads a key with it. */
const assignmentNoKey = Symbol("AssignmentNo")
const AssignmentNo = contract<typeof assignmentNoKey>()("AssignmentNo", pg.bigint, (n) =>
	Logic.ge(n, 0n)
)

const Assigned = relation("Assigned", { number: AssignmentNo, test: TestId }, ["number"])
const ClockOpened = relation(
	"ClockOpened",
	{ number: AssignmentNo, at: instant, question: QuestionId },
	["number", "at"]
)
const Invalidated = relation("Invalidated", { number: AssignmentNo, at: instant, reason: Reason }, [
	"number",
	"at"
])
export const Assignments = schema(
	"Assignments",
	[Assigned, ClockOpened, Invalidated],
	[
		unit("Sitting", { number: AssignmentNo }),
		contained(on(ClockOpened, "number"), on(Assigned, "number")),
		contained(on(Invalidated, "number"), on(Assigned, "number"))
	]
)
```

- **Its members are inferred from their keys.** Every stored relation whose primary key leads with the heading's
  fields, by name and type in order, sits under the unit: above, `Assigned`, `ClockOpened` and `Invalidated`, and
  every relation keyed `(number, …)` by an `AssignmentNo`, in this schema or any level above it, which states nothing
  more. No relation is listed, so none that leads with the key can be left out, and a unit's rows lie in one index
  range of each member. A relation keyed by its fields in another order, or by other fields, is no member.
- **An open relation sits in a unit.** A relation is closed by default, its facts inserted, never changed or deleted;
  `mutable(R)` opens it, and is admitted only where R's primary key leads with a unit's heading, so its every update and
  delete is a write of its unit's rows, held under the unit's exclusive borrow. `mutable(R)` over a relation that sits
  in no unit is refused when the schema is built, in the types and by the engine, by name: declare the unit its key
  leads with, or keep R closed and record each change as a fact inserted.
- **Give its key a named domain.** A field of the same name and type that means something else, a user's `number`
  beside an assignment's, joins the unit all the same. That is never wrong, since every writer and reader of the row
  takes the same lock, only coarser than it need be; a contract of the key's own, `AssignmentNo` above, keeps it out.
- **One unit a relation.** No unit's heading leads with another's, by name and type in order, and two units of one
  heading are refused, `MalformedDescription` naming both: a relation keyed by the longer would sit under both, and a
  lock on the inner key would not exclude a holder of the outer one. So every relation sits under one unit at most.
  One name is one unit: a unit stated twice identically, at two levels or in a fragment and its schema, is one
  declaration, and one name over two headings is refused.
- **Declared at or below its members.** A unit is stated at the level of its lowest member or below it, since a
  process over that level compiles its writes without the levels above: a unit stated above a relation of a level
  below that leads with its heading is refused, naming the relation and its level. A schema that lists a fragment
  states no unit over the fragment's relations (`FragmentRefused`): the fragment states its own.
- **No borrow is written.** Which units a ChangeSet holds, and how, follows from what it writes and reads: generate
  reads each of its statements, and each write of a member at the unit values its parameters and rows state holds
  them exclusively, and each read of a unit it does not write holds them shared. A call holds each key once, however
  many members it touches, all of them in one statement sorted by lock, so two calls never wait on each other in a
  cycle.
- **A lock is no row.** A unit's key is locked as a PostgreSQL advisory transaction lock, its id a digest of the
  unit's name and the key's values, the one spelling every lock grizzle takes shares, a call's borrows, its judge's at
  COMMIT and a series' alike. Nothing is stored for it: the lock adds no table, column or migration step, and two keys
  whose ids collide only share a lock, a coarser one, never a wrong one. A unit whose relations hold a clock holds one
  table, its clocks' head, one row a key, which the writes that already hold the key stamp from
  ([Instants](#instants)). The id's top byte is the unit's rank, its place in the one order generate gives every unit
  and series, and the 56 bits below it the first of the SHA-256 of the
  unit's name and the key's values, each written after its length, so no two lists of them spell one text, and each
  value as its type's equality reads it: 1.0 and 1.00 are one key, as -0 and 0 are. Every schema installs one function
  that takes them, `__borrow`, which every role executes: handed a call's locks in the order of their ids, each with
  its mode, it takes them in that order, so a call that waits holds only locks below the one it waits for, and no two
  calls ever wait on each other in a cycle.

**The series.** A number every new row takes as one past the greatest, with no gap, such as an assignment's place in
its series, is the one thing no key splits. `series(R)` declares it, over a relation keyed by one field alone, of a
type grizzle draws:

```ts
/** What holds a number: an assignment, or nothing, where an import found the number skipped. */
const NumberHolder = closed.unordered("NumberHolder", ["held", "unused"])
const AssignmentNumber = relation(
	"AssignmentNumber",
	{ number: natural, holder: closedId(NumberHolder) },
	["number"]
)
export const Numbers = schema(
	"Numbers",
	[NumberHolder, AssignmentNumber],
	[series(AssignmentNumber)]
)
```

- **Its law.** The statement states that each number's predecessor is one of the series, `contained(on(R,
  pred("number")), on(R, "number"))`, so the numbers run 0, 1, 2, … with no gap: a schema that states that
  containment too states it once.
- **Its lock.** Every ChangeSet that writes `R` holds the series' one lock, from before its first read until it
  commits, so its read of the greatest number is exact and the next append waits for it. Appends queue one at a time,
  which is what a gapless series means at any level.
- **The only lock no key splits.** A call takes it only by writing `R`: no statement or ChangeSet names a lock, every
  other lock is a unit's, whose heading holds a field at least, a clock stays refused first in its key
  (`childless`) and a place first in its key (`groupless`). And the series carries its law, so it is never a lock to
  wrap other work in.
- **Its numbers' type.** `R`'s primary key is its one field, `natural` or a contract over an integer, exactly the types
  `drawn` takes ([Families](#families)): a test's number kept in an int4,
  `contract<typeof testNumberKey>()("TestNumber", pg.integer, (n) => Logic.and([Logic.ge(n, 0), Logic.le(n, 2147483646)]))`, keys its series as
  itself, and a number past its bound is refused by the contract's own CHECK. Any other key, a second field or a type
  of no integer carrier, is refused where `series(R)` is stated.
- `R` is immutable: its numbers only grow by appends.

### Removing a unit's rows

Rows go by deletes. A family of rows that must go once its work is done, a finished run's leases, a removed package's
content, a superseded load, is deleted by a ChangeSet of deletes of its relations, under the unit its rows sit under,
which the call borrows exclusively, so a delete inside a unit is as safe as an insert. What must never come back, a run's
idempotency key, a package's name, a release's attempt numbers, stays in a relation no ChangeSet deletes. A foreign key
into a row refuses its delete while a row that references it remains (23503), as PostgreSQL holds it at every level.

```ts
/** A run of a workflow, by the idempotency key its trigger gave it. */
const RunKey = str.bytes(64, str.regex("^[0-9A-Za-z_-]{1,64}$"))

/** Each run, kept for good, so a key a run took never starts a fresh one. */
export const Flow = relation("Flow", { flow: RunKey, steps: natural }, ["flow"])
/** The leases of a run's steps, each deleted once its step is done. */
export const FlowLease = relation(
	"FlowLease",
	{ flow: RunKey, step: pg.integer, until: pg.bigint },
	["flow", "step"]
)
export const Flows = schema(
	"Flows",
	[Flow, FlowLease],
	[
		unit("Run", { flow: RunKey }),
		mutable(FlowLease),
		contained(on(FlowLease, "flow"), on(Flow, "flow"))
	]
)
/** A finished step's lease goes: a delete, under its run's exclusive borrow. */
export const finished = ChangeSet.empty(Flows).delete(FlowLease, [])
```

What the consumers' shapes come to:

- **A release's loads** (learning-commons): `unit("Release", { release: ReleaseId })`, the load keyed `(release, attempt)`
  with `attempt: place`, stamped one past the release's last under the release's exclusive borrow, and every loaded row
  keyed `(release, attempt, …)`. A superseded attempt's rows are deleted under the release's borrow; the release and its
  attempt numbers stay, so a new load is a new attempt, never a revived one.
- **A package's content** (pantry, a publisher): `unit("Package", { package: PackageName })` over every content relation
  keyed `(package, …)`. A removal deletes the package's rows under the package's exclusive borrow; a
  learner's write that references the content borrows the package shared, so a removal waits for it, and an insert that
  references removed content after the removal commits is refused by its foreign key.
- **A workflow's run** (den): `unit("FanRoot", { root: DenScope })`, every relation of a flow keyed `(root, …)`; a finished
  run's leases and claims are deleted under the root's exclusive borrow, its root row kept, so its idempotency key never
  starts a fresh run.

## Permissions

Three declarations, all in the [example](#example):

- **`context(name, fields, { claim? })`**: a claim of the session token, read by queries as a table of at most one
  row. Its fields, read from the payload's top level or from the nested object `claim` names, are text, uuid,
  boolean, the integer types, contracts over them, and closed ids, whose claim is a handle's name. An absent claim
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
  It has one flat set of columns. Aggregates, negation, span comparisons, `take`, recursion, contexts and every
  scalar operation are allowed, since no expression fails on a value ([Queries](#queries)), on the rows outside the
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
  ([Levels](#levels)). A role with a scope runs them over its world, each member of a unit its claims bind at the keys
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
`readCommitted` or `serializable` ([READ COMMITTED writes](#read-committed-writes)): read it there, never from the
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
- **An attested context is the server's alone.** `attested("Origin", { address: pg.inet })` is a fact the server states,
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
const learners = query(Sittings).rule((r) => {
	const { sub } = v(Session, "session")
	const { child } = v(ClerkAccount, "account")
	return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, child }).find({ child })
})

export const Student = role(Sittings, "student", wholeEntriesOf(Sittings), {
	contexts: [Session],
	insert: studentInsertNames,
	scope: [learners]
})

/** A student's assignment by its number, with its status: no sign-in, no child, no guard. */
export const myAssignment = query(Sittings).rule((r) => {
	const { number, test } = v(Assignment, "assignment")
	const { status } = v(AssignmentStatus, "status")
	return r
		.match(Assignment, { number, test })
		.match(AssignmentStatus, { number, status })
		.where(r.eq(number, r.param("number", natural)))
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
  holds it ([Units](#units)), and every stored derived table the unit holds, unit-local by its admission, so its rows at
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
  whole with every row nested under them ([Families](#families)), which a role does only through a whole entry of the
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

## Queries

```ts
/** Comments per author on published posts. */
export const commentsPerAuthor = query(Blog).rule((r) => {
	const { org, post, author, at } = v(Comment, "comment")
	return r
		.match(Comment, { org, post, author, at })
		.match(Post, { org, slug: post, status: "Published" })
		.find({ author, comments: r.count() })
})

/** Published posts nobody has commented on. */
export const unanswered = query(Blog).rule((r) => {
	const { org, slug, title } = v(Post, "post")
	return r
		.match(Post, { org, slug, title, status: "Published" })
		.where(r.not(Comment, { org, post: slug }))
		.find({ org, slug, title })
})

/** Total views per organization. */
export const viewsPerOrg = query(Blog).rule((r) => {
	const { org, post, views } = v(PostViews, "postViews")
	return r.match(PostViews, { org, post, views }).find({ org, views: r.sum(views) })
})

/** An organization's posts by title, ready for paging. */
export const orgPosts = query(Blog)
	.rule((r) => {
		const { org, slug, title } = v(Post, "post")
		return r
			.match(Post, { org, slug, title })
			.where(r.eq(org, r.param("org", ClerkOrg)))
			.find({ slug, title })
	})
	.orderBy(["title", "asc"])

/** Two posts of one organization under one title: Post matched twice, in two scopes. */
export const sameTitle = query(Blog).rule((r) => {
	const post = v(Post, "post")
	const twin = v(Post, "twin")
	return r
		.match(Post, { org: post.org, slug: post.slug, title: post.title })
		.match(Post, { org: post.org, slug: twin.slug, title: post.title })
		.where(r.ne(post.slug, twin.slug))
		.find({ org: post.org, post: post.slug, twin: twin.slug, title: post.title })
})
```

`v(Post, "post")` makes one variable per column, in a scope named `post`. `r.match(Post, { ... })` binds variables and constants to a table's columns; a variable in two matches joins them. `.where(...)` filters. `.find(...)` picks the result columns: variables, aggregates, parameters, constants and computed values.

In `sameTitle`, `v(Post, "post")` and `v(Post, "twin")` are two scopes of one table under two names, two sets of variables of two types, so the self-join's keys are proved like any join's. A second `v` of a name the rule already holds is refused with `DuplicateIdentity` when the rule is built.

Rows are typed from the query: `commentsPerAuthor` gives `{ author: string; comments: bigint }`, and `viewsPerOrg` gives `{ org: string; views: Decimal }`, as PostgreSQL's `sum` of a bigint is a numeric. `orgPosts` takes the parameter `{ org: string }`.

| To | Write |
| --- | --- |
| join | one variable in two matches |
| filter | `r.eq`, `r.ne`, `r.lt`, `r.le`, `r.gt`, `r.ge`, `r.between`, `r.in`, `r.and`, `r.or`; an empty `r.in` list or `r.or([])` matches no row, `r.and([])` every row |
| exclude | `r.not(Table, { ... })`: no matching row exists |
| take a parameter | `r.param("name", type)`: a term of that type |
| pass a row list | `r.relation("name", fields)`: a parameter that is a list of rows, matched like a table; `Q.bind({ name: rows })` binds it to a query's rows, of a level above among them ([Levels](#levels)) |
| aggregate | `r.count()`, `r.sum(x)`, `r.mean(x)`, `r.min(x)`, `r.max(x)`, grouped by the other columns of `find`; a min or max is one of its values, at its type, contract included |
| combine | a second `.rule(...)`, the union of both rules' rows. Rules of different columns need a constant that tells them apart; a rule with an attachment shares its columns with no other. A take or attachment over a union of several headings is no rule of a further union, takes once and is never paged |
| nest | `.attach(name, (parent) => child, delivery)`, delivery `"array"`, `"option"` or `"one"` |
| read several queries at once | `query(S).reads({ name: query, ... })`: one row holding each query's rows under its name, in one statement ([Nearest rows](#nearest-rows)) |
| order and limit | `.orderBy(["title", "asc"])`, then `.take(10)`, `.take("batch")` for an integer parameter, or a `paged(query)` member's windows |
| recurse | `query(S).recursive(...)` |
| compare spans | `r.allen` with `ALLEN` masks, `r.pointIn`, `r.intersection`, `r.difference`, `r.pack` |
| build a span | `r.span(start, end)`: zero or one fact, the span from `start`, included, to `end`, excluded, of the span type over their endpoint type; none where `end` is not after `start` |
| compute | `Num.add`, `Num.mul`, `Num.round`, `Logic.cond`, `Logic.when` and the rest of the [scalar terms](#scalar-terms) |
| match text | `Text.matches(x, pattern)`, `Text.startsWith`, `Text.endsWith`, `Text.contains`, `Xml.isPattern`; `Text.concat` in checks, and in queries over bounded texts |
| search vectors | `.approximateNearest(...)`, with pgvector, from a parameter's vector or a stored row's ([Nearest rows](#nearest-rows)) |
| search text | `Search.matches`, `Search.rank`, `Search.rankCd` of a search document and a `Search.websearch` or `Search.plain` ([Full text search](#full-text-search)) |

### Differences from SQL

- **A query returns a set.** Identical rows are one row.
- **An aggregate folds keyed rows.** It reads each matched row once, by its key: every match in its rule binds a whole key of its source by a variable, a parent's variable or a constant, as `commentsPerAuthor` binds the comment's whole key, or the query is refused with `FoldOverProjection`, naming the match and the key to bind. To aggregate distinct values, match a query of them, a set keyed by its columns.
- **grizzle knows each result's keys**, from primary keys, equalities and constants, and keeps a key through `find` while the chosen columns still determine the row. `r.allen(a, ALLEN.equals, b)` is an equality, as is its converse; a mask written with `|` is a plain number to TypeScript, so the types read it as stating nothing. An `"option"` or `"one"` nested result takes only a query proved to return at most one row, and a window is ordered by a key. A delivery the schema does not prove is a type error. A child query built by a function takes the parent's field as `Term<T, unknown, InputOrigin, Sql, V>`, T the field's domain, `DomainOf<typeof field>`, and V its values, `Infer<typeof field>`, not as a type parameter: an equality over a type parameter says what it fixes only at the call, so inside the function the keys that prove its `"option"` delivery are lost. A child over an equality with the parent's field, built by a function or written inline, proves `"option"` and never `"one"`: `"one"` needs the child matched inline on the parent's own fields, as postPage matches `post.org` and `post.slug` in `r.match(Comment, { org: post.org, post: post.slug, author, at, body })`, where the schema proves every parent has its child.
- **`.orderBy(...).take(k)` is a set again** to whatever composes with it: a match, a further rule, a derived relation or a role's query entry. `take(1)` returns at most one row. A query or nested `"array"` that ends in a take arrives in the take's order, ties broken by the query's key; a final `orderBy` after the take orders it anew.
- **Variables belong to their columns.** Two variables made from one column of a table the rule matches once are refused, and the error shows the rewrite: make the variable where it is bound, or match the table again.
- **A JavaScript value takes the type of what it meets:** its column, the term it is compared with, the field a write puts it in, or the type the query's other rules give its field. Meeting nothing, a string is text, a safe integer an integer, a bigint a bigint, a `Decimal` a numeric, a `Money` money and a boolean a boolean; any other value is refused. It never stands first in a comparison, and a list such as `r.in`'s holds only JavaScript values. Opposite a term, at a column, for a parameter or in a fact, it is a value of its type: in a pattern's language, a uuid's hyphenated spelling, a roster's names, so `"abc"` at a uuid column is a type error, and so is a plain `string` until `Uuid.parse` reads it. Where it becomes a contract's value, a parameter's, a fact's, a typed constant's or a conditional's arm's, it is one its key's mint made; compared with a contract's term, it is a value of the base.
- **A typed term states its type** and stands wherever such a term does. `Status.handle("Published")` is a member of the `Status` roster, and `Type.literal(F, x)` is `x` at the type of any other descriptor `F`. A head keeps a handle's member, so `find({ status: Status.handle("Published") })` delivers `status: "Published"`; `Type.literal` delivers F's type.
- **Terms that meet have one type:** one SQL type, one contract and one roster. A text term never meets a uuid column, and two rosters of the same members never meet. Texts of any two patterns meet: a pattern is no part of a text's type. The rules of one query deliver each field they share at one type. An equality is the one comparison that also meets two refinements of one base carrier, one SQL type once contracts are stripped, roster and all: `r.eq(n, b)` of a `natural` and a `pg.bigint`, or of two contracts over one base, compares them under the base's equality, as a containment's sides and a negation's binding meet. Where it holds its value is both sides', so it lies in both contracts, and grizzle's own rewrites may read either side for the other at the other's type with no check and no cast. `r.ne` and the orderings meet as any comparison does: their operands are of one type, `Type.base` of a contract where one is.
- **A value is only its value**, the same under every plan. A `Decimal` has no display scale: `1`, `1.0` and `1.00` are one value, delivered as `1`, and a `pg.numeric(10, 2)` field holds at most two places, refusing a value of more rather than rounding it, and delivers `12.5`, not `12.50`. `new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(d.toString())` prints it at the field's scale, exactly. A float keeps its zero's sign: `-0` is a value of its own, stored, computed and delivered as `-0`, equal to `0` under `=`, `DISTINCT` and a key's equality and apart from it as a fact's identity. Wherever an operation may take one float of several equal ones, a set's member, a group's key, a union's row, a recursion's state, a join variable's value, the merged zero is `+0`, so no plan picks one. A write stores the facts it states: a parameter relation's facts and a ChangeSet member's rows are sets of facts by their identity, `-0` and `0` two of them, so a `-0` a write states is stored as `-0` wherever it reads the relation, and two facts at one key that differ only in a zero's sign are refused as two facts. A read of a parameter relation delivers each of its facts, so `-0` and `0` at otherwise equal fields are two rows; a read's own merges, a projection that drops a field, a union or a group's key, take `+0` as every merge does. `min` and `max` of floats order `-0` below `0`, and a float sum or mean whose exact value is zero is `-0` exactly when every value it sums is; any other float that rounds to zero, a product, quotient, conversion or mean too small for its type, is the zero of its sign. A vector's components have one zero, `0`. A numeric quotient, power, square root or mean is PostgreSQL's for the values alone, as if no operand had trailing zeros: `Num.div(x, 3n)` is the same number whatever scale `x` was stored at.
- **Float and money sums are exact.** A sum of `real` or `double precision` values is their exact total rounded once to the result type, and of `Money` values their exact total; a mean of floats is that total over the count, rounded once. The same rows give the same sum in any order, under any plan.
- **Every answer is a function of the facts**, but for two exceptions, both pgvector's, and one caveat, full text search's: a search document, its matches and its ranks are PostgreSQL's parse of the facts' texts under the configuration's dictionaries and the database's builtin C.UTF-8 locale, a function of the facts on one server, which another PostgreSQL release's stemmers or stop word files may parse otherwise. `.approximateNearest` returns candidates from pgvector's index: which rows, and how many, depend on the index and the database owner's pgvector settings too. grizzle pins `hnsw.iterative_scan = strict_order`, which keeps the candidates in exact distance order, and `hnsw.max_scan_tuples` at pgvector's own 20,000, where both the scan and the stream a search's filters read stop; `hnsw.ef_search` and `hnsw.scan_mem_multiplier` are the owner's, and a scan that reaches their bounds returns fewer rows than asked. `Distance.cosine` is pgvector's own float arithmetic: one server gives the same result for the same vectors on every evaluation, but pgvector builds or CPUs may differ in the last place.
- **No read fails on a value.** Every scalar operation is defined on every value its operands' types admit, or its precondition is proved where it stands, so no query, role view or check raises an arithmetic error on any row, but arithmetic over a `pg.numeric`, an `exactInteger` or an `exactMoney` field, bounded by nothing but numeric's own limit, whose result past it PostgreSQL refuses with 22003, numeric_value_out_of_range.

### Scalar terms

PostgreSQL's scalar operators, functions and casts are typed builders of terms, in thirteen namespaces, each member in the one whose domain it reads, so a name is short and the namespace carries the domain: `Xml.isPattern`, never `isXsdPattern`.

| namespace | members |
|---|---|
| `Type` | `literal`, `base`, `cast` |
| `Num` | `add`, `sub`, `mul`, `div`, `mod`, `neg`, `quot`, `rem`, `abs`, `sign`, `round`, `trunc`, `ceil`, `floor`, `gcd`, `lcm`, `power`, `sqrt`, `widthBucket`, `minScale`, `numeric`, `floatBits`, `nonzero`, `nonnegative`, `positive`, `isFinite`, `within` |
| `Logic` | `cond`, `when`, `not`, `and`, `or`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between`, `in`, `least`, `greatest` |
| `Range` | `lower`, `upper`, `width` |
| `Text` | `charLength`, `octetLength`, `utf16Length`, `concat`, `startsWith`, `endsWith`, `contains`, `pattern`, `matches`, `translate`, `lowerAscii`, `replaceWhitespace`, `collapse`, `resolveReference`, `cutBefore`, `cutFrom`, `replace`, `parseDouble`, `parseDecimal` |
| `Xml` | `pattern`, `isPattern` |
| `Crypto` | `sha256` |
| `Distance` | `cosine` |
| `Search` | `websearch`, `plain`, `matches`, `rank`, `rankCd` |
| `Bits` | `union`, `intersection`, `difference`, `cardinality`, `subset`, `disjoint`, `singleton` |
| `Net` | `within`, `strictlyWithin`, `overlaps` |
| `Time` | `wall`, `epochDay`, `dateOfEpochDay` |
| `Fn` | `call`, `rows`, `row` |

`Type` writes a typed constant, drops a contract to its base and casts; `Num` is the numeric family's arithmetic, rounding and functions, and its guards; `Logic` the comparisons, `least` and `greatest`, the connectives and the conditionals, over any type they compare; `Range` a span's endpoints and width, a span being PostgreSQL's range; `Text` text's lengths, concatenation, prefixes, suffixes and containment, patterns in grizzle's grammar and their matches, transforms, references and lexical parses; `Xml` XML Schema 1.0's pattern dialect; `Crypto` a SHA-256 digest; `Distance` the cosine distance of two vectors; `Search` a full text search's queries, matches and ranks ([Full text search](#full-text-search)); `Bits` the set algebra over one roster's sets, beside `Bits.of`, a set value; `Net` the containment of the network types ([Network containment](#network-containment)); `Time` a zone's wall clock and a date's epoch day ([Time zones](#time-zones)); and `Fn` a declared function called for its value, its rows or its one row ([Calling a function](#calling-a-function)). No namespace is named `Number`, `Set` or `Digest`: the first two would shadow JavaScript's globals, the type `Set<T>` included, in every module that imports them, and `Digest.sha256` is `effect/crypto`'s own spelling.

### Arithmetic

- **Exact.** Integer arithmetic delivers `bigint`, an *exact integer*, and money arithmetic exact `Money`; neither overflows.
- **Floats are IEEE 754, but for a quotient by zero:** `sqrt(-1.0)` is NaN, and `x / 0.0` is the infinity of `x`'s sign, NaN where `x` is zero or NaN, whichever zero divides, so `1 / -0.0` is `Infinity`, where IEEE 754 gives `-Infinity`. `-0.0` equals `0.0`, and equal operands give equal results under every plan, which may read a divisor from either of two equal fields.
- **A partial operation needs its precondition proved:** division or remainder by a value that may be zero, a numeric square root of one that may be negative, a power, `widthBucket` and `minScale` of values that may be infinite, and a cast that narrows. The proof is a literal's own type, as in `Num.div(x, 7n)`; a contract that declares it, `contract<typeof divisorKey>()("Divisor", pg.bigint, (v) => Logic.ne(v, 0n), { proves: ["nonzero"] })`; or a guard, `Logic.when(Num.nonzero(b), (b) => Num.div(a, b), 0n)`, whose function receives `b` proved nonzero and whose last argument is the value where the guard does not hold. Only the function's parameter is proved, as TypeScript narrows a callback's parameter and never a term the callback captures: `(_) => Num.div(a, b)` reads `b` with its own facts, and is refused. An unproved divisor is a type error that names the guard to write.
- **Guards** are `Num.nonzero`, `Num.nonnegative`, `Num.positive`, `Num.isFinite` and `Num.within(x, low, high)`, each a predicate too. A guard's subject is any term, a parameter included: over `d = r.param("d", pg.bigint)`, `Logic.when(Num.nonzero(d), (d) => Num.div(x, d), 0n)` delivers `0n` where `d` is bound to zero, under every plan.
- **A contract's facts are exactly the ones its `proves` declares.** Compilation proves each from the predicate and refuses one the predicate does not imply. A fact the predicate implies but `proves` leaves out is no fact of its values: `Num.minScale(rate)` over `contract<typeof rateKey>()("Rate", pg.numeric(7, 6), (x) => Logic.between(x, 0n, 1n))` is refused, naming `{ proves: ["finite"] }` to add. A parameter of a contract has its declared facts, its binding checking every value, so `Num.div(x, Type.base(r.param("d", Divisor)))` needs no guard.
- **Magnitudes are proved by `Num.within`.** A narrowing's range or a power's is proved from `Num.within`'s bounds, or refused as `PartialOperation`: narrow an exact integer into an integer field with `Logic.when(Num.within(x, 0n, 1000000n), (x) => Type.cast(x, pg.integer), 0)`.
- **Exact and plain values share no type.** An exact value binds at a plain integer or money column, but a ChangeSet member stores one into a plain field only through that cast: a head that writes `Num.add(balance, amount)` into a `pg.bigint` field is a type error. An `exactInteger` or `exactMoney` field holds it as it is ([Tables and types](#tables-and-types)). Where PostgreSQL would widen the plain value implicitly, `Logic.cond`, `Logic.when`, `Logic.least` and `Logic.greatest` refuse an exact value beside a plain one of its family, in either order, naming the cast of the exact one into the plain one's type. A bare literal takes its term's type, an exact one's included, and is refused where it has more digits than that type holds.
- **A member writes each field at the field's own type,** as a generated field's term and an accumulator's step do: only a text's pattern and byte bound are left to the field's domain, which refuses a value outside them. A computed numeric, the value of `r.sum`, `r.mean` or a numeric operation, enters a `pg.numeric(p, s)` field only through `Type.cast` under a guard that proves it fits, and a numeric of another precision or scale, or a span of another width, only through `Type.cast`, since a typmod rounds and a sum can pass the field's precision. Compilation refuses any other head as `DescribedHeadingMismatch`.

### Text

- **`Text.matches(x, pattern)`** is PostgreSQL's `~`: whether `x` holds a match of a pattern in `str.regex`'s grammar under the flags `"u"`, anchored by `^` and `$`. The pattern is a `Text.pattern(source)`, whose source is type-checked as `str.regex` checks its own and admitted once, where it is written, inside PostgreSQL's regex compile space as a `str.regex` pattern is ([Limits](#limits)); make it once, as a module constant, and match on it anywhere. A pattern is its language: every law, check and derived relation over it is identified by the language its source spells and never by the spelling, so a source rewritten to spell the same language identifies nothing anew, and one of another language does. `doubleText`, `decimalText` and `lexicalForm(T)` are grizzle's own patterns, and `.source` is a pattern's text. Or the pattern is a text term whose every value the schema holds: a closed relation's `str.pattern` field, as in `Text.matches(lexical, ValueDomain.at("pattern", domain))`, or a `Logic.cond` of such terms. A `str.pattern` field holds patterns: each value is admitted once, where the schema compiles, and the relation's constants carry each one's translation into PostgreSQL's ARE beside it, so the match reads the translation by the field's key and translates nothing as it runs. Only a closed relation's own field is a `str.pattern`, and a match reads no other text payload as a pattern. A string is no pattern, and a field, a parameter or a computed text can be any pattern, and is refused as one. A match is also a guard: with `const digits = Text.pattern("^[0-9]+$")`, `Logic.when(Text.matches(code, digits), (code) => …, otherwise)` hands its branch the subject as text of its own patterns and the match's together, as `str.and` joins them, so nested matches prove a cast into a conjunction; over a pattern term it is a conditional. In a query, PostgreSQL's regex engine reads at most 268,435,454 bytes of `x` and a read never fails, so `x`'s bytes are proved within them by its type or by a byte guard whose branch the match stands in, `Logic.when(Num.within(Text.octetLength(x), 0, 4096), () => Text.matches(x, digits), false)`: the when is a CASE, so the match is read only where the guard holds, and its answer past the bound is the program's own, here `false`.
- **`Text.startsWith(a, b)` and `Text.endsWith(a, b)`** test a prefix and a suffix, by characters. A rule's probe that
  holds the suffix fixed, a policy's row it was written over, reads the texts that end with it by a seek: the
  installation holds a B-tree on the text's suffix key, `chr(1) || reverse(text)`, and the probe tests the key's range
  in the suffix test's place, `key >= chr(1) || reverse(b)` and below the least text above every key with that prefix,
  which is exactly the suffix test on every text, so a policy write reads the references it reaches and locks no whole
  table. Each write of the text keeps that B-tree, one entry more per row.
- **`Text.contains(haystack, needle)`** tests whether `haystack` holds `needle`'s characters together, PostgreSQL's
  `strpos(haystack, needle) > 0`. It reads no pattern, so every character of the needle is itself: a parameter's `%`,
  `_` and `\` need no escaping, as they would in a LIKE. The empty needle is in every text, and a needle longer than
  its haystack in none. It is defined on every pair of texts, so it stands in a query, a check, a contract predicate
  and a generated field alike, over texts of any length. A query filters by it, with no index: a B-tree serves no
  containment, so each row the query's other terms find is tested, and grizzle drafts no index for it. Like the prefix
  and suffix tests it is a boolean term, so a query filters by it as `Logic.eq(Text.contains(name, term), true)`. It
  folds no case: a search blind to ASCII's case folds both sides,
  `Logic.eq(Text.contains(Text.lowerAscii(name), Text.lowerAscii(term)), true)`, and like `Text.lowerAscii` it folds
  no letter past ASCII, so `É` and `é` stay apart.
- **`Xml.pattern(source)`** is a `Text.pattern` written in XML Schema 1.0's dialect, a pattern facet (Part 2, Appendix F), anchored at both ends as XML Schema reads every facet, its escapes XML Schema's own: `\s` the four XML spaces, `\i` and `\c` XML 1.0 Second Edition's name characters, `\p{IsBasicLatin}` a block of XML Schema's table. A repetition count may be any whole number, as Appendix F sets none: PostgreSQL's RE_DUP_MAX of 255 binds only the ARE grizzle prints, which spells `x{300}` as `x{255}x{45}`, and the host counts a repetition, never copying its body, so a count costs it no state. A facet past PostgreSQL's regex compile space is refused where it is written, as `Text.pattern` refuses one, before it is printed.
- **`Xml.isPattern(x)`** is whether `x` is an XML Schema 1.0 pattern, a string of Appendix F's `regExp` production, the language of QTI 3.0.1's `pattern-mask`, as `Xml.pattern` reads one: groups and class subtractions nested to any depth and counts of any size, refused at `(?`, a back-reference, an unclosed `[` or `(`, a `{` that opens no count, a count whose greatest is below its least, a range whose end is below its start, and a category or block escape the tables do not name. PostgreSQL judges it by the installation's own IMMUTABLE STRICT function, NULL over a NULL text as every operation is, the reader's moves as a table that a recursive query reads once over the text's characters, with no state budget and no bound on a count, so it is defined on every text and stands in checks, contract predicates, generated fields and queries alike: `contract<typeof patternMaskKey>()("PatternMask", Prose, (v) => Xml.isPattern(v))` is a text type of patterns.
- **A byte bound is a guard.** `Logic.when(Num.within(Text.octetLength(x), 0, 64), () => Type.cast(x, Name), "")`, with `Name` a `str.bytes(64, pattern)` whose pattern holds x's, reads `x` inside the branch as at most 64 UTF-8 bytes of its own pattern, so a text of no byte bound casts into `Name`. `octetLength` is total, so the guard stands everywhere, a query included, and it proves the bytes every operation that reads them needs: a query's `Text.matches` and `Text.translate`, and `Text.utf16Length`.
- **`Text.utf16Length(x)`** is `x`'s UTF-16 code units, JavaScript's `x.length`: its code points, and its supplementary ones once more, `char_length(x) + regexp_count(x, '[\U00010000-\U0010FFFF]')`. A length an Effect Schema's `isMaxLength` states of a string is this one, where `Text.charLength` counts code points. Like `charLength`, it stands in checks, contract predicates and generated fields, never in a query. `regexp_count` widens its text to four bytes for every byte, so `x` is bounded within 268,435,454 bytes by its type or by a byte guard, or the operation is refused when it compiles as `PartialOperation` (`bounded`), and no law that reads it fails on a long text. A UTF-16 unit is at most three UTF-8 bytes, so a bound reads no regex past them: `contract<typeof nameKey>()("Name", Prose, (v) => Logic.when(Num.within(Text.octetLength(v), 0, 765), () => Text.utf16Length(v), 256).le(255))` holds a text of at most 255 units, as `Schema.String.check(Schema.isMaxLength(255))` does, since a text of more than 765 bytes has more than 255.
- **`Text.concat(a, b)`** is `a || b`, text of no pattern, of at most the bytes of the two together where each is bounded: a term by its type's byte bound, a string or a typed constant (`Type.literal`) by its own bytes. It stands in checks, contract predicates, generated fields and folds; in a query wherever its operands' types bound its bytes within the most one varlena holds (`bytesMaxLength`), a query's head among them, so `find({ module: Text.concat(path, ".js") })` over a `str.bytes`-bounded `path` is text within its bytes and 3 more, since it allocates its result, which PostgreSQL refuses past 1 GB, and a read never fails on a value; and over texts of any length as a side of `Logic.eq` or `Logic.ne`, which is decided as an equality of the other side with the concatenation built under its bytes' guard: `octet_length(t) = Σ octet_length(pi) AND t = CASE WHEN Σ octet_length(pi) > bytesMaxLength THEN '' ELSE p1 || … || pn END`, which never allocates past the most bytes one varlena holds and is NULL exactly where `t = a || b` would be. So a rule that joins a stored text to a concatenation of the other side's columns reads that text by its key, never every row its other columns find. A literal on the other side is a value opposite the concatenation, as in a comparison with its term, so one of more bytes than the parts take together is refused at compile (`ContractLiteral`), in an equation as in an IN list. A concatenation nested in that side is read through as its parts, in order, so `Logic.eq(t, Text.concat(Text.concat(Text.concat(lead, target), params), trail))` builds the four in order, in a query as in a check. Its first operand is a term, as every operation's is, so a leading literal is a typed constant: `Text.concat(Type.literal(Prose, "item-"), id)`.
- **`Text.translate(x, from, to)`** is PostgreSQL's `translate`, by characters: each character of `x` that `from` holds becomes the character of `to` at its position, so `Text.translate(title, "\t\n\r", "   ")` reads a title in `xs:normalizedString`'s value space. `from` and `to` are strings of one length, `from` holding each character once, or the call is refused where it is written.
- **`Text.lowerAscii(x)`** is `translate` from `A` to `Z` onto `a` to `z`. It lowers no other letter, so it is one IMMUTABLE map whatever the collation. PostgreSQL computes it as `lower(x COLLATE "C") COLLATE pg_c_utf8` wherever it stands, a query, a check and a generated field alike: lower folds byte by byte under the C collation and allocates `x`'s own length, so it folds any text, and its result is collated as every stored text is, so an equation of it with a key is served by the key's index.
- **`Text.replaceWhitespace(x)`** is XML Schema's whiteSpace replace, `Text.translate(x, "\t\n\r", "   ")`.
- **`Text.collapse(x)`** is its whiteSpace collapse, each run of tab, LF, CR and space one space and none at either end, by PostgreSQL's `replace` and `btrim` alone, which never lengthen the text: IMMUTABLE and defined on every text, so it stands in a generated field and in a query over any text. A collapse keeps its operand's byte bound, so a query's `Text.matches` over a collapse still needs the operand bounded, as below. No other character is white space to it, a no-break space and a line separator among them.
- **`Text.cutBefore(x, chars)`** is `x` before its first character among `chars`, all of `x` where it holds none, and **`Text.cutFrom(x, chars)`** is `x` from that character on, the empty text where it holds none, so the two concatenate to `x`: `Text.cutBefore(href, "?#")` is an href's path and `Text.cutFrom(href, "?#")` its query and fragment. Characters are code points, and `chars` is a set, a repeat no second member and an empty one cutting nowhere; it may be any text term. Each is text of no pattern within `x`'s bytes, computed by a function of grizzle's library (strpos, `left` and `substring`), which allocates at most `x`'s own bytes, so it stands in queries over any text as in checks and generated fields.
- **`Text.replace(x, from, to)`** is PostgreSQL's `replace`: every occurrence of `from` in `x`, left to right and none overlapping, replaced by `to`, and `x` itself where `from` is empty, so `Text.replace(Text.replace(Text.replace(name, "%", "%25"), "?", "%3F"), "#", "%23")` writes an entry's name as a URI path segment, one character by several. It is text of no pattern within `x`'s bytes and what each occurrence of `from` adds (a string `from` by its own bytes, a term's at least one), and it allocates its result, so a query holds it only where that bound is within the most bytes one varlena holds; a check or generated field over longer texts fails its write.
- **`Crypto.sha256(x)`** is the SHA-256 digest of a `bytes` value, its 32 bytes as they are, PostgreSQL's `sha256(x)`, the one operation that reads a bytes value, which it reads whole; over a text it is the digest of the text's UTF-8, `<textDigest>(x)`, the installation's own IMMUTABLE STRICT function of `sha256(convert_to(x, 'UTF8'))`, which a grizzle database, always UTF8, converts nothing for. Its value is a `sha256` digest, never a text: no hex spelling is stored or compared. It is IMMUTABLE and defined on every value, so it stands in checks, selections, generated fields and queries. `generated(sha256, Crypto.sha256(row.content))` is a field PostgreSQL computes from the bytes it stores: no writer sends it, since an insert holds only the written fields, and no row holds a digest of other bytes. On the host, `Sha256.ofBytes(bytes)` and `Sha256.ofText(text)` compute the same digest.
- **`Num.floatBits(x)`** is a float's identity image: `float8send`'s 8 bytes, the bits of its IEEE 754 binary64 encoding, read as a signed `bigint`, a `real` widened exactly to `double precision` first, every NaN in one form (0x7ff8000000000000), as Java's `doubleToLongBits` reads them. `floatBits(value)`, exported beside `Num`, is the same function for an application's own code. Two floats have one image exactly when they are one value: `-0` and `0` differ, where `Logic.eq` holds them equal. It is IMMUTABLE and defined on every float. A primary key holds only fields a caller writes, so a key over floats by identity states the image as a field and holds it to the value by a law: `relation("Bag", { variable, bits: pg.bigint, value: pg["double precision"], count }, ["variable", "bits"])` with `check("BagImage", Bag, (b) => b.eq(b.bits, Num.floatBits(b.value)))`, each row written with `bits: floatBits(value)`. A bag holding both zeros holds two rows, the check refuses a `bits` that is not its value's image, and a read by `=` on `value` still finds either zero. A generated image, `generated(pg.bigint, Num.floatBits(r.value))`, stands in a candidate key and a reference.
- **A query matches or translates only a bounded text**, one whose type bounds it within 268,435,454 bytes, since PostgreSQL allocates four bytes for every byte of it; `Text.lowerAscii` folds any text there. A check, a law's selection or a generated field reads any text ([Limits](#limits)).
- **`r.series(low, high)`** is a source a rule matches: each integer from `low` to `high`, both included, none where `low` lies above `high`, `r.match(r.series(first, last), { at })`, PostgreSQL's `generate_series(low, high)` where the match stands, once for each binding of the matches before it. Each end is a term of an integer, bigint or exact integer type over the rule's variables, parameters and constants (a JavaScript value, which meets no term, is refused), and `at` is an exact integer. Every element lies between its own row's ends, so a term of the rule reads it within the least value `low` takes and the greatest `high` takes: no filter and no guard is its premise, so it holds wherever the term is evaluated. A piece of presence's UTC days are `r.series(Num.div(from, dayMicros), Num.div(Num.sub(to, 1n), dayMicros))`, and with `from` and `to` bounded by Moment's top each day is a date's, `Time.dateOfEpochDay(Type.cast(day, pg.bigint))`, proved by those intervals. A day stored in another relation's column is typed by a bounded contract there, proved at the write by the same interval.
- **`r.tokens(x)`** is a source a rule matches: the tokens of a whitespace-separated list, XML Schema's list lexical space, `x` collapsed and split at its spaces, `r.match(r.tokens(lexical), { at, token })`. Each `token` is a run of the characters `x`'s language holds but tab, LF, CR and space, text within `x`'s byte bound, so a token of a bounded text is bounded and a token of a text of XML's characters is a text of them, which a cast into a QTI identifier's type admits under a guard of its bytes; a token of any text is a run of no tab, LF, CR or space. `at` is its place among them from 0, a natural, which keys the tokens of one `x`: a derived relation of the tokens of a keyed row is keyed by the row's key and `at`, and by the row's key alone where a literal fixes `at`, so a stored one of tokens of no byte bound holds a key a B-tree entry holds. A series' element keys its rows so too; a declared function's rows (`Fn.rows`) are keyed by their whole heading. A text of whitespace alone has none. `x` is a text term of the rule's scope: a variable, a parameter or a constant, bound as a call's argument is, or a term computed from them where the match stands, as a series' end is. PostgreSQL computes the tokens where the match stands, `unnest(string_to_array(<x collapsed>, ' ')) WITH ORDINALITY`, once for each binding of the matches before it, so a list an import would store token by token, with a family and a fold to prove its split, is a derived relation instead: `derived("Idref", query(S).rule((r) => r.match(Attribute, { …, lexical }).match(r.tokens(lexical), { at, token }).find({ …, at, token })))`, its split true by definition. A rule over such a relation is judged whole where it is unit-local ([Rules over queries](#rules-over-queries)), reading the tokens of the units a transaction wrote alone; no probe reads a token back to the row that holds it, so one that is not unit-local is refused as `UnsupportedLawFamily`.
- **`r.split(x, separator)`** is a source a rule matches: the pieces of `x` between the occurrences of `separator`, a JavaScript string of one Unicode scalar value but U+0000, the split's own constant, `r.match(r.split(path, "/"), { at, piece })`. n occurrences give n + 1 pieces, the empty ones kept, so `"a//b"` is `a`, an empty piece and `b`, and the empty text is one empty piece, as JavaScript's `String.prototype.split` reads it: `x` is always its pieces joined by the separator. Each `piece` is a stretch of the characters `x`'s language holds but the separator, text within `x`'s byte bound, so a piece of a bounded text casts into a type that excludes the separator; `at` is its place from 0, a natural, which keys the pieces of one `x` as a token's place does. A whitespace-separated list is `r.tokens`, whose runs of whitespace are one separator and whose empty list has no token. PostgreSQL computes the pieces where the match stands, `string_to_table(<separator> || x, <separator>) WITH ORDINALITY`, its first piece, the one before the separator written ahead of `x`, dropped.
- **`r.rest(x, prefix)`** is a source a rule matches: one row, `rest`, the code points of `x` past `prefix`'s, where `x` starts with `prefix`, and none where it does not, so a match of it keeps only the bindings whose `x` has the prefix and `r.not(r.rest(x, prefix), {})` keeps the others. The text and the prefix are each a text term of the rule's scope, as a token split's text is, a computed one among them: the variable after an item ref's identifier and its period is `r.match(r.rest(reference, Text.concat(scope, ".")), { rest: variable })`. The rest is a stretch of `x`'s characters within its byte bound, and its row is keyed by what keys `x` and the prefix. PostgreSQL computes it where the match stands, `substring(x, char_length(prefix) + 1)` where `starts_with(x, prefix)`. The empty prefix is a prefix of every text, its rest the text itself; a text is a prefix of itself, its rest the empty text.
- **`r.splitLast(x, separator)`** is a source a rule matches: one row, `before`, the code points of `x` before the last occurrence of `separator`, and `after`, those after it, where `x` holds the separator, and none where it does not, so a match of it keeps only the bindings whose `x` holds it and `r.not(r.splitLast(x, separator), {})` keeps the others. `x` is always `before`, the separator and `after` joined, `after` holds no separator, and either may be empty, a separator at either end of `x`. The separator is a JavaScript string of one Unicode scalar value but U+0000, the split's own constant, as `r.split`'s is, and its occurrences are code points: a scalar value's UTF-8 never occurs inside another character's, so `é` and a character beyond the BMP split as a comma does. `before` is a stretch of `x`'s characters, the separator among them, and `after` a stretch of them but the separator, each within `x`'s byte bound, so the text after a bounded text's last separator keys a stored relation and casts into a type that excludes the separator; its row is keyed by what keys `x`. The last piece of a text is the text after the last separator of the text with one written ahead of it, a computed text, and a path's extension as Node's `path.posix.extname` reads it, without its dot, is the text after the last dot of its last segment, where neither side of that dot is empty: `r.match(r.splitLast(Text.concat(Type.literal(Slash, "/"), path), "/"), { after: segment }).match(r.splitLast(segment, "."), { before: stem, after: extension }).where(r.ne(stem, ""), r.ne(extension, ""))`, `Slash` being `str.regex("^/$")`, so `photo.JPG` is `JPG`, `..foo` `foo` and `a.b.c` `c`, and `.bashrc`, `a/.svg` and `a.` have none. PostgreSQL computes it where the match stands, `left(x, -k)` and `right(x, k - 1)` for `k` the place of the separator in `reverse(x)` (`strpos`), where `k > 0`: one pass of each over `x`.
- **`r.decodedPath(x)`** is a source a rule matches: one row, `path`, the path the percent-encoded URI path `x` spells (RFC 3986 §2.1 and §2.5), each `%HH` its octet and every other character its own UTF-8, the octets read as UTF-8, so `my%20sign.png` and `%C3%A9` decode to `my sign.png` and `é`; and none where `x` spells no path: a `%` that begins no `%HH` (`a%zz`, a `%` at the end), escaped octets that are no well-formed UTF-8 (`%FF`, a lone `%C3`, an overlong `%C0%80` or `%E0%80%80`, a surrogate `%ED%A0%80`, past U+10FFFF, or a lead and its continuations with a literal between them), an escape of U+0000, which no text holds, or of `/` (`a%2Fb`), which would join two segments, and a segment of dots alone with one written `%2E`, which would decode to a dot segment `x` does not hold. Every other character stands as written, a literal `/`, `.` or `..` among them, so decode a path after its dot segments are removed. `r.not(r.decodedPath(x), {})` keeps the texts that spell none. The path is any text within `x`'s byte bound, and its row is keyed by what keys `x`. PostgreSQL computes it where the match stands by a function of grizzle's library, which reads `x` once between its `%`s by window functions, no regular expression, at any length.
- **`r.resolvedWithin(base, reference)`** is a source a rule matches: one row, `target`, `reference` resolved against `base` as `Text.resolveReference` resolves it (RFC 3986 §5.2.2, strict, then §5.3's recomposition), where no `..` segment of the path its resolution walks climbs past that path's root, and none where one does, so a hierarchy rooted at the base holds no target of it: from a package's document `package:///items/i.xml`, `../a.png` resolves to `package:///a.png` and `../../a.png` to none, an href above the package root, which `r.not(r.resolvedWithin(base, reference), {})` keeps. A reference of no path keeps its base's path unwalked, within it. Only a literal `.` or `..` is a dot segment, as the strict resolver reads one; RFC 3986 §6.2.2.2 reads `%2E` as `.`, so a package importer that does replaces `%2E` and `%2e` in the reference with `.` first (`Text.replace`), resolves, then decodes the target's path (`r.decodedPath`). The target is any text within both texts' bytes and a merge's `/`, which a query holds only where their patterns bound that within the most bytes one varlena holds, as for `Text.resolveReference`; its row is keyed by what keys the base and the reference. PostgreSQL computes it by a function of grizzle's library, the resolution's walk counting each `..` that finds no segment to remove, by window functions over the path's segments, no regular expression.

A translation is text of the image of `x`'s language, every class and character of its pattern rewritten by the map, so a bounded pattern stays bounded and a literal opposite it is judged by the image. Where `x`'s type bounds its bytes, a `str.bytes` among them, so does the translation's: by the most bytes the image of a text of `x`'s byte and character bounds over its pattern's characters can take, which is `x`'s own bound where the map takes no character to one of more bytes, as `lowerAscii` and `replaceWhitespace` never do, and more where it does: `Text.translate(x, "a", "€")` over any text of at most 6 bytes is at most 18, six `a`s of three bytes each. A query's head delivers it as it delivers any refined text, cast where its trace proves no row inside the refinement into that refinement's domain, which the installation holds for every refinement any artifact over it or any program it serves types a value by, whatever field declares it; a law that reads it, a containment of a stored text into a derived relation that computes one among them, and a cast of it in a generated field or a check name that domain alike. A cast of a text into a refined text is total where the text's language lies inside the target's, proved by comparing their automata as for a parse, and, into a `str.bytes`, where the longest text of its language within its own byte bound fits the target's, which its automaton finds: a collapse of a text of at most one byte of spaces and `😀` is the empty text alone, so it casts into text of no byte. So a translation is stored in a field of a type the image lies in: `generated(Normalized, Type.cast(Text.translate(row.title, "\t\n\r", "   "), Normalized))`, `Normalized` being `str.regex("^[^\\t\\n\\r]*$", "su")`.

A collapse is text within `x`'s length and byte bounds, since it never lengthens a text, of runs of `x`'s other characters a space apart. That is exactly the image of `x`'s language for a pattern with no white space, which collapse leaves as it is, and for a class repeated freely, `^[...]*$` (the wildcard among them), whose image is every collapsed text over its other characters: `^(?:[^ \t\n\r]+(?: [^ \t\n\r]+)*)?$` for `Prose`. For any other pattern it is more than the image: for one of at most n characters, n up to 257, every text of at most n characters that begins and ends with a character other than white space, two spaces together included, `^(?:[^ \t\n\r](?:[^\t\n\r]{0,n-2}[^ \t\n\r])?)?$` for `^.{0,n}$`; for any other, the collapsed texts over its characters, unbounded. Store a collapse as a translation is stored: `generated(T, Type.cast(Text.collapse(row.title), T))` for a `T` the result lies in. The bound and the language compose through a chain, so a key text normalized from a key text casts back into its type: `generated(Key, Type.cast(Text.lowerAscii(Text.collapse(row.lang)), Key))`, `Key` being `str.bytes(2587, str.regex("^.*$", "su"))` and `lang` a `Key`.

A digest is a `sha256` value, 32 bytes: bytea behind the installation's digest domain, whose CHECK holds its length, and a `Sha256` on the host, a `Uint8Array` of its bytes. A key, a UNIQUE, a family's axis and a reference's target hold one by its bytes, its entry 32 bytes and a header, so a digest of a text no index entry could hold keys that text. `Logic.eq` compares two, a parameter of the type finds a row by one, and a query's head delivers one as a fresh `Sha256`. A value of another length is refused where it is passed, `sha256Value`, before any statement is sent. No contract is over a digest, and no cast turns one into a text: a URL or a file name that spells one renders its bytes at that boundary, `digest.toHex()`.

### Parsing text

`Type.cast(lexical, T)` is PostgreSQL's own cast from text into an integer type, `pg.numeric(p, s)`, `pg["double precision"]`, `pg.boolean` or `date`, read as XML Schema reads `xs:integer`, `xs:decimal`, `xs:double`, `xs:boolean` and `xs:date`. Each type has one lexical form, `lexicalForm(T)`: XML Schema's lexical space cut to the values `T` holds exactly, so the cast never raises and never rounds.

| `T` | `lexicalForm(T)` |
| --- | --- |
| an integer type | `[+-]?[0-9]+` within the type's range, a bigint's 19th digit included |
| `pg.numeric(p, s)` | at most `p - s` integer and `s` fraction digits, besides leading and trailing zeros |
| `pg["double precision"]` | a mantissa of at most 15 significant digits either side of its point, with an exponent of at most 293; or `INF`, `-INF` or `NaN` |
| `pg.boolean` | `true`, `false`, `1` or `0` |
| `date` | `YYYY-MM-DD` from 0001 to 9999, leap days by the Gregorian rule, no timezone |

The cast is total, and compiles, exactly when every value of its operand is in the form: a field typed `lexical(T)` or `str.regex(lexicalForm(T).source)`, a text whose pattern's language lies inside the form, proved by comparing the two languages' automata, or a subject under `Logic.when(Text.matches(x, lexicalForm(T)), (x) => Type.cast(x, T), otherwise)`. Anything else is `PartialOperation` with the precondition `lexical`. Two languages whose automata the comparison cannot build within 2,048 DFA states and 2,097,152 NFA-state visits are `ResourceBound`, naming both patterns.

So a typed value derived from its lexical form is a generated field, `generated(pg.bigint, Type.cast(row.count, pg.bigint))`: NOT NULL, computed by PostgreSQL from the text it agrees with, and read by a law as any field is. A numeric's cast is `::numeric(p, s)`, which the form keeps from rounding; a date's is `make_date` over the text's year, month and day, since `text::date` reads `DateStyle` and is STABLE, which a generated column refuses. The host reads each form by a scan of its own and agrees with PostgreSQL to the bit, a double's rounding included.

`Text.parseDouble(x)` reads any decimal text of a double, of any digits and any exponent, by IEEE 754's conversion to binary64, the one JavaScript's `Number` and Java's `Double.parseDouble` make: the text's exact value rounded to the nearest double, ties to even, an infinity of its sign past the greatest finite double, and a zero of its sign below half the least subnormal. Its text is `doubleText`, the grammar of XML Schema 1.1's `xs:double` lexical space: `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` with an optional `[eE][+-]?[0-9]+`, or `INF`, `+INF`, `-INF` or `NaN`, which name themselves. It compiles as a cast does, over a field whose pattern lies inside `doubleText` or a subject under `Logic.when(Text.matches(x, doubleText), (x) => Text.parseDouble(x), otherwise)`; anything else is `PartialOperation` with the precondition `lexical`. So `1e400` is `Infinity`, `-1e-400` a negative zero, equal to zero as every double's zero is, and `1.7976931348623157e308`, `5e-324` and `1.2345678901234567` the doubles they name, where `Type.cast` into `pg["double precision"]` keeps its bounded form, since PostgreSQL's own `float8in` refuses an overflow and an underflow. Its SQL reads the digits and exponent with plain text functions into a numeric of at most 769 significant digits, its exponent clamped within ±324, and rounds that once, so it stands in checks, generated fields and queries over a text of any length.

`Text.parseDecimal(x)` reads a decimal text of any digits into numeric exactly, by XML Schema's `xs:decimal` lexical mapping: its digits, signed, over ten to the count of its fraction digits, a numeric of no typmod. So `1.50`, `+001.5` and `1.5` are one value, and a text past 256 integer or 255 fraction digits is the value it names, never rounded, clamped or read as an infinity. Its text is `decimalText`, the grammar of XML Schema 1.1's `xs:decimal` lexical space, `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)`, within `decimalTextMaxBytes` UTF-8 bytes, 16,384. Every such text names a value PostgreSQL's numeric holds, at most 16,383 digits past its point; one byte more can name one it does not hold. A regex counts no run past 255, so the byte bound stands beside the pattern, as `str.bytes` does. The parse compiles over a field whose pattern lies inside `decimalText` and whose type bounds its bytes within 16,384, `str.bytes(16384, str.regex(decimalText.source))` or a refinement of it, or a subject under both guards, `Logic.when(Text.matches(x, decimalText), (x) => Logic.when(Num.within(Text.octetLength(x), 0, 16384), () => Text.parseDecimal(x), otherwise), otherwise)`, the byte guard standing where `octetLength` does. Anything else is `PartialOperation` with the precondition `lexical`, whose guard names the test the operand lacks. The value of a text of at most n bytes has at most n integer and n - 1 fraction digits, so it casts into `pg.numeric(2n, n - 1)` with no guard. Its SQL is `x::numeric`, IMMUTABLE, so it stands in checks, generated fields and queries. Where `Type.cast` into `pg.numeric(p, s)` keeps its form of at most 256 integer and 255 fraction digits, compare decimals of any length by their parse. Never let an `otherwise` stand for a value, such as an infinity: a rule over it then passes on a text that does not parse, so state what the rule holds of such a text in the rule.

XML Schema collapses a number's white space before it reads it. Guard the collapsed text, and the branch reads it as text of the collapse's language and the guard's pattern together, as a guard narrows any term: `Logic.when(Text.matches(Text.collapse(x), doubleText), (x) => Text.parseDouble(x), otherwise)` parses ` 1.5 ` and `\t-2e3\n`, and a translation, a cast and a value's base narrow alike.

### Network containment

`Net.within(a, b)` is PostgreSQL's `a <<= b`, whether `a` lies within the network `b` or is it, `Net.strictlyWithin(a, b)`
its `a << b`, within and not `b` itself, and `Net.overlaps(a, b)` its `a && b`, whether either lies within the other.
Each operand is an inet or a cidr, a contract over one among them, of either type whatever the other's, so an address
is tested against a network as each is stored; a JavaScript value takes the first operand's type. `>>=` and `>>` are
`within` and `strictlyWithin` with their operands swapped. Each is a predicate, false across the address families as
PostgreSQL defines it, and defined on every pair of values, so it stands in a query's filter, a row check and a rule
alike, and the host's evaluation of it is PostgreSQL's, bit for bit.

```ts
/** An organization's networks, each a cidr under the organization's key. */
export const Network = relation("Network", { org: ClerkOrg, network: pg.cidr }, ["org", "network"])
export const Campus = schema("Campus", [Network], [])
/** The address a request reached the server from, as its edge reports it: attested by the server, never the client's. */
export const Origin = attested("Origin", { address: pg.inet })

/** The organizations whose networks the request's address lies within. */
export const orgsHere = query(Campus).rule((r) => {
	const { org, network } = v(Network, "network")
	const { address } = v(Origin, "origin")
	return r
		.match(Network, { org, network })
		.match(Origin, { address })
		.where(Net.within(address, network))
		.find({ org })
})
```

A containment in a query's filter of a stored inet or cidr and a value the probe knows, a parameter's, a literal's or a
join partner's, a context's address among them, requests a GiST index on the column: inet_ops, PostgreSQL 19's default
GiST class for inet and cidr, serves `<<=`, `<<`, `>>=`, `>>` and `&&` alike, so the probe reads the networks that
contain or lie within the value and no other row. A rule's judge reads its rows by its equalities' keys and filters
by the containment.

### No outer joins

Where SQL would LEFT JOIN and fill the gaps with NULL, a second rule covers the rows that have no match:

```ts
/** Tickets sold per show, zero included: the second rule covers the shows a LEFT JOIN would pad with NULL. */
export const sold = query(BoxOffice)
	.rule((r) => {
		const { id } = v(Show, "show")
		const { id: ticket } = v(Ticket, "ticket")
		return r
			.match(Show, { id })
			.match(Ticket, { id: ticket, show: id })
			.find({ show: id, sold: r.count() })
	})
	.rule((r) => {
		const { id } = v(Show, "show")
		return r
			.match(Show, { id })
			.where(r.not(Ticket, { show: id }))
			.find({ show: id, sold: 0n })
	})
```

Its rows are `{ show: string; sold: bigint }`, one per show, since `0n` takes the count's type, `natural`, whose
values are bigints.

### Nearest rows

```ts
import { Distance } from "@bjornpagen/grizzle"

/** A QTI item's identifier, and a lesson's and a catalog's slugs. */
const ItemIdentifier = str.regex("^[A-Za-z_][0-9A-Za-z_.-]{0,63}$")
const LessonSlug = str.regex("^[a-z0-9-]{1,96}$")

export const Missed = relation("Missed", { id: ItemIdentifier, embedding: pg.vector(1536) }, ["id"])
export const Lesson = relation(
	"Lesson",
	{ id: LessonSlug, catalog: LessonSlug, embedding: pg.vector(1536) },
	["id"]
)
export const Seen = relation("Seen", { learner: ClerkUser, lesson: LessonSlug }, [
	"learner",
	"lesson"
])
export const Tutor = schema("Tutor", [Missed, Lesson, Seen], [])

/** The twenty lessons of a catalog nearest a missed question's stored embedding, the question named by its key. */
export const nearMissed = query(Tutor)
	.rule((r) => {
		const { id, catalog, embedding } = v(Lesson, "lesson")
		const missed = v(Missed, "missed")
		return r
			.match(Missed, { id: r.param("missed", Missed.fields.id), embedding: missed.embedding })
			.match(Lesson, { id, catalog, embedding })
			.where(r.eq(catalog, r.param("catalog", Lesson.fields.catalog)))
			.find({ lesson: id, distance: Distance.cosine(embedding, missed.embedding) })
	})
	.approximateNearest({ by: "distance", take: 20 })

/** The lessons a learner has seen. */
export const seenBy = query(Tutor).rule((r) => {
	const { lesson } = v(Seen, "seen")
	return r
		.match(Seen, { learner: r.param("learner", Seen.fields.learner), lesson })
		.find({ lesson })
})

/** Both reads of a step, in one statement. */
export const stepReads = query(Tutor).reads({ nearest: nearMissed, seen: seenBy })
```

`.approximateNearest({ by, take })` searches one rule's rows, nearest first by `by`, a `Distance.cosine` between a vector the rule matches and one query vector, through the HNSW index the workload's search requests, at most `take` of them. The query vector is one value for the whole statement: a parameter, a literal, or a field of another match than the ranked vector's, whose whole key the rule fixes to parameters or literals, in the match or by a `where` equality, `Missed` matched by its `id` above, which holds at most one row, so its fields are its row's. A match keyed to one row ranks at most that row, so a distance between two of its own fields ranks nothing. The statement reads that row by its key once, before the search, in a subquery PostgreSQL runs as an InitPlan, so the index orders by the stored vector as it orders by a parameter, in one scan. A key that holds no row leaves no candidates, an empty answer and no error, and the scan then never runs.

`query(S).reads({ ... })` is a record of named queries as one query of exactly one row, which holds each query's rows under its name, an array in that query's own order: its `orderBy` or `take`, otherwise its key. `stepReads`' row is `{ nearest: ReadonlyArray<{ lesson: string; distance: number }>; seen: ReadonlyArray<{ lesson: string }> }`. Each query's parameters are its own under its name, `"nearest.missed"`, `"nearest.catalog"` and `"seen.learner"`, so two reads never share one by its name. The record is one statement, whatever its queries are, searches among them, so its queries read one snapshot under any isolation, and its `explain` plans that one statement. It is a query like any other: `stepReads` is a member of a workload. Each query is an attachment of the unit row, the one row of no columns `r.find({})` holds, and an attachment under a parent of no columns reads none of its columns; under any other parent, an attachment that reads none of the parent's columns is refused with `AttachedParentUnbound`.

### Full text search

```ts
import { searchDocument } from "@bjornpagen/grizzle"

/** A unit of a course: its subject, grade, texts and embedding, and the search document of its title and summary. */
export const Unit = relation.generated(
	"Unit",
	{
		id: LessonSlug,
		subject: pg.integer,
		grade: pg.integer,
		title: Prose,
		summary: Prose,
		embedding: pg.vector(1536)
	},
	["id"],
	(r) => ({ search: searchDocument("english", ["A", r.title], ["B", r.summary]) })
)
export const Course = schema("Course", [Unit], [])

/** A query's text, within 4,096 bytes. */
const SearchText = str.bytes(4096, str.regex("^.*$", "su"))

/** The ten units of a subject up to a grade that best match a web search's text. */
export const searchUnits = query(Course)
	.rule((r) => {
		const { id, subject, grade, search } = v(Unit, "unit")
		const q = Search.websearch(r.param("q", SearchText))
		return r
			.match(Unit, { id, subject, grade, search })
			.where(
				r.and([
					Search.matches(search, q),
					r.eq(subject, r.param("subject", Unit.fields.subject)),
					r.le(grade, r.param("grade", Unit.fields.grade))
				])
			)
			.find({ unit: id, rank: Search.rank(search, q) })
	})
	.orderBy(["rank", "desc"])
	.take(10)
```

`searchDocument(configuration, [weight, text], ...)` is a generated field PostgreSQL parses from its row's texts: `setweight(to_tsvector('pg_catalog.<configuration>', text), weight) || ...`, the parts concatenated in their order, a tsvector stored with the row. The configuration is one of pg_catalog's (`textSearchConfigurations`: `simple`, and one per Snowball language, `english` among them), named per field and the document's type: a query is parsed under the configuration of the document it meets, so no query is ever read under another, and two documents of two configurations are two types. A weight is `A`, `B`, `C` or `D`, which a rank weighs a match by. Each text is a text term of the row, as a generated field's term reads it. A read delivers the document as the text PostgreSQL prints for it, `SearchDocument`, under the brand a read alone mints; no parameter carries one, and no key, rule, comparison, contract or fold reads one.

**A stored document.** `pg.tsvector(configuration)` is a search document's field its caller writes: each value a `SearchDocument` of its configuration a read delivered, written back as it is, so a read's documents can be kept with the rest of its rows and matched and ranked there as any document is. Its value is the text PostgreSQL prints, its lexemes quoted in their one order, each once, its positions ascending; any other text, one PostgreSQL would read and store as another document, is an `EncodingFailure` (`searchDocumentForm`), and one past PostgreSQL's sizes, a lexeme over 2,047 bytes or a document over 1,048,575, is `searchDocumentSize`. Over the wire a document is its text, which a served write's facts state as the host does, any other refused as `searchDocument`, the gap its JSON Schema lists (`x-grizzle-gaps`). A query's row states one by a term of its type.

`Search.websearch(text)` reads a query's text by `websearch_to_tsquery`, a web search engine's syntax of quoted phrases, `or` and a leading `-`, and `Search.plain(text)` by `plainto_tsquery`, every word required. A query is no term: `Search.matches(document, query)`, the predicate `document @@ query`, `Search.rank(document, query)`, ts_rank's real, and `Search.rankCd(document, query)`, ts_rank_cd's, read it, each in PostgreSQL's two-argument form, its default weights (A 1.0, B 0.4, C 0.2, D 0.1) and no normalization. A match in a query's filter over a stored document requests a GIN index on the document's column, which serves it: PostgreSQL reads the rows the query's lexemes hold, never the table. `searchUnits` delivers `{ unit, rank }`, best first, ties broken by `unit`, its key.

Text search is PostgreSQL's alone. What a document holds is its configuration's parser, dictionaries and stop word files, read under the database's builtin C.UTF-8 locale, which no host reproduces, so the host evaluates no document, match or rank, and every position a host judgement stands in refuses one: a contract predicate, a row check and a generated field compute no `textMatches`, `textRank` or `textRankCd`, a type error and `UnsupportedOperation` when the schema compiles; a document is made in a generated field alone. A query's text is read within `textQueryMaxBytes`, 262,143 bytes, by its type or by a byte guard whose branch the read stands in, `Logic.when(Num.within(Text.octetLength(q), 0, 4096), () => …, otherwise)`, since PostgreSQL refuses a query whose lexemes pass 1,048,575 bytes and a read never fails on a value; any other text is `UnsupportedOperation` when the query compiles.

### Hybrid search

```ts
import { Num, Type } from "@bjornpagen/grizzle"

/** The twenty units of a subject up to a grade nearest a query's embedding. */
export const nearUnits = query(Course)
	.rule((r) => {
		const { id, subject, grade, embedding } = v(Unit, "unit")
		return r
			.match(Unit, { id, subject, grade, embedding })
			.where(
				r.and([
					r.eq(subject, r.param("subject", Unit.fields.subject)),
					r.le(grade, r.param("grade", Unit.fields.grade))
				])
			)
			.find({
				unit: id,
				distance: Distance.cosine(embedding, r.param("vector", Unit.fields.embedding))
			})
	})
	.approximateNearest({ by: "distance", take: 20 })

/** Each unit of either search with its place there: the count of its units at or before it, ties by unit. */
export const unitPlaces = query(Course)
	.rule((r) => {
		const near = nearUnits.bind({
			subject: r.param("subject", Unit.fields.subject),
			grade: r.param("grade", Unit.fields.grade),
			vector: r.param("vector", Unit.fields.embedding)
		})
		const x = v(near, "x")
		const y = v(near, "y")
		return r
			.match(near, { unit: x.unit, distance: x.distance })
			.match(near, { unit: y.unit, distance: y.distance })
			.where(
				r.or([
					r.lt(y.distance, x.distance),
					r.and([r.eq(y.distance, x.distance), r.le(y.unit, x.unit)])
				])
			)
			.find({ arm: "nearest", unit: x.unit, place: r.count() })
	})
	.rule((r) => {
		const text = searchUnits.bind({
			subject: r.param("subject", Unit.fields.subject),
			grade: r.param("grade", Unit.fields.grade),
			q: r.param("q", SearchText)
		})
		const x = v(text, "x")
		const y = v(text, "y")
		return r
			.match(text, { unit: x.unit, rank: x.rank })
			.match(text, { unit: y.unit, rank: y.rank })
			.where(r.or([r.gt(y.rank, x.rank), r.and([r.eq(y.rank, x.rank), r.le(y.unit, x.unit)])]))
			.find({ arm: "text", unit: x.unit, place: r.count() })
	})

/** The ten units both searches rank best together: reciprocal rank fusion, Σ 1 / (60 + place). */
export const hybridUnits = query(Course)
	.rule((r) => {
		const places = unitPlaces.bind({
			subject: r.param("subject", Unit.fields.subject),
			grade: r.param("grade", Unit.fields.grade),
			vector: r.param("vector", Unit.fields.embedding),
			q: r.param("q", SearchText)
		})
		const { arm, unit, place } = v(places, "place")
		return r.match(places, { arm, unit, place }).find({
			unit,
			score: r.sum(
				Num.div(
					Type.literal(pg["double precision"], 1),
					Type.cast(Num.add(place, 60n), pg["double precision"])
				)
			)
		})
	})
	.orderBy(["score", "desc"])
	.take(10)
```

A hybrid search is one query: an approximate search and a full text search under one route's filters, each bounded, fused by reciprocal rank (Cormack, Clarke and Büttcher, 2009), each unit's score Σ 1 / (k + place) over the searches that hold it. A unit's place in a search is the count of the search's rows at or before it, nearest or best first, ties broken by its key, 1 for the first. `unitPlaces` states that order in its `where`, since an approximate search answers its candidates as a set, each with its distance, and a record of reads delivers them by key. The score is a double, each reciprocal and the sum rounded once ([Differences from SQL](#differences-from-sql)), and k is yours, a literal of the query, here the method's authors' 60. `hybridUnits` delivers `{ unit, score }`, best first, ties by `unit`, in one statement, which runs each search once however many matches read it. A record of reads holds it as it holds any query, its parameters `subject`, `grade`, `vector` and `q` under its name.

A nearest read is approximate by its index. Its statement reads the searched relation as one ordered stream, `SELECT ... ORDER BY <vector> <=> <query vector> LIMIT current_setting('hnsw.max_scan_tuples')`, a subquery PostgreSQL neither pulls up nor filters into, and a filter beside the search, a range such as `grade`'s among them, the rule's other matches and its negations read that stream above it until the search's bound is filled: every candidate holds every filter, met in exact distance order. Under `hnsw.iterative_scan = strict_order`, which grizzle pins, PostgreSQL's scan of the HNSW index goes on past the rows the filters refuse until the bound is filled, or until `hnsw.max_scan_tuples`, which grizzle pins at pgvector's own 20,000 and the stream reads where it runs, or the owner's `hnsw.scan_mem_multiplier` stops it; a row the scan meets after it returned a farther one is dropped to keep the order, as pgvector 0.8.7's strict order does. So a search underfills only where those bounds stop it or strict order dropped what would have filled it, and which rows it returns is HNSW's approximation, never proved the exact nearest. No statistic of a filter decides the read: PostgreSQL drives the stream from the HNSW index once the relation holds more rows than the index scan costs over a sorted read of all, from about 50,000 rows of eight dimensions on PostgreSQL 19, and reads a smaller relation whole and sorted, its candidates then exactly the nearest. A full text search reads its relation alike, the match the stream's own condition (`WHERE <document> @@ <query> OFFSET 0`), its rows what the GIN index finds, and the filters beside it above them; neither asks an index of the relation for its filters.

## Reading

A Db runs its login's served workload and nothing else: every call is a member, `db.workload.<name>`, compiled by `grizzle generate` and loaded when the layer was built. A member's input is one record, the same in process and over HTTP: `{ params, facts }`, both always present, `{}` where the program takes none, and a paged member's `{ params, facts, window }`. Every read runs in one SERIALIZABLE READ ONLY transaction, so a query's nested results and a window's rows see one snapshot.

- **Answered reads.** A read member is live, or `answered(read)`, of a query, an ordered query, a `paged(...)` one or a key: answered at its call's instant alone and never live. Its handle holds `once`, `explain` and `explainAnalyze`, and no `watch`, which is a type error; over HTTP its answer is `reset`, its upserts, `ready`, then `end`, and its OpenAPI operation's `ready` says in `x-stream` that `end` follows it, so a CLI generated from the document offers no `--follow` for it. Its workload plans no footprint for it, so its served file records it `answered` and the installation's live source decodes nothing for it. A login whose reads are all answered, beside its writes, serves no live read: `DbLayer.make` of it requires no `LiveSource`, in its type and at run time, so it serves from a process that holds no replication session, a serverless function's among them. A `clocked(...)` read is an answered one with its clock ([The database's clock](#the-databases-clock)); a member `deferrable(answered(read))` is both.

- **`once(input)`** answers the member's value: its rows as a `KeyedList`, in its order: an ordered query's `orderBy`, ties broken by its key, and a query's that states none its key's, ascending field by field in the order of the declared key it copies. Each row's key is the fields of that order, and an upsert of `watch` places its row after the row whose key it carries. A key member's value holds the one row at its key, or none. Every failure is one `CallError`.
- **`watch(input)`** is a `Stream` of the member's events: `reset`, then an `upsert` of each row as PostgreSQL delivers it, then `ready` once the read's transaction has committed, then, live, an `upsert` or a `remove` of each row whose change alters the answer. An upsert before `ready` is provisional: an `error` before it voids the rows it delivered. `once` is `watch` folded until `ready`.
- **Windows.** A member `paged(orderedQuery)` reads a window: `window: { anchor, size }`, its anchor `{ kind: "start" }`, `{ kind: "after", key }`, `{ kind: "end" }`, `{ kind: "before", key }` or `{ kind: "at", position }`. A key is a row's `RowKey`, the values of the query's completed order, which the row's entry in a value carries. A position is the count of rows of that order before the window, 0 for its first row, any safe integer of at least 0: page `n` of size `m`, counting pages from 1, is `window: { anchor: { kind: "at", position: (n - 1) * m }, size: m }`. A window is one statement of at most `size` rows, and a window that holds no rows is past the end. A size is any safe integer of at least 1, with no default and no largest.
- **A key or a position.** A keyset window seeks past its key in the order, through the index the order is read by, so it costs its size's rows wherever it lies. A positioned window is PostgreSQL's own `OFFSET` over the same order: its statement reads and discards every row before its position, so its cost grows with its position, and the window at position 1,000,000 reads a million rows to deliver its own. The order is total, so a position names exactly one window of one snapshot, but each call is its own snapshot: a row written or deleted before a position between two calls moves every row after it, so pages read by position across calls can repeat a row or skip one. A positioned window's entries carry their keys as every window's do, so `{ kind: "after", key }` at its last entry continues it by keyset. Keyset anchors are the scalable and stable way through an order, and position anchors exist for an API whose callers name pages by number.
- **`explain(input)`** returns PostgreSQL's plan of each statement the member sends for that input, in the order it sends them, as data: one `{ statement, plan }` per statement, `statement` the name it is prepared under on every session (`grizzle_…`, as `pg_prepared_statements` and `pg_stat_statements` show it). Each is planned by `EXPLAIN (FORMAT JSON, VERBOSE)` over the statement's served text with the call's values, which runs nothing, in one transaction of the Db's role that is rolled back, so explaining a ChangeSet member writes nothing: its session stands the write up first, as its apply's does (a session's first call of a write makes its rule tables once), and each statement that fills a carrier runs, unplanned, before the statements after it are planned, so a ChangeSet member's plans are those of every statement it sends but its carriers' fills. The plan is the one PostgreSQL makes for those values, which a session uses for a statement's first executions; a session that has run it many times may switch to a generic plan. A plan node holds its node type, its estimated startup and total cost, rows and width, its children, and `on`, what it reads, named by the login's served file and never parsed back from PostgreSQL's names: `{ kind: "relation", relation }` for a table, a stored derived relation's among them, read whole or written; `{ kind: "index", relation, index: { name } }` for one read through an index; and `{ kind: "none" }` for a join, a sort or any node that reads no relation, the ChangeSet's own carriers among them, whose rows are arrays its transaction's settings hold. A key member takes its key's values as its params, and a paged member explains its window's statement. A plan that reads a table or index the served file does not name is refused as unreadable. A served file names each index alone, so no running process loads what an index is: `indexesOf(snapshot)`, from `@bjornpagen/grizzle/compile`, takes the JSON value of the snapshot.json the file was generated beside and returns a `Result` of a map that holds, under each relation and then each index name, `{ columns, reasons }`. `columns` are the index's key columns in key order, each `{ kind: "field", field }`, a field of the relation by its declared name, or `{ kind: "law", holds, laws }`, a column a law adds, by the field whose values it holds and the laws it is added for, and each with its `direction`, `"asc"` or `"desc"` in a B-tree and `"none"` in an index that orders nothing; so a test holds a plan's index to "leads with `document`, then `start`" in field names. `reasons` are why the installation holds it: each law it serves by its identity, the `id` a refusal names that law by; the workload's access; or a derived relation's key.
- **`explainAnalyze(input)`**, on a read member, runs its statement under `EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE)` in the read's own transaction, rolled back, and returns each node's actual time to its first and last row, rows and loops, and the shared buffers it hit and read, beside its estimates, with the statement's planning and execution times. A ChangeSet member has none.

```text
yield* db.workload.postPage.explain({ params: { org, slug }, facts: {} })   // abridged
[{ statement: "grizzle_…", plan: { node: "Nested Loop", on: { kind: "none" }, rows: 1, …, children: [
  { node: "Index Scan", on: { kind: "index", relation: "Post", index: { name: "__post_pk_dyy23qj6j2" } }, … },
  { node: "Index Scan", on: { kind: "index", relation: "Comment", index: { name: "__comment_pk_…" } }, … }] } }]
(yield* Effect.fromResult(indexesOf(snapshot))).get("Post")?.get("__post_pk_dyy23qj6j2")
{ columns: [{ kind: "field", field: "org", direction: "asc" }, { kind: "field", field: "slug", direction: "asc" }],
  reasons: [{ kind: "law", law: "__post_pk_org_slug_…" }, { kind: "access" }] }
```

- **A member's calls** are exactly what its program allows: a read's `once`, `watch`, `explain` and `explainAnalyze`; an answered read's, a clocked one's among them, `once`, `explain` and `explainAnalyze`; a ChangeSet's `once`, `watch` and `explain`. A ChangeSet member with array members, facts its `insert`, `insertAll`, `delete` or `put` was given as an array, takes them as its input's `facts`: under each such member's op, `insert` (an `insertAll`'s members are inserts), `put` or `delete`, and then under its relation's name, the rows that member takes, typed and checked as its own (an owner's insert's with their families nested), as in `once({ params: {}, facts: { put: { Blob: stated }, delete: { Blob: removed } } })`. An op or relation left out, a row that is no fact of its relation and a name that is no array member's op or relation are type errors, and two array members of one op and one relation in two strata are refused where the strata meet: merge them into one. Every other member's facts are `{}`.
- **No other program runs.** A Db holds only the members its served file holds, each prepared under the name generate gave its text. A program built at run time runs once a workload names it and generate serves it, so put every program your application runs in a workload.
- **A session's first call of a write stands the write up.** Before a session's first call of a ChangeSet member, one
  transaction of its own, framed as the call is, makes in the session, for each table the write writes that a rule over
  a query reads, the rule judge's temporary tables, by the table's stand-up ([Rules over queries](#rules-over-queries)).
  The session remembers what it stood up, so each is made once a session, whichever member needs it first, and a call's
  own transaction makes no relation: the plans a brand-new backend's first call makes serve its second.
- **No served statement names an object of its session.** Rows one statement of a write makes and a later one reads,
  which no later statement could make again since the statements between changed what they read (a relation
  parameter's evaluation another state reads, a member or a sub-query two statements of a stratum read, a delta side a
  read-back after the last stratum reads, a member slot two statements read), travel in the transaction's own settings:
  the statement that makes them writes each column's array by `set_config(..., true)`, and each later statement reads
  them as `ROWS FROM (unnest(current_setting(...)::text[]), ...)`, each element cast back to its type, one function scan PostgreSQL evaluates once a
  statement however often a plan rescans it, over PostgreSQL's own text of the typed array, as every parameter travels. So
  every statement's text is its program's alone and one statement in every session, one `queryid` in
  `pg_stat_statements`, planned once a session; no session creates, empties or truncates anything to run a write, and no
  role needs `TEMPORARY`. A column's array is one setting's value, so one carrier is bounded as a parameter is, by
  PostgreSQL's longest text.
- **A call's planned queries are bounded.** `plannedQueriesOf(login, snapshot, workloads)`, from
  `@bjornpagen/grizzle/compile`, compiles `login` under `snapshot` as `compileServed` does and returns, under each role
  and then each member of its workload, the most `pg_stat_statements` entries one call of the member makes, a session's
  first call with its stand-ups included: `{ kind: "bounded", queries, by }`, `by` the same entries by the user each runs
  as (`login`, the login's own; `role`, the role it enters; `owner`, the installation's, every function and trigger of
  grizzle's) and whether it runs at the top level, as `pg_stat_statements` keys them. A test that measures a call by
  `pg_stat_statements` (track `all`, track_planning on), resetting it before the call, sets `pg_stat_statements.max` to
  its largest member's bound and loses no entry. The bound counts every statement the call sends, by the user it runs as,
  and every query PostgreSQL plans behind them, which `snapshot.json` records of the installation (`derived.planned`):
  each SPI query and expression of every PL/pgSQL body the call reaches, a trigger's for the event that fires it (the
  rule judge's captures, its parts, the upkeeps of stored relations, the stand-ups and the closures they make), a row
  function's, the queries of each foreign key's NO ACTION check and ON UPDATE CASCADE of a referenced row the call
  removes or re-keys, and a PERIOD key's check of a row it writes (a plain key's probes its index and plans none), and
  one RAISE's options, since the first RAISE a call meets ends it. Two queries PostgreSQL jumbles into one query id are counted once where their identities say so: a literal's value
  is no part of one, a relation read by its alias alone is none of its name. It is an upper bound: it counts every branch
  a call may take, a refusal's, a judge's TRUNCATE of a delta past the pages its emptying keeps and the forms a single
  statement's batched executions may send among them. A member whose call reaches a declared function, whose body
  grizzle never reads, has no bound (`{ kind: "declared", functions }`).

### The database's clock

A lease, a timer or a due instant judged by the caller's clock is judged differently by two hosts whose clocks disagree. `clocked(program, binding)` serves a query, an ordered query or a ChangeSet with each parameter its binding names bound to the database's clock: the instant the call's transaction began, `transaction_timestamp()`, counted since the Unix epoch and floored, in `"micros"`, PostgreSQL's own resolution, or `"millis"`, JavaScript's and Effect's. The program is unchanged: it declares the parameter, a `bigint`, `natural` or a consumer's contract over one, and a test serves the same program unclocked with a `now` of its own. A contract's reading is a value of it the clock makes, so the member takes the contract's key after its binding, by the parameter's name: `clocked(ranBefore, { now: "millis" }, { now: millisKey })`. A reading lies in PostgreSQL's timestamptz range, 4714-11-24 BC to 294277-01-01, in its unit, beside its declared type's bounds, and the scalar typing reads that range: a due instant `Type.cast(Num.add(Type.base(now), Type.base(delay)), Due, dueKey)`, its `delay` a contract whose predicate bounds it, `contract<typeof delayKey>()("Delay", pg.bigint, (d) => Logic.and([Logic.ge(d, 0n), Logic.le(d, 10n ** 12n)]))`, casts with no guard wherever the reading's range plus the delay's bounds fit `Due`: in millis, whose range ends near 9.2 × 10^15, it fits a bigint; in micros, whose range reaches past bigint's top, it asks a guard.

```ts
/** The calls that ran at or before the database's instant. */
export const ranBefore = query(Usage).rule((r) => {
	const { id, at } = v(Call, "call")
	return r
		.match(Call, { id, at })
		.where(r.le(at, r.param("now", Millis)))
		.find({ id, at })
})

export const UsageClock = workload(Usage, {
	ranBefore: clocked(ranBefore, { now: "millis" }, { now: millisKey })
})
```

`db.workload.ranBefore.once({ params: {}, facts: {} })` takes no `now`: the database reads it.

- **One reading per call.** Every statement, row and flight of a call reads the same instant, so a row a write stamps and the read-back that judges it agree. The reading is no later than any snapshot the call takes, so every call that committed before it is visible to the call's reads: a read of what is due at or before the reading misses nothing committed before it.
- **A reading is an observation, not an order.** Calls that do not overlap read non-decreasing instants, unless the server's wall clock steps back, as an NTP step or a failover to another host can. Overlapping calls read in neither their commit order nor the serial order their isolation proves, so a stamp is no cursor over what is visible: a read at an instant can miss a row stamped before it that commits after the read's snapshot. Keys fence a write; the clock decides only when work is due.
- **Never live.** Time passing is no change, so a clocked read is an answered one ([Reading](#reading)) with its clock: answered at its call's instant alone, its handle holds `once`, `explain` and `explainAnalyze`, and no `watch`, and over HTTP its answer is `reset`, its upserts, `ready`, then `end`. It needs no live source. To wake at an instant, watch a read of the due instants that reads no clock, and read the clocked one when an instant passes. A clocked ChangeSet is a ChangeSet member like any other, whose `watch` is its outcome, then the end.
- **The reading is the parameter's value.** It stands wherever the parameter does, cast to the parameter's type, so a contract judges it as it judges a caller's value, `refused` on the contract. The member's input holds the program's other parameters alone. A law, a check, a contract, a generated field, a derived relation and a role's entry read no parameter, so none reads the clock: a law judged against the clock would turn false with no write. PostgreSQL accepts `now()` in a table's or a domain's CHECK and judges it only at write; grizzle emits none.
- **What a binding binds.** A binding names at least one parameter of the program whose values are `bigint`s, `bigint`, `natural` or one consumer's contract over either, each with its unit; any other name is a type error, a contract over another consumer's contract among them, whose values one key would not make, a take's or a page's bound is refused, and a paged member and a key are never clocked. A micros reading past the year 294,247 on the server's clock is out of bigint's range, and refuses the call.
- **A host row's deadline is computed from the reading.** An insert's computed fields (`insertAllComputed`,
  [Writes](#writes)) read the reading as any parameter, so the rows a caller states, an owner's with its members nested among them, take a lease's
  end or a due instant from the call's own clock in the statement that writes them, never from the host's.
- **A reading is a value, never an instant.** Its parameter is a `bigint`, `natural` or a contract over one, never `instant`, which no parameter is: a deadline, a lease's end or a due instant is a reading and some arithmetic, while when a row was written is the insert's to stamp, ordered within its scope as no reading is ([Instants](#instants)).
- **A test states the clock; it never sleeps.** `compileServedMoved(login, snapshot, workloads)` (`@bjornpagen/grizzle/compile`) compiles a login's served file as `compileServed` does, but every clocked read and every ChangeSet of it declares the clock's instant and reads every instant of the database's clock as it, its clocked parameters' and its inserts' stamps alike: the Unix epoch plus the instant's microseconds as an interval, exact to the microsecond, PostgreSQL refusing an instant its timestamptz cannot hold. Serve that file with its login's `DbLayer` and open its roles with `Db.openMoved(role, options, instant)`: each call of a clocked read or a ChangeSet reads `instant`, an `Effect<bigint>` of microseconds since the Unix epoch (a millisecond is `1000n`; an instant stamps nothing before 1970, never below zero), once, and every statement of the call reads exactly that instant, whatever the database's own clock reads, so a stamp is the instant the test stated. A suite on Effect's `TestClock` passes `Effect.map(Clock.currentTimeMillis, (at) => BigInt(at) * 1000n)`, so a lease lapses when its clock travels past it; one that wants the database's own time moved reads that instant once and states it moved. A production file, whose programs declare no instant, is no moved Db's, and a moved file is no production Db's: a call that states no instant is refused as its parameters. `grizzle generate` never compiles a moved file, and the files it writes are the same with or without this facility.

### Time zones

A lesson's window, a store's opening hours or a report's local day reads an instant on a zone's wall clock. grizzle
reads it the way the database does: by PostgreSQL's tzdata, the server's own, with no zone, date or interval type of its
own, and the calendar is integer arithmetic over two numbers.

- **`Time.wall(t, zone)`** is the zone's wall clock at the instant `t`, both in milliseconds: `t` since the Unix epoch,
  the wall clock since the local epoch, 1970-01-01 00:00 on the zone's clock, a `bigint`. `t` is a `bigint` term, a millis
  reading of the database's clock among them (`clocked(program, { now: "millis" })`), never an `instant`, which counts
  microseconds: a stored instant's milliseconds are `Type.cast(Num.div(Type.base(at), 1000n), pg.bigint)`. It is defined
  where `t` lies in PostgreSQL's timestamptz range, 4714-11-24 BC to 294277-01-01, which a reading's bounds prove and a
  contract's or `Num.within`'s prove of any other term; anywhere else it is `PartialOperation` naming the guard. It is
  exact over that whole range, before 1970, at a zone's local mean time and at every daylight change: the instant plus the
  zone's offset at it, as `timezone(zone, t)` reads it, every function it calls IMMUTABLE.
- **`zone` is a closed id of a zone roster**, `closed.zones(name, zones)`, whose handles are time zones' IANA names, each
  in its Area/Location form (`"America/Chicago"`, `"Asia/Kolkata"`, `"Etc/UTC"`), in any order, its order meaning nothing,
  as an unordered roster's. A closed id of any other roster is a type error. The roster's code reaches the zone as its
  handle, read from its names constant, so no zone's name ever comes from a caller: a field, a parameter or a literal of
  the roster's closed id is a zone the schema declared.
- **A name of one component is refused** where the roster is built, `MalformedDescription`: `UTC`, `GMT`, `UCT`,
  `Zulu`, `EST`, `MST`, `HST`, `CET`, `EET`, `MET`, `WET`, `EST5EDT`, `CST6CDT`, `MST7MDT`, `PST8PDT`, `GB`, `NZ`,
  `Cuba` and tzdata's other backward names. PostgreSQL's `timezone(text, ...)` reads a name as a time zone abbreviation
  first, from the `timezone_abbreviations` setting and the session's `TimeZone`, then as a POSIX zone, and only then as a
  zone of its tzdata, so the first eleven name a fixed offset a session's settings choose and the four POSIX names a
  rule of their own, not the zone file their name is: no wall clock over them is a function of the zone alone. Each has
  an Area/Location twin (`Etc/UTC`, `America/New_York`, `Europe/London`). No abbreviation or POSIX zone holds a `/`.
- **The migration checks each zone on the server.** The migration that installs a zone roster, or changes its handles,
  reads each one as a time zone first in Setup, `timezone('<zone>', ...)`, so a handle the server's tzdata lacks refuses
  the migration with PostgreSQL's 22023 before anything changes, and no read of `Time.wall` ever raises. A production
  server ships its own tzdata (RDS updates it in its minor versions), and this is where it is held to the schema.
- **A query reads it, nothing else.** The host holds no tzdata: Node's ICU is its own version of tzdata (Node 26.13.1's
  is 2025c, PostgreSQL 19.0's bundled one 2026f, and they disagree in 26 zones), and no host could be pinned to a
  production server's. So a check, a contract predicate and a generated field, which the host evaluates, refuse
  `Time.wall`, as they refuse a declared function's call, and a row's evaluation never states a wall clock.
- **`Time.epochDay(date)`** is a date's days after 1970-01-01, negative before it, an integer, `x - '1970-01-01'::date`,
  and **`Time.dateOfEpochDay(n)`** the date `n` days after it, an `integer` or a `bigint` term, an exact integer cast into
  one first, `'1970-01-01'::date + n`, defined where `n` is the epoch day of a date grizzle holds, 0001-01-01 to
  9999-12-31, which its bounds prove or a `Num.within` guard. The host computes both, so they stand in a query, a check
  and a generated field alike.
- **The calendar is integer arithmetic.** A wall clock's milliseconds into its local day are `((w mod 86400000) +
  86400000) mod 86400000`, `Num.mod` keeping the dividend's sign as SQL's `%` does, and its local day `(w - intoDay) /
  86400000`, a division that is exact: so a wall clock before the local epoch lies in its own day, never the next. A local
  day's weekday is `((day + 4) mod 7 + 7) mod 7`, Sunday 0, 1970-01-01 a Thursday, and its date `Time.dateOfEpochDay`. A
  local wall clock's instant is a guess, the wall clock read as an instant, `g`, less the zone's offset at it, `g - (wall(g)
  - g)`: in a daylight gap the wall clock names no instant and this is the instant at the offset before the gap; in an
  overlap it names two and this is the one of the offset the guess reads.
- **A tzdata change moves a wall clock.** PostgreSQL declares `timezone(text, timestamptz)` IMMUTABLE, but the server's
  tzdata is updated in place: a read after an update reads the new rules. grizzle stores no wall clock, so nothing it
  holds goes stale.

```ts
/** Each branch's zone and the minute of its local day it opens at. */
export const BranchZone = closed.zones("BranchZone", [
	"America/Chicago",
	"America/New_York",
	"Asia/Kolkata"
])
export const Branch = relation(
	"Branch",
	{ id: pg.integer, zone: closedId(BranchZone), opens: pg.integer },
	["id"]
)
export const Branches = schema("Branches", [BranchZone, Branch], [])

/** Each branch's minute of its local day and weekday at the database's instant. */
export const branchClock = query(Branches).rule((r) => {
	const { id, zone, opens } = v(Branch, "branch")
	const wall = Time.wall(r.param("now", Millis), zone)
	const intoDay = Num.mod(Num.add(Num.mod(wall, 86_400_000n), 86_400_000n), 86_400_000n)
	const day = Num.div(Num.sub(wall, intoDay), 86_400_000n)
	return r.match(Branch, { id, zone, opens }).find({
		id,
		minute: Num.div(intoDay, 60_000n),
		weekday: Num.mod(Num.add(Num.mod(Num.add(day, 4n), 7n), 7n), 7n)
	})
})

export const BranchesClock = workload(Branches, {
	branchClock: clocked(branchClock, { now: "millis" }, { now: millisKey })
})
```

## Writes

A write is a ChangeSet: rows to insert, delete and put, applied as one transaction.

```text
ChangeSet.empty(Blog)               a write over a schema, or over a role: ChangeSet.empty(MemberBlog)
  .insert(Post, rows)               add these rows; a row already present is no change, which delta.met returns
  .insertAll({ Post: rows })        an insert of each relation the record names by its key
  .insertAllComputed({ Lease: rows }, { until })   each relation's rows leaving out the fields the call computes, once
  .delete(Comment, rows)            remove these rows
  .deleteWhere({ Comment: { post: param("post", Slug) } })     remove the rows whose fields equal these values
  .put(PostViews, rows)             after the change, the row at each key is the one given
  .read("name", (delta) => query)   a query over the result, delivered in the outcome
  .bind({ org, sittings: mine })    the parameters it names, ahead of apply: a value, rows, or a query of a relation
                                    parameter's rows, read once before this ChangeSet's first stratum; the rest stay
                                    the program's
```

- **Rows** are an array, an Effect `Stream` or a query, in any number; each column travels as one array. A query reads
  the state before its stratum, in the same transaction. There are no interactive transactions: a write that depends
  on a read states the read as its query.
- **A relation parameter bound to a query is an input of the call**, not a member's query, and it is scoped to the
  ChangeSet it was bound on, as a let is to its body: `.bind({ sittings: mine })` gives it one value, `mine` evaluated
  once in the state before the first stratum of that ChangeSet, and every member of every stratum and every read-back
  of it that reads `sittings` reads that one evaluation. A bind on the whole call's ChangeSet is evaluated before the
  call's first stratum: metis's assignment, `ChangeSet.sequence(held, assigned).read(…).bind({ target: picked })`,
  reads back the items `picked` chose before the call, never a pick made again over the state after it. A bind on a
  part sequenced after another is evaluated after the earlier part's writes, as that part's own members read them:
  edullm's take, `ChangeSet.sequence(decide, ChangeSet.union(take, grants).bind({ taken: mine }))`, takes the sittings
  `mine` holds once `decide` has written its decision. ChangeSet.union keeps each part's binding where it was. Contrast
  a member's own query, which reads the state before *its* stratum, and a read-back's, which reads the tables after the
  change: a bound parameter reads the state before its part, and no stratum or read-back reads it again. Where every
  reader reads a state that agrees with that one on every relation the parameter's query reads, through derived
  definitions and a role's entries (no stratum between writes one), its query is a part of theirs, as an import's is:
  metis's assign binds its target test to a read of the catalog, which no stratum of the assign writes, so each
  statement reads the catalog itself, keyed by the call's test; otherwise it is filled into a carrier first among that
  stratum's statements, every reader reading the carrier. The two realize one meaning, as a
  CTE inlined or held does one query; a read-back over such a parameter reads no table the change writes, so it rides
  the statement making the delta it reads, unless that statement comes before the part that bound it, where its rows
  are not yet read: then it runs after the change, over its delta carried there (below, "Where a read-back runs").
- **`insertAll`**'s rows at each key are what `insert` takes for that relation, typed and checked as that insert and
  refused at their key. Its keys are required, and their order means nothing. `insertableNamesOf(schema)` names, in the
  schema's order, every table a ChangeSet over it inserts at the top level: all that `writableNamesOf` names but an
  ordered family's members, which are nested under their owner; a counted family's members and a tree's table are
  among them. `InsertableNameOf<S>` is their type, and `InsertAllRowsOf<S>` is the record `insertAll` takes over all
  of them, each table's rows an array of its `AdditionIn<S, R>`, so `ChangeSet.empty(Credits).insertAll(rows)` with
  `rows: InsertAllRowsOf<typeof Credits>` writes grants and debits at once.
- **`deleteWhere`** removes, of each table the record names by its key, the rows whose named fields equal the given
  values, each a parameter, `param(name, descriptor)`, or a literal of the field's type: `DELETE FROM t WHERE post = $1`,
  and the conjunction for several fields; `{}` removes every row. It is the delete of the query that matches the table's
  rows and keeps those, so it plans, refuses and certifies as that delete does: a tree's selection names its root
  fields and removes whole trees, an owner's removes every row nested under it, and a family's member, whose delete is
  its family's edit, is a type error. A field names only the rows the table's delete states (`Written<R>`, or a tree's
  root), and a value is a parameter or a literal, never a variable, a typed constant or a scalar term, so a delete
  that reads another table or compares otherwise is a query's. Its keys are required, and their order means nothing.
  `ChangeSet.empty(S).deleteWhere({ Node: { package }, Entry: { package } }).insertAll(rows)` replaces a package.
- **A row holds the fields its caller writes**, `Written<R>` ([How a field is written](#how-a-field-is-written)). A
  family's member is a row of its own, nested under its owner only in a sequence ([Families](#families)), and written
  from an array or a `Stream`, never from a query or through a query entry, since grizzle draws its family's values
  from its rows on the host. Its owner may be written through a query entry
  ([Writing through a role](#writing-through-a-role)).
- **A relation's rows are a set.** Identical rows are one row. Two rows one stratum adds to one relation that share a
  key and differ elsewhere are `refused` on that key before any SQL is sent, or, at a key over a generated
  field, by the statement that writes them. Two rows it deletes at one key are no refusal: a deletion names its row
  exactly, so at most one of them is stored, and deleting the other changes nothing. At the primary key, an array literal of up to 1,024 such rows with literal values is a
  type error. A row one stratum both adds and deletes stays; one it both inserts and puts is the put's. Laws are
  judged only once every row and parameter of the application encodes: a row or a parameter that does not, a missing
  parameter among them, is its `EncodingFailure`, whatever key the other rows share or generated field they leave
  without a value.
- **A row states its whole fact.** grizzle mints no ids and PostgreSQL draws none: every field a caller writes is in
  every row, its key among them, and a row that leaves one out is an `EncodingFailure`
  ([Identity: natural keys](#identity-natural-keys)). An instant is no caller's: an insert's row leaves it out and the
  database stamps it ([Instants](#instants)).
- **`insertAllComputed`** inserts host rows that leave fields for the call to compute: `insertAllComputed(rows,
  computed)` takes insertAll's record, under each relation's name an array or a Stream of its rows, and a record of
  fields, at least one, to terms over the call's parameters, its clock reading and literals, each a caller-written
  field of every relation the record names, written at its field's own type as a query member's head is, a relation
  that lacks one refused at its key: `ChangeSet.empty(Den).insertAllComputed({ Claim: [] }, { until:
  Type.cast(Num.add(Type.base(param("now", DenInstant)), Type.base(param("budget", Budget))), DenInstant,
  denInstantKey) })`, served `clocked(…, { now: "millis" }, { now: denInstantKey })`, whose rows `{ step, holds: [{ resource }] }` leave `until` out (the row type omits
  every computed field), and edullm's pantry inserts every relation of a package computing `package` from its one
  parameter. The call evaluates the record once for each relation, one value of each field for every row of it the
  stratum's host rows insert, in the statement that writes them: a plain insert's own, or a nested insert's family statement, where every member field
  filled from a computed field of its owner, by its group or by its copy along the owner axis, holds its owner's one
  value, at any depth, never a value of its own; a generated field over one is PostgreSQL's, and a fold or a copy that
  reads one on the host is refused as `UnfillableField` (`stamped`). A computed field is part of the fact the call states, so a stored row at its key that differs there is refused
  on the key. Every row of a call holds the call's one value of a computed key field, so two of its rows that share the
  key's other fields and differ elsewhere are two facts of one key, refused before any SQL is sent, and a put of the
  relation in the same stratum meets the call's rows at that key in the database, as a stored row does. A stratum computes one record for each relation; a query member's head computes its own fields
  instead, and an insert through a query entry states every field.
- **A put at a no-overlap key** holds its row over every point of its span, as a put at a scalar key holds its row at
  its key: it displaces each stored row that agrees with it on the key's other fields and shares a point of its span,
  which the key would refuse beside it, every such row, one or several, and inserts its own. A row equal to it stays,
  so an identical put is no change. A window extended to a later end is a put of the whole new window, which displaces
  the window it grows from ([A window a put extends](#a-window-a-put-extends)).
- **`read`** runs its query after the change, before COMMIT. `delta.added(T)` and `delta.removed(T)` are the rows the
  change added and removed, and `delta.met(T)` the stored rows its insertions met ([Rows an insertion
  met](#rows-an-insertion-met)). A ChangeSet's read-backs are one set by name, each run once after the whole change,
  so a name read again, by `read`, `ChangeSet.union` or `ChangeSet.sequence`, over the same query is the same
  read-back: two programs that each end in `.read("standing", () => standing)` compose into one that reads it once.
  One name over another query is refused: by the types where its rows are of another type, and by the builder
  (`MalformedDescription`, naming both read-backs) where only the query differs.
- **Where a read-back runs.** The rows a statement returns exist only inside it. Each side of a delta a read-back
  reads is made whole by one statement, the only one that makes that side of the table, whose rows no statement of
  another stratum nets. Where one statement makes every side the read-back reads, no statement at or after it writes a
  table the read-back reads, and every relation parameter it reads is bound before it, the read-back runs inside that
  statement, over its rows. Otherwise it runs after the change, in the state the whole write leaves: each side it reads
  is carried there out of the statement making it, which fills a session table with its rows as it makes them, so the
  read-back reads the write's own delta, keyed as the write made it, joined to every table as the write leaves it, and
  never searches the state for it again. edullm's answer reads back the attempt it recorded, `delta.added(Attempt)`,
  with the grade a later stratum writes and the status derived from both. A stratum runs the writes of tables whose
  deltas a read-back reads after its others where its foreign keys allow, so the read-back rides with no session table.
  A delta of a table no statement writes is empty, and a read-back that reads no other runs after the change. A
  read-back of a side no one statement makes whole is refused when the ChangeSet compiles
  (`ReadBackCrossesStatements`, naming the side): a side two statements make, or one another statement nets (one table
  written in two strata; a delete and an insert of one table in one stratum each make their side whole, since a row
  one stratum both adds and deletes stays): write the table in one action of one stratum, or read it back by its key.
- **Strata.** Every write in a stratum reads the state before it, so build order means nothing, and a stratum's
  members of one operation on one table are one write of their union, whatever ChangeSets they came from, but for an
  insert's host rows that leave computed fields out or own counted families, and queries that state different
  instants, each a write of its own.
  `ChangeSet.union(a, b)` merges two ChangeSets stratum by stratum; `ChangeSet.sequence(a, b)` runs `b`'s strata after
  `a`'s. Either is one transaction, over the higher of the two schemas.
- **Statement order.** A stratum's writes, its families' members and owner counts included, run in the order its
  immediate foreign keys require: a referenced row is added before the rows that name it and removed after them, so a
  family's members are deleted before their owner. Writes those keys order in a cycle are refused when the ChangeSet
  compiles (`UnorderableStratum`): move one to another stratum with `ChangeSet.sequence`.
- **A ChangeSet member's `once`** answers `accepted`, with `counts` (each written relation's `added`, `deleted` and
  `put`, as `bigint`s) and `reads`, or
  `unchanged`, with `reads`; a write the laws refuse, or one that writes outside
  its role's world, fails with its `CallError`, `refused` or `outsideWorld`
  ([Errors and outcomes](#errors-and-outcomes)). Its `watch` is that outcome, then the end.

Two writes over the blog, each one transaction and one round trip:

```ts
/** Publish a draft: the new row is read from the old one, in the same transaction. */
export const publish = ChangeSet.empty(Blog).put(
	Post,
	query(Blog).rule((r) => {
		const { org, slug, author, title, body } = v(Post, "post")
		return r
			.match(Post, { org, slug, author, title, body, status: "Draft" })
			.where(r.eq(org, r.param("org", ClerkOrg)), r.eq(slug, r.param("slug", Slug)))
			.find({ org, slug, author, title, body, status: Status.handle("Published") })
	})
)

/** Delete every comment by one author, and read back how many went. */
export const purge = ChangeSet.empty(Blog)
	.delete(
		Comment,
		query(Blog).rule((r) => {
			const { org, post, author, at, body } = v(Comment, "comment")
			return r
				.match(Comment, { org, post, author, at, body })
				.where(r.eq(author, r.param("author", ClerkUser)))
				.find({ org, post, author, at, body })
		})
	)
	.read("removed", (delta) =>
		query(Blog).rule((r) => {
			const { org, post, author, at } = v(delta.removed(Comment), "removedComment")
			return r
				.match(delta.removed(Comment), { org, post, author, at })
				.find({ comments: r.count() })
		})
	)
```

`publish` takes `{ org: string; slug: string }`; applied twice, the second answers `unchanged`, since the query finds
no draft to put.
`purge` takes `{ author: string }`, and its `accepted` outcome carries `reads.removed`, a
`ReadonlyArray<{ comments: bigint }>`: `RETURNING`, as a query over what the change removed.

### A window a put extends

A learner's presence in a sitting is one row per stretch of readings no more than 3 s apart, each from its first
reading to its last plus one microsecond, a span's end being excluded, so a window of one reading is
`[now, now + 1 µs)` and its credited time, `upper − lower − 1 µs`, is its last reading less its first exactly. One put
records a reading: its row is the window over the reading and every window of the sitting within 3 s of it, from the
earliest start to the latest end, which displaces each window it grows from.

```ts
const learnerIdKey = Symbol("LearnerId")
const stageKeyKey = Symbol("StageKey")
const momentKey = Symbol("Moment")
const readingKey = Symbol("Reading")
const LearnerId = contract<typeof learnerIdKey>()("LearnerId", pg.integer)
const StageKey = contract<typeof stageKeyKey>()("StageKey", pg.bigint)
/**
 * Microseconds on the database's clock, a window's ends, up to 10000-01-01, after which no day a date holds begins; a
 * reading is one below the top, so it ends a window too.
 */
const Moment = contract<typeof momentKey>()("Moment", pg.bigint, (t) =>
	Num.within(t, 0n, 253_402_300_800_000_000n)
)
const Reading = contract<typeof readingKey>()("Reading", pg.bigint, (t) =>
	Num.within(t, 0n, 253_402_300_800_000_000n - 1n)
)

export const Presence = relation(
	"Presence",
	{ child: LearnerId, stage: StageKey, during: span(Moment) },
	["child", "stage", "during"]
)
export const Attendance = schema(
	"Attendance",
	[Presence],
	[unit("Learner", { child: LearnerId }), mutable(Presence)]
)

/** The reading [now, now + 1 µs) and every window of the sitting within 3 s of it, each by its ends. */
const near = query(Attendance)
	.rule((r) =>
		r.find({
			child: r.param("child", LearnerId),
			stage: r.param("stage", StageKey),
			start: Type.cast(Type.base(r.param("now", Reading)), Moment, momentKey),
			end: Type.cast(Num.add(Type.base(r.param("now", Reading)), 1n), Moment, momentKey)
		})
	)
	.rule((r) => {
		const { child, stage, during } = v(Presence, "window")
		const now = Type.base(r.param("now", Reading))
		return r
			.match(Presence, { child, stage, during })
			.where(
				r.eq(child, r.param("child", LearnerId)),
				r.eq(stage, r.param("stage", StageKey)),
				Logic.gt(Num.add(Type.base(Range.upper(during, Moment)), 3_000_000n), now),
				Logic.lt(Type.base(Range.lower(during, Moment)), Num.add(now, 3_000_001n))
			)
			.find({ child, stage, start: Range.lower(during, Moment), end: Range.upper(during, Moment) })
	})

/** One window over them all: the earliest start to the latest end. */
const hull = query(Attendance).rule((r) => {
	const { child, stage, start, end } = v(near, "near")
	const bound = near.bind({
		child: r.param("child", LearnerId),
		stage: r.param("stage", StageKey),
		now: r.param("now", Reading)
	})
	return r
		.match(bound, { child, stage, start, end })
		.find({ child, stage, start: r.min(start), end: r.max(end) })
})

export const beacon = ChangeSet.empty(Attendance).put(
	Presence,
	query(Attendance).rule((r) => {
		const { child, stage, start, end } = v(hull, "hull")
		const bound = hull.bind({
			child: r.param("child", LearnerId),
			stage: r.param("stage", StageKey),
			now: r.param("now", Reading)
		})
		return r
			.match(bound, { child, stage, start, end })
			.find({ child, stage, during: r.span(start, end) })
	})
)
```

`Presence` is `mutable` in its learner's unit, the one exception to insert-only rows, and the beacon is served
`clocked(beacon, { now: "micros" }, { now: readingKey })`: its reading is `Reading`'s, one below `Moment`'s top, so `now + 1` casts into
`Moment` unguarded. A reading within 3 s of the sitting's latest window extends it, and any other opens a new one. A
call reads the clock as its transaction begins, so a slower call may read an instant before the latest window began:
its reading falls inside the windows it lies within 3 s of, or joins them, so no reading is lost and no two windows
overlap, whatever order the calls commit in, and the windows are the 3 s stretches of the readings committed.

### Rows an insertion met

`delta.met(T)` holds each stored row of `T` an insertion of the ChangeSet met at its arbiter key and did not refuse:
the row as stored, every field of it. Without it, an insertion that repeats a stored row learns nothing about that row
in the same call. The arbiter key is the primary key. A row equal at every
field the insertion states is an exact repeat: no change, and met. One that differs at a field it states is `refused`
on the key, as always, and the ChangeSet commits nothing. A put meets nothing: an equal row at its key is its own no
change.

So a call that may lose a race to another learns the row that won, in the same round trip:

```ts
/** File a post at its slug, or meet the one filed there: either way, read back the post its key holds. */
export const filePost = ChangeSet.empty(Blog)
	.insert(Post, [])
	.read("post", (delta) =>
		query(Blog)
			.rule((r) => {
				const { org, slug, title } = v(delta.added(Post), "added")
				return r.match(delta.added(Post), { org, slug, title }).find({ org, slug, title })
			})
			.rule((r) => {
				const { org, slug, title } = v(delta.met(Post), "met")
				return r.match(delta.met(Post), { org, slug, title }).find({ org, slug, title })
			})
	)
```

Exactly one rule finds each post the call states. At READ COMMITTED the later of two racing calls waits at the key
for the earlier, then reads the row it committed, even though that commit came after its own statement began, and
never fails with 40001. The row is fixed from its commit on, since a READ COMMITTED role writes only relations no role
updates or deletes. At SERIALIZABLE the met row is read again under the transaction's snapshot, so SSI sees it as a
read, and a met row the snapshot cannot see fails the call with 40001, a TransientFailure, as before. A role that
inserts through a query entry runs at SERIALIZABLE, since its precheck reads every row at each key the call states:
the precheck refuses a row outside the entry at such a key on the key's law, and a row committed after the
transaction's snapshot fails the call with 40001, whose retry's precheck refuses an outside row on the key's law.

`delta.met` of a relation whose primary key holds a span is refused when the ChangeSet compiles: its exclusion
constraint arbitrates only by `ON CONFLICT DO NOTHING`, so no statement can tell a row it met from one it made. A
family's members are a type error, since their family statement writes them. A read-back over `delta.met(T)` rides
the one statement that inserts into `T`.

### Instants

`instant` is when a row was written, on the database's clock: microseconds since the Unix epoch, written by the
database alone. A row is keyed by its natural identity ([Identity: natural keys](#identity-natural-keys)), and by an
instant after it where when it was written is part of its fact. No caller states one, so a time a row records is never
a host's clock or a value a caller passes. Every instant field is a clock or a reference, as the schema's laws make it:

- A **reference** is an instant field a containment carries, from every row of its relation, into another relation's
  instant field: its values are stored instants there, which the containment proves. Below, `Visit.at` is a
  reference to `SignIn.at`.
- Every other instant field is a **clock**. It stands in its relation's primary key after at least one field, and the
  key's fields before it are its **child**: `SignIn`'s key `(user, at)` makes `user` the child of `SignIn.at`. A clock
  outside its primary key is refused when the schema compiles (`InstantRefused`, `clockOutsideKey`), since no child
  would order it, and so is one first in its key (`childless`), whose relation would be one child every write of it
  waits on.
- Every clock is ordered in a **scope**, the writes one lock serializes: the [unit](#units) its relation sits under,
  every clock of every relation of the unit alike, or, for a clock no unit holds, its own child. A scope's key is the
  unit's heading or the child, and each value of it has one **head**, the last instant ever stamped in the scope there.
  `SignIn` below sits in no unit, so its scope is its child, `user`; under `unit("User", { user: UserId })`, every clock
  of a relation keyed `(user, …)` would stamp from `User`'s one head at each user.

```ts
/** A user's sign-in at an instant, and the visit it opened, at the same instant. */
const SignIn = relation("SignIn", { user: UserId, at: instant, method: closedId(Method) }, [
	"user",
	"at"
])
const Visit = relation("Visit", { token: Token, user: UserId, at: instant }, ["token"])
export const Auth = schema(
	"Auth",
	[Method, SignIn, Visit],
	[contained(on(Visit, "user", "at"), on(SignIn, "user", "at"))]
)

/** A sign-in and its visit in one write that reads no row: both at the call's instant for the user. */
export const signIn = ChangeSet.empty(Auth)
	.insert(
		SignIn,
		query(Auth).rule((r) =>
			r.find({ user: r.param("user", UserId), method: r.param("method", SignIn.fields.method) })
		)
	)
	.insert(
		Visit,
		query(Auth).rule((r) =>
			r.find({ token: r.param("token", Token), user: r.param("user", UserId) })
		)
	)
```

- **An insert leaves an instant out to have it stamped.** A row of an array, a Stream or a query that omits an
  instant field has it stamped with the call's instant of its clock: a clock's own, at the row's child, or a
  reference's clock, at the child its containment carries the row to, `Visit.user` above. A stamp's child is a
  field the row states, never one the same insert stamps (`childStamped`). A clock is only ever stamped: a row that
  states one is refused (`clockStated`). A reference is stamped only beside an insert of its clock
  in the same stratum, else refused (`clockUnstamped`), since no stored row could hold the instant; and a reference
  whose containments reach no one clock at one child is never stamped (`unstampable`).
- **Or states a stored instant.** A query's row may state a reference by a term of type `instant`, and only a stored
  instant is one: a variable of an instant field, or `r.min`, `r.max`, `Logic.least`, `Logic.greatest` or
  `Logic.cond` over such terms. No parameter, relation parameter's column, literal, `Type.literal`, cast, contract
  or span is of type `instant`, so each is a type error and a `CompileError`, and arithmetic over an instant is a
  `bigint`. An instant meets only instants; `Type.base(at)` reads one as the `bigint` it is. A put and a delete state
  every instant of their rows this way, from a query, and a put of a relation with a clock is refused, since it would
  state the clock.
- **One instant per scope key per call.** Every row a call stamps at one key of one scope holds one instant, whichever
  clock and child of the scope it is a row of, so rows of one child in one call that share the rest of a key need a
  field of their own in it, a place or a name, or they meet at the key. A call stamps a clock in one statement: its
  stratum's, which holds its every insert and those of the references it stamps, a table's inserts one write of all
  their sources, however many queries, arrays and Streams state them. A ChangeSet that would stamp it in two strata, or
  in a stratum of several statements, such as one that inserts a table beside a put or a delete of it, whose removals
  run first, is refused when it compiles (`stampedApart`); a later stratum reads the stamped rows back as stored
  instants. Two clocks of one scope may stamp in two strata or two statements of one call: each stamps rows of its own
  relation, and both take the call's one instant.
- **A stamped row is new.** Its instant is above every instant its scope held at its key, so an insertion that stamps a
  clock meets no stored row at the primary key: `delta.met` holds none of its rows ([Rows an insertion
  met](#rows-an-insertion-met)), and a call retried after `commitUnknown` adds them again, at a later instant.
- **The stamp.** The call's instant at a key is `greatest(c, h + 1)`: `c` the call's reading of the database's clock in
  microseconds, `transaction_timestamp()`, and `h` the key's head, the last instant ever stamped in the scope there.
  Each scope keeps its keys' heads in a table of its own, one row a key, which no role reads or writes: a unit's in the
  installation's root schema, a clock's own beside its relation. The statement that stamps calls the scope's stamp
  function, which advances each key's row by one `INSERT ... ON CONFLICT DO UPDATE` and returns it. A ChangeSet that
  stamps has a READ COMMITTED form, so its role runs at the level the rest of its workload earns ([READ COMMITTED
  writes](#read-committed-writes)).

**Why it is the scope's order.** For one key of one scope, at every level:

- **Two calls that stamp the key take turns, and instant order is commit order, across every clock of the scope.** The
  stamp function's upsert either inserts the key's head row or locks the row it meets and assigns from its latest
  committed version, whatever the calling statement's snapshot holds, and keeps that lock until the call ends
  (PostgreSQL's ON CONFLICT DO UPDATE). So a call that stamps the key while another holds its head waits for that call
  to end, then stamps at least one past its instant, and commits after it, whichever clocks the two stamp. A call that
  began before another committed reads an earlier clock, and `h + 1` carries it past the other's instant. At
  SERIALIZABLE, a call whose snapshot cannot see the head's latest version, one a call that committed since wrote, is
  refused with 40001, a retryable `transient`, and its retry stamps after it. So a law that compares two clocks of one
  unit at one key, an end with the snapshots before it, reads every row of the one stored before the other's insertion
  at an instant at most the other's: a scope's instants are commit-ordered across the clocks it holds.
- **A unit's head adds no wait.** Every write of a unit's relations holds the unit's borrow exclusively at its key from
  before its first statement ([Units](#units)), so no other call of that key could meet its head's lock: the unit's
  writes already take turns.
- **No writer states a clock out of order.** The head records the transaction that stamped each key last, and every
  relation of a clock holds a guard: each row a statement inserts, and each row an UPDATE moves to another instant or
  key, must hold its transaction's own stamp of the clock at its scope's key, else the statement is refused with 23514
  under `__clocked` (an insert, at the statement's end) or `__clock_moved` (a move, at COMMIT). A served write meets it
  by construction; a direct writer, the owner and a migration's data step alike, calls the scope's stamp function first
  and states the instant it returns, one instant a key a transaction, so a history of several instants at a key is
  written one transaction an instant, in order. The insert guard probes the head once for each distinct key and
  instant of its statement's rows: a served statement, whose rows of one call share their instant at a key, probes it
  once a key, the row its own stamp just wrote, and never scans it.
- **Calls that stamp different keys never wait on each other.** Each key's head is its own row, so no lock of one key's
  stamp is another's: the key is the shard key, and keys shard freely. A call that stamps several keys of one scope
  takes their heads in key order, so two such calls never wait on each other in a cycle. Two calls that each stamp two
  heads, scopes or places, at keys the other stamps too may: a ChangeSet that stamps one of them before the other, in
  an earlier stratum or an earlier part of one statement, beside one that stamps them the other way round. PostgreSQL
  then fails one of them with 40P01, a retryable `transient`.
- **A clock that steps back reorders nothing.** An NTP step or a failover to a host whose clock is behind gives a
  smaller `c`, and `h + 1` wins: the key's instants count up by one a write until the clock passes them again. An
  instant is never earlier than its call's reading.
- **A call that rolls back stamps nothing**: its head's advance rolls back with it.
- **No occupant of the call's microsecond is met.** A stamped row's instant is above every instant ever stamped in its
  scope at its key, so an insertion that stamps a clock meets no stored row at the primary key.
- **What a key holds.** A write may delete a row its head counted; a later stamp is still above it, since the head
  keeps the last instant stamped, not the greatest one held.
- **A clock a migration adds to stored rows** takes the migration's instant on every one, its transaction's reading
  of the database's clock, under a DEFAULT the backfill then drops, with no placeholder: re-keying `VerifiedEmail` from
  `(user)` to `(user, at)` gives each stored row the one instant, and every later insert stamps above it. A migration
  that creates a scope's head table beside stored rows, for a clock it adds, a child it re-keys, a unit it declares or
  a type it changes, fills it with each key's greatest stored instant across the scope's clocks, and one whose clock
  joins a scope over stored rows, a relation re-keyed into the unit or a clock added to one of its relations, makes the
  head again and fills it so, so every later stamp is above every row it finds. That keeps the rows apart exactly when
  the new primary key holds the old one beside the clock; a clock added under a key that does not, `(user, email)` to
  `(user, at)`, is refused when generate drafts it (`InstantRefused`, `addedOverRows`, naming both keys): keep the old
  key's fields, or re-key in a migration of its own.

**An instant stored as it is.** A read delivers an instant as an `Instant`, a `bigint` under the brand grizzle's read of
one alone mints, so a host holds an instant only where a read delivered it. `instant.stored` is a field of instant's
type its caller writes, a copy of an instant read elsewhere, which the database draws nothing of: its writing is its
caller's, where `instant`'s is the database's clock, two writings of one type. A host row states it as an `Instant` it
read, and a bare `bigint`, a host's own clock or arithmetic, is a type error; a query's row states it by a term of type
`instant`, as it states a reference. It is no clock and no reference, so it may stand anywhere in its relation, its
primary key included, and a put and a delete of host rows state it as an insert does. Its terms meet every instant's,
and it is still no parameter, literal, cast, contract or span. A relation that keeps a read's rows, an audit's or a
workflow's record of what it read, is keyed by what identifies the read, never by its instants alone.

```ts
/** What a read of sign-ins delivered, kept as it was read: its instants stored as they are. */
const SeenSignIn = relation("SeenSignIn", { user: UserId, at: instant.stored }, ["user", "at"])
```

### Places

`place` is a row's place in its group, a natural the database stamps when an insert adds the row: one past the greatest
place the group holds, 0 for its first. It stands last in its relation's primary key, and the key's fields before it are
its **group**: `relation("Claim", { step, attempt: place, holds: drawn(natural) }, ["step", "attempt"])` numbers each
step's claims 0, 1, 2, … in the order their calls commit, so a group's places are gapless from 0 with no law to state it
and no count for a write to read.

- **Declared once.** A place first in its key (`groupless`), before another field of it (`notLast`) or outside it
  (`outsideKey`) is refused when the schema compiles (`PlaceRefused`).
- **Stamped by its insert.** An insert's rows leave the place out, as they leave out every field grizzle writes: a row
  that states one is refused as its heading's mismatch. Every row a call stamps in one group holds one place, so a
  call adds one row a group. A place is stamped as a clock is, in one statement of one stratum (`stampedApart`), never
  at a group the same insert stamps (`groupStamped`), from its group's head row ([Instants](#instants)): two calls
  that stamp one group take turns at its head, at every level, so no two commit one place, and a call that rolls back
  leaves no gap.
- **Its members carry it.** An owner whose place a nested insert stamps hands it to its members: each member's group
  field paired with the place carries the one place its owner's row takes, at any depth, and no member states it. The
  owner and every member are written by one family statement, which stamps the place once at each group, every row that
  carries it joining that one stamp, so the place is read from its group's head once per group and never again; a
  read-back of the owner's `delta.added` rides that statement, so the call reads back the place it was stamped:
  `ChangeSet.empty(S).insert(Claim, []).read("held", (delta) => ...)` over rows `{ step, holds: [{ resource }] }`. The
  host fills every other column of the rows, a member's slot, its copies of its owner's fields and its owner's folds
  over it, and none the statement stamps: a member's generated field over its carried place is PostgreSQL's alone, and
  a fold's step or selection, or a copy, that reads the place or such a field is refused where the write compiles
  (`UnfillableField`, `stamped`). Two owners of one call in one group would take one place, so they meet at the owner's
  primary key, which the host holds at the group, and the call is refused there before any statement.
- **Written by inserts, and deleted by whole groups.** A put would state a place, so none writes a relation with a
  place (`written`). A delete removes whole groups, and leaves every group gapless: every field its rows state is a field
  of the group, as `deleteWhere({ Claim: { root } })` states only `root` of a group `(root, step)`, so each group it
  reaches goes whole, a family owner's members with it, and its statement deletes each removed group's head with it,
  so an insert into the group again stamps 0; a delete whose rows state any other field, a row of a group rather than
  the group, is refused (`written`). A role that deletes from a place's relation holds SELECT and DELETE on the place's
  head table for it, and no other privilege on a head's table: no more than its DELETE on the relation lets it do.
- **Its order is the migration's.** A place's declaration says nothing a write reads beyond the place itself; it states
  only how a migration that adds the place to a table holding rows numbers them. `place` states no order: a relation
  created with it numbers nothing, and a migration that adds it to stored rows gives every one place 0, which keeps them
  apart at the new primary key exactly when it holds the old one, re-keying `(child, item)` to `(child, item, n)`; where
  it does not, so a group would hold two stored rows, the draft is refused (`addedOverRows`, naming both keys).
  `place.by(field)` numbers them: each group's stored rows from 0 in `field`'s order, `row_number() OVER (PARTITION BY
  <group> ORDER BY <field>) - 1`, in its backfill ([Migrations](#migrations)), with no placeholder, which a key of the
  relation within the group and the field makes total (`byUnkeyed`, which names the key the group and the field would
  be; `byUnknown`, `byItself`): `relation("ItemSession", { child, package, item, n: place.by("stage"), stage }, ["child",
  "package", "item", "n"])` beside `key(on(ItemSession, "child", "package", "item", "stage"))`. The inserts after a
  migration stamp on from each group's greatest. A child keyed by the parent's old key and re-keyed by its place,
  `Attempt` from `(child, stage, package, item, at)` to `(child, package, item, n, at)` beside a containment into
  `ItemSession`'s `(child, package, item, n)`, takes each row's `n` from the session its old containment named: a column
  a migration adds to stored rows that a containment carries is drawn from the row the previous installation's
  containment over the same table named, every other pair of the two containments alike, and is the reviewer's
  placeholder only where there is none.

## Derived tables

`derived(name, query)` names a query as a relation of the schema; declare it in a level over the schema its query reads,
with `schema.extend` ([Levels](#levels)). The query takes no parameter, matches no context, has at least one field,
and its rules share one set of columns. No role holds it as an entry: a role reads it through the relations its
definition reads.

Where its rows live is grizzle's to decide, never yours. grizzle stores it, its rows in a table of its own kept equal
to its definition at every COMMIT for every writer (grizzle's programs, direct SQL and a migration's data steps alike),
exactly where it can keep it at a written unit by reading only rows that unit's borrow covers. That is where its
definition is unit-local, as a rule judged whole is ([Rules over queries](#rules-over-queries)):
- every relation it reads leads its primary key with the unit's fields and sits in one declared unit
  ([Units](#units)) whose key leads them, so every write of its rows, a mutable relation's updates and deletes among
  them, holds that unit, and grizzle writes the stored rows under the same borrow;
- every match binds them to the rule's variables;
- every negation is correlated at them, and every aggregate groups by them;
- its head delivers them;
- every declared function it calls, and every function that function's body calls, is `immutable`;
- it reads no field grizzle rewrites in place, a fold's running value;
- and its table can hold its rows: every key it provably has fits a B-tree entry, and its fields convert to columns
  apart.

Whether the relations it reads are closed or open decides nothing. A definition over closed relations alone that joins
two units' rows could lose a fact two writers inserted into the two at once, so it is live; one over a relation open
inside its unit is kept under the borrow every writer of the unit holds.

A definition that reads relations of a unit sealed at founding beside relations of another unit reads the sealed ones by
reference, as it reads a closed relation, and stands in the other unit alone: a learner's credit over a package's
content is stored in the learner's unit. Each such read must stand at a key of the sealed unit that a row of the
definition's own unit, matched in the same rule, names through a containment the schema states into the sealed unit
(`contained(on(Attempt, "package", "item"), on(Item, "package", "item"))`), over every row that match admits; a
reference-only query read at such a key counts as read there. A row so contained stands only once its key was founded,
and the founding transaction wrote every row of the sealed unit there, which no later write changes, so the stored rows
change only with the writes of their own unit: a later fact of a learner, a regrade's assertion among them, is
re-stated at its COMMIT; a founding changes no stored row but at the units its own transaction writes; and a
migration's data step, the one writer that removes or updates a sealed row, is followed by its bracket's re-check, which
makes the relation its definition's rows again by one MERGE of its table, so no capture writes a sealed row's removal.
A read of sealed content at a key no such row reaches is live (`reference`).

Its upkeep costs what a write's delta bounds, never its whole unit: its unit is wider than the declared unit and one
read of it roots the others by their keys, or its unit binds a key of every relation it reads, or its declared unit is
sealed and its one founding write the upkeep's; or else its upkeep is a delta form whatever the width of its unit:
checked, every rule a join of relations reached from its head by keys, or by seeks, an existence test of one relation at
the fields the head binds, one descent of an index and at most one range of one more column, each changed row of it
naming its one fact by keys (a sitting holding an unprocessed attempt, a session whose control lies above its counted
attempts), and every negation one relation's, so a write reads
each fact it gains from the rows it wrote outward and checks each fact it may withdraw at the fact, one probe of a key
each, a fact whose candidate leaves fields free read from the stored table's own rows at the fields it binds, only where
those hold the unit's key and more (a removed snapshot withdraws its facts in each candidate session, read from
SessionSnapshot's table at the snapshot, never at the learner alone), and every stored relation a statement reads
read by an index of its own at the keys the write binds (a suspension's open snapshots read from TestSnapshot's
table at the sitting);
or monotone over closed relations, every rule a join negating nothing over relations no served write updates or
deletes, so a served write only gains facts, each read from the rows it wrote, and a migration's data step that removes
a row re-derives the units it touched. Ledger's TestSnapshot, SessionSnapshot, ItemSessionControl, ItemSessionOpen,
SettledSitting and UnsettledSitting, each at a learner whose sittings, item sessions and attempts are keyed apart, are
stored checked, an import read by its name where its canonical relation is stored. A definition whose upkeep is none of these is live
(`unboundedUpkeep`), and snapshot.json records why its delta form bounds none (`delta`: `arms`, `match`, `negation`,
`unreached`, `loss` or `open`, and where).

Every other derived relation is live: it stores nothing, and every query that matches it and every rule over it reads
its definition. `grizzle generate` records each live one in snapshot.json, under `derived.liveDerived`, with why:
`notUnitLocal`, naming the condition it lacks (`inPlace`, `unitKey`, `split`, `negation`, `aggregate`, `recursion`,
`shape`, `hidden`, `noUnit`, `call`, `borrow` or `reference`) and where, or `unrepresentable`, naming why no table could
hold its rows.

A stored relation's table serves a read exactly where its rows are its definition's there:
- **A query** that matches it reads the table, a range of its key, never its definition.
- **A role** reads it through its whole view where the role holds every relation its definition reads whole, and through
  its definition over the role's own entries otherwise, so a role sees the same rows whether or not it is stored. No role
  writes it.
- **A ChangeSet** that writes a relation its definition reads reads its definition, whose table the ChangeSet's own
  COMMIT replaces.
- **A read inside a write's transaction** and a query entry's view read its definition where the role may write a
  relation its definition reads, and a write entry's membership always reads it: the transaction's own writes reach
  its table only at COMMIT.

Its storage changes no verdict and no type: the checker and every analysis read a derived relation as a relation keyed
by the keys its definition provably has, stored or live alike, and only the SQL grizzle writes reads its table or its
definition.

- **When its rows are written.** At COMMIT, where the rule judge runs: for each unit whose rows a transaction wrote,
  on either side of every relation its definition reads, the judge deletes the stored rows there its definition no
  longer delivers and inserts the ones it delivers anew, two statements over the rows the transaction wrote, its work
  the written units' and never the table's. Before any of them reads a row, the judge borrows each of those units
  exclusively, one lock a unit key, every one in one statement in the order of their ids ([Units](#units)), so no two
  transactions keep one unit at once, whatever level they run at and wherever they come from: a READ COMMITTED
  transaction then reads every row of the unit that any earlier writer committed, and two writers of one learner's
  rows at once never leave a join's row missing, a count short or a negation's row standing. A stored row that stays
  is never touched. A definition that reads another
  stored relation reads its table, which the judge keeps first in the same COMMIT: it keeps each stored relation after
  every stored relation it reads, at the units whose rows the transaction wrote or whose stored rows the keeping of
  those below it changed, so no work below is done twice. A query a definition imports is a relation too, stored where
  it can be kept as a derived relation is, and read alike: its table, by reference, wherever a definition imports it,
  never its definition spelled again in place, so each statement the judge runs for an upkeep or a rule is as large as
  its own definition, however many stored derivations stand beneath it, and plans in time bounded by its own
  relations. After `SET CONSTRAINTS ALL
  IMMEDIATE` the judge runs at the end of each statement, so the stored rows are current after each.
- **Laws over it.** A rule over a stored relation reads its table, its rows as the transaction leaves them. A key
  over it is a unique index of its table (the index of the key it provably has, where it is one), a check over it its
  table's CHECK, each refusing at the upkeep's insert of a row that breaks it, at COMMIT (23505, 23514). A containment
  with it on either side is judged at COMMIT, after the upkeep, never a foreign key: a foreign key is checked by the
  statement that writes the other table, before the upkeep writes this one.
- **Its table.** `CREATE TABLE … AS <definition> WITH NO DATA`, each column of the type its definition delivers, its
  primary key the narrowest key the query provably has that holds the unit's fields, those fields first (or, where
  none holds them, the unit's fields and then the narrowest key's others), so the rows of a unit are a range of its
  index, and a unique index on each other: a choice of one key in each of its independent parts, such as one
  of the two keys of each table it joins, one index on one key and on each key one choice away from it, so k such
  tables make k + 1 indexes, not 2^k, and every key of the product stands in a key member, a nested result or an
  order. A query of several rules, each finding a literal that tells its rows apart, is keyed the same way: its keys
  hold a key of every rule beside those literals. Columns the query makes equal count as one column of a key, so k
  equal pairs make one key, not 2^k: the index holds the first of them, and any of them stands for it.
- **Migrations.** The migration that creates the table fills it with its definition's every row, once every row it
  reads is written. One that changes what the definition means, a function it calls among them, or writes again a
  column it reads, creates it again and fills it.
- **Rules over it** read its definition, as a rule over `derived` does.

## Records of a query

`records(stem, query, owner, ownerKey)` declares the relations that hold the rows a query found, for a level over the
query's to list: `${stem}Row`, the owner's fields, then each column of the query's heading as the query's own field, keyed
by `ownerKey`, a nonempty list of the owner's field names, as `relation`'s primary key takes it. A column is stored as
the type it is declared of, its contract's host type and check, its closed id's roster, its text's patterns, so a closed id
references the roster of the level below; a drawn, generated or accumulated field is stored as its declared type, never
drawn again; a computed numeric is stored as numeric within its bound (`pg.numeric.within`), an instant as a stored one
(`instant.stored`) and a search document as a stored one (`pg.tsvector`); a head literal is stored nowhere, its read writing it again, but a union's rules that write literals of
several values at one key (`kind: "draft"` in one, `kind: "final"` in the other) store that key as a column whose values
are exactly them: a text of the pattern of just those texts, or a boolean. List `R.relations` in the level and
`R.rules` among its rules.

```ts
import { Array } from "effect"

const found = records("Lessons", lessonsOf, { digest: sha256, run: RunId }, ["digest", "run"])
export const Audit = schema.extend([School], "Audit", found.relations, found.rules)

/** The insert of one run's found rows, each under its own digest. */
const entries = Array.map(lessons, (row) => [{ digest: digestOf(row), run }, row] as const)
const insert = recordsFacts(Audit, found)(entries)
ChangeSet.empty(Audit).insertAll(insert)

/** The rows stored at one owner: rows of `lessonsOf`'s own type, read through its own decoder. */
export const storedLessons = recordsQuery(Audit, found)
```

`recordsFacts(level, records)(entries)` is the insert of found rows as `insertAll` takes it, each entry a row beside
its owner's values, each fact the owner's values then the row's columns; an owner of several rows is entries that share
it. `recordsQuery(level, records)` is an ordinary query over the level whose
parameters are the owner's key fields and whose rows are the stored rows at that owner, delivered through the query's
own decoder: `HeadOf<typeof storedLessons>` is `HeadOf<typeof lessonsOf>`, value for value. A union of several
headings is refused with `UnsupportedOperation`, as is a column of a contract the level does not declare and a union's
literals of another type than text or boolean, which no field holds exactly.

A query's attachments, at any depth, are stored too, each in a relation of its own: `${stem}${Name}`, the attachment's
name capitalized, or, where that name is another attachment's anywhere in the tree or `Row`, its parent relation's name
followed by it. Each holds its parent's key, every field under its own name unless the attachment's own columns or
attachments take it, then the first free `<name>2`, `<name>3`, …; an array's place, `at` or the first of `at2`, … free;
the attachment's stored columns; and a drawn count under the name of each array attachment of its own, the root's
among them. Each is keyed by its parent's key, then an array's place, and held to its parent by the law its delivery
states: an array is the parent's ordered family counted at the attachment's name, so `recordsFacts` nests its members
under their owner in the order the query delivered them and their places are 0 … n − 1; an option is contained in its
parent; and the one child mirrors it.
`R.apart` names the relations an insert states beside the root, every attachment's but an array's; `recordsFacts`
gives each its facts under its name, its carried key's values then its own, so `insertAll(recordsFacts(level,
records)([]))` is the member that takes them all. `recordsQuery` reads each attachment back over its relation as the
query stated its delivery, an array in its places' order, so its rows are still the query's, value for value. Every
name the records mint is the stem followed by more: name a relation of your own the stem itself, never the stem and a
suffix.

A name the records derive is never cut short and never refused for its length, however deep the attachments: it is
the relation's name in the schema's types, and no PostgreSQL identifier. The relation's table and whole view are
named `__<stem>_<digest>`, hashed over the relation's name and spelled after the records' stem and the relation's path
(its attachment names from the root, none for the root), within PostgreSQL's 63 bytes, with a COMMENT naming the
relation, and listed by `grizzle names`. Two derived names that convert alike are still one name, refused as any two are.
`records(stem, query, owner, ownerKey, { names })` states a relation's name for an attachment's path, its attachment
names from the root joined by `.`, as `{ names: { "stimuli.document": "Stimulus" } }`, in place of the derived one,
and the derived names of the repeated attachments under it follow it. The options are optional: left out, no name is
stated. A stated name is a relation's declared name: its table and whole view are its conversion, readable, and one
past 63 bytes is `IdentifierTooLong`. A path no attachment has is refused.

Records' relations are relations like any other: their rows go by deletes, under the unit their owner's key leads with,
a reference to a row of them refusing its delete while it remains.

## Declared functions

`fn(name, { calls, args, returns, volatility, nullInput, language, body })` declares a PostgreSQL function the application writes,
a schema object a level lists beside its relations. Its body is PL/pgSQL or SQL text you own, written
`` fn.body`...` ``, installed byte for byte but for the headings it names; grizzle prints its head and never reads its
body.

```ts
const Word = str.regex("^[a-z]+$", "u")
const Weighted = rows({ weight: natural, word: Word })

/** A word folded to lower case: an SQL body. */
export const folded = fn("folded", {
	calls: [],
	args: { word: Word },
	returns: Word,
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT lower(word)`
})

/** Each word of `words` folded, its weight doubled: a set of rows, read from an array of rows. */
export const doubled = fn("doubled", {
	calls: [folded],
	args: { words: Weighted },
	returns: Weighted,
	volatility: "immutable",
	nullInput: "called",
	language: "plpgsql",
	body: fn.body`
DECLARE
  w ${Weighted};
BEGIN
  FOREACH w IN ARRAY words LOOP
    w.word := folded(w.word);
    w.weight := w.weight * 2;
    RETURN NEXT w;
  END LOOP;
END
`
})

/** A titled list of weighted words: a heading whose field holds rows of another. */
const Titled = rows({ title: Word, words: Weighted })
const Summary = rows({ count: natural, title: Word })

/** A titled list's title and its count of words: one row of a heading, from one row of another. */
export const summary = fn("summary", {
	calls: [],
	args: { doc: row(Titled) },
	returns: row(Summary),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT ROW(cardinality((doc).words), (doc).title)::${Summary}`
})

export const Lexicon = schema("Lexicon", [folded, doubled, summary], [])
```

- **Arguments and results** are a value of a field's type, `rows(heading)` or `row(heading)`: an argument of rows is
  an array of the heading's row type, a result of rows is a set of them, `RETURNS SETOF`, and one row, as an argument
  or a result, is a value of the row type itself, a composite. Each field of a heading is a value, rows of another
  heading (an array of that one's row type) or one row of one, so a heading holds another as one composite or as
  many: `Titled` above holds its words, and its row type installs after `Weighted`'s. A value's type is a base type, a
  closed id, a contract or a refined text over one: a serial, money, an exact value, bytes, a set, a span or a vector is a type error,
  and from JavaScript `Refused` when the schema is owned. A closed id is of its whole roster: one of a subset is refused
  alike, since no body is a value of a subset and the call casts its value to the roster's domain alone, while a
  variant's arm field of a subset is held to it by the variant's domain the call casts to. A heading holds no NULL, so no row is no arm of a type: a
  function of one row returns its row, and a body with none to return raises. PostgreSQL holds a function to its
  declared types exactly (a PL/pgSQL `RETURN QUERY` refuses a column whose type is not the row type's), so each is its
  field's base type, `natural` a bigint, `Word` a text and a closed id its code, a smallint: a contract, a pattern or
  a roster is checked where a statement reads the function's value, cast to its field's domain, never by the
  signature. That cast makes the contract's values from what the body returned, so a function whose result holds a
  consumer's contract at any depth is declared under each such contract's key, by its name, after its definition:
  `fn("grade", { …, returns: row(Single) }, { QtiInteger: qtiIntegerKey })`; one whose result holds none takes
  nothing. A call passes a closed id of the argument's own roster alone, as every term does.
- **Order.** A heading's fields and a function's arguments are each a set of names, and PostgreSQL reads both by
  position: a row type's attributes, in the order `ROW(...)::${heading}` builds them and a body's `SELECT` or
  `RETURN QUERY` returns them, and a function's parameters, in the order a call passes them and `$1`, `$2` number
  them. Both stand in code point order of their names, whatever order the record writes its keys in, which is the
  order oxlint's `sort-keys` holds a record to: `Summary` above is `(count, title)`, so its body builds
  `ROW(cardinality(...), (doc).title)`, and a function of `args: { x, y, iy }` is `f(iy, x, y)`. A body calls a
  declared function positionally in that order, or by name, `f(x => 0.5, y => 0, iy => 1)`, which no order changes.
  A record written in any key order, sorted or not, installs the same row type and the same function, and grizzle's
  own calls, rows arguments and reads of a call's rows take the same order.
- **Names.** A function installs in its level's schema under its name's conversion, `folded`, `xsd_regex` for
  `xsdRegex`; functions are one namespace across a schema's levels, apart from its relations. Each heading installs
  once per level as a row type named by its definition's digest, `__rows_<digest>`, its fields by name, so a changed
  heading is another type and the functions over it take the new one, and a heading whose record only writes its keys
  in another order is the same type.
- **A body names its row types** by placeholders: each `${heading}` of `` fn.body`...` `` is a heading `rows()` built,
  and the body installs with its row type's name in its place, `"__rows_<digest>"`, which the function's search_path
  resolves. A heading the body names is one its own arguments or result take rows of or return, or one a function it
  `calls` does; any other is `MalformedDescription` when the schema is owned, since its row type may stand in no schema
  of the level, or stand there for another function alone and go with it. The snapshot records the body as it
  installs, names and all, so a changed heading is a changed body of every function that names it.
- **It reads no table.** Every declared function is `SECURITY DEFINER`, owned by the installation's function owner,
  a role of no privilege on any table or view, under `SET search_path = pg_catalog, <its schema>, pg_temp`. So its
  body names the functions and row types of its own level unqualified, and a body that reads a relation, of its schema
  or any other, fails where it is called, `42501` permission denied. PUBLIC executes none. It runs under no plan advice
  (`SET pg_plan_advice.advice = ''`), its caller's included: grizzle proves no plan of its body, and an item of the
  calling statement's advice must never meet a relation the body reads, a system catalog among them, by its alias.
- **`calls`** lists the declared functions of the function's own level its body calls. The installation creates them
  callees first, so PostgreSQL, which reads an SQL body's names as it creates the function, finds each; a call of a
  function of another level, of one the schema does not declare, or a cycle, is `MalformedDescription` when the schema
  is owned. A PL/pgSQL body reads its names where it first runs, so `calls` orders its creation alone.
- **NULL input.** `nullInput` is what the function does with a NULL argument, and every declaration states it, since
  neither is a default: `"called"`, PostgreSQL's `CALLED ON NULL INPUT`, runs the body at every argument, NULL ones
  among them; `"strict"`, PostgreSQL's `STRICT`, answers a call with any NULL argument without running the body, NULL
  for a value or a row and no rows for a function of rows, so inside a strict body every parameter is a value. Declare
  a function strict wherever a NULL argument means nothing to it, as a text or a number's own function: its body need
  never test for NULL, and a body that would loop, raise or answer a value at NULL never runs there. A function that
  must refuse a NULL argument itself, as a constructor that raises on one, stays `"called"`.
- **Migrations.** A changed body, volatility or null input is `CREATE OR REPLACE FUNCTION`, which keeps the function's owner and
  grants; a changed signature or result drops the function and creates it again. The snapshot records each function by
  its head and the SHA-256 of its body, and the drift check holds the installed source, `pg_proc.prosrc`, to that
  digest, so a body edited by hand is drift, reported with both digests and the committed statement that last defines
  the function.

### Calling a function

A query calls a declared function of its schema in one of three ways, by what the function returns.
`Fn.call(f, args)` is the value of a function that returns a value: a term, which stands wherever a term of its
result's type stands. `Fn.rows(f, args)` is the rows of a function that returns rows: a source, which a rule
matches as it matches a bound query. `Fn.row(f, args)` is the fields of the one row a function returns: a
record of sources, one for each field of the row that holds rows of a heading of values. Each argument is named as the
function declares it, every one of them and no other: a value is a term, a parameter or a JavaScript value, as a bind
map takes one; rows are a query, or a bound query, whose heading holds the argument's fields. A rows argument's
parameters are all bound, as a matched query's are: a query of parameters is passed as `Q.bind({ ... })`, each bound
to a parameter, a variable or a constant of the calling rule, since the call binds them by its bind map alone and
never by name from the caller's own. Passed unbound, it is a type error ("bind the query's parameters before
matching it or passing it as rows") and, from JavaScript, `MalformedDescription`.

```ts
/** A document, by its slug. */
const DocSlug = str.regex("^[a-z0-9-]{1,64}$")
const Doc = relation("Doc", { doc: DocSlug, shift: natural }, ["doc"])
const Line = relation("Line", { doc: DocSlug, pos: natural, txt: Word }, ["doc", "pos"])
const Numbered = rows({ pos: natural, txt: Word })

/** Each line of `program` shifted by `shift`, its word folded. */
export const shifted = fn("shifted", {
	calls: [folded],
	args: { program: Numbered, shift: natural },
	returns: Numbered,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT p.pos + shift, folded(p.txt) FROM unnest(program) AS p`
})

export const Docs = schema("Docs", [Doc, Line, folded, shifted], [])

const linesOf = query(Docs).rule((r) => {
	const { pos, txt } = v(Line, "line")
	return r.match(Line, { doc: r.param("doc", DocSlug), pos, txt }).find({ pos, txt })
})

/** Every document's lines, shifted by its own shift, each beside its word folded again. */
export const shiftedLines = query(Docs).rule((r) => {
	const { doc, shift } = v(Doc, "doc")
	const run = Fn.rows(shifted, { program: linesOf.bind({ doc }), shift })
	const { pos, txt } = v(run, "run")
	return r
		.match(Doc, { doc, shift })
		.match(run, { pos, txt })
		.find({ doc, pos, txt, again: Fn.call(folded, { word: txt }) })
})
```

A function that computes several sets at once returns them as the fields of one row, and a statement reads each of
them as a source. The ChangeSet below files a document's lines by the length of their word, two members of one
statement, and calls `parted` once:

```ts
const Parted = rows({ long: Numbered, short: Numbered })

/** The lines of `program`, parted by the length of their word: one row, two fields of rows. */
export const parted = fn("parted", {
	calls: [],
	args: { program: Numbered },
	returns: row(Parted),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT ROW(
  ARRAY(SELECT p FROM unnest(program) AS p WHERE length(p.txt) >= 5),
  ARRAY(SELECT p FROM unnest(program) AS p WHERE length(p.txt) < 5))::${Parted}`
})

const Short = relation("Short", { doc: DocSlug, pos: natural, txt: Word }, ["doc", "pos"])
const Long = relation("Long", { doc: DocSlug, pos: natural, txt: Word }, ["doc", "pos"])
export const Words = schema("Words", [Line, Short, Long, parted], [])

const wordsOf = query(Words).rule((r) => {
	const { pos, txt } = v(Line, "line")
	return r.match(Line, { doc: r.param("doc", DocSlug), pos, txt }).find({ pos, txt })
})

/** A document's lines, each filed under its word's length. */
export const file = ChangeSet.empty(Words)
	.insert(
		Short,
		query(Words).rule((r) => {
			const doc = r.param("doc", DocSlug)
			const { short } = Fn.row(parted, { program: wordsOf.bind({ doc }) })
			const { pos, txt } = v(short, "short")
			return r.match(short, { pos, txt }).find({ doc, pos, txt })
		})
	)
	.insert(
		Long,
		query(Words).rule((r) => {
			const doc = r.param("doc", DocSlug)
			const { long } = Fn.row(parted, { program: wordsOf.bind({ doc }) })
			const { pos, txt } = v(long, "long")
			return r.match(long, { pos, txt }).find({ doc, pos, txt })
		})
	)
```

- **Where it runs.** A call of rows is read `LATERAL`, after the matches whose variables its arguments read, once per
  their binding: `shifted` above runs once per document, at the array of that document's lines. A rows argument is an
  array of the heading's row type, `ARRAY(SELECT ROW(...)::<row type> FROM (<query>))`, a set, in no order; a value
  argument is cast to its declared type's base.
- **What it returns.** The rows of a call are a set: a row the function returns twice is one row. Each value is cast to
  its field's declared type, so a contract or a pattern refuses a value of the function's that breaks it, where the
  query reads it. grizzle holds no NULL: a function that returns NULL, as a value or in a field of a row, fails the
  query with SQLSTATE `22004`. A strict function's `Fn.call` at a NULL argument, which a closed read at a key no row
  holds gives, is NULL, as a strict operation's is, never that refusal, and its body never runs there: a filter over it
  is unknown, so it keeps no row there. Every other argument a query passes, a variable, a parameter or a constant, is
  a value.
- **The fields of one row.** `Fn.row(f, args)` holds a source for each field of `f`'s row that holds rows of
  a heading of values, by the field's name, its facts the heading's, a set, typed by the heading as a call's rows are; a
  field of a value, of one row, or of rows whose heading holds rows or a row is none of them, and from a description
  `MalformedDescription`. Every read of a field of one call at one argument tuple reads one evaluation of it, so a
  statement that reads several fields calls the function once: a call whose arguments read only parameters, and
  bound queries over them, is one `MATERIALIZED` CTE of its statement, `SELECT r.* FROM f(...) AS r(...)`, which each
  field's read unnests (`LATERAL unnest(e.field)`), and in a ChangeSet's stratum of one statement one CTE that every
  member reads; a call that reads its rule's variables is one `LATERAL` item of the rule's region, once per binding,
  whichever of its fields the rule matches. A value an argument reads from a stored row, for a call several members
  share, comes in through a rows argument, a query bound to parameters, or as a parameter: a value argument bound to
  a member's own variable makes each member's call its own. `f` is immutable or stable, since a volatile function's
  evaluations are not one; a volatile `f` is refused. grizzle holds no NULL: a row holding NULL at any field, the
  function's NULL row among them, fails the statement with SQLSTATE `22004` where the call is evaluated, and a NULL
  element of a field's array, or one holding NULL, where the field is read, so a field of no rows, an empty array, is
  the empty source and never a NULL.
- **What a query calls.** A query calls a function whose arguments are values and rows of headings of values, and
  that returns a value, rows of such a heading, or one row whose fields it reads. A function that takes one row, or
  that returns rows of a heading with a field of rows or of a row, is called by another function's body alone, and a
  query's call of it is `MalformedDescription` (from JavaScript, and a type error where its types say so): a query's
  sources and terms hold fields, and no field holds a composite or an array of them, so a query could neither read such
  a column nor build such an argument.
- **Where a call is matched.** A call's rows arguments may each be built by a `query(S)` of their own, over one level
  of a schema or over several: the call is matched where the highest of them may be, in a rule over that level or one
  above it, and rows arguments over two levels neither of which is a level of the other are `MalformedDescription`.
- **What may call one.** A call is a query's term alone: a check, a contract's predicate and a generated field are
  evaluated on the host too, and PostgreSQL alone evaluates a declared function, so a call there is a type error
  (`Refused`), and refused from JavaScript when the schema is owned. A term calls an immutable or stable function; a
  volatile one is called through `Fn.rows` alone.
- **Who may call one.** A role holds `EXECUTE` on exactly the declared functions its served programs call, and the
  function, which reads no table, runs as the function owner. A derived relation's or a query entry's definition that
  calls a function runs inside its view, as its owner.

## Levels

A schema builds on another under its own name: `schema.extend([base], name, relations, statements)` is a level over
`base`, with every relation and rule of it and of the levels below it, and relations and rules of its own. Each level is
declared once, by its own name, which no level below it takes, and there is no other way to extend a schema. Its bases
are a list, its description's `bases`, of one base: a level over several bases is not built yet, and a second base is
refused, `Refusal<"schema.extend takes one base: a level over several bases is not built yet">`.

```ts
/** The QTI content model, maintained on its own: an item is its QTI identifier. */
export const Item = relation("Item", { id: ItemIdentifier, title: Title }, ["id"])
export const Qti = schema("Qti", [Item], [])

/** A child's sittings, over Qti: each sitting's item is one Qti holds, as the database enforces. */
export const Sitting = relation("Sitting", { child: ClerkUser, item: ItemIdentifier }, [
	"child",
	"item"
])
export const Ledger = schema.extend(
	[Qti],
	"Ledger",
	[Sitting],
	[contained(on(Sitting, "item"), on(Item, "id"))]
)

/** The signed-in child's own sittings; an insert fills `child` from the token. */
export const mySittings = query(Ledger).rule((r) => {
	const { child, item } = v(Sitting, "sitting")
	return r.match(Sitting, { child, item }).match(Session, { sub: child }).find({ item })
})

export const Learner = role(
	Ledger,
	"learner",
	{ ...wholeEntriesOf(Qti), MySitting: mySittings },
	{ insert: ["MySitting"], contexts: [Session] }
)
export const LedgerApp = login(Ledger, "app", [Learner])
export const QtiAuthor = role(Qti, "author", wholeEntriesOf(Qti), wholeWritesOf(Qti))
export const AuthorApp = login(Qti, "author_app", [QtiAuthor])
```

- **Each level is a PostgreSQL schema.** `schemaNameOf(Qti)` is `qti` and `schemaNameOf(Ledger)` is `ledger`: a level's
  tables, stored derived tables and rosters' domains live in its own schema. A login or role is named
  by the level it is over, `roleNameOf(LedgerApp, {})` is `ledger__app` and `roleNameOf(AuthorApp, {})` is `qti__author_app`.
  The root's schema also holds what belongs to the whole installation: the migrations ledger, the contract and text
  domains, the constants and grizzle's functions. Every reference across schemas is qualified.
- **One installation.** The config lists `Ledger`, its top level, and both levels install together: one migrations
  directory, `migrations/qti/`, named by the root, one snapshot recording each level and one ledger. A migration
  spans every level, so a change of `Qti` that a view or foreign key of `Ledger` reads drops and recreates it in one
  transaction, and a rename of a `Qti` table or field reaches `Ledger`'s foreign keys and views in place. A level added
  on top later is the next migration of the same installation. A relation moved to another level is a new table there:
  `--drop` the old one, as for any stored relation.
- **A level reaches the levels below it only where their writes need nothing of it.** A containment between stored
  relations may have one side below, its other side the level's own, the lower side's terms fields with no `pred` and
  no span, every fact or a selection of them, into a key the target relation declares: a foreign key such as
  `ledger.sitting` into `qti.item`, or, from a selection below, `contained(on(select(Item, (i) => φ), "id"),
  on(Reviewed, "item"))`, every item φ holds of reviewed above. A selection's terms, and a field a selected
  target fixes, are generated columns PostgreSQL computes on the lower table however its row is written, under a
  UNIQUE the key implies, so a `Qti` write is compiled and drawn as before and meets the law as one above it; a
  containment that is unit-local is judged at COMMIT instead ([Rules over queries](#rules-over-queries)). A rule over a
  query may read the levels below through its derived relation, as deferred triggers on their tables. A row check may
  stand over a relation below (next). Anything else stated at `Ledger` over a `Qti` relation (a key, `mutable`, a
  family, tree or fold, a containment between two `Qti` relations, whose foreign key would order `Qti`'s own
  statements) is `LevelRefused` when the schema is built: a process over `Qti` holds none of `Ledger`'s code, so no law
  of `Ledger` may change how a `Qti` write is compiled or drawn.
- **A level checks the rows below it.** `Ledger`'s list may hold a row check over a `Qti` relation, written exactly as
  that relation's own would be, `check("Titled", Item, (i) => Text.matches(i.title, nonBlank))`, `nonBlank` a
  `Text.pattern`: it reads any field of the row, a text of no byte bound with `Text.matches` among them, as a row
  check does. It is `Ledger`'s law and its CHECK on `qti.item`, named as a row check is and sharing `Item`'s checks'
  names, so a second `Titled` over `Item` at any level is `IdentifierCollision`. The migration that installs `Ledger`, or
  adds the check to it, adds it and validates every stored row, refusing the migration over one that breaks it, and the
  one that removes it drops it; an installation of `Qti` without `Ledger` holds no trace of it.
- **Read-only is the worlds model.** `Learner` holds `Qti`'s tables whole and writes only its own sittings: it reads `Qti`
  through the whole views of its tables, one view of each table in `Qti`'s schema of whole views, `__qti`
  (`wholeSchemaNameOf(Qti)`), owned by the migration role, which every role holding the table whole reads, and holds no
  privilege on a `Qti` table. Since it holds every `Qti` table whole, every query over `Qti` runs on it, through those
  views. Its query entry `MySitting` is a view of its own, in its own schema, `ledger__learner`.
- **Every level is served.** `DbLayer.make` takes the served file of a login over any level of the installation: a
  process of `Qti` alone, such as `AuthorApp`'s, loads only what its programs over `Qti` read, and nothing above it. When a write of it breaks a law a level above states, such as deleting an `Item` a
  `Sitting` holds or inserting one `Titled` refuses, the error is `refused` with `refused.kind` `above`
  and `refused.above` naming the law `{ kind: "above", level: "Ledger", law }`, the level and the law as that level states it
  ([Errors and outcomes](#errors-and-outcomes)). `Qti`'s own laws are named as they would be were `Ledger` not
  installed: a process holds no predicate of a law above it, so it never claims to judge one, and judges each of its
  own.
- **A relation parameter takes a query of a level above.** A lower level's program that names the rows it acts on as a
  relation parameter, `r.relation("sittings", heading)`, is bound to a query of a level above it, so the higher level's
  guard runs inside the lower level's write, in its transaction, with no read by the host before it. In a rule over the
  higher level,
  `openVisit.bind({ sittings: appSittings.bind({ child: r.param("child", LearnerId) }) })` binds an import's parameter
  to a bound query, which is bound first as a match's is; and `suspendTest.bind({ sittings: appSittings })` binds a
  ChangeSet's, an input of the call read once before the first stratum of the ChangeSet it is bound on by every member
  and read-back of it that uses it ([Writes](#writes)): bound on the whole call, as metis binds the item its assignment
  picks, before the call's first stratum; bound on a part sequenced after another, as edullm binds the sittings its take
  reads after its decision, after the earlier part's writes. `appSittings`' own parameter `child` joins the ChangeSet's
  as one parameter of one type, the
  other parameters staying the program's. Either is then over the higher
  of the two levels and reads the query's contexts. A query over a level apart is refused, `Refusal<"a relation
  parameter binds a query over a level of the schema it is bound in, or over a schema that schema is a level of">`, as
  is one that delivers other fields than the parameter's heading; a scalar parameter takes no query, whose rows are
  any number. Every member that reads one bound query reads one evaluation of it: an import's in the statement of the
  query that imports it, a ChangeSet's before the first stratum of the part it was bound on.
- **The empty level is below every root.** `schema.empty` is the level of no relation and no rule, below every root: a
  query over it is a query over every schema and every role, which holds it whole whatever it holds: every level's
  reader of queries admits it beside its own, so no level's levels grow by it. A read of no relation, a row of its parameters and
  constants alone, is written over it, `query(schema.empty).rule((r) => r.find({ at: r.param("at", pg.bigint) }))`, and
  runs on every role, so the role serving it holds nothing for it: den's role serves a schedule's input derived from
  its key so while holding nothing of the app's. It installs nothing and names no migrations directory. A level that
  declares nothing over a base is no empty level: it holds the base's relations, and a role runs a program over it only
  where it holds them whole.
- **A level over whatever base it is given.** A package's level over the base its installation hands it is a function
  of that base, bounded by the least level it reads: `export const ledgerOf = <Base extends SchemaOver<typeof Qti>>(base:
  Base) => schema.extend([base], "Ledger", [Sitting], [contained(on(Sitting, "item"), on(Item, "id"))])`. The call checks
  the level over that least level, the one level it knows: its relations' names against `Qti`'s, its statements'
  relations among `Qti`'s and its own, and each derived relation's definition a query over a level of `Qti`. `AnySchema`
  is the weakest bound, which knows no relation's name and admits no derived relation. The same checks over the base
  itself wait for `ledgerOf(base)`: a level the base refuses, one of whose relations takes a name the base holds
  another relation under, or whose statement names a relation the base lacks, is typed with its refusal, which no
  schema admits, so it is refused wherever it is taken as a schema, as a base, a role's or a login's, naming the rule
  it breaks: `Refusal<"two relations of one name across a schema's levels">`.
- **A program over whatever role it is given.** A package's write over its level is applied through whichever role
  over that level the application hands it, bounded by that level: `export const ledgerWrite = <W extends
  RoleOver<typeof Qti>>(role: W) => ChangeSet.over(role, ledgerProgram)`. `ChangeSet.over(role, cs)` is `cs` taken over
  the role, the empty ChangeSet over the role unioned with it, its strata, parameters, writes and read-backs `cs`'s, and
  the call checks `cs`'s schema a level of the bound's least level, the one level it knows, where
  `ChangeSet.union(ChangeSet.empty(role), cs)` waits on the parameter and is refused. `RoleOver<typeof Qti>` holds
  `Qti`'s relations whole under their names, so `ledgerWrite(role)` admits a role that holds `Qti` whole, a full role
  over it or over a level above it; `AnyRole` is the weakest bound, which knows no level. Over a built role the call is
  checked against the role itself: a ChangeSet over a schema that is none of the role's levels is refused,
  `Refusal<"ChangeSet.over takes a ChangeSet over a level of its role">`. A union or a sequence of ChangeSets over a
  role parameter waits on it as union's does, so build the program over its level and take it over the role last.

## Fragments

A library ships its relations, the laws over them and the programs that read and write them, written once, and every
application that composes the library serves those programs over its own schema. `fragment(relations, statements)` is
the library's half: relations and the statements over them, with no name and no installation of their own. An
application lists the fragment among its relations, and its schema declares the fragment's relations and writes its
statements at that level, as if they were its own.

```ts
/** A library's facts: each job, and its one result. */
/** A job, by the key its enqueuer gave it. */
const JobKey = str.regex("^[0-9A-Za-z:_-]{1,96}$")
export const Job = relation("Job", { id: JobKey, attempts: pg.integer }, ["id"])
export const JobDone = relation("JobDone", { job: JobKey, ok: pg.boolean }, ["job"])
export const Jobs = fragment([Job, JobDone], [contained(on(JobDone, "job"), on(Job, "id"))])

/** The library's programs, over the fragment: they name no application's schema. */
export const finishJob = ChangeSet.empty(Jobs).insert(JobDone, [])
export const pendingJobs = query(Jobs).rule((r) => {
	const { id, attempts } = v(Job, "job")
	return r
		.match(Job, { id, attempts })
		.where(r.not(JobDone, { job: id }))
		.find({ id, attempts })
})

/** An application: a relation of its own beside the library's, and a law of its own into the library's key. */
export const Fee = relation("Fee", { job: JobKey, cents: pg.bigint }, ["job"])
export const Shop = schema("Shop", [Fee, Jobs], [contained(on(Fee, "job"), on(JobDone, "job"))])
export const JobWorker = role(
	Shop,
	"jobs",
	{ ...Jobs.relations, Fee },
	{ insert: ["JobDone", "Fee"] }
)
export const feeJob = ChangeSet.union(finishJob, ChangeSet.empty(Shop).insert(Fee, []))
export const ShopApp = login(Shop, "shop", [JobWorker], {
	workload: [workload(JobWorker, { finishJob, pendingJobs, feeJob })]
})
```

- **A fragment is a level of every schema that lists it.** A query or a ChangeSet written over the fragment reads and
  writes its relations alone. It is a program of every schema whose levels list the fragment, and of every role that
  holds the fragment's relations whole, as a program over a level is. So it can stand in that schema's and that role's
  workloads, be imported by their rules, be read back, and join their ChangeSets by `ChangeSet.union` and `sequence`,
  which are then over the schema. A rule over a fragment matching any other relation is a type error, and from
  JavaScript is refused when it is built. A fragment is never what a program compiles against: `grizzle generate`
  compiles each fragment program in each login that serves it, against that login's schema and role, names and
  prepares its statements there, and certifies its role there, exactly as for a program written over the schema. A
  fragment carries no certificate and no served text of its own, and two installations that list one fragment are two
  certificates.
- **Its identity is its content.** A fragment listed twice, or reached through two libraries, is one: its relations are
  one declaration each, as two copies of a relation are, and its statements one statement each. A fragment's
  relations meet the application's under one namespace, so a relation of the fragment's name that differs is
  `DuplicateIdentity`. A diagnostic names a fragment by its relations, `fragment(Job, JobDone)`.
- **Only the fragment states how its relations are written.** A key, `mutable`, `race`, a unit, a series, a family, a
  tree or a fold over one of its relations is the fragment's own statement. The application may state one again, since one
  text is one statement, but it may not add one: a key can become an insertion's arbiter, `mutable` puts a row in place,
  `race` meets the row at a key instead of refusing it, a unit and a series are what its writes borrow, and a
  family, tree or fold draws fields and nests members. Any of those, from any level of the schema or another fragment
  it lists, is `FragmentRefused` when the schema is built. What the application may add over the fragment's relations
  only refuses a write: a containment either way, a row check, a rule over a query. So a fragment's program means the
  same in every application, and an application can only refuse more of its writes.
- **What an application's laws may still refuse.** A containment over the fragment's relations can order a fragment
  ChangeSet's writes into a cycle (`UnorderableStratum`). Then `grizzle generate` refuses that program in that
  application, naming the application's law, and serves it unchanged in an application without that law. It is a
  refusal at generate, per application, and never a difference at run time: a program that compiles is served exactly
  as it would be written over the application's schema. A containment that orders a table a read-back reads after the
  statement making its delta refuses nothing: the read-back runs after the change, over its delta carried there.
- **Nothing is installed for a fragment.** Its relations install at the level whose list holds it, in that level's
  PostgreSQL schema, under the application's one migrations directory, snapshot and ledger. Listing a fragment is, to
  the snapshot, that level declaring its relations and stating its laws, so a schema that spread the same relations and
  laws by hand and now lists the fragment migrates by nothing. A fragment has no login, role or workload: an application's
  role holds its relations and serves its programs.

## Migrations

`grizzle.config.ts`, whose default export is `defineConfig({ ... })`, and which every command names as its argument:

```ts
import net from "node:net"
import { CredentialError, defineConfig } from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pgDriver from "pg"
import { Blog, caPem, EtlJob, Web } from "./src/blog.ts"

export default defineConfig({
	schemas: [Blog],
	logins: [Web, EtlJob],
	contracts: [],
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
			Effect.mapError((cause) => new CredentialError({ cause }))
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
- **A stored index is data.** An ordered family's or a tree's index holds the order its caller wrote, so a migration
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
  snapshot.
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
- **Names come from your code.** A declared name is ASCII letters, digits and underscores, starting with a letter.
  `TaskNote` becomes `task_note` for the schema, tables, derived tables, rosters' domains, contracts, columns, row
  checks, a table's whole view and a role's query entries' views; a contract's CHECK is `check`; a schema's schema of
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

## Errors and outcomes

A call answers its value or fails with one `CallError`, the same in process and over HTTP: `{ kind, retry, message }`
and the members its kind holds. `kind` is one of a closed set, `retry` says whether the same call may succeed run again
(`"safe"`: nothing committed, and the failure was not the call's own) or meets the same answer (`"never"`), and
`message` is the failure's own words, the server's report where the database refused. A broken rule is a refusal of
the write, `refused`, which names the rules it broke and a row that breaks them.

**Outcomes** of a ChangeSet member's `once`, plain values a test of your code writes as they are:

- **`accepted`**: `counts`, each written table's `added`, `deleted` and `put`, and `reads`, the read-backs.
- **`unchanged`**: `reads`, the read-backs; nothing was written.

**Refusals** of a write, each a `CallError` whose `retry` is `"never"`:

- **`refused`**: `refused`, the broken rules, and `witness`. Each entry of `refused.laws` is `{ law, id,
  by }`: the rule as your schema states it, which you match directly, `law` being
  `{ kind: "check", relation: "Grant", name: "WithinGrant" }`; its identity, the one the snapshot records; and the
  installed object that refused it, a table's `constraint` or a `domain`'s by table or domain and name, a write
  `statement`, or a generated column's `notNull`.
- **`outsideWorld`**: `relation`, the role's table a row cannot belong to.

`refused.laws` is never empty where it stands: every refusal but an `above` one whose `own` is `none` or `unjudged`,
which names its laws in `refused.above` alone. `every`, `first` and `some` name only the laws of your Db's own level and the levels
below it, and a table's checks are theirs, whatever check a level above installs on the table. `refused.kind` says how
grizzle decided them:

- **`every`**: each rule is decided broken. A row check refusing a row you stated names every rule of that table's
  checks the row breaks as the write fills it (counts, ends, indexes and copies at the values grizzle draws), once
  each, in canonical order (primary keys, then statements, as the snapshot lists them, however you wrote the schema),
  whichever check PostgreSQL tried first. A domain refusing a value of a row you stated names the rule of each field of
  that row it types whose value it refuses: a pattern rule names its relation and field, so of two fields of one
  pattern it names the one you broke, or both. Any other refusal names the one rule its constraint states.
- **`some`**: one PostgreSQL object that discharges two rules or more refused the write, and nothing grizzle holds says
  which: at least one is broken, maybe more, each named once, in the order of their identities, however you wrote the
  schema. The object is a family's foreign key, which carries every containment merged into it, a key's index that
  serves several rules (a counted family's numbering under a count's fold), or a domain serving every field of one
  pattern or every contract of one definition, where grizzle
  judges no row you stated whole (a row a query computes, or a value it cannot evaluate on the host); a domain names
  the rules of the fields it types in the tables the statement writes.
- **`first`**: a row check refused a row grizzle cannot judge: one only PostgreSQL computes, which no ChangeSet states
  (a query's, or one grizzle fills on a family), a row you stated whose table has a check reading a value the host
  does not hold, such as a count or an end a put keeps from the stored row, or one of two rows you stated that grizzle
  cannot tell apart (see the witness below). It names the rules of the check PostgreSQL tried first, never more.
  PostgreSQL orders a table's checks by installed name, which no version of grizzle keeps, so the row may break others
  too, and another version may name another.
- **`above`**: PostgreSQL refused the write by an object of a level above your Db's, and `refused.above` names every
  law of those levels it serves, each `{ kind: "above", level, law }` as that level states it, which your process holds
  no predicate of: one where the object serves one, and where it serves several, such as a key's index under a count's
  fold and its family's counted law, at least one of them broken, as `some` says of your own. Nothing is said of any
  other law above. `refused.own` is what grizzle finds of your own levels' checks on the rows of that table the refused
  statement states: `every`, `refused.laws`, every rule of them the first stated row breaking one breaks, as `every`
  would name them were the level's check not installed, that row the witness; `none`, every row the statement writes
  is one you stated and holds them all, the witness `unreported`; `unjudged`, nothing is said of them, the witness
  `unreported`: a refusal at COMMIT, by a foreign key or a rule over a query of the level above, or a row grizzle
  cannot judge. Only `every` carries `refused.laws`.

**Witness**: `{ kind: "key", relation, values }`, the key of one row that breaks the rule and never another column;
`{ kind: "drawn", relation, values, drawn }`, that key where the database supplies a field of it as its statement
writes the row, `values` the key's other fields and `drawn` each such field by what supplies it, never a value guessed
for it: `"clock"`, an instant its clock stamps or a field the call computes from its reading of the clock
(transaction_timestamp, one value a call); `"place"`, a place its insert stamps; `"call"`, a field the call computes
by a term grizzle does not evaluate, which the statement does; `{ kind: "unreported" }` or `{ kind: "unreproduced" }`.
A field the call computes (`ChangeSet.insertAllComputed`) is in the key at the value its term takes over the call's
parameters wherever grizzle evaluates the term, once a call, as the statement fills it. Every insert, a family's members and a tree's nodes included, checks each key and unique of its
table in the statement that writes the rows: a declared key, a key over a side, a family's (owner, index) and a tree's
(root, start), against the stored rows and between the rows the statement writes. That is one index lookup per row and
key beside PostgreSQL's own check, the same cost on every insert. So a key (over a table or a side of one) that a row you
stated breaks, by two rows you submitted or by a stored row inside or outside your role's view, is grizzle's own
finding, witnessed by that row's values at the key's fields, an index or a start at the value grizzle drew and a
generated field at the value PostgreSQL computes. A row check, contract, pattern or generated field is refused by
PostgreSQL, which states the row only in its message, never read by grizzle: grizzle judges on the host the rows your
ChangeSet states for the refused statement (an inserted or put row, a query entry's row, a nested member) as the write
fills them, and the witness is the key of the first that breaks the rule. Either key is in the fields you wrote it in.
A foreign key grizzle installs deferred, such as a family's predecessor key, which PostgreSQL checks at COMMIT, refuses
the write once every statement ran, and PostgreSQL states the row only in its message. Only
then does grizzle send a second flight: the write's statements again, then that key's query for the least row, by its
primary key, that it leaves matching nothing, in a transaction that ends in ROLLBACK. The witness is that row's
primary key. The second flight is a write like the first, with the same admission, taking the same locks in the same
order, and it leaves nothing: no row, no drawn value, nothing a live query sees. A write that commits sends nothing
more. Where another write committed between the two flights and left no such row, the witness is
`{ kind: "unreproduced" }`, never a guess. grizzle sends the second flight only for a key on a table the write changes,
where your role writes that table and the key's target through whole entries. Otherwise the witness is `unreported`.
That covers a query entry, as PostgreSQL itself states the key to no role that cannot read it, and a key a
delete from its target breaks on a table the write leaves alone. A drawn key, such as an instant from the database clock, is the one the
second flight drew. The witness is `unreported` for a foreign key PostgreSQL checks at the statement, and where no
row you stated breaks the rule: a row only PostgreSQL computes,
a query's, or a rule reading a value the host does not hold or over what the host does not evaluate. A family member you put is such a row: its running values are PostgreSQL's, folded again in the
write's own statement from the stored members before it, and its counts and ends stay as stored, so grizzle holds none
of them, and a rule only they break is refused with the witness `unreported`. A family's owner that you insert and the
write never reads, such as one with no members in the ChangeSet or an ordered one, could be new or a stored one you
insert again, which the write leaves as it is: grizzle names it only where it is the one row of the refused statement
that can break the rule, and where two such rows can, the witness is `unreported`.

**The parse, then PostgreSQL.** grizzle checks nothing on the host that PostgreSQL enforces. A value is parsed once, as
its field's or parameter's type exactly ([Tables and types](#tables-and-types)), and a value no such type holds is an
`EncodingFailure` before any SQL. Every law over the values is PostgreSQL's: keys, containments, checks, contracts,
patterns and rosters, each refusal classified into the typed outcome or error below, one round trip in, never an
earlier refusal of the host's. The one rule the host judges is a relation's rows as a set: two rows one stratum adds at
one key that differ elsewhere are `refused` on that key before any SQL, since the input is no set of its facts.

**Contracts and patterns.** The encoder checks only the base type, so a value its contract or pattern refuses is refused
by its domain's CHECK as the statement casts it, before the row's constraints and row-level security. A parameter's
value is cast as PostgreSQL binds it, to its contract's domain or to its own pattern domain, one per parameter and
pattern, which `grizzle generate` installs for every contract and every pattern a served parameter names: a value
outside them is refused
there, before the statement reads a row. A write binds every such parameter in the first statement each call sends,
and sends no statement for it: each parameter is an entry no query reads, leading every statement before the first
one the write sends wherever the parameter may hold a refused value (a scalar's in every call, a relation parameter's
where it holds a fact) and that one, its placeholders the statement's first; where no statement is sent so, the
write's first statement is sent there besides, writing nothing. So the refusal comes before any other statement of the
write runs, whichever stratum reads the parameter, and no law a stratum breaks answers first. A read binds every one
in its statement, those its query leaves unread too (a rule under the constant false `r.or([])`), so a call is refused
for the parameters it declares, never only for those its logic reads. A
contract's refusal of a parameter is `refused` on the contract's law, its
witness `unreported`, a write's and a read's (`LawRejected`) alike; a pattern's refusal of a parameter, a
`str.bytes` bound's among them, is `paramRejected` (`ParamRejected`), its `param` where: `{ kind: "scalar", name }`
for a scalar parameter, `{ kind: "field", name, field }` for a field of a relation parameter's facts. A caller names
the field it refused from that data, never from the message, which spells the place `<parameter>.<field>` with its
pattern: a parameter's name may hold a `.`, so that text can name two places. The outcome names
the contract's rule or the field's pattern rule. Fields of one pattern share a domain, as do fields whose patterns
grizzle proves match the same texts, and PostgreSQL reports the domain, never the column, so grizzle judges the row on
the host to name the field, its rule spelled as that field spells its patterns:
`{ kind: "pattern", relation: "Item", field: "slug", patterns: [{ source: "^[a-z-]{1,64}$", flags: "u" }] }`. A
`str.and` field's rule lists every pattern, in order: its domain is one CHECK, which PostgreSQL refuses as a whole, so
no outcome tells which pattern a value missed. A value PostgreSQL
generates into a refined field, or grizzle fills into a fold's accumulator or end, is refused the same way; its witness
is `unreported` where grizzle does not hold the value: where only a refill writes the row, such as a stored owner whose
family the write appends to, and at a family member you put, whose running values PostgreSQL folds again from the
stored members.

<details>
<summary>Every rule an outcome can name</summary>

| `law.kind`   | Its fields                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `primaryKey` | `relation`, `fields` (a span field makes it a no-overlap key)                                                   |
| `key`        | `side`: a key statement, a candidate key of its relation when its side reads every row and its terms are fields |
| `check`      | `relation`, `name`                                                                                              |
| `contained`  | `from`, `to`: a containment, foreign keys included; a `mirrors` is two containments                              |
| `coverage`   | `from`, `to`: a containment whose sides pair a span field                                                       |
| `family`     | `order` (`"ordered"` or `"counted"`), `member` (a side), `slots` (`{ owner, count }`)                           |
| `tree`       | `member`, `slots`, `root` (the root fields, a list)                                                             |
| `fold`       | `family` (its slots), `monoid`, `step` and `end` (sides)                                                        |
| `contract`   | `contract`                                                                                                      |
| `pattern`    | `relation`, `field`, `patterns`: each `{ source, flags }` as that field spells it, one rule per field           |
| `variant`    | `relation`, `field`, `variant`: a variant field's value is of one arm, each field of its type and its arm's check holding, one rule per field |
| `generated`  | `relation`, `field`: a generated field whose term has no value at a row, a closed read at a key its relation lacks |
| `above`      | `level`, `law`: a law of a level above the Db's, as that level states it, only ever in `refused.above` of an `above` refusal |

A side is `{ relation, terms, selection }`. `terms` are in the order the rule pairs them, each `{ kind: "field", field }`
or `{ kind: "pred", field }`.
`selection` is `{ conjuncts }`, row predicates in canonical form (a literal second, `gt` and `ge` between two terms as
`lt` and `le`, `eq` and `ne` with their terms in canonical order, an IN list's values a set, and an IN list of one value
the `eq` with it) and canonical order; a side that reads every row has none.

</details>

Every rule carries its catalog entry, `entry: { kind, name, source }`, the same shape whatever its kind and no part of
what it is: `sameLaw` reads it, but its identity, the schema's fingerprint and the installation do not, so a changed entry
drafts no migration and only rewrites the snapshot's record and the served files. Declare one with
`law({ name, source }, declaration)`, any two nonempty texts (a catalog's name for the rule and the specification
section it reads, say), at the declaration the rule comes from: a statement, for every rule it states; a relation, for
its primary key's rule; a `generated(type, term)` field, for its generated rule; a `str.regex`, `str.and` or `str.bytes`
type, for the pattern rule of every stored field it types, one entry for the type whatever field it types, a drawn,
accumulated or generated field of it included; and a contract, grizzle's own `natural` among them, for its rule. `law(...)` returns a copy of the declaration carrying the entry and leaves the declaration as it
was, so declare the copy where you use it. Every rule so declared carries `{ kind: "declared", name, source }`, in
`lawsOf`, in `lawsByStatement` and in every refusal that names it, a refusal by a rule of a level above included. A rule
nothing declares one for carries `{ kind: "derived", name, source }`: a check and a contract by their own names, any
other rule by its shape as grizzle names it (`key Grant(id)`, `Grant(owner) in Owner(id)`), and its source the statement
that states it, as grizzle spells it. One rule takes one entry: two declarations of it that declare two entries are
refused as `MalformedDescription`, and so is `law(...)` of a `mutable` or `race`, which states no rule, of a value that
declares none, or of a declaration already given one.

`lawsOf(schema)`, from `@bjornpagen/grizzle/compile` as `lawsByStatement`, `constraintNamesOf` and `rowEvaluator` are,
lists every rule the schema states, each once, as `{ law, id }`: `law` exactly as an outcome names
it, its entry included, so every rule an outcome over the schema names is one of them, and `id` the one a refusal names it by, a refused
law's own. Name the rules you handle by their ids once, then read a refusal's `laws` by `id`, with no search and no
table of ids of your own. In order, however you declared the schema: each table's primary key, by table
name; the rules of the schema's statements in canonical order, one for a key, check, containment, family, tree or fold,
two containments for a mirrors, none for `mutable`; each contract's, by
name; then each stored field's pattern rule and each generated field's rule, by table name and each table's fields in
declared order. A rule two statements state, such as a key over a table's primary key, is listed once. A pattern every
text matches, such as `"^.*$"` under `"su"`, states no rule: grizzle drops it, and the column is plain text. Neither
does a contract's pattern, whose refusal names the contract, nor a closed relation's, whose rows the schema fixes. A
contract only a login's context field names is the login's, never the schema's: PostgreSQL checks a claim against it where a
statement reads it, and no write is refused by it. Each call compiles the rules, so call it once and keep the list.

`lawsByStatement(schema)` compiles the rules once and gives a lookup: bind it once,
`const lawsOfStatement = lawsByStatement(schema)`, then `lawsOfStatement(statement)` lists the rules that statement
states, each a `law` of `lawsOf(schema)`'s list, in its order: two containments for a mirrors, none for `mutable`, and
a rule two statements state is each one's. A statement is its canonical form, so
an equal statement built again is the same one, at any level. A lookup compiles nothing, and throws `CompileError` for a
statement no level of the schema states.

`sameLaw(a, b)` says whether two rules are one: `refused.laws.some((law) => sameLaw(law, rule))` says whether a
refusal names `rule`, and a handler for each `law` of `lawsOf(schema)` handles every refusal.
`constraintNamesOf(schema)` compiles the rules once and gives a lookup of the name PostgreSQL holds each check under:
bind it once, `const constraintNameOf = constraintNamesOf(Credits)`, then
`constraintNameOf({ kind: "check", relation: "Grant", name: "WithinGrant" })` is `"within_grant"`, and a row check
declared as `E1_derived` is `"e_1_derived"`. A check over a stored derived relation is its table's CHECK, named as
declared. A check over a live derived relation is held by a trigger on each table its query reads, named from its rule (`__<readable part>_<digest>`), since its own name could be a table's check's. A direct
writer's refusal by the check names it, so take it from grizzle and never spell it. A lookup compiles nothing, and
throws `CompileError` for a rule that is no check of the schema.

`rowEvaluator(schema)` compiles the schema once and gives the host's evaluation of a row: what PostgreSQL computes of
it, by the one evaluator grizzle judges a refused write's rows by. Bind it once,
`const evaluate = rowEvaluator(Accounts)`, a `Result` whose failure is the schema's `CompileError`: every `Result`
grizzle answers, here and in `codecText`, `insertPreview` and `indexesOf`, is Effect's (`effect/Result`), read with
`Result.isSuccess`, `Result.match` or `Effect.fromResult`. A row is admitted
once, `evaluate.admit(Account, row)`, then evaluated as a row of any source of its relation, `evaluate(Account,
admitted)` or `evaluate(select(Account, (a) => a.gt(a.units, 3)), admitted)` for a selection. A source is any relation of
the schema, stored, derived or closed, a roster among the closed ones, or a selection of one. The row is typed off the
relation: every field but the generated ones, each its codec's value, so a contract's value is its host's, `toUnits(5)`,
and an instant, the database's or a stored one, the `bigint` it is: an evaluation writes nothing, so a row it judges
holds any instant, and an admitted row's instant is no `Instant`, which only a read delivers.
PostgreSQL reads each value as its column's type and holds it to its domain before anything else, which a mint does
not check, and so does admit: `{ _tag: "ValueRefused", field, fault }`, a field whose value its type's input function
refuses (an integer that is none or past its type's range, a text holding NUL, a date no calendar holds, a numeric past
its typmod), by the codec's fault, the word `codecText` refuses the value by; `{ _tag: "DomainRefused", field }`, a
field a domain refuses, its contract or its pattern; or the `AdmittedRow`, which only admit makes, `admitted.row` the
row as stated. Its domains judged once, an admitted row is evaluated as `{ generated,
checks, selected }`, each item its own `Result`, computed where it is first read and kept on the admitted row, so every
source of the relation over it shares the generated values and verdicts it reads:

- `generated`: each generated field's value, by name, or `null` where PostgreSQL computes NULL, as a closed read at a
  key no row holds does, which the column's NOT NULL refuses;
- `checks`: each row check of the relation, by name, `"holds"` or `"breaks"`, as the database judges it, NULL breaking
  it: a table's by its `CHECK ((p) IS TRUE)`, a derived relation's by its rule's violation query, `WHERE (p) IS NOT
  TRUE` over the derived row;
- `selected`: whether the source keeps the row, its predicate true, as `WHERE` reads it; a relation keeps every row,
  being `select(R, TRUE)`.

A closed relation's row is evaluated as any other: its facts are rows of its heading, and a selection of it is a side a
rule reads, by its fields' literals in a containment into it and by any predicate in one between closed relations. It
has no generated field, since `closed.relation` refuses a field grizzle writes, and no check, since the schema refuses a
row check over facts it fixes, so its evaluation is its domains and `selected`: each of `PlanLimits.rows`, admitted and
evaluated as a row of `PlanLimits`, gives no generated value, no verdict, and `selected` true.

An item whose expression the host does not lower or evaluate, such as float arithmetic in a derived relation's check,
is `{ _tag: "Unevaluated", why }`, the other items keeping theirs. Nothing is thrown, and nothing stands in for a value. Each source is read where it is first evaluated,
and once.

`codecText(field)` reads a field descriptor once and gives the one text of each value of its type, a function of the
value alone: bind `const startText = codecText(Node.fields.start)`, then `startText(row.start)` is a `Result` of the
value's text, or the `CodecFault` of a value its type does not admit. Two values have one text exactly when they are
one value: numeric 1.0 and 1.00 are one, as NaN and NaN are, and a float's -0 and +0, equal under PostgreSQL's
equality, are two, `-0` and `0`. A closed id's text
is its handle, its host value, and a set's its handles in its roster's declared order as a JSON array: a code is a
storage detail of one installation, so a text is the same in every installation, and readable in a message. Every other
carrier's is the codec's own, which PostgreSQL's input function reads as the value: an integer's digits, a numeric's
`numeric_out` text, a double's shortest round-trip decimal, `true` or `false`, a date's ISO 8601 text, a text itself.
Key a set or a map of rows by these texts, and never by `String()` of a host value. A bytes field is a type error.

`rowText(query)` reads a query's decoder once and gives the one text of each row it delivers: bind
`const text = rowText(lessons)`, a `Result` whose failure is the `CompileError` of a query no builder can decode (one
rebuilt from its Description), then `text(row)` is a `Result` of the row's text, or the `CodecFault` of a value its type
does not admit. Each column's value is written as `codecText` writes it, a set's handles in declared order as a list, a
bytes value as its SHA-256 digest, and each attachment's children in delivered order, an Option's none or one; every
piece is framed by its length and every list by its count, with no JSON, so two rows have one text exactly where they
are one row, value for value under each type's equality, attachments member by member. A digest of it keys a found row
by its content ([Records of a query](#records-of-a-query)).

`insertPreview(schema)` gives the rows `ChangeSet.empty(schema).insertAll(rows)` stores as the first write of an
installation holding no row, closed relations aside, with nothing sent: bind `const preview = insertPreview(BoxOffice)`,
a `Result` whose failure is the schema's `CompileError`, then call `preview(rows)`. `rows` is insertAll's record over
every top-level relation: a preview states every value, and PostgreSQL draws nothing in it. Binding compiles the
schema's law model, the one `rowEvaluator` and `lawsOf` read of the same schema value, and nothing else: each call
compiles, the first time a call writes them, the insert of the families its rows write (the relations it states rows
of, every relation a write of them writes, their families' owners and members, and the clock each instant they stamp by
reference is stamped from), the host half of the compile the write takes, no statement built, kept for every later call
that writes the same families. So a call's compile is the insert of what it previews, whatever else the schema holds.
Each call is the write's own binding of its rows, the one every application of it runs before any SQL, so every count,
index, interval, fold end and copy the write draws, a fresh counted group's whole among them, is the preview's. It is a
`Result` of `PreviewRows<S>`: every writable relation by name, an empty array where the write stores none of it, each
row every field the relation stores but those PostgreSQL generates, each its codec's host value, a closed id its handle,
so `rowEvaluator(schema)` admits and evaluates a row as it is, its generated fields and its checks in one place. A
relation's rows are a set, each once, in no order that means anything. Or it is the refusal the write meets before any
SQL, a tagged value, never thrown:

- `InputRefused`: `failure`, the `EncodingFailure` of a value outside its type or a fact of another shape, or the `MessageBound` or `LiteralBound` of an input past what one statement carries, which
  the write meets as `input`;
- `KeyConflict`: two rows of one relation at one key that differ, `law` the key's and `witness` its values, as the
  write's `refused` names them;
- `GeneratedNull`: a generated field with no value at a row a family's fill reads it of, `law` the field's and
  `witness` the row's key;
- `OwnerAbsent`: a counted family's member whose owner the call does not insert, which no installation holding no row
  stores, `law` the family's as `lawsOf` lists it, so `sameLaw` reads it.
- `Uncompiled`: `error`, the `CompileError` the insert of the call's families refuses as it compiles, a relation no
  insert can write, such as an instant no one clock stamps; each call that writes those families meets it.

A law PostgreSQL judges once the statements run, a check, a containment, a rule over a query, a generated field's NOT
NULL where no fill reads it, refuses no preview: its rows are the rows the write would send, which `rowEvaluator` and
the laws judge. A code is a storage detail of one installation: a preview binds under its rosters' declared order and
gives handles alone, so its rows are the same whatever codes an installation holds
(test/pg/write/preview/preview.test.ts holds them to a fresh installation's and to one migrated past a dropped handle).

**Errors**: `DbLayer.make` and `Db.open` fail with `OpenError` in the Effect's error channel; every call of a member
fails with its `CallError`, by kind:

| `kind`          | `retry` | What happened                                                                                                   |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `input`         | `never` | a parameter, a fact or a window the member's codecs or input boundary refuse, past a bound of its transport included |
| `paramRejected` | `never` | PostgreSQL refused a parameter's value outside its pattern, a `str.bytes` bound included, as it bound it (`param`) |
| `tokenRefused`  | `never` | no token where the role declares a token's context, a token `verify` refuses, or claims that do not decode      |
| `tokenExpired`  | `safe`  | the token expired, before the call or while it streamed                                                         |
| `refused`       | `never` | the schema's laws refused the write (`refused`, `witness`)                                                      |
| `outsideWorld`  | `never` | a row the write adds lies outside the written world relation (`relation`)                                       |
| `transient`     | `safe`  | the attempt changed nothing, refused by a concurrent transaction (`reason`)                                     |
| `credentialRefused` | `never` | no session could be had: its connection was not authenticated, either way (`reason`)                       |
| `unavailable`   | `safe`  | no session could be had for now: the network, the server, a released layer, `verify`'s verifier (`reason`)     |
| `transport`     | `safe`  | a connection broke before the call's end: a read's, which commits nothing, or a write's before COMMIT was sent |
| `stale`         | `never` | the database is not at the Db's snapshot ([Deploying](#deploying)), so the call ran nothing                     |
| `commitUnknown` | `never` | a write's COMMIT was sent and no answer came: it may have committed                                             |
| `failed`        | `never` | the server refused a statement, or answered rows grizzle cannot read                                            |
| `route`         | `never` | over HTTP, no served member at the path                                                                         |

- **`OpenError`**'s `reason` is what happened, a tagged value, so `Effect.catchReason`, `catchReasons` and
  `unwrapReason` reach it; `stage` follows from the reason, and `message` is a sentence naming it. Every error and
  reason class is exported as a value, the class grizzle builds it with, so a test of your code builds the exact value
  an open fails with, never a cast. Your `password` Effect fails with `CredentialError`, and your `verify` with
  `TokenRefused` where its verifier refuses the token, or `VerifierUnavailable` where none could judge it now (the
  verifier's service down or unreachable): `OpenError`'s `retry` is `safe` for that one reason and `never` for every
  other, and over HTTP the call's error is `unavailable`, reason `verifierUnavailable`, retried safely, so an outage of
  your verifier never reads as a refused token.
- **`transient`**: its `reason` is `SerializationFailure` (40001), `Deadlock` (40P01), or a concurrent transaction's
  work the statement met (`PutTargetConflict`, `SpanKeyChange`, `UnseenOccupant`). grizzle never
  runs a call again: running it again is the caller's (a den step runs again past one). Each refusal changed nothing
  and came of another transaction's committed work, and PostgreSQL's serializable implementation cancels an attempt
  only once a transaction it conflicts with has committed, "such that an immediate retry will not fail again on
  conflicts with the same transactions" (src/backend/storage/lmgr/README-SSI), so a call run again starts past work
  that committed. A deadline is yours to put on the call, `Effect.timeout`.
- **`commitUnknown`**: COMMIT was sent whole and no answer came, so the change may have committed. Read back before
  running it again. A write the socket failed before COMMIT's last byte left the process is `transport` instead: COMMIT
  never reached the server.
- **`credentialRefused`**: no session could be had, and the same call meets the same refusal until the connection's
  configuration changes, so it is never to retry. Its `reason`, a string:
  - `passwordFailed`: your `password` Effect failed (`CredentialError`), so no password was offered;
  - `passwordRefused`: the server refused the password, SQLSTATE 28P01;
  - `loginRefused`: the server refused the login with any other SQLSTATE of class 28, 28000 among them: no
    `pg_hba.conf` entry admits it, or its role does not exist or may not log in;
  - `tlsUnverified`: TLS did not come up verified: the server's certificate does not chain to `ca` or does not name
    the host, the handshake failed with a code no system error has, or the server offers no TLS or answered the
    SSLRequest with neither yes nor no;
  - `driverRefused`: pg ended the startup itself, with no SQLSTATE and no code: a SCRAM exchange whose server proof
    does not verify, a mechanism it does not support, a server that asks a password of a role given none.
- **`unavailable`**: no session could be had for now, for a cause that may pass. Its `reason` is `{ kind }`, a cause
  of a closed set read off the SQLSTATE or the socket's code, never off the message:
  - `connectionRefused`: nothing accepted the connection at its address, ECONNREFUSED or ENOENT;
  - `hostUnreachable`: no route reaches the host, EHOSTUNREACH, ENETUNREACH, EHOSTDOWN or ENETDOWN;
  - `hostUnresolved`: the host's name did not resolve, ENOTFOUND or EAI_AGAIN;
  - `timedOut`: the operating system gave up on the connection, ETIMEDOUT;
  - `connectionClosed`: the connection closed before the session was ready, with no ErrorResponse
    (`ConnectionClosed`), ECONNRESET, EPIPE or ECONNABORTED, a TLS handshake's among them;
  - `serverDown`: 57P01 (admin_shutdown), 57P02 (crash_shutdown) or 57P03 (cannot_connect_now: starting, recovering
    or stopping);
  - `tooManyConnections`: 53300, the server's or the role's connection limit;
  - `layerReleased`: the `DbLayer` the Db was opened under, or a live read registered on, was released;
  - `sessionLost`: a session of a live read's source, its listener's or its leader's, was lost with no report of the
    server's (one the server ended with a report reads by its SQLSTATE, 57P01 as `serverDown`), its connection having
    ended; pg's own refusal of a query on a connection still standing is `failed`, never a lost session;
  - `slotInvalidated`: the installation's replication slot was invalidated: its live leader makes it again;
  - `leaderFailed`: the live leader's candidacy failed otherwise: an answer, a message or a secret it cannot read, a
    statement past a bound, or a replication stream the server ended;
  - `{ kind: "otherSqlstate", sqlstate }`: the server refused with any other SQLSTATE, such as 3D000 for a database
    that does not exist;
  - `{ kind: "otherSocketCode", code }`: the socket failed with any other code, its errno's name for a system error.
- **`credentialRefused`**, **`unavailable`** and **`transport`** change nothing. Waiting for a session never fails: a
  call waits until it has one or is interrupted. A server that reaches ReadyForQuery without a cancellation key
  (`NoCancelKey`) is `failed`: every attempt meets it.
- **The server's report** is in the `message` of every call PostgreSQL's refusal ends, `SQLSTATE <code>: <message>`, its
  message exactly as the server gave it. The server writes in the language of `lc_messages`, the database owner's
  setting; grizzle classifies a refusal by its SQLSTATE and the fields it names, never its words. A message can quote
  the values a statement was given, though never a value outside the role's view, so what you log is your choice:
  grizzle logs nothing.

<details>
<summary>Every error reason</summary>

**`OpenError`**, by stage:

| Stage        | Reason                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`     | `DbConfigRefused`; `ConnectionEnvironmentRefused`, a process environment that sets `PGREPLICATION`                                                                                                                                                                                                                  |
| `role`       | `RoleOutsideLayers`                                                                                                                                                                                                                                                                                                 |
| `token`      | `TokenMalformed`, a token that is no token68 (a JWT is one), refused before `verify` runs; `TokenRefused`, `verify`'s refusal or throw (the throw is its `cause`); `VerifierUnavailable`, `verify` unable to judge the token now, the one reason whose `retry` is `safe`; `ClaimRefused`, a payload that does not decode through the role's contexts; `ExpiryRefused`, an `exp` that is no number of seconds since the epoch |
| `schema`     | `CompileError`; `AttestationRefused`, attested facts that do not decode through the role's attested contexts                                                                                                                                                                                                      |

`Db.open` contacts nothing, so a connection that can't be had is the first call's failure, never the open's.

A call's `CallError` is read from the reason that failed it, each reason a class of grizzle's own
(adapter/live/call-error.ts), and a member's `explain` and `explainAnalyze` fail with the `CallError` its `once` would:

| Reason                                                                                                                                                                       | `kind`          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| the server's `ServerError`, 53200 and 54001 among them; `UnreadableAnswer`, rows grizzle cannot read or its compiled proof says the query cannot deliver; `CompileError`; `DriverFailure`, pg's refusal of a query on a connection still standing; `AdviceUnloaded`, a session that does not load `pg_plan_advice` ([Install](#install)) | `failed`        |
| `CredentialError`; `StartupRefused` of SQLSTATE class 28; `TlsRefused`, but a handshake's failure with a system error's code; `DriverRefused` | `credentialRefused` |
| `StartupRefused` of any other SQLSTATE, with the server's report; `SocketFailed`; `TlsRefused` of a system error's code; `ConnectionClosed`; `LayerReleased`, a layer whose scope has closed | `unavailable`   |
| `NoCancelKey`                                                                                                                                                                 | `failed`        |
| `ConnectionLost`, `CommitLost`                                                                                                                                               | `transport`     |
| `EncodingFailure`; `InputTooLarge`, below; `CallInputRefused`, below                                                                                                         | `input`         |
| `ParamRejected`, a parameter's value outside its pattern, its `param` the `CallError`'s                                                                                      | `paramRejected` |
| `LawRejected`, the laws a contract's or a pattern's domain discharges, which refused a value a statement cast to it; `InputRejected`, below                                 | `refused`       |
| `TransientFailure`, its reason the `CallError`'s `reason`                                                                                                                    | `transient`     |
| `StaleSnapshot`: `Migrating` or `Migrated` ([Deploying](#deploying))                                                                                                         | `stale`         |
| a COMMIT sent and never answered: the change may have committed                                                                                                              | `commitUnknown` |
| an `OpenError` of a call that opened its own Db, over HTTP: its token reasons `tokenRefused`, a role no layer serves `route`, the rest `failed`                                 | as listed       |

**`InputRejected`** is a ChangeSet member's `explain` of a call whose `once` would be `refused` before any SQL, by two
rows one stratum adds at one key, or a nested row's generated field with no value: its `refused` and `witness` are
that refusal's.

**`InputTooLarge`** is found on the host before the call's flight is sent. Its `bound`, which never counts rows:

- `message`: one statement's Bind message is longer than PostgreSQL reads (1,073,741,822 bytes,
  `PQ_LARGE_MESSAGE_LIMIT`), with the statement and its length. Split the input across calls. A family write's
  statement, which no execution cuts, meets it as every statement does; the largest real call, pantry's QTI publish at
  161.8 MB, is about 6 times under it.
- `literal`: one column of a relation input is an array longer than one JavaScript string holds (536,870,888 UTF-16
  code units), or for a bytes column longer than the message limit, with the input and its column. Split the input
  across calls.
- `input`: a ChangeSet member's arrays, or one row of a nested write, would make a Bind message past that limit, with
  the input and the least length its statement would take. It is counted from your values' lengths before any of
  their bytes is read or copied. Split the input across calls.
- `flight`: the call's flight, every byte the driver writes for it in its one write, is longer than one write over
  TLS carries (1,908,342,784 bytes), with its length. Nothing was sent, so nothing ran. Split the input across calls.
- `parse`: a statement's Parse message, its text with its name and fields, is longer than PostgreSQL reads
  (1,073,741,822 bytes), with its length. Nothing was sent, so nothing ran.

**`CompileError`**'s reason holds where it refused, `at`, and:

| Reason                                          | Details                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Refused`                                       | the `refusal`, a rule the type errors name too, in their words                                           |
| `MalformedDescription`                          | the rule `what` your schema or program breaks                                                            |
| `MalformedArtifact`                             | what grizzle reads back (the snapshot, a migration folder or its meta.json, the ledger's rows) malformed at the path `at` |
| `ArtifactFormat`                                | a committed snapshot or a served file, `artifact`, of another format than this grizzle's, `expected`: `recorded`, what its `format` member holds, `{ kind: "none" }` or `{ kind: "recorded", text }` |
| `UnsupportedOperation`, `UnsupportedLawFamily`  | a `capability` grizzle lacks, such as a parameter's value of a pattern no stored field declares, naming the parameter and the pattern ([Limits](#limits)) |
| `ResourceBound`                                 | its `bound`                                                                                              |
| `OutsideRole`                                   | the `role` and the `access` it doesn't hold                                                              |
| `DuplicateIdentity`                             | the `earlier` declaration                                                                                |
| `IdentifierCollision`                           | the `other` declaration and the `identifier` both convert to                                             |
| `IdentifierTooLong`                             | the `declaration` whose `identifier`, a name's conversion or a login's or role's role, takes `bytes` past PostgreSQL's `limit` |
| `DecodedColumnTooLong`                        | the `relation`'s closed-id `field` whose `conversion` takes `bytes` past `limit`, PostgreSQL's 63 less `_name`, so its decoded column `<field>_name` would not fit |
| `DigestCollision`                               | two objects, `display` and `otherDisplay`, whose hashed names share the stem and digest of `identifier`; renaming a declaration either is built from gives it another |
| `UnrepresentableKey`                            | every key the compile met whose entry no index holds, in `keys`, each with its `fault`                   |
| `PartialOperation`                              | an `operation` whose `precondition` on `operand` nothing proves, and the `guard` to write                |
| `RecursionRefused`, `DerivedRefused`            | their `cause`                                                                                            |
| `ForeignLevel`                                  | a rule over `over` (a schema or a role) reading a query written over `written`, none of `over`'s levels  |
| `RoleRefused`, `LoginRefused`, `ContextRefused` | the `rule` broken                                                                                        |
| `ScopeRefused`                                  | the `role` whose scope breaks the `rule`: `owner` (`why`), `unit`, `unitType` or `twice` |
| `GeneratedRefused`                              | the generated `field` of a `relation` and the `rule` it breaks                                           |
| `FoldOverProjection`                            | the match's `source` and the `key` it must bind for an aggregate to read each row once                   |
| `QueriedOwnerAppend`                            | an insert or put (`op`), at `at`, of the `owner` from a query beside an append of `member` to its `family` (`{ owner, count }`) |
| `CascadedCopyAppend`                            | a write (`op`) of `member` of its `family` whose `copy` reads its `owner`'s `through`, which the owner copies from `changed`, a relation the same stratum puts from a query, whose rows grizzle never sees |
| `StaleDerivedRead`                              | a write (`op`) of `member` changing a stored row's column (`changed`: `relation`, `column`, and `by`: `put`, `owner` or `member`), which the cascade carries into `copies`, read by `reader` (`{ kind, family, relation, column }`: a fold, a predecessor, a last or a tree's copy), which grizzle cannot refill for `cause`: `{ kind: "query" }`, a put from a query; `{ kind: "cycle", refills }`, refills reaching a family they refill again; `{ kind: "immutable", relation }`, a refill of a closed owner's family or a closed relation's rows; `{ kind: "tree", tree }`, a refill of the values of the tree `tree` (`{ owner, count }`), which grizzle draws only when a node is written; `{ kind: "chained", refill }`, a refill of a value that reads what the refill of the family `refill` (`{ owner, count }`) itself changes; or `{ kind: "edit", family }`, a refill of a value of `family` (`{ owner, count }`) that a family member's own put, delete or append reaches beyond the two values such a write refills |
| `UnfillableField`                               | the `relation`'s `field`, the `law` filling it, the `source` column it reads along `axis` of its `family`, and why that column is filled `later` |
| `UnwritableRelation`                            | the `relation` no write fills, and its `cause`                                                           |
| `NoReadCommittedForm`                           | the `relation`, whose primary key holds a span, that a ChangeSet compiled for READ COMMITTED inserts into: only a compile at a level no certificate gives meets it, since generate runs such a role SERIALIZABLE |
| `ReadBackCrossesStatements`                     | the read-back `read`, and `delta` (`relation`, `side`), a side of a table's delta more than one statement makes, or one a statement of another stratum nets |
| `UnorderableStratum`                            | the `cycle` of a stratum's writes (`{ relation, op }`: an insert, put or delete, or a family's insert, update or delete of its members' rows or count of its owners), each of which immediate keys order before the next and the last before the first, so no order of the stratum's statements keeps them all |
| `UnstatedKey`                                   | a put or delete (`op`) of a `relation` whose `key` (`{ kind, fields }`: its primary key, or a declared one a put compares) holds fields grizzle writes (`unstated`) |
| `UndeclaredDrop`                                | the name a migration would drop, which no `--drop` or `--rename` declares                                |
| `MissingDiscriminant`, `AttachedParentUnbound`, `AttachedPage`, `DescribedHeadingMismatch`, `ContractLiteral` | a `capability` sentence |

**`EncodingFailure`**'s reason is its codec's fault word, never the value, the word of the exact parse that refused it:
`numericScale` for a `Decimal` past its field's scale and `realInexact` for a `number` no binary32 value is among them;
its `place` is the `Slot` the value fills, by `name`, or a whole `Fact`. **`CallInputRefused`**'s `fault` names what
of a call's input it refuses: `envelope`, no record of exactly `params` and `facts` (and a paged member's `window`);
`params`, params that are no record; `{ program, parameter }`, a key of the params that names none of the member's
parameters, `assignByGradeBypassingGate declares no parameter titles`, so a parameter misspelled, or one another
member takes, is refused as itself and never binds nothing; `facts`, facts given to a member that takes none;
`window`, `size` or `anchor`, a paged member's window, a position that is no safe integer of at least 0 among its
anchor's faults.

</details>

## Transactions and concurrency

- **Every transaction grizzle opens names its level.** A write runs SERIALIZABLE unless its role is certified READ
  COMMITTED, and a read SERIALIZABLE READ ONLY; a statement grizzle sends
  outside a transaction, a `-- grizzle: no-transaction` file's among them, runs SERIALIZABLE, since every session of the
  migration identity starts with SERIALIZABLE as its default. grizzle sets no database default: a foreign session
  starts at the server's, READ COMMITTED unless the operator chose otherwise. A write below SERIALIZABLE on a grizzle
  table is refused with 25000, by the table's guard trigger, psql's included, so a direct writer says SERIALIZABLE; the
  guard, not a default, keeps every direct writer of a guarded table inside what certification proves.
- **A role's writes run READ COMMITTED only where generate proves it.** `grizzle generate` certifies each role from
  the statements its ChangeSets send, against every other writer, and the role's served file begins its writes at the
  level it proved ([READ COMMITTED writes](#read-committed-writes)). Reads are always SERIALIZABLE READ ONLY
  ([Reading](#reading)).
- **A table whose every writer is certified READ COMMITTED has no guard.** Such a table is one some role writes, and
  every role that holds INSERT, UPDATE or DELETE on it is certified to run its writes READ COMMITTED and holds only
  INSERT and SELECT there. The installation creates no guard trigger for it, so a write below SERIALIZABLE is admitted
  there: a direct writer meets the grants of the role it writes as, which insert and read and nothing else, and the
  table's laws, each a constraint PostgreSQL checks at every level or a rule over a query no other write can help
  break ([READ COMMITTED writes](#read-committed-writes)). Every other table keeps its guard, and a table no
  role writes keeps it too. A migration that changes whether a table qualifies drops or creates its guard. A role
  that writes only by direct SQL has no ChangeSet to prove, so it is SERIALIZABLE, and a grant of INSERT, UPDATE or
  DELETE to it keeps that table's guard and makes SERIALIZABLE every role that writes the table, every role whose
  writes its grants let it read, and every role whose foreign keys check what it writes: generate cannot see its
  transactions, so it takes them as any its grants permit, which may read any relation they reach, present or absent,
  and take no fence ([READ COMMITTED writes](#read-committed-writes)).
- **One call, one transaction, one round trip or two.** A call sends BEGIN, its statements and COMMIT in one pipelined flight.
  A write that must read stored values first (a family edit of a group already stored, or a refill of a value a change
  leaves stale) sends two flights in its one transaction: one batched read per family of the stored values the edit
  continues and one per way a change reaches a refilled family's groups, then the writes filled from them with COMMIT.
  There are no interactive transactions: a read that decides a write is a query inside the ChangeSet, and reads that
  must agree are one query with nested results.
- **No retries.** A refusal from outside the call's inputs is a `transient` `CallError` (a migration's is `stale`)
  and changes nothing. Any SERIALIZABLE transaction can meet a serialization failure, even with no other transaction in
  sight, because under load PostgreSQL's SSI summarizes old committed transactions and judges conservatively: treat it
  as retryable everywhere.
- **Imports at once: one database per worker, for now.** Two large imports into one database, such as two packages
  that share no row, can still fail each other with 40001: PostgreSQL's SSI can lock more of a stored table than the
  rows a staged write reads. Until grizzle's fix for this lands, run imports that happen at the same time each in a
  database of its own, one database per worker.
- **No timeouts.** grizzle sets no `statement_timeout` or `lock_timeout`, and no connect timeout: a connection attempt
  waits for the server's own answer, or for the failure the operating system reports (a refused, reset or timed-out
  connection) and PostgreSQL's own `authentication_timeout`. Put a deadline on a call yourself, `Effect.timeout`.
  Interrupting the Effect is the only cancellation: a call interrupted while its statements run sends a
  CancelRequest, then waits on its own connection for the server to end the statement. PostgreSQL ignores a
  CancelRequest that reaches the backend before it has read the statement, so each time the server answers another
  statement of the call while it has not ended, the call sends another; a statement a CancelRequest missed runs to its
  own end, whose answer sends the next. The interruption ends only once the server has stopped the statement: its
  locks and snapshot are released, a write's COMMIT has run or never will, and a read after the interruption sees the
  outcome. The session is never used again. A CancelRequest that cannot reach the server (refused, reset or timed out,
  as the operating system reports it) counts it unreachable: the call destroys the connection and ends, and what the
  server then runs of the statement is unknown. A server that goes silent without the operating system noticing is
  found only by your transport's TCP keepalive (`open`). Treat an interrupted write like `commitUnknown`: if its
  statements had all finished, it may have committed.
- **Predicate locks are the operator's to size.** Set `max_pred_locks_per_transaction = 2048`; without room, PostgreSQL
  fails transactions with 53200, which is not retryable. Keep every transaction on the cluster short: a committed
  write's and a read's predicate locks are kept until every older transaction ends.
- **A lone writer can still meet 40001.** While a transaction that has written holds the cluster's horizon back, any
  idle-in-transaction session or long import among them, PostgreSQL keeps every SERIALIZABLE transaction that finishes
  meanwhile, and once they fill its fixed pool, ten per connection slot, it summarizes the oldest to their ids alone. A
  writer whose transaction writes a row its own earlier transaction read, and reads a version that a summarized one of
  its own wrote, is then failed as a pivot ("Canceled on identification as a pivot, with conflict out to old committed
  transaction"), though no other transaction touches its tables: the earlier reader counts as concurrent because the
  writer's snapshot starts below the held horizon (PostgreSQL 19 src/backend/storage/lmgr/predicate.c 4157 and 4170),
  and a summarized writer is looked up with no test of concurrency (3980-4012). A migration meets it as a refused file,
  a call as a `transient` `CallError`; both are safe to run again: the call changed nothing, and `grizzle migrate`
  resumes the folder where it stopped. A session waiting on a lock that has written nothing holds no horizon back. The
  experiment packages/experiments/ssi-summary reproduces it.

### READ COMMITTED writes

At SERIALIZABLE, PostgreSQL aborts one of two transactions whose reads and writes could cross, with 40001, and under
load it judges conservatively, so many callers writing at once (a class of children answering the same test) meet
40001s that no real conflict caused. grizzle never retries. Instead, `grizzle generate` proves, role by role, when a
role's writes run at READ COMMITTED and still behave as if every call ran alone, one after another, in the order they
committed. Such a role's writes never meet a serialization failure: a real conflict is a key's law, refused by the
unique check that decides it.

**When a role is certified READ COMMITTED.** generate reads every statement each ChangeSet of the role's workload can
send, in every variant and every form, its read-backs included, and judges them against every other role of every
login. A row "another call can write" is a row of a relation some role writes, other than the call's own rows and
grizzle's own key checks of what it inserts. A foreign key check counts as a read, made at a later snapshot than its
statement's. The role is certified READ COMMITTED when all of these hold, and stays SERIALIZABLE otherwise:

- **It has a ChangeSet.** A role that writes only by direct SQL has nothing to prove. Its writes are unknown, and
  generate judges every other role beside the most a transaction of its grants can do: read every relation its grants
  reach, for what it holds and what it lacks (each relation its views read, a live derived relation by the relations
  its definition reads, and each table it holds a privilege on), insert, update or delete each relation it holds that
  privilege on, and take no fence. PostgreSQL refuses any other read with 42501 before it reads a row, so a relation
  its grants do not reach is one it never sees. While a role holds INSERT, UPDATE or DELETE and has no ChangeSet, no
  role runs READ COMMITTED that writes a relation it can read (`absence`, `laws`, `writers`), or whose foreign key
  checks a relation it writes (`pivot`), since no fence orders such a check against its transactions. A role that
  only reads has nothing to bound: a transaction that writes nothing is no pivot.
- **Each of its ChangeSets has a READ COMMITTED form.** An insert into a relation whose primary key holds a span has
  none: PostgreSQL arbitrates an exclusion constraint by `ON CONFLICT ON CONSTRAINT ... DO NOTHING` alone, so no
  statement can tell a fact the insert met from one it made. A role with such an insert, or a put of such a relation,
  runs SERIALIZABLE, where the insert arbitrates every key at once and classifies what it met. An insert that stamps an
  instant or a place has one: it takes its stamp from its scope's or its group's head row at its key, which serializes
  the calls of one key and no others ([Instants](#instants)), and reads nothing of its own relation to do it.
- **It only inserts.** It states `insert`, not `write`, so it holds INSERT and SELECT alone, and every relation it
  writes is one no role updates or deletes: by a grant, by a ChangeSet, or by an `ON UPDATE CASCADE` into it.
- **Its relations' laws hold at READ COMMITTED.** Every law over a relation it writes is one PostgreSQL checks at every
  level (a key, a CHECK, a domain, a foreign key), or a rule over a query that its writes can break only through the
  one row each inserts. A trigger checks such a rule at COMMIT, and generate reads each way the rule can be broken (a
  rule of a side's query, a key's two facts) that its write reaches: that way must read exactly one row some write can
  add or take away, a match of the row its write inserts, and beside it only rows no write adds (of a relation no role
  inserts or updates, or a closed relation) and the absence of rows no write takes away (of a relation no role
  deletes or updates). A write the trigger misses can then only take a violation away, so it
  refuses more, never less: `Live = Hold where not Freed` checked against a closed count, written by a role that
  inserts both, is one; a key over `Live`, a join of two relations roles insert, a count, sum, min or max of a relation
  a role inserts, which reads every row of its group, or a negation of a relation a role deletes is none. No
  SERIALIZABLE role's ChangeSet reads a relation it writes.
- **Nothing reads the absence or a count of what it writes.** No ChangeSet of any role asks whether a row of it is
  missing (a negation, a `NOT EXISTS`) or how many there are (a count, an aggregate). grizzle's own checks inside a
  write (a duplicate within the call, a refusal of a conflicting row) don't count when every row they look at comes
  through a whole immutable group the same statement reads positively, through one in each arm of a `UNION`, and every
  write they guard is joined with that group.
- **It reads other calls' rows in one statement, as whole groups that never change.** Each such read finds one row by a
  whole declared key of a relation every role only inserts into, all the members of a family whose closed owner
  holds their count, or a relation no role writes, keyed by values the call states once: a read keyed by each row of
  an array the call was given reads one group per row, which another call's rows can split. All of a ChangeSet's reads
  of other calls' rows are in one
  statement, beside no foreign key check that reads more of them, and each row it writes is joined with what it read,
  so a call that finds nothing writes nothing. Each foreign key check it makes finds an immutable row in the same way,
  or a row of a relation no role updates, which the check locks until the call commits, or refuses the call whole: by
  a whole key PostgreSQL enforces, a key over the columns a law adds among them, as an arm's mirrors' way back to its
  relation or a family's slot is. A
  row the call inserted, read back in a later statement by the key it was inserted at, is its own, when no statement
  up to the insert read other calls' rows.
- **No SERIALIZABLE role writes what it writes, or keeps a stored relation it keeps.** The table's guard would refuse
  every one of its writes. A write keeps a stored relation where its definition reads the relation written, directly
  or through another stored relation ([Derived tables](#derived-tables)): the judge's borrow orders two writers' upkeeps
  of one unit, but a SERIALIZABLE upkeep reads at its transaction's snapshot, which no lock moves past a READ COMMITTED
  writer's commit, so it would keep the unit as though that writer's rows were not there.
- **No SERIALIZABLE writer of what it reads can miss another call's write.** Every role that runs SERIALIZABLE and
  writes a relation the role reads (by a statement, or the judge of a rule over a query its write arms) reads no row
  another call can write, makes no foreign key check but one that finds an immutable row (of a relation every role only
  inserts into, by a whole declared key, or of a relation no role writes), and writes no relation a rule over a query
  reads. A foreign key check of the role's is no such read: a writer that may miss another call's write fences the
  relation it checks (below).

**Reading generate's report.** generate prints each role's level, and under a SERIALIZABLE role why it is, before the
files it writes:

```
login app, role learner: read committed
login app, role reader: serializable (writers 1)
  fix login author_app, role author first (writers 1)
login author_app, role author: serializable (privileges 1, absence 1)
  privileges, relation Item: holds DELETE; state insert, not write, on the relation, and let no role update or delete a relation the role writes: record each change as an inserted fact
  absence, member publish, statement 0, relation Item: author of author_app reads it negated; read no absence (NOT EXISTS, a negation) and no count of a relation the role writes, in any role's ChangeSet: state the fact as a row and read it by its key
login author_app fences PublishedVariant: its writes of it lock it in exclusive mode before their snapshot, for the read committed foreign key checks of login app, role learner
```

A SERIALIZABLE role's line counts each condition it fails, and the lines under it say where. A role that fails a
condition by itself has a line per place that fails one: the condition; where, the role, a relation, a ChangeSet's
write of a relation, or a statement of a ChangeSet by its place among the statements a call of it sends, with the
relation it reads or writes; what fails there; and the condition's fix. A role that fails none by itself, but runs
SERIALIZABLE because a role that runs SERIALIZABLE reads what it writes, writes what it writes, or writes what it reads
while that role may miss another call's write, has a line per such role in their place, `fix login L, role R first`,
with the count of each condition that role gives it: it runs READ COMMITTED once none of them does or gives it one, so
fix those first. Every count of a role's line is the number of its lines of that condition, or the sum of its givers'
counts of it. Each fence follows the roles. The conditions:

| Condition    | What fails it                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `form`       | a ChangeSet with no READ COMMITTED form: it inserts into or puts a relation whose primary key holds a span |
| `facts`      | a relation it touches that the installation states no fact of, or a table or function its statements name that no relation is         |
| `members`    | no ChangeSet in its workload                                                                                                             |
| `privileges` | it states `write`, or some role updates or deletes a relation it writes                                                                 |
| `laws`       | a rule over a query its write can break through more than the one row it inserts, or a SERIALIZABLE ChangeSet reading what it writes   |
| `absence`    | a ChangeSet that reads whether rows of a relation it writes are missing, or counts them, or a check of grizzle's own over rows no whole immutable group of its statement brings |
| `snapshot`   | a read of other calls' rows beside another one in a later statement, or beside a foreign key check                                      |
| `pivot`      | a read of other calls' rows that is no whole immutable group, a row it writes not joined with such a read, or a foreign key check of a row that can change |
| `writers`    | a SERIALIZABLE role writing what it writes, or keeping a stored relation it keeps, or writing what it reads by a statement or a rule's judge while reading other calls' rows or making a check of a row that can change |

A role's level is in its login's served file, so a change that moves it shows as a stale served file in `grizzle
check`, like any change to the workload. The served login reads it: `served<typeof Web>(webFile, "web").roles.member.isolation`
is `readCommitted` or `serializable`, for every role of the login.

**Reads stay SERIALIZABLE READ ONLY.** A query, a key and a window run SERIALIZABLE READ ONLY whatever the role's level,
each one statement. A ChangeSet's read-backs run in its own transaction, at its
level.

**compileServed serves every role SERIALIZABLE.** A file `compileServed` compiles from other programs than the
committed workload has no certificate behind it, so every role in it runs SERIALIZABLE.

**compileServed refuses a read the live source does not serve.** A watch of a read whose table the installation's
publication leaves out, or whose routing column its live source does not route by, would miss its changes, and a watch
over an installation with no live source would miss the migration that ends it `stale`, so `compileServed` refuses that
program, a `ServedRefusal` at the program whose error is `UncoveredRead`, naming the missing source, or each table and
column. Only a snapshot of a database migrated without the program's workload has one, since `grizzle generate` builds
the publication from the same workload.

**compileServed refuses a domain or a function the installation lacks.** `grizzle generate` installs the domain of
every refinement and every contract any artifact of the installation or any program of its served workload types a
value by, the pattern domain of every pattern parameter, one per parameter and pattern, and every library function they
call, and `snapshot.json` records them. A program that `compileServed` compiles names only those, so a program that
types a value by a refinement or a contract, or calls a function, that the committed workload never served is a
`ServedRefusal` at the program whose error is `UninstalledDomain` or `UninstalledFunction`, naming the contract, the
pattern, the parameter or the function, never a `type ... does not exist` from PostgreSQL. Serve the program from a
workload of the login and run `grizzle generate`, which drafts the migration that installs them.

**Direct SQL.** A direct writer, psql included, writes at SERIALIZABLE, and the guard refuses anything below it with
25000, except on a table whose every writer is certified READ COMMITTED. There it may write at any level, as the role it
writes as: it can only insert and read, and every law of the table holds at every level, a constraint PostgreSQL
checks, or a rule over a query no other write can help break. A
direct transaction of a login that fences a relation (generate's report names it) that writes the relation begins with
`LOCK TABLE ... IN EXCLUSIVE MODE` on it, before any other statement, as the fenced ChangeSets do.

**Referencing a relation another role deletes, or writes while it may miss a write: fences.** A READ COMMITTED role
may reference a relation that some role deletes, as a learner's answer references the published keys a content
replace deletes and inserts again, or that a SERIALIZABLE role inserts while it reads other calls' rows, as an import
does, when no role updates it. Its foreign key check locks the row it finds until the call commits, and every deletion
of that row waits for it. Two histories still break that check, and generate closes both by fencing the relation:

- A replace that deletes a key and inserts the same key in one transaction. A READ COMMITTED check that took its
  snapshot before the replace committed waits on the deleted row, finds it deleted, never sees the inserted one, and
  raises 23503, although the key exists before and after: a refusal no order of the calls gives. This holds for an
  identical row too: the inserted row is a new one.
- A writer that may miss another call's write (it reads other calls' rows, or writes a relation a rule over a query
  reads) inserting a key while a check looks for it. The check waits for nothing and refuses its call, which no order
  in real time explains once the writer missed a write that committed before the call began.

Every login whose roles delete such a relation fences it, and so does every login with a role that runs SERIALIZABLE,
may miss another call's write (it reads other calls' rows, makes a check of a row that can change, or writes a relation
a rule over a query reads) and writes it: each ChangeSet of the login that writes the relation begins
its transaction, as the login and before any statement takes the snapshot, with `LOCK TABLE ... IN EXCLUSIVE MODE` on
it, and `grizzle migrate` grants the login MAINTAIN on its table, the least privilege that permits the lock, and USAGE
on its schema; the drift check judges both. A READ COMMITTED check takes ROW SHARE on the table before its own
snapshot, which the lock excludes, so every check either committed before the fencing write locked, and the write's
snapshot sees the call, or takes its snapshot after the write committed. Neither history can happen, the write's check
of the rows that reference a row it deletes no longer counts against the referencing role, and generate prints each
fence it relies on. Fences cost:

- A READ COMMITTED call whose check reads the relation waits while a fencing write runs, and fencing writes of one
  relation run one at a time. Plain reads, which take no row lock, never wait.
- A deadlock, at most once per fencing write: the write locks its relations one at a time, in the order of their
  qualified names, and a READ COMMITTED call holding ROW SHARE on one of them may wait for another it locked first.
  PostgreSQL aborts one of the two with 40P01, a `TransientFailure` (`Deadlock`). No order of the lock list avoids it:
  a call takes ROW SHARE in the order its foreign key checks fire, its relation's check triggers' names, and those are
  `RI_ConstraintTrigger_c_` and the trigger's OID, compared as text, so two referencing relations can check two fenced
  relations in opposite orders.

A relation some role updates is never fenced: an update may move the key a check found, so the referencing role stays
SERIALIZABLE.

**Referencing content another role writes: publish it.** A ChangeSet that inserts rows referencing content another role
maintains (an author edits questions, a learner's answer names a question) reads that content in its foreign key
checks. If the content's writer reads other calls' rows of its own, as an import does, it runs SERIALIZABLE and its
login fences the content, so every referencing call's check waits while a content write runs, and content writes run
one at a time; a statement that reads the content keeps the referencing role SERIALIZABLE (`writers`). Publish the
keys it references instead, so the checks wait for nothing:

1. Have every role that writes the referenced content relations state `insert` on them, so a content row, once there,
   never changes.
2. Add a published relation, keyed by the content's key, with a foreign key into the content and nothing else.
3. Give it a `publisher` role of its own that states `insert` on it alone, whose ChangeSets insert published keys and
   read nothing else. It may stay SERIALIZABLE: its only reads are its foreign key checks, each of which finds an
   immutable content row.
4. Point the referencing role's foreign keys at the published relation, not at the content.

```ts
export const Question = relation("Question", { id: ItemIdentifier, prompt: Prose }, ["id"])
export const Bank = schema("Bank", [Question], [])
export const Author = role(Bank, "author", wholeEntriesOf(Bank), { insert: ["Question"] })

export const Published = relation("Published", { question: ItemIdentifier }, ["question"])
export const Answer = relation(
	"Answer",
	{ learner: ClerkUser, step: pg.bigint, question: ItemIdentifier },
	["learner", "step"]
)
export const Exam = schema.extend(
	[Bank],
	"Exam",
	[Published, Answer],
	[
		contained(on(Published, "question"), on(Question, "id")),
		contained(on(Answer, "question"), on(Published, "question"))
	]
)
export const Publisher = role(Exam, "publisher", wholeEntriesOf(Exam), { insert: ["Published"] })
export const ExamLearner = role(Exam, "learner", wholeEntriesOf(Exam), { insert: ["Answer"] })
```

The learner's check now reads `Published`, which only ever gains rows, and its one writer reads nothing another call
can write, so the check finds an immutable row or refuses the call. Publish a question before a learner may answer it.

### Races

`race(R)` among a schema's rules makes R's primary key first come, first held. The first insertion at a key holds it,
and every later insertion at that key meets the row that holds it, whatever that row holds: nothing is refused, the row
it met is in `delta.met(R)`, and the call's outcome is `accepted` or `no-change` as its other members decide. Without
`race`, a row another insertion holds is an exact repeat, which changes nothing, or that key's refusal.

- **Which tables race.** An ordinary table whose primary key has a field beside it and holds no span and no field the
  database or grizzle draws, that is neither `mutable` nor a family's owner or member. generate refuses any other
  `race` as MalformedDescription, and a `race` over a table a lower level declares as LevelRefused.
- **Adding or dropping it is a migration.** `race` changes the schema's fingerprint as `mutable` does, so generate
  drafts a migration with no SQL, which moves the installation to the new fingerprint; once it is applied, a `Db` of
  the old snapshot fails with `StaleSnapshot`.
- **Its other keys stay laws.** An insertion that would hold another of R's keys that another row holds is refused by
  that key, and the whole call with it. A `put` of R asserts its row and never races. A key held by a row outside the
  role's query entry is never met, race or not.

A claim of work, keyed by the work it claims and never searched for:

```ts
const instantKey = Symbol("Instant")
export const Instant = contract<typeof instantKey>()("Instant", pg.bigint)
/** A step, by its name in its flow, and a claimer, by its own name: its host and its process. */
const StepName = str.regex("^[0-9A-Za-z:_-]{1,96}$")
const Worker = str.regex("^[0-9a-z.-]{1,64}:[0-9]{1,10}$")
export const Step = relation("Step", { id: StepName }, ["id"])
export const Claim = relation(
	"Claim",
	{ step: StepName, attempt: natural, holder: Worker, at: Instant, ttl: pg.bigint },
	["step", "attempt"]
)
export const Finished = relation("Finished", { step: StepName, attempt: natural, holder: Worker }, [
	"step"
])
export const Work = schema(
	"Work",
	[Step, Claim, Finished],
	[
		race(Claim),
		contained(on(Claim, "step"), on(Step, "id")),
		contained(on(Claim, "step", pred("attempt")), on(Claim, "step", "attempt")),
		contained(on(Finished, "step", "attempt", "holder"), on(Claim, "step", "attempt", "holder"))
	]
)
```

- **One holder per key.** A claimer names its work by key, `(step, attempt)`, from the message that woke it or a read
  that found it, and its own name as `holder`, and inserts Claim there. Exactly one claimer of a key
  holds it; every other meets the holder's row in `delta.met(Claim)`. A claimer that sends its call again after
  `commitUnknown` meets its own row, its own holder in it.
- **Only the winner goes on.** A member that runs for the winner alone reads Claim back at the key in a later statement
  of the same ChangeSet, `holder` equal to its own, and writes from that read: a loser finds no row and writes nothing.
  generate certifies that read as the row the race fixed, where the read binds the key as the insertion bound it and
  nothing before the insertion read rows another call can write.
- **Expiry is a new fact.** A claim never changes. A reclaim inserts Claim at the next attempt from the previous
  attempt's row, read by its whole key, where `at + ttl` is before `now` (Num.add over Type.base of each); a
  claim stamps `at` with `now`, and serving both `clocked(…, { now: "micros" })` judges both ends by the database's
  clock ([The database's clock](#the-databases-clock)). Nothing revokes the earlier attempt, so two attempts' holders
  may run at once: Finished's key decides which commits, and a later commit of the step is refused by that key, nothing
  of its call written.
- **All of it is certified READ COMMITTED.** The claim, the winner's read, the reclaim and a commit fenced by
  Finished's containment into Claim each run READ COMMITTED, so none meets a serialization failure, and a lost race
  answers on its first try. Searching for work inside the claim does not: taking the next due item reads rows a
  concurrent call can add, skipping claimed items reads their absence, and allowing fewer than W running counts them,
  and each keeps its role SERIALIZABLE (`pivot`, `absence`).
- **Two races in two statements are two races.** A call that races two tables, each in its own statement, can win one
  and meet the other. It then holds the key it won, and `delta.met` says which it met. To win both or neither, put
  both keys on one row, the primary key raced and the other a key of the table, so a held other key refuses the call
  whole; or race the first and insert the second, into a table that does not race, joined with the winner's read of
  the first, so a held second key refuses the call and the first with it.
- **Deadlocks.** A call that inserts one row into each table it races never waits on another in a cycle. A call that
  inserts several rows into a table with two unique keys, or claims several keys in an order another call reverses,
  can meet a deadlock (40P01), a `transient` failure, at any isolation level.

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
  ([Limits](#limits)); `grizzle migrate` refuses a server below it. The extensions the schema needs are the
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
  its fenced writes lock it by ([READ COMMITTED writes](#read-committed-writes)). The login is LOGIN NOINHERIT and the
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
([Rules over queries](#rules-over-queries)). So the data step pays for it, once, in its own transaction: right after
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
import { roleNameOf } from "@bjornpagen/grizzle/runtime"
import { Redacted } from "effect"

export const RdsEtlLayer = DbLayer.make({
	...connection,
	login: EtlServed,
	pool: { max: 2 },
	password: Effect.tryPromise({
		try: () =>
			new Signer({
				hostname: "db.internal",
				port: 5432,
				region: "us-east-1",
				username: roleNameOf(EtlServed, connection)
			}).getAuthToken(),
		catch: (cause) => new CredentialError({ cause })
	}).pipe(Effect.map(Redacted.make))
})
```

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
([Errors and outcomes](#errors-and-outcomes)); `grizzle names` lists each hashed one with its COMMENT, which says what
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
| 23514               | a row check, a family's CHECK or a rule over a closed relation, each named by its rule; a value its contract or pattern refuses, or a code or set its roster's domain refuses, as the statement casts it, before row-level security and the row's constraints |
| 23514               | a clock stated at an instant its transaction did not stamp at its scope's key: an INSERT at the statement's end (`__clocked`), an UPDATE that moves one at COMMIT (`__clock_moved`); stamp first, `SELECT * FROM <schema>.<stamp>(ARRAY[<key>], <microseconds>)`, which `grizzle names` lists, and state the `__instant` it returns ([Instants](#instants)) |
| 23505               | at the statement: a duplicate key, over a table or over a side of one, an exact repeat included; or a key a concurrent transaction committed after this one's snapshot, which is retryable |
| 23P01               | at the statement: an overlap under a no-overlap key; or a span a concurrent transaction committed after this one's snapshot, which is retryable               |
| 23503               | a foreign key, a containment between sides included: at COMMIT when deferred (below), at the statement otherwise                                             |
| 23503, 23505, 23514 | at COMMIT, a rule over a query, a containment, a key or a check, named by the rule ([Rules over queries](#rules-over-queries))                               |
| 40001, 40P01        | a serialization failure or a deadlock: run the transaction again                                                                                             |
| 55Z03               | a write of a table a rule over a query reads, in a session that has not stood up the rule judge's tables: call the table's stand-up once in the session first, `SELECT <schema>.<stand-up>()`, which `grizzle names` lists (`__stand_<table>_…`), as a served write's session does |

- **Deferred foreign keys:** a family's key as its proof needs (a counted family's predecessor key, every last-slot
  key, an owner key a cascade feeds); a family's key a refill writes around (the owner key of every family whose
  members a refill can rewrite or whose owner a put or a delete can re-place, and the predecessor key of an ordered
  family or tree and a tree's owner key a refill rewrites); any key on a cycle of the foreign keys that order a write's
  statements, a family's owner key among them, as a containment from an owner into its members closes one; and any
  other whose target has a field that is not one of the columns it references.
- **The claims setting** is readable exactly when it has the shape a `Db` writes: a JSON object with no key repeated
  at any depth whose every member is an object of JSON strings, `{}` where it holds no fact. A setting that holds no
  document, never set in the session or empty (as a transaction's own setting is once it ends), is 22P02 with
  constraint `grizzle.claims` and DETAIL `c-`, never read as a document of no fact. Anything else, non-JSON text
  included, is 22P02 with constraint `grizzle.claims` and DETAIL `c[]`. A context's member holding other keys than exactly its fields
  is 22P02 with DETAIL `c["<Context>"]`; a member of a context the statement does not read is never judged. Each claim
  is then cast to its field's type, a closed id's claim being its handle's code: one its type refuses (not a uuid, an
  integer or a boolean) is 22P02, an integer out of range 22003, and a value its contract, pattern or roster refuses
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
  among them) is refused at stage `token`, on the host. A claim's pattern or contract is PostgreSQL's to judge, by the
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
  write of it ([Rules over queries](#rules-over-queries)). PostgreSQL gives `PUBLIC` the `TEMPORARY` privilege on every
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
  the key you submitted (one overlapping the span you submitted, for a no-overlap key), never any of its other columns.
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
  temporary tables of the session, as the judge's own definer ([Rules over queries](#rules-over-queries)).
- Nothing else: no TRUNCATE, no sequence, and no other role's view or function.

</details>

## Limits

grizzle fits applications that own their data end to end, with rules worth declaring and users who see different slices of it.

### Scope

- **PostgreSQL 19 only**, tested on the official 19.0 release, unpatched ([PostgreSQL known issues](#postgresql-known-issues)); **Node 26 or later**; **Effect 4.1**.
- **grizzle owns the database.** Existing schemas, and tables created outside its migrations, are not supported.
- **No nullable columns, outer joins, window functions, SKIP LOCKED or raw SQL at run time.** A query is written in grizzle's query language or not at all.
- **No interactive transactions and no retries.** A transaction is one call; you run a `transient` call again yourself.
- **No PgBouncer, no LISTEN/NOTIFY and no browser connections.** A browser cannot reach PostgreSQL directly; a server runs `verify`.
- **The login is the trust boundary.** Anyone with its password can act as any of its roles, with any claims.
- **Relations are closed by default**: their facts are inserted, never changed or deleted. `mutable(T)` inside a unit opens one to puts and deletes.
- **Stored derived tables are kept at COMMIT**, by the rule judge, for every writer: no job refreshes them.
- **Migrations are downtime.** No `Db` call runs while a migration is being applied.

### Values

- **No timestamp type.** When a row was written is an `instant`, stamped by the database ([Instants](#instants)); any other time is a bigint contract, and the database's clock a parameter a member binds ([The database's clock](#the-databases-clock)). A `date` holds 0001-01-01 to 9999-12-31; a lexical form has no timezone, so a timezoned `xs:date` has no typed value.
- **A span is over `integer`, `bigint`, `date` or a contract over one** (int4range, int8range, daterange), never `smallint`, which PostgreSQL has no range over. A date span's ends are `CalendarDate`s within 0001-01-01 and an excluded 9999-12-31, as an integer span's excluded end is at most its type's greatest value; its width is a `number` of days.
- **A numeric is `pg.numeric(p, s)`, `pg.numeric` or `pg.numeric.within(digits, scale)`.** `pg.numeric(p, s)` declares its precision and scale: p at most 1,000, s within ±1,000, NaN but no infinity, and at scale 0 an integer, a `bigint`, with no NaN: a cast into it is proved free of NaN, as a narrowing is proved to fit. `pg.numeric` is PostgreSQL's numeric of no typmod, every value numeric holds, NaN and the infinities among them, a `Decimal`: a field, a parameter, a contract's base or a declared function's argument or result of it passes each value as it is, never rounded to a scale nothing stated (`returns: pg.numeric` for a function whose SQL says `returns numeric`). A key over one is refused: a key needs a precision (A numeric in a key, below). A computed numeric (a sum, a mean, an operation's result, a derived field) carries the digits its computation proves, and a field of `pg.numeric.within(digits, scale)` stores one of that bound exactly, its column checked to the bound and a `Decimal` past it refused before any SQL (`numericBound`); past 131,072 integer digits, PostgreSQL's limit, it is `ResourceBound` at compile time, but over a `pg.numeric` operand, bounded by nothing but that limit, PostgreSQL enforces it, and a value past it refuses its statement with 22003, numeric_value_out_of_range. `Num.numeric(x)` is `x::numeric` of an integer, money or a float, a float to the 6 or 15 significant digits PostgreSQL writes.
- **A parse reads integer, numeric(p, s), double precision, boolean and date forms.** A numeric form has at most 255 digits either side of its point; a double's, 15 significant digits either side and an exponent of at most 293, so float8in neither overflows nor underflows. `Text.parseDouble` reads a double's text of any digits and exponent, and `Text.parseDecimal` a decimal text of any digits within 16,384 bytes, the most whose every value numeric holds. An `xs:duration` has no typed value, since PostgreSQL's interval orders 1 month as 30 days.
- **A vector's norm lies in the cosine domain, 2^-68 to 2^63**, where pgvector's single-precision `cosine_distance` is in [0, 2], never NaN, for vectors of up to 16,000 dimensions. A vector outside it is refused when it is encoded, and by its column's CHECK from any writer.

### Patterns and text

- **A `str.regex` pattern has no lookahead, lookbehind or `\p{…}` class**, nor any other construct [Tables and types](#tables-and-types) excludes, and some text must match it.
- **A pattern is bounded by what PostgreSQL's regex engine builds from it**, not by its length, and each pattern of a
  `str.and` by its own alone. grizzle reads the ARE
  it prints as PostgreSQL's parser does, and refuses with `ResourceBound`, at compile time, a pattern past one of the
  engine's own limits, which PostgreSQL would otherwise meet at the first value a domain checks, refusing every write:
  more than 16,384 colors, the classes of characters its sets hold alike (`MAX_COLOR`, halved, since parsing one set can
  split every color at once); more than 482,800 NFA states or 1,967,182 NFA arcs held at once while it compiles, a
  set's arcs counted once for each color it spans (`REG_MAX_COMPILE_SPACE`'s shares of each); an NFA whose longest path
  is more than 16,000 arcs, which the compiler's recursive walks would descend past `max_stack_depth`; more than 64,000
  NFA states to match with, or 16,000,000 for those states times its colors, the arrays each match allocates within
  `MaxAllocSize`; or more than 8 anchors it must move, those some consuming path reaches or leaves. A counted
  repetition's bound is at most 255, PostgreSQL's own, so `^.{0,n}$` holds n up to 255; a longer bound on any text is
  `str.bytes(n, ...)` or a contract's `Text.charLength`. Each `Text.pattern` and each value a `Text.matches`
  pattern term can take, a closed relation's dictionary values, is bounded alike.
- **A large pattern costs time.** A pattern near the limits takes seconds to compile, the first time a backend checks it
  and again whenever it leaves the backend's cache (below), and each match allocates arrays that grow with its states
  and colors. grizzle sets no time budget.
- **The depth limit rests on `max_stack_depth` at its default, 2MB**, a superuser's setting: `grizzle migrate` refuses
  a server set lower at stage `stack`.
- **A parameter is checked against its contract and pattern by PostgreSQL as it binds it**, its placeholder cast to its contract's domain or its own pattern domain, which `grizzle generate` installs for every pattern a served parameter names, so a query delivers a parameter's value, or a relation parameter's field, as bound. A refusal there is one round trip in, not before any SQL. A computed value not proved inside its pattern goes through the pattern's domain, which exists only for a pattern the installation declares: on a stored field, a closed relation's field, a derived table's column, a role's view column or a context field. Any other is `UnsupportedOperation` when the query compiles, naming the pattern.
- **PostgreSQL keeps a backend's last 32 compiled regular expressions** (`MAX_CACHED_RES`), so rows that cycle through a dictionary of more patterns compile one per row. On 19.0 (measured on 19rc1, whose regex cache and compiler 19.0 keeps: git diff REL_19_RC1 REL_19_0 -- src/backend/utils/adt/regexp.c src/backend/regex is empty; an Apple M-series laptop under load; 200,000 rows; dictionaries of 1 to 178 patterns; median of three runs) a row costs 1.4 to 4.9 µs grouped by pattern or cycling through 32 patterns or fewer, and 80 to 102 µs cycling through 33, 64 or 178; the CASE that reads each source's translation adds about 1 µs a row at 178. Order bulk reads and writes by pattern where you can.
- **A concatenation is at most 1 GB** (`MaxAllocSize`). A write whose check or generated field concatenates more with `Text.concat` fails with "invalid memory alloc request size". A query concatenates only texts whose types bound the result within it, and folds and equations never build theirs past it, however many parts an equation's concatenation has.
- **A search document holds at most 1,048,575 bytes of lexemes and positions** (`MAXSTRPOS`): a write whose texts make a longer document fails with "string is too long for tsvector" (54000), as a translation past its bound does. A query's match or rank reads a text within `textQueryMaxBytes`, 262,143 bytes, so no read fails on its query.
- **A translation or a regex reads at most 268,435,454 bytes**, four bytes per byte within `MaxAllocSize`. Past it, a write's check or generated field that translates fails with "requested length too large" (54000), and a check, selection or generated field that matches, a `str.regex` field's domain CHECK included, with "invalid memory alloc request size". A query translates or matches only a text its pattern bounds within the limit. `Text.lowerAscii` is no translation there: it is `lower` under the C collation, which allocates the text's own length, so a query, a check and a generated field fold any text.

### Keys and indexes

- **Every key fits its index entry for every value its fields admit, in any order of its columns**: a primary key, a declared key, a key over a selection, the UNIQUE a containment references where its target's columns are no declared key, a family's own UNIQUEs, and each family axis's UNIQUE with the copies it carries, a fold's running values among them. Each has at most 32 columns (`INDEX_MAX_KEYS`) and a B-tree entry of at most 2,704 bytes (`BTMaxItemSize`) counted from its columns' types as PostgreSQL could lay them out in any order: from the data offset, each datum after its widest alignment padding, at its longest, the whole MAXALIGNed, so whether a key fits is a function of its column set and never of the order a key, a UNIQUE or a reference lists it in. A key past either, or over a text of no byte bound, is `UnrepresentableKey` when the schema compiles, naming the relation, the key, each column's counted bytes and the fix, not PostgreSQL's 54000 at the first write.
- **grizzle never hashes a key behind your back.** A key holds every column as itself. Where one could outgrow its entry, declare a byte bound (`str.bytes(n)`) or a precision, or key by an explicit digest field you declare, a generated `Crypto.sha256(x)`, which the key then holds and reads by like any other field. A lookup that binds a text of no byte bound by equality seeks by that digest, grizzle stating `digest = Crypto.sha256(value)` wherever the rule states the text equal to a value, and rechecks the text on the rows of that digest; one with no digest to seek by is `UnrepresentableKey`, as a key is. A key that large is almost always a modelling bug: an identity is a short name, a path or a digest, never a document. (Settled: CONTRIBUTING.md "Settled decisions".)
- **A family axis carries a set by its roster's codes.** A `Monoid.concat` fold's accumulators ride its axes as themselves, so their text needs a byte bound that fits the axis's UNIQUE beside its other columns (`keyTextBytes`, and the bound a refused fold names), or the fold names their SHA-256 digests in their places ([Families](#families)). An `or` or `twos` fold's set is its roster's `bit(n)`, `n` every code the roster has minted, removed handles' included, in whole bytes, sized when `generate`, `check` or `migrate` compiles the installation, so a roster grown and pruned past about 21,000 codes refuses the UNIQUE there.
- **Every read leads an index exactly, with the fewest indexes.** Indexes come from the reads alone: each keyed read a workload program, a write or a rule's judge makes binds a set of columns by equality, and it reads through an index whose leading columns are exactly that set, in any order, or through a unique index all of whose keys it binds, never through one that holds its columns after one it leaves unbound, which would read every row of that column's values and filter the rest. A relation's sets ordered by inclusion fall into chains, each the leading columns of one index that orders its columns along the chain, and grizzle creates the fewest such indexes for the reads no key's index already serves. A range's prefix and its range column, a seek's fixed columns and its order keys, and a whole rule's unit and the rest of its lookup, lead their index in that order. Where every read needs one set, or a chain that adds one column at a time (a range, a seek), the fewest are a minimum chain cover (Dilworth's theorem, by a maximum matching); a whole rule's lookup may share an index with reads whose sets fall between its unit and the rest, and there the fewest indexes are NP-hard to find (by a reduction from colouring circular arcs), so grizzle merges the reads that ask the same, lets each read another's index serves ride it, and searches the rest exactly: the work is exponential only in the distinct reads that interleave so, never in how many ask (physical/indexes/chains.ts).
- **Each read resolves to the index that serves it.** Index planning resolves every access request, by what it asks, to the one index it landed on, a key's or one grizzle created, and a statement's plan names that index for the read it makes, its name, its method, the columns it stores and whether its scan can return them: no estimate of a table's size or of its columns' values chooses another. A request no planned index serves stops `generate` and `check` where the indexes are planned, an internal compiler error, grizzle's bug to report.
- **A stored relation's lookup by one column of no byte bound reads a hash index.** No B-tree entry holds a `bytes` value of no bound, and a stored derived relation is the installation's own inference, so a lookup of its table that binds one such column alone reads a hash index on it, whose entry is the value's 4-byte hash code: the rows it finds are the lookup's own. One that binds several such columns alone is `UnsupportedOperation` when the schema compiles, since a hash index on one of them reads every row sharing that one value. A text of no byte bound seeks by its digest, as below.
- **A keyed read no index serves is an internal compiler error.** `generate`, `check` and `upgrade` hold every statement the installation installs, and every read and write each login's served file sends, its reads of the role's views as PostgreSQL expands them into it, to the indexes the installation plans: a read at a binding no index's leading run holds, beside the columns of few values a run leaves as filters, is an internal compiler error naming the statement, the relation, its columns and the table's indexes. It is grizzle's bug, a read whose index the extraction never asked for, to report, never a scan of the table found where the file is served. A rule's judge, a stored relation's upkeep and a served write ask their equality lookups' indexes from their statements as printed, one request for each seek the check would judge, so none of theirs can miss; a served read asks from its query and the check holds it.
- **A lookup holds only the columns that fit its entry.** An index grizzle plans for a rule's probe, a workload program's equality lookup or join key, the equality prefix of a range or a prefix search, or a page holds its columns as themselves, never by an image. Where they could not all fit `BTMaxItemSize` in any order, it leaves out the columns its requests bind by equality, the widest first and a column of no byte bound widest of all, until the rest fits: each left out is a filter the read applies beside the index, and the index's comment in the drafted SQL names it (`COMMENT ON INDEX … IS 'btree index Attribute(package, name), value filtered beside it, not indexed: no byte bound fits the entry'`), so a review sees every lookup column a byte bound would bring into its index. A column it orders by or matches a prefix of stays, and an entry those still overfill is `UnrepresentableKey` naming them; a lookup left no column is refused for the widest it binds.
- **A containment's target holds a key.** A foreign key references a UNIQUE, so grizzle states a containment as one only into a side a key of its target's relation holds apart: at that key's own UNIQUE, or at one over a superkey of it, which the key implies and which must fit its index entry as above. A containment into a side no key holds apart is judged whole where it is unit-local over immutable relations or one declared unit's, and refused anywhere else ([Rules over queries](#rules-over-queries)).
- **A containment's reverse index never refuses free text.** Its probe is PostgreSQL's RI trigger's, which states the referencing columns' equalities alone, so grizzle indexes the lookup of referencing rows by a B-tree over the longest leading run of bounded referencing columns whose entry fits, or, with no such run, a hash index on one referencing column, whose entry is a 4-byte hash code. A PERIOD reference's GiST index holds the longest leading run of bounded scalars that fits a GiST page, then the span. Only the referenced UNIQUE must be bounded. With no fitting run and every referencing column of a type no hash index takes (money, a set's `bit(n)`, a vector), the containment is `UnrepresentableKey` when the schema compiles.
- **A containment's source is one table or a selection of it.** A containment whose source is a join, such as the rows of R that have a matching row in S, is not supported yet.

### Families and ChangeSets

- **A relation is a member of at most one ordered family or tree**, which orders it, and of any number of counted families ([Families](#families)). A tree is written whole, its root inserted with the tree nested and deleted by its root value. A put or a delete of a member that owns an ordered family or a tree is refused, since it would not reach the rows nested under it; a delete of a member that owns only counted families leaves their groups, which their owner axes refuse at commit where they hold members.
- **A whole delete runs first in its stratum**, after only the removals of rows that reference its rows by an immediate foreign key from outside them. A whole delete from a query that reads a relation such a removal writes is `UnsupportedOperation`: state its rows as an array, or write it in a stratum of its own with `ChangeSet.sequence`.
- **An owner inserted or put from a query cannot share a ChangeSet with appends to its counted family** (`QueriedOwnerAppend` when the ChangeSet compiles): grizzle computes the owner's final count and folds' ends from the facts the ChangeSet states, and a query's facts exist only in its statement. State the owner's facts as an array or a `Stream`, or write the owner in a ChangeSet that `ChangeSet.sequence` runs first. A write whose every fact carries a stored owner's key inserts no owner, and compiles.
- **A put names its rows by their primary key, and a delete names its rows exactly**: a delete removes a stored row only where that row equals one it states at every field a fact carries, the primary key's among them, so a row unlike the stored one at its key changes nothing ([Writes](#writes)); a tree's delete names trees by their root value instead ([Families](#families)). So no ChangeSet puts or deletes a relation whose primary key holds a field grizzle writes, such as a sequence member keyed by its owner and drawn index. A put also compares its facts at every declared key, so a declared key over such a field refuses puts but not deletes. Such a write is a type error, and from JavaScript `UnstatedKey` when the ChangeSet compiles, naming the key. Key such a member by a field its caller writes, such as an id, declare no key over a field grizzle writes, and insert a sequence nested under its owner.

### Sizes

`messageMaxBytes`, `maxStringLength`, `bytesMaxLength`, `flightMaxBytes`, `regexMaxRepeat` and `regexTextMaxBytes` are exported as `Limit` values, whose `.value` is the number.

- **A `bytes` value is at most 1,073,741,819 bytes** (`bytesMaxLength`), PostgreSQL's longest bytea. A longer one is `EncodingFailure` before any SQL. It is read back in chunks of 16 MiB, one result row each, a write reads back only its SHA-256 digest, and a column's array of bytes values is sent in binary, bounded by the message alone: one copy of each value, made as the call is sent, after its member is measured from its values' lengths. A nested write's rows of one relation are no statement's bound: where their arrays would make the statement that writes them longer than one Bind message, the call empties a temporary table its session stood up for the write, fills it with consecutive chunks of the rows, each as long as one Bind message carries, and runs the statement once over it, so what it writes and what its laws judge are one statement's.
- **A statement's parameters are at most 1,073,741,822 bytes** (`messageMaxBytes`, PostgreSQL's `PQ_LARGE_MESSAGE_LIMIT`), **and an input column's array literal at most 536,870,888 UTF-16 code units** (`maxStringLength`, V8's longest string, 2^29 − 24). A relation input is one array per column, sent again to each statement that reads it. A call past either bound is `InputTooLarge` before anything is sent.
- **A call's flight is at most 1,908,342,784 bytes** (`flightMaxBytes`): every message the driver writes for it, its statements' texts and parameters among them, in the one write a round trip is. Node hands that write to one `SSL_write`, whose length is a C int, and its ciphertext to one send, which macOS refuses past 2,147,483,647 bytes, so the bound is the whole TLS 1.2 records whose largest ciphertext fits one send. A longer flight is `InputTooLarge` (`flight`) before any byte is written: grizzle never splits a call into more round trips, so split the input across calls. Without the bound such a write fails whole, the connection ends with a transaction open, and a write would report `CommitLost` though nothing committed.
- **A statement's Parse message is at most 1,073,741,822 bytes** (`messageMaxBytes`): its text and 8 bytes of fields, as the driver writes it. A longer one is `InputTooLarge` (`parse`) before any byte of its flight is written, where the server would end the connection at it.
- **A generated text is at most 536,870,888 UTF-16 code units**, about 512 MiB of ASCII: each SQL statement, migration file, `snapshot.json` and fingerprint text. `generate` and `check` refuse a schema past it with `ResourceBound`.
- **A generated file is at most 52,428,800 bytes** (50 MiB, GitHub's warning size): `manifest.json` and a migration folder's files are written in parts within it, and `snapshot.json`, a served file or an OpenAPI document past it is `FileTooLarge` ([Migrations](#migrations)).
- **A closed relation is as large as its key's code space**: a cell per combination of its key fields' codes, written in its migration as one hex literal of a digit per four bits of code space times its cell's bits, whatever its rows. Prefer dense coordinates, such as slots, whose space is each owner's counts, to a sparse product of rosters ([Closed relations](#closed-relations)). Its constant has at most 2,147,483,640 bits, PostgreSQL's longest bit string, payload codes whose product is at most 2,147,483,647, the most a cell read as an integer holds, and a literal of at most 536,870,888 digits. Past any, the schema is `ResourceBound` when it compiles, the literal's as `stringLength`. `grizzle check` refuses a literal its comment or its function's name does not digest, naming the first cell that differs from the declared rows, and that cell's key.
- **PostgreSQL's own limits are `ResourceBound` where grizzle emits what they bound**: a table's 1,600 columns, a relation's generated rule columns included (checked when its schema compiles), as for a view, a derived table or a write's temporary table; a select list's 1,664 entries; and a statement's 1,073,741,822 bytes and 65,535 parameters (a 16-bit count). Dropped columns count toward the 1,600, so PostgreSQL itself refuses an added column past them. A row must fit one 8 KB heap page once its long values are stored out of line, which PostgreSQL checks when it writes the row.
- **A window's size is any safe integer of at least 1**, bound as a bigint: there is no largest.

## PostgreSQL known issues

**Imprecise GiST indexes over multibyte text.** Through PostgreSQL 19, btree_gist prices a UTF8 text key by the byte after the common prefix of its subtree's bounds, cut at a character boundary, so characters that share leading bytes, such as the CJK Unified Ideographs, price alike, and a GiST index led by such text is imprecise: a point lookup takes 14 buffers for one row of 20,000 two-ideograph keys, where ASCII keys take 3. grizzle builds such an index only for a no-overlap key or a span filter whose text field comes first. It stays valid; only its lookups cost more. PostgreSQL's master branch fixes this in commit b82d69abf6, for PostgreSQL 20, where the lookup takes 3 buffers; rebuild an older index there. No PostgreSQL 19 release carries it (a request to back-patch it is drafted, not filed, in [upstream/btree-gist-multibyte-penalty](upstream/btree-gist-multibyte-penalty)), and grizzle's tests run on the unpatched release, so the indexes the test suite builds pay this cost too.

**CHECKs and generated columns re-planned per statement.** PostgreSQL 19 parses and plans every CHECK and stored generation expression again in each statement that writes its table: it reads each literal back from the stored expression a byte at a time and evaluates each IMMUTABLE function the expression calls, copying the value in. Counted in user-mode instructions of the writing backend on 19.0, a literal costs a statement about 207 instructions a byte, and a call of a constant about 7,800 plus 0.83 a byte of its value; before grizzle answered it, each INSERT statement into qti's interaction_attribute table paid 90.6 million instructions for its CHECKs and generations, its attribute table 35.0 million. grizzle installs each CHECK and stored generation that calls a constant of the installation's data, a closed relation's, a roster's or a dictionary's ([Closed relations](#closed-relations)), that matches a pattern, or whose literals hold more than 21 bytes of text or bits together, as a row function: a PL/pgSQL function of the columns it reads, named by its definition's digest, which each backend plans once with the constants folded in, and the CHECK or the column calls it. A statement then pays the call once a row, about 4,400 instructions, where it paid the literals and the constants once a statement, so a statement of many rows into a table of many such expressions pays more than it did: qti's interaction_attribute, 72 calls a row, breaks even near 300 rows a statement. Planning CHECKs once per relcache entry, as PostgreSQL plans index expressions and domain checks, would remove both costs: a change of grizzle's own that no PostgreSQL release carries ([upstream/relcache-planned-check-and-generation](upstream/relcache-planned-check-and-generation)). A roster's domain is unaffected: a domain's check is planned once per backend. Only the cost differs, never the behaviour.

**PL/pgSQL functions with many IFs or CASE arms compile in quadratic time, unless each statement is one line.** PL/pgSQL learns an IF's, an ELSIF's and a CASE WHEN's line number after its body's statements have asked for theirs, and PostgreSQL 19 rescans the function's source from its start whenever a location lies on a line before the one it last resolved, so a function of N such statements written over lines compiles in O(N x length), at CREATE FUNCTION and again at its first call in each backend: one CASE of 40,000 arms takes about 17 s. grizzle prints every statement of a PL/pgSQL block on one line, its body with it, and spells a string constant that holds a line feed as an escape string, so no location goes back but the block's own BEGIN, and its law functions compile in time linear in their length: qti's largest, 4.3 MB of 1,764 IF and ELSIF branches, resolves its lines in one walk of its source, where printed over lines it rescanned 2.3 GB. Recording where each line starts once and finding a location's line by binary search would fix it for every function, with the same line numbers: a change of grizzle's own that no PostgreSQL release carries, prepared for pgsql-hackers in [upstream/plpgsql-lineno-rescan](upstream/plpgsql-lineno-rescan) and not yet sent.

**A BEFORE UPDATE row trigger costs every row of an UPDATE, even disabled.** Through PostgreSQL 19, an UPDATE of a table with a `BEFORE UPDATE` row trigger locks each row before it updates it, a lock record in the WAL and the lock left on the new row version, computes every stored generated column whatever the UPDATE assigns, and keeps about 41 bytes of executor memory a row until the statement ends; an `INSERT … ON CONFLICT DO UPDATE` keeps the same for each row it updates, with no trigger at all: 4 MB a 100,000 rows. A trigger disabled by `ALTER TABLE … DISABLE TRIGGER` costs all of it, since PostgreSQL still marks the table as having one: on 19.0 a disabled one made an UPDATE of 100,000 rows compute 100,000 generation expressions it needed none of, write 5.6 MB more WAL and take 730 ms where 450 ms sufficed. grizzle's immutability guard is such a trigger ([Tables and types](#tables-and-types)), so a migration's data steps drop it and create it again after them, never disable it ([Migrations](#migrations)), and meet none of this; a write's in-place rewrite of an immutable table and its inserts that meet stored rows `ON CONFLICT DO UPDATE` pay the memory. Two fixes are prepared and not sent: keeping the per-row memory in the per-tuple context, a reply to the 2023 pgsql-hackers thread that fixed its sibling ([upstream/update-lock-mode-key-columns](upstream/update-lock-mode-key-columns)), and letting a disabled trigger mark nothing, a new thread ([upstream/disabled-trigger-hint-flags](upstream/disabled-trigger-hint-flags)). Only the cost differs, never the behaviour.

## Status

grizzle is not published: you take a commit of this repository ([Install](#install)). 1.0.0-beta.1, the first public beta, stays on npm under the `beta` tag, and no later release goes there. grizzle is tested against the official PostgreSQL 19.0 release, unpatched, as hosted providers build it. The test suite runs on Linux against that pinned build.

There are no stability guarantees. Every release is a hard cutover, with no deprecations and no compatibility path for the API, snapshots or migration files.

## Development

Everything runs natively on Linux, with no Docker. There is no build step: Node runs each package's `src/*.ts` directly, and each package's `exports` and `bin` name its `src/` modules, so the repository and every consumer resolve the packages' names to the source.

```sh
git submodule update --init       # the toolchain, vendor/toolchain: the dev tools and the testing library
pnpm install
pnpm pg:build                     # build the pinned PostgreSQL 19.0 from its release tarball, and pgvector
pnpm pg settle                    # start the local cluster's units and give them pg.config.ts: verify-full TLS from 5442
pnpm pg check                     # read every member as a run reads it, writing nothing
pnpm test                         # the unit and types tiers, which need no network
pnpm test:network                 # the pg and schedules tiers, against the local cluster
pnpm test:cli-generator           # the CLI generator's properties, its grizzle tier against the local cluster
pnpm test:properties <file | id>  # some modules or properties
pnpm types                        # after every edit: the typecheck, which the hooks run too
pnpm check                        # before a release (turbo, cached): typecheck, workspace gate, oxlint, format, fallow, dedupe
```

Every script and test reaches one local cluster, `pg.config.ts`, whose members are the workbench's PostgreSQL units `postgres@grizzle-test-<key>-<i>`, a family a checkout: a run's workers hold the family and bring up the members they reach, each settled to the spec where it is not, its members spread over a run's workers, each admitting as many connections as the machine's memory holds of busy backends, and each member stops once the last process holding the family has ended, however it ended. Nothing admits or queues a run's connections.

`pnpm pg:build` builds the PostgreSQL the machine's units run (the workbench's `machine/parts/postgresql` installs it); end what holds its clusters (a run's workers, a `pg-held` command) before an exchange: a cluster runs only while it is held, the workbench starts none unheld (beefy da1e9fc), and the next holder starts it on the new binaries.

Every generated suite draws from one seed, `TEST_SEED`, which a run prints first. Setting it reproduces a run, and whether a suite reaches what it requires never depends on it. [CONTRIBUTING.md](CONTRIBUTING.md) has the code rules and how the tests are built on the testing library.

## Repository

- `packages/text/`: `@bjornpagen/grizzle-text`, the text primitives and the one regex engine the engine and grizzle stand on, dependency-free and browser-safe.
- `packages/engine/`: `@bjornpagen/grizzle-engine`, the compiler: schemas, roles, rules, queries and ChangeSets to SQL, the migration drafter and the snapshot.
- `packages/openapi/`: `@bjornpagen/grizzle-openapi`, a login's OpenAPI 3.2 document, the one owner of its format: its writer, which `grizzle generate` and `grizzle check` run over the login's served file, and its reader, browser-safe, which the client reads the login's wire back from.
- `packages/grizzle/`: `@bjornpagen/grizzle`, which re-exports the engine's API and adds:
    - `src/adapter/`: the runtime over node-postgres in pipeline mode: `Db.open`, a member's `once` and `watch`, reads, writes, windows, `migrate` and `drift`.
    - `src/cli/`: the `grizzle` command line.
    - `skills/grizzle/`: the agent guide.
- `test/`: the unit, pg, schedules and types tiers, and their support in `test/support/`.
- `bench/`: performance gates.
- `scripts/pg/`: the pinned PostgreSQL's pin, source and build, whose commands the `grizzle-pg` bin runs.
- `packages/cli-generator/`: `@bjornpagen/grizzle-cli-generator`, the CLI generator: an OpenAPI 3.0, 3.1 or 3.2 document, a login's among them, to a standalone Effect CLI ([CLIs for logins](#clis-for-logins)). Nothing imports it.
- `packages/pg/`: `@bjornpagen/grizzle-pg`, the TypeScript those commands run: the pin, as a typed value, and the postmasters that run an installed build.
- `pg.config.ts`: the local cluster the tests and benchmarks reach, its port, template and sizes, which the testing library makes and runs.
- `scripts/dev/`: the mutation tester and the profiler.
- `vendor/toolchain/`: the [toolchain](https://github.com/bjornpagen/toolchain), a git submodule pinned by commit, whose packages join the workspace: `@bjornpagen/devtools`, the lint tooling (the oxlint preset and plugin, the workspace gate, the hooks' gate), which `toolchain.config.ts` and `oxlint.config.ts` configure, and `@bjornpagen/testing`, the testing library every test runs on, with `pnpm fuzz`'s script.

## License

[0BSD](LICENSE).
