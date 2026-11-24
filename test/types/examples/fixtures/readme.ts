import net from "node:net"
import { Signer } from "@aws-sdk/rds-signer"
import {
	accumulated,
	alternatives,
	type AnyLogin,
	type AnySchema,
	arm,
	attested,
	ChangeSet,
	check,
	clocked,
	closed,
	closedId,
	contained,
	context,
	contract,
	counted,
	CredentialError,
	type Decimal,
	defineConfig,
	derived,
	Distance,
	drawn,
	type Fact,
	fin,
	fn,
	Fn,
	fold,
	fragment,
	type HeadOf,
	type Inet,
	type Infer,
	instant,
	key,
	type KeysOf,
	Logic,
	login,
	Monoid,
	mutable,
	natural,
	Net,
	Num,
	on,
	paged,
	type ParamsOf,
	type ParamType,
	pg,
	pred,
	query,
	race,
	Range,
	records,
	recordsFacts,
	recordsQuery,
	relation,
	role,
	row,
	rows,
	schema,
	scopedEntriesOf,
	Search,
	searchDocument,
	select,
	series,
	type Sha256,
	sha256,
	span,
	str,
	Time,
	Type,
	unit,
	v,
	wholeEntriesOf,
	workload,
	wholeWritesOf
} from "@bjornpagen/grizzle"
import {
	Db,
	DbLayer,
	LiveSource,
	type LiveOf,
	type LiveSourceService,
	roleNameOf,
	served,
	TokenRefused
} from "@bjornpagen/grizzle/runtime"
import { verifyToken } from "@clerk/backend"
import { Array, Config, Effect, Layer, ManagedRuntime, type Option, Redacted, Schema } from "effect"
import pgDriver from "pg"

type Equals<A, B> =
	(<X>(x: X) => X extends A ? 1 : 2) extends <X>(x: X) => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

/**
 * The README's program, checked. Each ```ts block of README.md is below, in order and with its comments, after a
 * comment naming its README section, with one mechanical substitution: the committed snapshot.json the README imports
 * is a declared value, because this directory has no migrations; the config block's own imports are this file's
 * bindings. The package's own name, "@bjornpagen/grizzle", resolves to the sources the package exports, as it does for
 * every consumer.
 * test/types/examples/blocks.test.ts holds every README ```ts block here, line for line and in order. The types the
 * README's comments and prose state are pinned at the end, with the refusals it promises. Typechecked, never executed.
 *
 * README: the opening block, the blog's schema and one query over it.
 */
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

/** README: "The relational model, by feel", "Checks and closed relations": a price list and the rules that read it. */
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

/** README: "The relational model, by feel", "A write moves between lawful states". */
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

/** README: "Hard in Drizzle, one declaration here", 1. Every organization sees only its own rows. */
/** An API key, keyed by the SHA-256 of its secret: the table never holds a secret, and a key is one row everywhere. */
export const ApiKey = relation("ApiKey", { digest: sha256, org: ClerkOrg, name: Title }, ["digest"])
export const Keys = schema("Keys", [ApiKey], [])

/** The caller's organization: the `org` claim of their verified session token. */
export const Tenant = context("Tenant", { org: ClerkOrg })

/** The keys of the caller's organization. An insert takes `org` from the token. */
export const orgKeys = query(Keys).rule((r) => {
	const { digest, org, name } = v(ApiKey, "apiKey")
	return r.match(ApiKey, { digest, org, name }).match(Tenant, { org }).find({ digest, name })
})

export const KeyAdmin = role(
	Keys,
	"key_admin",
	{ ApiKey: orgKeys },
	{ insert: ["ApiKey"], contexts: [Tenant] }
)
export const Dashboard = login(Keys, "dashboard", [KeyAdmin])

/** README: "Hard in Drizzle, one declaration here", 2. Top three per group, with exact types. */
/** Millionths of a dollar, never negative; and an instant, in milliseconds since the epoch. */
const Micros = contract("Micros", pg.bigint, (m) => Logic.ge(m, 0n))
const Millis = contract("Millis", pg.bigint)
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

/** README: "Hard in Drizzle, one declaration here", 3. A tree of any depth. */
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

/** README: "Hard in Drizzle, one declaration here", 4. No double booking. */
const Minute = contract("Minute", pg.bigint)

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

