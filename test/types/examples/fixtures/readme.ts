import net from "node:net"
import { Signer } from "@aws-sdk/rds-signer"
import {
	accumulated,
	alternatives,
	arm,
	ChangeSet,
	CredentialError,
	check,
	closed,
	closedId,
	contained,
	context,
	contract,
	counted,
	Db,
	DbLayer,
	type Decimal,
	defineConfig,
	derived,
	drawn,
	type Fact,
	fin,
	fold,
	type HeadOf,
	type Infer,
	type Page,
	type KeysOf,
	key,
	login,
	Monoid,
	mutable,
	natural,
	on,
	type PageCursor,
	type ParamsOf,
	type ParamType,
	pg,
	pred,
	query,
	relation,
	role,
	roleNameOf,
	schema,
	select,
	span,
	str,
	TokenError,
	uuid,
	type Uuid,
	v,
	wholeEntriesOf,
	workload,
	writableNamesOf
} from "@bjornpagen/grizzle"
import { verifyToken } from "@clerk/backend"
import { attachDatabasePool } from "@vercel/functions/db-connections"
import { Config, Effect, type Layer, ManagedRuntime, type Option, Redacted, Schema } from "effect"
import pgDriver from "pg"

type Equals<A, B> =
	(<X>(x: X) => X extends A ? 1 : 2) extends <X>(x: X) => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

/**
 * The README's program, checked. Each ```ts block of README.md is below, in order and with its comments, after a
 * comment naming its README section, with two mechanical substitutions: the package's own name, "@bjornpagen/grizzle",
 * resolves here to the sources through the package's grizzle-source export condition, and the committed snapshot.json
 * the README imports is a declared value, because this directory has no migrations; the config block's own imports are
 * this file's bindings.
 * test/types/examples/blocks.test.ts holds every README ```ts block here, line for line and in order. The types the
 * README's comments and prose state are pinned at the end, with the refusals it promises. Typechecked, never executed.
 *
 * README: the opening block, the blog's schema and one query over it.
 */
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

/** README: "The relational model, by feel", "Checks and closed relations": a price list and the rules that read it. */
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
export const Billing = schema.extend(Blog, "Billing", { Plan, PlanLimits, Subscription }, [
	contained(on(Post, "org"), on(Subscription, "org")),
	check("WithinPlan", Subscription, (s) => s.le(s.seats, PlanLimits.at("seats", s.plan)))
])

/** README: "The relational model, by feel", "A write moves between lawful states". */
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

/** README: "Hard in Drizzle, one declaration here", 1. Every organization sees only its own rows. */
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

/** README: "Hard in Drizzle, one declaration here", 2. Top three per group, with exact types. */
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

/** README: "Hard in Drizzle, one declaration here", 3. A tree of any depth. */
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

/** README: "Hard in Drizzle, one declaration here", 4. No double booking. */
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

/** README: "Hard in Drizzle, one declaration here", 5. A budget no burst of requests can overdraw. */
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

/** README: "Hard in Drizzle, one declaration here", 6. Books that always balance. */
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

/** README: "Hard in Drizzle, one declaration here", 7. States that carry their own data. */
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

/** README: "Hard in Drizzle, one declaration here", 8. A usage page: cursors, a rollup and their indexes. */
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
export const ModelSpend = derived.materialized(
	"ModelSpend",
	query(Usage).rule((r) => {
		const { id, workspace, model, cost } = v(Call, "call")
		return r
			.match(Call, { id, workspace, model, cost })
			.find({ workspace, model, calls: r.count(), spend: r.sum(cost) })
	})
)
export const Reporting = schema.extend(Usage, "Reporting", { ModelSpend }, [])

export const Analyst = role(Reporting, "analyst", wholeEntriesOf(Reporting), {
	refresh: ["ModelSpend"]
})
export const UsageApi = login(Reporting, "usage_api", [Analyst], {
	workload: [workload(Analyst, { callLog })]
})

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

