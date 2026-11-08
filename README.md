# grizzle

The relational model as a TypeScript API, compiled into PostgreSQL.

Your data has rules. Kept in app code, they hold only where that code remembers them, and only for that code. grizzle
moves them into the database. You declare relations, the laws they obey, what each kind of user may
see, and the queries and writes your app runs; grizzle compiles them into PostgreSQL 19's own domains, keys, foreign
keys, CHECKs, roles, views, row-level security policies and indexes. PostgreSQL then enforces every rule for your app,
your scripts and psql alike. Every query's result type follows from the query, every call is one SERIALIZABLE
transaction, and every failure is a typed value: a broken rule comes back naming the rule.

[Install](#install) · [Example](#example) · [Agent guide](packages/grizzle/skills/grizzle/SKILL.md) ·
[Contributing](CONTRIBUTING.md) · [npm](https://www.npmjs.com/package/@bjornpagen/grizzle)

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
  proved by PostgreSQL's constraints, and a rollup is a query PostgreSQL stores as a materialized view.

grizzle makes that model the API, and compiles it into PostgreSQL so that PostgreSQL enforces it for every writer, not
only your app. Each rule becomes one of PostgreSQL's own constraints, never a trigger. Each role becomes a PostgreSQL
role that reads through views of its own, under row-level security where it writes only some rows.

Every call is one SERIALIZABLE transaction, its statements pipelined into one round trip, or two when a write must
first read stored values it builds on. There are no interactive transactions to hold open: a read that decides a write
is a query inside the write. The first migration makes SERIALIZABLE the database's default, and a write below it on a
grizzle table is refused, so psql and scripts get the same isolation. Every failure is typed: a broken rule is an
outcome that names the rule, and anything else is a tagged error. A `TransientFailure` changed nothing, and grizzle
never retries: whether to run it again is your code's decision.

Drizzle is a good typed SQL builder, thin by design: what you write is close to what runs. Its limits are those of the
storage view. A rule beyond keys, foreign keys and single-row CHECKs is a trigger you write in a custom migration, or a
check in app code that other writers skip and concurrent requests race past. Row-level security is policies whose
conditions are SQL strings, and a query that outgrows the builder becomes `` sql`…` `` with a result type you write by
hand. [Hard in Drizzle, one declaration here](#hard-in-drizzle-one-declaration-here) takes eight such cases one at a
time.

|                          | With Drizzle                                                    | With grizzle                                                                          |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Tables                   | `pgTable(...)`, nullable unless `.notNull()`                    | `relation(...)`, every field required                                                 |
| Rules beyond FK, unique  | `check()` on one row; triggers in custom migrations; app code   | declared beside the relations, compiled to PostgreSQL's own constraints               |
| Who sees which rows      | `where` clauses in app code, or `pgPolicy` with SQL conditions  | roles declared in TypeScript, compiled to roles, views, grants and row-level security |
| Complex queries          | often `` sql`…` `` with a hand-written result type              | one query language, every result type inferred, nested results included               |
| Indexes                  | declared by hand                                                | derived from your rules and from the queries your app runs                            |
| Transactions             | interactive, at the isolation level you pick                    | one SERIALIZABLE transaction per call, pipelined                                      |
| Migrations               | drizzle-kit generates SQL from your schema changes, or pushes them | `grizzle generate` drafts SQL that you review and commit; nothing is pushed        |

grizzle is opinionated in return. It runs on PostgreSQL 19 only, tested on 19rc1 with the two patches under
[PostgreSQL known issues](#postgresql-known-issues), and it owns its database: existing schemas, and tables created
outside its migrations, are not supported. There are no nullable columns, outer joins, window functions, interactive
transactions or raw SQL at run time. Read [Limits](#limits) before you adopt it.

## The relational model, by feel

Here is a small blog for organizations that sign in through Clerk: posts, their comments, view counts, and the query a
post's page runs. Every `ts` block on this page typechecks in grizzle's test suite. This section reads the blog one
idea at a time.

```ts
import { closed, closedId, contained, on, pg, query, relation, schema, str, uuid, v } from "@bjornpagen/grizzle"

const ClerkUser = str.regex("^user_[0-9A-Za-z]{1,64}$")
const ClerkOrg = str.regex("^org_[0-9A-Za-z]{1,64}$")
const Title = str.regex("^.{1,200}$", "su")
const Prose = str.regex("^.*$", "su")

export const Status = closed("Status", ["Draft", "Published"])
export const Post = relation(
	"Post",
	{
		id: uuid,
		org: ClerkOrg,
		author: ClerkUser,
		title: Title,
		body: Prose,
		status: closedId(Status)
	},
	["id"]
)
export const Comment = relation(
	"Comment",
	{ id: uuid, post: uuid, author: ClerkUser, body: Prose },
	["id"]
)
export const PostViews = relation("PostViews", { post: uuid, views: pg.bigint }, ["post"])

export const Blog = schema("Blog", { Status, Post, Comment, PostViews }, [
	contained(on(Comment, "post"), on(Post, "id")),
	contained(on(PostViews, "post"), on(Post, "id"))
])

/** A published post by its id, with its comments nested inside it. */
export const postPage = query(Blog)
	.rule((r) => {
		const { id, title, body } = v(Post, "post")
		return r
			.match(Post, { id, title, body, status: "Published" })
			.where(r.eq(id, r.param("id", uuid)))
			.find({ id, title, body })
	})
	.attach(
		"comments",
		(post) =>
			query(Blog).rule((r) => {
				const { id, author, body } = v(Comment, "comment")
				return r.match(Comment, { id, post: post.id, author, body }).find({ id, author, body })
			}),
		"array"
	)
```

Three relations, a roster of statuses, two rules and one query.

### Relations hold facts

`relation(name, fields, primaryKey)` declares a relation, and `schema(name, relations, rules)` gathers relations and
the rules between them into one PostgreSQL schema. Each `Post` row is a fact: this post exists, in this organization,
by this author, with this title, body and status. Three things follow:

- **Every field is required.** There are no nullable columns. A post that has never been viewed has no `PostViews` row,
  and one that has been viewed has exactly one: a value that may be missing is a fact that may be missing.
- **A relation is a set.** A fact inserted twice is one fact, and a write that changes nothing answers `no-change`.
- **Facts are inserted and deleted, not edited in place.** A relation is immutable by default, and no role holds
  UPDATE on it. A `put` states the fact that holds at a key afterwards, which is what an update means. Declaring
  `mutable(Post)` among the rules changes how a put is carried out, never what it means.

### Types are sets of values

A field's type is the set of values it admits, and PostgreSQL checks it on every write, whoever writes.

- **Text always carries a pattern.** `ClerkOrg` admits `org_` followed by 1 to 64 ASCII letters or digits, so no writer stores
  `"acme"` as an organization. Its TypeScript type is the pattern's language: `string` here, and `"yes" | "no"` for
  `^(yes|no)$`.
- **A `uuid` field holds a `Uuid`**, a uuid's hyphenated spelling as a type: a uuid literal or `crypto.randomUUID()` is
  one as it is, and a plain string becomes one through `Uuid.parse`.
- **Integers keep their width.** `pg.bigint` is a `bigint` in TypeScript, never a `number` that rounds past 2^53.
- **`closedId(Status)`** holds one of `Status`'s handles: `"Draft" | "Published"` in TypeScript, a smallint code in
  PostgreSQL.

[Tables and types](#tables-and-types) lists every type with its PostgreSQL and TypeScript forms.

### Keys and containment

A key says which facts are one thing. The third argument of `relation` is the primary key: no two posts share an `id`,
and no two `PostViews` rows share a `post`, so a post has at most one view count. `key(on(Post, "org", "title"))`
would declare another: no two posts of one organization share a title.

A containment says one set of values lies inside another. `contained(on(Comment, "post"), on(Post, "id"))` reads
"every comment's `post` is some post's `id`": a foreign key, written as the inclusion it is. The same shape relates a
selection of rows, a closed relation, or spans covered by spans ([Rules](#rules)).

This is what `grizzle generate` installs for `Post` and that containment, abridged:

```sql
CREATE DOMAIN "blog"."status" AS smallint CONSTRAINT "check" CHECK (VALUE IS NULL OR (("blog"."__status_names_6zfckdmtul"())[VALUE + 1] <> ''::"pg_catalog"."name") IS TRUE);

CREATE DOMAIN "blog"."__text_ucvpb5bhvu" AS "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" CONSTRAINT "check" CHECK (VALUE IS NULL OR (VALUE ~ '\A[\u0001-\U0010FFFF]{1,200}\Z'::"pg_catalog"."text") IS TRUE);

CREATE TABLE "blog"."post" (
  "id" "pg_catalog"."uuid" NOT NULL,
  "org" "blog"."__text_t2hbrv4zer" NOT NULL,
  "author" "blog"."__text_u2zmp7otto" NOT NULL,
  "title" "blog"."__text_ucvpb5bhvu" NOT NULL,
  "body" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  "status" "blog"."status" NOT NULL,
  CONSTRAINT "__post_pk_dyy23qj6j2" PRIMARY KEY ("id")
);

ALTER TABLE "blog"."comment" ADD CONSTRAINT "__comment_fk_post_264gmiavub" FOREIGN KEY ("post") REFERENCES "blog"."post" ("id") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
```

Every column is NOT NULL. Each pattern is a domain, one per distinct pattern, so `post.author` and `comment.author`
share one. `Title`'s pattern reaches PostgreSQL spelled for its regex engine, and `Prose` admits every text, so its
column is plain `text`. The roster is a smallint domain over a function returning its names. The foreign key is deferred to COMMIT, so a write is judged on the state it leaves, not
statement by statement. All of it is PostgreSQL's own, so psql meets it as your app does:

```sql
-- psql, as a role that may write blog.comment
INSERT INTO blog.comment (id, post, author, body)
VALUES (gen_random_uuid(), gen_random_uuid(), 'user_1', 'First!');
-- 23503 at COMMIT: no post has that id
```

### Checks and closed relations

`Status` is a relation too. `closed("Status", ["Draft", "Published"])` is a roster: a closed relation of one field,
`id`, whose rows the schema fixes. It stands among `Blog`'s relations, a query matches it like any table, and
`closedId(Status)` refers into it. Each handle has a code, 0 … n − 1 in declared order. The API reads and writes names,
and the table stores codes under a domain that admits only live handles. Codes are history: an added handle takes the
next code, a removed one leaves its code unused, and a reorder is refused ([Migrations](#migrations)).

A closed relation can carry data too. Here is a price list for the blog's organizations, and two rules that tie it to
the blog:

```ts
import { check, natural } from "@bjornpagen/grizzle"

/** The plans an organization can be on, and the seats each allows: rows the schema fixes. */
export const Plan = closed("Plan", ["Free", "Team"])
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
export const Billing = schema.extend(Blog, { Plan, PlanLimits, Subscription }, [
	contained(on(Post, "org"), on(Subscription, "org")),
	check("WithinPlan", Subscription, (s) => s.le(s.seats, PlanLimits.at("seats", s.plan)))
])
```

`schema.extend` builds on `Blog`: all of its relations and rules, three relations more and two rules more. `natural` is
a count, a `bigint` that is never negative.

- **`contained(on(Post, "org"), on(Subscription, "org"))`**: an organization posts only once it has a subscription. A
  containment's target is a key, here `Subscription`'s primary key.
- **`check("WithinPlan", Subscription, ...)`**: a check is a condition every fact of one relation meets, written over
  its fields, as in `(s) => s.seats.ge(1n)`. This one reads the price list: `PlanLimits.at("seats", s.plan)` is the
  seats of the subscription's plan.

`PlanLimits` has no table. Its rows become IMMUTABLE constants, which PostgreSQL folds into every statement that reads
them, and `WithinPlan` becomes a CHECK that reads them. Abridged from `grizzle generate`:

```sql
CREATE FUNCTION "blog"."__constant_votvjyxb73"() RETURNS bigint[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN '{"1","50"}'::bigint[];

CREATE TABLE "blog"."subscription" (
  "org" "blog"."__text_t2hbrv4zer" NOT NULL,
  "plan" "blog"."plan" NOT NULL,
  "seats" "blog"."__domain_gfw43vigph" NOT NULL,
  CONSTRAINT "__subscription_pk_ji5ktre5v6" PRIMARY KEY ("org"),
  CONSTRAINT "within_plan" CHECK (("seats" <= ("blog"."__constant_votvjyxb73"())[NULLIF("pg_catalog"."substring"("blog"."__constant_ab5qkascpx"(), "plan" * 2 + 1, 2)::integer, 0) - 1 + 1]) IS TRUE)
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
  readonly id: Uuid
  readonly title: string
  readonly body: string
  readonly comments: ReadonlyArray<{ readonly id: Uuid; readonly author: string; readonly body: string }>
}
```

Nothing there is annotated by hand. grizzle also knows each result's keys. `postPage` fixes `id`, `Post`'s key, to its
one parameter, `id: Uuid`, so it returns at most one row, and `db.get(postPage, { id })` returns an `Option` of that
row; on a query that can return several rows, `db.get` is a type error. An aggregate is typed as PostgreSQL computes
it: `r.count()` is a `bigint`, and the `r.sum` of a bigint is an exact `Decimal`. Negation is
`r.not(Comment, { post: id })`, a union is a second `.rule(...)`, and there is no `` sql`…` `` to fall back to.
[Queries](#queries) has the whole language.

### A write moves between lawful states

A write is a ChangeSet: the facts to insert, delete and put, applied as one transaction. A `Db`, the handle you read and
write through, always acts as a role, and `Admin` holds all of `Billing` (the first case below is about roles that see
less):

```ts
import {
	ChangeSet,
	Db,
	type Fact,
	role,
	wholeEntriesOf,
	writableNamesOf
} from "@bjornpagen/grizzle"

/** A role that reads all of Billing and writes every relation in it but the closed ones. */
export const Admin = role(Billing, "admin", wholeEntriesOf(Billing), {
	write: writableNamesOf(Billing)
})

/** An organization's subscription and its first post: one write, judged as a whole. */
export const launch = (
	db: Db<typeof Admin, unknown>,
	subscription: Fact<typeof Subscription>,
	post: Fact<typeof Post>
) =>
	db.apply(ChangeSet.empty(Billing).insert(Subscription, [subscription]).insert(Post, [post]), {})
```

`db.apply` sends the ChangeSet as one SERIALIZABLE transaction and answers with an outcome you match on: `accepted`,
`no-change`, `invariant-rejected` or `outside-world`. The subscription and the post go in together, in either order:
the post's containment in `Subscription` is decided at COMMIT, on the state the write leaves, and a post for an
organization with no subscription is refused on it. Launch `org_2abc` on the Free plan with 5 seats, and nothing
changes. The answer is:

```text
{
  kind: "invariant-rejected",
  refused: { kind: "every", laws: [{ kind: "check", relation: "Subscription", name: "WithinPlan" }] },
  witness: { kind: "key", relation: "Subscription", values: { org: "org_2abc" } }
}
```

`refused.laws` names each broken rule as you declared it, never as a message to parse, so
`law.kind === "check" && law.name === "WithinPlan"` recognizes this one. `every` means grizzle judged each rule named
there broken, and the witness is the key of the fact that broke it. psql gets the same refusal from PostgreSQL, SQLSTATE
23514 on the constraint `within_plan`.

An error is something else. A dropped connection or a serialization failure fails the Effect with a tagged error. A
`TransientFailure` changed nothing, so your code may run the write again; grizzle never does. [Errors and outcomes](#errors-and-outcomes)
lists every outcome and error.

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
8. [A usage page: cursors, a rollup and their indexes](#8-a-usage-page-cursors-a-rollup-and-their-indexes): indexes nothing ties to their queries.

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

**The reframe.** "This organization's keys" is not a filter you add to queries. It is a relation: the keys whose `org` is the caller's. What a role may see is itself a query, so write it once and make it the table the dashboard calls `ApiKey`. Three declarations say it:

- **A `context`** is a claim of the caller's verified session token, which a query reads as a table of at most one row. `Tenant` holds the token's `org`.
- **A `role`** is what one kind of user sees, laid out as tables. Each entry is a table of the schema, whole, or a query over it, and `write` lists the entries the role may write. `KeyAdmin`'s `ApiKey` is the query `orgKeys`: the keys whose `org` matches `Tenant`'s.
- **A `login`** is one PostgreSQL user, with its password and its own connection pool, that can act as the roles it lists.

**The declaration.**

```ts
import { context, login, role } from "@bjornpagen/grizzle"

export const ApiKey = relation("ApiKey", { id: uuid, org: ClerkOrg, name: Title }, ["id"])
export const Keys = schema("Keys", { ApiKey }, [])

/** The caller's organization: the `org` claim of their verified session token. */
export const Tenant = context("Tenant", { org: ClerkOrg })

/** The keys of the caller's organization. An insert takes `org` from the token. */
export const orgKeys = query(Keys).rule((r) => {
	const { id, org, name } = v(ApiKey, "apiKey")
	return r.match(ApiKey, { id, org, name }).match(Tenant, { org }).find({ id, name })
})

export const KeyAdmin = role(Keys, "key_admin", { ApiKey: orgKeys }, { write: ["ApiKey"] })
export const Dashboard = login(Keys, "dashboard", [KeyAdmin])
```

**What you get.** The dashboard's queries and writes are written over `KeyAdmin`, where `ApiKey` already means "this organization's keys", with rows `{ id: Uuid; name: string }`. There is no `where` to forget and no `org` to pass. `orgKeys` fixes `org` to the claim, so inserting `{ id, name }` stores the caller's organization.

Another organization's keys don't exist for this role: deleting one does nothing, and an insert at an `id` one already holds is `invariant-rejected` on the primary key, its witness the `id` you submitted, never the other row. `Db.open(Dashboard.roles.key_admin, ...)` doesn't compile without a token, and opening runs your `verify` function on it once.

grizzle installs `KeyAdmin` as a PostgreSQL role that reads through a view in its own schema and writes the table under row-level security. The rule lives in PostgreSQL, so psql meets it too:

```sql
-- psql, logged in as the login keys__dashboard
SET ROLE keys__key_admin;
BEGIN;
SELECT set_config('grizzle.claims', '{"Tenant":{"org":"org_2abc"}}', true);
SELECT id, name FROM keys__key_admin.api_key;                                     -- org_2abc's keys only
INSERT INTO keys.api_key (id, org, name) VALUES (gen_random_uuid(), 'org_9xyz', 'x');  -- 42501
```

What `grizzle generate` installs for it, abridged; each `…` is generated SQL that reads the token's claims:

```sql
CREATE ROLE "keys__key_admin" NOLOGIN;
CREATE SCHEMA "keys__key_admin";
CREATE VIEW "keys__key_admin"."api_key" ("id", "name") WITH (security_barrier) AS …;
CREATE POLICY "keys__key_admin" ON "keys"."api_key" AS PERMISSIVE FOR ALL TO "keys__key_admin"
  USING (…)
  WITH CHECK (…);
ALTER TABLE "keys"."api_key" ENABLE ROW LEVEL SECURITY;
GRANT SELECT ("id", "org", "name") ON TABLE "keys"."api_key" TO "keys__key_admin";
GRANT INSERT ("id", "org", "name") ON TABLE "keys"."api_key" TO "keys__key_admin";
GRANT DELETE ON TABLE "keys"."api_key" TO "keys__key_admin";
```

The view is a security-barrier view, so its filter runs before anything that could fail on a row outside it. The login holds no table privilege of its own: it can only switch to its roles. That makes the login the trust boundary. Whoever holds its password can act as any of its roles with any claims, so give each trust domain its own login ([Security model](#security-model)). The [example](#example) builds roles, logins and Clerk tokens in full.

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

**The reframe.** A query is a set expression, and its result type follows from it. "Each workspace's spend" is a rule with an aggregate. "Its three costliest models" is a second query nested in each row, ordered and cut to three. "Not refunded" is a negation: the calls for which no `Refund` row exists, since a refund is a fact in a table of its own, not a nullable column on the call. grizzle reads the expression instead of sending a string, so the row type follows from it: PostgreSQL's `count` is a bigint and its `sum` of a bigint a numeric, and the type says so.

The amounts are contracts. **A `contract`** is a named type over a base type, with an optional check, installed as a PostgreSQL domain that every writer meets. `Micros` is a bigint that is never negative. `Millis` adds no check, but is a type of its own, so an instant is never compared with an amount. `Micros(0n)` makes a value of one: it brands the value without checking it, and the database checks it on every write.

**The declaration.**

```ts
import { contract } from "@bjornpagen/grizzle"

/** Millionths of a dollar, never negative; and an instant, in milliseconds since the epoch. */
const Micros = contract("Micros", pg.bigint, (m) => m.ge(0n))
const Millis = contract("Millis", pg.bigint)

/** One API call: its workspace, its model, when it ran and what it cost. */
export const Call = relation(
	"Call",
	{ id: uuid, workspace: uuid, model: Title, at: Millis, cost: Micros },
	["id"]
)
export const Refund = relation("Refund", { call: uuid }, ["call"])
export const Usage = schema("Usage", { Call, Refund }, [
	contained(on(Refund, "call"), on(Call, "id"))
])

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
  readonly workspace: Uuid
  readonly spend: Decimal
  readonly models: ReadonlyArray<{ readonly model: string; readonly calls: bigint; readonly spend: Decimal }>
}
```

`calls` is a `bigint` and `spend` an exact `Decimal` at both levels, because that's what PostgreSQL computes. `.attach("models", (w) => ..., "array")` nests the child query in each row, and `w.workspace` is the parent row's value. `.orderBy(["spend", "desc"]).take(3)` keeps each workspace's three costliest models, and they arrive in that order, ties broken by `model`, the child query's key, which grizzle adds to the order because it knows the key.

Both levels match each call's `id`, though neither returns it. A query is a set, so an aggregate reads each row it matches once, by its key: two calls of one model and one cost are two calls, not one. A rule with an aggregate that doesn't bind each match's key is refused with `FoldOverProjection`, naming the key to bind. And `Refund` is contained in `Call`, so a refund of a call that doesn't exist is `invariant-rejected` on that rule, whoever writes it.

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
export const Account = relation("Account", { id: uuid }, ["id"])
/** Reseller billing: an account bills through at most one parent account. */
export const BillsThrough = relation("BillsThrough", { child: uuid, parent: uuid }, ["child"])
export const Charge = relation("Charge", { id: uuid, account: uuid, amount: Micros }, ["id"])
export const Resellers = schema("Resellers", { Account, BillsThrough, Charge }, [
	contained(on(BillsThrough, "child"), on(Account, "id")),
	contained(on(BillsThrough, "parent"), on(Account, "id")),
	contained(on(Charge, "account"), on(Account, "id"))
])

/** The root account and every account below it, at any depth. */
const below = query(Resellers).recursive("Below", {
	row: { account: uuid },
	base: [
		(r) => {
			const { id } = v(Account, "account")
			return r
				.match(Account, { id })
				.where(r.eq(id, r.param("root", uuid)))
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
	const tree = below.bind({ root: r.param("root", uuid) })
	const { account } = v(tree, "tree")
	const { id, amount } = v(Charge, "charge")
	return r
		.match(tree, { account })
		.match(Charge, { id, account, amount })
		.find({ account, spend: r.sum(amount) })
})
```

**What you get.** `query(S).recursive(name, { row, base, rec })` declares the recursive relation: `row` its fields, `base` the rules that seed it, and `rec` the rules that grow it from `self`, the set so far. `below.bind({ root })` passes it a parameter, and `r.match` joins it to `Charge` like a table. `treeSpend` takes `{ root: Uuid }`, and its rows are `{ account: Uuid; spend: Decimal }`.

The recursion compiles to `WITH RECURSIVE … UNION`, and its result is a set, so a cycle in `BillsThrough` ends the walk instead of looping forever. A recursive rule reads `self` positively, never under a negation, an aggregate or a take, so the fixed point is well defined: aggregate the finished set, as `treeSpend` does. The edges' rules hold for every writer: both ends of an edge are accounts, and a second parent for one account is `invariant-rejected` on `BillsThrough`'s primary key, `child`.

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

const Minute = contract("Minute", pg.bigint)

export const Room = relation("Room", { id: uuid, name: Title }, ["id"])
export const Opening = relation("Opening", { room: uuid, hours: span(Minute) }, ["room", "hours"])
export const Booking = relation("Booking", { room: uuid, during: span(Minute), by: ClerkUser }, [
	"room",
	"during"
])

export const Rooms = schema("Rooms", { Room, Opening, Booking }, [
	contained(on(Opening, "room"), on(Room, "id")),
	contained(on(Booking, "room", "during"), on(Opening, "room", "hours"))
])
```

**What you get.** A `span` in a primary key makes it a no-overlap key: rows that agree on `room` never share a point of `during`. `contained` between two spans is coverage: the room's opening hours cover each booking. A span includes its start and excludes its end, so back-to-back bookings don't overlap.

There is no timestamp type: a `Minute` is a bigint contract, minutes since the epoch, and the current time is a parameter you pass. A coverage's target needs a no-overlap key over its span, as `Opening`'s primary key is, or the schema is refused. `grizzle generate` compiles both rules to PostgreSQL's own constraints, a temporal primary key and a PERIOD foreign key:

```sql
CREATE TABLE "rooms"."booking" (
  "room" "pg_catalog"."uuid" NOT NULL,
  "during" "pg_catalog"."int8range" NOT NULL,
  "by" "rooms"."__text_u2zmp7otto" NOT NULL,
  CONSTRAINT "__booking_pk_tzyi2pgieq" PRIMARY KEY ("room", "during" WITHOUT OVERLAPS)
);

ALTER TABLE "rooms"."booking" ADD CONSTRAINT "__booking_fk_room_during_254p6ghcbd" FOREIGN KEY ("room", PERIOD "during") REFERENCES "rooms"."opening" ("room", PERIOD "hours") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
```

A booking that overlaps another comes back from `db.apply` as `invariant-rejected`, naming the rule, `{ kind: "primaryKey", relation: "Booking", fields: ["room", "during"] }`, with the room and span you submitted as its witness. A booking outside opening hours names the coverage rule, at commit. The constraints are PostgreSQL's, so two overlapping bookings sent in the same second can't both commit, whether the app, psql or a second service sends them.

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

- **`drawn(natural)` and `accumulated(type, start)`** are fields grizzle writes, never the caller: a count, and a value accumulated from members, starting at `start`.
- **`counted(on(Debit, "grant"), fin(Grant, "debits"))`** says each grant's members are the debits that name it, and `debits` counts them. `fin(Grant, "debits")` is the slots of that count.
- **`fold(family, Monoid.sum, step, end)`** combines each member's step value, a debit's `amount`, into its owner's end, the grant's `spent`, by a monoid: here an exact sum.
- **`mutable(Grant)`** lets a grant's count and total change after it is inserted. Tables are immutable by default: rows are inserted and deleted, never updated in place.

`wholeEntriesOf(Credits)` is the entries of a role that sees every table whole, so `Metering` reads everything and writes only debits.

**The declaration.**

```ts
import {
	accumulated,
	ChangeSet,
	check,
	counted,
	Db,
	drawn,
	type Fact,
	fin,
	fold,
	Monoid,
	mutable,
	natural,
	wholeEntriesOf
} from "@bjornpagen/grizzle"
import { Effect } from "effect"

export const Grant = relation(
	"Grant",
	{
		id: uuid,
		org: ClerkOrg,
		amount: Micros,
		debits: drawn(natural),
		spent: accumulated(Micros, Micros(0n))
	},
	["id"]
)
export const Debit = relation("Debit", { call: uuid, grant: uuid, amount: Micros }, ["call"])

/** A grant's debits, counted; their amounts summed into what it has spent. */
const grantDebits = counted(on(Debit, "grant"), fin(Grant, "debits"))

export const Credits = schema("Credits", { Grant, Debit }, [
	grantDebits,
	fold(grantDebits, Monoid.sum, on(Debit, "grant", "amount"), on(Grant, "id", "spent")),
	check("WithinGrant", Grant, (g) => g.le(g.spent, g.amount)),
	mutable(Grant)
])

export const Metering = role(Credits, "metering", wholeEntriesOf(Credits), { write: ["Debit"] })

/** Debit a grant for one call. Your code decides the retry; grizzle never retries. */
export const spend = (db: Db<typeof Metering, unknown>, debit: Fact<typeof Debit>) =>
	db
		.apply(ChangeSet.empty(Credits).insert(Debit, [debit]), {})
		.pipe(Effect.retry({ while: (e) => e._tag === "TransientFailure", times: 3 }))
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

Every transaction is SERIALIZABLE: the first migration makes it the database's default, and a write below it on a grizzle table is refused, psql's included. Two calls that spend one grant both rewrite its count and total, so they can't both commit: one fails with a `TransientFailure` that changed nothing. grizzle never retries on its own. `spend` runs the call again with `Effect.retry`, and the run sees the other's debit: it commits if the grant still covers it, and otherwise comes back as an outcome you match on, never a message to parse:

```text
{
  kind: "invariant-rejected",
  refused: { kind: "first", laws: [{ kind: "check", relation: "Grant", name: "WithinGrant" }] },
  witness: { kind: "unreported" }
}
```

`refused.laws` names rules as your schema states them, and is never empty. Here it is `first` and the witness `unreported`: `WithinGrant` reads `spent`, which grizzle fills on the grant from its debits, so the refused grant row is not one your ChangeSet states, and the check PostgreSQL tried first is all grizzle knows. A row check over a row you state names that row's key, and `every` rule of its table the row breaks ([Errors and outcomes](#errors-and-outcomes)).

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

export const Entry = relation(
	"Entry",
	{ id: uuid, memo: Prose, postings: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
export const Posting = relation(
	"Posting",
	{ entry: uuid, account: AccountCode, amount: pg.bigint },
	["entry", "account"]
)

/** An entry's postings, counted; their amounts summed into its total. */
const entryPostings = counted(on(Posting, "entry"), fin(Entry, "postings"))

export const Books = schema("Books", { Entry, Posting }, [
	entryPostings,
	fold(entryPostings, Monoid.sum, on(Posting, "entry", "amount"), on(Entry, "id", "total")),
	check("Balanced", Entry, (e) => e.total.eq(0n))
])
```

**What you get.** An entry goes in as its written row, `{ id, memo }`, and each posting as its own row naming its entry, in one ChangeSet. grizzle draws the count and the total from the postings, and `Balanced` reads the total, so a ChangeSet that leaves an entry unbalanced comes back `invariant-rejected` on `Balanced`, and changes nothing. It compiles as the grant's rule does, to keys, CHECKs and foreign keys over the postings' hidden columns, and every writer meets it, psql included.

`Entry` is not `mutable`, so its postings are fixed once it is inserted: deleting one is a type error, and a correction is a reversing entry, as a ledger wants. The check states the bound: `e.total.eq(0n)` is an exact total, and `i.total.eq(i.amount)` makes a total equal a column instead, as in "an invoice's lines add up to its amount".

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

**The reframe.** A nullable column says "this value exists in some states". Relationally, that is a fact that exists in some states: a payment is a row about an invoice, present exactly when the invoice is paid. Give each state's data a table of its own, and the rule says which row exists: an invoice whose state is `paid` has one `Payment` row, one whose state is `void` has one `Voiding` row, and no other invoice has either. The state itself is a closed relation, a fixed roster of handles the database stores as data.

**The declaration.**

```ts
import { alternatives, arm } from "@bjornpagen/grizzle"

export const InvoiceState = closed("InvoiceState", ["open", "paid", "void"])
export const Invoice = relation(
	"Invoice",
	{ id: uuid, org: ClerkOrg, state: closedId(InvoiceState) },
	["id"]
)
export const Payment = relation(
	"Payment",
	{ invoice: uuid, charge: str.regex("^ch_[0-9A-Za-z]{1,64}$") },
	["invoice"]
)
export const Voiding = relation("Voiding", { invoice: uuid, reason: Prose }, ["invoice"])

export const Invoices = schema("Invoices", { InvoiceState, Invoice, Payment, Voiding }, [
	alternatives(Invoice, "state", InvoiceState, { paid: Payment, void: Voiding })
])

/** An invoice, with its payment when it is paid and its voiding when it is void. */
export const invoiceCard = query(Invoices)
	.rule((r) => {
		const { id, state } = v(Invoice, "invoice")
		return r
			.match(Invoice, { id, state })
			.where(r.eq(id, r.param("id", uuid)))
			.find({ id, state })
	})
	.attach(
		"payment",
		(i) =>
			query(Invoices).rule((r) => {
				const { charge } = v(Payment, "payment")
				return r.match(Payment, { invoice: i.id, charge }).find({ charge })
			}),
		arm("state", "paid")
	)
	.attach(
		"voiding",
		(i) =>
			query(Invoices).rule((r) => {
				const { reason } = v(Voiding, "voiding")
				return r.match(Voiding, { invoice: i.id, reason }).find({ reason })
			}),
		arm("state", "void")
	)

/** Pay an open invoice: its state and its payment change together, in one transaction. */
export const pay = ChangeSet.empty(Invoices)
	.put(
		Invoice,
		query(Invoices).rule((r) => {
			const { org } = v(Invoice, "invoice")
			return r
				.match(Invoice, { id: r.param("invoice", uuid), org, state: "open" })
				.find({ id: r.param("invoice", uuid), org, state: InvoiceState.handle("paid") })
		})
	)
	.insert(
		Payment,
		query(Invoices).rule((r) =>
			r.match(Invoice, { id: r.param("invoice", uuid), state: "open" }).find({
				invoice: r.param("invoice", uuid),
				charge: r.param("charge", Payment.fields.charge)
			})
		)
	)
```

**What you get.** `alternatives(Invoice, "state", InvoiceState, { paid: Payment, void: Voiding })` says each invoice has exactly the detail row its `state` names, and the types follow. `invoiceCard` attaches each detail with `arm("state", "paid")`, a delivery that holds a row exactly in that arm, so its row is a union on `state`, in which `payment` is an `Option.Some` exactly when the invoice is paid:

```text
  | { readonly id: Uuid; readonly state: "open"; readonly payment: Option.None<{ readonly charge: string }>; readonly voiding: Option.None<{ readonly reason: string }> }
  | { readonly id: Uuid; readonly state: "paid"; readonly payment: Option.Some<{ readonly charge: string }>; readonly voiding: Option.None<{ readonly reason: string }> }
  | { readonly id: Uuid; readonly state: "void"; readonly payment: Option.None<{ readonly charge: string }>; readonly voiding: Option.Some<{ readonly reason: string }> }
```

`pay` takes `{ invoice: Uuid; charge: string }`. Its rows are queries, and a query in a ChangeSet reads the state before the change, in the same transaction: that is how a write depends on a read, with no interactive transaction. `pay` reads the invoice and, if it was open, marks it paid and inserts its payment, together. On an invoice that isn't open both parts are empty, so a webhook delivered twice answers `no-change` the second time. `InvoiceState.handle("paid")` is the roster's handle as a typed constant.

A paid invoice without its payment, or a payment of an invoice that isn't paid, is refused at commit, whoever writes it, as `invariant-rejected` on one of the containments `alternatives` stands for. In PostgreSQL, abridged from `grizzle generate`, `state` is a smallint code under the roster's domain, which admits only a live handle's code, and both directions are foreign keys over STORED generated columns, deferred to commit. A payment can point only at a paid invoice, and a paid invoice, its id kept only where its state is `paid` (code 1), must have its payment:

```sql
CREATE FUNCTION "invoices"."__invoice_state_names_yhl4rhbevp"() RETURNS "pg_catalog"."name"[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN '{"open","paid","void"}'::"pg_catalog"."name"[];

CREATE DOMAIN "invoices"."invoice_state" AS smallint CONSTRAINT "check" CHECK (VALUE IS NULL OR (("invoices"."__invoice_state_names_yhl4rhbevp"())[VALUE + 1] <> ''::"pg_catalog"."name") IS TRUE);

CREATE TABLE "invoices"."invoice" (
  "id" "pg_catalog"."uuid" NOT NULL,
  "org" "invoices"."__text_t2hbrv4zer" NOT NULL,
  "state" "invoices"."invoice_state" NOT NULL,
  CONSTRAINT "__invoice_pk_6v4xjquwn3" PRIMARY KEY ("id"),
  CONSTRAINT "__invoice_key_id_state_yoqqcdf5vz" UNIQUE NULLS DISTINCT ("id", "state")
);

ALTER TABLE "invoices"."invoice" ADD COLUMN "__id_jua3zt56f7" "pg_catalog"."uuid" GENERATED ALWAYS AS (CASE WHEN "state" = 1::smallint THEN "id" END) STORED;

ALTER TABLE "invoices"."payment" ADD COLUMN "__tag_state_paid_czelpy2jmx" smallint GENERATED ALWAYS AS (1::smallint) STORED NOT NULL;

ALTER TABLE "invoices"."invoice" ADD CONSTRAINT "__invoice_fk_id_ccexml2ehq" FOREIGN KEY ("__id_jua3zt56f7") REFERENCES "invoices"."payment" ("invoice") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "invoices"."payment" ADD CONSTRAINT "__payment_fk_invoice_tag_state_paid_oj2dydnqrc" FOREIGN KEY ("invoice", "__tag_state_paid_czelpy2jmx") REFERENCES "invoices"."invoice" ("id", "state") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
```

### 8. A usage page: cursors, a rollup and their indexes

**The problem.** A usage page lists a workspace's calls newest first, 50 at a time, with next and previous links that stay correct while calls keep arriving, and a chart reads spend per model without scanning every call. Both must stay fast as the call log grows.

**The Drizzle way.** You write the keyset query and its cursor format, the rollup, and the indexes, and nothing ties them together:

```sql
-- the page after a cursor: the (at, id) of the last row shown, decoded from a string you encoded
SELECT id, model, at, cost FROM call
WHERE workspace_id = $1 AND (at, id) < ($2, $3)
ORDER BY at DESC, id DESC
LIMIT 51;  -- one extra row tells you whether there is a next page

CREATE INDEX call_by_workspace ON call (workspace_id, at DESC, id DESC);

CREATE MATERIALIZED VIEW model_spend AS
  SELECT workspace_id, model, count(*) AS calls, sum(cost) AS spend FROM call GROUP BY workspace_id, model;
CREATE UNIQUE INDEX ON model_spend (workspace_id, model);  -- REFRESH ... CONCURRENTLY needs it
```

Drizzle's `pgMaterializedView` declares the view and `refreshMaterializedView` refreshes it. The cursor format, the backward page and both indexes are yours, and an index that stops matching its query fails silently, as a slow page.

**The reframe.** Each piece follows from something you declare anyway. A page is a slice of an ordered set, and a cursor a position in its order; the order is total once it ends in a key, which grizzle knows. A rollup is a derived relation, a query whose rows PostgreSQL stores, and its key follows from its query. An index serves the queries that need it, so the queries your app runs decide the indexes:

- **`derived(name, query)`** stores a query's rows as a materialized view, with a unique index on each key the query provably has. `schema.extend` adds it to a schema, and a role's `refresh` list names what the role may refresh.
- **`workload(role, programs)`** names the queries and writes your app runs on its hot paths. A login owns its workloads: grizzle compiles them once when the app starts and prepares them on each connection, and `grizzle generate` derives the indexes they need.

**The declaration**, continuing the `Usage` schema of [case 2](#2-top-three-per-group-with-exact-types):

```ts
import { derived, type PageCursor, type Uuid, wholeEntriesOf, workload } from "@bjornpagen/grizzle"

/** A workspace's calls, newest first. */
export const callLog = query(Usage)
	.rule((r) => {
		const { id, model, at, cost } = v(Call, "call")
		return r
			.match(Call, { id, workspace: r.param("workspace", uuid), model, at, cost })
			.find({ id, model, at, cost })
	})
	.orderBy(["at", "desc"])

/** Calls and spend per workspace and model, stored, and refreshed when the job says so. */
export const ModelSpend = derived(
	"ModelSpend",
	query(Usage).rule((r) => {
		const { id, workspace, model, cost } = v(Call, "call")
		return r
			.match(Call, { id, workspace, model, cost })
			.find({ workspace, model, calls: r.count(), spend: r.sum(cost) })
	})
)
export const Reporting = schema.extend(Usage, { ModelSpend }, [])

export const Analyst = role(Reporting, "analyst", wholeEntriesOf(Reporting), {
	refresh: ["ModelSpend"]
})
export const UsageApi = login(Reporting, "usage_api", [Analyst], {
	workload: [workload(Analyst, { callLog })]
})
```

and the reads:

```ts
/** The first 50 calls, and the 50 after a cursor the client sent back. */
export const firstCalls = (db: Db<typeof Analyst, unknown>, workspace: Uuid) =>
	db.page(callLog, { workspace }, { first: 50 })
export const moreCalls = (
	db: Db<typeof Analyst, unknown>,
	workspace: Uuid,
	after: PageCursor<typeof callLog>
) => db.page(callLog, { workspace }, { first: 50, after })

/** One workspace's spend on one model: at most one row, since the rollup's key is (workspace, model). */
export const modelSpend = query(Reporting).rule((r) => {
	const { calls, spend } = v(ModelSpend, "modelSpend")
	return r
		.match(ModelSpend, {
			workspace: r.param("workspace", uuid),
			model: r.param("model", Title),
			calls,
			spend
		})
		.find({ calls, spend })
})

export const spendOn = (db: Db<typeof Analyst, unknown>, workspace: Uuid, model: string) =>
	db.get(modelSpend, { workspace, model })
export const nightly = (db: Db<typeof Analyst, unknown>) => db.refresh(ModelSpend)
```

**What you get.**

- **Pages.** `db.page` answers `{ edges, pageInfo }`. Each edge is a row, `{ id, model, at, cost }` with `at` and `cost` the branded `bigint`s of their contracts, and its cursor; `pageInfo` holds the first and last edges' cursors and exact `hasNextPage` and `hasPreviousPage`. A cursor is an opaque string typed to `callLog`, and checked against it when it comes back. Ties are broken by `id`, the row's key, which grizzle adds to the order. `{ last: 50, before }` pages backward.
- **The rollup.** `ModelSpend`'s key, `(workspace, model)`, follows from its query, so `modelSpend` returns at most one row and `db.get` accepts it: `spendOn` gives an `Option<{ calls: bigint; spend: Decimal }>`. `db.refresh(ModelSpend)` compiles only for a role whose `refresh` lists it.
- **The indexes.** `grizzle generate` derives one from the workload's `callLog` and one from the rollup's key, and grants the refresh:

```sql
CREATE INDEX "__call_ix_workspace_at_id_txjpwdbrfr" ON "usage"."call" USING btree ("workspace", "at", "id" DESC);

CREATE MATERIALIZED VIEW "usage"."model_spend" ("model", "workspace", "calls", "spend") AS … WITH NO DATA;
CREATE UNIQUE INDEX "__model_spend_key_model_workspace_p5jkdouxat" ON "usage"."model_spend" USING btree ("model", "workspace");

GRANT MAINTAIN ON TABLE "usage"."model_spend" TO "usage__analyst";
```

Change `callLog` so that it needs another index, and `grizzle check`, and `DbLayer.make` at startup, refuse until you run `grizzle generate` again.

### Drizzle to grizzle, API by API

For porting an app, each Drizzle construct and what takes its place:

<details>
<summary>Drizzle → grizzle, API by API</summary>

| Drizzle                                                | grizzle                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `pgTable("post", { ... })`                             | `relation("Post", { ... }, ["id"])`; the third argument is the primary key                      |
| `.notNull()`                                           | every column; a value that may be missing is a row in a table of its own                        |
| `text()`, `varchar()`                                  | `str.regex(pattern)`: text always carries a pattern                                             |
| `integer()`, `bigint({ mode: "bigint" })`, `numeric()` | `pg.integer` (`number`), `pg.bigint` (`bigint`), `pg.numeric(p, s)` (an exact `Decimal`)        |
| `pgEnum("status", [...])`                              | `closed("Status", [...])`, with `closedId(Status)` for the column                               |
| `.references(() => post.id)`                           | `contained(on(Comment, "post"), on(Post, "id"))`                                                |
| `unique().on(t.show, t.holder)`                        | `key(on(Ticket, "show", "holder"))`                                                             |
| `` check("some_seats", sql`...`) ``                    | `check("SomeSeats", Show, (s) => s.seats.ge(1n))`                                               |
| `index().on(...)`                                      | nothing: `grizzle generate` derives indexes from your rules and your `workload(...)` queries    |
| `pgPolicy(...)`, and `set_config` around each request  | `context(...)` and `role(...)`                                                                  |
| `pgMaterializedView(...)`                              | `derived(...)`                                                                                  |
| `db.select().from(post).where(eq(post.id, id))`        | `query(Blog).rule((r) => r.match(Post, { ... }).where(r.eq(...)).find({ ... }))`                |
| `.innerJoin(comment, eq(comment.postId, post.id))`     | one variable in two matches                                                                     |
| `notExists(...)`                                       | `r.not(Comment, { post: id })`                                                                  |
| `count()`, `sum(...)`                                  | `r.count()`, a `bigint`; `r.sum(x)`, typed as PostgreSQL types it (a `Decimal` for a `bigint`)  |
| `db.query.post.findMany({ with: { comments: true } })` | `.attach("comments", (post) => ..., "array")`                                                   |
| `.orderBy(...).limit(10)`                              | `.orderBy([...]).take(10)`, or `db.page` for cursors                                            |
| `db.insert(post).values(rows)`                         | `ChangeSet.empty(Blog).insert(Post, rows)`                                                      |
| `.onConflictDoUpdate(...)`, `db.update(post).set(...)` | `.put(Post, rows)`: after the change, the row at each key is the one given                      |
| `db.delete(post).where(...)`                           | `.delete(Post, rows)`, the rows given or read by a query                                        |
| `.returning()`                                         | `.read(name, (delta) => query)`                                                                 |
| `db.transaction(async (tx) => { ... })`                | one ChangeSet and `db.apply`; a read that decides a write is a query inside the ChangeSet       |
| `` sql`...` ``                                         | none at run time                                                                                |
| `drizzle-kit generate`, `migrate`, `check`             | `grizzle generate`, `grizzle migrate`, `grizzle check`                                          |
| `drizzle-kit push`                                     | none: every change is a migration you review                                                    |

</details>

## What grizzle builds

The whole map, from what you declare to what PostgreSQL enforces for every writer:

| You write | PostgreSQL gets |
| --- | --- |
| `relation(...)` | a table, every column NOT NULL, with its primary key, and a statement trigger that refuses any write below SERIALIZABLE |
| `str.regex(...)`, `contract(...)` | a domain whose CHECK every writer's value meets, one domain for each distinct definition |
| `closed(...)` | a smallint domain that admits only live handles' codes, checked against an IMMUTABLE function returning the roster's names as `name[]`; for a `bits(...)` field over the roster, a `bit(n)` domain that admits only live handles, n its codes rounded up to whole hex digits |
| `closed.relation(...)` | no table: content-addressed IMMUTABLE constants for each closed relation or side a rule or query reads, and a table CHECK for each rule that reads one from an open row ([Closed relations](#closed-relations)) |
| a rule: `contained`, `key`, `check`, ... | a foreign key, unique key, no-overlap key or CHECK, over STORED generated columns where a side selects rows or reads `pred`; never a trigger |
| a family: `ordered`, `counted`, `tree`, `fold` | the drawn and accumulated fields grizzle fills on every write, hidden columns beside them, and the keys, CHECKs and foreign keys that prove each value it fills |
| `role(...)` | a NOLOGIN role with a schema of views and its grants; on each table some role writes through a query entry that leaves rows out, row-level security and a policy for each role that writes it |
| `login(...)` | a LOGIN NOINHERIT role that can switch to its roles, holds no privilege on your tables, and pins the session settings grizzle's guarantees rest on |
| `workload(...)` | the indexes and extended statistics its programs need; the programs compiled when the app starts and prepared on each connection |
| `derived(...)` | a materialized view, with a unique index on each key it provably has |
| a query | SQL, usually one statement and one more per attachment, and a decoder for its exact row type |

None of it is a trigger or a policy you keep in step by hand. Migrations are plain SQL files that `grizzle generate` drafts and you review, as with drizzle-kit.

## Install

You need PostgreSQL 19, Node 26 or later, and Effect 4.1. grizzle is tested on PostgreSQL 19rc1 with the two patches under [PostgreSQL known issues](#postgresql-known-issues). PostgreSQL 19 GA is due on 2026-11-19; until hosted providers offer it, run the server yourself.

```sh
pnpm add @bjornpagen/grizzle@beta effect pg
```

The agent guide ships in the package as `skills/grizzle/SKILL.md`: copy it to where your agent reads skills, and again after upgrading grizzle.

In full:

- **Peer dependencies.** `effect` 4.1.2 or a later 4.x, and `pg` (node-postgres) 8.23.1 or a later 8.x: install one copy of each beside grizzle. grizzle imports no driver: you pass the `pg` you import as each connection's `driver`, and a `pg` without pipeline mode, which every call's one round trip needs, is a type error there. `@types/pg`, where TypeScript reads `pg`'s types, is an optional peer.
- **Hardened Node.** grizzle runs under `--disable-proto=delete` and `--disable-sigusr1`: it never touches `Object.prototype.__proto__`, the `grizzle` command starts with both flags, and every test runs under both.
- **The database.** UTF8 with the builtin `C.UTF-8` locale, on a server host that has the `C.UTF-8` operating-system locale. `btree_gist` must be available; a migration creates it when a no-overlap key or a coverage rule needs it. pgvector 0.8.7 is needed only for vector fields; it is not a trusted extension, so a superuser creates `vector` first where the migration role cannot.
- **A migration role that owns the database.** It owns the schema and the database, and has CREATEROLE to create the PostgreSQL roles of your logins and roles. It needs no superuser. Any other role fails the first migration with 42501, because only the database's owner may set its default isolation level.
- **A password for each login role**, which you set, or, for RDS IAM authentication, membership in `rds_iam`. Each connection authenticates with exactly the password its configuration names: node-postgres never reads `PGPASSWORD` or `~/.pgpass` for one.
- **TLS with verify-full**, the only mode. Plaintext is refused.
- **A direct connection.** PgBouncer is not supported.
- **`max_pred_locks_per_transaction = 2048`**, recommended: a server-start setting, about 115 MB of shared memory at 200 connections.

## Effect, briefly

grizzle is built on [Effect](https://effect.website) 4. Opening a database, reading and writing return `Effect` values: lazy descriptions of work whose success and failure types are part of their type. Inside `Effect.gen(function* () { ... })`, `yield*` runs one and gives you its result. At the edge of your app, a `ManagedRuntime` built from grizzle's layer runs them: `runtime.runPromise(effect)` returns a Promise.

The example also uses `Effect.map`, `flatMap`, `mapError`, `promise`, `tryPromise` and `retry`, whose names say what they do; `Config`, which reads an environment variable each time it runs (`Config.Redacted` as a `Redacted`, which never prints its value); and `Schema`, which decodes a request body.

## Example

A blog behind Clerk: signed-out readers, signed-in members who write in their active organization, and a nightly job that loads view counts. It continues the blog schema at the start of this page and puts the cases' pieces together: contexts and roles from [case 1](#1-every-organization-sees-only-its-own-rows), a workload and its derived indexes from [case 8](#8-a-usage-page-cursors-a-rollup-and-their-indexes), typed outcomes, and a retry of a `TransientFailure` as in [case 5](#5-a-budget-no-burst-of-requests-can-overdraw). Each block below is the same module and imports only what it adds, and the test suite typechecks every line.

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
	const { id, title, body } = v(Post, "post")
	return r.match(Post, { id, title, body, status: "Published" }).find({ id, title, body })
})

/** A member reads every published post, and every post of their active organization. */
export const memberPosts = query(Blog)
	.rule((r) => {
		const { id, title, body } = v(Post, "post")
		return r
			.match(Post, { id, title, body, status: "Published" })
			.find({ id, title, body, status: Status.handle("Published") })
	})
	.rule((r) => {
		const { id, org, title, body, status } = v(Post, "post")
		return r
			.match(Post, { id, org, title, body, status })
			.match(Org, { id: org })
			.find({ id, title, body, status })
	})

/** The member's own posts in their active organization; an insert fills `author` and `org` from the token. */
export const myPosts = query(Blog).rule((r) => {
	const { id, org, author, title, body, status } = v(Post, "post")
	return r
		.match(Post, { id, org, author, title, body, status })
		.match(Session, { sub: author })
		.match(Org, { id: org })
		.find({ id, title, body, status })
})

export const comments = query(Blog).rule((r) => {
	const { id, post, author, body } = v(Comment, "comment")
	return r
		.match(Comment, { id, post, author, body })
		.match(Post, { id: post, status: "Published" })
		.find({ id, post, author, body })
})

export const myComments = query(Blog).rule((r) => {
	const { id, post, author, body } = v(Comment, "comment")
	return r
		.match(Comment, { id, post, author, body })
		.match(Session, { sub: author })
		.match(Post, { id: post, status: "Published" })
		.find({ id, post, body })
})

export const postIds = query(Blog).rule((r) => {
	const { id } = v(Post, "post")
	return r.match(Post, { id }).find({ id })
})

export const AnonBlog = role(Blog, "anon", { Status, Post: published, Comment: comments })
export const MemberBlog = role(
	Blog,
	"member",
	{ Status, Post: memberPosts, MyPost: myPosts, Comment: comments, MyComment: myComments },
	{ write: ["MyPost", "MyComment"] }
)
export const Etl = role(Blog, "etl", { Post: postIds, PostViews }, { write: ["PostViews"] })
```

A `role` is what one kind of user sees, laid out as tables. Each entry is a table or roster of `Blog`, whole (`Status`), or a query over `Blog` (`Post: published`), and `write` lists the entries the role may write.

- `anon` reads published posts and their comments.
- `member` reads published posts and every post of its active organization. `memberPosts` has two rules, and a query with several rules returns the rows of all of them; `Status.handle("Published")` puts that constant in the first rule's rows, so both rules return the same columns. `myPosts` matches `Session` and `Org`, so it keeps the posts whose `author` is the signed-in user and whose `org` is the active organization. Inserting into `MyPost` fills `author` and `org` from the token, and a post `myPosts` would not return is refused. `MyComment` works the same way, on published posts only.
- `etl` reads post ids, never a title or a body, and writes `PostViews`.

grizzle installs each role as a PostgreSQL role that reads through views in a schema of its own, one for each entry but the roster. `MyPost` and `MyComment` leave rows out, so `Post` and `Comment` get row-level security with a policy for `member`; `PostViews`, which `etl` writes whole, needs none, and its grants decide. A filter forgotten in app code cannot leak a row, because the filter is not in app code: PostgreSQL applies it to every statement.

### The app's queries and its logins

```ts
import { login, workload } from "@bjornpagen/grizzle"

const { Post: AnonPost } = AnonBlog.relations
const { Post: MemberPost, MyPost } = MemberBlog.relations

/** The feed each kind of user reads; the rows of both are { readonly id: Uuid; readonly title: string }. */
export const anonFeed = query(AnonBlog).rule((r) => {
	const { id, title } = v(AnonPost, "anonPost")
	return r.match(AnonPost, { id, title }).find({ id, title })
})

export const memberFeed = query(MemberBlog).rule((r) => {
	const { id, title } = v(MemberPost, "memberPost")
	return r.match(MemberPost, { id, title }).find({ id, title })
})

export const anonReads = workload(AnonBlog, { anonFeed })
export const memberReads = workload(MemberBlog, { memberFeed })

export const Web = login(Blog, "web", [AnonBlog, MemberBlog], {
	workload: [anonReads, memberReads]
})
export const EtlJob = login(Blog, "etl_job", [Etl])
```

A query for a role is written over the role and sees only what the role sees: `MemberPost` is already the member's filtered view of posts, so `memberFeed` has no filter to forget.

A `workload` names the queries and writes your app runs on its hot paths. The app compiles them once, when it starts; `grizzle generate` compiles them the same way, derives the indexes they need and records them in the snapshot, so a program the app would refuse to start with, generate refuses first. Edit `memberFeed` so that it needs another index, and `grizzle check` and the app's startup both refuse until you run `grizzle generate` again: the index ships in the same migration as the query that needs it.

A `login` is one PostgreSQL user, here `blog__web` and `blog__etl_job`, with its password and its own connection pool, that can act as the roles it lists. The login is the trust boundary: whoever holds its password can act as any of its roles, with any claims. So the web app and the nightly job get separate logins, and no token sent to the web app can make it write view counts.

### Connecting

```ts
import net from "node:net"
import { CredentialError, DbLayer, TokenError } from "@bjornpagen/grizzle"
import { verifyToken } from "@clerk/backend"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Config, Effect } from "effect"
import pgDriver from "pg"
import snapshot from "./migrations/blog/snapshot.json" with { type: "json" }

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
	database: "app",
	connectTimeoutMs: 10_000
} as const

export const WebLayer = DbLayer.make({
	...connection,
	login: Web,
	snapshot,
	password: Config.Redacted("BLOG_WEB_PASSWORD").pipe(
		Effect.mapError((cause) => new CredentialError({ cause }))
	),
	pool: { max: 10, min: 1, idleTimeoutMs: 5_000 },
	attachPool: attachDatabasePool,
	verify: (token) =>
		clerkJwtKey.pipe(
			Effect.mapError((cause) => new TokenError({ cause })),
			Effect.flatMap((jwtKey) =>
				Effect.tryPromise({
					try: () => verifyToken(token, { jwtKey, authorizedParties: ["https://blog.example"] }),
					catch: (cause) => new TokenError({ cause })
				})
			)
		)
})
```

`DbLayer.make` builds one login's connection pool, which serves every role of the login. It takes the `snapshot.json` that `grizzle generate` writes ([Migrating and deploying](#migrating-and-deploying)), and the connection:

- `driver`: the `pg` you import.
- `transport`: how each connection reaches the server. `open` makes a new, unconnected socket, which pg connects to `host` and `port`; then come an SSLRequest and verify-full TLS over the socket, the server's certificate chained to `ca` and naming `servername`. `host` is a name or an IP address, never a Unix socket's path, since PostgreSQL offers no TLS over one. A tunnel connects to its local end and names the server it reaches. A CancelRequest opens its own connection the same way.
- `password`: a `Redacted`, or an Effect that yields one for each new connection, so a rotated credential needs no restart.
- `connectTimeoutMs`: how long one connection attempt may take, past which it fails with `ConnectTimedOut`, and how long the one CancelRequest an interrupted call sends may take.
- `pool`: at most `max` sessions open, `min` of them kept open once opened, and the others closed `idleTimeoutMs` after their last use.

A login whose roles read the token also needs `verify`, your function from a bearer token to its verified payload: here, Clerk's `verifyToken`. `attachPool` hands the pool to Vercel, so idle connections close before a function instance suspends.

grizzle states no number of its own, and there is no isolation level, statement timeout or retry policy to set. A call waits for a session as long as you let it: the wait has no deadline, and interrupting the Effect, your own timeout among the ways, ends it, leaving nothing behind. Closing the layer's scope destroys every connection of its pool at once, awaiting nothing from the network.

### The route handler

```ts
import { ChangeSet, Db } from "@bjornpagen/grizzle"
import { ManagedRuntime, Schema } from "effect"

/** A post's id: a uuid's text, typed Uuid (five hyphenated groups) and checked to be a uuid. */
const PostId = Schema.TemplateLiteral([
	Schema.String,
	"-",
	Schema.String,
	"-",
	Schema.String,
	"-",
	Schema.String,
	"-",
	Schema.String
]).check(Schema.isUUID())

/** The client names a draft's id, so a POST sent twice inserts it once. */
const Draft = Schema.Struct({ id: PostId, title: Schema.String, body: Schema.String })

export const draft = (post: typeof Draft.Type) =>
	ChangeSet.empty(MemberBlog).insert(MyPost, [{ ...post, status: "Draft" }])

const web = ManagedRuntime.make(WebLayer)
const bearer = (request: Request) =>
	/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]

/** app/posts/route.ts: one Db per request, as the role the request's session gets. */
export const GET = (request: Request): Promise<Response> => {
	const token = bearer(request)
	const feed = Effect.gen(function* () {
		if (token === undefined) {
			const db = yield* Db.open(Web.roles.anon, {})
			return yield* (yield* db.workload.anonFeed.execute({})).collect
		}
		const db = yield* Db.open(Web.roles.member, { token })
		return yield* (yield* db.workload.memberFeed.execute({})).collect
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
		const db = yield* Db.open(Web.roles.member, { token })
		const outcome = yield* db.apply(draft(post), {})
		switch (outcome.kind) {
			case "accepted":
				return 201
			case "no-change":
				return 200
			case "outside-world":
				return 403
			case "invariant-rejected":
				return 409
		}
	})
	return web.runPromise(Effect.map(posted, (status) => new Response(null, { status })))
}
```

`Db.open(role, { token })` opens a database handle as one role, for one request: one round trip checks the database, and each call is one more. The types follow the roles: `Db.open(Web.roles.member, ...)` does not compile without a token, `Db.open(Web.roles.anon, {})` needs none, and each handle's `db.workload` holds exactly its login's workload programs for its role, compiled when the layer was built. The draft is a ChangeSet built per request, so `db.apply` compiles it for the call. The handler meets Clerk's three states:

- **Signed out.** No token: the handler opens `anon` and returns published posts.
- **Signed in, no organization.** The token has `sub` and no `o`, so `Session` has a row and `Org` has none. The feed is the published posts, and a draft comes back `outside-world`: there is no organization to fill `org` from, so the post is not one `MyPost` can hold.
- **In an organization.** The feed adds the organization's drafts, and a draft is inserted with the user and the organization filled in.

`db.apply` runs a ChangeSet and answers with an outcome: `accepted`; `no-change`, here the same draft posted again, since the client names its id and a table holds a row once; `outside-world`, a row the role may not write; or `invariant-rejected`, a rule said no, naming the rule and the key that broke it. A title over 200 characters is `invariant-rejected` on `Post.title`'s pattern, with the draft's `id` as its witness, and so is an id another post already holds, on `Post`'s primary key, whether or not the member can see that post.

Errors stay in the Effect's error channel, and this handler lets them reject its promise; a production handler maps them by stage and reason, such as an `OpenError` at stage `token` to 401. To stop a call whose client went away, pass an `AbortSignal` as `web.runPromise(effect, { signal })`: the server stops the interrupted call's statement, and an interrupted write may still have committed, like `CommitUnknown`.

### The nightly job

```ts
export const EtlLayer = DbLayer.make({
	...connection,
	login: EtlJob,
	snapshot,
	password: Config.Redacted("BLOG_ETL_PASSWORD").pipe(
		Effect.mapError((cause) => new CredentialError({ cause }))
	),
	pool: { max: 2, min: 0, idleTimeoutMs: 5_000 }
})

const etl = ManagedRuntime.make(EtlLayer)

/** No token and no claims: it writes view counts, and never reads a title. */
export const loadViews = (views: ReadonlyArray<{ readonly post: Uuid; readonly views: bigint }>) =>
	etl.runPromise(
		Effect.gen(function* () {
			const db = yield* Db.open(EtlJob.roles.etl, {})
			return yield* db.apply(ChangeSet.empty(Etl).put(PostViews, views), {})
		}).pipe(Effect.retry({ while: (e) => e._tag === "TransientFailure", times: 4 }))
	)
```

`put` writes rows by primary key: after the change, the row at each key is the one given. The load is one transaction, so it lands whole or not at all: a count for a post deleted since the export is `invariant-rejected` on the containment of `PostViews.post` in `Post.id`, and nothing is written. grizzle never retries on its own. A `TransientFailure`, such as a serialization failure, changed nothing, so this job runs the write again, up to four times.

`EtlJob` needs no `verify` and opens with no token, since its role reads no claims. Its pool holds at most two connections and closes each five seconds after its last use.

### Why it holds up in production

Each piece is PostgreSQL's to enforce or TypeScript's to check, so the guarantees hold under load, through a shared pool and beside other writers:

- **Every writer meets the same rules.** The blog's rules and roles are constraints, grants and row-level security policies, so a script, a second service or psql logged in as `blog__web` meets them exactly as the app does ([Direct SQL access](#direct-sql-access)).
- **No request leaks into the next.** `anon` and `member` share the web login's pool. Each transaction takes on its role and claims at its start, for that transaction only, so a pooled connection never carries one request's role or claims into the next.
- **Races resolve in PostgreSQL.** Every call of the blog is one SERIALIZABLE transaction in one round trip, and none holds a connection between awaits. PostgreSQL commits only what some serial order of the calls would; a call it cannot order fails with a `TransientFailure` that changed nothing, which your code may run again, as the nightly job does.
- **Failures are values.** A refused write is an outcome you switch on, and anything that went wrong is a tagged error in the Effect's error channel ([Errors and outcomes](#errors-and-outcomes)). Neither is a message to parse.
- **Trust is split by login.** Whoever holds the web login's password can act as any reader or member, but never as `etl`; whoever holds the job's can write view counts and never read a title ([Security model](#security-model)).

### Migrating and deploying

Before the app's first request, install the schema. `grizzle.config.ts` names `Blog`, both logins, the migrations directory and the connection of the role that owns the database; [Migrations](#migrations) shows it in full. Then:

```sh
pnpm exec grizzle generate grizzle.config.ts   # draft migrations/blog/<timestamp>_<name>/ and snapshot.json
pnpm exec grizzle check grizzle.config.ts      # offline: generated, resolved and untampered?
pnpm exec grizzle migrate grizzle.config.ts    # apply what is pending, as the owner
```

Read the SQL `generate` drafts, edit it if you need to, and commit it with the code: it is what `migrate` runs, and the database must end where the snapshot says. The first migration creates the login roles `blog__web` and `blog__etl_job` without passwords: as the owner, give each its password (`\password blog__web` in psql), and set it as `BLOG_WEB_PASSWORD` or `BLOG_ETL_PASSWORD` where the app or the job runs.

- **The code and the database move together.** `DbLayer.make` refuses a snapshot that is not the code's schema, and a workload whose index needs differ from it. `Db.open` refuses a database whose latest migration did not reach that snapshot, or whose roles, settings or privileges differ from it. `grizzle drift`, from CI or a schedule, compares the whole database with the snapshot, view definitions and policies included.
- **Migrations are downtime.** While one runs, every `Db` call fails at once with `StaleSnapshot` (reason `Migrating`) and every `Db.open` is refused; once it completes, a `Db` of the old code fails with `StaleSnapshot` (reason `Migrated`). Deploy the code that carries the new `snapshot.json`.

[Migrations](#migrations) covers the whole loop, with renames, drops, markers and data steps. [Deploying](#deploying) covers everything `DbLayer.make` and `Db.open` check, Vercel, and RDS IAM authentication.

## Tables and types

`relation(name, fields, primaryKey)` declares a table. `schema` groups tables and their rules into one PostgreSQL
schema.

- **No nullable columns.** A value that may be missing is a row that may be missing, in a table of its own, like
  `PostViews`.
- **Immutable by default.** Rows are inserted and deleted, never updated, and no role holds UPDATE on them.
  `mutable(Post)` among a schema's rules allows in-place updates; it changes how a `put` runs, never what it means. A
  family's owner whose family changes after it is inserted is mutable too ([Families](#families)).
- **No timestamp type.** An instant is a `bigint` contract, such as milliseconds since the epoch, and the current time
  is a parameter. A calendar day is a `date`.

| Field                                              | PostgreSQL                                                          | TypeScript                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `uuid`                                             | uuid                                                                | `Uuid`, its hyphenated spelling; `Uuid.parse` reads a string           |
| `pg.smallint`, `pg.integer`                        | smallint, integer                                                   | `number`                                                               |
| `pg.bigint`                                        | bigint                                                              | `bigint`                                                               |
| `natural`                                          | bigint, behind a domain that checks `>= 0`                          | `bigint`                                                               |
| `date`                                             | date, its column checked to 0001-01-01 … 9999-12-31                 | `CalendarDate`, its ISO 8601 text `"YYYY-MM-DD"`                       |
| `pg.numeric(p, s)`                                 | numeric(p, s)                                                       | `Decimal`, exact, no display scale                                     |
| `pg.real`, `pg["double precision"]`, `pg.float(p)` | real, double precision                                              | `number`                                                               |
| `pg.money`                                         | money                                                               | `Money`                                                                |
| `pg.boolean`                                       | boolean                                                             | `boolean`                                                              |
| `pg.smallserial`, `pg.serial`, `pg.bigserial`      | an identity column                                                  | `number`, `number`, `bigint`                                           |
| `str.regex(pattern, flags?)`                       | text, behind a domain that checks the pattern                       | the pattern's language: `string`, or `"yes" \| "no"` for `^(yes\|no)$` |
| `str.bytes(n, str.regex(...))`                     | text, behind a domain that checks its UTF-8 bytes, then the pattern | the pattern's                                                          |
| `closedId(X)`, for `X = closed("X", [...])`        | smallint, behind the roster's domain                                | the union of its names                                                 |
| `bits(X)`, a set of `X`'s handles                  | bit(n), behind a domain that holds only live handles                | `Bits<typeof X>`, a `ReadonlySet` of its names; `Bits.of(X, [...])`    |
| `contract(name, base, check?)`                     | a domain with that CHECK                                            | the base type, branded with the name                                   |
| `span(T, width?)`, T integer, bigint or date       | int4range, int8range or daterange                                   | `{ start, end }`, start included, end excluded                         |
| `pg.vector(n)`                                     | pgvector's vector(n)                                                | `Vector`, a Float32Array                                               |
| `bytes`                                            | bytea, its column checked to at most 268,435,443 bytes              | `Uint8Array`, a fresh one over its own buffer                          |

`pg.float(p)` is real for p up to 24 and double precision up to 53. `pg.int4`, `pg.float8`, `pg.decimal` and
PostgreSQL's other spellings are the same fields.

- **Contracts.** `Cents(500n)` brands a value without checking it; the database checks it on every write. A fourth
  argument, `{ proves: [...] }`, declares facts the check implies ([Queries](#queries)).
- **`natural`** is the builtin contract over `pg.bigint`, unbranded: a count, and the one type a rule's `pred` reads
  ([Rules](#rules)). A negative value is an outcome on the law `{ kind: "contract", contract: "natural" }`. No other
  contract may be named `natural`.
- **`date`** is a day of the proleptic Gregorian calendar, PostgreSQL's date, a plain type: `Compute.base` of a date is
  the date. Its value is its ISO 8601 text, `"2024-02-29"`, one text per day, in calendar order; every login pins
  `DateStyle` to ISO. A CHECK on every date column holds it to 0001-01-01 … 9999-12-31 against any writer, so no
  infinity or unspellable year is stored; it is the type's range, not a rule an outcome names. Dates compare, take
  `min` and `max`, and may stand in a key or index.
- **Spans** are over integer, bigint or date, or a contract over one; `span(date)` is a span of days.
  `span(T, width)` fixes `end − start` by a CHECK on the column: a positive `number` over integer, a count of days
  over date, a positive `bigint` over bigint.
- **`bytes`** is written and read back whole, nothing more. No key, unique, containment, rule, selection, filter,
  `Compute` operation or parameter takes one, and no contract, generated or accumulated field is of one: each is a
  type error where the types see it and `UnsupportedOperation` when it compiles. A query's head reads one like any
  field. It is written in binary, read back as hex text, and returned as a fresh `Uint8Array` you own. Its bound,
  268,435,443 bytes, keeps its hex text one JavaScript string: a longer value is an `EncodingFailure` naming its field,
  before any SQL, and a CHECK on every bytes column refuses it from any writer.
- **Patterns.** Text always carries one, with flags `"u"` (the default) or `"su"`. The syntax is JavaScript's under
  `u`, cut to what PostgreSQL matches the same way: characters and escapes, classes and ranges, `\d`, `\w` and their
  complements, `.`, groups, `|`, `^` and `$` for the start and end of the whole text, and greedy `?`, `*`, `+` and
  `{m,n}`, each bound at most 255. Refused: lookahead and lookbehind, `\p{…}` and `\P{…}`, `\s` and `\S`, `\b` and
  `\B`, backreferences, named groups, inline modifiers, lazy quantifiers, NUL, a lone surrogate, and a pattern no
  text matches, such as `a^b` or `[]`. TypeScript accepts these; the first relation, contract or `Compute.matches`
  built over the pattern refuses it with `UnsupportedOperation`, naming the construct and its position.
- **`str.bytes(n, pattern)`** is the pattern's text of at most `n` UTF-8 bytes, `n` from 0 to 2,147,483,647. Its host
  type is the pattern's, so an unbounded text of the pattern needs no cast. Its domain checks
  `octet_length(VALUE) <= n` before the pattern, so the regex engine never reads a longer value, and refuses either
  with 23514. Equal patterns and bounds share one domain; a bound the pattern already implies is dropped.
  `str.bytes(n, str.regex("^.*$", "su"))` is any text of at most `n` bytes.
- **Text in a key**, or in any index grizzle installs, needs a byte bound: its pattern's, `str.bytes`'s, or a
  contract's bound on `Compute.charLength(v)` (four bytes a code point) or `Compute.octetLength(v)` (exact).
  `keyTextBytes(fields)` is the most bytes a text holds beside `fields`, the index's other columns, in every index
  grizzle plans over them, in any order, any of them a hidden column that may be NULL. For a family axis that carries
  the text, `fields` are its group fields, its natural index, its other carried values and a tree's `end`. So
  `str.bytes(keyTextBytes([uuid, natural]), str.regex("^.*$", "su"))` fits a key beside a uuid and a natural,
  declared or over a selection, and an ordered family's axis grouped by a uuid. `keyTextBytes` throws
  `UnrepresentableKey` for a field of no byte bound, for more fields than an index holds beside a text, and for fields
  that leave a text no byte. An entry is sized as PostgreSQL lays it out: exactly through the fixed-width fields in key
  order, then each datum at its widest padding from the first text, numeric, set, range or vector on.
- **Exported bounds.** `messageMaxBytes`, PostgreSQL's longest message (1,073,741,822 bytes), `maxStringLength`, V8's
  longest string (536,870,888 UTF-16 code units), and `bytesMaxLength` (268,435,443 bytes) refuse a call before it is
  sent. Each is a `Limit`: `.value` is the number, with its owner, unit, scope and evidence, the source that states it
  or the limits it derives from. Code that splits an input across calls (`InputTooLarge`,
  [Errors and outcomes](#errors-and-outcomes)) reads the bound instead of restating it.
- **Rosters.** `closed("Status", ["Draft", "Published"])` is a fixed list of handles. A `closedId(Status)` column holds
  a handle's code, 0 … n − 1 in declared order, which is also comparison order. The API reads and writes names. The
  table stores codes, under a smallint domain that admits only live handles' codes, and every role's view adds a
  decoded column, `status_name`, beside each closed id. A handle is at most 63 UTF-8 bytes, a PostgreSQL `name`. Codes
  are history: an added handle is appended, a removed one leaves its code unused, and a reorder is refused
  ([Migrations](#migrations)).
- **Sets.** `bits(Status)` is a `bit(n)`, one bit per code, n rounded up to whole hex digits, under a domain that holds
  only live handles' bits and 0 past the last code. grizzle writes a set in hex only: `X'…'` cast to its domain in
  SQL, `X` and its hex digits as a parameter's text. The algebra is `Compute.union`, `.intersection`, `.difference`,
  `.cardinality`, `.subset`, `.disjoint` and `.singleton`; for a complement, take the full set less it. Membership is
  `Compute.subset(Compute.singleton(id), set)`. Every operation gives NULL on NULL, a NULL id's singleton included. No
  key holds a set: its bit string is too wide for an index entry.

### How a field is written

Every field has one writer. An insert or a put takes exactly the fields its caller writes, `Written<R>`.
`AdditionIn<S, R>` is R's addition in S, its sequences' members nested at their count fields.

- **The caller**, the default: a field declared by its type alone, `title: Title`.
- **PostgreSQL**: a STORED generated column,
  `relation.generated(name, written, primaryKey, (r) => ({ f: generated(type, term) }))`.
- **grizzle, drawn:** `drawn(natural)`, a family's count or index, and a tree's `start` and `end`
  ([Families](#families)).
- **grizzle, accumulated:** `accumulated(type, start)`, a fold's end or accumulator, or a copy along a family's axis,
  `start` its value where the axis begins.
- **The identity:** a serial field, which an insert may leave out ([Writes](#writes)).

**Generated fields.** A term reads its own row and closed relations ([Closed relations](#closed-relations)). `r` holds
only the fields the caller writes, so reading a generated, drawn or accumulated field is a type error. Compiling the
schema refuses a term that breaks these rules with `GeneratedRefused` (`readsGenerated`, `readsUnwritten`, or
`notRowLocal` for a read beyond its row). The term has the field's type, except for a text's pattern and byte bound,
which the field's domain checks: `generated(Ids, Compute.concat(row.head, row.tail))` fills a refined text, and a
generated value outside the domain refuses its row, `invariant-rejected` on the pattern's rule. Nothing is cast
implicitly: a term of another integer width, numeric typmod or contract, `natural` included, is `GeneratedRefused`
(`type`); write the `Compute.cast`. A term with no value at a row, such as `C.at` at a key no row holds, refuses the
row, `invariant-rejected` on `{ kind: "generated", relation, field }`, witnessed by the first row you stated whose term
has no value. It is one outcome whoever finds the NULL: grizzle, filling a nested write or a family's values that read
the field, before any SQL, or PostgreSQL's NOT NULL.

**Keys.** A fact and a query's row hold every field. A primary key holds no set, bytes, generated or accumulated field.
Another key may hold a generated field, such as a `value` generated from a text to keep two spellings of one value
apart. It is compared in the statement that writes the row, never on the host, against every row the statement writes
and every stored row: two rows of one value are `invariant-rejected` on the key, witnessed by the key's values as
PostgreSQL stores them. A delete compares only at keys whose fields it states. A family's member rows meet such a key
at its index alone, which refuses them on the key with an `unreported` witness.

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
- no row's columns read each other in a cycle, as copies along a tree's owner axis can at its root.

A schema that breaks one is refused with `UnfillableField`, naming the field, the law that fills it, the column it
reads, the axis it reads it along, and why that column is filled later.

### Closed relations

`closed.relation(name, fields, key, rows)` is a relation whose rows are fixed when the schema compiles, such as a
grammar or a price list. Its key is required, a nonempty list of its closed-id fields; a key of every field makes it a
set. Its other fields are closed ids or open-typed values, never a serial, span, set, vector or bytes. Its rows are a
set: a row written twice is one row, and two rows of one key with different payloads are refused, naming the key and
both payloads.
`closed.relation("Allowed", { kind: closedId(Kind), flag: closedId(Flag), weight: pg.integer }, ["kind", "flag"], rows)`
says which flags each kind admits, and at what weight.

It has no table. The migration installs it as content-addressed IMMUTABLE constants, a bit string indexed by its key's
codes and an array of each open-typed field's values, which PostgreSQL folds into every statement that reads them. A
rule that reads one from an open row is a CHECK on that row's table, named by its rule: a containment of a row's
`(kind, flag)` into `Allowed` is one substring read of the row's own codes.

Three reads stand in a row check, a selection, a generated field's term or a query's filter, never in a value a query
delivers or binds:

- **`Allowed.at("weight", kind, flag)`**: the payload field at that key, NULL where no row holds it.
- **`Allowed.row(kind)`**: the set of the last key field's handles that complete the prefix, empty where none does.
- **`Allowed.has(kind, flag)`**: a predicate, true where a row holds the key and false where none does.

Each is NULL where a key value is NULL. `has` states what holds at an absent key:
`Compute.or(Compute.not(Allowed.has(kind, flag)), Compute.ge(Allowed.at("weight", kind, flag), 1))` holds of every
pair `Allowed` lacks, and `Compute.cond(Allowed.has(kind, flag), Allowed.at("weight", kind, flag), 0)` is the weight,
0 where there is none. NULL follows SQL's three-valued logic: a row check refuses a row its condition leaves unknown,
and holds where another arm of an `or` holds; a selection keeps only the rows its condition is true of; and a
generated field's NULL term is refused by its column's NOT NULL. Every domain admits NULL, so no cast to a contract,
pattern, roster or set refuses a read first.

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
import { check, contract, counted, drawn, fin, key, mutable, natural, span } from "@bjornpagen/grizzle"

const Cents = contract("Cents", pg.bigint, (c) => c.ge(0n))

export const Show = relation(
	"Show",
	{ id: uuid, seats: natural, price: Cents, tickets: drawn(natural) },
	["id"]
)
export const Ticket = relation("Ticket", { id: uuid, show: uuid, holder: ClerkUser }, ["id"])
export const Stage = relation("Stage", { id: uuid, name: Title }, ["id"])
export const Run = relation("Run", { stage: uuid, nights: span(pg.integer), show: uuid }, [
	"stage",
	"nights"
])

export const BoxOffice = schema("BoxOffice", { Show, Ticket, Stage, Run }, [
	counted(on(Ticket, "show"), fin(Show, "tickets")),
	contained(on(Run, "stage"), on(Stage, "id")),
	contained(on(Run, "show"), on(Show, "id")),
	key(on(Ticket, "show", "holder")),
	check("SomeSeats", Show, (s) => s.seats.ge(1n)),
	check("NoOversell", Show, (s) => s.le(s.tickets, s.seats)),
	mutable(Show)
])
```

A price is never negative. Every ticket's show, and every run's stage and show, exists. A person holds at most one
ticket per show. A show has at least one seat and never more tickets than seats: `tickets` is drawn, each show's count
of the tickets that name it, which grizzle keeps and `mutable(Show)` lets change. `nights` is a span in `Run`'s primary
key, so two runs on one stage never share a night.

| Rule           | Written as                                                                | Holds when                                                                    |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Primary key    | `relation`'s third argument                                               | no two rows share it                                                          |
| Unique key     | `key(on(Ticket, "show", "holder"))`                                       | no two rows share these fields                                                |
| No-overlap key | a key with a `span` field                                                 | rows that agree on the key's other fields never share a point of the span     |
| Foreign key    | `contained(on(Ticket, "show"), on(Show, "id"))`                           | every ticket's `show` is a show's `id`                                        |
| Both ways      | `mirrors(on(A, "x"), on(B, "y"))`                                         | `contained(a, b)` and `contained(b, a)`, the two rules it stands for          |
| Coverage       | `contained` between two `span` fields                                     | the target's spans cover each source span                                     |
| One of several | `alternatives(Task, "kind", Kind, { Automatic, Manual })`                 | each row has exactly one detail row, in the table its `kind` names            |
| Row check      | `check("SomeSeats", Show, (s) => s.seats.ge(1n))`                         | the condition holds on every row                                              |
| Counted family | `counted(on(Ticket, "show"), fin(Show, "tickets"))`                       | each show's `tickets` is the number of tickets that name it                   |
| Ordered family | `ordered(on(Line, "order", "at"), fin(Order, "n"))`                       | each order's lines hold `at` exactly 0 … n − 1                                |
| Tree           | `tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })`  | each `doc`'s rows are one tree, `[start, end)` each row's pre-order interval  |
| Fold           | `fold(family, Monoid.sum, step, end)`                                     | each owner's end is its members' step values combined by the monoid           |
| Selected side  | `on(select(Ticket, (t) => φ), "show")`, in any rule                       | the rule reads only the rows where φ holds                                    |
| Predecessor    | `on(Place, "show", pred("at"))`, in any rule                              | the rule reads `at` − 1, and nothing of a row whose `at` is 0                 |
| Constant       | `on(A, "id", constant("x"))`, in a containment's source                   | the row meets only target rows holding `"x"` at the paired field              |

A rule pairs its sides' terms in order. A side is `on(source, ...terms)`.

- **A source** is a table, or `select(T, (t) => φ)`, the rows of T where φ holds, φ written as a row check's
  condition. It is the one way to write a selection. A derived relation is never a source, since its query alone
  decides its rows: `on(Counts, "id")` is a type error, *a law side is never over a derived relation*, and a schema
  stating a rule over one is refused from JavaScript as `LawOnDerived`.
- **A term** is a field, or `pred(n)` of a `natural` field n: n − 1, defined only where n is above 0.
- **Each term once.** A key, a family, a fold and a containment's target list each term once:
  `key(on(Ticket, "show", "show"))` is a type error, and refused from JavaScript when built. `"at"` and `pred("at")`
  are two terms.
- **A containment's source**, its first side, may read a field twice, each time meeting its own target term, and may
  hold `constant(v)`, v on every row, meeting a target field v is a value of:
  `contained(on(A, "id", constant("x"), "id"), on(B, "id", "kind", "root"))` holds where every A's id is a B of kind
  `"x"` that is its own root. A constant pairs with a scalar target field, never a `pred` term or a span, and a source
  reads at least one field. A target, either side of `mirrors` (each is a target once), a key, a family and a fold
  hold no constant: a type error, and refused from JavaScript.
- **Rows a side leaves out**, outside its selection or with its `pred` field at 0, have no tuple there: a key over the
  side doesn't hold them apart, a containment from it doesn't require them, and one into it doesn't find them.
- **Keys.** A key over a table's own fields is a candidate key of the table; one over a selected side or a `pred` term
  is not. A containment's target holds a key: a candidate key among its fields, or a key over the same selection among
  its terms.
- **Generic helpers.** A rule may be written in a helper generic over the tables it reads,
  `<T extends typeof A | typeof B>(t: T) => contained(on(t, "owner"), on(Owner, "id"))`, and typechecks exactly where
  the rule holds for each table T may be. Those tables share one heading, or one holds every field of another and
  more; a helper over tables that share none is refused. A query over such a T reads it the same way, through
  `v(t, "x")` and `r.match(t, …)`.

A show's waitlist, over the box office:

```ts
import { natural, pred, select } from "@bjornpagen/grizzle"

/** A show's waitlist: its places in order from 0, and whether each place's holder has been called. */
export const Place = relation(
	"Place",
	{ show: uuid, at: natural, holder: ClerkUser, called: pg.boolean },
	["show", "at"]
)

/** The places whose holder has not been called yet. */
const waiting = select(Place, (p) => p.eq(p.called, false))

export const Waitlist = schema.extend(BoxOffice, { Place }, [
	contained(on(Place, "show"), on(Show, "id")),
	contained(on(Place, "show", pred("at")), on(Place, "show", "at")),
	key(on(waiting, "show", "holder"))
])
```

A show's places run from 0 with no gap. A holder waits at most once per show, and may hold any number of places
already called.

Every rule holds at commit, for every writer, as PostgreSQL's own constraints. grizzle installs no trigger and no
function for a rule.

- **Sides.** Each term of a selected side, and each `pred` term, is a STORED generated column,
  `CASE WHEN φ THEN t END`. A key over a side is `UNIQUE NULLS DISTINCT` and a containment
  `FOREIGN KEY … MATCH SIMPLE`, both of which pass a row whose columns there are NULL.
- **Constants and repeated fields.** A constant of a containment's source is a STORED generated column holding it, and
  a field the source reads twice is listed twice among the foreign key's columns, so the reference meets the target's
  columns in its side's order and adds no column to the target. Such a containment keeps its own foreign key and
  rides no family's axis.
- **`alternatives`** is its containments: one from each arm into its parent at its handle, and one from the parent's
  rows of each handle into its arm, a selected side.
- **Coverage.** A coverage's target needs a no-overlap key over its span, or the schema is refused: coalesce the spans,
  or key them.

A write that breaks a rule comes back as an outcome that names the rule, never as a message to parse.

### Families

A family is a rule over rows the caller writes: each owner's members, counted by a drawn field of the owner.
`fin(O, "n")`, a family's second argument, is the slots of O's drawn count `n`, never a side or a table.

- **`ordered(on(F, g…, "at"), fin(O, "n"))`**: each owner's members, their group `g…` paired with O's primary key,
  indexed by their drawn `at` exactly 0 … n − 1, in order.
- **`counted(on(F, g…), fin(O, "n"))`**: each owner's `n` members, their group `g…` naming the owner by O's primary
  key: an unordered set, one row per member key. Its index is hidden from every field, fact and query: a coordinate,
  never a multiplicity.
- **`tree(on(T, "parent", "at"), fin(T, "children"), { root: "doc" })`**: T over itself, with drawn `at`, `children`,
  `start` and `end`. Each value of the root field `doc` is one tree: its root is the row whose `parent` is its own id,
  every other row is a member of its parent's ordered family, and `[start, end)` is each row's pre-order interval.
  PostgreSQL's own constraints keep each tree one tree, every row reachable and none on a cycle. The tree installs
  `UNIQUE (doc, start)`: a document in order is one scan of it, and a row's descendants, its tree's rows whose `start`
  lies in its interval, one range scan, with no recursion.
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
  value outside its pattern is `invariant-rejected` on that pattern's rule. Another integer width, numeric typmod or
  contract is another type, and such a fold is `MalformedDescription` when the schema compiles.
- **Running values.** A fold over a sequence may name each member's running `before` and `after`; one over a counted
  family names only its step value and end, its order being hidden. concat folds only a sequence, and names its pair.
  The family's axes key each running text, so concat's accumulators are text of a bounded pattern ([Limits](#limits)).
- **A separator belongs to the step**, never to the monoid: write each member's token with the separator before it,
  except at index 0, and the end is the tokens joined by it.

A relation is a member of at most one sequence, which orders it, and of any number of counted families, each with its
own hidden columns and foreign keys. A counted family's member may also be a sequence's member or owner, or a tree's
node. One count counts one family. Ordered families that nest each other in a cycle, an ordered family of a relation
over itself among them, are refused when the schema compiles (`UnwritableRelation`, `nestingCycle`). A family's or a
tree's member side is a table, never a selection: `counted(on(select(Ticket, φ), "show"), fin(Show, "tickets"))` is a
type error, and from JavaScript refused when you build it. A fold's step may still select the members it reads.

grizzle owns every value a family holds: each count, index, interval, copy and accumulator is drawn on the host on
every write and proved by PostgreSQL, never written by the caller. A fold's running `after` is no generated column:
grizzle fills it and `CHECK ((after = combine(before, x)) IS TRUE)` proves it in exact arithmetic, so a sum is never
narrowed into its column's type unproved.

#### Writing a family

- **A sequence is written nested**: its members under their owner, in order, at its count field, without their group
  and drawn fields: `insert(Order, [{ id, n: [{ qty }, { qty }] }])`. No tree row names its `parent`, and only the
  root names the root field: `{ id, doc, children: [{ id, children: [] }] }`. A nested member, at any depth, states no
  field its nesting supplies, grizzle draws or accumulates, or its relation lacks: a type error, and from JavaScript an
  `EncodingFailure` (`factShape`) before any SQL. An ordered member inserted alone is a type error. A tree is written
  whole: a put or a delete of one of its rows is a type error, and from JavaScript refused when the ChangeSet compiles.
- **A put and an insert of one sequence owner at one key in one stratum are two rows** at that key, since the insert
  states the owner's members and the put leaves them as they are. They are `invariant-rejected` on the key before any
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
  tree node's copy of its parent's are drawn when their row is written. A write that changes a column one of them
  reads, on a stored row, through such a copy, or as the count or end of an owner that is itself a member, refills
  that value's family: the first flight's read finds every group the change reaches along the copies that carry it,
  and grizzle draws each value there again and rewrites those rows in place, members first, before the change
  cascades into them, so a fold's CHECK holds at every statement. A refill that changes an owner's ends or another
  family's copies refills on in turn.
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
  they refill again; a refill of an immutable relation's rows or an immutable owner's family. A role refills only
  relations it holds whole: the members it rewrites in its `write` list, and every relation the refill's read passes
  among its entries (`OutsideRole`).
- **An immutable owner's family is fixed when the owner is inserted.** Declare `mutable(Owner)` for a family that
  changes later, or an owner you put. A delete of a member of an immutable owner's family and a put of an immutable
  owner are type errors, and from JavaScript refused when the ChangeSet compiles. An insert of such a member in a
  stratum that inserts no such owner is a type error where the ChangeSet is compiled (`db.apply`, `db.compile`,
  `db.explain`, a workload), since a later insert or a union may still add the owner.
- **A ChangeSet writes family members in one stratum**: writing them in a second is a type error at the call that
  makes it, and from JavaScript `UnsupportedOperation` when the ChangeSet compiles.

## Permissions

Three declarations, all in the [example](#example):

- **`context(name, fields, { claim? })`**: a claim of the session token, read by queries as a table of at most one
  row. Its fields, read from the payload's top level or from the nested object `claim` names, are text, uuid,
  boolean, the integer types, contracts over them, and closed ids, whose claim is a handle's name. An absent claim
  object is no row, and a payload that is not an object has none; a context read from the top level refuses such a
  payload at stage `token`. No rule reads a context, and no ChangeSet writes one.
- **`role(schema, name, entries, { write?, refresh? })`**: what one kind of user sees. An entry is a table of the
  schema, whole, or a query over it. `write` lists the entries it writes, each once (a name listed twice is a type
  error), `refresh` the derived tables it refreshes. A role is no schema: `role`, `login`, `schema.extend`,
  `wholeEntriesOf`, `writableNamesOf` and `lawsOf` take a schema, and a role passed to one is a type error.
- **`login(schema, name, roles, { workload? })`**: one PostgreSQL user and one pool for some roles of one schema,
  owning their workloads, each over the schema, a schema it extends, or one of the login's roles. Every role is in
  exactly one login, under a name other than the login's, and is reached through it by name, `Web.roles.member`. Two
  programs of one name across a login's workloads are a type error. A login that breaks one of these is
  `LoginRefused`.

Roles:

- **A query entry is a security-barrier view**: its filter runs before anything that could fail on a row outside it.
  It has one flat set of columns. Aggregates, negation, span comparisons, `take`, recursion, contexts and every
  Compute operation are allowed, since no expression fails on a value ([Queries](#queries)), on the rows outside the
  role a view evaluates it on included. Its keys are the ones its query provably has.
- **A role declares no rules**: the schema's rules hold, whoever writes.
- **A role that writes a family's member** reads what grizzle reads of the owner to fill the family and, when the owner
  is mutable, changes that family's drawn count and accumulated ends on it, and nothing else of the owner unless
  `write` lists the owner too: `role(Credits, "metering", wholeEntriesOf(Credits), { write: ["Debit"] })` spends grants
  and edits no grant's amount.
- **A roster among a role's entries has no view:** every query reads its handles as codes.
- **A full role** is `role(S, name, wholeEntriesOf(S), { write: writableNamesOf(S) })`. `wholeEntriesOf(S)` is every
  table of every level of `S`, whole, under its own name, except the closed relations, which every role reads and none
  holds as an entry. `writableNamesOf(S)` names, in the schema's order, every table a role writes whole: all but the
  rosters, the closed relations and the derived tables. Their types are exactly these, so `wholeEntriesOf` never
  holds a closed relation and `writableNamesOf` never names a table `write` refuses. A role that holds every table
  whole, such as `role(Blog, "staff", wholeEntriesOf(Blog))`, also runs every query and ChangeSet over the schema
  itself, such as `postPage`.
- **`RoleRefused`**, when you build the role, names the rule it breaks: a whole entry under another name than its
  table's, or not the schema's own; a query entry over a role or over any schema but the role's and those it extends,
  reading a table the schema lacks, or with parameters, nested results, vector search or an `orderBy` without `take`;
  a `write` naming no entry of the role, a roster, a derived table or an unwritable query entry, or two entries over
  one table; a `refresh` naming anything but a derived table.

`DbLayer.make({ login, snapshot, ... })` builds the login's pool and compiles its workloads. It requires `verify`
exactly when one of the login's roles reads a context. A layer with `verify` runs it on every token it is handed, for
a role that reads no context too.

`Db.open(Web.roles.member, { token })` is the only way to open a `Db`, and only where the layer of the role's login is
provided. It requires `token` exactly when the role reads a context. It runs `verify` once per `Db` and decodes the
role's contexts from what it returns, and the `Db` keeps those claims. A `Db` opened without a token, or on a layer
without `verify`, has no context rows. A role that reads no context opens whatever the payload.

**Queries for a role are written over the role.** `query(MemberBlog)` and `ChangeSet.empty(MemberBlog)` see only what
`member` does, write only the entries in its `write` list, and match only the contexts it reads. Anything else is a
type error, and another context, from a caller the types don't reach, is refused before any SQL.

### Writing through a role

A query entry in `write` is writable when it has one rule, all its columns come straight from one table, every column
of that table it leaves out, a key column included, is fixed by the query to a constant or a claim, and every other
match only filters. A count or end the table's family draws is the exception: the entry holds it among its columns,
or leaves it out unfixed. `myPosts` qualifies: its columns come from `Post`, and the token fixes `author` and `org`.
A `write` naming any other query entry is `RoleRefused` (`writeUnwritable`), with the reason.

- **An insert fills the fixed columns.** It may leave out the entry's serial columns as an insert into a table may,
  also when every column of the entry is serial: `[{}]` is one new row of the fixed columns. A serial column the query
  filters on must be in every inserted row: the row is checked against the query before its identity is drawn. A row
  the query could never return (a filter it fails, an absent claim) is the outcome `outside-world`.
- **A delete of a row outside the entry does nothing**: for this role, that row does not exist.
- **An entry over a family's owner writes the owner as a write of the table does.** No row states its counts and ends,
  and a put updates the entry's own columns in place and leaves the family as it is. Its filter may read no count or
  end, and no key of the table may hold one, else the role is `RoleRefused` (`writeUnwritable`) with `why`
  `filterReadsFamily` or `keyHoldsFamily`, naming the field.
- **A collision with a row outside the entry**, by a put or an insert, on a key over the table or over a side of it,
  is `invariant-rejected` on that rule. The witness is the key you submitted, in the entry's fields, never the other
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
	const { id, post, author } = v(Comment, "comment")
	return r
		.match(Comment, { id, post, author })
		.match(Post, { id: post, status: "Published" })
		.find({ author, comments: r.count() })
})

/** Published posts nobody has commented on. */
export const unanswered = query(Blog).rule((r) => {
	const { id, title } = v(Post, "post")
	return r
		.match(Post, { id, title, status: "Published" })
		.where(r.not(Comment, { post: id }))
		.find({ id, title })
})

/** Total views per organization. */
export const viewsPerOrg = query(Blog).rule((r) => {
	const { post, views } = v(PostViews, "postViews")
	const { org } = v(Post, "post")
	return r
		.match(PostViews, { post, views })
		.match(Post, { id: post, org })
		.find({ org, views: r.sum(views) })
})

/** An organization's posts by title, ready for paging. */
export const orgPosts = query(Blog)
	.rule((r) => {
		const { id, title, org } = v(Post, "post")
		return r
			.match(Post, { id, title, org })
			.where(r.eq(org, r.param("org", ClerkOrg)))
			.find({ id, title })
	})
	.orderBy(["title", "asc"])

/** Two posts of one organization under one title: Post matched twice, in two scopes. */
export const sameTitle = query(Blog).rule((r) => {
	const post = v(Post, "post")
	const twin = v(Post, "twin")
	return r
		.match(Post, { id: post.id, org: post.org, title: post.title })
		.match(Post, { id: twin.id, org: post.org, title: post.title })
		.where(r.ne(post.id, twin.id))
		.find({ post: post.id, twin: twin.id, title: post.title })
})
```

`v(Post, "post")` makes one variable per column, in a scope named `post`. `r.match(Post, { ... })` binds variables and constants to a table's columns; a variable in two matches joins them. `.where(...)` filters. `.find(...)` picks the result columns: variables, aggregates, parameters, constants and computed values.

In `sameTitle`, `v(Post, "post")` and `v(Post, "twin")` are two scopes of one table under two names, two sets of variables of two types, so the self-join's keys are proved like any join's. A second `v` of a name the rule already holds is refused with `DuplicateIdentity` when the rule is built.

Rows are typed from the query: `commentsPerAuthor` gives `{ author: string; comments: bigint }`, and `viewsPerOrg` gives `{ org: string; views: Decimal }`, as PostgreSQL's `sum` of a bigint is a numeric. `orgPosts` takes the parameter `{ org: string }`.

| To | Write |
| --- | --- |
| join | one variable in two matches |
| filter | `r.eq`, `r.ne`, `r.lt`, `r.le`, `r.gt`, `r.ge`, `r.between`, `r.inSet`, `r.and`, `r.or`; an empty `r.inSet` list or `r.or()` matches no row, `r.and()` every row |
| exclude | `r.not(Table, { ... })`: no matching row exists |
| take a parameter | `r.param("name", type)`: a term of that type |
| pass a row list | `r.relation("name", fields)`: a parameter that is a list of rows, matched like a table |
| aggregate | `r.count()`, `r.sum(x)`, `r.mean(x)`, `r.min(x)`, `r.max(x)`, grouped by the other columns of `find`; a min or max is one of its values, at its type, contract included |
| combine | a second `.rule(...)`, the union of both rules' rows. Rules of different columns need a constant that tells them apart; a rule with an attachment shares its columns with no other. A take or attachment over a union of several headings is no rule of a further union, takes once and is never paged |
| nest | `.attach(name, (parent) => child, delivery)`, delivery `"array"`, `"option"`, `"one"` or `arm(field, name)` |
| order and limit | `.orderBy(["title", "asc"])`, then `.take(10)`, `.take("batch")` for an integer parameter, or `db.page` |
| recurse | `query(S).recursive(...)` |
| compare spans | `r.allen` with `ALLEN` masks, `r.pointIn`, `r.intersection`, `r.difference`, `r.pack` |
| compute | `Compute.add`, `Compute.mul`, `Compute.round`, `Compute.cond`, `Compute.when` and the rest of `Compute` |
| match text | `Compute.matches(x, pattern)`, `Compute.startsWith`, `Compute.endsWith`; `Compute.concat` in checks |
| search vectors | `.approximateNearest(...)`, with pgvector |

### Differences from SQL

- **A query returns a set.** Identical rows are one row.
- **An aggregate folds keyed rows.** It reads each matched row once, by its key: every match in its rule binds a whole key of its source by a variable, a parent's variable or a constant, as `commentsPerAuthor` binds the comment's `id`, or the query is refused with `FoldOverProjection`, naming the match and the key to bind. To aggregate distinct values, match a query of them, a set keyed by its columns.
- **grizzle knows each result's keys**, from primary keys, equalities and constants, and keeps a key through `find` while the chosen columns still determine the row. `db.get` and an `"option"` or `"one"` nested result take only a query proved to return at most one row, and a page is ordered by a key. A delivery the schema does not prove is a type error.
- **`.orderBy(...).take(k)` is a set again** to whatever composes with it: a match, a further rule, a derived relation or a role's query entry. `take(1)` returns at most one row. A query or nested `"array"` that ends in a take arrives in the take's order, ties broken by the query's key; a final `orderBy` after the take orders it anew.
- **Variables belong to their columns.** Two variables made from one column of a table the rule matches once are refused, and the error shows the rewrite: make the variable where it is bound, or match the table again.
- **A JavaScript value takes the type of what it meets:** its column, the term it is compared with, the field a write puts it in, or the type the query's other rules give its field. Meeting nothing, a string is text, a safe integer an integer, a bigint a bigint, a `Decimal` a numeric, a `Money` money and a boolean a boolean; any other value is refused. It never stands first in a comparison, and a list such as `r.inSet`'s holds only JavaScript values. Opposite a term, at a column, for a parameter or in a fact, it is a value of its type: in a pattern's language, a uuid's hyphenated spelling, a roster's names, so `"abc"` at a uuid column is a type error, and so is a plain `string` until `Uuid.parse` reads it.
- **A typed term states its type** and stands wherever such a term does. `Status.handle("Published")` is a member of the `Status` roster, and `Compute.literal(F, x)` is `x` at the type of any other descriptor `F`. A head keeps a handle's member, so `find({ status: Status.handle("Published") })` delivers `status: "Published"`; `Compute.literal` delivers F's type.
- **Terms that meet have one type:** one SQL type, one contract and one roster. A text term never meets a uuid column, and two rosters of the same members never meet. Texts of any two patterns meet: a pattern is no part of a text's type. The rules of one query deliver each field they share at one type.
- **A value is only its value**, the same under every plan. A `Decimal` has no display scale: `1`, `1.0` and `1.00` are one value, delivered as `1`, and a `pg.numeric(10, 2)` field rounds what it stores to two places but delivers `12.5`, not `12.50`. `new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(d.toString())` prints it at the field's scale, exactly. A float's zero is `0`, never `-0`. A numeric quotient, power, square root or mean is PostgreSQL's for the values alone, as if no operand had trailing zeros: `Compute.div(x, 3n)` is the same number whatever scale `x` was stored at.
- **Float and money sums are exact.** A sum of `real` or `double precision` values is their exact total rounded once to the result type, and of `Money` values their exact total; a mean of floats is that total over the count, rounded once. The same rows give the same sum in any order, under any plan.
- **Every answer is a function of the facts**, but for two exceptions, both pgvector's. `.approximateNearest` returns candidates from pgvector's index: which rows, and how many, depend on the index and the database owner's pgvector settings too. grizzle pins only `hnsw.iterative_scan = strict_order`, which keeps the candidates and their cursors in exact distance order; `hnsw.ef_search`, `hnsw.max_scan_tuples` and `hnsw.scan_mem_multiplier` are the owner's, and a scan that reaches their bounds returns fewer rows than asked. `Compute.cosineDistance` is pgvector's own float arithmetic: one server gives the same result for the same vectors on every evaluation, but pgvector builds or CPUs may differ in the last place.
- **No read fails on a value.** Every Compute operation is defined on every value its operands' types admit, or its precondition is proved where it stands, so no query, role view or check raises an arithmetic error on any row.

### Arithmetic

- **Exact.** Integer arithmetic delivers `bigint`, an *exact integer*, and money arithmetic exact `Money`; neither overflows.
- **Floats are IEEE 754:** `x / 0.0` is ±Infinity and `sqrt(-1.0)` is NaN.
- **A partial operation needs its precondition proved:** division or remainder by a value that may be zero, a numeric square root of one that may be negative, a power, `widthBucket` and `minScale` of values that may be infinite, and a cast that narrows. The proof is a literal's own type, as in `Compute.div(x, 7n)`; a contract that declares it, `contract("Divisor", pg.bigint, (v) => v.ne(0n), { proves: ["nonzero"] })`; or a guard, `Compute.when(Compute.nonzero(b), (b) => Compute.div(a, b), 0n)`, whose function receives `b` proved nonzero and whose last argument is the value where the guard does not hold. An unproved divisor is a type error that names the guard to write.
- **Guards** are `Compute.nonzero`, `Compute.nonnegative`, `Compute.positive`, `Compute.isFinite` and `Compute.within(x, low, high)`, each a predicate too. A guard's subject is any term, a parameter included: over `d = r.param("d", pg.bigint)`, `Compute.when(Compute.nonzero(d), (d) => Compute.div(x, d), 0n)` delivers `0n` where `d` is bound to zero, under every plan.
- **A contract's facts are exactly the ones its `proves` declares.** Compilation proves each from the predicate and refuses one the predicate does not imply. A fact the predicate implies but `proves` leaves out is no fact of its values: `Compute.minScale(rate)` over `contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))` is refused, naming `{ proves: ["finite"] }` to add. A parameter of a contract has its declared facts, its binding checking every value, so `Compute.div(x, Compute.base(r.param("d", Divisor)))` needs no guard.
- **Magnitudes are proved by `Compute.within`.** A narrowing's range or a power's is proved from `Compute.within`'s bounds, or refused as `PartialOperation`: narrow an exact integer into an integer field with `Compute.when(Compute.within(x, 0n, 1000000n), (x) => Compute.cast(x, pg.integer), 0)`.
- **Exact and plain values share no type.** An exact value binds at a plain integer or money column, but a ChangeSet member stores one into a field only through that cast: a head that writes `Compute.add(balance, amount)` into a `pg.bigint` field is a type error. Where PostgreSQL would widen the plain value implicitly, `Compute.cond`, `Compute.when`, `Compute.least` and `Compute.greatest` refuse an exact value beside a plain one of its family, in either order, naming the cast of the exact one into the plain one's type. A bare literal takes its term's type, an exact one's included, and is refused where it has more digits than that type holds.

### Text

- **`Compute.matches(x, pattern)`** is PostgreSQL's `~`: whether `x` holds a match of a pattern in `str.regex`'s grammar under the flags `"u"`, anchored by `^` and `$`. The pattern is a string, type-checked as `str.regex` checks its own, or a text term whose every value the schema holds: a closed relation's text payload, as in `Compute.matches(lexical, ValueDomain.at("pattern", domain))`, or a `Compute.cond` of such terms. Each value is admitted when the schema compiles, inside PostgreSQL's regex compile space as a `str.regex` pattern is ([Limits](#limits)). A field, a parameter or a computed text can be any pattern, and is refused as one. A match is also a guard: `Compute.when(Compute.matches(code, "^[0-9]+$"), (code) => …, otherwise)` hands its branch the subject as text of the pattern's language; over a pattern term it is a conditional.
- **`Compute.startsWith(a, b)` and `Compute.endsWith(a, b)`** test a prefix and a suffix, by characters.
- **A byte bound is a guard.** `Compute.when(Compute.within(Compute.octetLength(x), 0, 64), () => Compute.cast(x, Name), "")`, with `Name` a `str.bytes(64, pattern)` whose pattern holds x's, reads `x` inside the branch as at most 64 UTF-8 bytes of its own pattern, so a text of no byte bound casts into `Name`. Like `octetLength`, it stands in checks, contract predicates and generated fields.
- **`Compute.concat(a, b)`** is `a || b`, text of no pattern. It stands in checks, contract predicates, generated fields and folds, and in a query only as a side of `Compute.eq` or `Compute.ne`, which is decided without building it: by the lengths, a prefix and a suffix, and NULL exactly where `a || b` would be. Its first operand is a term, as every operation's is, so a leading literal is a typed constant: `Compute.concat(Compute.literal(Prose, "item-"), id)`.
- **`Compute.translate(x, from, to)`** is PostgreSQL's `translate`, by characters: each character of `x` that `from` holds becomes the character of `to` at its position, so `Compute.translate(title, "\t\n\r", "   ")` reads a title in `xs:normalizedString`'s value space. `from` and `to` are strings of one length, `from` holding each character once, or the call is refused where it is written.
- **`Compute.lowerAscii(x)`** is `translate` from `A` to `Z` onto `a` to `z`. It lowers no other letter, so it is one IMMUTABLE map whatever the collation.
- **`Compute.replaceWhitespace(x)`** is XML Schema's whiteSpace replace, `Compute.translate(x, "\t\n\r", "   ")`.
- **`Compute.collapse(x)`** is its whiteSpace collapse, each run of tab, LF, CR and space one space and none at either end: `btrim(regexp_replace(x, '[ \t\n\r]+', ' ', 'g'))`, IMMUTABLE and reading no collation, so it stands in a generated field. No other character is white space to it, a no-break space and a line separator among them.
- **A query matches, translates or collapses only a bounded text**, one whose pattern bounds it within 268,435,454 bytes, since PostgreSQL allocates four bytes for every byte of it. A check, a law's selection or a generated field reads any text ([Limits](#limits)).

A translation is text of the image of `x`'s language, every class and character of its pattern rewritten by the map, so a bounded pattern stays bounded and a literal opposite it is judged by the image. A query's head delivers it through one cast into a text type some field declares, or into `Prose`. A cast of a text into a refined text is total where the text's language lies inside the target's, proved by comparing their automata as for a parse, so a translation is stored in a field of a type the image lies in: `generated(Normalized, Compute.cast(Compute.translate(row.title, "\t\n\r", "   "), Normalized))`, `Normalized` being `str.regex("^[^\\t\\n\\r]*$", "su")`.

A collapse is text within `x`'s length bound, of runs of `x`'s other characters a space apart. That is exactly the image of `x`'s language for a pattern with no white space, which collapse leaves as it is, and for a class repeated freely, `^[...]*$` (the wildcard among them), whose image is every collapsed text over its other characters: `^(?:[^ \t\n\r]+(?: [^ \t\n\r]+)*)?$` for `Prose`. For any other pattern it is more than the image: for one of at most n characters, n up to 257, every text of at most n characters that begins and ends with a character other than white space, two spaces together included, `^(?:[^ \t\n\r](?:[^\t\n\r]{0,n-2}[^ \t\n\r])?)?$` for `^.{0,n}$`; for any other, the collapsed texts over its characters, unbounded. Store a collapse as a translation is stored: `generated(T, Compute.cast(Compute.collapse(row.title), T))` for a `T` the result lies in.

### Parsing text

`Compute.cast(lexical, T)` is PostgreSQL's own cast from text into an integer type, `pg.numeric(p, s)`, `pg["double precision"]`, `pg.boolean` or `date`, read as XML Schema reads `xs:integer`, `xs:decimal`, `xs:double`, `xs:boolean` and `xs:date`. Each type has one lexical form, `lexicalForm(T)`: XML Schema's lexical space cut to the values `T` holds exactly, so the cast never raises and never rounds.

| `T` | `lexicalForm(T)` |
| --- | --- |
| an integer type | `[+-]?[0-9]+` within the type's range, a bigint's 19th digit included |
| `pg.numeric(p, s)` | at most `p - s` integer and `s` fraction digits, besides leading and trailing zeros |
| `pg["double precision"]` | a mantissa of at most 15 significant digits either side of its point, with an exponent of at most 293; or `INF`, `-INF` or `NaN` |
| `pg.boolean` | `true`, `false`, `1` or `0` |
| `date` | `YYYY-MM-DD` from 0001 to 9999, leap days by the Gregorian rule, no timezone |

The cast is total, and compiles, exactly when every value of its operand is in the form: a field typed `lexical(T)` or `str.regex(lexicalForm(T))`, a text whose pattern's language lies inside the form, proved by comparing the two languages' automata, or a subject under `Compute.when(Compute.matches(x, lexicalForm(T)), (x) => Compute.cast(x, T), otherwise)`. Anything else is `PartialOperation` with the precondition `lexical`. Two languages whose automata the comparison cannot build within 2,048 DFA states and 2,097,152 NFA-state visits are `ResourceBound`, naming both patterns.

So a typed value derived from its lexical form is a generated field, `generated(pg.bigint, Compute.cast(row.count, pg.bigint))`: NOT NULL, computed by PostgreSQL from the text it agrees with, and read by a law as any field is. A numeric's cast is `::numeric(p, s)`, which the form keeps from rounding; a date's is `make_date` over the text's year, month and day, since `text::date` reads `DateStyle` and is STABLE, which a generated column refuses. The host reads each form by a scan of its own and agrees with PostgreSQL to the bit, a double's rounding included.

`Compute.parseDouble(x)` reads any decimal text of a double, of any digits and any exponent, by IEEE 754's conversion to binary64, the one JavaScript's `Number` and Java's `Double.parseDouble` make: the text's exact value rounded to the nearest double, ties to even, an infinity of its sign past the greatest finite double, and a zero of its sign below half the least subnormal. Its text is `doubleText`, the grammar of XML Schema 1.1's `xs:double` lexical space: `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` with an optional `[eE][+-]?[0-9]+`, or `INF`, `+INF`, `-INF` or `NaN`, which name themselves. It compiles as a cast does, over a field whose pattern lies inside `doubleText` or a subject under `Compute.when(Compute.matches(x, doubleText), (x) => Compute.parseDouble(x), otherwise)`; anything else is `PartialOperation` with the precondition `lexical`. So `1e400` is `Infinity`, `-1e-400` a negative zero, equal to zero as every double's zero is, and `1.7976931348623157e308`, `5e-324` and `1.2345678901234567` the doubles they name, where `Compute.cast` into `pg["double precision"]` keeps its bounded form, since PostgreSQL's own `float8in` refuses an overflow and an underflow. Its SQL reads the digits and exponent with plain text functions into a numeric of at most 769 significant digits, its exponent clamped within ±324, and rounds that once, so it stands in checks, generated fields and queries over a text of any length.

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

Its rows are `{ show: Uuid; sold: bigint }`, one per show, since `0n` takes the count's type, bigint.

## Reading

Every read takes a query and its parameters and runs in one READ ONLY transaction, so a query's nested results and a page's rows see one snapshot.

- **`db.execute(query, params)`** gives a result whose `collect` is the rows; each run of `collect` runs the query again.
- **`db.get(target, params)`** gives an `Option` of one row: of a table by its primary key, `db.get(Post, { id })`; of a candidate key or a closed relation by its key values; or of a query that returns at most one row.
- **`db.page(orderedQuery, params, { first: 20 })`** pages by key, with opaque cursors: `{ first }`, `{ first, after }`, `{ last }` or `{ last, before }`. A size is any safe integer of at least 1, with no default and no largest.
- **`db.explain(program, params)`** returns PostgreSQL's estimated plans as data, in the order the program's statements would run, never EXPLAIN ANALYZE; a ChangeSet's are taken in a transaction that is rolled back. A plan node holds only its node type, estimated startup and total cost, rows, width and children; the relation and index names and conditions PostgreSQL reports are dropped.
- **`db.workload.<name>`** is a program in the login's workloads, compiled when the layer was built, with exactly the operations it allows. Its statements are prepared on each connection's first use and kept for the pool's life.
- **Any other program**, one built at run time included, still runs: `db.execute` and the others compile it for the call and send it as unnamed statements, with no index promised for it.
- **`db.compile(program)`** compiles a query, ordered query or ChangeSet once and returns a handle with exactly the operations it allows. Its prepared statements close, and its compiled form drops, when the handle's `Scope` ends.

## Writes

A write is a ChangeSet: rows to insert, delete and put, applied as one transaction.

```text
ChangeSet.empty(Blog)               a write over a schema, or over a role: ChangeSet.empty(MemberBlog)
  .insert(Post, rows)               add these rows; a row already present is no change
  .insertAll({ Post: rows })        an insert of each relation the record names by its key
  .delete(Comment, rows)            remove these rows
  .put(PostViews, rows)             after the change, the row at each key is the one given
  .read("name", (delta) => query)   a query over the result, delivered in the outcome
  .bind({ id })                     every parameter's value, bound ahead of apply
```

- **Rows** are an array, an Effect `Stream` or a query, in any number; each column travels as one array. A query reads
  the state before its stratum, in the same transaction. There are no interactive transactions: a write that depends
  on a read states the read as its query.
- **`insertAll`**'s rows at each key are what `insert` takes for that relation, typed and checked as that insert and
  refused at their key. Its keys are required, and their order means nothing. `insertableNamesOf(schema)` names, in the
  schema's order, every table a ChangeSet over it inserts at the top level: all that `writableNamesOf` names but an
  ordered family's members, which are nested under their owner; a counted family's members and a tree's table are
  among them. `InsertableNameOf<S>` is their type, and `InsertAllRowsOf<S>` is the record `insertAll` takes over all
  of them, each table's rows an array of its `AdditionIn<S, R>`, so `ChangeSet.empty(Credits).insertAll(rows)` with
  `rows: InsertAllRowsOf<typeof Credits>` writes grants and debits at once.
- **A row holds the fields its caller writes**, `Written<R>` ([How a field is written](#how-a-field-is-written)). A
  family's member is a row of its own, nested under its owner only in a sequence ([Families](#families)), and written
  from an array or a `Stream`, never from a query or through a query entry, since grizzle draws its family's values
  from its rows on the host. Its owner may be written through a query entry
  ([Writing through a role](#writing-through-a-role)).
- **A relation's rows are a set.** Identical rows are one row. Two rows of one relation that share a key and differ
  elsewhere are `invariant-rejected` on that key before any SQL is sent, or, at a key over a generated field, by the
  statement that writes them. At the primary key, an array literal of up to 1,024 such rows with literal values is a
  type error. A row one stratum both adds and deletes stays; one it both inserts and puts is the put's.
- **Serial columns** may be left out of an insert's rows, all of a row's or none: the identity draws them for a new
  row, and equal such rows are one new row. Leaving out only some is an `EncodingFailure`. A table whose every column
  is serial takes `[{}]`, one new row.
- **`read`** runs its query after the change, before COMMIT. `delta.added(T)` and `delta.removed(T)` are the rows the
  change added and removed. A read-back name used twice in one ChangeSet is a type error.
- **Strata.** Every write in a stratum reads the state before it, so build order means nothing.
  `ChangeSet.union(a, b)` merges two ChangeSets stratum by stratum; `ChangeSet.sequence(a, b)` runs `b`'s strata after
  `a`'s. Either is one transaction, over the higher of the two schemas.
- **Statement order.** A stratum's writes, its families' members and owner counts included, run in the order its
  immediate foreign keys require: a referenced row is added before the rows that name it and removed after them, so a
  family's members are deleted before their owner. Writes those keys order in a cycle are refused when the ChangeSet
  compiles (`UnorderableStratum`): move one to another stratum with `ChangeSet.sequence`.
- **`db.apply(changes, params)`** answers `accepted`, with `counts` (each written relation's `added`, `deleted` and
  `put`, as `bigint`s) and `reads`; `no-change`, with `reads`; `invariant-rejected`; or `outside-world`
  ([Errors and outcomes](#errors-and-outcomes)).

Two writes over the blog, each one transaction and one round trip:

```ts
/** Publish a draft: the new row is read from the old one, in the same transaction. */
export const publish = ChangeSet.empty(Blog).put(
	Post,
	query(Blog).rule((r) => {
		const { id, org, author, title, body } = v(Post, "post")
		return r
			.match(Post, { id, org, author, title, body, status: "Draft" })
			.where(r.eq(id, r.param("id", uuid)))
			.find({ id, org, author, title, body, status: Status.handle("Published") })
	})
)

/** Delete every comment by one author, and read back how many went. */
export const purge = ChangeSet.empty(Blog)
	.delete(
		Comment,
		query(Blog).rule((r) => {
			const { id, post, author, body } = v(Comment, "comment")
			return r
				.match(Comment, { id, post, author, body })
				.where(r.eq(author, r.param("author", ClerkUser)))
				.find({ id, post, author, body })
		})
	)
	.read("removed", (delta) =>
		query(Blog).rule((r) => {
			const { id } = v(delta.removed(Comment), "removedComment")
			return r.match(delta.removed(Comment), { id }).find({ comments: r.count() })
		})
	)
```

`publish` takes `{ id: Uuid }`; applied twice, the second answers `no-change`, since the query finds no draft to put.
`purge` takes `{ author: string }`, and its `accepted` outcome carries `reads.removed`, a
`ReadonlyArray<{ comments: bigint }>`: `RETURNING`, as a query over what the change removed.

## Derived tables

`derived(name, query)` stores a query's rows as a materialized view; add it to a schema with `schema.extend`. The
query takes no parameter, matches no context, has at least one field, and its rules share one set of columns. Each
key the query provably has gets a unique index. Columns the query makes equal count as one column of a key, so k
equal pairs make one key, not 2^k: the index holds the first of them, and any of them stands for it in a `get`, a
nested result or an order. A derived table changes only when `db.refresh(...tables)` refreshes it, on a role whose
`refresh` list names it, all of one call's tables in one transaction. `db.refresh()` with no table is a type error:
narrow a list built at run time with `Array.isReadonlyArrayNonEmpty` first. Rules are declared on stored tables only,
never on derived ones.

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
	migrations: "migrations",
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

Every setting is required, and nothing else is configurable:

- **`schemas`**: the declared schemas, at least one.
- **`logins`**: every login, and through them every role and workload. A login over a schema not listed is refused;
  a login not listed is not installed, nor are its roles.
- **`migrations`**: the directory, absolute or relative to the config file's directory.
- **`connection`**: where `migrate` and `drift` connect, as the role that owns the schemas; no other command reads it.
  Its password is a `Redacted` or an Effect evaluated for each connection attempt.

grizzle reads no file you don't name and no environment variable for where to connect: the config reads its own
credentials.

```text
grizzle generate <config> [--name <name>] [--schema <schema>] [--rename <old>=<new>]... [--drop <old>]...
    draft the next migration from the schemas' changes
grizzle generate <config> --custom --name <name> [--schema <schema>]
    an empty migration for data steps
grizzle check <config>
    generated, resolved and untampered? (offline)
grizzle migrate <config>
    apply pending migrations
grizzle drift <config>
    does the database match the snapshot? (applies nothing)
grizzle names <config>
    each hashed object's PostgreSQL name and what it is
```

`--name` is lowercase ASCII letters and digits in words joined by `_` or `-`, at most 240 characters, so that the folder `<timestamp>_<name>` fits
one file name (NAME_MAX, 255 bytes); without it, a drafted folder is named after its change. `--schema` is accepted
only when the config lists several schemas, and required there with `--custom`, `--rename` or `--drop`. Exit codes: 0
ok, 1 refused, 2 usage error, 130 interrupted.

The loop: change the schema in code, run `grizzle generate grizzle.config.ts`, read the SQL it drafts and resolve its
markers, run `grizzle check grizzle.config.ts`, commit, and run `grizzle migrate grizzle.config.ts` from CI or the
deploy.

- **Drafted from a snapshot, never from a live database.** `generate` compares your schemas, their roles and logins,
  and every login's workloads with the committed `migrations/<schema>/snapshot.json`, and writes the new snapshot and
  a folder `migrations/<schema>/<timestamp>_<name>/` of numbered SQL files and a `meta.json`.
- **Plain SQL you may edit**, as long as the database ends where the snapshot says. What the schema drops is
  dropped in the same migration, as declared. A declared rename happens in place, as does a type change of a field its
  caller writes: by a cast, or by the expression you write at a `-- grizzle: placeholder` marker, which also asks for
  the values of a new field its caller writes, on a table that may hold rows. Roles' views, policies and functions hold no data: one that
  changes, or reads anything the migration changes, is dropped and created again in one transaction.
- **No guessing.** grizzle never guesses a rename and drops nothing you didn't declare. Declare each with
  `--rename <old>=<new>` or `--drop <old>`, once per name, each side a relation (`Task`), a field (`Task.title`), a
  roster's handle (`Status#done`) or a login (`@web`); swaps and chains work. A renamed relation keeps its rows, a
  field its values, a handle its code, and a login its PostgreSQL role (`ALTER ROLE ... RENAME TO`), with its password
  and grants. A name the schema dropped that no declaration names is refused, naming it: a stored relation, a field
  its caller writes, a handle, or a login, whose password and outside grants no migration can give back.
- **A schema renamed in code is a new PostgreSQL schema.** Its first migration, drafted while the migrations directory
  holds schemas the config doesn't list, carries its creating statement commented out under
  `-- grizzle: data loss`: uncomment it to start empty and leave the old rows behind, never migrated again, or keep
  the old name and delete the folder. `check` and `migrate` refuse the folder until you decide.
- **Codes are history.** The snapshot records each roster's codes: a new handle takes the next code, a renamed one
  keeps its own, and a removed one leaves a hole no handle takes again. The migration validates the roster's domain
  against its new names constant, refusing, by table and column, every row that holds a removed code: change or delete
  those rows in a data step first. A set over a grown roster converts in place to its wider
  domain, the new handles absent. A roster declared out of its codes' order is refused before anything is drafted:
  append new handles.
- **A roster continues one roster at most.** It continues the roster a `--rename` names, or else the roster of its own
  name or an alike spelling of it (`Status`, `status`), unless a rename of another roster takes that name. Every other
  roster is new, its codes from 0. A closed id or a set keeps its stored codes only on the roster its own continues.
  Anywhere else its codes would name other handles, so its conversion is a `-- grizzle: placeholder`: moved to
  another roster, to or from an integer, renamed without `--rename` (that is a `--drop` and a new roster), or left on a
  name another roster takes (`--rename Draft=Status --drop Status`). The marker says why, and it offers no cast:
  compute each row's new value from what its old value means.
- **A closed relation's change is a new constant.** Constants are named by their contents, so a change installs new
  ones, replaces and validates every CHECK that reads them, gives every generated field that reads them its new
  expression (`SET EXPRESSION`), and drops the old ones `RESTRICT`, so PostgreSQL refuses a migration that missed a
  reader. A rule over closed relations alone, new or with changed closed rows, runs as its violation query at the start
  of the migration's first file, refusing the migration before it changes anything. A key holding slots reads its
  owners' counts, never its slot roster's size: a changed count replaces its counts' and rows' constants and its
  owners' bases where they move, and a grown or renamed slot roster replaces none.
- **A family added to stored rows is backfilled** by SQL over those rows, in the migration that adds it: each member's
  index in its member key's order, each count, each fold's running values in index order, and a tree's intervals. Its
  constraints are added after the backfill, `NOT VALID`, and validated, so a value drawn wrongly refuses the
  migration. A family the stored rows alone don't determine (a fold over a tree, a copy along an axis) is refused,
  naming it. The backfill's window functions and its one recursive step over a tree are migration SQL you review;
  queries at run time use neither.
- **Data steps** go in a custom migration, `generate --custom`: a folder holding only `meta.json`, from the committed
  snapshot to itself.
  Add `01-<words>.sql`, `02-<words>.sql` and so on, each one transaction unless its first line is
  `-- grizzle: no-transaction`, which runs each statement alone, each ending at a semicolon where psql would end it:
  outside quotes, dollar quotes, comments, parentheses and the `BEGIN ATOMIC … END` body of a function or procedure.
  None controls its own transaction. Every file runs at SERIALIZABLE, and the database must still end at the
  snapshot.
- **`check` reads no database.** It reports, each with its fix, a schema change you haven't generated, a drop no
  declaration names, a workload program whose index needs differ from the snapshot's (naming it), an unresolved marker
  or data loss, and an edited `snapshot.json` or `meta.json`.
- **`migrate`** connects as the role that owns the schema and the database, applies the pending files, records each in
  the schema's ledger, and refuses an applied file edited, removed or added since. Then it refuses drift, a database
  that is not exactly the snapshot's, so on a database changed by hand it applies its files, then refuses. `drift`
  runs that check alone, for CI or a schedule. Both judge the database as it stands: a grant already held, or a revoke
  of a privilege never held, changes nothing. Both refuse a process environment that
  sets `PGOPTIONS` or `PGREPLICATION`, at stage `environment`.
- **Names come from your code.** A declared name is ASCII letters, digits and underscores, starting with a letter.
  `TaskNote` becomes `task_note` for the schema, tables, derived tables, rosters' domains, contracts, columns, row
  checks and a role's views; a contract's CHECK is `check`; a login's or role's PostgreSQL role, like a role's schema,
  is `<schema>__<name>`. Refused: two names that convert to one, a conversion over 63 bytes (a login's or role's with
  its schema's), and a schema name starting with `pg_`. Everything else (keys, foreign keys, indexes, functions,
  triggers) is named `__<readable part>_<digest>`, with a COMMENT saying what it is, and listed by `grizzle names`.
  PostgreSQL roles are cluster-wide, so one schema name is one installation per cluster. grizzle's SQL qualifies every
  name: a table as `"shop"."task"`, a type as `"pg_catalog"."text"` or its keyword (`integer`), a function as
  `"pg_catalog"."count"`. So a relation may be called `Text` or `Uuid`, and no search_path, the database's, a role's
  or a session's, changes what a migration or a query means.
- **Indexes follow the code.** Every index comes from a rule, from a workload program's queries through the roles they
  read, or from a role's write filter. A workload program edit that needs no other index takes effect as is; one that
  does, or a program added, renamed or removed, is refused by `check` and by `DbLayer.make` until you run `generate`.

The [agent guide](packages/grizzle/skills/grizzle/SKILL.md) is the full workflow: markers, renames, legal edits,
refusals and deploys.

## Errors and outcomes

A broken rule is an outcome, not an error. Errors are tagged classes in the Effect's error channel.

**Outcomes** of `db.apply` and a compiled ChangeSet's `apply`:

- **`accepted`**: each written table's counts, and the read-backs.
- **`no-change`**: the read-backs.
- **`invariant-rejected`**: `refused`, the broken rules as your schema states them, and `witness`. Match a rule
  directly: `{ kind: "check", relation: "Grant", name: "WithinGrant" }`.
- **`outside-world`**: the role's table a row cannot belong to.

`refused.laws` is never empty. `refused.kind` says how grizzle decided them:

- **`every`**: each rule is decided broken. A row check refusing a row you stated names every rule of that table's
  checks the row breaks as the write fills it (counts, ends, indexes and copies at the values grizzle draws), once
  each, in canonical order (primary keys, then statements, as the snapshot lists them, however you wrote the schema),
  whichever check PostgreSQL tried first. A domain refusing a value of a row you stated names the rule of each field of
  that row it types whose value it refuses: a pattern rule names its relation and field, so of two fields of one
  pattern it names the one you broke, or both. Any other refusal names the one rule its constraint states.
- **`some`**: one PostgreSQL object that discharges two rules or more refused the write, and nothing grizzle holds says
  which: at least one is broken, maybe more. The object is a family's foreign key, which carries every containment
  merged into it, or a domain serving every field of one pattern or every contract of one definition, where grizzle
  judges no row you stated whole (a row a query computes, or a value it cannot evaluate on the host); a domain names
  the rules of the fields it types in the tables the statement writes.
- **`first`**: a row check refused a row grizzle cannot judge: one only PostgreSQL computes, which no ChangeSet states
  (a query's, or one grizzle fills on a family), a row you stated whose table has a check reading a value the host
  does not hold, such as a count or an end a put keeps from the stored row, or one of two rows you stated that grizzle
  cannot tell apart (see the witness below). It names the rules of the check PostgreSQL tried first, never more.
  PostgreSQL orders a table's checks by installed name, which no version of grizzle keeps, so the row may break others
  too, and another version may name another.

**Witness**: `{ kind: "key", relation, values }`, the key of one row that breaks the rule and never another column, or
`{ kind: "unreported" }`. A key (over a table or a side of one) that grizzle's own write statement finds broken, by two
rows you submitted or by a stored row inside or outside your role's view, is witnessed by the key you submitted, a
generated field at the value PostgreSQL computes. A row check, contract, pattern or generated field is refused by
PostgreSQL, which states the row only in its message, never read by grizzle: grizzle judges on the host the rows your
ChangeSet states for the refused statement (an inserted or put row, a query entry's row, a nested member) as the write
fills them, and the witness is the key of the first that breaks the rule. Either key is in the fields you wrote it in. The
witness is `unreported` for a foreign key, and where no row you stated breaks the rule: a row only PostgreSQL computes,
a query's, a rule reading a value the host does not hold or over what the host does not evaluate, or a row whose key
PostgreSQL draws. A family's owner that you insert and the write never reads, such as one with no members in the
ChangeSet or an ordered one, could be new or a stored one you insert again, which the write leaves as it is: grizzle
names it only where it is the one row of the refused statement that can break the rule, and where two such rows can,
the witness is `unreported`.

**Contracts and patterns.** The encoder checks only the base type, so a value its contract or pattern refuses is refused
by its domain's CHECK as the statement casts it, before the row's constraints and row-level security. The outcome names
the contract's rule or the field's pattern rule. Fields of one pattern share a domain, as do fields whose patterns
grizzle proves match the same texts, and PostgreSQL reports the domain, never the column, so grizzle judges the row on
the host to name the field, its rule spelled as that field spells its pattern:
`{ kind: "pattern", relation: "Item", field: "slug", source: "^[a-z-]{1,64}$", flags: "u" }`. A value PostgreSQL
generates into a refined field, or grizzle fills into a fold's accumulator or end, is refused the same way; its witness
is `unreported` where only a refill writes the row, such as a stored owner whose family the write appends to.

<details>
<summary>Every rule an outcome can name</summary>

| `law.kind`   | Its fields                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `primaryKey` | `relation`, `fields` (a span field makes it a no-overlap key)                                                   |
| `key`        | `side`: a key statement, a candidate key of its relation when its side reads every row and its terms are fields |
| `check`      | `relation`, `name`                                                                                              |
| `contained`  | `from`, `to`: a containment, foreign keys included; an `alternatives` statement and a `mirrors` are containments |
| `coverage`   | `from`, `to`: a containment whose sides pair a span field                                                       |
| `family`     | `order` (`"ordered"` or `"counted"`), `member` (a side), `slots` (`{ owner, count }`)                           |
| `tree`       | `member`, `slots`, `root` (the root field)                                                                      |
| `fold`       | `family` (its slots), `monoid`, `step` and `end` (sides)                                                        |
| `contract`   | `contract`                                                                                                      |
| `pattern`    | `relation`, `field`, `source`, `flags`: the field's pattern as that field spells it, one rule per field         |
| `generated`  | `relation`, `field`: a generated field whose term has no value at a row, a closed read at a key its relation lacks |

A side is `{ relation, terms, selection }`. `terms` are in the order the rule pairs them, each `{ kind: "field", field }`
or `{ kind: "pred", field }`; a containment's `from` may also hold `{ kind: "constant", value }` and read a term twice.
`selection` is `{ conjuncts }`, row predicates in canonical form (a literal second, `gt` and `ge` between two terms as
`lt` and `le`, `eq` and `ne` with their terms in canonical order, an IN list's values a set) and canonical order; a side
that reads every row has none.

</details>

`lawsOf(schema)` lists a schema's statements in declared order, its base's first, each with the rules an outcome names
when it is broken: one for a key, check, containment, family, tree or fold; two containments for a mirrors; an
alternatives statement's containments; none for `mutable`. Each call compiles the rules, so call it once and keep the
list. `sameLaw(a, b)` says whether two rules are one:
`refused.laws.some((law) => entry.laws.some((rule) => sameLaw(law, rule)))` says whether a refusal names a statement's
rule. `constraintNameOf(law)` is the name PostgreSQL holds a row check under, from its rule:
`constraintNameOf({ kind: "check", relation: "Grant", name: "WithinGrant" })` is `"within_grant"`, and a check
declared as `E1_derived` is `"e_1_derived"`. A direct writer's refusal by the check names it, so take it from grizzle
and never spell it.

`patternLawsOf(schema)` lists the pattern rules, which no statement states: one
`{ kind: "pattern", relation, field, source, flags }` per stored field whose pattern states one, spelled as that field
spells it, by relation name and each relation's fields in declared order. They are exactly the pattern rules an outcome
names. A pattern every text matches, such as `"^.*$"` under `"su"`, states none: grizzle drops it, and the column is
plain text. Neither does a contract's pattern, whose refusal names the contract, nor a closed relation's, whose rows the
schema fixes. It compiles the rules too, so call it once and keep the list.

**Errors**, by operation:

| Operation                 | Fails with                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `DbLayer.make`, `Db.open` | `OpenError`                                                                                                        |
| a read                    | `ReadError`: `ReadFailure`, `TransientFailure` or `StaleSnapshot`; a page also `CursorError`                       |
| a write or refresh        | `EncodingFailure`, `TransientFailure`, `TransportFailure`, `ExecutionFailure`, `CommitUnknown` or `StaleSnapshot` |
| `db.compile`              | `CompileError`                                                                                                     |

- **`reason`** is what happened, a tagged value, so `Effect.catchReason`, `catchReasons` and `unwrapReason` reach it:
  `Effect.catchReason("TransientFailure", "PutTargetConflict", f)` handles one case and keeps the rest. `stage` follows
  from the reason, and `message` is a sentence naming it; read details from the reason, never the message. Reasons are
  exported as types only. The exported classes are the errors, plus `CredentialError` and `TokenError`, which your
  `password` Effect and your `verify` fail with.
- **`TransientFailure`**: the attempt changed nothing and may succeed if run again. Its reason is `SerializationFailure`
  (40001), `Deadlock` (40P01), a concurrent transaction's work the statement met (`PutTargetConflict`,
  `GeneratedSerialUnique`, `SpanKeyChange`, `UnseenOccupant`, `ConcurrentRefresh`), or `StaleStatement`, a prepared
  statement the server no longer honors; `error` is the server's report. grizzle never retries: use `Effect.retry` with
  your own `Schedule`. `Db.open`'s retryable case is an `OpenError` with reason `AdmissionTransient`: open again.
- **`CommitUnknown`**: COMMIT was sent and no answer came, so the change may have committed. Read back before running
  it again.
- **`StaleSnapshot`**: the database is not at the `Db`'s snapshot, and the call ran nothing; its reason is `Migrating`
  or `Migrated` ([Deploying](#deploying)).
- **`TransportFailure`**: the connection failed before the write could commit, and nothing changed. A connection that
  can't be had (a failing `password` Effect, TLS, the server, a released layer) is this for a write, and `ReadFailure`
  at stage `acquire` for a read. Waiting for a session never fails: a call waits until it has one or is interrupted.
- **`ExecutionFailure`**: the server's error, a refusal before any SQL, or rows grizzle cannot read, whose `fate` says
  what the transaction then did.
- **`ServerError`** is on every error PostgreSQL raised: its `sqlstate`, its `message`, `detail` and `hint` exactly as
  the server gave them, and the `constraint`, `schema`, `table`, `column` and `dataType` it named; the error's
  `message` quotes the server's. The server writes in the language of `lc_messages`, the database owner's setting;
  grizzle reads an error by its SQLSTATE and the fields it names, never its words. These can quote the values a
  statement was given, though never a value outside the role's view, so what you log is your choice: grizzle logs
  nothing.

<details>
<summary>Every error reason</summary>

**`OpenError`**, by stage:

| Stage                       | Reason                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `credential`                | `CredentialError`                                                                                                                       |
| `tls`                       | `TlsRefused`                                                                                                                            |
| `authentication`, `connect` | `StartupRefused`, with the server's report (`authentication` for SQLSTATE class 28)                                                    |
| `connect`                   | `ConnectTimedOut`, `SocketFailed`, `ConnectionClosed`, `DriverRefused`, `NoCancelKey`                                                   |
| `released`                  | `LayerReleased`, a layer whose scope has closed                                                                                         |
| `config`                    | `DbConfigRefused`; `ConnectionEnvironmentRefused`, a process environment that sets `PGREPLICATION`                                     |
| `role`                      | `RoleOutsideLayers`, `LoginNameRefused`                                                                                                 |
| `token`                     | `TokenError`, `verify`'s refusal or throw (the throw is its `cause`); `ClaimRefused`, a payload that does not decode through the role's contexts, or a claim PostgreSQL refused |
| `schema`                    | `CompileError`; `WorkloadUngenerated`, a workload out of step with the snapshot                                                        |
| `capability`                | `MissingCapability`, a workload program needing an extension the database lacks                                                        |
| a check's stage             | `AdmissionRefused`, with every mismatch, at the first stage one is at                                                                  |
| `admission`                 | `AdmissionTransient` (`SerializationFailure` or `Deadlock`, the server's report its `error`), retryable; `AdmissionFailed`, no verdict |

**`ReadFailure`**, by stage:

| Stage                 | Reason                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `execute`, `resource` | the server's `ServerError` (`resource` for 53200 and 54001)                                                            |
| `acquire`             | a connection's or the pool's refusal, as for `OpenError`; `HandleReleased`, a `db.compile` handle used after its `Scope` ended |
| `transport`           | `ConnectionLost`, `CommitLost`                                                                                         |
| `driver`              | `DriverFailure`                                                                                                        |
| `decode`              | `UnreadableAnswer`: rows grizzle cannot read, or rows its compiled proof says the query cannot deliver                 |
| before any SQL        | `CompileError` (`compile`), `MissingCapability` (`capability`), `EncodingFailure` or `LawRejected` (`encode`), `InputTooLarge` (`resource`), `PageRequestRefused` (`request`) |

**`TransportFailure`**: a connection's or the pool's refusal, `HandleReleased`, `ConnectionLost` or `DriverFailure`.
**`ExecutionFailure`**: `ServerError`, `CompileError`, `MissingCapability`, `InputTooLarge` or `UnreadableAnswer`.

**`InputTooLarge`** is found on the host before the call's flight is sent. Its `bound`, which never counts rows:

- `message`: one statement's Bind message is longer than PostgreSQL reads (1,073,741,822 bytes,
  `PQ_LARGE_MESSAGE_LIMIT`), with the statement and its length. Split the input across calls.
- `literal`: one column of a relation input is an array longer than one JavaScript string holds (536,870,888 UTF-16
  code units), or for a bytes column longer than the message limit, with the input and its column. Split the input
  across calls.
- `familyRow`: one row a family write places, vacates or recounts is past one of those bounds alone, so no statement
  can carry it. Shorten the row's values.

**`CompileError`**'s reason holds where it refused, `at`, and:

| Reason                                          | Details                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MalformedDescription`                          | the rule `what` your schema or program breaks                                                            |
| `MalformedArtifact`                             | what grizzle reads back (the snapshot, a migration folder or its meta.json, the ledger's rows, a cursor) malformed at the path `at` |
| `UnsupportedOperation`, `UnsupportedLawFamily`  | a `capability` grizzle lacks, such as a parameter's value of a pattern no stored field declares, naming the parameter and the pattern ([Limits](#limits)) |
| `ResourceBound`                                 | its `bound`                                                                                              |
| `OutsideRole`                                   | the `role` and the `access` it doesn't hold                                                              |
| `DuplicateIdentity`                             | the `earlier` declaration                                                                                |
| `IdentifierCollision`                           | the `other` declaration and the `identifier` both convert to                                             |
| `DigestCollision`                               | two objects, `display` and `otherDisplay`, whose hashed names share the stem and digest of `identifier`; renaming a declaration either is built from gives it another |
| `LawOnDerived`                                  | its `relation`                                                                                           |
| `UnrepresentableKey`                            | the key and its `fault`                                                                                  |
| `PartialOperation`                              | an `operation` whose `precondition` on `operand` nothing proves, and the `guard` to write                |
| `RecursionRefused`, `DerivedRefused`            | their `cause`                                                                                            |
| `ForeignLevel`                                  | a rule over `over` (a schema or a role) reading a query written over `written`, none of `over`'s levels  |
| `RoleRefused`, `LoginRefused`, `ContextRefused` | the `rule` broken                                                                                        |
| `RoleNameTooLong`                               | the PostgreSQL `role` and its `limit`                                                                    |
| `GeneratedRefused`                              | the generated `field` of a `relation` and the `rule` it breaks                                           |
| `FoldOverProjection`                            | the match's `source` and the `key` it must bind for an aggregate to read each row once                   |
| `QueriedOwnerAppend`                            | an insert or put (`op`), at `at`, of the `owner` from a query beside an append of `member` to its `family` (`{ owner, count }`) |
| `CascadedCopyAppend`                            | a write (`op`) of `member` of its `family` whose `copy` reads its `owner`'s `through`, which the owner copies from `changed`, a relation the same stratum puts from a query, whose rows grizzle never sees |
| `StaleDerivedRead`                              | a write (`op`) of `member` changing a stored row's column (`changed`: `relation`, `column`, and `by`: `put`, `owner` or `member`), which the cascade carries into `copies`, read by `reader` (`{ kind, family, relation, column }`: a fold, a predecessor, a last or a tree's copy), which grizzle cannot refill for `cause`: `{ kind: "query" }`, a put from a query; `{ kind: "cycle", refills }`, refills reaching a family they refill again; or `{ kind: "immutable", relation }`, a refill of an immutable owner's family or an immutable relation's rows |
| `UnfillableField`                               | the `relation`'s `field`, the `law` filling it, the `source` column it reads along `axis` of its `family`, and why that column is filled `later` |
| `UnwritableRelation`                            | the `relation` no write fills, and its `cause`                                                           |
| `UnorderableStratum`                            | the `cycle` of a stratum's writes (`{ relation, op }`: an insert, put or delete, or a family's insert, update or delete of its members' rows or count of its owners), each of which immediate keys order before the next and the last before the first, so no order of the stratum's statements keeps them all |
| `UnstatedKey`                                   | a put or delete (`op`) of a `relation` whose `key` (`{ kind, fields }`: its primary key, or a declared one a put compares) holds fields grizzle writes (`unstated`) |
| `UndeclaredDrop`                                | the name a migration would drop, which no `--drop` or `--rename` declares                                |
| `MissingDiscriminant`, `AttachedParentUnbound`, `AttachedPage`, `DescribedHeadingMismatch`, `ContractLiteral` | a `capability` sentence |

**`EncodingFailure`**'s reason is its codec's fault word, never the value; its `place` is the `Slot` the value fills,
by `name`, or a whole `Fact`. **`CursorError`**'s reason is its cursor fault word.

</details>

## Transactions and concurrency

- **Every transaction is SERIALIZABLE.** The first migration makes it the database's default, so every session gets
  it, psql included. A write below it on a grizzle table is refused with 25000.
- **One call, one transaction, one round trip or two.** A call sends BEGIN, its statements and COMMIT in one pipelined flight.
  A write that must read stored values first (a family edit of a group already stored, or a refill of a value a change
  leaves stale) sends two flights in its one transaction: one batched read per family of the stored values the edit
  continues and one per way a change reaches a refilled family's groups, then the writes filled from them with COMMIT.
  There are no interactive transactions: a read that decides a write is a query inside the ChangeSet, and reads that
  must agree are one query with nested results.
- **No retries.** A refusal from outside the call's inputs is a `TransientFailure` (a migration's is `StaleSnapshot`)
  and changes nothing. Any transaction can meet a serialization failure, even with no other transaction in sight,
  because under load PostgreSQL's SSI summarizes old committed transactions and judges conservatively: treat it as
  retryable everywhere.
- **No server-side timeouts.** grizzle sets no `statement_timeout` or `lock_timeout`. Interrupting the Effect is the only
  cancellation: a call interrupted while its statements run sends one CancelRequest, within the connection's
  `connectTimeoutMs`, so the server stops the statement, then destroys the session's connection, which is never used
  again. Treat an interrupted write like `CommitUnknown`: if its statements had all finished, it may have committed.
- **Predicate locks are the operator's to size.** Set `max_pred_locks_per_transaction = 2048`; without room, PostgreSQL
  fails transactions with 53200, which is not retryable. Keep every transaction on the cluster short: a committed
  write's predicate locks are kept until every older transaction ends.

## Deploying

Build each `DbLayer` once per process. Building it parses the snapshot, compiles the login's roles and every workload
program for every role it runs on (the compilation `grizzle generate` ran), and checks the workloads' index needs
against the snapshot. It fails with an `OpenError` at stage `schema` for a snapshot that does not parse or was edited by
hand, a schema that is not the snapshot's, a role or program that does not compile, or a workload program added,
renamed, removed or changed since `grizzle generate`; the error names the program and says to run `grizzle generate`.

Open a `Db` per request or handler. Before it yields, `Db.open` checks the database in one round trip of a few catalog
reads, by stage, in this order:

- **`version`:** PostgreSQL 19.
- **`locale`:** the database UTF8 with the builtin `C.UTF-8` locale.
- **`capability`:** the extensions the schema needs installed.
- **`ledger`:** no migration running or stopped part-way, and the latest complete one at the snapshot's fingerprint.
- **`settings`:** the database's default isolation SERIALIZABLE, and the login's and the role's settings exactly as the
  snapshot installs them. Every login's own defaults pin its sessions, each a setting a grizzle guarantee rests on:
  `search_path = pg_catalog, pg_temp`, `extra_float_digits = 1`, `DateStyle = 'ISO, YMD'`, `bytea_output = hex`, and
  `lc_monetary`, `lc_numeric` and `lc_time` at `C.UTF-8`; a login whose roles search vectors also
  `hnsw.iterative_scan = strict_order`. A role's own default outranks the database's and the server's, so neither
  reaches a `Db`'s sessions, and a login with one missing, changed, or set for it in this database alone is refused.
  Every session of the login's pool also sends them as startup options, so the environment's `PGOPTIONS` never reaches
  it, and `DbLayer.make` refuses a process environment that sets `PGREPLICATION` (stage `config`). Every other setting
  is the database owner's, on the database or the server, JIT among them: on a server built with LLVM,
  `jit_above_cost` can make a large statement compile its plan to machine code first.
- **`privileges`:** the login's and the role's privileges exactly as the snapshot installs them, and the policies
  naming the role the snapshot's, by table and name. The login is LOGIN NOINHERIT and the role NOLOGIN, neither with
  SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS. A role's members are its login and the migration role; any
  other membership of the login confers nothing, and a membership fault refuses every role of the login. Row-level
  security is enabled, not forced, on every table the role writes through a query entry that leaves rows out.

`Db.open` does not compare view definitions, policy expressions or the owner's default privileges: `grizzle migrate`
and `grizzle drift` do. A value that is not a role reached through its login is refused at stage `schema`. Otherwise a
refusal is an `OpenError` at the first stage that fails: `role` (no provided layer holds its login), `schema` (the
token is not a string), `token` (`verify` refused or threw, or the payload does not decode through the role's
contexts), the connection's `credential`, `tls`, `authentication`, `connect` and `released`, then the checks above, or
`admission` when they reach no verdict, and `token` again for a claim PostgreSQL refuses.

**Migrations are downtime.** Each migration file takes the ledger's exclusive lock, which waits for the transactions in
flight. From the first file until the last commits, and while a stopped run leaves a folder unfinished, every `Db` call
fails at once with `StaleSnapshot` (reason `Migrating`) before any statement runs, and every `Db.open` is refused at
stage `ledger`. After the migration, a `Db` opened at the old snapshot fails with `StaleSnapshot` (reason `Migrated`),
and keeps failing: deploy the code that carries the new `snapshot.json` and open new `Db`s with it.

**Each transaction checks the snapshot.** Every transaction a `Db` sends starts with two statements in the same round
trip: one takes the ledger's lock without waiting, so a running migration refuses it at once and the app never waits;
one checks the snapshot and takes on the role and the claims for that transaction only. A pooled connection never
carries one request's role or claims into the next. An apply with nothing to write still sends BEGIN, those two
statements and COMMIT, so a stale `Db` never answers `no-change`.

**Vercel.** `attachPool: attachDatabasePool` hands each pool to Vercel, as the example does, so it closes idle
connections before an instance suspends. grizzle depends on no platform's package.

**RDS with IAM authentication.** The password is an Effect that signs a token for each connection attempt;
`@aws-sdk/rds-signer` signs locally, without a network call. Grant the login `rds_iam` with
`GRANT rds_iam TO <login role> WITH INHERIT TRUE, SET FALSE`, the login role being `<schema>__<login>`. `Db.open` and
`grizzle drift` judge what a login can do, not how its memberships are spelled: a membership beyond the login's roles is
admitted when it carries SET FALSE and no ADMIN and the login's privileges on the installation stay exactly its own
(USAGE on the schema, SELECT on the ledger). `rds_iam` holds nothing in the installation, so it is admitted; a
membership that would hand the login any privilege or ownership there is refused. This has not been run against RDS.

```ts
import { Signer } from "@aws-sdk/rds-signer"
import { Redacted } from "effect"

/** The login's PostgreSQL role, `<schema>__<login>`. */
const etlJobRole = Config.String("BLOG_ETL_ROLE")

export const RdsEtlLayer = DbLayer.make({
	...connection,
	login: EtlJob,
	snapshot,
	pool: { max: 2, min: 0, idleTimeoutMs: 5_000 },
	password: etlJobRole.pipe(
		Effect.mapError((cause) => new CredentialError({ cause })),
		Effect.flatMap((username) =>
			Effect.tryPromise({
				try: () =>
					new Signer({
						hostname: "db.internal",
						port: 5432,
						region: "us-east-1",
						username
					}).getAuthToken(),
				catch: (cause) => new CredentialError({ cause })
			})
		),
		Effect.map(Redacted.make)
	)
})
```

## Direct SQL access

psql, scripts and other services may write grizzle's tables directly, under the same rules and roles as the app. Log in
as a login, `SET ROLE` to one of its roles, set the claims in the transaction for a role that reads them
(`SELECT set_config('grizzle.claims', '{"Session":{"sub":"user_123"}}', true)`), and write at SERIALIZABLE.
A readable name spells what it is, and `constraintNameOf(law)` gives a row check's from its rule
([Errors and outcomes](#errors-and-outcomes)); `grizzle names` lists each hashed one with its COMMENT, which says what
it is, read offline from the committed snapshot. PostgreSQL answers:

| SQLSTATE            | When                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 42501               | a table outside the role; a row its filter refuses; an UPDATE of an immutable table, or through a query entry of a column outside it, in a key or fixed by a claim |
| 42501               | `SET ROLE` to another login's role or the owner; `SET SESSION AUTHORIZATION` to anyone but the login; a call of another role's filter or probe function, or of the advance function of a table the role does not write |
| 22023               | `SET ROLE` or `SET SESSION AUTHORIZATION` to a role that does not exist                                                                                      |
| 428C9               | an UPDATE of a serial column, before any privilege check                                                                                                     |
| 25000               | a write below SERIALIZABLE                                                                                                                                   |
| 23502               | a NULL in a column, such as one an INSERT leaves out that is neither serial nor generated (every column a writer supplies is NOT NULL, a family's hidden ones included); a generated field whose term has no value at the row, a closed read at a key its relation holds no row at; each reported by its table and column alone |
| 22P02, 22003, 23514 | a `grizzle.claims` setting PostgreSQL cannot read, where a statement reads it (below)                                                                         |
| 23514               | a row check, a family's CHECK or a rule over a closed relation, each named by its rule; a value its contract or pattern refuses, or a code or set its roster's domain refuses, as the statement casts it, before row-level security and the row's constraints |
| 23505               | at the statement: a duplicate key, over a table or over a side of one, an exact repeat included; or a key a concurrent transaction committed after this one's snapshot, which is retryable |
| 23P01               | at the statement: an overlap under a no-overlap key; or a span a concurrent transaction committed after this one's snapshot, which is retryable               |
| 23503               | a foreign key, a containment between sides included: at COMMIT when deferred (below), at the statement otherwise                                             |
| 40001, 40P01        | a serialization failure or a deadlock: run the transaction again                                                                                             |

- **Deferred foreign keys:** a family's key as its proof needs (a counted family's predecessor key, every last-slot
  key, an owner key a cascade feeds); a family's key a refill writes around (the owner key of every family whose
  members a refill can rewrite or whose owner a put or a delete can re-place, and the predecessor key of an ordered
  family or tree and a tree's owner key a refill rewrites); any key on a cycle of the foreign keys that order a write's
  statements, a family's owner key among them, as a containment from an owner into its members closes one; and any
  other whose target has a field that is not one of the columns it references.
- **The claims setting** is readable exactly when it has the shape a `Db` writes: empty, or a JSON object with no key
  repeated at any depth whose every member is an object of JSON strings. Anything else, non-JSON text included, is
  22P02 with constraint `grizzle.claims` and DETAIL `c[]`. A context's member holding other keys than exactly its fields
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
- **Spellings are not values.** A writer may store `-0` in a float or vector field; grizzle reads it as `0`, and no
  query result depends on the spelling stored. A key holds one fact per value: `[-0,1]` and `[0,1]` in a vector key
  field collide (23505).
- **Serial columns** draw their identity default with no sequence privilege. A writer that inserts explicit serial
  values (`OVERRIDING SYSTEM VALUE`) calls the field's advance function in the same transaction, as grizzle does, so a
  later generated value never repeats a stored one: `SELECT <schema>.<advance function>(<largest value inserted>)`.
- **A login without `SET ROLE`** holds only USAGE on its schema, SELECT on the ledger, and EXECUTE on the snapshot
  guard, the lock and the check that `Db.open` and every `Db` transaction take.
- **The owner and superusers bypass** every rule and role, and the owner is reserved for migrations.

## Security model

- **The login is the boundary.** Whoever holds a login's password can open any of its roles with any claims: a claim
  is what `verify` returned, and PostgreSQL cannot check a token's signature. The web login can be any user of the web
  app, but it never reaches `PostViews`, which only another login's role writes. Give each trust domain its own login.
- **Claims are verified once, then decoded.** `verify` decides the token. grizzle decodes the value it returns, never
  the token's JSON text (so a key the token repeats is `verify`'s to refuse), through the contexts' fields. A present
  claim object missing a field or holding a value its field's encoder refuses (a text holding NUL or a lone surrogate
  among them) is refused at stage `token`, before the database is checked. A claim's pattern or contract is
  PostgreSQL's to judge: `Db.open`'s round trip asks, and a claim it refuses is refused at stage `token` once the checks
  pass. The transaction's setting holds the decoded claims, one member per context that has a row,
  `{"<Context>":{"<field>":"<text>"}}`, each holding exactly its context's fields as JSON strings. It never holds the
  token, and it ends with the transaction.
- **PostgreSQL enforces every role.** A role holds no privilege on a table it does not write, and reads through views in
  its own schema. A table some role writes through a query entry that leaves rows out is under row-level security, with
  a policy for each role that writes it: the entry's filter, or true for a role that writes every row. A table every
  writer writes whole has no row-level security and no policy, since each policy would be true: the grants alone decide
  its writes. A query entry's view is a security-barrier view; a whole-table entry hides nothing, so its view is plain
  and PostgreSQL plans through it onto the table's indexes. On a table under row-level security, constraint messages
  omit row and key detail.
- **What a role can learn.** Rules hold across the whole database. A delete refused by a comment you cannot see, or a
  limit that counts rows outside your view, tells you such rows exist; a collision at a key tells you a row exists at
  the key you submitted (one overlapping the span you submitted, for a no-overlap key), never any of its other columns.
- **Not offered.** A write-only role (an insert reads its rows back), a browser connecting straight to PostgreSQL (which
  cannot verify an RS256 token), and a role in two logins.
- **The owner bypasses every role.** The migration role owns the tables and bypasses row-level security. It is for
  migrations, never for the app.

<details>
<summary>Exactly what a role holds</summary>

- USAGE on the schema, its own schema, the vector extension's schema when a column it reads or writes is a vector, and
  exactly the domains its columns use: its rosters' and sets', and its contracts' and patterns', down each contract's
  base.
- SELECT on its views, and on no materialized view.
- On a table it writes through a whole-table entry: SELECT, INSERT and DELETE, and UPDATE when the table is mutable.
- On a table it writes through a query entry: column SELECT and INSERT on every column, column UPDATE (when the table is
  mutable) on each of the entry's columns outside every key that no claim fixes directly, and DELETE; never table-level
  SELECT, INSERT or UPDATE.
- On the owner of a family whose member it writes: column SELECT on what grizzle reads of the owner to fill the family
  (its key, its count and ends, and the fields its members copy), and, when the owner is mutable, column UPDATE on that
  family's count and ends; nothing else of the owner unless its `write` lists the owner.
- EXECUTE on:
  - one key probe (a function that looks a key up across the whole table) per key of such a table, and one unique
    probe per key over a selected side or a `pred` term whose collisions no other probe finds, for each writable query
    entry;
  - the entry's filter function, exactly when its filter reads a table besides the written row;
  - the advance function of each serial column of a table it writes;
  - the refusal function, when it writes or reads a context, which only raises, in the caller's own statement;
  - every constant a statement it runs evaluates, since PostgreSQL checks EXECUTE as the invoker: each constant reached
    through constants' bodies and through the CHECKs of every domain a value is written or cast into (a roster's names
    constant, a set's live constant), from the domains of its columns, from every CHECK, generated field, default and
    index of a table it writes, a cast into a domain inside them included, and from its policies and its views; and
    the closed constants its queries read.
- MAINTAIN on the materialized view of each derived table its `refresh` names.
- Nothing else: no TRUNCATE, no sequence, and no other role's view or function.

</details>

## Limits

grizzle fits applications that own their data end to end, with rules worth declaring and users who see different slices of it.

### Scope

- **PostgreSQL 19 only**, tested on 19rc1 with the two patches under [PostgreSQL known issues](#postgresql-known-issues); **Node 26 or later**; **Effect 4.1**.
- **grizzle owns the database.** Existing schemas, and tables created outside its migrations, are not supported.
- **No nullable columns, outer joins, window functions, SKIP LOCKED or raw SQL at run time.** A query is written in grizzle's query language or not at all.
- **No interactive transactions and no retries.** A transaction is one call; you retry `TransientFailure` yourself.
- **No PgBouncer, no LISTEN/NOTIFY and no browser connections.** A browser cannot reach PostgreSQL directly; a server runs `verify`.
- **The login is the trust boundary.** Anyone with its password can act as any of its roles, with any claims.
- **Tables are immutable by default.** `mutable(T)` opts one in to in-place updates.
- **Derived tables are refreshed explicitly**, with `db.refresh`.
- **Migrations are downtime.** No `Db` call runs while a migration is being applied.
- **RDS IAM authentication** has not been run against RDS.

### Values

- **No timestamp type.** An instant is a bigint contract. A `date` holds 0001-01-01 to 9999-12-31; a lexical form has no timezone, so a timezoned `xs:date` has no typed value.
- **A span is over `integer`, `bigint`, `date` or a contract over one** (int4range, int8range, daterange), never `smallint`, which PostgreSQL has no range over. A date span's ends are `CalendarDate`s within 0001-01-01 and an excluded 9999-12-31, as an integer span's excluded end is at most its type's greatest value; its width is a `number` of days.
- **A numeric field declares its precision and scale**, `pg.numeric(p, s)`: p at most 1,000, s within ±1,000, NaN but no infinity. A computed numeric (a sum, a mean, an operation's result, a derived field) carries the digits its computation proves; past 131,072 integer digits, PostgreSQL's limit, it is `ResourceBound` at compile time. `Compute.numeric(x)` is `x::numeric` of an integer, money or a float, a float to the 6 or 15 significant digits PostgreSQL writes.
- **A parse reads integer, numeric(p, s), double precision, boolean and date forms.** A numeric form has at most 255 digits either side of its point; a double's, 15 significant digits either side and an exponent of at most 293, so float8in neither overflows nor underflows. An `xs:duration` has no typed value, since PostgreSQL's interval orders 1 month as 30 days.
- **A vector's norm lies in the cosine domain, 2^-68 to 2^63**, where pgvector's single-precision `cosine_distance` is in [0, 2], never NaN, for vectors of up to 16,000 dimensions. A vector outside it is refused when it is encoded, and by its column's CHECK from any writer.

### Patterns and text

- **A `str.regex` pattern has no lookahead, lookbehind or `\p{…}` class**, nor any other construct [Tables and types](#tables-and-types) excludes, and some text must match it.
- **A pattern is bounded by the automaton PostgreSQL compiles from it**, not by its length. grizzle refuses with `ResourceBound`, at compile time, a pattern past its measures of PostgreSQL's compile space (`REG_MAX_COMPILE_SPACE`, beyond which PostgreSQL says "regular expression is too complex"): 4,096 positions once counted repetitions are written out, 65,536 pairs of positions joined by empty paths, 8 anchors, or 8,192 for anchors times positions. The measures sit inside PostgreSQL's limit. A counted repetition's bound is at most 255. Each pattern a `Compute.matches` term can take, a closed relation's dictionary values included, is bounded alike.
- **A parameter is checked against its contract and pattern at bind**, before any SQL (`EncodingFailure`, `refinedValue`), so a query delivers a parameter's value, or a relation parameter's field, as bound, whatever its pattern. A computed value not proved inside its pattern goes through the pattern's domain, which exists only for a pattern the installation declares: on a stored field, a closed relation's field, a derived table's column, a role's view column or a context field. Any other is `UnsupportedOperation` when the query compiles, naming the pattern.
- **PostgreSQL keeps a backend's last 32 compiled regular expressions** (`MAX_CACHED_RES`), so rows that cycle through a dictionary of more patterns compile one per row. On 19rc1 (an Apple M-series laptop under load; 200,000 rows; dictionaries of 1 to 178 patterns; median of three runs) a row costs 1.4 to 4.9 µs grouped by pattern or cycling through 32 patterns or fewer, and 80 to 102 µs cycling through 33, 64 or 178; the CASE that reads each source's translation adds about 1 µs a row at 178. A family write orders each statement's rows by pattern, so each compiles once per statement. Order other bulk reads and writes by pattern where you can.
- **A concatenation is at most 1 GB** (`MaxAllocSize`). A write whose check or generated field concatenates more with `Compute.concat` fails with "invalid memory alloc request size". No query concatenates, and folds and equations never build theirs.
- **A translation or a regex reads at most 268,435,454 bytes**, four bytes per byte within `MaxAllocSize`. Past it, a write's check or generated field that translates fails with "requested length too large" (54000), and a check, selection or generated field that matches or collapses, a `str.regex` field's domain CHECK included, with "invalid memory alloc request size". A query translates, matches or collapses only a text its pattern bounds within the limit.

### Keys and indexes

- **Every key fits its index entry for every value its fields admit**: a primary key, a declared key, a key over a selection, the UNIQUE a containment references where its target's columns are no declared key, a family's own UNIQUEs, and each family axis's UNIQUE with the copies it carries, a fold's running values among them. Each has at most 32 columns (`INDEX_MAX_KEYS`) and a B-tree entry of at most 2,704 bytes (`BTMaxItemSize`) counted from its columns' types, so a text column needs a bounded pattern or a contract bounding its `charLength` or `octetLength`. A key past either is `UnrepresentableKey` when the schema compiles, naming each column's counted bytes, not PostgreSQL's 54000 at the first write.
- **A family axis carries only bounded values.** A `Monoid.concat` fold's accumulators are text of a bounded pattern, such as `str.regex("^.{0,64}$", "su")`. An `or` or `twos` fold's set is its roster's `bit(n)`, `n` every code the roster has minted, removed handles' included, in whole hex digits, sized when `generate`, `check` or `migrate` compiles the installation, so a roster grown and pruned past about 21,000 codes refuses the UNIQUE there.
- **A containment's reverse index never refuses free text.** grizzle indexes the lookup of referencing rows by a B-tree over the longest leading run of bounded referencing columns whose entry fits, or, with no such run, a hash index on one referencing column, whose entry is a 4-byte hash code. A PERIOD reference's GiST index holds the longest leading run of bounded scalars that fits a GiST page, then the span. Only the referenced UNIQUE must be bounded. With no fitting run and every referencing column of a type no hash index takes (money, a set's `bit(n)`, a vector), the containment is `UnrepresentableKey` when the schema compiles.
- **A containment's source is one table or a selection of it.** A containment whose source is a join, such as the rows of R that have a matching row in S, is not supported yet.

### Families and ChangeSets

- **A relation is a member of at most one ordered family or tree**, which orders it, and of any number of counted families ([Families](#families)). A tree is written whole, its root inserted with the tree nested. A put or a delete of a member that owns an ordered family or a tree is refused, since it would not reach the rows nested under it.
- **An owner inserted or put from a query cannot share a ChangeSet with appends to its counted family** (`QueriedOwnerAppend` when the ChangeSet compiles): grizzle computes the owner's final count and folds' ends from the facts the ChangeSet states, and a query's facts exist only in its statement. State the owner's facts as an array or a `Stream`, or write the owner in a ChangeSet that `ChangeSet.sequence` runs first. A write whose every fact carries a stored owner's key inserts no owner, and compiles.
- **A put or a delete names its rows by their primary key**, so no ChangeSet puts or deletes a relation whose primary key holds a field grizzle writes, such as a sequence member keyed by its owner and drawn index. A put also compares its facts at every declared key, so a declared key over such a field refuses puts but not deletes. Such a write is a type error, and from JavaScript `UnstatedKey` when the ChangeSet compiles, naming the key. Key such a member by a field its caller writes, such as an id, declare no key over a field grizzle writes, and insert a sequence nested under its owner.

### Sizes

`messageMaxBytes`, `maxStringLength` and `bytesMaxLength` are exported as `Limit` values, whose `.value` is the number.

- **A `bytes` value is at most 268,435,443 bytes** (`bytesMaxLength`), which keeps its hex text one string. A longer one is `EncodingFailure` before any SQL, and every bytes column's CHECK refuses it.
- **A statement's parameters are at most 1,073,741,822 bytes** (`messageMaxBytes`, PostgreSQL's `PQ_LARGE_MESSAGE_LIMIT`), **and an input column's array literal at most 536,870,888 UTF-16 code units** (`maxStringLength`, V8's longest string, 2^29 − 24). A relation input is one array per column, sent again to each statement that reads it. A call past either bound is `InputTooLarge` before anything is sent.
- **A generated text is at most 536,870,888 UTF-16 code units**, about 512 MiB of ASCII: each SQL statement, migration file, `snapshot.json` and fingerprint text. `generate` and `check` refuse a schema past it with `ResourceBound`.
- **A closed relation is as large as its key's code space**: a cell per combination of its key fields' codes, written in its migration as one hex literal of a digit per four bits of code space times its cell's bits, whatever its rows. Prefer dense coordinates, such as slots, whose space is each owner's counts, to a sparse product of rosters ([Closed relations](#closed-relations)). Its constant has at most 2,147,483,640 bits, PostgreSQL's longest bit string, payload codes whose product is at most 2,147,483,647, the most a cell read as an integer holds, and a literal of at most 536,870,888 digits. Past any, the schema is `ResourceBound` when it compiles, the literal's as `stringLength`. `grizzle check` refuses a literal its comment or its function's name does not digest, naming the first cell that differs from the declared rows, and that cell's key.
- **PostgreSQL's own limits are `ResourceBound` where grizzle emits what they bound**: a table's 1,600 columns, a relation's generated rule columns included (checked when its schema compiles), as for a view, a derived table or a write's temporary table; a select list's 1,664 entries; and a statement's 1,073,741,822 bytes and 65,535 parameters (a 16-bit count). Dropped columns count toward the 1,600, so PostgreSQL itself refuses an added column past them. A row must fit one 8 KB heap page once its long values are stored out of line, which PostgreSQL checks when it writes the row.
- **A page size is any safe integer of at least 1.** A cursor is at most 268,435,455 characters, the bound of its layout's four-byte varints. A page one of whose cursors would be longer fails with `CursorError` `cursorTupleOversized`, and a longer cursor sent back is `cursorOversized`.

## PostgreSQL known issues

**Recursive queries on an unpatched 19rc1.** Upstream commit 8f29467c removed the hash_mem clamp on an executor hash table's initial size, so on an unpatched 19rc1 a recursive query (`query(S).recursive(...)`) with a large estimated result can stall at executor start zeroing a hash table of many gigabytes, under plain EXPLAIN and `db.explain` too. Neither `statement_timeout` nor cancellation interrupts it. Only recursive queries are affected. PostgreSQL restored the clamp for 19rc2 ([BUG #19759](https://postgr.es/m/19759-acd3f33402e54f36@postgresql.org), commit 747dbf30d1); the repository's build applies that fix to 19rc1 as [scripts/pg/patches/19rc1-recursive-union-hash-mem.patch](scripts/pg/patches/19rc1-recursive-union-hash-mem.patch) until the repin to 19rc2.

**Imprecise GiST indexes over multibyte text.** Through PostgreSQL 19, btree_gist prices a UTF8 text key by the byte after the common prefix of its subtree's bounds, cut at a character boundary, so characters that share leading bytes, such as the CJK Unified Ideographs, price alike, and a GiST index led by such text is imprecise: a point lookup takes 14 buffers for one row of 20,000 two-ideograph keys, where ASCII keys take 3. grizzle builds such an index only for a no-overlap key or a span filter whose text field comes first. It stays valid; only its lookups cost more. PostgreSQL's master branch fixes this in commit b82d69abf6, for PostgreSQL 20, where the lookup takes 3 buffers; rebuild an older index there.

**CHECKs and generated columns re-planned per statement.** Stock 19rc1 parses and plans every CHECK and stored generation expression in each statement that needs it, calling each IMMUTABLE function it reads and copying the result in. A closed relation is installed as such a function ([Closed relations](#closed-relations)): on one-row INSERTs into a bare table, a CHECK over a 33 KB constant adds 13 µs, one over 128 KiB 20 µs, and a generated column over 128 KiB 22 µs. The repository's build plans them once per relcache entry, as PostgreSQL does index expressions and domain checks ([scripts/pg/patches/19rc1-relcache-planned-check-and-generation.patch](scripts/pg/patches/19rc1-relcache-planned-check-and-generation.patch)), for 0.4 to 1.2 µs each, whether the constant is 363 bits or 128 KiB. A roster's domain is unaffected: a domain's check is planned once per backend. Only the cost differs, never the behaviour. The patch is grizzle's own and in no PostgreSQL release, so every repin carries it.

## Status

grizzle 1.0.0-beta.1 is the first public beta, published on npm under the `beta` tag. It is tested against PostgreSQL 19rc1, patched as above; PostgreSQL 19 GA is due 2026-11-19. The test suite runs on macOS against that pinned build.

There are no stability guarantees. Every release is a hard cutover, with no deprecations and no compatibility path for the API, snapshots or migration files.

## Development

Everything runs natively on macOS through Homebrew, with no Docker. Development has no build step: Node runs each package's `src/*.ts` directly, resolving the packages' names to their `src/` through the `grizzle-source` export condition. `pnpm build` emits each package's published `dist/`; packing or publishing a package runs it first.

```sh
pnpm install
pnpm pg:build                     # build the pinned PostgreSQL 19rc1 from source, with its patches and pgvector
pnpm pg:init                      # create the local cluster on port 5433: TLS and SCRAM only
pnpm pg:doctor                    # the go/no-go check of the cluster
pnpm test                         # the unit and types tiers, which need no network
pnpm test:network                 # the pg and schedules tiers, against the local cluster
pnpm test <file>                  # some files
pnpm check                        # the gate (turbo, cached): typecheck, superlint, oxlint, format, fallow, dedupe
```

Every generated suite draws from one seed, `TEST_SEED`, which a run prints first. Setting it reproduces a run, and whether a suite reaches what it requires never depends on it. [CONTRIBUTING.md](CONTRIBUTING.md) has the code rules and how the tests are built on the testing library.

## Repository

- `packages/engine/`: `@bjornpagen/grizzle-engine`, the compiler: schemas, roles, rules, queries and ChangeSets to SQL, the migration drafter and the snapshot.
- `packages/grizzle/`: `@bjornpagen/grizzle`, which re-exports the engine's API and adds:
    - `src/adapter/`: the runtime over node-postgres in pipeline mode: `Db.open`, reads, writes, pages, `migrate` and `drift`.
    - `src/cli/`: the `grizzle` command line.
    - `skills/grizzle/`: the agent guide the package ships.
- `test/`: the unit, pg, schedules and types tiers, and their support in `test/support/`.
- `bench/`: performance gates.
- `scripts/pg/`: the pinned PostgreSQL build, cluster, doctor and patches.
- `scripts/dev/`: the mutation tester and the profiler.
- `packages/devtools/`: the lint tooling: the oxlint preset and plugin, superlint and the tsconfig base.
- `packages/testing/`: `@grizzle/testing`, the testing library every test runs on, and `pnpm fuzz`'s script.

## License

[0BSD](LICENSE).
