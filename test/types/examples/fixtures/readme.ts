import assert from "node:assert/strict"
import net from "node:net"
import {
	accumulated,
	answered,
	ChangeSet,
	check,
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
	drawn,
	type Fact,
	fin,
	fold,
	generated,
	type HeadOf,
	type Infer,
	instant,
	key,
	Logic,
	login,
	mintOf,
	Monoid,
	mutable,
	natural,
	on,
	paged,
	type ParamsOf,
	type ParamType,
	pg,
	query,
	relation,
	role,
	schema,
	type Sha256,
	sha256,
	span,
	str,
	unit,
	v,
	variant,
	wholeEntriesOf,
	workload
} from "@bjornpagen/grizzle"
import { insertPreview } from "@bjornpagen/grizzle/compile"
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

// @ts-expect-error -- refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
ChangeSet.empty(Member).insert(OrgPost, [])

export default defineConfig({
	schemas: [Blog],
	logins: [Web],
	contracts: [],
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

/** "`feed`'s rows are `{ slug, author, title }`, each a string." */
export type FeedHead = Expect<
	Equals<
		HeadOf<typeof feed>,
		{ readonly slug: string; readonly author: string; readonly title: string }
	>
>
/** "`status` is `"draft" | "published"`." */
export type PostStatus = Expect<Equals<Fact<typeof Post>["status"], "draft" | "published">>

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

/** Close a task: a put of the task, done. */
export const closeTask = ChangeSet.empty(Tracker).put(Task, [])

export const TrackerApp = login(Tracker, "tracker", [Teammate], {
	workload: [workload(Teammate, { openTasks: answered(openTasks), closeTask })]
})

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

type TopModelsRow = {
	readonly workspace: string
	readonly spend: Decimal
	readonly models: ReadonlyArray<{
		readonly model: string
		readonly calls: bigint
		readonly spend: Decimal
	}>
}

export type TopModelsHead = Expect<Equals<HeadOf<typeof topModels>, TopModelsRow>>

query(Usage).rule((r) => {
	const { model, cost } = v(Call, "call")
	return (
		r
			.match(Call, { model, cost })
			// @ts-expect-error -- refusal: a sum reads each fact it matches once, by a key: bind a key of every source the rule matches, or match a query of the distinct values
			.find({ model, spend: r.sum(cost) })
	)
})

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

export const DriveReader = role(Drive, "drive_reader", wholeEntriesOf(Drive))
export const DriveApp = login(Drive, "drive", [DriveReader], {
	workload: [workload(DriveReader, { folderSizes: answered(folderSizes) })]
})

export type FolderSizesHead = Expect<
	Equals<HeadOf<typeof folderSizes>, { readonly folder: string; readonly bytes: Decimal }>
>
export type FolderSizesParams = Expect<
	Equals<ParamsOf<typeof folderSizes>, { readonly root: ParamType<string, "text"> }>
>

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

export const FrontDesk = role(Rooms, "front_desk", wholeEntriesOf(Rooms), { insert: ["Booking"] })
export const book = ChangeSet.empty(Rooms).insert(Booking, [])
export const RoomsApp = login(Rooms, "rooms", [FrontDesk], {
	workload: [workload(FrontDesk, { book })]
})

/** A role of its login's own name, which the login refuses as generate does. */
export const sameName = () =>
	// @ts-expect-error -- refusal: a login's roles are named apart from it: give the role or the login another name
	login(Rooms, "rooms", [role(Rooms, "rooms", wholeEntriesOf(Rooms))])

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

export const Meter = role(Credits, "meter", wholeEntriesOf(Credits), { insert: ["Debit"] })
export const MeteringApp = login(Credits, "metering", [Meter], {
	workload: [workload(Meter, { charge })]
})

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

export const Bookkeeper = role(Books, "bookkeeper", wholeEntriesOf(Books), {
	insert: ["Entry", "Posting"]
})
export const BooksApp = login(Books, "books", [Bookkeeper], {
	workload: [workload(Bookkeeper, { record })]
})

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

query(Invoices)
	.rule((r) => {
		const { id, status } = v(Invoice, "invoice")
		return r.match(Invoice, { id, status }).find({ id, status })
	})
	// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
	.orderBy(["status", "asc"])

check("PaidOrLater", Invoice, (i) =>
	// @ts-expect-error -- refusal: a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles
	i.ge(i.status, "paid")
)

export const Cashier = role(Invoices, "cashier", wholeEntriesOf(Invoices), { write: ["Invoice"] })
export const BillingApp = login(Invoices, "billing", [Cashier], {
	workload: [workload(Cashier, { invoice: answered(invoice), pay })]
})

export type InvoiceHead = Expect<
	Equals<
		HeadOf<typeof invoice>,
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

export const Gate = role(Auth, "gate", wholeEntriesOf(Auth), { insert: ["SignIn", "ApiKey"] })
export const AuthApp = login(Auth, "auth", [Gate], {
	workload: [workload(Gate, { signIn })]
})

export type ApiKeyDigest = Expect<Equals<Fact<typeof ApiKey>["digest"], Sha256>>

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

// @ts-expect-error -- refusal: a delete of a closed relation: its facts are inserted, never changed or deleted; declare it mutable inside a unit, or record the change as an inserted fact
ChangeSet.empty(Shop).delete(Order, [])

export const Clerk = role(Shop, "clerk", wholeEntriesOf(Shop), {
	insert: ["Order", "Cancelled"],
	write: ["CartLine"]
})
export const ShopApp = login(Shop, "shop", [Clerk], {
	workload: [workload(Clerk, { liveOrders: answered(liveOrders), cancel, setQuantity })]
})

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

export const Registrar = role(School, "registrar", wholeEntriesOf(School), {
	insert: ["Enrollment"]
})
export const Editor = role(Catalog, "editor", wholeEntriesOf(Catalog), { insert: ["Course"] })
export const SchoolApp = login(School, "school", [Registrar], {
	workload: [workload(Registrar, { myCourses: answered(myCourses) })]
})
export const CatalogApp = login(Catalog, "catalog", [Editor])

/** "only the holder of its key can make values of it". */
const price: Infer<typeof Micros> = toMicros(2_500_000n)

/** "A plain bigint is no Micros." */
// @ts-expect-error -- refused: a plain bigint is no value of a contract, which only its key's mint makes
const unpriced: Infer<typeof Micros> = 2_500_000n

export const prices = [price, unpriced] as const

/** A search indexer reads every post; it writes nothing. */
export const Indexer = login(Blog, "indexer", [role(Blog, "crawler", wholeEntriesOf(Blog))])

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
