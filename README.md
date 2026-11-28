# grizzle

grizzle is a TypeScript library for building applications on PostgreSQL 19. You declare your tables, the rules your
data must keep, who may read and change what, and every query and write your app runs. `grizzle generate` compiles all
of it into plain SQL migrations you review and commit: tables, keys, references, checks, roles, grants, views and
row-level security policies, and the indexes your queries need. It also writes, for each login, a file of compiled
programs that your app serves. Queries return exactly typed rows, writes return outcomes you match on, and the rules
hold for every writer, because PostgreSQL enforces them.

- **Rules live in the database.** Keys, references, no-overlap constraints, running totals and checks become
  constraints, so a script, a second service and your app all meet the same rules.
- **Programs are compiled ahead of time.** Every query and write is checked against the schema when you run
  `grizzle generate` and gets the index it needs. You never write `CREATE INDEX`.
- **No surprises in the types.** A field's type is the set of values it may hold, a query's rows are typed from what it
  finds, and a mistake the schema can see is a type error in your editor.

## Requirements

- PostgreSQL 19, with `pg_plan_advice` loaded in every session: a superuser runs
  `ALTER DATABASE <database> SET session_preload_libraries = 'pg_plan_advice'` once, or sets
  `shared_preload_libraries = 'pg_plan_advice'` on the server. grizzle carries each statement's plan to PostgreSQL, and
  `grizzle migrate` refuses a database that does not load it.
- A server built with PostgreSQL's default page size, `block_size` 8192, from which grizzle derives the bound of every
  key and row it admits; `grizzle migrate` refuses any other.
- A migration role that owns the database and may create roles: the first migration creates one PostgreSQL role per
  login and per role.
- TLS to the server, verified against your CA and the server's name: the only way grizzle connects.
- Node 26 or later, `effect` 4, and `pg` (node-postgres) 8.

## Install

grizzle is taken as a git submodule, pinned by commit, and added to your pnpm workspace. Node runs its TypeScript
source directly, so there is no build step.

```sh
git submodule add -b main https://github.com/bjornpagen/grizzle.git vendor/grizzle
```

```yaml
# pnpm-workspace.yaml
packages:
  - vendor/grizzle/packages/engine
  - vendor/grizzle/packages/grizzle
  - vendor/grizzle/packages/openapi
  - vendor/grizzle/packages/text
```

Then depend on `"@bjornpagen/grizzle": "workspace:*"`, beside `effect` and `pg`. Schemas and the config import
`@bjornpagen/grizzle`; a running app imports `@bjornpagen/grizzle/runtime`, which loads no compiler.

## Quick start

A blog where each organization's members read their organization's posts and write their own. Everything below is
checked code: this README's examples are compiled by grizzle's own test suite.

### 1. The schema

In `src/schema.ts`:

```ts
import { answered, ChangeSet, closed, closedId, context, login, query, relation, role, schema, str, v, workload } from "@bjornpagen/grizzle"

/** Each field's type is a set of values, and PostgreSQL holds every row to it. */
const UserId = str.regex("^user_[0-9A-Za-z]{1,32}$")
const OrgId = str.regex("^org_[0-9A-Za-z]{1,32}$")
const Slug = str.regex("^[a-z0-9-]{1,64}$")
const Title = str.regex("^.{1,200}$", "su")
const Body = str.regex("^.*$", "su")

export const Status = closed.ordered("Status", ["draft", "published"])

/** A post, keyed by its organization and its slug: no surrogate id. */
export const Post = relation(
	"Post",
	{ org: OrgId, slug: Slug, author: UserId, title: Title, body: Body, status: closedId(Status) },
	["org", "slug"]
)

export const Blog = schema("Blog", [Status, Post], [])
```

`str.regex` types a text by a pattern, which PostgreSQL checks on every write. `closed.ordered` declares a fixed list
of values. `Post` is keyed by `["org", "slug"]`: a post is identified by what it is, so there is no `id` column.

### 2. Who can do what