/** README: "Hard in Drizzle, one declaration here", 5. A budget no burst of requests can overdraw. */
/** A grant of credits, by the Stripe payment that bought it. */
const StripePayment = str.regex("^pi_[0-9A-Za-z]{1,64}$")
export const Grant = relation(
	"Grant",
	{
		id: StripePayment,
		org: ClerkOrg,
		amount: Micros,
		debits: drawn(natural),
		spent: accumulated(Micros, Micros(0n))
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

/** README: "Hard in Drizzle, one declaration here", 6. Books that always balance. */
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

/** README: "Hard in Drizzle, one declaration here", 7. States that carry their own data. */
export const InvoiceState = closed.unordered("InvoiceState", ["open", "paid", "void"])
/** An invoice, by Stripe's id of it. */
const StripeInvoice = str.regex("^in_[0-9A-Za-z]{1,64}$")
export const Invoice = relation(
	"Invoice",
	{ id: StripeInvoice, org: ClerkOrg, state: closedId(InvoiceState) },
	["id"]
)
export const Payment = relation(
	"Payment",
	{ invoice: StripeInvoice, charge: str.regex("^ch_[0-9A-Za-z]{1,64}$") },
	["invoice"]
)
export const Voiding = relation("Voiding", { invoice: StripeInvoice, reason: Prose }, ["invoice"])

export const Invoices = schema(
	"Invoices",
	[InvoiceState, Invoice, Payment, Voiding],
	[
		alternatives(Invoice, "state", InvoiceState, { paid: Payment, void: Voiding }),
		unit("Invoice", { id: StripeInvoice }),
		mutable(Invoice)
	]
)

/** An invoice, with its payment when it is paid and its voiding when it is void. */
export const invoiceCard = query(Invoices)
	.rule((r) => {
		const { id, state } = v(Invoice, "invoice")
		return r
			.match(Invoice, { id, state })
			.where(r.eq(id, r.param("id", StripeInvoice)))
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
				.match(Invoice, { id: r.param("invoice", StripeInvoice), org, state: "open" })
				.find({ id: r.param("invoice", StripeInvoice), org, state: InvoiceState.handle("paid") })
		})
	)
	.insert(
		Payment,
		query(Invoices).rule((r) =>
			r.match(Invoice, { id: r.param("invoice", StripeInvoice), state: "open" }).find({
				invoice: r.param("invoice", StripeInvoice),
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

/** README: "Example", "Who is asking". */
/** Clerk's session token: the user in `sub`, the active organization's id in the nested object `o`. */
export const Session = context("Session", { sub: ClerkUser })
export const Org = context("Org", { id: ClerkOrg }, { claim: "o" })

/** README: "Example", "What each kind of user sees". */
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

/** README: "Example", "The app's queries and its logins". */
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

/**
 * README: "Example", "Connecting". The README imports `webFile` and `etlJobFile` from
 * "./migrations/blog/served/web.json" and "./migrations/blog/served/etl_job.json" with { type: "json" }, and the logins
 * as types alone.
 */
declare const webFile: unknown
declare const etlJobFile: unknown

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

/** README: "Example", "The route handler". */
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

/** README: "Example", "The nightly job". */
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

/** README: "Rules", the box office. */
const Cents = contract("Cents", pg.bigint, (c) => Logic.ge(c, 0n))
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

/** README: "Rules", a side's selection and its pred term: a show's waitlist. */
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

/** README: "Rules over queries": rules over a join no table stores. */
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
			t.not(t.and(t.eq(t.type, "item"), t.eq(t.internal, false)))
		),
		contained(on(items, "path"), on(PackageFile, "path")),
		contained(
			on(CatalogRecord, "resource", "path", "type"),
			on(TypedHref, "resource", "path", "type")
		)
	]
)

/** README: "Units": an assignment's sitting, the unit its facts sit under. */
const TestId = str.bytes(64, str.regex("^[0-9A-Za-z_-]{1,64}$"))
const QuestionId = str.bytes(255, str.regex("^.{1,255}$", "u"))
const Reason = str.bytes(255, str.regex("^.{1,255}$", "u"))
/** An assignment's number, a sitting's key: a contract of its own, so no other number leads a key with it. */
const AssignmentNo = contract("AssignmentNo", pg.bigint, (n) => Logic.ge(n, 0n))

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

/** README: "Units", the series. */
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

/** README: "Removing a unit's rows". */
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

/**
 * README: "Scoped entries": a level of the tables a sitting writes, each person a Clerk account signs in as, each
 * assignment rooted by its student, each test session by its child, each event of an assignment reached through its
 * number, and the tables a student writes.
 */
const PersonId = str.regex("^p_[a-z0-9]{1,24}$", "u")
const Person = relation("Person", { person: PersonId }, ["person"])
const ClerkAccount = relation("ClerkAccount", { clerk: ClerkUser, person: PersonId }, ["clerk"])
const Assignment = relation("Assignment", { number: pg.bigint, student: PersonId }, ["number"])
const TestSession = relation("TestSession", { child: PersonId, stage: natural }, ["child", "stage"])
const SittingEvent = relation("SittingEvent", { number: pg.bigint, step: natural }, [
	"number",
	"step"
])
const Sittings = schema(
	"Sittings",
	[Person, ClerkAccount, Assignment, TestSession, SittingEvent],
	[
		contained(on(ClerkAccount, "person"), on(Person, "person")),
		contained(on(Assignment, "student"), on(Person, "person")),
		contained(on(TestSession, "child"), on(Person, "person")),
		contained(on(SittingEvent, "number"), on(Assignment, "number"))
	]
)
const studentInsertNames = ["SittingEvent"] as const

/** The persons the signed-in Clerk user is: the owner, read from the token and the sign-in it names. */
const persons = query(Sittings).rule((r) => {
	const { sub } = v(Session, "session")
	const { person } = v(ClerkAccount, "account")
	return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, person }).find({ person })
})

