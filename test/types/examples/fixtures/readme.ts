import assert from "node:assert/strict"
import net from "node:net"
import * as g from "@bjornpagen/grizzle"
import * as gCompile from "@bjornpagen/grizzle/compile"
import { Config, Effect, Result } from "effect"
import pgDriver from "pg"

/** The CA bundle the README's ./certs.ts exports. */
declare const caPem: string

type Equals<A, B> =
	(<X>(x: X) => X extends A ? 1 : 2) extends <X>(x: X) => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

/**
 * The README's program: every ```ts block of README.md that declares a schema, a role, a login, a workload, a query, a
 * ChangeSet or the configuration is below, in order, beside what the README leaves out (each example's login, so
 * `grizzle generate` compiles every program it shows) and the types and refusals its prose states, pinned. The
 * application's blocks, which read a served file, are readme.app.ts's. test/types/examples/blocks.test.ts holds every
 * README block to one of the two, line for line and in order; `pnpm typecheck` checks both; examples.test.ts checks
 * every refusal they state against the compiler's own text; and generates.test.ts runs `grizzle generate` over every
 * login this module exports, each program they serve the README's, and holds every ```sql block of the README to the
 * SQL it drafts. Importing it builds descriptions and runs the README's testing block, nothing else.
 */

/** Each field's type is a set of values, and PostgreSQL holds every row to it. */
const UserId = g.str.regex("^user_[0-9A-Za-z]{1,32}$")
const OrgId = g.str.regex("^org_[0-9A-Za-z]{1,32}$")
const Slug = g.str.regex("^[a-z0-9-]{1,64}$")
const Title = g.str.regex("^.{1,200}$", "su")
const Body = g.str.regex("^.*$", "su")

export const Status = g.closed.ordered("Status", ["draft", "published"])

/** A post, keyed by its organization and its slug: no surrogate id. */
export const Post = g.relation(
	"Post",
	{ org: OrgId, slug: Slug, author: UserId, title: Title, body: Body, status: g.closedId(Status) },
	["org", "slug"]
)

export const Blog = g.schema("Blog", [Status, Post], [])

/** Who is calling: the verified claims of their session token (Clerk's, here). */
export const Session = g.context("Session", { sub: UserId })
export const Org = g.context("Org", { id: OrgId }, { claim: "o" })

/** A member reads their organization's posts... */
const orgPosts = g.query(Blog).rule((r) => {
	const { org, slug, author, title, body, status } = g.v(Post, "post")
	return r
		.match(Post, { org, slug, author, title, body, status })
		.match(Org, { id: org })
		.find({ slug, author, title, body, status })
})

/** ...and writes posts as themselves, in their organization. */
const myPosts = g.query(Blog).rule((r) => {
	const { org, slug, author, title, body, status } = g.v(Post, "post")
	return r
		.match(Post, { org, slug, author, title, body, status })
		.match(Org, { id: org })
		.match(Session, { sub: author })
		.find({ slug, title, body, status })
})

export const Member = g.role(
	Blog,
	"member",
	{ Post: orgPosts, MyPost: myPosts },
	{ insert: ["MyPost"], contexts: [Session, Org] }
)

const { Post: OrgPost, MyPost } = Member.relations

export const feed = g.query(Member).rule((r) => {
	const { slug, author, title } = g.v(OrgPost, "post")
	return r
		.match(OrgPost, { slug, author, title, status: "published" })
		.find({ slug, author, title })
})

/** A new post: the caller's organization and user id fill `org` and `author`. */
export const write = g.ChangeSet.empty(Member).insert(MyPost, [])

/** The web app's login: the roles it opens and every program it runs. */
export const Web = g.login(Blog, "web", [Member], {
	workload: [g.workload(Member, { feed: g.answered(feed), write })]
})

// @ts-expect-error -- refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
g.ChangeSet.empty(Member).insert(OrgPost, [])

export default g.defineConfig({
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
			Effect.mapError((cause) => new g.CredentialError({ cause }))
		)
	})
})