```ts
/** Who is calling: the verified claims of their session token (Clerk's, here). */
export const Session = context("Session", { sub: UserId })
export const Org = context("Org", { id: OrgId }, { claim: "o" })

/** A member reads their organization's posts... */
const orgPosts = query(Blog).rule((r) => {
	const { org, slug, author, title, body, status } = v(Post, "post")
	return r
		.match(Post, { org, slug, author, title, body, status })
		.match(Org, { id: org })
		.find({ slug, author, title, body, status })
})

/** ...and writes posts as themselves, in their organization. */
const myPosts = query(Blog).rule((r) => {
	const { org, slug, author, title, body, status } = v(Post, "post")
	return r
		.match(Post, { org, slug, author, title, body, status })
		.match(Org, { id: org })
		.match(Session, { sub: author })
		.find({ slug, title, body, status })
})

export const Member = role(
	Blog,
	"member",
	{ Post: orgPosts, MyPost: myPosts },
	{ insert: ["MyPost"], contexts: [Session, Org] }
)
```

A role sees the schema through the entries you give it. `Member` reads `Post` as its organization's posts, and writes
through `MyPost`, whose `org` and `author` come from the caller's token, so a member can't write a post into another
organization or under another user's name.

### 3. The programs your app runs

```ts
const { Post: OrgPost, MyPost } = Member.relations

export const feed = query(Member).rule((r) => {
	const { slug, author, title } = v(OrgPost, "post")
	return r
		.match(OrgPost, { slug, author, title, status: "published" })
		.find({ slug, author, title })
})

/** A new post: the caller's organization and user id fill `org` and `author`. */
export const write = ChangeSet.empty(Member).insert(MyPost, [])

/** The web app's login: the roles it opens and every program it runs. */
export const Web = login(Blog, "web", [Member], {
	workload: [workload(Member, { feed: answered(feed), write })]
})
```

`feed`'s rows are `{ slug, author, title }`, each a `string`, and `status` is `"draft" | "published"` everywhere it is
read or written. `answered` marks a read your app calls once per request; a read without it can also be watched live, which needs
the installation's live source. Writing through `Post`, which `Member` only reads, doesn't compile:

```ts
// @ts-expect-error -- refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
ChangeSet.empty(Member).insert(OrgPost, [])
```

### 4. The config

`grizzle.config.ts`, beside your `package.json`:

```ts
import net from "node:net"
import { CredentialError, defineConfig } from "@bjornpagen/grizzle"
import { Config, Effect } from "effect"
import pgDriver from "pg"
import { caPem } from "./certs.ts"
import { Blog, Web } from "./src/schema.ts"

export default defineConfig({
	schemas: [Blog],
	logins: [Web],
	migrations: "migrations",
	rolePrefixBytes: 0,
	/** Where `grizzle migrate` connects, as the role that owns the schema. */
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

`./certs.ts` exports your database's CA bundle as a string. Only `grizzle migrate` and `grizzle drift` call
`connection`, so `generate` and `check` run in CI with no database in reach.

### 5. Generate, review, migrate

```sh
pnpm exec grizzle generate grizzle.config.ts
pnpm exec grizzle check grizzle.config.ts
pnpm exec grizzle migrate grizzle.config.ts
```

`generate` writes `migrations/blog/19700101000000_init/`, a few numbered SQL files and their `meta.json`, beside
`snapshot.json`, `manifest.json` and `served/web.json`, the web login's compiled programs. Read the SQL, edit it if you
need to, and commit it all. Here is the start of `02-structure.sql`:

```sql
CREATE TABLE "blog"."post" (
  "org" "blog"."__text_e7ayr247kk" NOT NULL,
  "slug" "blog"."__text_t4rwovzmqj" NOT NULL,
  "author" "blog"."__text_zzj77fcksi" NOT NULL,
  "title" "blog"."__text_ucvpb5bhvu" NOT NULL,
  "body" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  "status" "blog"."status" NOT NULL,
  CONSTRAINT "__post_pk_dyy23qj6j2" PRIMARY KEY ("org", "slug")
);
```

Each pattern is a domain, so the database refuses a bad slug however it is written. `check` fails in CI when someone
changes the schema and forgets to generate; `migrate` applies what is pending, then compares the database with
`snapshot.json`.

The first migration creates the web login's PostgreSQL role without a password. Set one as the owner, or grant it
`rds_iam` ([Logins](#logins-connecting-and-rds-iam)).

### 6. A route handler

In `app/posts/route.ts`:

```ts
import net from "node:net"
import { CredentialError } from "@bjornpagen/grizzle"
import { Db, DbLayer, served, TokenRefused } from "@bjornpagen/grizzle/runtime"
import { verifyToken } from "@clerk/backend"
import { Config, Effect, ManagedRuntime } from "effect"
import pgDriver from "pg"
import { caPem, clerkJwtKey } from "../../certs.ts"
import webFile from "../../migrations/blog/served/web.json" with { type: "json" }
import type { Web } from "../../src/schema.ts"