/** Each assignment rooted by its student, each test session by its child. */
const roots = { Assignment: "student", TestSession: "child" } as const

export const Student = role(
	Sittings,
	"student",
	scopedEntriesOf(Sittings, { owner: persons, roots }),
	{ contexts: [Session], insert: studentInsertNames }
)

/** README: "Queries". */
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

/** README: "Queries", network containment. */
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

/** "`attested` exactly when it declares one its server attests": a full role of Campus declaring Origin. */
export const Visitor = role(Campus, "visitor", wholeEntriesOf(Campus), { contexts: [Origin] })
export const CampusWeb = login(Campus, "campus_web", [Visitor], {
	workload: [workload(Visitor, { orgsHere })]
})
declare const campusFile: unknown
const CampusServed = served<typeof CampusWeb>(campusFile, "campus_web")

// @ts-expect-error -- refused: Visitor declares an attested context, so Db.open requires the server's attested facts
export const visitorUnattested = Db.open(CampusServed.roles.visitor, {})

/** A server attests the address its edge reports, read by Inet.parse; no token is needed for a role that claims none. */
export const visitorAttested = (header: Inet) =>
	Db.open(CampusServed.roles.visitor, { attested: { Origin: { address: header } } })

export const visitorMisattested = (header: Inet) =>
	// @ts-expect-error -- refused: an attested fact holds its context's fields alone
	Db.open(CampusServed.roles.visitor, { attested: { Origin: { addr: header } } })

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

/** README: "Queries", nearest rows. */
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

/** README: "Queries", full text search. */
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
				r.and(
					Search.matches(search, q),
					r.eq(subject, r.param("subject", Unit.fields.subject)),
					r.le(grade, r.param("grade", Unit.fields.grade))
				)
			)
			.find({ unit: id, rank: Search.rank(search, q) })
	})
	.orderBy(["rank", "desc"])
	.take(10)