/** "`feed`'s rows are `{ slug, author, title }`, each a string." */
export type FeedHead = Expect<
	Equals<
		g.HeadOf<typeof feed>,
		{ readonly slug: string; readonly author: string; readonly title: string }
	>
>
/** "`status` is `"draft" | "published"`." */
export type PostStatus = Expect<Equals<g.Fact<typeof Post>["status"], "draft" | "published">>

const ProjectKey = g.str.regex("^[A-Z]{2,8}$")

export const Task = g.relation(
	"Task",
	{ org: OrgId, project: ProjectKey, number: g.natural, title: Title, done: g.bool },
	["org", "project", "number"]
)
export const Tracker = g.schema("Tracker", [Task], [g.unit("Org", { org: OrgId }), g.mutable(Task)])

/** The organization the caller's token names. */
const callersOrg = g.query(Tracker).rule((r) => {
	const { id } = g.v(Org, "org")
	return r.match(Org, { id }).find({ org: id })
})

export const Teammate = g.role(Tracker, "teammate", g.wholeEntriesOf(Tracker), {
	write: ["Task"],
	contexts: [Org],
	scope: [callersOrg]
})

/** A project's open tasks. No organization in sight: the role's scope supplies it. */
export const openTasks = g.query(Tracker).rule((r) => {
	const { project, number, title } = g.v(Task, "task")
	return r
		.match(Task, { project, number, title, done: false })
		.where(r.eq(project, r.param("project", ProjectKey)))
		.find({ number, title })
})

/** Close a task: a put of the task, done. */
export const closeTask = g.ChangeSet.empty(Tracker).put(Task, [])

export const TrackerApp = g.login(Tracker, "tracker", [Teammate], {
	workload: [g.workload(Teammate, { openTasks: g.answered(openTasks), closeTask })]
})

const microsKey = Symbol("Micros")
const millisKey = Symbol("Millis")
/** Millionths of a dollar, never negative; milliseconds since the epoch. */
const Micros = g.domain<typeof microsKey>()("Micros", g.int8, (m) => g.Logic.ge(m, 0n))
const Millis = g.domain<typeof millisKey>()("Millis", g.int8)
const RequestId = g.str.regex("^req_[0-9A-Za-z]{1,64}$")
const Workspace = g.str.regex("^ws_[0-9a-z]{1,32}$")
const Model = g.str.regex("^[a-z0-9.-]{1,64}$")

/** One API call, keyed by the gateway's request id. */
export const Call = g.relation(
	"Call",
	{ id: RequestId, workspace: Workspace, model: Model, at: Millis, cost: Micros },
	["id"]
)
export const Usage = g.schema("Usage", [Call], [])

/** Each workspace's spend, with its three costliest models. */
export const topModels = g
	.query(Usage)
	.rule((r) => {
		const { id, workspace, cost } = g.v(Call, "call")
		return r.match(Call, { id, workspace, cost }).find({ workspace, spend: r.sum(cost) })
	})
	.attach(
		"models",
		(w) =>
			g
				.query(Usage)
				.rule((r) => {
					const { id, model, cost } = g.v(Call, "call")
					return r
						.match(Call, { id, workspace: w.workspace, model, cost })
						.find({ model, calls: r.count(), spend: r.sum(cost) })
				})
				.orderBy(["spend", "desc"])
				.take(3),
		"array"
	)

type TopModelsRow = {
	readonly workspace: string
	readonly spend: g.Numeric
	readonly models: ReadonlyArray<{
		readonly model: string
		readonly calls: bigint
		readonly spend: g.Numeric
	}>
}

export type TopModelsHead = Expect<Equals<g.HeadOf<typeof topModels>, TopModelsRow>>

g.query(Usage).rule((r) => {
	const { model, cost } = g.v(Call, "call")
	return (
		r
			.match(Call, { model, cost })
			// @ts-expect-error -- refusal: a sum reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values
			.find({ model, spend: r.sum(cost) })
	)
})