/** README: "Example", "Who is asking". */
/** Clerk's session token: the user in `sub`, the active organization's id in the nested object `o`. */
export const Session = context("Session", { sub: ClerkUser })
export const Org = context("Org", { id: ClerkOrg }, { claim: "o" })

/** README: "Example", "What each kind of user sees". */
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

/** README: "Example", "The app's queries and its logins". */
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

/**
 * README: "Example", "Connecting". The README imports `snapshot` from "./migrations/blog/snapshot.json" with
 * { type: "json" }.
 */
declare const snapshot: { readonly fingerprint: string }

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

/** README: "Example", "The route handler". */
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

/** README: "Example", "The nightly job". */
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

/** README: "Rules", the box office. */
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

/** README: "Rules", a side's selection and its pred term: a show's waitlist. */
/** A show's waitlist: its places in order from 0, and whether each place's holder has been called. */
export const Place = relation(
	"Place",
	{ show: uuid, at: natural, holder: ClerkUser, called: pg.boolean },
	["show", "at"]
)

/** The places whose holder has not been called yet. */
const waiting = select(Place, (p) => p.eq(p.called, false))

export const Waitlist = schema.extend(BoxOffice, "Waitlist", { Place }, [
	contained(on(Place, "show"), on(Show, "id")),
	contained(on(Place, "show", pred("at")), on(Place, "show", "at")),
	key(on(waiting, "show", "holder"))
])

/** README: "Rules over queries": rules over a join no table stores. */
/** A content package's resources, each with an href and a type, either of which it may lack. */
export const Resource = relation("Resource", { id: uuid }, ["id"])
export const ResourceHref = relation(
	"ResourceHref",
	{ resource: uuid, path: Title, internal: pg.boolean },
	["resource"]
)
export const ResourceTyped = relation("ResourceTyped", { resource: uuid, type: Title }, [
	"resource"
])
export const PackageFile = relation("PackageFile", { path: Title }, ["path"])
/** A catalog record of a resource, naming its href and its type. */
export const CatalogRecord = relation(
	"CatalogRecord",
	{ resource: uuid, path: Title, type: Title },
	["resource"]
)