/** README: "Queries", hybrid search. */
/** The twenty units of a subject up to a grade nearest a query's embedding. */
export const nearUnits = query(Course)
	.rule((r) => {
		const { id, subject, grade, embedding } = v(Unit, "unit")
		return r
			.match(Unit, { id, subject, grade, embedding })
			.where(
				r.and(
					r.eq(subject, r.param("subject", Unit.fields.subject)),
					r.le(grade, r.param("grade", Unit.fields.grade))
				)
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
				r.or(
					r.lt(y.distance, x.distance),
					r.and(r.eq(y.distance, x.distance), r.le(y.unit, x.unit))
				)
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
			.where(r.or(r.gt(y.rank, x.rank), r.and(r.eq(y.rank, x.rank), r.le(y.unit, x.unit))))
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

/** README: "Reading", the database's clock. */
/** The calls that ran at or before the database's instant. */
export const ranBefore = query(Usage).rule((r) => {
	const { id, at } = v(Call, "call")
	return r
		.match(Call, { id, at })
		.where(r.le(at, r.param("now", Millis)))
		.find({ id, at })
})

export const UsageClock = workload(Usage, { ranBefore: clocked(ranBefore, { now: "millis" }) })

/** README: "Reading", time zones. */
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
	branchClock: clocked(branchClock, { now: "millis" })
})

/** README: "Writes". */
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

/** README: "A window a put extends". */
const LearnerId = contract("LearnerId", pg.integer)
const StageKey = contract("StageKey", pg.bigint)
/**
 * Microseconds on the database's clock, a window's ends, up to 10000-01-01, after which no day a date holds begins; a
 * reading is one below the top, so it ends a window too.
 */
const Moment = contract("Moment", pg.bigint, (t) => Num.within(t, 0n, 253_402_300_800_000_000n))
const Reading = contract("Reading", pg.bigint, (t) =>
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
			start: Type.cast(Type.base(r.param("now", Reading)), Moment),
			end: Type.cast(Num.add(Type.base(r.param("now", Reading)), 1n), Moment)
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

/** README: "Rows an insertion met". */
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

/** README: "Instants": a user, a visit's token and a sign-in's method, the types the example names. */
const UserId = str.regex("^u_[a-z0-9]{1,24}$", "u")
const Token = str.regex("^[a-f0-9]{32}$", "u")
const Method = closed.ordered("Method", ["password", "passkey"])

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

/** What a read of sign-ins delivered, kept as it was read: its instants stored as they are. */
const SeenSignIn = relation("SeenSignIn", { user: UserId, at: instant.stored }, ["user", "at"])
export const KeptSignIns = schema("KeptSignIns", [SeenSignIn], [])

/**
 * README: "Records of a query": a school's offered lessons, the query of them whose found rows an audit keeps, a run of
 * the audit, one run's found lessons as a host holds them, and the digest each is kept under.
 */
const Offered = relation("Offered", { lesson: LessonSlug, minutes: natural }, ["lesson"])
const School = schema("School", [Offered], [])
const lessonsOf = query(School).rule((r) => {
	const { lesson, minutes } = v(Offered, "offered")
	return r.match(Offered, { lesson, minutes }).find({ lesson, minutes })
})
const RunId = contract("RunId", pg.bigint)
declare const lessons: ReadonlyArray<HeadOf<typeof lessonsOf>>
declare const run: Infer<typeof RunId>
declare const digestOf: (row: HeadOf<typeof lessonsOf>) => Sha256

const found = records("Lessons", lessonsOf, { digest: sha256, run: RunId }, ["digest", "run"])
export const Audit = schema.extend([School], "Audit", found.relations, found.rules)

/** The insert of one run's found rows, each under its own digest. */
const entries = Array.map(lessons, (row) => [{ digest: digestOf(row), run }, row] as const)
const insert = recordsFacts(Audit, found)(entries)
ChangeSet.empty(Audit).insertAll(insert)

/** The rows stored at one owner: rows of `lessonsOf`'s own type, read through its own decoder. */
export const storedLessons = recordsQuery(Audit, found)

/** README: "Levels". */
/** "Declared functions": a function of an SQL body and one of a PL/pgSQL body that calls it, over a heading's rows. */
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

/** "Calling a function": a call of rows over a bound query, read once per document, and a call term. */
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

/** "Calling a function": the fields of one row, two members of one statement reading one call. */
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

/** README: "Fragments". */
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

/**
 * "join their ChangeSets by `ChangeSet.union`": feeJob served takes the fragment's facts beside the application's, each
 * relation's rows under its own name, JobDone's as the fragment writes them.
 */
export const finishWithFee = (
	db: Db<typeof JobWorker, { readonly feeJob: typeof feeJob }>,
	job: string
) =>
	db.workload.feeJob.once({
		params: {},
		facts: { insert: { JobDone: [{ job, ok: true }], Fee: [{ job, cents: 100n }] } }
	})

/**
 * README: "Migrations", the block of grizzle.config.ts. Its imports of net, CredentialError, defineConfig, Config,
 * Effect, pgDriver, Blog, caPem, EtlJob and Web are this file's.
 */
export default defineConfig({
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
			Effect.mapError((cause) => new CredentialError({ cause }))
		)
	})
})

/** README: "READ COMMITTED writes", publishing the keys a learner's answers reference. */
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