const FolderId = g.str.regex("^f_[0-9a-z]{1,24}$")

export const Folder = g.relation("Folder", { id: FolderId, name: Title }, ["id"])
/** A folder's parent: at most one, so the folders form trees. */
export const Parent = g.relation("Parent", { child: FolderId, parent: FolderId }, ["child"])
export const File = g.relation("File", { folder: FolderId, name: Title, bytes: g.natural }, [
	"folder",
	"name"
])
export const Drive = g.schema(
	"Drive",
	[Folder, Parent, File],
	[
		g.contained(g.on(Parent, "child"), g.on(Folder, "id")),
		g.contained(g.on(Parent, "parent"), g.on(Folder, "id")),
		g.contained(g.on(File, "folder"), g.on(Folder, "id"))
	]
)

/** A folder and every folder below it, at any depth. */
const subtree = g.query(Drive).recursive("Subtree", {
	row: { folder: FolderId },
	base: [
		(r) => {
			const { id } = g.v(Folder, "folder")
			return r
				.match(Folder, { id })
				.where(r.eq(id, r.param("root", FolderId)))
				.find({ folder: id })
		}
	],
	rec: [
		(r, self) => {
			const { folder } = g.v(self, "self")
			const { child } = g.v(Parent, "parent")
			return r
				.match(self, { folder })
				.match(Parent, { child, parent: folder })
				.find({ folder: child })
		}
	]
})

/** Bytes per folder under a root. */
export const folderSizes = g.query(Drive).rule((r) => {
	const tree = subtree.bind({ root: r.param("root", FolderId) })
	const { folder } = g.v(tree, "tree")
	const { name, bytes } = g.v(File, "file")
	return r
		.match(tree, { folder })
		.match(File, { folder, name, bytes })
		.find({ folder, bytes: r.sum(bytes) })
})

export const DriveReader = g.role(Drive, "drive_reader", g.wholeEntriesOf(Drive))
export const DriveApp = g.login(Drive, "drive", [DriveReader], {
	workload: [g.workload(DriveReader, { folderSizes: g.answered(folderSizes) })]
})

export type FolderSizesHead = Expect<
	Equals<g.HeadOf<typeof folderSizes>, { readonly folder: string; readonly bytes: g.Numeric }>
>
export type FolderSizesParams = Expect<
	Equals<g.ParamsOf<typeof folderSizes>, { readonly root: g.ParamType<string, "text"> }>
>

const minuteKey = Symbol("Minute")
/** Minutes since the epoch. */
const Minute = g.domain<typeof minuteKey>()("Minute", g.int8)
const RoomName = g.str.regex("^[A-Za-z0-9 -]{1,64}$")

export const Room = g.relation("Room", { name: RoomName }, ["name"])
/** When a room is open: a room's openings never overlap. */
export const Opening = g.relation("Opening", { room: RoomName, hours: g.range(Minute) }, [
	"room",
	"hours"
])
/** A booking: a room's bookings never overlap, and each is covered by the room's openings. */
export const Booking = g.relation(
	"Booking",
	{ room: RoomName, during: g.range(Minute), by: UserId },
	["room", "during"]
)
export const Rooms = g.schema(
	"Rooms",
	[Room, Opening, Booking],
	[
		g.contained(g.on(Opening, "room"), g.on(Room, "name")),
		g.contained(g.on(Booking, "room", "during"), g.on(Opening, "room", "hours"))
	]
)

export const FrontDesk = g.role(Rooms, "front_desk", g.wholeEntriesOf(Rooms), {
	insert: ["Booking"]
})
export const book = g.ChangeSet.empty(Rooms).insert(Booking, [])
export const RoomsApp = g.login(Rooms, "rooms", [FrontDesk], {
	workload: [g.workload(FrontDesk, { book })]
})

/** A role of its login's own name, which the login refuses as generate does. */
export const sameName = () =>
	// @ts-expect-error -- refusal: a login's roles are named apart from it: give the role or the login another name
	g.login(Rooms, "rooms", [g.role(Rooms, "rooms", g.wholeEntriesOf(Rooms))])