/** The web login's compiled programs, as `grizzle generate` wrote them: the app runs no schema code. */
const WebServed = served<typeof Web>(webFile, "web")

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

/** One pool for the web login, built once per process. */
const web = ManagedRuntime.make(
	DbLayer.make({
		...connection,
		login: WebServed,
		password: Config.Redacted("WEB_DB_PASSWORD").pipe(
			Effect.mapError((cause) => new CredentialError({ cause }))
		),
		pool: { max: 10 },
		verify: (token) =>
			Effect.tryPromise({
				try: () => verifyToken(token, { jwtKey: clerkJwtKey }),
				catch: (cause) => new TokenRefused({ cause })
			})
	})
)

const bearer = (request: Request) =>
	/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]

/** GET /posts: the caller's organization's published posts. */
export const GET = (request: Request) =>
	web.runPromise(
		Effect.gen(function* () {
			const token = bearer(request)
			if (token === undefined) {
				return new Response(null, { status: 401 })
			}
			const db = yield* Db.open(WebServed.roles.member, { token })
			const posts = yield* db.workload.feed.once({ params: {}, facts: {} })
			return Response.json(posts)
		})
	)
```

The app imports the login as a type and its served file as JSON, so no schema code runs in production. `Db.open`
verifies the token and opens a handle for one role; `db.workload` holds the programs the login serves that role.

## Cookbook

Each recipe is a problem, the code, and what you get. Imports are left out: every name comes from
`@bjornpagen/grizzle`, or from `@bjornpagen/grizzle/runtime` in app code. The recipes reuse the quick start's `UserId`,
`OrgId`, `Slug` and `Title`.

### Every organization sees only its own rows

```ts
const ProjectKey = str.regex("^[A-Z]{2,8}$")

export const Task = relation(
	"Task",
	{ org: OrgId, project: ProjectKey, number: natural, title: Title, done: pg.boolean },
	["org", "project", "number"]
)
export const Tracker = schema("Tracker", [Task], [unit("Org", { org: OrgId }), mutable(Task)])

/** The organization the caller's token names. */
const callersOrg = query(Tracker).rule((r) => {
	const { id } = v(Org, "org")
	return r.match(Org, { id }).find({ org: id })
})

export const Teammate = role(Tracker, "teammate", wholeEntriesOf(Tracker), {
	write: ["Task"],
	contexts: [Org],
	scope: [callersOrg]
})

/** A project's open tasks. No organization in sight: the role's scope supplies it. */
export const openTasks = query(Tracker).rule((r) => {
	const { project, number, title } = v(Task, "task")
	return r
		.match(Task, { project, number, title, done: false })
		.where(r.eq(project, r.param("project", ProjectKey)))
		.find({ number, title })
})
```

`unit("Org", { org: OrgId })` says every table keyed by `org` first belongs to an organization. The role's `scope`
binds the caller's organization from their token, so `openTasks` reads only the caller's tasks without naming an
organization, and a write of another organization's rows is refused as `outsideWorld` before anything is stored.
The scope holds what the role's programs mean; the login's password is the boundary, so it stays on your server.

```ts
const TrackerServed = served<typeof TrackerApp>(trackerFile, "tracker")

/** The caller's token names their organization; every read and write is held to it. */
export const projectTasks = (token: string, project: string) =>
	Effect.gen(function* () {
		const db = yield* Db.open(TrackerServed.roles.teammate, { token })
		return yield* db.workload.openTasks.once({ params: { project }, facts: {} })
	})
```

A role that reads the token can't be opened without one:

```ts
export const tokenless =
	// @ts-expect-error -- TS2345: Property 'token' is missing in type '{}' but required in type '{ readonly token: string; }'.
	Db.open(TrackerServed.roles.teammate, {})
```

### Top N per group, with exact types

```ts
const microsKey = Symbol("Micros")
const millisKey = Symbol("Millis")
/** Millionths of a dollar, never negative; milliseconds since the epoch. */
const Micros = contract<typeof microsKey>()("Micros", pg.bigint, (m) => Logic.ge(m, 0n))
const Millis = contract<typeof millisKey>()("Millis", pg.bigint)
const RequestId = str.regex("^req_[0-9A-Za-z]{1,64}$")
const Workspace = str.regex("^ws_[0-9a-z]{1,32}$")
const Model = str.regex("^[a-z0-9.-]{1,64}$")