/** README: "Races". */
export const Instant = contract("Instant", pg.bigint)
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

/** README: "Deploying". */
/** The RDS IAM password: an Effect signing a token for each connection attempt, for the login's PostgreSQL role
 * (roleNameOf), failing as a CredentialError. */
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

/** The types the README's comments and prose state. */
export type PostPageHead = Expect<
	Equals<
		HeadOf<typeof postPage>,
		{
			readonly org: string
			readonly slug: string
			readonly title: string
			readonly body: string
			readonly comments: ReadonlyArray<{
				readonly author: string
				readonly at: Infer<typeof instant>
				readonly body: string
			}>
		}
	>
>

export type PostPageParams = Expect<
	Equals<
		ParamsOf<typeof postPage>,
		{ readonly org: ParamType<string, "text">; readonly slug: ParamType<string, "text"> }
	>
>

/** The rows a read's value holds, in its order. */
type RowsOf<V> = V extends Iterable<infer Row> ? Row : never

/** "a query over the schema runs on a role holding the schema whole": its value holds its rows. */
const Staff = role(Blog, "staff", wholeEntriesOf(Blog))
const staffReads = workload(Staff, { postPage, post: Post })
declare const staff: Db<typeof Staff, typeof staffReads.programs>
export const onePage = staff.workload.postPage.once({
	params: { org: "org_1", slug: "hello" },
	facts: {}
})
export type OnePage = Expect<
	Equals<RowsOf<Effect.Success<typeof onePage>>, HeadOf<typeof postPage>>
>

export type AnonFeedHead = Expect<
	Equals<
		HeadOf<typeof anonFeed>,
		{ readonly org: string; readonly slug: string; readonly title: string }
	>
>

export type MemberFeedHead = Expect<
	Equals<
		HeadOf<typeof memberFeed>,
		{ readonly org: string; readonly slug: string; readonly title: string }
	>
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
// @ts-expect-error -- refused: pred reads a natural field, and holder is text
export const predOfText = on(Place, pred("holder"))

/** "over a selected side or a pred term it holds apart only the rows its side reads, and is no key of the table". */
export type PlaceKeys = Expect<
	Equals<KeysOf<typeof Waitlist, typeof Place>, readonly ["show", "at"]>
>

/** "a workload's member Post reads a table by its key": its params are the key's values. */
export const byKey = staff.workload.post.once({
	params: { org: "org_1", slug: "hello" },
	facts: {}
})
export type ByKey = Expect<Equals<RowsOf<Effect.Success<typeof byKey>>, Fact<typeof Post>>>

/** "Db.open(WebServed.roles.member, ...) does not typecheck without one": MemberBlog's relations read Session and Org. */
// @ts-expect-error -- refused: MemberBlog reads a context, so Db.open requires a token
export const memberWithoutToken = Db.open(WebServed.roles.member, {})

/** "Db.open(WebServed.roles.anon, ...) needs no token", and the web login's layer serves both of its roles. */
export const bothRoles = web.runPromise(
	Effect.gen(function* () {
		const anon = yield* Db.open(WebServed.roles.anon, {})
		const member = yield* Db.open(WebServed.roles.member, { token: "a verified token" })
		return [anon, member] as const
	})
)

/** "Each Db shows the programs of its login's workloads for its role": the anonymous Db has no memberFeed. */
export const anonFeedOnly = web.runPromise(
	Effect.gen(function* () {
		const anon = yield* Db.open(WebServed.roles.anon, {})
		// @ts-expect-error -- refused: memberFeed is a program over MemberBlog, which an AnonBlog Db does not run
		return anon.workload.memberFeed
	})
)

/** A role is opened only through its served login: the role value itself is no ServedRole. */
// @ts-expect-error -- refused: Db.open takes a role of a served login, WebServed.roles.member
export const bareRole = Db.open(MemberBlog, { token: "a verified token" })

/** "a role of the login itself (Web.roles.member) is a type error, since the app holds the login as a type alone". */
// @ts-expect-error -- refused: Db.open takes a role of a served login, WebServed.roles.member
export const loginsOwnRole = Db.open(Web.roles.member, { token: "a verified token" })

/** "Two programs of one name across a login's workloads are a type error". */
const twiceReader = role(Blog, "twice_reader", { Post: postKeys })
const twicePrograms = [workload(Blog, { postKeys }), workload(Blog, { postKeys })] as const
// @ts-expect-error -- refusal: two programs of one name across a login's workloads
export const twiceNamed = () => login(Blog, "twice", [twiceReader], { workload: twicePrograms })