const toMicros = g.mintOf(microsKey)
const PaymentId = g.str.regex("^pi_[0-9A-Za-z]{1,64}$")

export const Grant = g.relation(
	"Grant",
	{
		id: PaymentId,
		amount: Micros,
		debits: g.drawn(g.natural),
		spent: g.accumulated(Micros, toMicros(0n), microsKey)
	},
	["id"]
)
export const Debit = g.relation("Debit", { call: RequestId, grant: PaymentId, amount: Micros }, [
	"call"
])

const grantDebits = g.counted(g.on(Debit, "grant"), g.fin(Grant, "debits"))

export const Credits = g.schema(
	"Credits",
	[Grant, Debit],
	[
		grantDebits,
		g.fold(grantDebits, g.Monoid.sum, g.on(Debit, "grant", "amount"), g.on(Grant, "id", "spent")),
		g.check("WithinGrant", Grant, (g1) => g1.le(g1.spent, g1.amount)),
		g.unit("Grant", { id: PaymentId }),
		g.mutable(Grant)
	]
)

export const charge = g.ChangeSet.empty(Credits).insert(Debit, [])

export const Meter = g.role(Credits, "meter", g.wholeEntriesOf(Credits), { insert: ["Debit"] })
export const MeteringApp = g.login(Credits, "metering", [Meter], {
	workload: [g.workload(Meter, { charge })]
})

const Account = g.str.regex("^[a-z][a-z_]{0,63}$")
const EntryId = g.str.regex("^JE-[0-9]{1,12}$")

export const Entry = g.relation(
	"Entry",
	{ id: EntryId, memo: Title, postings: g.drawn(g.natural), total: g.accumulated(g.int8, 0n) },
	["id"]
)
export const Posting = g.relation("Posting", { entry: EntryId, account: Account, amount: g.int8 }, [
	"entry",
	"account"
])

const entryPostings = g.counted(g.on(Posting, "entry"), g.fin(Entry, "postings"))

export const Books = g.schema(
	"Books",
	[Entry, Posting],
	[
		entryPostings,
		g.fold(
			entryPostings,
			g.Monoid.sum,
			g.on(Posting, "entry", "amount"),
			g.on(Entry, "id", "total")
		),
		g.check("Balanced", Entry, (e) => e.eq(e.total, 0n))
	]
)

export const record = g.ChangeSet.empty(Books).insert(Entry, []).insert(Posting, [])

export const Bookkeeper = g.role(Books, "bookkeeper", g.wholeEntriesOf(Books), {
	insert: ["Entry", "Posting"]
})
export const BooksApp = g.login(Books, "books", [Bookkeeper], {
	workload: [g.workload(Bookkeeper, { record })]
})

const InvoiceId = g.str.regex("^in_[0-9A-Za-z]{1,64}$")
const ChargeId = g.str.regex("^ch_[0-9A-Za-z]{1,64}$")

export const InvoiceStatus = g.closed.unordered("InvoiceStatus", ["open", "paid", "void"])
/** An invoice is open, paid by a charge, or void for a reason. */
export const InvoiceState = g.variant("InvoiceState", InvoiceStatus, {
	open: {},
	paid: { charge: ChargeId },
	void: { reason: Title }
})
export const Invoice = g.relation.generated(
	"Invoice",
	{ id: InvoiceId, org: OrgId, state: InvoiceState },
	["id"],
	(i) => ({ status: g.generated(g.closedId(InvoiceStatus), InvoiceState.tag(i.state)) })
)
export const Invoices = g.schema(
	"Invoices",
	[InvoiceStatus, Invoice],
	[g.unit("Invoice", { id: InvoiceId }), g.mutable(Invoice)]
)

export const invoice = g.query(Invoices).rule((r) => {
	const { id, state } = g.v(Invoice, "invoice")
	return r
		.match(Invoice, { id, state })
		.where(r.eq(id, r.param("id", InvoiceId)))
		.find({ id, state })
})

