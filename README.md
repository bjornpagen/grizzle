# grizzle

Describe your data, its rules and who may see it, in TypeScript. grizzle compiles it into PostgreSQL.

You declare your tables, the rules your data must always obey, what each kind of user may read and write, and the
queries and writes your app runs. grizzle turns that into the database objects a PostgreSQL expert would set up by
hand (constraints, triggers, roles, views, row-level security and indexes) and into SQL compiled ahead of time, with
exact result types. PostgreSQL then enforces all of it, for your app and for anything else that connects. Every call is
one SERIALIZABLE transaction in one round trip, and every failure is typed.

[Agent guide](packages/grizzle/skills/grizzle/SKILL.md) · [Contributing](CONTRIBUTING.md) ·
[npm](https://www.npmjs.com/package/@bjornpagen/grizzle)

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

Three tables, a roster of statuses and two foreign keys: `contained(on(Comment, "post"), on(Post, "id"))` reads "every
comment's `post` is some post's `id`". A query is made of rules: `v(Post, "post")` makes one variable per column, in
a scope named `post`, `r.match` binds them to a table's rows, `.where` filters, `.find` picks the columns, and
`.attach` nests a child query in each row. `postPage` takes one parameter, `id: Uuid`, and its rows are typed from the
query itself, the nested comments included. A `Uuid` is a uuid's hyphenated spelling as a type: a uuid literal or
`crypto.randomUUID()` is one as it is, and a plain string becomes one through `Uuid.parse`:

```text
{
  readonly id: Uuid
  readonly title: string
  readonly body: string
  readonly comments: ReadonlyArray<{ readonly id: Uuid; readonly author: string; readonly body: string }>
}
```

Because `id` is the primary key, grizzle knows `postPage` returns at most one row, so `db.get(postPage, { id })`
compiles and returns an `Option` of that row. On a query that can return several rows, `db.get` is a type error.
Nothing here is annotated by hand, and there is no `` sql`…` `` to fall back to.

## Coming from Drizzle

Drizzle is a thin, typed layer over SQL, and that's its appeal: what you write is close to what runs. On a large app,
that closeness turns into three recurring costs.

1. **You still design the database by hand.** The tables are typed, but foreign keys, CHECKs, triggers, indexes and
   row-level security policies are yours to write, in SQL or in a SQL-shaped API, and to keep in step with the code.
2. **Type inference stops where queries get interesting.** Selects and joins infer well. Aggregates, subqueries,
   unions and nested results often end up in `` sql`…` `` with a result type you write yourself, and nothing checks
   that type against the query.
3. **Business rules and permissions live in app code.** "A member sees only their organization's drafts" and "a show
   never sells more tickets than it has seats" become `where` clauses and `if`s in handlers. Every code path has to
   remember them, and so does every other writer: a script, a psql session, a second service.

grizzle starts one level up. You say what the data is, what must stay true of it and who may see it; grizzle writes
the SQL, and PostgreSQL enforces the result.

|                         | With Drizzle                                                | With grizzle                                                                       |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Tables                  | `pgTable(...)`                                              | `relation(...)`, with no nullable columns                                          |
| Rules beyond FK, unique | triggers you write in SQL, or checks in app code            | declared beside the tables, compiled to PostgreSQL's own constraints               |
| Who sees which rows     | `where` clauses in app code, or RLS policies written in SQL | roles declared in TypeScript, compiled to views, grants and row-level security     |
| Complex queries         | often `` sql`…` `` with a hand-written result type          | one query language, every result type inferred, nested results included            |
| Indexes                 | declared by hand                                            | derived from your rules and from the queries your app runs                         |
| Transactions            | interactive, at the isolation level you pick                | one SERIALIZABLE transaction per call, sent in one round trip                      |
| Migrations              | drizzle-kit generates SQL from your schema changes          | `grizzle generate` drafts SQL from your schema changes; you review it and commit it |

grizzle is opinionated in return: PostgreSQL 19 only, no nullable columns, no outer joins or window functions, no
interactive transactions and no raw SQL at run time. Read [Limits](#limits) before you adopt it.

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

## Hard in Drizzle, one declaration here

Eight things a large app needs, each in three parts: what it takes with Drizzle, the grizzle code, and what you get.
The grizzle code typechecks in the test suite, like every `ts` block on this page, and each generated statement shown
is `grizzle generate`'s output for that code, abridged where marked. Each showcase continues the opening block, with
its `ClerkUser`, `ClerkOrg`, `Title` and `Prose`, and imports what it adds. Most come from an LLM API platform:
organizations, API keys, metered calls, credits and invoices.

1. [Every organization sees only its own rows](#1-every-organization-sees-only-its-own-rows)
2. [Top three per group, with exact types](#2-top-three-per-group-with-exact-types)
3. [A tree of any depth](#3-a-tree-of-any-depth)
4. [No double booking](#4-no-double-booking)
5. [A budget no burst of requests can overdraw](#5-a-budget-no-burst-of-requests-can-overdraw)
6. [Books that always balance](#6-books-that-always-balance)
7. [States that carry their own data](#7-states-that-carry-their-own-data)
8. [A usage page: cursors, a rollup and their indexes](#8-a-usage-page-cursors-a-rollup-and-their-indexes)

### 1. Every organization sees only its own rows

**The task.** A dashboard where members manage their organization's API keys, and never see or create another
organization's.

**With Drizzle**, the usual answer is `where(eq(apiKey.orgId, orgId))` in every query and `orgId` in every insert, and
one forgotten clause leaks. Moving the rule into PostgreSQL means writing it in SQL: `pgPolicy` declares a policy, but
its condition is a `` sql`…` `` string, and every request has to set the claim inside the transaction its queries run
in.

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

**With grizzle:**

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

**What you get.** The app's queries and writes are written over `KeyAdmin`, where `ApiKey` already means "this
organization's keys", with rows `{ id: Uuid; name: string }`. There is no `where` to forget, and no `org` to pass:
inserting `{ id, name }` stores the caller's organization, and deleting another organization's key does nothing.
`Db.open(Dashboard.roles.key_admin, ...)` doesn't compile without a token. The rule lives in PostgreSQL, so psql meets
it too:

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

The [example](#example) walks through roles, logins and Clerk tokens in full.

### 2. Top three per group, with exact types

**The task.** A billing page: each workspace's spend, and its three costliest models with their call counts, leaving
out refunded calls.

**With Drizzle**, this is the kind of query that ends up in `` sql`…` ``: a LATERAL subquery (or a window function)
for the top three per workspace, NOT EXISTS for the refunds, and `json_agg` to nest them.

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

The row type is yours to write, and nothing checks it against the query. It is easy to get subtly wrong: node-postgres
returns the outer `sum` as a string, while `json_agg` turns the inner `sum` and `count` into JSON numbers, which lose
precision past 2^53.

**With grizzle:**

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

PostgreSQL's `count` is a bigint, so `calls` is a `bigint`; its `sum` of a bigint is a numeric, so `spend` is an exact
`Decimal`, at both levels. Each workspace's `models` arrive in order, ties broken by `model`, the child query's key,
which grizzle adds to the order because it knows the key.

### 3. A tree of any depth

**The task.** Reseller billing: an account bills through its parent account, to any depth, and a reseller sees what
every account under it spent.

**With Drizzle**, the query builder has CTEs (`$with`) but no recursive ones yet, so this is `` db.execute(sql`…`) ``
with a row type you write:

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

**With grizzle:**

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

**What you get.** `treeSpend` takes `{ root: Uuid }`, and its rows are `{ account: Uuid; spend: Decimal }`. A
recursive query is used like a table: `below.bind(...)` passes it a parameter, and `r.match` joins it to `Charge` and
feeds an aggregate. Its result is a set, so a cycle in `BillsThrough` ends the walk instead of looping forever.

### 4. No double booking

**The task.** Meeting rooms: two bookings of one room never overlap, and a room is booked only within its opening
hours.

**With Drizzle**, neither rule fits in the table builder. The first is an exclusion constraint, and the second a
trigger function you write (or, on PostgreSQL 18 and later, a temporal key and a PERIOD foreign key over range
columns), in a custom migration your TypeScript schema doesn't know about:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&);
-- and "within opening hours": a trigger function on booking, and another on opening_hours
```

A violation then reaches the app as an error whose constraint name you match on.

**With grizzle:**

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

**What you get.** A `span` in a primary key makes it a no-overlap key: two bookings of one room never share a minute.
`contained` between two spans says the room's opening hours cover each booking. `grizzle generate` compiles both to
PostgreSQL's own constraints, a temporal primary key and a PERIOD foreign key:

```sql
CREATE TABLE "rooms"."booking" (
  "room" "pg_catalog"."uuid" NOT NULL,
  "during" "pg_catalog"."int8range" NOT NULL,
  "by" "rooms"."__text_u2zmp7otto" NOT NULL,
  CONSTRAINT "__booking_pk_tzyi2pgieq" PRIMARY KEY ("room", "during" WITHOUT OVERLAPS)
);

ALTER TABLE "rooms"."booking" ADD CONSTRAINT "__booking_fk_room_during_254p6ghcbd" FOREIGN KEY ("room", PERIOD "during") REFERENCES "rooms"."opening" ("room", PERIOD "hours") MATCH SIMPLE;
```

A booking that overlaps another comes back from `db.apply` as `invariant-rejected`, naming the rule,
`{ kind: "primaryKey", relation: "Booking", fields: ["room", "during"] }`, and the room and span you submitted. A
booking outside opening hours names the coverage rule. Two overlapping bookings sent at the same moment can't both
commit either. There is no timestamp type: a `Minute` is a bigint contract, minutes since the epoch, and a span
includes its start and excludes its end.

### 5. A budget no burst of requests can overdraw

**The task.** Prepaid credits: each API call debits a grant, and a grant's debits never add up to more than its
amount, however many calls spend it at once.

**With Drizzle**, this is an interactive transaction that locks the grant, sums its debits and checks in app code:

```sql
BEGIN;
SELECT amount FROM credit_grant WHERE id = $1 FOR UPDATE;
SELECT coalesce(sum(amount), 0) AS spent FROM debit WHERE grant_id = $1;
-- in app code: if spent + $3 > amount, ROLLBACK
INSERT INTO debit (call_id, grant_id, amount) VALUES ($2, $1, $3);
COMMIT;
```

That is several round trips, and it holds only while every writer takes the same lock first: a backfill script or a
second service that inserts a debit directly can overdraw the grant. A trigger that sums the debits doesn't close the
gap under READ COMMITTED, PostgreSQL's default: two concurrent transactions each see their own new debit but not the
other's, and both commit.

**With grizzle:**

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
	natural
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

export const Metering = role(Credits, "metering", Credits.relations, { write: ["Debit"] })

/** Debit a grant for one call. Your code decides the retry; grizzle never retries. */
export const spend = (db: Db<typeof Metering, unknown>, debit: Fact<typeof Debit>) =>
	db
		.apply(ChangeSet.empty(Credits).insert(Debit, [debit]), {})
		.pipe(Effect.retry({ while: (e) => e._tag === "TransientFailure", times: 3 }))
```

**What you get.** The rule holds at commit, for every writer. A debit is written as its own row,
`{ call, grant, amount }`, which names its grant; the grant's count `debits` and its total `spent` are grizzle's to
draw, so no insert or put takes them, and `mutable(Grant)` lets them change after the grant is inserted. `grizzle generate` compiles the
family, the fold and the check to PostgreSQL's own constraints, over columns of each debit that grizzle fills on every
write and no query reads; abridged:

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

A grant's debits are a set, one row per debit by its key; the index is only the coordinate the proof counts them by,
never a multiplicity. Each debit carries a copy of its grant's count, its index, and the running total before and
after it. The UNIQUE and the CHECK on the index hold a grant's indices to distinct values below its count, the fold's
CHECK proves each after is its before plus its amount, in exact arithmetic, from 0 at the first slot, and the deferred
foreign keys carry each before from the debit at the slot below (`__predecessor_debits_…` is the index less one) and
the grant's `spent` from its last debit, at `debits` less one. `WithinGrant` is a row check on the grant.

Every transaction is SERIALIZABLE, and two calls that spend one grant both rewrite its count and total, so two that
each fit, but together overdraw, can't both commit. One fails with a `TransientFailure` that changed nothing; `spend`
runs it again, it sees the other's debit, and it comes back as an outcome you match on, never a message to parse:

```text
{
  kind: "invariant-rejected",
  refused: { kind: "first", laws: [{ kind: "check", relation: "Grant", name: "WithinGrant" }] },
  witness: { kind: "unreported" }
}
```

`refused.laws` is never empty ([Errors and outcomes](#errors-and-outcomes)). It is `first` and the witness
`unreported` here: `WithinGrant` reads `spent`, which grizzle fills on the grant from its debits, so no grant the
ChangeSet states breaks it, and the check PostgreSQL tried first is all grizzle knows. A row check over a row you state
names that row's key, and `every` rule of its table the row breaks.

### 6. Books that always balance

**The task.** Double-entry bookkeeping: every journal entry's postings add up to zero.

**With Drizzle**, a CHECK can't see other rows, and an ordinary trigger runs at the end of each statement, so an entry
written in several statements fails halfway. It takes a deferred constraint trigger you write in PL/pgSQL, in a custom
migration:

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

**With grizzle:**

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

**What you get.** An entry and its postings go in one ChangeSet: the entry as its written row, `{ id, memo }`, and
each posting as its own row naming its entry. grizzle draws the count and the total from the postings, and `Balanced`
reads the total, so a ChangeSet that leaves an entry unbalanced comes back `invariant-rejected` on `Balanced`, and
changes nothing. The entry is immutable, so its postings are fixed once it is inserted: a delete of one is refused
before any SQL, and correcting an entry is a reversing entry, as a ledger wants. It compiles as the grant's rule does,
to keys, CHECKs and foreign keys over the postings' hidden columns, and every writer meets it, psql included. The
check states the bound: `e.total.eq(0n)` is an exact total, and `i.total.eq(i.amount)` makes a total equal a column
instead, as in "an invoice's lines add up to its amount".

### 7. States that carry their own data

**The task.** An invoice is open, paid or void. A paid invoice has exactly one payment, with its charge id; a void one
has a reason; an open one has neither.

**With Drizzle**, the usual model is nullable columns and CHECKs:

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

Drizzle can declare those CHECKs with `check()`, in `` sql`…` ``, but the row type stays
`{ state: "open" | "paid" | "void"; paidChargeId: string | null; voidReason: string | null }` in every state, so every
reader narrows by hand.

**With grizzle:**

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

**What you get.** `alternatives` says each invoice has exactly the detail row its `state` names, and the types follow:
`invoiceCard`'s row is a union on `state`, in which `payment` is an `Option.Some` exactly when the invoice is paid.

```text
  | { readonly id: Uuid; readonly state: "open"; readonly payment: Option.None<{ readonly charge: string }>; readonly voiding: Option.None<{ readonly reason: string }> }
  | { readonly id: Uuid; readonly state: "paid"; readonly payment: Option.Some<{ readonly charge: string }>; readonly voiding: Option.None<{ readonly reason: string }> }
  | { readonly id: Uuid; readonly state: "void"; readonly payment: Option.None<{ readonly charge: string }>; readonly voiding: Option.Some<{ readonly reason: string }> }
```

`pay` takes `{ invoice: Uuid; charge: string }`. It reads the invoice as it stood and, if it was open, marks it paid
and inserts its payment, in one transaction; on an invoice that is no longer open both parts are empty, so a payment
webhook delivered twice answers `no-change` the second time. A paid invoice without its payment is refused at commit,
whoever writes it. In PostgreSQL, abridged from `grizzle generate`, `state` is a smallint code under the roster's
domain, which admits only a live handle's code, and both directions are foreign keys over STORED generated columns,
deferred to commit: a payment can point only at a paid invoice, and a paid invoice, its id kept only where its state is
`paid` (code 1), must have its payment:

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

**The task.** A usage page lists a workspace's calls newest first, 50 at a time, with next and previous links that
stay correct while new calls arrive, and a chart reads spend per model without scanning every call. Both must be fast.

**With Drizzle**, you write the keyset query and its cursor format, the rollup, and the indexes, and nothing ties them
together:

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

Drizzle's `pgMaterializedView` declares the view and `refreshMaterializedView` refreshes it. The cursor format, the
backward page, and both indexes are yours.

**With grizzle**, continuing the `Usage` schema of [showcase 2](#2-top-three-per-group-with-exact-types):

```ts
import { derived, type PageCursor, type Uuid, workload } from "@bjornpagen/grizzle"

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

export const Analyst = role(Reporting, "analyst", Reporting.relations, { refresh: ["ModelSpend"] })
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

- **Pages.** `db.page` answers `{ edges, pageInfo }`. Each edge is a row, `{ id, model, at, cost }` with `at` and
  `cost` the branded `bigint`s of their contracts, and its cursor, and `hasNextPage` and `hasPreviousPage` are exact.
  A cursor is an opaque string typed to `callLog`, and checked against it when it comes back. Ties are broken by `id`,
  the row's key, which grizzle adds to the order because it knows the key. `{ last: 50, before }` pages backward.
- **The rollup.** `ModelSpend` is a materialized view whose key, `(workspace, model)`, grizzle proves from its query,
  so `modelSpend` returns at most one row and `db.get` accepts it: `spendOn` gives an
  `Option<{ calls: bigint; spend: Decimal }>`. `db.refresh(ModelSpend)` compiles only for a role whose `refresh` lists
  it.
- **The indexes.** `grizzle generate` derives one from the workload's `callLog` and one from the rollup's key, and
  grants the refresh:

```sql
CREATE INDEX "__call_ix_workspace_at_id_txjpwdbrfr" ON "usage"."call" USING btree ("workspace", "at", "id" DESC);

CREATE MATERIALIZED VIEW "usage"."model_spend" ("model", "workspace", "calls", "spend") AS … WITH NO DATA;
CREATE UNIQUE INDEX "__model_spend_key_model_workspace_p5jkdouxat" ON "usage"."model_spend" USING btree ("model", "workspace");

GRANT MAINTAIN ON TABLE "usage"."model_spend" TO "usage__analyst";
```

Change `callLog` so that it needs another index, and `grizzle check`, and `DbLayer.make` at startup, refuse until you
run `grizzle generate` again.

## What grizzle builds

| You write                                   | PostgreSQL gets                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `relation(...)`                             | a table, every column NOT NULL, with its primary key                                                                          |
| `str.regex(...)`, `contract(...)`           | a domain whose CHECK every writer meets, one domain for each distinct definition                                             |
| `closed(...)`                               | a smallint domain that admits each live handle's code, over the roster's names, an IMMUTABLE function returning them as `name[]`; where a `bits(...)` field is over the roster, a `bit(n)` domain, n its codes rounded up to whole hex digits, that admits only live handles |
| `closed.relation(...)`                      | no table: one content-addressed IMMUTABLE constant for each closed relation or side a rule or query reads, with its owners' bases and counts where its key holds slots, and a table CHECK for each rule that reads one from an open row |
| a rule: `contained`, `key`, `check`, ...    | a foreign key, unique key, no-overlap key or CHECK, over STORED generated columns where a side selects rows or reads `pred`, and never a trigger |
| a family: `ordered`, `counted`, `tree`, `fold` | the drawn and accumulated fields grizzle fills on every write, hidden columns beside them, and the keys, CHECKs and foreign keys that prove each value it fills |
| `role(...)`                                 | a PostgreSQL role with its own schema of views and its grants; on each table some role writes through a query entry that leaves rows out, row-level security and a policy for every role that writes it |
| `login(...)`                                | a login role that can switch to its roles and holds no table privilege of its own                                            |
| `workload(...)`                             | the indexes and statistics its queries need; its queries compiled when the app starts and prepared on each connection        |
| `derived(...)`                              | a materialized view, with a unique index on each key it provably has                                                         |
| a query                                     | SQL, usually one statement and one more per attachment, and a decoder for its exact row type                                 |

Migrations are plain SQL files that `grizzle generate` drafts and you review, as with drizzle-kit.

## Install

> **What you need to run grizzle**
>
> - **PostgreSQL 19**, tested on 19rc1 with the two patches under
>   [PostgreSQL known issues](#postgresql-known-issues). PostgreSQL 19 GA is due on 2026-11-19; until hosted providers
>   offer it, run the server yourself.
> - **Node 26** or later.
> - **Effect 4.1.**

```sh
pnpm add @bjornpagen/grizzle@beta effect pg
```

The agent guide ships in the package as `skills/grizzle/SKILL.md`: copy it to where your agent reads skills, and again
after upgrading grizzle.

In full, you need:

- **Node 26 or later** and **Effect 4.1.** `effect` is a peer dependency, so install one copy beside grizzle. grizzle
  runs under `--disable-proto=delete` and `--disable-sigusr1`: it never touches `Object.prototype.__proto__`, the
  `grizzle` command starts with both flags, and every test runs under both.
- **node-postgres 8.23.1 or later.** `pg` is a peer dependency too, and `@types/pg`, which TypeScript reads its types
  from, an optional one: grizzle imports none of it, and you pass the module you import as each connection's
  `driver`. A `pg` without pipeline mode, which every call's one round trip needs, is a type error there.
- **PostgreSQL 19**, tested on 19rc1 with the two patches under [PostgreSQL known issues](#postgresql-known-issues).
  The database must be UTF8 with the builtin `C.UTF-8` locale, and the server host needs the `C.UTF-8` operating-system
  locale. `btree_gist` must be available; a migration creates it when a no-overlap key or a coverage rule needs it.
  pgvector 0.8.7 is needed only for vector fields; it is not a trusted extension, so a superuser creates `vector`
  first where the migration role cannot.
- **A migration role that owns the database.** It owns the schema and the database, and has CREATEROLE to create the
  PostgreSQL roles of your logins and roles. It needs no superuser. Any other role fails the first migration with
  42501, because only the database's owner may set its default isolation level.
- **A password for each login role**, which you set, or for an RDS IAM login, membership in `rds_iam`. Each grizzle
  connection authenticates with exactly the password its configuration names, and node-postgres never reads
  `PGPASSWORD` or `~/.pgpass` for one.
- **TLS with verify-full.** It is the only mode; plaintext is refused.
- **A direct connection.** PgBouncer is not supported.
- **`max_pred_locks_per_transaction = 2048`** on the server, recommended (a server-start setting, about 115 MB of
  shared memory at 200 connections).

## Effect, briefly

grizzle is built on [Effect](https://effect.website) 4. Opening a database, reading and writing return `Effect` values:
lazy descriptions of work whose success and failure types are part of their type. Inside `Effect.gen(function* () {
... })`, `yield*` runs one and gives you its result. At the edge of your app, a `ManagedRuntime` built from grizzle's
layer runs them: `runtime.runPromise(effect)` returns a Promise. That is all the Effect the example below uses.

## Example

A blog behind Clerk: signed-out readers, signed-in members who write in their active organization, and a nightly job
that loads view counts. It continues the schema at the top of this page. Each block below is the same module and
imports only what it adds, and the test suite typechecks every line.

### Who is asking

```ts
import { context } from "@bjornpagen/grizzle"

/** Clerk's session token: the user in `sub`, the active organization's id in the nested object `o`. */
export const Session = context("Session", { sub: ClerkUser })
export const Org = context("Org", { id: ClerkOrg }, { claim: "o" })
```

A `context` is a claim of the verified session token, seen by queries as a table of at most one row. A signed-in user
outside any organization has a `Session` row and no `Org` row; a signed-out visitor has neither.

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

A `role` is what one kind of user sees, laid out as tables. Each entry is either a table of `Blog`, whole (`Status`),
or a query over `Blog` (`Post: published`). grizzle installs each role as a PostgreSQL role that reads through one
view per entry and writes a query entry under row-level security, so a forgotten filter in app code cannot leak a row:
PostgreSQL applies the role to every statement. `write` lists the entries the role may write.

- `anon` reads published posts and their comments.
- `member` reads published posts and every post of its active organization. `memberPosts` has two rules, and a query
  with several rules returns the rows of all of them; `Status.handle("Published")` puts that constant in the first
  rule's rows, so both rules return the same columns. `myPosts` matches `Session` and `Org`, so it keeps the posts
  whose `author` is the signed-in user and whose `org` is the active organization. A member writes through `MyPost`
  and `MyComment`: inserting into `MyPost` fills `author` and `org` from the token, and a post that `myPosts` would
  not return is refused.
- `etl` reads post ids, never a title or a body, and writes `PostViews`.

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

A query for a role is written over the role and sees only what the role sees: `MemberPost` is already the member's
filtered view of posts.

A `workload` names the queries and writes your app runs on its hot paths. grizzle compiles them once, when the app
starts, and `grizzle generate` compiles them the same way, derives the indexes they need and records them in the
migration snapshot: a program the app would refuse to start with, generate refuses first.

A `login` is one PostgreSQL user, with its password and its own connection pool, that can act as the roles it lists.
The login is the trust boundary: whoever holds its password can act as any of its roles, with any claims. So the web
app and the nightly job get separate logins, and no token sent to the web app can make it write view counts.

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

`DbLayer.make` sets up one login's connection pool. It takes the `snapshot.json` that `grizzle generate` wrote, and
the connection:

- `driver`, the `pg` you import;
- `transport`, how each connection reaches the server: `open` makes a new, unconnected socket, which pg connects to
  `host` and `port`, then an SSLRequest and verify-full TLS over the socket, the server's certificate chained to `ca`
  and naming `servername`. `host` is a name or an IP address, never a Unix socket's path: PostgreSQL offers no TLS
  over one. A tunnel connects to its local end and names the server it reaches. A CancelRequest opens its own
  connection the same way;
- the password: a `Redacted`, or an Effect that yields one for each new connection;
- `connectTimeoutMs`, how long one connection attempt may take, past which it fails with `ConnectTimedOut`, and how
  long the one CancelRequest an interrupted call sends may take;
- `pool`: at most `max` sessions open, `min` of them kept open once opened, and the others closed `idleTimeoutMs`
  after their last use.

grizzle states no number of its own. A call waits for a session as long as you let it: the wait has no deadline, and
interrupting the Effect, your own timeout among the ways, ends it, leaving nothing behind. Closing the layer's scope
destroys every connection of its pool at once, awaiting nothing from the network.

A login whose roles read the token also needs `verify`, your function from a bearer token to its verified payload:
here, Clerk's `verifyToken`. `attachPool` hands the pool to Vercel, so idle connections close before a function
instance suspends. There is no isolation level, statement timeout or retry policy to set.

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

`Db.open(role, { token })` opens a database handle as one role, for one request. The types follow the roles:
`Db.open(Web.roles.member, ...)` does not compile without a token, `Db.open(Web.roles.anon, {})` needs none, and each
handle's `db.workload` holds exactly the programs of its login's workloads for its role, compiled when the layer was
built. The draft is a ChangeSet built per request, so `db.apply` compiles it for the call. The handler meets Clerk's
three states:

- **Signed out.** No token: the handler opens `anon` and returns published posts.
- **Signed in, no organization.** The token has `sub` and no `o`, so `Session` has a row and `Org` has none. The feed
  is the published posts, and a draft comes back `outside-world`: there is no organization to fill `org` from, so the
  post is not one `MyPost` can hold.
- **In an organization.** The feed adds the organization's drafts, and a draft is inserted with the user and the
  organization filled in.

`db.apply` runs a write, called a ChangeSet, and answers with an outcome: `accepted`, `no-change` (here, the same draft
posted again), `outside-world` (a row the role may not write) or `invariant-rejected` (a rule said no; the outcome names
the rule and the key that broke it).

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

`put` writes rows by primary key: after the change, the row at each key is the one given. grizzle never retries on its
own. A `TransientFailure`, such as a serialization failure, changed nothing, so this job runs the write again, up to
four times.

## Tables and types

`relation(name, fields, primaryKey)` declares a table. A `schema` groups tables and the rules between them, and
becomes one PostgreSQL schema.

- **No nullable columns.** Every column is required. A value that may be missing is a row that may be missing, in a
  table of its own, like `PostViews`.
- **Tables are immutable by default.** Rows are inserted and deleted, never updated in place, and no role holds
  UPDATE on them. List `mutable(Post)` among a schema's rules for a table whose rows are replaced often; it changes how
  a `put` is carried out, never what it means. A family's owner whose family changes after it is inserted is mutable
  too ([Families](#families)).
- **No timestamp type.** An instant is a `bigint` contract, such as milliseconds since the epoch, and the current time
  is a parameter you pass in. A calendar day is a `date`.

| Field                                              | PostgreSQL                                    | TypeScript                                                          |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `uuid`                                             | uuid                                          | `Uuid`, its hyphenated spelling; `Uuid.parse` reads a string        |
| `pg.smallint`, `pg.integer`                        | smallint, integer                             | `number`                                                            |
| `pg.bigint`                                        | bigint                                        | `bigint`                                                            |
| `natural`                                          | bigint, behind a domain that checks `>= 0`    | `bigint`                                                            |
| `date`                                             | date, its column checked to 0001-01-01 … 9999-12-31 | `CalendarDate`, its ISO 8601 text `"YYYY-MM-DD"`              |
| `pg.numeric(p, s)`                                 | numeric(p, s)                                 | `Decimal`, exact, no display scale                                  |
| `pg.real`, `pg["double precision"]`, `pg.float(p)` | real, double precision                        | `number`                                                            |
| `pg.money`                                         | money                                         | `Money`                                                             |
| `pg.boolean`                                       | boolean                                       | `boolean`                                                           |
| `pg.smallserial`, `pg.serial`, `pg.bigserial`      | an identity column                            | `number`, `number`, `bigint`                                        |
| `str.regex(pattern, flags?)`                       | text, behind a domain that checks the pattern | the pattern's language: `string`, or `"yes" \| "no"` for `^(yes\|no)$` |
| `str.bytes(n, str.regex(...))`                     | text, behind a domain that checks its UTF-8 bytes, then the pattern | the pattern's own                                                   |
| `closedId(X)`, for `X = closed("X", [...])`        | smallint, behind the roster's domain           | the union of its names                                              |
| `bits(X)`, a set of `X`'s handles                  | bit(n), n `X`'s codes rounded up to whole hex digits, behind a domain that holds only live handles | `Bits<typeof X>`, a `ReadonlySet` of its names, `Bits.of(X, [...])` |
| `contract(name, base, check?)`                     | a domain with that CHECK                      | the base type, branded with the name                                |
| `span(pg.integer)`, over integer, bigint or date  | a range                                       | `{ start, end }`, start included, end excluded                      |
| `pg.vector(n)`                                     | pgvector's vector(n)                          | `Vector`, a Float32Array                                            |

Text always carries a pattern, with flags `"u"` (the default) or `"su"`. A contract value is made with its
constructor, `Cents(500n)`, which brands it without checking it: the database checks it on every write. `natural` is a
count: the builtin contract `natural` over `pg.bigint`, unbranded, and the one type a rule's `pred` reads
([Rules](#rules)). Its domain refuses a negative value, an outcome on the law
`{ kind: "contract", contract: "natural" }`, and another contract under its name is refused. `date` is a calendar day
of the proleptic Gregorian calendar: PostgreSQL's date, a plain type as `pg.integer` is, so `Compute.base` of a date
is the date itself. Every date column carries a CHECK of the days from 0001-01-01 to 9999-12-31, so no column holds an
infinity or a year its text could not spell, whoever writes it; it is the type's range, no rule an outcome names. Its value is its ISO
8601 text, `"2024-02-29"`, one text per day, ordered as the calendar is; every login pins `DateStyle` to ISO, so
PostgreSQL writes it the same way. Dates compare, and `min` and `max` them, a key or index may hold one, and
`span(date)` is a span of days, PostgreSQL's daterange.

A pattern is written in JavaScript's regular expression syntax under the `u` flag, and holds the part of it that
PostgreSQL matches the same way: characters and escapes, classes and ranges, `\d`, `\w` and their complements, `.`,
groups, `|`, `^` and `$` for the start and end of the whole text, and the greedy `?`, `*`, `+` and `{m,n}`, each bound
at most 255. A lookahead or lookbehind, a `\p{…}` or `\P{…}` class, `\s` or `\S`, `\b` or `\B`, a backreference, a
named group, an inline modifier, a lazy quantifier, NUL and a lone surrogate are not, and neither is a pattern no text
matches, such as `a^b` or `[]`. TypeScript accepts each of them, as JavaScript does;
the first relation, contract or `Compute.matches` built over the pattern refuses it with `UnsupportedOperation`, naming
the construct and where it stands in the pattern.

`str.bytes(n, pattern)` is text of the pattern's language of at most `n` UTF-8 bytes, `n` from 0 to 2,147,483,647.
The bound is a refinement as the pattern is, not a type: the field's host type is the pattern's, so it meets every
text the pattern meets, and a value copied from a document text of no bound into it needs no cast. Its domain checks
`octet_length(VALUE) <= n` before the pattern, so PostgreSQL's regex engine never reads a longer value, and refuses a
longer value with 23514 as it refuses a value outside the pattern; equal patterns and bounds share one domain, and a
bound every value of the pattern already meets leaves the pattern's own type and domain. Text always carries a
pattern, so the bound takes one: `str.bytes(n, str.regex("^.*$", "su"))` is any text of at most `n` bytes.

A text in a key, or in any index grizzle installs, needs a byte bound: its pattern's, `str.bytes`'s, a contract's
`Compute.charLength(v)` bound, four bytes a code point, or a contract's `Compute.octetLength(v)` bound, its UTF-8 bytes
exactly. `keyTextBytes(fields)` is the most bytes a text holds beside `fields` in every index grizzle plans over them,
whatever their order and whichever is a hidden column that may be NULL; `fields` are the index's other columns, a
key's other fields or, for a family axis that carries the text, its group fields, its natural index, the other values
it carries and a tree's `end`. So `str.bytes(keyTextBytes([uuid, natural]), str.regex("^.*$", "su"))` sits in a key
with a uuid and a natural, declared or over a selection, and rides an ordered family's axis grouped by a uuid, and a
pattern needs no counted repetition to be a key's. A key's entry is laid out
as PostgreSQL lays it out: exactly through its fixed-width fields in key order, then each datum at its widest padding
from the first text, numeric, set, range or vector on.

Two bounds a call is refused by before it is sent are exported beside it: `messageMaxBytes`, the longest message
PostgreSQL reads (1,073,741,822 bytes), and `maxStringLength`, the longest string V8 builds (536,870,888 UTF-16 code
units). Each is a `Limit`: its `.value` is the number, and it carries its owner, unit, scope and the source the number
is read from, so code that splits an input across calls (`InputTooLarge`,
[Errors and outcomes](#errors-and-outcomes)) reads the bound instead of restating it.

A roster, `closed("Status", ["Draft", "Published"])`, is a fixed list of handles, and a `closedId(Status)` column holds
a handle's code: 0 … n − 1 in declared order, which is also their comparison order. The API reads and writes names; the
table stores codes, under a smallint domain that admits only a live handle's code, and every role's view adds a
decoded column beside each closed id, `status_name`, so psql shows names. A handle is at most 63 UTF-8 bytes, the most a
PostgreSQL `name` holds. Codes are history: a new handle is appended, a removed one leaves its code unused, and a
reorder is refused ([Migrations](#migrations)). `bits(Status)` is a set of handles, a `bit(n)` with one bit per code,
n rounded up to a whole number of hex digits, whose domain holds only live handles' bits and every bit past the last
code at 0. grizzle writes a set in hex alone: `X'…'` cast to its domain in SQL, `X` and its hex digits as a
parameter's text. `Compute.union`, `.intersection`, `.difference`, `.cardinality`, `.subset`, `.disjoint` and
`.singleton` are its algebra, and there is no complement: the complement of a set within its roster is the full set
less it. `Compute.singleton(id)` is the set of a closed id's one handle, the empty set with its code's bit set, so a
handle's membership in a set is `Compute.subset(Compute.singleton(id), set)`; a NULL id gives a NULL set, as every
operation of the algebra does. A key holds no set: a set's bit string is too wide for an index entry.

### How a field is written

Every field says who writes it, and an insert or a put takes exactly the fields its caller writes, `Written<R>`, which
grizzle exports beside `AdditionIn<S, R>`, R's addition in S with its sequences' members nested at its count fields:

- **The caller**, the default: a field declared by its type alone, `title: Title`.
- **PostgreSQL**, as a STORED generated column:
  `relation.generated(name, written, primaryKey, (r) => ({ f: generated(type, term) }))`. `r` holds the fields its
  caller writes alone: no generated column, which PostgreSQL's generation expression never reads, and no drawn or
  accumulated field, which grizzle writes on the host, by type and, for a JavaScript caller, by `GeneratedRefused`
  (`readsUnwritten`) when the schema is compiled. The term is of the declared type but for a text's pattern and byte
  bound: a text of any pattern or bound fills a refined text, as
  `generated(Ids, Compute.concat(row.head, row.tail))` does. The field's domain checks every value PostgreSQL
  generates, as it checks a value you write, and refuses a row whose term lies outside it, `invariant-rejected` on the
  pattern's rule. Another integer width, numeric typmod or contract, `natural` among them, is a type of its own, and
  grizzle casts nothing implicitly, so such a term is `GeneratedRefused` (`type`) when the schema is compiled: write
  the `Compute.cast` it needs. The term may read closed relations ([Closed relations](#closed-relations)); a term with
  no value at a row, a closed read `C.at` at a key its relation holds no row at, refuses the row,
  `invariant-rejected` on `{ kind: "generated", relation, field }`.
- **grizzle, drawn:** `drawn(natural)`, a family's count or index, and a tree's `start` and `end`
  ([Families](#families)).
- **grizzle, accumulated:** `accumulated(type, start)`, a fold's end or accumulator, or a copy along a family's axis,
  `start` its value where the axis begins.
- **The identity:** a serial field, which an insert may leave out ([Writes](#writes)).

A fact and a query's row hold every field. A primary key holds no set, generated or accumulated field, and no key
holds a generated field: no fact carries its value, so no write could check it, and such a schema is refused when it
compiles (`UnwritableRelation`, `generatedKey`).

grizzle fills every value it writes in an order the schema fixes, and a schema in which a field would be read before
it is filled is refused when it compiles, never at its first write. An insert fills each row on entering it: its
caller's and generated fields, its counts, its index, a tree's `start` and `end` (its subtree's size is known from the
nesting), and every copy it takes from its owner or from the member before it. Then it fills the members of each
ordered family and tree the row owns, nested under it, and on leaving the row what it reads off them: a fold's end and
a copy along a last axis. A counted family fills its own members after that, from their owner's whole row, and then
its own fold's end. A counted family's member that the insert nests, as a sequence's member, a tree's node or the
owner of the rows nested under it, is filled by the walk like any row there, and its counted families complete it
afterwards. So:

- a copy along an ordered family's or a tree's owner axis reads a column its owner fills on entering it, never a
  fold's end, a copy along a last axis, or a column read from one;
- a copy along a counted family's owner axis reads any column of its owner but the end of a fold over that family;
- a counted family's count and fold ends, and the index, count and copies it fills on its members, are read only by
  that family's own members and ends: no other family's copy, fold step or selection reads them;
- no row's columns read each other in a cycle, as copies along a tree's owner axis can at its root.

A schema that breaks one of these is refused as `UnfillableField`, naming the field, the law that fills it, the column
it reads, the axis it reads it along, and why that column is filled later.

### Closed relations

`closed.relation(name, fields, key, rows)` is a relation whose rows are fixed when the schema compiles, such as a
grammar, a price list, or which states may follow which. Its key is required, a nonempty list of its closed-id fields,
and one whose key lists every field is a set; its other fields are closed ids or values of an open type, never a
serial, span, set or vector. Its rows are a set of facts: a row written twice is one row, and two rows of one key with
other payloads break its key and are refused, naming the key and both payloads.
`closed.relation("Allowed", { kind: closedId(Kind), flag: closedId(Flag), weight: pg.integer }, ["kind", "flag"], rows)`
says which flags each kind admits, and at what weight.

It has no table. The migration installs it as content-addressed IMMUTABLE constants, a bit string indexed by its key's
codes and an array of each open-typed field's values, which PostgreSQL folds into every statement that reads them.
Every rule that reads one from an open row is a table CHECK on that row's table, named by its rule: a containment of a
row's `(kind, flag)` into `Allowed` is one substring read of the row's own codes. Two terms read it in a row check, a
selection or a generated field's term: `Allowed.at("weight", kind, flag)`, the payload field at that key, NULL where
no row holds the key; and `Allowed.row(kind)`, the set of the last key field's handles that complete the prefix, empty
where none does and NULL where the prefix is, for the set algebra above. The rule judges a NULL by SQL's three-valued
logic: a row check refuses a row its condition leaves unknown, and holds of one where another arm of an `or` holds; a
selection keeps only the rows its condition is true of; and a generated field's NULL term is refused by its column's
NOT NULL. Every domain admits NULL, so no cast to a contract, a pattern, a roster or a set refuses a read first. A rule
over closed relations alone is checked once, by PostgreSQL, in the migration that installs them: a violating row
refuses the migration, and nothing is left behind. A containment from a closed relation into an open one is refused:
it would require rows of an open relation, which belong in a closed relation of their own.

A key field may hold slots instead of every code of its roster. `slot(closedId(Position), fin(Model, "positions"))` is
a closed id of `Position` whose codes, for each owner, run from 0 below that owner's count: `fin(O, "n")` over a closed
relation `O` is its natural field `n` per row, the same former a family's count is. `O`'s key pairs with the key's
first fields, roster for roster and in order, the owner prefix, and every slot follows it. So
`closed.relation("Follow", { version: closedId(Version), parent: closedId(Kind), from: slotOf, to: slotOf }, ["version",
"parent", "from", "to"], rows)`, with `slotOf` that slot, holds each model's positions squared, not the widest model's
for every model: its constant is one block per owner, each after the blocks before it, at the owner's own counts. A
row whose slot is at or past its owner's count is refused when the installation is planned, and a read of such a key,
in a rule, a generated field or a query, finds nothing there, never another key's row. The key's reads are the ones
above, unchanged: `Follow.row(version, parent, from)` is the set of `to` positions that follow, over `Position`.

The migration states each of a closed relation's constants as one hex literal, `X'…'`, four bits a digit, its cells'
bits padded with 0s to a whole digit, under a comment of its row count and content digest, which `grizzle check`
decodes and holds to that digest and to its function's name: a changed digit, a lowercase one or a 1 in the padding
is refused, naming the relation, the first cell where the literal parts from the declared rows and that cell's key.
A constant two relations share is one literal. Follow over 1,217,966 rows drafts a 507,520-byte literal and installs
it in 35 ms.

## Rules

Rules are declared beside the tables, in a schema's list. Here is a box office:

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

A price is never negative. Every ticket's show exists, and so does every run's stage and show. One person holds at most
one ticket per show. A show has at least one seat, and never more tickets than seats: `tickets` is drawn, each show's
count of the tickets that name it, which grizzle keeps and `mutable(Show)` lets change as tickets sell. And because
`nights` is a span in `Run`'s primary key, two runs on one stage never share a night. The last two are the kind of rule
an app usually checks in code, with a race between the check and the write; here they hold in the database, for every
writer.

| Rule           | Written as                                                | Holds when                                                                       |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Primary key    | `relation`'s third argument                               | no two rows share it                                                             |
| Unique key     | `key(on(Ticket, "show", "holder"))`                       | no two rows share these fields                                                   |
| No-overlap key | a key with a `span` field                                 | rows that agree on the key's other fields never share a point of the span        |
| Foreign key    | `contained(on(Ticket, "show"), on(Show, "id"))`           | every ticket's `show` is a show's `id`                                           |
| Both ways      | `mirrors(on(A, "x"), on(B, "y"))`                         | `contained(a, b)` and `contained(b, a)`, the two rules it stands for             |
| Coverage       | `contained` between two `span` fields                     | the target's spans cover each source span                                        |
| One of several | `alternatives(Task, "kind", Kind, { Automatic, Manual })` | each row has exactly one detail row, in the table its `kind` names               |
| Row check      | `check("SomeSeats", Show, (s) => s.seats.ge(1n))`         | the condition holds on every row                                                 |
| Counted family | `counted(on(Ticket, "show"), fin(Show, "tickets"))`       | each show's `tickets` is the number of tickets that name it                      |
| Ordered family | `ordered(on(Line, "order", "at"), fin(Order, "n"))`       | each order's lines hold `at` exactly 0 … n − 1                                    |
| Tree           | `tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })` | each `doc`'s rows are one tree, `[start, end)` each row's pre-order interval |
| Fold           | `fold(family, Monoid.sum, step, end)`                     | each owner's end is its members' step values combined by the monoid              |
| Selected side  | `on(select(Ticket, (t) => φ), "show")`, in any rule       | the rule reads only the rows where φ holds                                       |
| Predecessor    | `on(Place, "show", pred("at"))`, in any rule              | the rule reads `at` − 1, and nothing of a row whose `at` is 0                    |

A rule is stated over sides, `on(source, ...terms)`, and pairs its sides' terms in order. A source is a table, or
`select(T, (t) => φ)`: the rows of T where φ holds, φ written as a row check's condition, the one way a selection is
written. A term is a field, or `pred(n)` of a `natural` field n: n − 1, defined only where n is above 0. A side lists
each term once: `on(Ticket, "show", "show")` is a type error, and from JavaScript refused when you build it, while
`"at"` and `pred("at")` are two terms. A row outside a side's selection, or whose `pred` field is 0, has no tuple on
that side: a key over the side doesn't hold it apart, a containment from the side doesn't require it, and a containment
into the side doesn't find it. A key over a table's own fields is a candidate key of the table; over a selected side or
a `pred` term it is no key of the table. A containment's target holds a key: a candidate key among its fields, or a key
over the same selection among its terms. A rule may be written in a helper generic over the tables it reads,
`<T extends typeof A | typeof B>(t: T) => contained(on(t, "owner"), on(Owner, "id"))`: it typechecks exactly where the
rule holds for each table T may be. Those tables share one heading, or one holds every field of another and more; a
helper over tables that share none is refused. A query over such a T reads it the same way, through `v(t, "x")` and
`r.match(t, …)`. A show's waitlist, over the box office:

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

Every place after the first has the place before it, so a show's places run from 0 with no gap. A holder waits at most
once per show, and may also hold any number of places already called.

Every rule holds at commit, for every writer, and every rule compiles to PostgreSQL's own constraints: grizzle
installs no trigger and no function for a rule. Each term of a selected side, and each `pred` term, is a STORED
generated column, `CASE WHEN φ THEN t END`; a key over a side is `UNIQUE NULLS DISTINCT` and a containment
`FOREIGN KEY … MATCH SIMPLE`, which pass a row whose columns there are null. `alternatives` is its containments: one
from each arm into its parent at its handle, and one from the parent's rows of each handle into its arm, a selected
side. A coverage's target needs a no-overlap key over its span, or the schema is refused: coalesce the spans, or key
them. A write that breaks a rule comes back as an outcome that names the rule, never as a message to parse.

### Families

A family is a rule over rows the caller writes: each owner's members, counted by a drawn field of the owner.
`fin(O, "n")` is the slots of O's drawn count `n`, a family's second argument, never a side and never a table.

- **`ordered(on(F, g…, "at"), fin(O, "n"))`**: each owner's members, its group `g…` paired with O's primary key,
  indexed by their drawn `at` exactly 0 … n − 1, in order.
- **`counted(on(F, g…), fin(O, "n"))`**: each owner's `n` members, its group `g…` naming the owner by O's primary
  key: an unordered set of rows, one per member key. The index the proof counts them by is hidden: no field, no fact
  and no query holds it, and it is a coordinate, never a multiplicity.
- **`tree(on(T, "parent", "at"), fin(T, "children"), { root: "doc" })`**: T over itself, with drawn `at`, `children`,
  `start` and `end`. Each value of the root field `doc` is one tree: its root is the one row whose `parent` is its own
  id, every other row is a member of its parent's ordered family, and `[start, end)` is each row's pre-order interval.
  PostgreSQL's own constraints make each tree's rows one tree, every row reachable and none on a cycle. So a document
  in order is its rows by `start`, one scan of the `UNIQUE (doc, start)` the tree installs, and a row's descendants are
  its tree's rows whose `start` lies inside its interval: a range scan, with no recursion.
- **`fold(family, Monoid.m, step, end)`**: the members' step values, `step` a side of the member, combined by the
  monoid into the owner's `end` fields, each `accumulated`. The monoids are `Monoid.count`; `Monoid.sum`, exact, over an
  integer type or a numeric, never a float or money; `Monoid.or` and `Monoid.twos` over sets, `twos` with two planes,
  the handles seen once and those seen twice; `Monoid.max`; and `Monoid.concat` over text, its free monoid, each step
  after the running text. Each starts at its identity, which an empty family's end holds. Its accumulators and ends are
  of its step value's type but for a text's pattern and byte bound, each its own: concat's pieces may be any text,
  generated or written, and its accumulators a pattern of the text they spell. Each one's domain checks every value
  grizzle fills into it, so a running value or an end outside its pattern refuses the write, `invariant-rejected` on
  that pattern's rule. Another integer width, numeric typmod or contract is a type of its own: such a fold is
  `MalformedDescription` when the schema is compiled. A fold over an ordered family may name each member's running
  `before` and `after` too; one over a counted family names only its step value
  and its end, since a running value would show the hidden order. concat depends on that order, so it folds only an
  ordered family or a tree, by its named pair. A separator belongs to the step, never to the monoid, which would have
  no identity: write each member's token with the separator before it, but at index 0, and the end is the tokens
  joined by it. The family's axes key each running text, so its accumulators are text of a bounded pattern
  ([Limits](#limits)).

A relation is a member of at most one ordered family or tree, which orders it, and of any number of counted families,
each with its own hidden columns and foreign keys. A counted family's member may also be an ordered family's member,
a tree's node or a sequence's owner. Ordered families that nest each other in a cycle, an ordered family of a relation
over itself among them, are refused when the schema compiles (`UnwritableRelation`, `nestingCycle`), since no row of
them could be written first. One count counts one family. A family's or a tree's member side is a table, never a
selection, since every row of its relation is a member: `counted(on(select(Ticket, φ), "show"), fin(Show, "tickets"))`
is a type error, and from JavaScript refused when you build it. A fold's step may still select the members whose
values it reads.

grizzle owns every value a family holds: each count, index, interval, copy and accumulator is drawn on the host on
every write and proved by PostgreSQL, never written by the caller. A fold's running `after` is no generated column: it
is filled by grizzle and proved by `CHECK ((after = combine(before, x)) IS TRUE)`, in exact arithmetic, so a sum is
never narrowed into its column's type unproved.

- **A sequence is nested.** The members of an ordered family or a tree are written under their owner, in order, at
  its count field, each without its group and drawn fields: `insert(Order, [{ id, n: [{ qty }, { qty }] }])`. No
  row of a tree names its `parent`, and only the root names the root field:
  `{ id, doc, children: [{ id, children: [] }] }`. A nested member, at any depth, states no other field: one its
  nesting supplies, one grizzle draws or accumulates, or one its relation lacks is a type error, and from JavaScript an
  `EncodingFailure` (`factShape`) before any SQL. An insert of an ordered member alone is a type error, since its
  order is the nesting's. A tree is written whole: a put or a delete of one of its rows is a type error, and from
  JavaScript refused when the ChangeSet compiles, because a row inserted or removed in the middle shifts every later
  interval.
- **A counted member is a row.** Its group key names its owner, and it is inserted, put and deleted like any row. A
  counted member that is also a sequence's member or a tree's node is inserted nested under its owner in that
  sequence, its group key among the fields it states, and one that owns a sequence is inserted with that sequence's
  members nested under it; grizzle reads each of its counted families' stored groups and appends it there as it
  appends a row inserted on its own.
- **A change rewrites what it shifts.** Every change to one owner's family is one edit of it: an append takes the
  slots after the last; a counted member's removal moves the last member into the freed slot and refills from there;
  an update that changes a step value, or a value a selection or a copy reads, refills from its slot; one that
  changes its group key leaves its old owner's family and joins the new one's; any other update is in place. In an
  ordered family, an insertion or a removal rewrites the later siblings. So a change near the start of a long family
  costs the members after it, and an edit of an owner already stored reads its stored values first
  ([Transactions and concurrency](#transactions-and-concurrency)).
- **A changed owner column reaches its copies and every value drawn from them.** A put of an owner updates its row in
  place, and an edit of one of its families its count and ends; a member's copy of a changed column follows by
  cascade, and a member appended in the same ChangeSet takes the new value. A fold's step or selection, a predecessor
  or last copy, or a tree's copy of its parent's is drawn when its row is written, so a write that changes a column one
  of them reads on a stored row, through such a copy, or as the count or end of an owner that is itself a member,
  refills that value's family: the read flight finds every group the change reaches, along the copies that carry it,
  and grizzle draws each value there again and rewrites those rows in place before the change that would cascade into
  them, members first, so a fold's CHECK holds at every statement; a refill that changes an owner's ends or another
  family's copies refills on in turn. A put that moves a member to another group or changes what its ordered family
  reads of it, and a delete of an ordered family's member, re-place rows, deleting and inserting them again, which no
  cascade follows: every family the re-placed rows own is refilled where its members copy a column the ChangeSet
  changes there, its count among them, and a re-placed row is drawn whole, with its owners' values as the ChangeSet
  leaves them. The owner axis of every family whose members a refill can rewrite or whose
  owner a put or a delete can re-place, and the predecessor axis of every ordered family and tree a refill rewrites
  and a tree's owner axis, are deferred, decided once for the schema. A refill is planned in the first stratum, beside every edit of a family's members, and is
  refused when the ChangeSet compiles (`StaleDerivedRead`) only where grizzle cannot draw it: a put whose rows a query
  states, which grizzle never sees; refills that reach a family they refill again; and a refill of an immutable
  relation's family or rows, an immutable owner's family being fixed when the owner is inserted. A role refills only rows of
  relations it holds whole: the members it rewrites in its write list, and every relation the refill's read passes
  among its own (`OutsideRole`).
- **An immutable owner's family is fixed when the owner is inserted.** Declare `mutable(Owner)` for a family that
  changes later, or an owner you put: a delete of a member of an immutable owner's family, and a put of an immutable
  owner, are type errors, and from JavaScript refused when the ChangeSet compiles. A ChangeSet's type holds its strata,
  so two more are type errors too: an insert of a member of an immutable owner's family in a stratum that inserts no
  such owner, refused where the ChangeSet is compiled (`db.apply`, `db.compile`, `db.explain`, a workload), since a
  later insert or a union may still add the owner; and a ChangeSet that writes a family's members in more than one
  stratum, refused at the call that makes the second, since each stratum's edits are planned from one read before the
  ChangeSet's writes.

## Permissions

Three declarations, all in the [example](#example):

- **`context(name, fields, { claim? })`** is a claim of the session token, read by queries as a table of at most one
  row. Its fields come from the payload's top level, or from the nested object `claim` names. Fields are text, uuid,
  boolean, the integer types, contracts over them, and closed ids, whose claim is a handle's name. Each `Db` decodes
  its contexts once, from what `verify` returns. An absent claim object is no row, and a payload that is not an object
  has none; a context read from the top level refuses such a payload at stage `token`. No rule reads a context, and no
  ChangeSet writes one.
- **`role(schema, name, entries, { write?, refresh? })`** is what one kind of user sees. An entry is a table of the
  schema, whole, or a query over the schema. A query entry becomes a security-barrier view, so its filter runs before
  anything that could fail on a row outside it. It has one flat set of columns, no parameters, no nested results and
  no vector search; aggregates, negation, span comparisons, `take`, recursion, contexts and every Compute operation
  are all allowed, since no expression fails on a value (see [Queries](#queries)), on the rows outside the role a view
  evaluates it on included. Its keys are the ones its query provably has. A role declares no rules of its own: the
  schema's rules hold, whoever writes. A role that writes a family's member reads what grizzle reads of the owner to
  fill the family and, when the owner is mutable, changes that family's drawn count and accumulated ends on it, and
  nothing else of the owner unless `write` lists the owner too: `role(Credits, "metering", Credits.relations, { write: ["Debit"] })` spends grants and
  edits no grant's amount. A roster among a role's entries has no view of its own: every query reads its handles as
  codes.
- **`login(schema, name, roles, { workload? })`** is one PostgreSQL user and one pool for some roles of one schema,
  and owns their workloads, each over the schema or one of the login's roles. Every role is in exactly one login, and
  is reached through it by name, `Web.roles.member`. Two programs of one name across a login's workloads are a type
  error.

`DbLayer.make({ login, snapshot, ... })` builds the login's pool and compiles its workloads, and it requires `verify`
exactly when one of the login's roles reads a context. A layer without `verify` never reads a token, so a `Db` it opens
has no context rows; a layer with `verify` runs it on every token it is handed, for a role that reads no context too.

`Db.open(Web.roles.member, { token })` is the only way to open a `Db`, and only where the layer of the role's login is
provided. It requires `token` exactly when the role reads a context, and runs `verify` once per `Db`, which keeps the
claims it was opened with. A `Db` opened without a token has no context rows. A role that reads no context opens
whatever the payload.

**Queries for a role are written over the role.** `query(MemberBlog)` and `ChangeSet.empty(MemberBlog)` see and write
only what `member` does, and may match only the contexts `member` reads: any other is a type error, and, for a caller
the types don't reach, refused before any SQL. A role that holds every table of its schema whole,
`role(Blog, "staff", Blog.relations)`, also runs every query and ChangeSet written over the schema itself, such as
`postPage`. A ChangeSet can write only the entries in its role's `write` list; anything else is a type error.

### Writing through a role

A query entry in `write` is writable when it has one rule, all its columns come straight from one table, every column of
that table the entry leaves out, a key column included, is fixed by the query to a constant or a claim, and every other
match only filters. A count or end the table's family draws is the one exception: the entry holds it among its columns,
or leaves it out unfixed. `myPosts` qualifies: its columns come from `Post`, and `author` and `org` are fixed
by the token. A role whose `write` names any other entry is refused when you build it, with the reason.

- An insert fills the fixed columns, and may leave out the entry's serial columns as an insert into a table may, also
  when every column of the entry is serial: `[{}]` is one new row of the fixed columns. A serial column the query
  filters on is one every inserted row carries, since the row is checked against the query before its identity is
  drawn. A row the query could never return (a filter it fails, a claim that is absent) is the outcome
  `outside-world`.
- A delete of a row outside the entry does nothing: for this role, that row does not exist.
- An entry over a family's owner writes the owner as a write of the table does: no row states its counts and ends,
  which grizzle draws, and a put updates the entry's own columns in place and leaves the family as it is. Its filter
  may read no count or end, and no key of the table may hold one: a role whose entry does is refused when you build
  it, a `RoleRefused` whose rule is `writeUnwritable` with the `why` `filterReadsFamily` or `keyHoldsFamily`, naming
  the field. The owner's place in the entry would move with writes to its members that no write through the entry
  states, and the table's policy could not judge an owner as it is inserted, before its count is written.
- A put or insert that collides with a row outside the entry, on a key over the table or over a side of it, is
  `invariant-rejected` on that rule, and the witness is the key you submitted, in the entry's fields, never the other
  row. An error PostgreSQL still raises there is a typed failure, never an outcome.
- A column fixed directly by a claim, like `author`, holds the claim's value in every row and is never updatable: no
  role holds UPDATE on it, so a direct writer's `SET author = author` is refused with 42501. A column fixed by a claim
  through a join stays updatable.
- One step of a ChangeSet may not write a query entry and also a table that entry's filter reads, because the result
  would depend on statement order; it is refused when it compiles. `ChangeSet.sequence` puts them in order.
- When a ChangeSet both writes a row outside the entry and breaks a rule, which of the two it reports is not
  promised.

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

A rule reads like a pattern. `v(Post, "post")` makes one variable per column, in a scope named `post`.
`r.match(Post, { ... })` binds variables and constants to a table's columns, and a variable used in two matches joins
them. `.where(...)` filters, and `.find(...)` picks the result columns: variables, aggregates, parameters, constants
and computed values. Two scopes of one table are two names: in `sameTitle`, `v(Post, "post")` and `v(Post, "twin")`
are two sets of variables of two types, so the keys a self-join's type proves are its own, as for any join. A rule
holds one scope of each name: a second `v` with a name the rule already holds is refused with `DuplicateIdentity` when
the rule is built, because no type tells two calls of one name apart.

The rows are typed from the query: `commentsPerAuthor` gives `{ author: string; comments: bigint }`, and `viewsPerOrg`
gives `{ org: string; views: Decimal }`, because PostgreSQL's `sum` of a bigint is a numeric. `orgPosts` takes the
parameter `{ org: string }`.

| To               | Write                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| join             | one variable in two matches                                                                                            |
| self-join        | two scopes of one table under two names, `v(Post, "post")` and `v(Post, "twin")`                                       |
| filter           | `r.eq`, `r.ne`, `r.lt`, `r.le`, `r.gt`, `r.ge`, `r.between`, `r.inSet` (of an empty list, false: no row), `r.and` (of no predicate, true: every row), `r.or` (of no predicate, false: no row) |
| exclude          | `r.not(Table, { ... })`: no matching row exists                                                                        |
| take a parameter | `r.param("name", type)`: a term of that type, which stands wherever such a term does                                  |
| pass a row list  | `r.relation("name", fields)`: a parameter that is a list of rows, matched like a table                                 |
| aggregate        | `r.count()`, `r.sum(x)`, `r.mean(x)`, `r.min(x)`, `r.max(x)`, grouped by the other columns of `find`, over matches that each bind a key; a sum of real or double precision values is their exact total rounded once, of money values exact money, a mean that total over the count; a min or max is one of its values, at its type, contract included |
| combine          | a second `.rule(...)`: the union of both rules' rows; rules of different columns need a constant that tells them apart, a rule with an attachment shares its columns with no other rule, and a take or an attachment over a union of several headings is no rule of a further union, takes once and is never paged |
| nest             | `.attach(name, (parent) => child, delivery)`: `"array"`, `"option"`, `"one"`, or `arm(field, name)`                    |
| order and limit  | `.orderBy(["title", "asc"])`, then `.take(10)` or `db.page`                                                            |
| recurse          | `query(S).recursive(...)`                                                                                              |
| compare spans    | `r.allen` with `ALLEN` masks, `r.pointIn`, and `r.intersection`, `r.difference`, `r.pack`                              |
| compute          | `Compute.add`, `Compute.mul`, `Compute.round`, `Compute.cond`, `Compute.when` and the rest of `Compute`                |
| match text       | `Compute.matches(x, pattern)`, `Compute.startsWith`, `Compute.endsWith`, and `Compute.concat` in checks               |
| search vectors   | `.approximateNearest(...)`, with pgvector                                                                              |

Six things work differently from SQL:

- **A query returns a set, and an aggregate folds keyed rows.** Identical rows are one row. An aggregate reads each
  row its rule matches once, by its key: in a rule with an aggregate, every match binds a whole key of its source, by
  a variable, a parent's variable or a constant, as `commentsPerAuthor` binds the comment's `id`, or the query is
  refused with `FoldOverProjection`, naming the match and the key to bind. To aggregate distinct values, match a query
  of them, a set keyed by its columns.
- **grizzle knows each result's keys.** It works them out from primary keys, equalities and constants, and keeps a key
  through `find` whenever the chosen columns still determine the row. `db.get` takes only a query that returns at most
  one row, an `"option"` or `"one"` nested result needs the same proof, and a page is ordered by a key. A delivery the
  schema does not prove is a type error. `.orderBy(...).take(k)` is a set again to whatever composes with it, a match,
  a further rule, a derived relation or a role's query entry, and `take(1)` returns at most one row. Its order is for
  delivery: a query or a nested `"array"` that ends in a take arrives in the take's order, ties broken by the query's
  key, and a final `orderBy` after the take orders it anew.
- **Variables belong to their columns.** In one rule, two variables made from the same column of a table the rule
  matches once are refused, and the error shows the rewrite: make the variable where it is bound, or match the table
  again.
- **A constant is a JavaScript value or a typed term.** A JavaScript value takes the type of what it meets: the
  column it is bound to, the term it is compared with, the field a write puts it in, or the type a union's other
  arms give its head field. With nothing to meet it takes its own: a string is text, a safe integer an integer, a
  bigint a bigint, a `Decimal` a numeric, a `Money` money and a boolean a boolean; any other value is refused. It
  never stands first in a comparison, and a list such as `r.inSet`'s holds JavaScript values only. A typed term
  states its type and stands wherever a term of that type stands: `Status.handle("Published")` is a member of the
  `Status` roster, and `Compute.literal(F, x)` is x at the type of any other descriptor F. A head keeps a handle's
  member in its rows, so `find({ status: Status.handle("Published") })` delivers `status: "Published"`;
  `Compute.literal` delivers F's type. Wherever a term meets a column or another term, both are of one type: one SQL
  type, one contract and one roster, so a text term never meets a uuid column and two rosters of the same members
  never meet. A pattern is no part of a text's type: texts of any two patterns meet, as PostgreSQL compares them. A
  JavaScript value opposite a term, at a column, for a parameter or in a fact is one of its type's values: a pattern's
  language, a uuid's hyphenated spelling, a roster's names, so `"abc"` at a uuid column is a type error, and so is a
  plain `string` until `Uuid.parse` reads it. The rules of one query deliver each field they share at one type, and a JavaScript value takes the type
  the other rules give its field.
- **A value is only its value.** Under every plan a query delivers the same values. A `Decimal` has no display scale:
  `1`, `1.0` and `1.00` are one value, delivered as `1`, and a `pg.numeric(10, 2)` field rounds what it stores to two
  places but delivers `12.5`, not `12.50`; print it at the field's scale with
  `new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(d.toString())`, which formats the decimal
  string exactly. A float's zero is `0`, never `-0`. A numeric quotient, power, square root or mean is PostgreSQL's
  for the values alone, as if every operand were written without trailing zeros: `Compute.div(x, 3n)` is the same number
  whatever scale `x` was stored at. A sum of `real` or `double precision` values is their exact total rounded once to
  the result type, a sum of `Money` values their exact total, and a mean of floats that total over the count, rounded
  once: the same rows give the same sum in any order, under any plan. Every answer is a function of the facts, with
  two declared exceptions, both pgvector's: `.approximateNearest` returns candidates from pgvector's index, so which
  rows it returns, and how many, depend on the index and on the database owner's pgvector settings as well as the
  facts. grizzle pins only `hnsw.iterative_scan = strict_order`, which keeps the candidates and their cursors in exact
  distance order; `hnsw.ef_search`, `hnsw.max_scan_tuples` and `hnsw.scan_mem_multiplier` are the owner's, and a scan
  that reaches their bounds returns fewer rows than asked. `Compute.cosineDistance` is pgvector's own float
  arithmetic, the same for the same vectors on every evaluation by one server, but it may differ in the last place
  between pgvector builds or CPUs.
- **No read fails on a value.** Every Compute operation is defined on every value its operands' types admit, or its
  precondition is proved where it stands, so no query, role view or check raises an arithmetic error on any row.
  Integer arithmetic is exact and delivers `bigint`, an *exact integer*; money arithmetic delivers exact `Money`; both
  never overflow. Float arithmetic is IEEE 754: `x / 0.0` is ±Infinity and `sqrt(-1.0)` is NaN. A partial operation, a
  division or remainder by a value that may be zero, a numeric square root of one that may be negative, a power,
  `widthBucket` and `minScale` of values that may be infinite, a cast that narrows, needs its precondition proved: by
  a literal's own type, as in `Compute.div(x, 7n)`; by a contract that declares it,
  `contract("Divisor", pg.bigint, (v) => v.ne(0n), { proves: ["nonzero"] })`; or by a guard,
  `Compute.when(Compute.nonzero(b), (b) => Compute.div(a, b), 0n)`, whose function receives `b` proved nonzero and
  whose last argument is the value where the guard does not hold. The guards are `Compute.nonzero`,
  `Compute.nonnegative`, `Compute.positive`, `Compute.isFinite` and `Compute.within(x, low, high)`, and each is a
  predicate too. A guard's subject is any term, a parameter among them:
  `Compute.when(Compute.nonzero(d), (d) => Compute.div(x, d), 0n)` over `d = r.param("d", pg.bigint)` delivers `0n`
  where `d` is bound to zero, under every plan, since PostgreSQL computes a branch only where its condition holds. A
  contract's facts are exactly the ones its `proves` declares: compilation proves each from the predicate and refuses
  a declaration the predicate does not imply, and a fact the predicate implies but `proves` leaves out is no fact of
  its values, so `Compute.minScale(rate)` over `contract("Rate", pg.numeric(7, 6), (x) => x.between(0n, 1n))` is
  refused, naming `{ proves: ["finite"] }` to add. A parameter of a contract has the facts it declares, its binding
  checking every value, so `Compute.div(x, Compute.base(r.param("d", Divisor)))` needs no guard. An unproved divisor is
  a type error that names the guard to write. A precondition that rests on
  magnitudes, a narrowing's range or a power's, compilation proves from `Compute.within`'s bounds, or refuses as
  `PartialOperation`: narrow an exact integer into an integer field with
  `Compute.when(Compute.within(x, 0n, 1000000n), (x) => Compute.cast(x, pg.integer), 0)`. An exact value binds at a
  plain integer or money column, but a ChangeSet member stores one into a field only through that cast: a head that
  writes `Compute.add(balance, amount)` into a `pg.bigint` field is a type error. An exact value and a plain value of
  its family share no type: where PostgreSQL widens the plain one implicitly, `Compute.cond`, `Compute.when`,
  `Compute.least` and `Compute.greatest` refuse one beside the other in either order, naming the cast of the exact one
  into the plain one's type. A bare literal takes its term's type, an exact one's included, and is refused where its
  value has more digits than that type holds.

Text has eight terms. `Compute.matches(x, pattern)` is PostgreSQL's `~`: whether `x` holds a match of a pattern in
`str.regex`'s grammar under the flags `"u"`, which `^` and `$` anchor. The pattern is a string, which the type checker
reads as `str.regex` reads its own, or a text term whose every value the schema holds: a closed relation's text
payload, as in `Compute.matches(lexical, ValueDomain.at("pattern", domain))`, or a `Compute.cond` of such terms. Each
value is admitted when the schema compiles, inside PostgreSQL's regex compile space as a `str.regex` pattern is
([Limits](#limits)), and written into the SQL as the pattern PostgreSQL reads, so `~` never sees a pattern grizzle has
not measured; a field, a parameter or a computed text can be any pattern, and as a pattern it is refused. A match is
a guard too: `Compute.when(Compute.matches(code, "^[0-9]+$"), (code) => …, otherwise)` hands its branch the subject,
which compilation reads as text of the pattern's language, and over a pattern term it is a conditional. PostgreSQL's
regex engine widens its subject to four bytes for every byte before it matches, so a query matches only a text whose
pattern bounds it within 268,435,454 bytes; a check, a law's selection or a generated field matches any text.
`Compute.startsWith(a, b)` and `Compute.endsWith(a, b)` test a prefix and a suffix, by characters.
A text's bytes have a guard too, `Compute.within` over its `Compute.octetLength`:
`Compute.when(Compute.within(Compute.octetLength(x), 0, 64), () => Compute.cast(x, Name), "")`, with `Name` a
`str.bytes(64, pattern)` whose pattern holds x's, reads `x` inside the branch as at most 64 UTF-8 bytes of its own
pattern, so a text of no byte bound casts into it; like `octetLength`, it stands in checks, contract predicates and
generated fields.

A text parses into a typed value: `Compute.cast(lexical, T)` is PostgreSQL's own cast from text into an integer type,
`pg.numeric(p, s)`, `pg["double precision"]`, `pg.boolean` or `date`, read as XML Schema reads `xs:integer`,
`xs:decimal`, `xs:double`, `xs:boolean` and `xs:date`. Each type has one lexical form, `lexicalForm(T)`: XML Schema's
lexical space cut to the values `T` holds exactly, so the cast never raises and never rounds. An integer is
`[+-]?[0-9]+` within its type's range, the 19th digit of a bigint included; numeric(p, s) holds at most `p - s`
integer and `s` fraction digits besides leading and trailing zeros; a double is a mantissa of at most 15 significant
digits either side of its point with an exponent of at most 293, or `INF`, `-INF` or `NaN`; a boolean is `true`,
`false`, `1` or `0`; a date is `YYYY-MM-DD` from 0001 to 9999, leap days by the Gregorian rule, with no timezone. The
cast is total, and compiles, exactly when its operand's every value is a member of the form: a field typed
`lexical(T)`, `str.regex(lexicalForm(T))`, or any pattern whose language lies inside the form, which compilation
proves by comparing the two languages' automata, or a subject under `Compute.when(Compute.matches(x,
lexicalForm(T)), (x) => Compute.cast(x, T), otherwise)`. Anything else is `PartialOperation` with the precondition
`lexical`, and a pair of languages whose automata the comparison cannot build within grizzle's bounds, 2,048 DFA
states and 2,097,152 NFA-state visits, is `ResourceBound`, naming both patterns. So a typed value derived from its
lexical form is a generated field, `generated(pg.bigint, Compute.cast(row.count, pg.bigint))`, NOT NULL and computed
by PostgreSQL from the text it agrees with, and a law reads it as it reads any field. A numeric's cast is
`::numeric(p, s)`, which the form keeps from rounding; a date's is `make_date` over the text's year, month and day,
since `text::date` reads `DateStyle` and is STABLE, which a generated column refuses. The host reads each form by a
scan of its own and agrees with PostgreSQL to the bit, a double's rounding included.

`Compute.concat(a, b)` is `a || b`, text of no pattern. A concatenation allocates its result, so it stands in checks,
contract predicates, generated fields and folds, and in a query only as a side of `Compute.eq` or `Compute.ne`, which
is decided without building it: by the lengths, a prefix and a suffix, and NULL exactly where `a || b` would be. Its
first operand is a term, as every operation's is, so a leading literal is a typed constant,
`Compute.concat(Compute.literal(Prose, "item-"), id)`.

`Compute.translate(x, from, to)` is PostgreSQL's `translate`, by characters: each character of `x` that `from` holds
becomes the character of `to` at its position, so `Compute.translate(title, "\t\n\r", "   ")` reads a title in
`xs:normalizedString`'s value space. `from` and `to` are strings of one length, and `from` holds each character once:
PostgreSQL deletes a character `to` has no counterpart for and maps a repeated one by its first occurrence, so either
is refused where the call is written. `Compute.lowerAscii(x)` is `translate` from `A` to `Z` onto `a` to `z`: it lowers
no other letter, so it is one IMMUTABLE map whatever the collation, as a case-insensitive BCP 47 language tag needs.
Compilation reads a translation as text of the image of `x`'s language, every class and character of its pattern
rewritten by the map, so a bounded pattern stays bounded and a literal opposite it is judged by the image; a query's
head delivers one cast into a text type some field declares, or into `Prose`, since no domain is installed for the image
itself. A cast of a text into a refined text is total where the text's language lies inside the target's, which
compilation proves by comparing their automata as it proves a parse, so a translation is stored in a field of a type
the image lies in: `generated(Normalized, Compute.cast(Compute.translate(row.title, "\t\n\r", "   "), Normalized))`,
`Normalized` being `str.regex("^[^\\t\\n\\r]*$", "su")`. PostgreSQL's translate allocates four bytes for every byte
of `x`, so a query translates only a text whose pattern bounds it within 268,435,454 bytes, and a check or generated
field translates any text.

XML Schema's other two whiteSpace facets are terms too. `Compute.replaceWhitespace(x)` is its replace,
`Compute.translate(x, "\t\n\r", "   ")`. `Compute.collapse(x)` is its collapse: each run of tab, LF, CR and space one
space, and none at either end, `btrim(regexp_replace(x, '[ \t\n\r]+', ' ', 'g'))`, both functions IMMUTABLE and the
bracket reading no collation, so it stands in a generated field. No other character is white space to it, a no-break
space and a line separator among them. Collapse never lengthens a text, so compilation reads the result as text within
`x`'s length bound, of runs of `x`'s other characters a space apart. That is exactly the image of `x`'s language where
it is cheap to state: a pattern with no white space, which collapse leaves as it is, and a class repeated freely,
`^[...]*$`, the wildcard among them, whose image is every collapsed text over its other characters,
`^(?:[^ \t\n\r]+(?: [^ \t\n\r]+)*)?$` for `Prose`. Any other pattern's is more than its image: a bounded one of
at most n characters, n up to 257, is every text of at most n characters beginning and ending with another character,
`^(?:[^ \t\n\r](?:[^\t\n\r]{0,n-2}[^ \t\n\r])?)?$` for `^.{0,n}$`, two spaces together included; and any other
the collapsed texts over its characters, unbounded. Store one as a translation is stored,
`generated(T, Compute.cast(Compute.collapse(row.title), T))` for a `T` the result lies in. A query collapses only a text
whose pattern bounds it within 268,435,454 bytes, since collapse is a regex read.

There are no outer joins. Where SQL would LEFT JOIN and fill the gaps with NULL, a second rule covers the rows that
have no match:

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

Every read takes a query and its parameters, and runs in one READ ONLY transaction, so a query's nested results and a
page's rows see one snapshot.

- **`db.execute(query, params)`** gives a result whose `collect` is the rows; each run of `collect` runs the query
  again.
- **`db.get(target, params)`** gives an `Option` of one row: of a table by its key, `db.get(Post, { id })`, or of a
  query that returns at most one row.
- **`db.page(orderedQuery, params, { first: 20 })`** pages by key, with opaque cursors: `{ first }`,
  `{ first, after }`, `{ last }` or `{ last, before }`. There is no default page size and no largest one: a size is
  any safe integer of at least 1.
- **`db.explain(program, params)`** returns PostgreSQL's estimated plans as data, in the order the program's statements
  would run, never EXPLAIN ANALYZE. A plan node holds its node type, its estimated startup and total cost, rows and
  width, and its children, nothing else: the relation and index names and the conditions PostgreSQL reports are
  dropped.

A program in the login's workloads is `db.workload.<name>`, compiled when the layer was built, with exactly the
operations it allows; its statements are prepared on each connection's first use and kept for the pool's life. Any
other program, one built at run time included, still runs: `db.execute` and the others compile it for the call and
send it as unnamed statements, with no index promised for it. `db.compile(program)` compiles a query, ordered query or
ChangeSet once and returns a handle with exactly the operations it allows; its prepared statements close, and its
compiled form drops, when the handle's `Scope` ends.

## Writes

A write is a ChangeSet: the rows to insert, delete and put, applied as one transaction.

```text
ChangeSet.empty(Blog)               a write over a schema, or over a role: ChangeSet.empty(MemberBlog)
  .insert(Post, rows)               add these rows; a row already present is no change
  .delete(Comment, rows)            remove these rows
  .put(PostViews, rows)             after the change, the row at each key is the one given
  .read("name", (delta) => query)   a query over the result, delivered in the outcome
```

- **Rows** are an array, an Effect `Stream`, or a query. A query reads the state before the change, in the same
  transaction, which is how a write depends on a read: there are no interactive transactions.
- **A row holds the fields its caller writes**, `Written<R>`, for an insert and a put alike: never a generated, drawn
  or accumulated field ([How a field is written](#how-a-field-is-written)). A family's member is a row of its own,
  nested under its owner only in a sequence ([Families](#families)), and is written from an array or a `Stream`, never
  from a query or through a query entry, since grizzle draws its family's values from its rows on the host. Its owner
  may be written through a query entry whose filter reads none of the counts and ends grizzle draws
  ([Writing through a role](#writing-through-a-role)).
- **A relation's rows are a set.** Identical rows are one row, however often they are given. Two rows of one relation
  that share a key and differ elsewhere are `invariant-rejected` on that key before any SQL is sent, and an array
  literal of such rows, its keys literals, is a type error.
- **Serial columns** may be left out of an insert's rows, all of a row's serial columns or none of them. A row that
  leaves them out is a new row whose serial values the identity draws, and equal such rows are one new row; a row
  that leaves out only some is an `EncodingFailure`. A table whose every column is serial takes `[{}]`: one new row.
- **`read`** runs a query after the change and before COMMIT; `delta.added(T)` and `delta.removed(T)` are the rows
  this change added and removed.
- **`ChangeSet.union(a, b)`** applies both as one change; **`ChangeSet.sequence(a, b)`** applies `b` after `a`, in the
  same transaction.
- **A stratum's statements run in one order every immediate key keeps.** Its inserts, puts and deletes, and the
  statements that write its families' members and count their owners, are ordered by every immediate foreign key
  between them: a referenced row is added before the rows that name it and removed after them, so a family's
  members are deleted before their owner and a row that names a member is inserted after it. A stratum those keys
  order in a cycle is refused when the ChangeSet compiles (`UnorderableStratum`): write one of its writes in another
  stratum, `ChangeSet.sequence`.
- **`db.apply(changes, params)`** answers `accepted` (with each table's counts and the read-backs), `no-change`,
  `invariant-rejected` or `outside-world`. An input holds any number of rows: each travels as one array per column.

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

`publish` takes `{ id: Uuid }`. Applied twice, the second answers `no-change`: the post is no longer a draft, so
the query finds nothing to put. `purge` takes `{ author: string }`, and its `accepted` outcome carries
`reads.removed`, typed `ReadonlyArray<{ comments: bigint }>`: what `RETURNING` would give you, as a query over what
the change removed.

## Derived tables

`derived(name, query)` stores a query's rows as a materialized view, with a unique index on each key the query
provably has. Columns the query makes equal count as one column of a key, so k equal pairs make one key rather than
2^k; the index holds the first of them, and any of them stands for it in a `get`, a nested result or an order. Add a
derived table to a schema with `schema.extend`. It changes only when you refresh it: `db.refresh(...tables)`, on a
role whose `refresh` list names them, refreshes them in one transaction. `db.refresh()` with no table is a type error,
so narrow a list built at run time with `Array.isReadonlyArrayNonEmpty` first. Rules are declared on stored tables,
never on derived ones.

## Migrations

`grizzle.config.ts`, which every command names as its argument:

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

Every setting is required, and nothing else is configurable: `schemas`, the declared schemas; `logins`, every login
and through them every role and workload; `migrations`, the directory, relative to the config file's directory; and
`connection`, where `migrate` and `drift` connect as the role that owns the schemas, its password a `Redacted` or an
Effect evaluated for each connection attempt. grizzle reads no file you don't name and no environment variable for
where to connect: the config reads its credentials itself, as the password Effect does.

The loop: change the schema in code, run `grizzle generate grizzle.config.ts`, read the SQL it drafts, resolve its
markers, run `grizzle check grizzle.config.ts`, commit, and run `grizzle migrate grizzle.config.ts` from CI or the
deploy. A migration's name, `--name` or derived from its change, is at most 240 characters, so that its folder
`<timestamp>_<name>` fits one file name (NAME_MAX, 255 bytes); `--custom` needs one.

- **Drafted from a snapshot, never from a live database.** `generate` compares your schemas, their roles and logins,
  and every login's workloads with the committed `migrations/<schema>/snapshot.json`, and writes a folder
  `migrations/<schema>/<timestamp>_<name>/` of numbered SQL files with its `meta.json`, and the new snapshot. The
  config refuses a login over a schema it doesn't list, and a login missing from `logins` is not installed, nor are
  its roles.
- **Plain SQL you may edit.** What the schema no longer has is dropped in the same migration, as declared; a declared
  rename or a type change happens in place. Roles' views, policies and functions hold no data, so one that changes, or that reads
  anything the migration changes, is dropped and created again in one transaction. Edit the SQL as you need: whatever
  it does, the database must end where the snapshot says.
- **No guessing.** grizzle never guesses a rename, and drops nothing you didn't declare. Declare each rename to
  `generate` with `--rename <old>=<new>` and each drop with `--drop <old>`, once per name, each side a relation
  (`Task`), a field (`Task.title`), a roster's handle (`Status#done`) or a login (`@web`). A renamed relation keeps its
  rows, a renamed field its values, a renamed handle its code, and a renamed login its PostgreSQL role
  (`ALTER ROLE ... RENAME TO`), with its password and what was granted to it. A name the schema no longer holds that no
  declaration names is refused, naming it: a stored relation, a field written by its caller, a handle, or a login,
  whose password and outside grants no migration can give back. A draft that needs a value carries a marker: a value
  for a new column on a table with rows. A schema's first migration that abandons schemas the configuration no longer
  lists is drafted commented out, and `check` and `migrate` refuse the folder until you decide it.
- **Codes are history.** The snapshot records each roster's codes. A new handle takes the next code, a renamed one
  keeps its own, and a removed one leaves a hole no handle takes again. The migration installs the roster's new names
  constant and validates its domain against it, which refuses every row still holding a removed code, naming its
  table and column: change or delete those rows in a data step first. A set over a roster that grows is converted to
  its wider domain in place, with the new handles absent. A roster declared out of its codes' order is refused before
  anything is drafted: append new handles.
- **A closed relation's change is a new constant.** Its constants are named by their contents, so a change installs
  new ones, replaces and validates every CHECK that reads them, gives every generated field that reads them its new
  expression (`SET EXPRESSION`), and drops the old ones `RESTRICT`: PostgreSQL itself refuses a migration that missed
  a reader. A rule over closed relations alone runs as its violation query at the start of the migration's first
  file, when it is new or its closed rows changed, so rows that break it refuse the migration before it changes
  anything. A slotted key reads its owners' counts, never its slots' roster's size, so a changed count replaces its
  counts' constant and its rows', and its owners' bases where they move, and a grown or renamed slot roster replaces
  none.
- **A family added to stored rows is backfilled.** grizzle draws every value a family holds, so a family new to
  relations that may hold rows takes its values from SQL over those rows, in the migration that adds it, never from
  you: each member's index in its member key's order, each count, each fold's running values in index order, and a
  tree's intervals. Its constraints are added after the backfill, `NOT VALID`, and validated, so a value drawn wrongly
  refuses the migration. A family whose values the stored rows alone don't give (a fold over a tree, a copy along an
  axis) is refused, naming the family. The backfill's window functions and its one recursive step over a tree are
  migration SQL you review; queries at run time hold neither.
- **`check` reads no database.** It refuses a schema change you haven't generated, a drop no declaration names, a
  workload program whose index needs differ from the snapshot's (naming it), an unresolved marker, an undecided data
  loss, and an edited `snapshot.json` or `meta.json`.
- **`migrate` connects with the config's `connection`** as the role that owns the schema and the database, in a
  process environment that sets neither `PGOPTIONS` nor `PGREPLICATION` (refused at stage `environment`), applies the
  pending files, records each in the schema's ledger, and then refuses drift: a database that is not exactly the
  snapshot's. It judges drift after its files, so on a database changed by hand it applies them, then refuses. `drift`
  runs that check alone, for CI or a schedule. Both judge the database as it stands, not the statements that made it:
  a grant already held or a revoke of a privilege never held changes nothing.
- **Names come from your code.** `TaskNote` becomes `task_note` for the schema, tables, derived tables, rosters'
  domains, contracts, columns, row checks and a role's views; a contract's CHECK is `check`; a login's or role's PostgreSQL
  role, like a role's schema, is `<schema>__<name>`. Two names that become the same name are refused, as is a name
  starting with `_`, one longer than 63 bytes once converted (a login's or role's with its schema's), and a schema
  name starting with `pg_`. Everything else (keys, foreign keys, indexes, functions, triggers) is named
  `__<readable part>_<digest>`, carries a COMMENT saying what it is, and is listed by `grizzle names`. PostgreSQL roles
  are cluster-wide, so one schema name is one installation per cluster. Every name grizzle's SQL holds names its
  schema: a table as `"shop"."task"`, a PostgreSQL type as `"pg_catalog"."text"` or its keyword (`integer`), a
  PostgreSQL function as `"pg_catalog"."count"`. So a relation may be called `Text` or `Uuid`, and no search_path, the
  database's, a role's or a session's, changes what a migration or a query means.
- **Indexes follow the code.** Every index comes from a rule, from a workload program's queries through the roles they
  read, or from a role's write filter. An edit to a workload program that needs no other index just takes effect; one
  that does, or a program added, renamed or removed, is refused by `check` and by `DbLayer.make` until you run
  `generate`.

The [agent guide](packages/grizzle/skills/grizzle/SKILL.md) is the full workflow: markers, renames, legal edits,
refusals and deploys.

## Errors and outcomes

A broken rule is an outcome, not an error. An error is something that went wrong, and lives in the Effect's error
channel as a tagged class.

**Outcomes** come from `db.apply` and a compiled ChangeSet's `apply`:

- `invariant-rejected` carries `refused`, the rules as your schema states them, never empty, and how grizzle decided
  them, and `witness`, which says what broke them. Match on a law directly:
  `{ kind: "check", relation: "Grant", name: "WithinGrant" }`. `refused` is one of two:
  - `{ kind: "every", laws }`: every rule grizzle decides refused the write. A row check that refused a row you stated
    names every rule of that row's table's checks the row breaks as the write fills it, its counts, ends, indexes and
    copies at the values grizzle draws for it, each once, in your schema's canonical order of rules
    (its primary keys', then its statements' in canonical order, the order its snapshot lists them, which depends on
    what the schema says, never on how you wrote it), whichever check PostgreSQL tried first. Any other rule is the one
    the failing constraint states, or, where one PostgreSQL object discharges several and its report does not say which
    failed, each of them: a family's foreign key carries every containment merged into it, and one domain serves every
    contract and pattern of the same definition.
  - `{ kind: "first", laws }`: a row check that refused a row only PostgreSQL computes, which no ChangeSet states (a
    query's, or one grizzle fills on a family), or a row you stated one of whose table's checks reads a value grizzle
    does not hold on the host, such as a count or an end a put keeps from the stored row: the rules of the check
    PostgreSQL tried first, never more, since grizzle cannot decide that check. PostgreSQL tries a
    table's checks in the order of their installed names, which no version of grizzle keeps, so the row may break
    others too, and another version may name another of them.
- The witness is `{ kind: "key", relation, values }`, the key values of one row that breaks the rule, never another
  column; or `{ kind: "unreported" }`. A key, over a table or over a side of one, that grizzle's own write statement
  finds broken, by two rows you submitted or by a stored row inside or outside your role's view, names the key you
  submitted, in the fields you wrote it in. A rule PostgreSQL refuses itself, a row check, a contract, a pattern or a
  generated field, states its row only in its message, which grizzle never reads, so grizzle judges, on the host, the
  rows the refused statement wrote that your ChangeSet states (an inserted or put row, a query entry's row, a nested
  member) by the rule over their fields as the write fills them: the witness is the key of the first that breaks it,
  in the fields you wrote it in. It is `unreported` for a foreign key, and where no row you stated breaks the rule: a
  row only PostgreSQL computes, a query's, one whose rule reads a value grizzle does not hold on the host, a rule over
  what the host does not evaluate, or a row whose key PostgreSQL draws.
- `outside-world` names the role's table a row cannot belong to.

A value its contract or pattern refuses passes the encoder, which checks only the base type, and is refused by its
domain's CHECK as the statement casts it, before the row's constraints and row-level security: `invariant-rejected` on
the contract's or pattern's rule, its witness the key of the row you stated that holds the value. So is a value
PostgreSQL generates into a refined field, and one grizzle fills into a fold's accumulator or end: the witness is the
key of the row you stated whose generated or filled value breaks it, and `unreported` where that row is one only a
refill writes, such as a stored owner whose family the write appends to.

<details>
<summary>Every rule an outcome can name</summary>

| `law.kind`   | Its fields                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `primaryKey` | `relation`, `fields`: a relation's primary key (a span field makes it a no-overlap key)                  |
| `key`        | `side`: a key statement, a candidate key of its relation when its side reads every row and its terms are fields |
| `check`      | `relation`, `name`                                                                                       |
| `contained`  | `from`, `to`: a containment, a foreign key included; an `alternatives` statement and a `mirrors` are their containments |
| `coverage`   | `from`, `to`: a containment whose sides pair a span field                                                |
| `family`     | `order` (`"ordered"` or `"counted"`), `member`, a side, and `slots`, `{ owner, count }`                  |
| `tree`       | `member`, `slots` and `root`, the root field                                                             |
| `fold`       | `family`, its slots; `monoid`; `step` and `end`, sides                                                   |
| `contract`   | `contract`                                                                                               |
| `pattern`    | `source`, `flags`: one rule for every spelling of the same language                                      |
| `generated`  | `relation`, `field`: a generated field whose term has no value at a row, a closed read at a key its relation lacks |

A side is its `relation`, its `terms` in the order the rule pairs them, each `{ kind: "field", field }` or
`{ kind: "pred", field }`, and its `selection`, `{ conjuncts }`: each conjunct a row predicate in its canonical form
(a literal second, `gt` and `ge` between two terms as `lt` and `le`, `eq` and `ne` with their terms in canonical order,
an IN list's values a set), in canonical order, and none for a side that reads every row.

</details>

`lawsOf(schema)` lists every statement of a schema, in the order you declared it, its base's first, each with the
rules an outcome names when that statement is broken: a key's, a check's, a containment's, a family's, a tree's or a
fold's one rule, a mirrors' two containments, an alternatives statement's containments, and none for `mutable`. It
compiles the schema's rules once per call, so call it once and keep the list. `sameLaw(a, b)` says whether two rules
are one, so `refused.laws.some((law) => entry.laws.some((rule) => sameLaw(law, rule)))` says whether a refusal names a
statement's rule.

**Errors**, by operation:

| Operation                 | Fails with                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `DbLayer.make`, `Db.open` | `OpenError`                                                                                                        |
| a read                    | `ReadError`: `ReadFailure`, `TransientFailure` or `StaleSnapshot`; a page also `CursorError`                       |
| a write or refresh        | `EncodingFailure`, `TransientFailure`, `TransportFailure`, `ExecutionFailure`, `CommitUnknown` or `StaleSnapshot` |
| `db.compile`              | `CompileError`                                                                                                     |

- Every error names what happened as its `reason`, a tagged value of its own, so `Effect.catchReason`, `catchReasons`
  and `unwrapReason` reach it: `Effect.catchReason("TransientFailure", "PutTargetConflict", f)` handles one case and
  keeps the rest. Its `stage` follows from the reason, and its `message` is a sentence naming it. Read details from the
  reason, never from the message. Reasons are types only; the exported classes are the errors, plus
  `CredentialError` and `TokenError`, which your `password` Effect and your `verify` fail with.
- **`TransientFailure`** means the attempt changed nothing and may succeed if you run it again. Its reason is
  `SerializationFailure` (40001), `Deadlock` (40P01), or a concurrent transaction's work the statement met
  (`PutTargetConflict`, `GeneratedSerialUnique`, `SpanKeyChange`, `UnseenOccupant`, `ConcurrentRefresh`,
  `StaleStatement`), with the server's report as its `error`. grizzle never retries; use `Effect.retry` with your own
  `Schedule`. `Db.open`'s retryable case is an `OpenError` whose reason is `AdmissionTransient`: open again.
- **`CommitUnknown`** means COMMIT was sent and no answer came back. The change may have committed: read back before
  you run it again.
- **`StaleSnapshot`** means the database is not at the snapshot the `Db` was opened with, and the call ran nothing:
  its reason is `Migrating` while a migration runs or one stopped part-way, and `Migrated` once a migration to another
  snapshot completed. Running the call again on the same `Db` meets it again; open a `Db` with the snapshot the
  database holds.
- **`TransportFailure`** means the connection failed before the write could commit, and it changed nothing.
  **`ExecutionFailure`** carries the server's error or a compile failure, and says what the transaction did.
- A connection that can't be had (a failing `password` Effect, TLS, the server, a released layer) fails a read with
  `ReadFailure` at stage `acquire`, and a write with `TransportFailure`. Waiting for a session is no failure: a call
  waits until it has one or is interrupted.
- Every error PostgreSQL raised carries a `ServerError` with its `sqlstate`, its `message`, `detail` and `hint`
  exactly as the server gave them, and the `constraint`, `schema`, `table`, `column` and `dataType` it named; an
  error's `message` quotes the server's. The server writes its message, detail and hint in the language of its
  `lc_messages`, the database owner's setting; grizzle reads an error by its SQLSTATE and the fields it names, never
  by its words. These can quote the values a statement was given, though never a value outside the role's view, so
  what you log is your choice: grizzle logs nothing.

<details>
<summary>Every error reason</summary>

**`OpenError`**, by stage:

| Stage                       | Reason                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `credential`                | `CredentialError`                                                                                                                       |
| `tls`                       | `TlsRefused`                                                                                                                            |
| `authentication`, `connect` | `StartupRefused`, with the server's report (`authentication` for SQLSTATE class 28)                                                    |
| `connect`                   | `ConnectTimedOut`, `SocketFailed`, `ConnectionClosed`, `DriverRefused`, `NoCancelKey`                                                   |
| `released`                  | the pool's `LayerReleased`, a layer whose scope has closed                                                                              |
| `config`                    | `DbConfigRefused`; `ConnectionEnvironmentRefused`, a process environment that sets `PGREPLICATION`                                     |
| `role`                      | `RoleOutsideLayers`, `LoginNameRefused`                                                                                                 |
| `token`                     | `TokenError`, `verify`'s refusal or throw (the throw is its `cause`); `ClaimRefused`, a payload that does not decode through the role's contexts, or a claim PostgreSQL refused |
| `schema`                    | `CompileError`; `WorkloadUngenerated`, a workload out of step with the snapshot                                                        |
| `capability`                | `MissingCapability`, a workload program needing an extension the database lacks                                                        |
| a check's stage             | `AdmissionRefused`, with every mismatch, at the first stage one is at                                                                  |
| `admission`                 | `AdmissionTransient` (`SerializationFailure` or `Deadlock`, the server's report its `error`), retryable; `AdmissionFailed`, no verdict |

**`ReadFailure`**, by stage: the server's `ServerError` (`execute`, or `resource` for 53200 and 54001); a connection's
or the pool's refusal, as `OpenError` names them, or `HandleReleased`, a `db.compile` handle used after its `Scope`
ended (`acquire`); `ConnectionLost` or `CommitLost` (`transport`); `DriverFailure` (`driver`); `UnreadableAnswer`, rows
grizzle cannot read or rows its compiled proof says the query cannot deliver (`decode`); and before any SQL,
`CompileError` (`compile`), `MissingCapability` (`capability`), `EncodingFailure` or `LawRejected` (`encode`),
`InputTooLarge` (`resource`) and `PageRequestRefused` (`request`).

**`InputTooLarge`**'s `bound` is the transport bound a call's parameters are past, found before its flight is sent:
`message`, one statement's Bind message longer than PostgreSQL reads (1,073,741,822 bytes, `PQ_LARGE_MESSAGE_LIMIT`),
with the statement and its length; or `literal`, one column's array longer than one JavaScript string holds
(536,870,888 UTF-16 code units), with the input and its column. Split the input across calls.

**`TransportFailure`**: a connection's or the pool's refusal, `HandleReleased`, `ConnectionLost` or `DriverFailure`.
**`ExecutionFailure`**: the server's `ServerError`, `CompileError`, `MissingCapability`, `InputTooLarge`, or
`UnreadableAnswer`.

**`CompileError`**'s reason holds where it refused, `at`, and its details: `MalformedDescription`, your schema or
program breaking the rule `what`; `MalformedArtifact`, what grizzle reads back (the snapshot, a migration folder or
its meta.json, the ledger's rows, a cursor) malformed at the path `at`; `UnsupportedOperation` and
`UnsupportedLawFamily`, a `capability` grizzle doesn't have, such as a parameter's value of a pattern no stored field
declares, which names the parameter and the pattern ([Limits](#limits)); `ResourceBound`, its `bound`; `OutsideRole`, the `role`
and the `access` it doesn't hold; `DuplicateIdentity`, the `earlier` declaration; `IdentifierCollision`, the `other`
declaration and the `identifier` both convert to; `LawOnDerived`, its `relation`; `UnrepresentableKey`, the key and
its `fault`; `RecursionRefused` and `DerivedRefused`, their `cause`; `RoleRefused`, `LoginRefused` and
`ContextRefused`, the `rule` broken; `RoleNameTooLong`, the PostgreSQL `role` and its `limit`; `GeneratedRefused`, the
generated `field` of a `relation` and the `rule` it breaks; `FoldOverProjection`, the match's `source` and the `key` it
must bind for an aggregate to read each row once; `QueriedOwnerAppend`, an insert or a put (`op`) of the `owner` from
a query beside an append of `member` to its `family` (`{ owner, count }`), the write being `at`; `CascadedCopyAppend`,
a write (`op`) of `member` of its `family` whose `copy` reads its `owner`'s `through`, which the owner copies from
`changed`, a relation the same stratum puts from a query, whose rows grizzle never sees; `StaleDerivedRead`, a write
(`op`) of `member` that changes a stored row's column (`changed`: its `relation`, `column`, and `by`: `put`, `owner` or
`member`), which the cascade carries into `copies`, read by `reader` (`{ kind, family, relation, column }`, a fold, a
predecessor, a last or a tree's copy), which grizzle cannot refill for `cause`: `{ kind: "query" }`, a put from a
query; `{ kind: "cycle", refills }`, refills that reach a family they refill again; or `{ kind: "immutable", relation }`,
a refill of an immutable owner's family or an immutable relation's rows; `UnfillableField`, the `relation`'s
`field`, the `law` that fills it, the `source` column it reads along `axis` of its `family`, and why that column is
filled `later`; `UnwritableRelation`, the `relation` no write fills and its `cause`; `UnorderableStratum`, the
`cycle` of a stratum's writes (`{ relation, op }`, an insert, a put or a delete, or a family's insert, update or
delete of its members' rows or count of its owners) that immediate keys order each before the next and the last
before the first, so no order of the stratum's statements keeps them all; `UnstatedKey`, a put
or a delete (`op`) of a `relation` whose `key` (`{ kind, fields }`, its primary key or a declared one a put compares)
holds fields grizzle writes (`unstated`); `UndeclaredDrop`, the name a migration would drop, which no `--drop` or
`--rename` declares; and the remaining rules, a `capability` sentence.

**`EncodingFailure`**'s reason is its codec's fault word, never the value, and its `place` the `Slot` the value fills,
by `name`, or a whole `Fact`. **`CursorError`**'s reason is its cursor fault word.

</details>

## Transactions and concurrency

- **Every transaction is SERIALIZABLE.** The first migration makes it the database's default, so every session gets
  it, psql included, and a write below it on a grizzle table is refused with 25000.
- **One call, one transaction, one round trip.** A call sends BEGIN, its statements and COMMIT in one pipelined flight.
  A write whose plan reads before it writes, a family edit of a group already stored or a refill of a value a change
  leaves stale, sends two flights in its one transaction: one batched read per family of the stored values the edit
  continues, and one per way a change reaches a refilled family's groups, then the writes filled from them, with
  COMMIT. There are no interactive transactions: a read that decides a write is a query inside the ChangeSet, and
  reads that must agree are one query with nested results.
- **No retries.** A refusal from outside the call's inputs fails the call with `TransientFailure` and changes
  nothing; a migration's is `StaleSnapshot` instead. A serialization failure can happen to any transaction, even with
  no other transaction in sight, because PostgreSQL's SSI summarizes old committed transactions under load and then
  judges conservatively, so treat it as retryable everywhere.
- **No server-side timeouts.** grizzle sets no `statement_timeout` or `lock_timeout`. Interrupting the Effect is the
  only cancellation: a call interrupted while its statements run sends one CancelRequest, within the connection's
  `connectTimeoutMs`, so the server stops the statement, and then destroys its session's connection, which is never
  used again. Treat an interrupted write like `CommitUnknown`: statements that had all finished may have committed.
- **Predicate locks are the operator's to size.** Set `max_pred_locks_per_transaction = 2048`. Without room,
  PostgreSQL fails transactions with 53200, which is not retryable. Keep every transaction on the cluster short: a
  committed write's predicate locks are kept until every older transaction ends.

## Deploying

Build each `DbLayer` once per process. Building it parses the snapshot, compiles the login's roles and every workload
program for every role it runs on, the compilation `grizzle generate` ran, and checks that the workloads' index needs
are the ones the snapshot records. It
fails with an `OpenError` at stage `schema` for a snapshot that does not parse or was edited by hand, a schema that is
not the snapshot's, a role or program that does not compile, and a workload program added, renamed, removed or changed
since `grizzle generate`: the error names the program and says to run `grizzle generate`.

Open a `Db` per request or handler. `Db.open` checks the database in one round trip of a few catalog reads before it
yields:

- the server is PostgreSQL 19, and the database UTF8 with the builtin `C.UTF-8` locale;
- the extensions the schema needs are installed;
- no migration is running or stopped part-way, and the latest complete one reached the snapshot's fingerprint;
- the login's and the role's settings and privileges are exactly what the snapshot installs. Every login's own
  defaults pin its sessions, each a setting a grizzle guarantee rests on: `search_path = pg_catalog, pg_temp`,
  `extra_float_digits = 1`, `DateStyle = 'ISO, YMD'`, and `lc_monetary`, `lc_numeric` and `lc_time` at `C.UTF-8`.
  A role's own default
  outranks the database's and the server's, so neither reaches a `Db`'s sessions, and a login with one of them
  missing, changed, or set for it in this database alone is refused. Every session of the login's pool also sends
  them as its startup options, so the environment's `PGOPTIONS` never reaches it, and `DbLayer.make` refuses a process
  environment that sets `PGREPLICATION` with an `OpenError` at stage `config`. A login whose roles search vectors
  also stores `hnsw.iterative_scan = strict_order`. Every other setting is the database owner's, set on the database
  or the server, JIT among them: on a server built with LLVM, `jit_above_cost` can make a large statement compile its
  plan to machine code first;
- the login is LOGIN NOINHERIT and the role NOLOGIN, neither with SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or
  BYPASSRLS, and a role's members are its login and the migration role (any other membership of the login confers
  nothing, and a membership fault refuses every role of the login);
- row-level security is enabled, not forced, on every table the role writes through a query entry that leaves rows
  out;
- the database's default isolation is SERIALIZABLE.

It does not compare view definitions, policies or the owner's default privileges: `grizzle migrate` and
`grizzle drift` do. A value that is not a role reached through its login is refused at stage `schema`. Otherwise a
refusal is an `OpenError` at the first stage that fails, in this order: `role` (no provided layer holds its login),
`schema` (the token is not a string), `token` (`verify` refused or threw, or the payload does not decode through the
role's contexts), the connection's `credential`, `tls`, `authentication`, `connect` and `released`, then the
checks' `version`, `locale`, `capability`, `ledger` (a migration running or stopped part-way, or a snapshot the ledger
never reached), `settings` and `privileges`, or `admission` when the check reaches no verdict, and `token` again for a
claim PostgreSQL refuses.

**Migrations are downtime.** Each migration file takes the ledger's exclusive lock, which waits for the transactions
in flight. From the first file until the last commits, and while a stopped run leaves a folder unfinished, every `Db`
call fails at once with `StaleSnapshot` (reason `Migrating`), before any of its statements runs, and every `Db.open`
is refused at stage `ledger`. Once the migration completes, a `Db` opened at the old snapshot fails with
`StaleSnapshot` (reason `Migrated`): deploy the code that carries the new `snapshot.json`, and open new `Db`s with it.

Every transaction a `Db` sends starts with two statements in the same round trip: one takes the ledger's lock without
waiting, so a running migration refuses it at once and the app never waits, and one checks the snapshot and takes on
the role and the claims for that transaction only. A pooled connection never carries one request's role or claims
into the next. An apply with nothing to write still sends BEGIN, those two statements and COMMIT, so a stale `Db`
never answers `no-change`.

**Vercel.** `attachPool: attachDatabasePool` hands each pool to Vercel, as the example does, so it closes idle
connections before an instance suspends. grizzle depends on no platform's package.

**RDS with IAM authentication.** The password is an Effect that signs a token for each connection attempt;
`@aws-sdk/rds-signer` signs locally, without a network call. Grant the login `rds_iam` with
`GRANT rds_iam TO <login role> WITH INHERIT TRUE, SET FALSE`, the login role being `<schema>__<login>`. `Db.open` and
`grizzle drift` judge what a login can do, not how its memberships are spelled: a membership beyond the login's roles
is admitted when it carries SET FALSE and no ADMIN and the login's privileges on the installation stay exactly its own
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

psql, scripts and other services may write grizzle's tables directly, and they meet the same rules and roles as the
app. Log in as a login, `SET ROLE` to one of its roles, set the claims in the transaction for a role that reads them
(`SELECT set_config('grizzle.claims', '{"Session":{"sub":"user_123"}}', true)`), and write at SERIALIZABLE.
`grizzle names` prints the PostgreSQL name of everything grizzle installs. PostgreSQL answers with these:

| SQLSTATE            | When                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 42501               | a table outside the role; a row its filter refuses; an UPDATE of an immutable table, or through a query entry of a column outside it, in a key or fixed by a claim |
| 42501               | `SET ROLE` to another login's role or the owner; `SET SESSION AUTHORIZATION` to anyone but the login; a call of another role's filter or probe function, or of the advance function of a table the role does not write |
| 22023               | `SET ROLE` or `SET SESSION AUTHORIZATION` to a role that does not exist                                                                                      |
| 428C9               | an UPDATE of a serial column, before any privilege check                                                                                                     |
| 25000               | a write below SERIALIZABLE                                                                                                                                   |
| 23502               | a NULL in a column, such as one an INSERT leaves out that is neither serial nor generated (every column a writer supplies is NOT NULL, a family's hidden ones included); a generated field whose term has no value at the row, a closed read at a key its relation holds no row at |
| 22P02, 22003, 23514 | a `grizzle.claims` setting PostgreSQL cannot read, where a statement reads it (below)                                                                         |
| 23514               | a row check, a family's CHECK or a rule over a closed relation, each named by its rule; a value its contract or pattern refuses, or a code or set its roster's domain refuses, as the statement casts it, before row-level security and the row's constraints |
| 23505               | at the statement: a duplicate key, over a table or over a side of one, an exact repeat included; or a key a concurrent transaction committed after this one's snapshot, which is retryable |
| 23P01               | an overlap under a no-overlap key, at the statement; or a span a concurrent transaction committed after this one's snapshot, which is retryable               |
| 23503               | a foreign key, a containment between sides included: at COMMIT when it is deferred (a family's key as its proof needs: a counted family's predecessor key, every last-slot key, and an owner key a cascade feeds; a family's key a refill writes around: the owner key of every family whose members a refill can rewrite or whose owner a put or a delete can re-place, and the predecessor key of an ordered family or tree and a tree's owner key a refill rewrites; any key that lies on a cycle of the foreign keys that order a write's statements, a family's owner key among them, as a containment from an owner into its members closes one; and any other whose target has a field that is not one of the columns it references), at the statement otherwise |
| 40001, 40P01        | a serialization failure or a deadlock: run the transaction again                                                                                             |

- **The claims setting** is readable exactly when it has the shape a `Db` writes: empty, or a JSON object with no key
  repeated at any depth whose every member is an object of JSON strings. Anything else, text that is no JSON included,
  is 22P02 with constraint `grizzle.claims` and DETAIL `c[]`. A context's member holding other keys than exactly its
  fields is 22P02 with DETAIL `c["<Context>"]`; a member of a context the statement does not read is never judged.
  Each claim is then cast to its field's type, a closed id's claim being its handle's code: one its type refuses (not a
  uuid, not an integer, not a boolean) is 22P02, an integer out of range 22003, and a value its contract, pattern or
  roster refuses 23514. No DETAIL carries a claim's value. A plan that drops the row through a join or condition before it reads the claims
  gives that judgment's own answer: 42501 for a write, no rows for a read, false from a function.
- **COMMIT** of a transaction a refusal aborted rolls it back, without an error.
- **A family's values** are a direct writer's to fill, as grizzle fills them: each member's hidden index, its copy of
  its owner's count and each fold's running values, and the owner's count and ends, by the names `grizzle names`
  prints. PostgreSQL refuses every value that breaks the family, with 23505, 23514 or 23503.
- **Spellings** are not values. A direct writer may store `-0` in a float or vector field. grizzle reads it as its
  value, `0`, and no query result depends on which spelling is stored.
  A key holds one fact per value: `[-0,1]` and `[0,1]` stored in a vector key field collide on it (23505).
- **Serial columns** draw their identity default with no sequence privilege. A writer that inserts explicit serial
  values (`OVERRIDING SYSTEM VALUE`) calls the field's advance function,
  `SELECT <schema>.<advance function>(<largest value inserted>)`, in the same transaction, as grizzle does, so a later
  generated value never repeats a stored one.
- **A login without `SET ROLE`** holds only USAGE on its schema, SELECT on the ledger, and EXECUTE on the snapshot
  guard, the lock and the check that `Db.open` and every `Db` transaction take.
- **The owner and superusers bypass** every rule and role, and the owner is reserved for migrations.

## Security model

- **The login is the boundary.** Whoever holds a login's password can open any of its roles with any claims: a claim
  is what `verify` returned, and PostgreSQL cannot check a token's signature. The web login can be any user of the web
  app, but it never reaches `PostViews`, which only another login's role writes. Give each trust domain its own login.
- **Claims are verified once, then decoded.** `verify` decides the token. grizzle decodes the value it returns, never
  the token's JSON text (so a key the token repeats is `verify`'s to refuse), through the contexts' fields, and
  refuses a present claim object missing a field or holding a value its field's encoder refuses (a text holding NUL or
  a lone surrogate among them) at stage `token`, before the database is checked. A claim's pattern or contract is
  PostgreSQL's to judge: `Db.open`'s round trip asks, and a claim it refuses is refused at stage `token` once the
  checks pass. The transaction's setting holds the decoded claims, one member per context that has a row,
  `{"<Context>":{"<field>":"<text>"}}`, each holding exactly its context's fields as JSON strings. It never holds the
  token, and it ends with the transaction.
- **PostgreSQL enforces every role.** A role holds no privilege on a table it does not write. It reads through views
  in its own schema. A table some role writes through a query entry that leaves rows out is under row-level security,
  with a policy for each role that writes it: the entry's filter, or true for a role that writes every row. A table
  every writer writes whole has no row-level security and no policy, since each policy would be true: the grants
  alone decide its writes. A query entry's view is a security-barrier view; a whole-table entry hides nothing, so its
  view is plain, and PostgreSQL plans through it onto the table's indexes. Constraint messages omit row and key detail
  there.
- **What a role can learn.** Rules hold across the whole database. A delete refused by a comment you cannot see, or a
  limit that counts rows outside your view, tells you such rows exist; a collision at a key tells you a row exists at
  the key you submitted (one overlapping the span you submitted, for a no-overlap key), never any of its other
  columns.
- **Not offered.** A write-only role (an insert reads its rows back), a browser connecting straight to PostgreSQL
  (which cannot verify an RS256 token), and a role in two logins.
- **The owner bypasses every role.** The migration role owns the tables and bypasses row-level security. It is for
  migrations, never for the app.

<details>
<summary>Exactly what a role holds</summary>

- USAGE on the schema, on its own schema, on the vector extension's schema when a column it reads or writes is a
  vector, and on exactly the domains its columns use: its rosters' and sets', and its contracts' and patterns', down
  each contract's base.
- SELECT on its views, and on no materialized view.
- On a table it writes through a whole-table entry: SELECT, INSERT and DELETE, and UPDATE when the table is mutable.
- On a table it writes through a query entry: column SELECT and INSERT on every column, column UPDATE (when the table
  is mutable) on each of the entry's columns outside every key that no claim fixes directly, and DELETE; never
  table-level SELECT, INSERT or UPDATE.
- On the owner of a family whose member it writes: column SELECT on what grizzle reads of the owner to fill the
  family (its key, its count and ends, and the fields its members copy), and, when the owner is mutable, column UPDATE
  on that family's count and ends; nothing else of the owner unless its `write` lists the owner.
- EXECUTE on one key probe (a function that looks a key up across the whole table) per key of such a table, and one
  unique probe per key over a selected side or a `pred` term whose collisions no other probe finds, for each writable
  query entry; on the entry's filter function exactly when its filter reads a table besides the written row; on the
  advance function of each serial column of a table it writes; on the refusal function when it writes or reads a
  context, which only raises, in the caller's own statement; and on every constant a statement it runs evaluates,
  since PostgreSQL checks EXECUTE as the invoker: each constant reached through constants' bodies and through the
  CHECKs of every domain a value is written or cast into (a roster's names constant, a set's live constant), from the
  domains of its columns, from every CHECK, generated field, default and index of a table it writes, a cast into a
  domain inside them included, and from its policies and its views; and the closed constants its queries read.
- MAINTAIN on the materialized view of each derived table its `refresh` names.
- Nothing else: no TRUNCATE, no sequence, and no other role's view or function.

</details>

## Limits

grizzle fits applications that own their data end to end, such as accounts, ledgers, billing, scheduling and
workflows, whose rules are worth declaring and whose users see different slices of it.

- **PostgreSQL 19 only**, tested on 19rc1 with the two patches below; **Node 26 or later**; **Effect 4.1**.
- **grizzle owns the database.** Existing schemas, and tables created outside its migrations, are not supported.
- **No nullable columns, outer joins, window functions, SKIP LOCKED or raw SQL at run time.** A query is written in
  grizzle's query language or not at all.
- **No timestamp type.** An instant is a bigint contract. A `date` holds 0001-01-01 to 9999-12-31, and a lexical
  form has no timezone: a timezoned `xs:date` has no typed value.
- **A span is over `integer`, `bigint` or `date`, or a contract over one**: PostgreSQL's int4range, int8range or
  daterange; a `smallint` has none, since PostgreSQL has no range over it. A date span's ends are `CalendarDate`s, so
  it starts at 0001-01-01 at the earliest and ends at 9999-12-31 at the latest, which it excludes, as an integer span
  ends at its type's greatest value; its width is its count of days, a `number`.
- **A parse reads the forms of integers, numeric(p, s), double precision, booleans and dates.** A numeric's form
  holds at most 255 digits either side of its point, PostgreSQL's limit on a counted repetition; a double's, 15
  significant digits either side and an exponent of at most 293, inside which float8in neither overflows nor
  underflows. An `xs:duration` has no typed value: its value is a count of months and of seconds, which PostgreSQL's
  interval, ordering 1 month as 30 days, is not.
- **Every numeric field declares its precision and scale**, `pg.numeric(p, s)`: PostgreSQL's numeric(p, s), its
  precision at most 1,000 and its scale within ±1,000, which holds NaN and no infinity. A computed numeric, a sum, a
  mean, an operation's result or a derived relation's field, carries the integer and fraction digits its computation
  proves; one past 131,072 integer digits, PostgreSQL's numeric limit, is refused at compile time with
  `ResourceBound`. `Compute.numeric(x)` is PostgreSQL's `x::numeric` of an integer, money or a float, a float's to
  its 6 or 15 significant digits as PostgreSQL writes it.
- **A vector's norm lies in the cosine domain**, between 2^-68 and 2^63: within it pgvector's `cosine_distance`,
  which sums in single precision, is a number in [0, 2] for every pair of vectors of up to 16,000 dimensions, never
  NaN. A vector outside it is refused when it is encoded, and its column's CHECK refuses it from any writer.
- **A `str.regex` pattern has no lookahead or lookbehind and no `\p{…}` class**, nor any other construct
  [Tables and types](#tables-and-types) lists, and some text must match it.
- **A `str.regex` pattern is bounded by the automaton PostgreSQL compiles from it**, not by its length or nesting.
  PostgreSQL refuses a regular expression whose automaton outgrows its compile space (`REG_MAX_COMPILE_SPACE`) as
  "regular expression is too complex", and compilation refuses with `ResourceBound` a pattern past grizzle's measures
  of that space: 4,096 positions once counted repetitions are written out, 65,536 pairs of positions joined by empty
  paths, 8 anchors, and 8,192 for anchors times positions. The measures sit inside PostgreSQL's limit, so a pattern
  past one may still compile there. A counted repetition's bound is at most 255, PostgreSQL's limit. Every pattern a
  `Compute.matches` term can take is bounded the same way, each value of a closed relation's dictionary included.
- **A parameter's value is checked against its contract and pattern at bind**, before any SQL: one outside them is
  refused with `EncodingFailure` (`refinedValue`). Its refinement travels with it, so a query delivers a parameter's
  value, or a relation parameter's field, of any pattern as it was bound, whether or not a stored field declares the
  pattern. A value the query computes, which no bind checks, is delivered through its pattern's domain where it cannot
  be proved inside the pattern, and the installation holds a domain only for a pattern something it installs declares
  (a stored field, a closed relation's field, a derived table's column, a role's view column or a context field): a
  computed value of any other pattern is refused with `UnsupportedOperation` when the query is compiled, naming the
  pattern.
- **PostgreSQL keeps the last 32 regular expressions a backend compiled** (`MAX_CACHED_RES`). A match over a
  dictionary of more patterns, over rows that cycle through them, compiles a pattern per row. Measured on 19rc1 (an
  Apple M-series laptop under load), 200,000 rows matched over dictionaries of 1 to 178 value-domain patterns, median
  of three runs: rows grouped by pattern, or cycling through 32 patterns or fewer, cost 1.4 to 4.9 µs a row; rows
  cycling through 33, 64 or 178 cost 80 to 102 µs a row. The CASE that reads each source's translation adds about
  1 µs a row at 178 patterns. A family write orders each of its statements' rows by the values its matches read their
  patterns from, so each pattern is compiled once per statement; order any other bulk read or write by pattern where it
  can be.
- **Every key fits its index entry for every value its fields admit.** A primary key, a declared key, a key over a
  selection, the UNIQUE a containment references where its target's columns are no declared key, a family's own
  UNIQUEs, and the UNIQUE each family axis references, which holds
  the copies the axis carries, a fold's running values among them, are bounded alike: at most 32 columns
  (`INDEX_MAX_KEYS`), and a B-tree entry of at most 2,704 bytes (`BTMaxItemSize`) counted from each column's type, so a
  text column needs a bounded pattern, or a contract bounding its `charLength` or `octetLength`. A key past either is
  refused with `UnrepresentableKey` when the schema is compiled, naming the bytes each column is counted at, where
  PostgreSQL would refuse the first write that outgrew it (54000). A `Monoid.concat` fold's accumulators ride its family's axes, so they are text of a
  bounded pattern, such as `str.regex("^.{0,64}$", "su")`. A set an axis carries, an `or` or `twos` fold's, is its
  roster's `bit(n)`, `n` every code the roster has minted, removed handles' included, rounded up to whole hex digits, so it is sized by the
  installation's codes when `generate`, `check` or `migrate` compiles it: a roster grown and pruned past about 21,000
  codes refuses the UNIQUE there.
- **A containment's reverse index never refuses free text.** When a target row goes, PostgreSQL's foreign key looks
  up the source rows that reference it, binding every referencing column by equality. grizzle indexes that lookup with
  a B-tree over the longest leading run of the referencing columns of a bounded type, in their order, whose entry
  fits, and PostgreSQL rechecks the rest on the rows it finds; where no such run exists, as when every referencing
  column is free text or the first bounded one alone outgrows an entry, with a hash index on one referencing column, a
  field before a hidden one, whose entry is a 4-byte hash code. A PERIOD reference's GiST index holds the longest
  leading run of its bounded scalars that fits a GiST page, then its span. So free text among the referencing columns
  never refuses a containment; only the UNIQUE it references must be bounded. A containment whose referencing columns
  leave no run that fits, each of a type no hash index takes (money, a set's `bit(n)`, a vector), is refused with
  `UnrepresentableKey` when the schema is compiled.
- **A concatenation is at most 1 GB.** `Compute.concat` builds its result, and PostgreSQL refuses one past
  `MaxAllocSize` ("invalid memory alloc request size"), so a write whose check or generated field concatenates more
  fails with that error. No query concatenates, and a fold's or an equation's concatenation is never built.
- **A translation reads at most 268,435,454 bytes.** PostgreSQL's `translate` allocates four bytes for each byte of its
  operand, past `MaxAllocSize` "requested length too large" (54000), so a write whose check or generated field
  translates a longer text fails with that error, and a query translates only a text whose pattern bounds it within.
- **A regex reads at most 268,435,454 bytes.** PostgreSQL's regex engine widens its subject to a four-byte character
  for each byte before `~` or `regexp_replace` reads it, past `MaxAllocSize` "invalid memory alloc request size", so a
  write whose check, selection or generated field matches or collapses a longer text fails with that error, a
  `str.regex` field's domain CHECK among them, and a query matches or collapses only a text whose pattern bounds it
  within.
- **Tables are immutable by default.** `mutable(T)` opts one in to in-place updates.
- **A relation is a member of at most one ordered family or tree**, which orders it, and of any number of counted
  families ([Families](#families)). A tree is written whole, by inserting its root with the whole tree nested. A put or
  a delete of a family's member that owns an ordered family or a tree is refused: a member's edit does not reach the
  rows nested under it, which only an insert of its owner writes.
- **An insert or a put of an owner from a query cannot share its ChangeSet with an append to the owner's family.** An
  owner the ChangeSet inserts and appends members to holds its final count and ends in its own row, since PostgreSQL
  checks a row's CHECKs as it inserts the row, and grizzle draws them on the host from the facts the ChangeSet states;
  a query's facts are the statement's alone. So an insert or a put of an owner of a counted family from a query, in a
  ChangeSet that inserts or puts that family's members, is refused with `QueriedOwnerAppend` when the ChangeSet is
  compiled: state the owner's facts from an array or a `Stream`, or write the owner in a ChangeSet that
  `ChangeSet.sequence` runs before the one that appends. A write whose every fact carries a stored owner's key inserts
  no owner, and compiles.
- **A put or a delete names its rows by their primary key**, so a relation whose primary key holds a field grizzle
  writes, such as a sequence's member keyed by its owner and its drawn index, is put and deleted by no ChangeSet: its
  facts cannot state the key. A put also compares its facts at every declared key before it is sent, so a declared key
  holding such a field refuses the put too, though not a delete, which compares none. Such a write is a type error, and
  from JavaScript refused with `UnstatedKey` when the ChangeSet is compiled, naming the key: key the member by fields its
  caller writes, such as an id, to put or delete it, declare no key over a field grizzle writes, and insert a sequence
  nested under its owner.
- **A closed relation is as large as its key's code space.** Its constant holds one cell per combination of its key
  fields' codes, so a sparse relation over a large product of rosters is costly in proportion to the product: choose
  coordinates that make it dense, such as slots, whose space is each owner's counts rather than the product
  ([Closed relations](#closed-relations)). A constant holds at most 2,147,483,640 bits, PostgreSQL's longest bit
  string, and a longer one is refused with `ResourceBound` when the schema is compiled, as is one whose payload fields'
  codes multiply past 2,147,483,647, the most a cell read as an integer holds.
- **A closed relation's constant is one hex literal in its migration,** a digit per four bits of its key's code space
  times its cell's bits, whatever its rows, so a sparse relation over a large product of rosters drafts a long file:
  choose dense coordinates. A literal of more than 536,870,888 digits, V8's longest string, is refused with
  `ResourceBound` (`stringLength`) when the schema is compiled. `grizzle check` decodes every literal and refuses one
  its comment or its function's name does not digest, naming the first cell where it parts from the declared rows and
  that cell's key.
- **No interactive transactions, and no retries.** A transaction is one call; you retry `TransientFailure` yourself.
- **One statement's parameters are at most 1,073,741,822 bytes**, PostgreSQL's longest message
  (`PQ_LARGE_MESSAGE_LIMIT`), and one input column's array literal at most 536,870,888 UTF-16 code units, V8's
  longest string. A relation input of any number of rows travels as one array per column, sent again to each statement
  that reads it; a call past either bound is `InputTooLarge` before anything is sent.
- **One generated text is at most 536,870,888 characters**, V8's longest string (2^29 − 24 UTF-16 code units, about
  512 MiB of ASCII): each SQL statement, migration file, `snapshot.json` and fingerprint text grizzle builds.
  `generate` and `check` refuse a schema whose texts would exceed it with `ResourceBound`.
- **PostgreSQL's own limits, refused with `ResourceBound` where grizzle emits what they bound.** A table holds at most
  1,600 columns: a relation's fields with the generated columns its rules add, refused when its schema is compiled,
  and a view's, a derived table's or a write's temporary table's alike. Columns a table once held and dropped count
  too, so PostgreSQL itself refuses an added column past them. A select list holds at most 1,664 entries. One statement
  is at most 1,073,741,822 bytes, PostgreSQL's longest protocol message, and binds at most 65,535 parameters, which a
  Bind message counts in 16 bits. A row must also fit one 8 KB heap page once its long values are stored out of line,
  which PostgreSQL checks when it writes the row.
- **A page size has no upper bound**: it is any safe integer of at least 1. A cursor is at most 268,435,455
  characters, the bound of its own layout, whose lengths and counts are varints of at most four bytes; a page one of
  whose cursors would be longer fails with `CursorError` `cursorTupleOversized`, and a longer cursor sent back is
  `cursorOversized`.
- **No PgBouncer, and no LISTEN/NOTIFY.**
- **No browser connections.** A browser cannot connect straight to PostgreSQL; a server runs `verify`.
- **The login is the trust boundary.** Anyone with its password can act as any of its roles, with any claims.
- **Derived tables are refreshed explicitly**, with `db.refresh`.
- **Migrations are downtime.** No `Db` call runs while a migration is being applied.
- **RDS IAM authentication** has not been run against RDS.

## PostgreSQL known issues

**Recursive queries on an unpatched 19rc1.** Upstream commit 8f29467c removed the hash_mem clamp on an executor hash
table's initial size. On an unpatched 19rc1 server, a recursive query (`query(S).recursive(...)`) whose result the
planner estimates to be large can stall at executor start while it zeroes a hash table of many gigabytes, plain EXPLAIN
and `db.explain` included, and neither `statement_timeout` nor cancellation interrupts it. PostgreSQL restored the
clamp for 19rc2 ([BUG #19759](https://postgr.es/m/19759-acd3f33402e54f36@postgresql.org), commit 747dbf30d1), and the
repository's build applies that fix to 19rc1 as
[scripts/pg/patches/19rc1-recursive-union-hash-mem.patch](scripts/pg/patches/19rc1-recursive-union-hash-mem.patch).
Only recursive queries are affected. The patch goes with the repin to 19rc2.

**Imprecise GiST indexes over multibyte text.** Through PostgreSQL 19, btree_gist prices a text key by the byte after
the common prefix of a subtree's bounds, and ends that prefix at a character boundary under UTF8. Characters that
share leading bytes, such as the CJK Unified Ideographs, then cost the same in every subtree, and a GiST index led by
such a text column is imprecise: a point lookup takes 14 buffers for one row of 20,000 two-ideograph keys, where ASCII
keys take 3. This affects only GiST indexes led by such a text field, which grizzle builds for a no-overlap key or a
span filter whose text field comes first. Such an index stays valid; only its lookups cost more. PostgreSQL's master
branch fixed this in commit b82d69abf6, for PostgreSQL 20, where the lookup takes 3 buffers, and an index built before
the fix places its keys well once rebuilt on a server that has it.

**CHECKs and generated columns re-planned per statement.** Stock 19rc1 parses and plans every CHECK and every stored
generation expression afresh in each statement that needs them, and planning calls each IMMUTABLE function they read
and copies its result in. A closed relation is installed as such a function (see [Closed relations](#closed-relations)),
so every table CHECK and generated field that reads one pays for its constant on every statement: on one-row INSERTs
against a bare table, +13 µs for a CHECK over a 33 KB constant, +20 µs over 128 KiB, and +22 µs for a generated column
over 128 KiB. The repository's build plans them once per relcache entry, as PostgreSQL already does for index
expressions and domain checks,
[scripts/pg/patches/19rc1-relcache-planned-check-and-generation.patch](scripts/pg/patches/19rc1-relcache-planned-check-and-generation.patch),
and each then costs 0.4 to 1.2 µs, the same for a 363-bit constant as for 128 KiB. A roster's domain is unaffected: a
domain's check is planned once per backend already. Behaviour is the same either way; only the cost differs. The patch
is grizzle's own, in no PostgreSQL release, so every repin carries it.

## Status

Beta. There are no stability guarantees: every release is a hard cutover, with no deprecations and no compatibility
path for the API, snapshots or migration files. The test suite runs on macOS against the pinned PostgreSQL 19rc1
build, patched as above.

## Development

Everything runs natively on macOS through Homebrew, with no Docker. Development has no build step: Node runs each
package's `src/*.ts` directly, and the repository resolves the packages' names to their `src/` through the
`grizzle-source` export condition. `pnpm build` emits each package's published `dist/`, and `npm publish` runs it
first.

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

Every generated suite draws from one seed, `TEST_SEED`, which a run prints first; setting it reproduces a run, and
whether a suite reaches what it requires never depends on it.
[CONTRIBUTING.md](CONTRIBUTING.md) has the code rules, how the tests use the testing library, and the oracles.

## Repository

- `packages/engine/`: `@bjornpagen/grizzle-engine`, the compiler: schemas, roles, rules, queries and ChangeSets to SQL,
  the migration drafter and the snapshot.
- `packages/grizzle/`: `@bjornpagen/grizzle`, which re-exports the engine's API and adds:
    - `src/adapter/`: the runtime over node-postgres in pipeline mode: `Db.open`, reads, writes, pages, `migrate` and
      `drift`.
    - `src/cli/`: the `grizzle` command line.
    - `skills/grizzle/`: the agent guide the package ships.
- `test/`: the unit, pg, schedules and types tiers, and their support in `test/support/`.
- `bench/`: performance gates.
- `scripts/pg/`: the pinned PostgreSQL build, cluster, doctor and patches.
- `scripts/dev/`: the mutation tester and the profiler.
- `packages/devtools/`: the lint tooling: the oxlint preset and plugin, superlint and the tsconfig base.
- `packages/testing/`: `@grizzle/testing`, the choice-stream testing library every test runs on, and `pnpm fuzz`'s
  script.

## License

[0BSD](LICENSE).