/**
 * "The web login can never write PostViews": Etl is a role of the other login, so the web layer provides no layer that
 * serves it.
 */
export type EtlOnWeb = Expect<
	Equals<Extract<Layer.Success<typeof WebLayer>, DbLayer<typeof Etl>>, never>
>

/** "`EtlJob` serves no read, so its layer needs no live source". */
export type EtlNeedsNoSource = Expect<Equals<Layer.Services<typeof EtlLayer>, never>>

/** "A login whose type hides its workloads, `AnyLogin` among them, requires one too". */
export type ErasedNeedsSource = Expect<Equals<LiveOf<AnyLogin>, LiveSourceService<AnySchema>>>

/** "Only the write list is writable": MemberBlog's Post is read-only. */
const post = {
	id: "00000000-0000-0000-0000-000000000000",
	title: "t",
	body: "b",
	status: "Draft"
} as const
// @ts-expect-error -- refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
export const writePost = ChangeSet.empty(MemberBlog).insert(MemberPost, [post])

/** "Its states have no order, so it is `closed.unordered`: ... an `orderBy` of states is a type error". */
const invoiceStates = query(Invoices).rule((r) => {
	const { id, state } = v(Invoice, "invoice")
	return r.match(Invoice, { id, state }).find({ id, state })
})
export const statesInOrder = invoiceStates
	// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
	.orderBy(["state", "asc"])

/** "no state comes before another, and a comparison ... of states is a type error": a rule's filter. */
export const beforePaid = query(Invoices).rule((r) => {
	const { id, state } = v(Invoice, "invoice")
	return (
		r
			.match(Invoice, { id, state })
			// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
			.where(r.lt(state, "paid"))
			.find({ id })
	)
})

/** "no state comes before another": so no invoice's state is the greatest of its organization's. */
export const latestState = query(Invoices).rule((r) => {
	const { id, org, state } = v(Invoice, "invoice")
	return (
		r
			.match(Invoice, { id, org, state })
			// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
			.find({ org, latest: r.max(state) })
	)
})

/** "a comparison ... of states is a type error": a row check's comparison of its own field. */
export const stateCheck = check("PaidOrLater", Invoice, (i) =>
	// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
	i.ge(i.state, "paid")
)

/** "A query over the schema is a type error on a role that does not hold every table whole". */
// @ts-expect-error -- refused: a workload over MemberBlog holds programs over its levels, and published is over Blog
export const baseOnMember = workload(MemberBlog, { published })

/** "requires verify exactly when a role of the login reads a context". */
// @ts-expect-error -- refused: a role of the web login reads a context, so its layer needs verify
export const webWithoutVerify = DbLayer.make({
	...connection,
	login: WebServed,
	password: Redacted.make("secret"),
	pool: { max: 10 }
})

/** The gallery's types, as its prose states them. */
export type OrgKeysHead = Expect<
	Equals<HeadOf<typeof orgKeys>, { readonly digest: Sha256; readonly name: string }>
>

/** The dashboard login's committed workload, served as its type. */
declare const dashboardFile: unknown
const DashboardServed = served<typeof Dashboard>(dashboardFile, "dashboard")

/** "Opening a Db of key_admin through the dashboard's served login doesn't compile without a token". */
// @ts-expect-error -- refused: KeyAdmin reads a context, so Db.open requires a token
export const keyAdminWithoutToken = Db.open(DashboardServed.roles.key_admin, {})