/** Pay an open invoice: its state becomes `paid`, carrying the charge. */
export const pay = g.ChangeSet.empty(Invoices).put(
	Invoice,
	g.query(Invoices).rule((r) => {
		const { org } = g.v(Invoice, "invoice")
		return r.match(Invoice, { id: r.param("invoice", InvoiceId), org, status: "open" }).find({
			id: r.param("invoice", InvoiceId),
			org,
			state: InvoiceState.make("paid", { charge: r.param("charge", ChargeId) })
		})
	})
)

g.query(Invoices)
	.rule((r) => {
		const { id, status } = g.v(Invoice, "invoice")
		return r.match(Invoice, { id, status }).find({ id, status })
	})
	// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
	.orderBy(["status", "asc"])

g.check("PaidOrLater", Invoice, (i) =>
	// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
	i.ge(i.status, "paid")
)

export const Cashier = g.role(Invoices, "cashier", g.wholeEntriesOf(Invoices), {
	write: ["Invoice"]
})
export const BillingApp = g.login(Invoices, "billing", [Cashier], {
	workload: [g.workload(Cashier, { invoice: g.answered(invoice), pay })]
})

export type InvoiceHead = Expect<
	Equals<
		g.HeadOf<typeof invoice>,
		{
			readonly id: string
			readonly state:
				| { readonly tag: "open" }
				| { readonly tag: "paid"; readonly charge: string }
				| { readonly tag: "void"; readonly reason: string }
		}
	>
>

/** A sign-in: the user, and the instant the database stamped it at. */
export const SignIn = g.relation("SignIn", { user: UserId, at: g.instant }, ["user", "at"])
/** An API key, keyed by the SHA-256 of its secret: the table never holds the secret. */
export const ApiKey = g.relation("ApiKey", { org: OrgId, digest: g.sha256, name: Title }, [
	"org",
	"digest"
])
export const Auth = g.schema("Auth", [SignIn, ApiKey], [g.key(g.on(ApiKey, "digest"))])

export const signIn = g.ChangeSet.empty(Auth).insert(
	SignIn,
	g.query(Auth).rule((r) => r.find({ user: r.param("user", UserId) }))
)

export const Gate = g.role(Auth, "gate", g.wholeEntriesOf(Auth), { insert: ["SignIn", "ApiKey"] })
export const AuthApp = g.login(Auth, "auth", [Gate], {
	workload: [g.workload(Gate, { signIn })]
})

export type ApiKeyDigest = Expect<Equals<g.Fact<typeof ApiKey>["digest"], g.Sha256>>

const OrderId = g.str.regex("^ord_[0-9A-Za-z]{1,32}$")

/** An order, and its cancellation: two facts, each inserted once. */
export const Order = g.relation("Order", { id: OrderId, customer: UserId, total: Micros }, ["id"])
export const Cancelled = g.relation("Cancelled", { order: OrderId, reason: Title }, ["order"])

/** A cart's lines change until checkout: open, inside the cart's unit. */
export const CartLine = g.relation("CartLine", { cart: UserId, sku: Slug, quantity: g.natural }, [
	"cart",
	"sku"
])

export const Shop = g.schema(
	"Shop",
	[Order, Cancelled, CartLine],
	[
		g.contained(g.on(Cancelled, "order"), g.on(Order, "id")),
		g.unit("Cart", { cart: UserId }),
		g.mutable(CartLine)
	]
)

/** Orders still live: the ones with no cancellation. */
export const liveOrders = g.query(Shop).rule((r) => {
	const { id, customer, total } = g.v(Order, "order")
	return r
		.match(Order, { id, customer, total })
		.where(r.not(Cancelled, { order: id }))
		.find({ id, customer, total })
})

export const cancel = g.ChangeSet.empty(Shop).insert(Cancelled, [])
export const setQuantity = g.ChangeSet.empty(Shop).put(CartLine, [])

// @ts-expect-error -- refusal: a delete of a closed relation: its facts are inserted, never changed or deleted; declare it mutable inside a unit, or record the change as an inserted fact
g.ChangeSet.empty(Shop).delete(Order, [])