export const Content = schema(
	"Content",
	{ Resource, ResourceHref, ResourceTyped, PackageFile, CatalogRecord },
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

export const ContentPackage = schema.extend(Content, "ContentPackage", { TypedHref }, [
	check("ItemsInside", TypedHref, (t) =>
		t.not(t.and(t.eq(t.type, "item"), t.eq(t.internal, false)))
	),
	contained(on(items, "path"), on(PackageFile, "path")),
	contained(
		on(CatalogRecord, "resource", "path", "type"),
		on(TypedHref, "resource", "path", "type")
	)
])

/** README: "Queries". */
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

/** README: "Queries", no outer joins. */
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

/** README: "Writes". */
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

/** README: "Levels". */
/** The QTI content model, maintained on its own. */
export const Item = relation("Item", { id: uuid, title: Title }, ["id"])
export const Qti = schema("Qti", { Item }, [])

/** A child's sittings, over Qti: each sitting's item is one Qti holds, as the database enforces. */
export const Sitting = relation("Sitting", { id: uuid, child: ClerkUser, item: uuid }, ["id"])
export const Ledger = schema.extend(Qti, "Ledger", { Sitting }, [
	contained(on(Sitting, "item"), on(Item, "id"))
])

/** The signed-in child's own sittings; an insert fills `child` from the token. */
export const mySittings = query(Ledger).rule((r) => {
	const { id, child, item } = v(Sitting, "sitting")
	return r.match(Sitting, { id, child, item }).match(Session, { sub: child }).find({ id, item })
})

export const Learner = role(
	Ledger,
	"learner",
	{ ...wholeEntriesOf(Qti), MySitting: mySittings },
	{ write: ["MySitting"] }
)
export const LedgerApp = login(Ledger, "app", [Learner])
export const QtiAuthor = role(Qti, "author", wholeEntriesOf(Qti), { write: writableNamesOf(Qti) })
export const AuthorApp = login(Qti, "author_app", [QtiAuthor])

/**
 * README: "Migrations", the block of grizzle.config.ts. Its imports of net, CredentialError, defineConfig, Config,
 * Effect, pgDriver, Blog, caPem, EtlJob and Web are this file's.
 */
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

/** README: "Deploying". */
/** The RDS IAM password: an Effect signing a token for each connection attempt, for the login's PostgreSQL role
 * (roleNameOf), failing as a CredentialError. */
export const RdsEtlLayer = DbLayer.make({
	...connection,
	login: EtlJob,
	snapshot,
	pool: { max: 2, min: 0, idleTimeoutMs: 5_000 },
	password: Effect.tryPromise({
		try: () =>
			new Signer({
				hostname: "db.internal",
				port: 5432,
				region: "us-east-1",
				username: roleNameOf(EtlJob)
			}).getAuthToken(),
		catch: (cause) => new CredentialError({ cause })
	}).pipe(Effect.map(Redacted.make))
})

/** The types the README's comments and prose state. */
export type PostPageHead = Expect<
	Equals<
		HeadOf<typeof postPage>,
		{
			readonly id: Uuid
			readonly title: string
			readonly body: string
			readonly comments: ReadonlyArray<{
				readonly id: Uuid
				readonly author: string
				readonly body: string
			}>
		}
	>
>

export type PostPageParams = Expect<
	Equals<ParamsOf<typeof postPage>, { readonly id: ParamType<Uuid, "uuid"> }>
>

/** "grizzle knows postPage returns at most one row, so db.get accepts it": on a role holding the schema whole. */
const Staff = role(Blog, "staff", wholeEntriesOf(Blog))
declare const staff: Db<typeof Staff, unknown>
export const onePage = staff.get(postPage, { id: "00000000-0000-0000-0000-000000000000" })
export type OnePage = Expect<
	Equals<Effect.Success<typeof onePage>, Option.Option<HeadOf<typeof postPage>>>
>

/** "db.get on a query that can return several rows is a type error". */
// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
export const manyPages = staff.get(published, {})

export type AnonFeedHead = Expect<
	Equals<HeadOf<typeof anonFeed>, { readonly id: Uuid; readonly title: string }>
>

export type MemberFeedHead = Expect<
	Equals<HeadOf<typeof memberFeed>, { readonly id: Uuid; readonly title: string }>
>

export type CommentsPerAuthorHead = Expect<
	Equals<HeadOf<typeof commentsPerAuthor>, { readonly author: string; readonly comments: bigint }>
>

export type ViewsPerOrgHead = Expect<
	Equals<HeadOf<typeof viewsPerOrg>, { readonly org: string; readonly views: Decimal }>
>

export type OrgPostsParams = Expect<
	Equals<ParamsOf<typeof orgPosts>, { readonly org: ParamType<string, "text"> }>
>

/** "a finite pattern such as ^(yes|no)$ is "yes" | "no"". */
const YesNo = str.regex("^(yes|no)$")
export type YesNoHost = Expect<Equals<Infer<typeof YesNo>, "yes" | "no">>

/** "A contract value is made with its constructor, Cents(500n)". */
export const price: Infer<typeof Cents> = Cents(500n)

/** "natural is a count: the builtin contract natural over pg.bigint, unbranded". */
export type PlaceAt = Expect<Equals<Fact<typeof Place>["at"], bigint>>

/** "A term is a field, or pred(n) of a natural field n". */
// @ts-expect-error -- TS2345: pred reads a natural field, and holder is text
export const predOfText = on(Place, pred("holder"))

/** "over a selected side or a pred term it holds apart only the rows its side reads, and is no key of the table". */
export type PlaceKeys = Expect<
	Equals<KeysOf<typeof Waitlist, typeof Place>, readonly ["show", "at"]>
>

/** "db.get(Post, { id })": a table by its key. */
export const byKey = staff.get(Post, { id: "00000000-0000-0000-0000-000000000000" })
export type ByKey = Expect<Equals<Effect.Success<typeof byKey>, Option.Option<Fact<typeof Post>>>>

/** "Db.open(Web.roles.member, ...) does not typecheck without one": MemberBlog's relations read Session and Org. */
// @ts-expect-error -- TS2741: MemberBlog reads a context, so Db.open requires a token
export const memberWithoutToken = Db.open(Web.roles.member, {})

/** "Db.open(Web.roles.anon, ...) needs no token", and the web login's layer serves both of its roles. */
export const bothRoles = web.runPromise(
	Effect.gen(function* () {
		const anon = yield* Db.open(Web.roles.anon, {})
		const member = yield* Db.open(Web.roles.member, { token: "a verified token" })
		return [anon, member] as const
	})
)

/** "Each Db shows the programs of its login's workloads for its role": the anonymous Db has no memberFeed. */
export const anonFeedOnly = web.runPromise(
	Effect.gen(function* () {
		const anon = yield* Db.open(Web.roles.anon, {})
		// @ts-expect-error -- TS2339: memberFeed is a program over MemberBlog, which an AnonBlog Db does not run
		return anon.workload.memberFeed
	})
)

/** A role is opened only through its login: the role value itself is no LoginRole. */
// @ts-expect-error -- TS2739: Db.open takes a role reached through its login, Web.roles.member
export const bareRole = Db.open(MemberBlog, { token: "a verified token" })

/** "Two programs of one name across a login's workloads are a type error". */
const twiceReader = role(Blog, "twice_reader", { Post: postIds })
const twicePrograms = [workload(Blog, { postIds }), workload(Blog, { postIds })] as const
// @ts-expect-error -- TS2345 refusal: two programs of one name across a login's workloads
export const twiceNamed = () => login(Blog, "twice", [twiceReader], { workload: twicePrograms })

/**
 * "The web login can never write PostViews": Etl is a role of the other login, so the web layer provides no layer that
 * serves it.
 */
export type EtlOnWeb = Expect<
	Equals<Extract<Layer.Success<typeof WebLayer>, DbLayer<typeof Etl>>, never>
>

/** "Only the write list is writable": MemberBlog's Post is read-only. */
const post = {
	id: "00000000-0000-0000-0000-000000000000",
	title: "t",
	body: "b",
	status: "Draft"
} as const
// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
export const writePost = ChangeSet.empty(MemberBlog).insert(MemberPost, [post])

/** "A query over the schema is a type error on a role that does not hold every table whole". */
// @ts-expect-error -- TS2345 refusal: a program over no level of the database's schema
export const baseOnMember = (db: Db<typeof MemberBlog, unknown>) => db.execute(published, {})

/** "requires verify exactly when a role of the login reads a context". */
// @ts-expect-error -- TS2345: a role of the web login reads a context, so its layer needs verify
export const webWithoutVerify = DbLayer.make({
	...connection,
	login: Web,
	snapshot,
	password: Redacted.make("secret"),
	pool: { max: 10, min: 1, idleTimeoutMs: 5_000 }
})

/** The gallery's types, as its prose states them. */
export type OrgKeysHead = Expect<
	Equals<HeadOf<typeof orgKeys>, { readonly id: Uuid; readonly name: string }>
>

/** "Db.open(Dashboard.roles.key_admin, ...) does not compile without the token". */
// @ts-expect-error -- TS2741: KeyAdmin reads a context, so Db.open requires a token
export const keyAdminWithoutToken = Db.open(Dashboard.roles.key_admin, {})

export type TopModelsHead = Expect<
	Equals<
		HeadOf<typeof topModels>,
		{
			readonly workspace: Uuid
			readonly spend: Decimal
			readonly models: ReadonlyArray<{
				readonly model: string
				readonly calls: bigint
				readonly spend: Decimal
			}>
		}
	>
>

export type TreeSpendHead = Expect<
	Equals<HeadOf<typeof treeSpend>, { readonly account: Uuid; readonly spend: Decimal }>
>
export type TreeSpendParams = Expect<
	Equals<ParamsOf<typeof treeSpend>, { readonly root: ParamType<Uuid, "uuid"> }>
>

export type InvoiceCardHead = Expect<
	Equals<
		HeadOf<typeof invoiceCard>,
		| {
				readonly id: Uuid
				readonly state: "open"
				readonly payment: Option.None<{ readonly charge: string }>
				readonly voiding: Option.None<{ readonly reason: string }>
		  }
		| {
				readonly id: Uuid
				readonly state: "paid"
				readonly payment: Option.Some<{ readonly charge: string }>
				readonly voiding: Option.None<{ readonly reason: string }>
		  }
		| {
				readonly id: Uuid
				readonly state: "void"
				readonly payment: Option.None<{ readonly charge: string }>
				readonly voiding: Option.Some<{ readonly reason: string }>
		  }
	>
>

export type PayParams = Expect<
	Equals<
		ParamsOf<typeof pay>,
		{ readonly invoice: ParamType<Uuid, "uuid">; readonly charge: ParamType<string, "text"> }
	>
>

export type CallLogHead = Expect<
	Equals<
		HeadOf<typeof callLog>,
		{
			readonly id: Uuid
			readonly model: string
			readonly at: Infer<typeof Millis>
			readonly cost: Infer<typeof Micros>
		}
	>
>
export type FirstCalls = Expect<
	Equals<
		Effect.Success<ReturnType<typeof firstCalls>>,
		Page<HeadOf<typeof callLog>, typeof callLog>
	>
>
export type SpendOn = Expect<
	Equals<
		Effect.Success<ReturnType<typeof spendOn>>,
		Option.Option<{ readonly calls: bigint; readonly spend: Decimal }>
	>
>

/** Each rule's rows are a { show, sold } of its own; together they are exactly that row type, both ways. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type SoldHead = Expect<
	Same<HeadOf<typeof sold>, { readonly show: Uuid; readonly sold: bigint }>
>
export type PublishParams = Expect<
	Equals<ParamsOf<typeof publish>, { readonly id: ParamType<Uuid, "uuid"> }>
>

/** "the outcome's reads hold the count": on a role that writes Comment. */
const Moderator = role(Blog, "moderator", wholeEntriesOf(Blog), { write: ["Comment"] })
declare const moderator: Db<typeof Moderator, unknown>
export const purged = moderator.apply(purge, { author: "user_1" })
export type PurgedReads = Expect<
	Equals<
		Extract<Effect.Success<typeof purged>, { readonly kind: "accepted" }>["reads"],
		{ readonly removed: ReadonlyArray<{ readonly comments: bigint }> }
	>
>

/** "Types are sets of values": each field's TypeScript type follows from its declaration. */
export type PostIdHost = Expect<Equals<Fact<typeof Post>["id"], Uuid>>
export type PostStatusHost = Expect<Equals<Fact<typeof Post>["status"], "Draft" | "Published">>
export type PostViewsHost = Expect<Equals<Fact<typeof PostViews>["views"], bigint>>
export type SubscriptionPlanHost = Expect<
	Equals<Fact<typeof Subscription>["plan"], "Free" | "Team">
>
export type SubscriptionSeatsHost = Expect<Equals<Fact<typeof Subscription>["seats"], bigint>>

/** "db.apply answers with an outcome you match on: accepted, no-change, invariant-rejected or outside-world". */
export type LaunchOutcomeKind = Expect<
	Equals<
		Effect.Success<ReturnType<typeof launch>>["kind"],
		"accepted" | "no-change" | "invariant-rejected" | "outside-world"
	>
>

/** "refused.laws names each broken rule as you declared it: law.kind === "check" && law.name === "WithinPlan"". */
type LaunchLaw = Extract<
	Effect.Success<ReturnType<typeof launch>>,
	{ readonly kind: "invariant-rejected" }
>["refused"]["laws"][number]
export const overPlan = (law: LaunchLaw): boolean =>
	law.kind === "check" && law.name === "WithinPlan"