/** One API call, keyed by the gateway's request id. */
export const Call = relation(
	"Call",
	{ id: RequestId, workspace: Workspace, model: Model, at: Millis, cost: Micros },
	["id"]
)
export const Usage = schema("Usage", [Call], [])

/** Each workspace's spend, with its three costliest models. */
export const topModels = query(Usage)
	.rule((r) => {
		const { id, workspace, cost } = v(Call, "call")
		return r.match(Call, { id, workspace, cost }).find({ workspace, spend: r.sum(cost) })
	})
	.attach(
		"models",
		(w) =>
			query(Usage)
				.rule((r) => {
					const { id, model, cost } = v(Call, "call")
					return r
						.match(Call, { id, workspace: w.workspace, model, cost })
						.find({ model, calls: r.count(), spend: r.sum(cost) })
				})
				.orderBy(["spend", "desc"])
				.take(3),
		"array"
	)
```

Its rows are typed exactly, nested array included, as `HeadOf<typeof topModels>`:

```ts
type TopModelsRow = {
	readonly workspace: string
	readonly spend: Decimal
	readonly models: ReadonlyArray<{
		readonly model: string
		readonly calls: bigint
		readonly spend: Decimal
	}>
}
```

A count is a `bigint` and a sum a `Decimal`, so no total ever loses precision. `contract` makes `Micros` a type of its
own: a plain `2_500_000n` doesn't typecheck where a `Micros` is expected.

A sum over a join can count a row twice, so grizzle refuses an aggregate whose rule doesn't bind the key of what it
matches:

```ts
query(Usage).rule((r) => {
	const { model, cost } = v(Call, "call")
	return (
		r
			.match(Call, { model, cost })
			// @ts-expect-error -- refusal: a sum reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values
			.find({ model, spend: r.sum(cost) })
	)
})
```

Bind `id` in the match, as `topModels` does, and it compiles.

### A tree of any depth

```ts
const FolderId = str.regex("^f_[0-9a-z]{1,24}$")

export const Folder = relation("Folder", { id: FolderId, name: Title }, ["id"])
/** A folder's parent: at most one, so the folders form trees. */
export const Parent = relation("Parent", { child: FolderId, parent: FolderId }, ["child"])
export const File = relation("File", { folder: FolderId, name: Title, bytes: natural }, [
	"folder",
	"name"
])
export const Drive = schema(
	"Drive",
	[Folder, Parent, File],
	[
		contained(on(Parent, "child"), on(Folder, "id")),
		contained(on(Parent, "parent"), on(Folder, "id")),
		contained(on(File, "folder"), on(Folder, "id"))
	]
)

/** A folder and every folder below it, at any depth. */
const subtree = query(Drive).recursive("Subtree", {
	row: { folder: FolderId },
	base: [
		(r) => {
			const { id } = v(Folder, "folder")
			return r
				.match(Folder, { id })
				.where(r.eq(id, r.param("root", FolderId)))
				.find({ folder: id })
		}
	],
	rec: [
		(r, self) => {
			const { folder } = v(self, "self")
			const { child } = v(Parent, "parent")
			return r
				.match(self, { folder })
				.match(Parent, { child, parent: folder })
				.find({ folder: child })
		}
	]
})

/** Bytes per folder under a root. */
export const folderSizes = query(Drive).rule((r) => {
	const tree = subtree.bind({ root: r.param("root", FolderId) })
	const { folder } = v(tree, "tree")
	const { name, bytes } = v(File, "file")
	return r
		.match(tree, { folder })
		.match(File, { folder, name, bytes })
		.find({ folder, bytes: r.sum(bytes) })
})
```

`folderSizes` takes `{ root: string }` and returns `{ folder: string; bytes: Decimal }` rows: one recursive query and
one aggregate, in a single statement.

### No double booking

```ts
const minuteKey = Symbol("Minute")
/** Minutes since the epoch. */
const Minute = contract<typeof minuteKey>()("Minute", pg.bigint)
const RoomName = str.regex("^[A-Za-z0-9 -]{1,64}$")