export const Clerk = g.role(Shop, "clerk", g.wholeEntriesOf(Shop), {
	insert: ["Order", "Cancelled"],
	write: ["CartLine"]
})
export const ShopApp = g.login(Shop, "shop", [Clerk], {
	workload: [g.workload(Clerk, { liveOrders: g.answered(liveOrders), cancel, setQuantity })]
})

/** A workspace's calls, newest first. */
export const callLog = g
	.query(Usage)
	.rule((r) => {
		const { id, model, at, cost } = g.v(Call, "call")
		return r
			.match(Call, { id, workspace: r.param("workspace", Workspace), model, at, cost })
			.find({ id, model, at, cost })
	})
	.orderBy(["at", "desc"])

/** Calls and spend per workspace and model: a query you read like a table. */
export const ModelSpend = g.derived(
	"ModelSpend",
	g.query(Usage).rule((r) => {
		const { id, workspace, model, cost } = g.v(Call, "call")
		return r
			.match(Call, { id, workspace, model, cost })
			.find({ workspace, model, calls: r.count(), spend: r.sum(cost) })
	})
)
export const Reporting = g.schema.extend([Usage], "Reporting", [ModelSpend], [])

export const spendByModel = g.query(Reporting).rule((r) => {
	const { model, calls, spend } = g.v(ModelSpend, "row")
	return r
		.match(ModelSpend, { workspace: r.param("workspace", Workspace), model, calls, spend })
		.find({ model, calls, spend })
})

export const Analyst = g.role(Reporting, "analyst", g.wholeEntriesOf(Reporting))
export const UsageApi = g.login(Reporting, "usage_api", [Analyst], {
	workload: [
		g.workload(Analyst, {
			callLog: g.answered(g.paged(callLog)),
			topModels: g.answered(topModels),
			spendByModel: g.answered(spendByModel)
		})
	]
})

/** A course catalog, maintained on its own... */
export const Course = g.relation("Course", { slug: Slug, title: Title }, ["slug"])
export const Catalog = g.schema("Catalog", [Course], [])

/** ...and enrollments over it: each enrollment's course is one the catalog holds. */
export const Enrollment = g.relation("Enrollment", { student: UserId, course: Slug }, [
	"student",
	"course"
])
export const School = g.schema.extend(
	[Catalog],
	"School",
	[Enrollment],
	[g.contained(g.on(Enrollment, "course"), g.on(Course, "slug"))]
)

/** A student's courses, with their titles: one query across both levels. */
export const myCourses = g.query(School).rule((r) => {
	const { course } = g.v(Enrollment, "enrollment")
	const { title } = g.v(Course, "c")
	return r
		.match(Enrollment, { student: r.param("student", UserId), course })
		.match(Course, { slug: course, title })
		.find({ course, title })
})

export const Registrar = g.role(School, "registrar", g.wholeEntriesOf(School), {
	insert: ["Enrollment"]
})
export const Editor = g.role(Catalog, "editor", g.wholeEntriesOf(Catalog), { insert: ["Course"] })
export const SchoolApp = g.login(School, "school", [Registrar], {
	workload: [g.workload(Registrar, { myCourses: g.answered(myCourses) })]
})
export const CatalogApp = g.login(Catalog, "catalog", [Editor])

/** "only the holder of its key can make values of it". */
const price: g.Infer<typeof Micros> = toMicros(2_500_000n)

/** "A plain bigint is no Micros." */
// @ts-expect-error -- refused: a plain bigint is no value of a contract, which only its key's mint makes
const unpriced: g.Infer<typeof Micros> = 2_500_000n

export const prices = [price, unpriced] as const

/** A search indexer reads every post; it writes nothing. */
export const Indexer = g.login(Blog, "indexer", [g.role(Blog, "crawler", g.wholeEntriesOf(Blog))])

const preview = Result.getOrThrow(gCompile.insertPreview(Books))
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