export type TopModelsHead = Expect<
	Equals<
		HeadOf<typeof topModels>,
		{
			readonly workspace: string
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
	Equals<HeadOf<typeof treeSpend>, { readonly account: string; readonly spend: Decimal }>
>
export type TreeSpendParams = Expect<
	Equals<ParamsOf<typeof treeSpend>, { readonly root: ParamType<string, "text"> }>
>

export type InvoiceCardHead = Expect<
	Equals<
		HeadOf<typeof invoiceCard>,
		| {
				readonly id: string
				readonly state: "open"
				readonly payment: Option.None<{ readonly charge: string }>
				readonly voiding: Option.None<{ readonly reason: string }>
		  }
		| {
				readonly id: string
				readonly state: "paid"
				readonly payment: Option.Some<{ readonly charge: string }>
				readonly voiding: Option.None<{ readonly reason: string }>
		  }
		| {
				readonly id: string
				readonly state: "void"
				readonly payment: Option.None<{ readonly charge: string }>
				readonly voiding: Option.Some<{ readonly reason: string }>
		  }
	>
>

export type PayParams = Expect<
	Equals<
		ParamsOf<typeof pay>,
		{ readonly invoice: ParamType<string, "text">; readonly charge: ParamType<string, "text"> }
	>
>

export type CallLogHead = Expect<
	Equals<
		HeadOf<typeof callLog>,
		{
			readonly id: string
			readonly model: string
			readonly at: Infer<typeof Millis>
			readonly cost: Infer<typeof Micros>
		}
	>
>
export type FirstCalls = Expect<
	Equals<RowsOf<Effect.Success<ReturnType<typeof firstCalls>>>, HeadOf<typeof callLog>>
>
export type SpendOn = Expect<
	Equals<
		RowsOf<Effect.Success<ReturnType<typeof spendOn>>>,
		{ readonly calls: bigint; readonly spend: Decimal }
	>
>

/** Each rule's rows are a { show, sold } of its own; together they are exactly that row type, both ways. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type SoldHead = Expect<
	Same<HeadOf<typeof sold>, { readonly show: string; readonly sold: bigint }>
>
export type PublishParams = Expect<
	Equals<
		ParamsOf<typeof publish>,
		{ readonly org: ParamType<string, "text">; readonly slug: ParamType<string, "text"> }
	>
>

/** "the outcome's reads hold the count": on a role that writes Comment. */
const Moderator = role(Blog, "moderator", wholeEntriesOf(Blog), { write: ["Comment"] })
const moderation = workload(Moderator, { purge })
declare const moderator: Db<typeof Moderator, typeof moderation.programs>
export const purged = moderator.workload.purge.once({ params: { author: "user_1" }, facts: {} })
export type PurgedReads = Expect<
	Equals<
		Extract<Effect.Success<typeof purged>, { readonly kind: "accepted" }>["reads"],
		{ readonly removed: ReadonlyArray<{ readonly comments: bigint }> }
	>
>

/** "Types are sets of values": each field's TypeScript type follows from its declaration. */
export type PostSlugHost = Expect<Equals<Fact<typeof Post>["slug"], string>>
export type PostStatusHost = Expect<Equals<Fact<typeof Post>["status"], "Draft" | "Published">>
export type PostViewsHost = Expect<Equals<Fact<typeof PostViews>["views"], bigint>>
export type SubscriptionPlanHost = Expect<
	Equals<Fact<typeof Subscription>["plan"], "Free" | "Team">
>
export type SubscriptionSeatsHost = Expect<Equals<Fact<typeof Subscription>["seats"], bigint>>

/**
 * "once answers with an outcome you match on, accepted or unchanged; a rule's refusal is its error, refused, and a row
 * the role may not write is outsideWorld".
 */
export type LaunchOutcomeKind = Expect<
	Equals<Effect.Success<ReturnType<typeof launchOrg>>["kind"], "accepted" | "unchanged">
>
export type LaunchOutsideWorld = Expect<
	Equals<
		Extract<
			Effect.Error<ReturnType<typeof launchOrg>>,
			{ readonly kind: "outsideWorld" }
		>["relation"],
		string
	>
>

/**
 * "Each entry of refused.laws names a broken rule as you declared it, its law: entry.law.kind === "check" &&
 * entry.law.name === "WithinPlan"".
 */
type LaunchRefusal = Extract<
	Extract<Effect.Error<ReturnType<typeof launchOrg>>, { readonly kind: "refused" }>["refused"],
	{ readonly laws: unknown }
>["laws"][number]
export const overPlan = (entry: LaunchRefusal): boolean =>
	entry.law.kind === "check" && entry.law.name === "WithinPlan"

/** "A family's members are a type error, since their family statement writes them". */
export const debitMet = ChangeSet.empty(Credits)
	.insert(Debit, [])
	.read("met", (d) => {
		// @ts-expect-error -- refusal: delta.met names no family's members: their additions are their family statement's, which meets no stored fact at an arbiter key
		const met = d.met(Debit)
		return query(Credits).rule((r) => {
			const { call } = v(met, "met")
			return r.match(met, { call }).find({ debits: r.count() })
		})
	})