export const Room = relation("Room", { name: RoomName }, ["name"])
/** When a room is open: a room's openings never overlap. */
export const Opening = relation("Opening", { room: RoomName, hours: span(Minute) }, [
	"room",
	"hours"
])
/** A booking: a room's bookings never overlap, and each is covered by the room's openings. */
export const Booking = relation("Booking", { room: RoomName, during: span(Minute), by: UserId }, [
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

A key over a `span` is a no-overlap key, and a reference from a span must be covered by the spans it references.
grizzle writes both as PostgreSQL 19's temporal constraints:

```sql
  CONSTRAINT "__booking_pk_tzyi2pgieq" PRIMARY KEY ("room", "during" WITHOUT OVERLAPS),
ALTER TABLE "rooms"."booking" ADD CONSTRAINT "__booking_fk_room_during_254p6ghcbd" FOREIGN KEY ("room", PERIOD "during") REFERENCES "rooms"."opening" ("room", PERIOD "hours") MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
```

Two requests booking overlapping minutes can't both commit, and no booking can land outside opening hours.

### A budget no burst can overdraw

```ts
const toMicros = mintOf(microsKey)
const PaymentId = str.regex("^pi_[0-9A-Za-z]{1,64}$")

export const Grant = relation(
	"Grant",
	{
		id: PaymentId,
		amount: Micros,
		debits: drawn(natural),
		spent: accumulated(Micros, toMicros(0n), microsKey)
	},
	["id"]
)
export const Debit = relation("Debit", { call: RequestId, grant: PaymentId, amount: Micros }, [
	"call"
])

const grantDebits = counted(on(Debit, "grant"), fin(Grant, "debits"))

export const Credits = schema(
	"Credits",
	[Grant, Debit],
	[
		grantDebits,
		fold(grantDebits, Monoid.sum, on(Debit, "grant", "amount"), on(Grant, "id", "spent")),
		check("WithinGrant", Grant, (g) => g.le(g.spent, g.amount)),
		unit("Grant", { id: PaymentId }),
		mutable(Grant)
	]
)

export const charge = ChangeSet.empty(Credits).insert(Debit, [])
```

`debits` counts a grant's debits and `spent` sums their amounts. grizzle keeps both: a debit's insert updates its
grant in the same transaction, so two debits of one grant take turns, and the one that would pass `amount` is refused
by `WithinGrant`. The caller never writes `spent`, and no burst of requests can overdraw.

### Books that always balance

```ts
const Account = str.regex("^[a-z][a-z_]{0,63}$")
const EntryId = str.regex("^JE-[0-9]{1,12}$")

export const Entry = relation(
	"Entry",
	{ id: EntryId, memo: Title, postings: drawn(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
export const Posting = relation(
	"Posting",
	{ entry: EntryId, account: Account, amount: pg.bigint },
	["entry", "account"]
)

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

export const record = ChangeSet.empty(Books).insert(Entry, []).insert(Posting, [])
```

An entry's postings always sum to zero. The database keeps each entry's `total`, and the rule is a plain `CHECK`:

```sql
  "total" bigint NOT NULL,
  CONSTRAINT "balanced" CHECK (("total" = 0::bigint) IS TRUE),
```

`record` inserts an entry and its postings in one call; a call whose postings don't balance is refused, naming
`Balanced`, and stores nothing.

### States that carry their own data

```ts
const InvoiceId = str.regex("^in_[0-9A-Za-z]{1,64}$")
const ChargeId = str.regex("^ch_[0-9A-Za-z]{1,64}$")

export const InvoiceStatus = closed.unordered("InvoiceStatus", ["open", "paid", "void"])
/** An invoice is open, paid by a charge, or void for a reason. */
export const InvoiceState = variant("InvoiceState", InvoiceStatus, {
	open: {},
	paid: { charge: ChargeId },
	void: { reason: Title }
})
export const Invoice = relation.generated(
	"Invoice",
	{ id: InvoiceId, org: OrgId, state: InvoiceState },
	["id"],
	(i) => ({ status: generated(closedId(InvoiceStatus), InvoiceState.tag(i.state)) })
)
export const Invoices = schema(
	"Invoices",
	[InvoiceStatus, Invoice],
	[unit("Invoice", { id: InvoiceId }), mutable(Invoice)]
)

export const invoice = query(Invoices).rule((r) => {
	const { id, state } = v(Invoice, "invoice")
	return r
		.match(Invoice, { id, state })
		.where(r.eq(id, r.param("id", InvoiceId)))
		.find({ id, state })
})

/** Pay an open invoice: its state becomes `paid`, carrying the charge. */
export const pay = ChangeSet.empty(Invoices).put(
	Invoice,
	query(Invoices).rule((r) => {
		const { org } = v(Invoice, "invoice")
		return r.match(Invoice, { id: r.param("invoice", InvoiceId), org, status: "open" }).find({
			id: r.param("invoice", InvoiceId),
			org,
			state: InvoiceState.make("paid", { charge: r.param("charge", ChargeId) })
		})
	})
)
```

`invoice`'s `state` is a tagged union, `{ tag: "open" } | { tag: "paid"; charge: string } | { tag: "void"; reason: string }`,
and a paid invoice without a charge can't be stored. `status`, generated from the state, is what you filter and index
by. The states have no order, so ordering by them doesn't compile:

```ts
query(Invoices)
	.rule((r) => {
		const { id, status } = v(Invoice, "invoice")
		return r.match(Invoice, { id, status }).find({ id, status })
	})
	// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
	.orderBy(["status", "asc"])
```

### Natural keys, no minted ids

grizzle never mints an id. A row is keyed by what identifies it: its parent's key and its own name, another system's
id, a digest of its content, or the instant the database stamped it.

```ts
/** A sign-in: the user, and the instant the database stamped it at. */
export const SignIn = relation("SignIn", { user: UserId, at: instant }, ["user", "at"])
/** An API key, keyed by the SHA-256 of its secret: the table never holds the secret. */
export const ApiKey = relation("ApiKey", { org: OrgId, digest: sha256, name: Title }, [
	"org",
	"digest"
])
export const Auth = schema("Auth", [SignIn, ApiKey], [key(on(ApiKey, "digest"))])

export const signIn = ChangeSet.empty(Auth).insert(
	SignIn,
	query(Auth).rule((r) => r.find({ user: r.param("user", UserId) }))
)
```

`at` is an `instant` the database stamps when the row is inserted, increasing for each user in commit order. `digest`
is a `Sha256`, the raw 32 bytes, so the secret itself is never stored, and `key(on(ApiKey, "digest"))` makes it unique
across organizations.

### Closed relations: facts you only add

A relation is closed unless you say otherwise: its rows are inserted, never updated or deleted, and the role that writes
it gets `INSERT` but no `UPDATE` or `DELETE`. Record a change as a new fact and derive the current state. Open a
relation with `mutable`, inside the unit its key leads with.

```ts
const OrderId = str.regex("^ord_[0-9A-Za-z]{1,32}$")

/** An order, and its cancellation: two facts, each inserted once. */
export const Order = relation("Order", { id: OrderId, customer: UserId, total: Micros }, ["id"])
export const Cancelled = relation("Cancelled", { order: OrderId, reason: Title }, ["order"])

/** A cart's lines change until checkout: open, inside the cart's unit. */
export const CartLine = relation("CartLine", { cart: UserId, sku: Slug, quantity: natural }, [
	"cart",
	"sku"
])

export const Shop = schema(
	"Shop",
	[Order, Cancelled, CartLine],
	[
		contained(on(Cancelled, "order"), on(Order, "id")),
		unit("Cart", { cart: UserId }),
		mutable(CartLine)
	]
)

/** Orders still live: the ones with no cancellation. */
export const liveOrders = query(Shop).rule((r) => {
	const { id, customer, total } = v(Order, "order")
	return r
		.match(Order, { id, customer, total })
		.where(r.not(Cancelled, { order: id }))
		.find({ id, customer, total })
})

export const cancel = ChangeSet.empty(Shop).insert(Cancelled, [])
export const setQuantity = ChangeSet.empty(Shop).put(CartLine, [])
```

Deleting an order doesn't compile:

```ts
// @ts-expect-error -- refusal: a delete of a closed relation: its facts are inserted, never changed or deleted; declare it mutable inside a unit, or record the change as an inserted fact
ChangeSet.empty(Shop).delete(Order, [])
```

### A usage page: windows and a rollup

```ts
/** A workspace's calls, newest first. */
export const callLog = query(Usage)
	.rule((r) => {
		const { id, model, at, cost } = v(Call, "call")
		return r
			.match(Call, { id, workspace: r.param("workspace", Workspace), model, at, cost })
			.find({ id, model, at, cost })
	})
	.orderBy(["at", "desc"])

/** Calls and spend per workspace and model: a query you read like a table. */
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

export const spendByModel = query(Reporting).rule((r) => {
	const { model, calls, spend } = v(ModelSpend, "row")
	return r
		.match(ModelSpend, { workspace: r.param("workspace", Workspace), model, calls, spend })
		.find({ model, calls, spend })
})

export const Analyst = role(Reporting, "analyst", wholeEntriesOf(Reporting))
export const UsageApi = login(Reporting, "usage_api", [Analyst], {
	workload: [
		workload(Analyst, {
			callLog: answered(paged(callLog)),
			topModels: answered(topModels),
			spendByModel: answered(spendByModel)
		})
	]
})
```

`paged` serves the log a window at a time. `ModelSpend` is a derived relation: a query you read like a table, always
equal to its definition. The index the log needs comes from the workload; nobody wrote it:

```sql
CREATE INDEX "__call_ix_workspace_at_id_txjpwdbrfr" ON "usage"."call" USING btree ("workspace", "at", "id" DESC);
```

Paging by key, so each page is one index range:

```ts
const UsageServed = served<typeof UsageApi>(usageFile, "usage_api")

/** The first 50 calls, then the 50 after the last one shown. */
export const calls = (workspace: string) =>
	Effect.gen(function* () {
		const db = yield* Db.open(UsageServed.roles.analyst, {})
		const first = yield* db.workload.callLog.once({
			params: { workspace },
			facts: {},
			window: { anchor: { kind: "start" }, size: 50 }
		})
		const last = [...first.entries()].at(-1)
		if (last === undefined) {
			return [...first]
		}
		const next = yield* db.workload.callLog.once({
			params: { workspace },
			facts: {},
			window: { anchor: { kind: "after", key: last.key }, size: 50 }
		})
		return [...first, ...next]
	})
```

### Contracts and schemas that build on each other

`Micros` above is a `contract`: a type of its own over `pg.bigint`, with a check, whose values only the holder of
`microsKey` can make, through `mintOf(microsKey)`. Two systems' ids, or cents and micros, never mix.

`contractParser(Micros, microsKey)`, from `@bjornpagen/grizzle/contract`, is the checked mint: it parses a value from
outside, a request's or a step input's, and refuses one PostgreSQL would refuse to store, `ValueRefused` or
`DomainRefused`. It derives its checker from the contract where it is built, so no generated file holds one. Your
configuration never imports a file `grizzle generate` writes: one that does is refused (`ConfigReadsGenerated`), since
it would stop loading when that file next changed format.

`schema.extend` builds a level over another schema. Each level installs in its own PostgreSQL schema, and a level
references the one below it by plain containment:

```ts
/** A course catalog, maintained on its own... */
export const Course = relation("Course", { slug: Slug, title: Title }, ["slug"])
export const Catalog = schema("Catalog", [Course], [])

/** ...and enrollments over it: each enrollment's course is one the catalog holds. */
export const Enrollment = relation("Enrollment", { student: UserId, course: Slug }, [
	"student",
	"course"
])
export const School = schema.extend(
	[Catalog],
	"School",
	[Enrollment],
	[contained(on(Enrollment, "course"), on(Course, "slug"))]
)

/** A student's courses, with their titles: one query across both levels. */
export const myCourses = query(School).rule((r) => {
	const { course } = v(Enrollment, "enrollment")
	const { title } = v(Course, "c")
	return r
		.match(Enrollment, { student: r.param("student", UserId), course })
		.match(Course, { slug: course, title })
		.find({ course, title })
})
```

`School` and `Catalog` install together, from one migrations directory; a login can serve either level.

### Logins, connecting and RDS IAM

A login is one PostgreSQL role your app connects as, with its own password and its own pool, serving one or more
roles. Split trust by login: whoever holds the web login's password can act as any member, but never as the indexer.

```ts
/** A search indexer reads every post; it writes nothing. */
export const Indexer = login(Blog, "indexer", [role(Blog, "crawler", wholeEntriesOf(Blog))])
```

The password is a `Redacted`, or an Effect that yields one for each new connection, so rotated credentials and RDS IAM
tokens need no restart:

```ts
const IndexerServed = served<typeof Indexer>(indexerFile, "indexer")

/** The indexer signs a fresh RDS IAM token for every connection it opens. */
export const IndexerLayer = DbLayer.make({
	...connection,
	login: IndexerServed,
	pool: { max: 2 },
	password: Effect.tryPromise({
		try: () =>
			new Signer({
				hostname: "db.internal",
				port: 5432,
				region: "us-east-1",
				username: roleNameOf(IndexerServed, connection)
			}).getAuthToken(),
		catch: (cause) => new CredentialError({ cause })
	}).pipe(Effect.map(Redacted.make))
})
```

### Errors and outcomes with Effect

A program's call is an Effect. A write answers `accepted` or `unchanged`; everything that goes wrong is a typed error
with a `kind`, such as `refused` (a rule said no, naming it), `outsideWorld` or `transient`, and a `retry` field that
is `"safe"` exactly when running the call again can help. grizzle never retries on its own.

```ts
/** A post as the client sends it, decoded with Effect Schema. */
const NewPost = Schema.Struct({ slug: Schema.String, title: Schema.String, body: Schema.String })

/** POST /posts: 201 written, 200 already there, 409 refused by a rule, 422 not a post. */
export const POST = (request: Request) =>
	web.runPromise(
		Effect.gen(function* () {
			const token = bearer(request)
			if (token === undefined) {
				return new Response(null, { status: 401 })
			}
			const post = yield* Effect.flatMap(
				Effect.promise(() => request.json()),
				Schema.decodeUnknownEffect(NewPost)
			)
			const db = yield* Db.open(WebServed.roles.member, { token })
			const status = yield* db.workload.write
				.once({ params: {}, facts: { insert: { MyPost: [{ ...post, status: "draft" }] } } })
				.pipe(
					Effect.map((outcome) => (outcome.kind === "accepted" ? 201 : 200)),
					Effect.catchIf(
						(error) => error.kind === "refused",
						() => Effect.succeed(409)
					)
				)
			return new Response(null, { status })
		}).pipe(
			Effect.catchTag("SchemaError", () => Effect.succeed(new Response(null, { status: 422 })))
		)
	)
```

### Migrations and deploys

Change the schema, run `grizzle generate` again, and it drafts the next folder from the committed snapshot, never
from the live database. It guesses no renames and drops nothing you didn't declare:

```sh
pnpm exec grizzle generate grizzle.config.ts --rename Post.body=Post.text
pnpm exec grizzle generate grizzle.config.ts --drop Post.legacy
```

A new required column on a table with rows gets a marked placeholder for you to fill, and `check` refuses the folder
until you do. Run `grizzle migrate` from CI or your deploy: it applies the pending files in order, then checks that the
database matches the snapshot. A migration is downtime for the app: while it runs, calls fail with a `stale` error, so
deploy the new served files right after.

### Testing without a database

`@bjornpagen/grizzle/compile` reads a schema the way the database would, with no SQL sent. `insertPreview` shows what a
write would store, the values grizzle keeps included:

```ts
const preview = Result.getOrThrow(insertPreview(Books))
const stored = Result.getOrThrow(
	preview({
		Entry: [{ id: "JE-1", memo: "Rent" }],
		Posting: [
			{ entry: "JE-1", account: "rent", amount: 1200n },
			{ entry: "JE-1", account: "cash", amount: -1200n }
		]
	})
)
assert.deepEqual(stored.Entry, [{ id: "JE-1", memo: "Rent", postings: 2n, total: 0n }])
```

For everything else, run your tests against a real PostgreSQL 19: `grizzle migrate` into a fresh database, then open
`Db`s exactly as production does.

## Coming from Drizzle

| Drizzle | grizzle |
| --- | --- |
| `pgTable("posts", { ... })` | `relation("Post", { ... }, ["org", "slug"])` |
| `serial()`, `uuid().defaultRandom()` | natural keys, `instant`, `sha256` |
| `.references(() => posts.id)` | `contained(on(Comment, "post"), on(Post, "slug"))` |
| `check("name", sql\`...\`)` | `check("Name", Post, (p) => ...)`, or a typed field |
| `db.select().from(posts).where(...)` | `query(Blog).rule((r) => r.match(Post, ...).where(...).find(...))` |
| `db.transaction(async (tx) => ...)` | a `ChangeSet`: one write, judged whole at commit |
| `pgPolicy(...)` | a `role` with `contexts` and `scope` |
| `drizzle-kit generate`, `migrate` | `grizzle generate`, `grizzle migrate` |

## Learn more

- [CONTRIBUTING.md](CONTRIBUTING.md): how grizzle is built and tested.
- [docs/multi-schema-design.md](docs/multi-schema-design.md): levels and installations in depth.
- [packages/grizzle/skills/grizzle/SKILL.md](packages/grizzle/skills/grizzle/SKILL.md): the agent guide to the
  migration loop, every refusal and its fix.

## License

0BSD
