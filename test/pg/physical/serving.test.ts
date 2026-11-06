import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Equal, Formatter, Order, Result } from "effect"
import type { TestContext } from "vitest"
import { isCompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { codeOf, emptyCodebook } from "#compiler/ir/codes.ts"
import type { AccessUse } from "#compiler/ir/products.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { workload } from "#compiler/program/workload/value.ts"
import {
	drawnRequests,
	everyRow,
	judgeServing,
	loadAtVolume,
	type PlannedShape,
	planShape,
	type RequestSpec,
	rosterDomainSql,
	type ServingFeature,
	specText,
	type VolumeLoad
} from "#test/pg/physical/serving.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import {
	contained,
	eq,
	f,
	field as fieldRef,
	key,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installRealSchema, planRealInstall } from "#test/support/oracle/install/real.ts"
import { unperturbed } from "#test/support/oracle/perturb.ts"
import { buildMixed, buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type CaseSketch,
	caseSketchGen,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import type { ProgramCase, FieldKind } from "#test/support/oracle/public/program.ts"
import { spread } from "#test/support/plans.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Index serving judged by PostgreSQL, over generated schemas and workloads and over drawn index requests, at volume.
 *
 * The index engine (physical/indexes/engine.ts) claims, for every request it plans, an index that serves it, and it
 * creates an index only for a request nothing installed serves. PostgreSQL is the judge of both claims (serving.ts):
 * every request's probe must run through an index the installation planned, with an index condition, one descent, no
 * filtered row, no sort and a bounded count of touched buffers, and every created index must be needed, some request it
 * holds going unserved once it is dropped. The serving rule is never restated here.
 *
 * Three populations, each installed by the fresh-install compiler and loaded at volume (serving.ts volumeRows):
 *
 * - Generated workloads. A program of the public-boundary generator (test/support/oracle/public) is a schema and its
 *   reads; its reads are the workload, compiled by the workload compiler and installed with the access paths its extraction
 *   draws (physical/access/extract.ts). Every field of a relation's keys holds the series itself, so keys stay
 *   distinct, and every other field the series spread over 141 values, so one field alone selects about 140 rows and
 *   two select about one: an index on a column the probe does not fix first is told from one that serves it. A relation
 *   whose key admits fewer rows (its key fields closed handles, say) holds as many as its key admits, too few for any
 *   index to tell from a scan, and is not judged (serving.ts). A workload whose access path PostgreSQL could not index
 *   (an unbounded text or numeric key) is refused as UnrepresentableKey, a named outcome. Its kept cases: an equality
 *   lookup on a boolean key column, whose answer is half its relation, beside a span predicate that a GiST index led by
 *   a closed id, then a numeric of many values the predicate leaves unbound, does not serve; and a join key on a key column
 *   and a column of many values, beside span predicates whose GiST index holds both after its lead, which PostgreSQL
 *   sweeps for the join key, a residue no plan the engine makes avoids (serving.ts), and which drawn workloads reach
 *   about once in 200 cases.
 * - Drawn requests. A fixed schema holds a plain table, a span key's GiST index (Booking, on room and during), a
 *   selected side's unique (at most one remainder deposit per line) beside a foreign key on its column, and the engine is
 *   handed drawn requests on it: workload B-tree requests of every use, law probes of every row or of a flag's selected
 *   rows, and GiST span predicates on during with any of Booking's scalars. Its kept cases plant the requests a
 *   planner is tempted to serve wrongly: an equality pair beside a range over the same two columns in the other order,
 *   which one index serves; a law probe of the remainder deposits on line, the selected side's own selection;
 *   a descending key lookup beside a law probe of a flag's rows on the same column, which the lookup's index of every
 *   row serves, so no partial index belongs beside it; and law probes of the held bookings on (room, id), on id and on
 *   room, whose partial index on (id, room) PostgreSQL sweeps for the probe on room, a residue no plan the engine makes
 *   avoids (serving.ts).
 * - Shared columns. Two to four equality lookups and seeks over the same three columns of Event, each column drawn in
 *   any position and direction, are planned in every order they can arrive in, and the plan must be one list of
 *   indexes: the engine plans in its canonical order, and chooses each created index's key order to serve every later
 *   request over its columns that one order can serve with it. The first order is then installed and judged as above.
 *   Beside drawn sets it draws two seeks over the same columns in reverse orders, and an equality lookup beside a seek
 *   over some or all of its columns, each among up to two other requests.
 *
 * A field's value on row g (see the header): `value` the series or its spread, `key` whether the field lies in a key.
 *
 * At most two code points, as the generated text field admits: two CJK ideographs name a million keys.
 */
const fieldSql = (
	kind: FieldKind,
	value: string,
	key: boolean,
	salt: number,
	handle: (v: string) => string
): string => {
	switch (kind) {
		case "int2":
			return `((${value}) % 32768)::int2`
		case "int4":
			return `(${value})::int4`
		case "int8":
		case "tick":
			return `(${value})::int8`
		case "fixed":
			return `((${value})::numeric / 100)`
		case "numeric":
			return `((${value})::numeric / 7)`
		case "float4":
			return `((${value})::float4 / 8)`
		case "float8":
			return `((${value})::float8 / 8)`
		case "money":
			return `((${value})::numeric / 100)::money`
		case "bool":
			return `((${value}) % 2 = 0)`
		case "text":
			return key
				? `chr(19968 + ((${value}) / 1000 % 1000)::int4) || chr(19968 + ((${value}) % 1000)::int4)`
				: `chr(19968 + (${value})::int4)`
		case "prose":
			return `'p' || (${value})::text`
		case "uuid":
			return `md5('${salt}:' || (${value})::text)::uuid`
		case "handle":
			return handle(value)
		case "span4":
			return `int4range(((${value}) * 10)::int4, ((${value}) * 10 + 5)::int4)`
		case "span8":
			return `int8range((${value})::int8 * 10, (${value})::int8 * 10 + 5)`
		case "vector":
			return key
				? `ARRAY[((${value})::int8 % 1000)::real, ((${value})::int8 / 1000 % 1000)::real, ((${value})::int8 / 1000000 % 1000 + 1)::real]::real[]`
				: `ARRAY[((${value}) % 1000)::real, 1, 0]::real[]`
	}
}

type WorkloadFeature = "a workload installed" | "a workload refused for an unrepresentable key"

/** The generated case's reads as a workload, installed, loaded and judged. */
const workloadCase = (c: ProgramCase, note: (feature: ServingFeature | WorkloadFeature) => void) =>
	Effect.gen(function* () {
		const built = buildSchema(c.schema)
		const programs: Record<string, unknown> = {}
		for (const [at, read] of c.reads.entries()) {
			switch (read.kind) {
				case "query":
					programs[`read${at}`] = buildRoot(built, built.schema, read.query)
					break
				case "mixed":
					programs[`read${at}`] = buildMixed(built, built.schema, read.root)
					break
				case "key":
				case "handle":
					break
			}
		}
		const plan = compileTestWorkload(
			[{ login: "server", workloads: [workload(built.schema, programs)] }],
			built.schema,
			testCompile
		)
		if (!plan.ok) {
			return assert.fail(`the workload does not compile: ${plan.error.message}\n${printCase(c)}`)
		}
		const installed = yield* Effect.result(
			installRealSchema(built.schema, {
				label: "serving_workload",
				logins: [],
				extensions: [workloadExtension(plan.value)]
			})
		)
		if (Result.isFailure(installed)) {
			const e = installed.failure
			if (isCompileError(e) && e.reason._tag === "UnrepresentableKey") {
				note("a workload refused for an unrepresentable key")
				return
			}
			return assert.fail(`the workload does not install: ${String(e)}\n${printCase(c)}`)
		}
		note("a workload installed")
		const judged = installed.success.plan
		const domain = rosterDomainSql(judged, c.schema.roster.name)
		const codec = defined(
			judged.installation.names.codes.rosters.get(parsedName(c.schema.roster.name)),
			"the installation's codes of the case's roster"
		)
		const codes = Arr.join(
			Arr.map(c.schema.roster.handles, (h) => String(codeOf(codec, h))),
			", "
		)
		const handle = (v: string): string =>
			`(ARRAY[${codes}]::int2[])[1 + ((${v}) % ${c.schema.roster.handles.length})::int4]::${domain}`
		let salt = 0
		const loads = Arr.map(c.schema.relations, (r): VolumeLoad => {
			const keyed = new Set(
				Arr.flatMap([r.primaryKey, ...r.candidates], (k) => Arr.map(k, (field) => field.name))
			)
			return {
				relation: r.name,
				fields: Arr.map(r.fields, (field) => {
					salt += 1
					const key = keyed.has(field.name)
					return [
						field.name,
						fieldSql(field.kind, key ? "g" : spread(salt, 141), key, salt, handle)
					] as const
				})
			}
		})
		yield* loadAtVolume(judged, loads)
		const problems = yield* judgeServing(judged, () => everyRow, note)
		assert.deepEqual(
			problems,
			[],
			`PostgreSQL serves every request and needs every created index\n${printCase(c)}`
		)
	})

/**
 * Event: a plain table under its primary key. Booking: a span key, so a GiST index on (room, during) whose room column
 * btree_gist serves by equality. Line and Deposit: a foreign key on Deposit's line beside a unique over its remainder
 * deposits' lines (at most one per line), which its primary key (account, line) cannot serve. Each holds a boolean a
 * law's selection reads.
 */
const Indexed: SchemaDesc = {
	name: "Indexed",
	relations: [
		relation(
			"Event",
			{
				id: f.uuid,
				tenant: f.uuid,
				account: f.uuid,
				created: f.bigint,
				unrelated: f.bigint,
				live: f.boolean
			},
			["id"]
		),
		relation(
			"Booking",
			{ room: f.uuid, during: f.span(f.integer, undefined), id: f.uuid, held: f.boolean },
			["room", "during"]
		),
		relation("Line", { id: f.uuid }, ["id"]),
		relation("Deposit", { line: f.uuid, account: f.uuid, remainder: f.boolean }, [
			"account",
			"line"
		])
	],
	statements: [
		contained(on("Deposit", ["line"]), on("Line", ["id"])),
		key(onWhere("Deposit", ["line"], eq(fieldRef("remainder"), literal(true))))
	],
	extends: undefined
}

/**
 * Line first, so each deposit's line exists; one deposit per line, so at most one remainder per line; bookings never
 * overlap at all, so every room's spans are disjoint; a booking's id, which no key holds, spread like any other field,
 * so no index on it finds one row the schema does not promise.
 */
const indexedLoads: ReadonlyArray<VolumeLoad> = [
	{ relation: "Line", fields: [["id", "md5('line:' || g)::uuid"]] },
	{
		relation: "Deposit",
		fields: [
			["line", "md5('line:' || g)::uuid"],
			["account", `md5('account:' || ${spread(1, 141)})::uuid`],
			["remainder", "(g % 2 = 0)"]
		]
	},
	{
		relation: "Event",
		fields: [
			["id", "md5('event:' || g)::uuid"],
			["tenant", `md5('tenant:' || ${spread(2, 141)})::uuid`],
			["account", `md5('account:' || ${spread(3, 141)})::uuid`],
			["created", spread(4, 141)],
			["unrelated", spread(5, 141)],
			["live", "(g % 2 = 0)"]
		]
	},
	{
		relation: "Booking",
		fields: [
			["room", `md5('room:' || ${spread(6, 141)})::uuid`],
			["during", "int4range(g * 10, g * 10 + 5)"],
			["id", `md5('booking:' || ${spread(7, 141)})::uuid`],
			["held", "(g % 2 = 0)"]
		]
	}
]

/** The relations a drawn B-tree request keys, with the columns it may key and the boolean a law's selection reads. */
const keyed = ["Event", "Booking", "Deposit"] as const
type Keyed = (typeof keyed)[number]
const columnsOf: Readonly<Record<Keyed, Arr.NonEmptyReadonlyArray<string>>> = {
	Event: ["tenant", "account", "created", "unrelated", "id"],
	Booking: ["room", "id"],
	Deposit: ["line", "account"]
}

const flagOf: Readonly<Record<Keyed, string>> = {
	Event: "live",
	Booking: "held",
	Deposit: "remainder"
}

const btreeUses = [
	"key lookup",
	"equality lookup",
	"join key",
	"write target",
	"range",
	"prefix search",
	"take seek",
	"page seek"
] as const satisfies ReadonlyArray<AccessUse>
type BtreeUse = (typeof btreeUses)[number]
const spanScalars = ["room", "id"] as const
type SpanScalar = (typeof spanScalars)[number]

/**
 * A drawn request, by what it asks: a workload B-tree access, a law's probe of every row or of a flag's rows, or a GiST
 * span predicate on during with Booking's scalars before it. Each names the relation, the columns and the use it draws.
 */
interface KeySketch<C extends string> {
	readonly column: C
	readonly desc: boolean
}

type Intent =
	| {
			readonly kind: "access"
			readonly relation: Keyed
			readonly keys: Arr.NonEmptyReadonlyArray<KeySketch<string>>
			readonly use: BtreeUse
	  }
	| {
			readonly kind: "law"
			readonly relation: Keyed
			readonly keys: Arr.NonEmptyReadonlyArray<KeySketch<string>>
			readonly rows: "every row" | "flag true" | "flag false"
	  }
	| { readonly kind: "span predicate"; readonly scalars: ReadonlyArray<SpanScalar> }

/** One to three keys over `columns`, a column possibly repeated (a request keys each once). */
const keysGen =
	<C extends string>(
		columns: Arr.NonEmptyReadonlyArray<C>
	): Gen<Arr.NonEmptyReadonlyArray<KeySketch<C>>> =>
	(source) => {
		const key: Gen<KeySketch<C>> = (drawing) => ({
			column: drawing.draw(element(columns)),
			desc: drawing.draw(boolean)
		})
		return [source.draw(key), ...source.draw(array(key, { min: 0, max: 2 }))]
	}

const intentGen: Gen<Intent> = weighted<Intent>([
	[
		3,
		(source) => {
			const relation = source.draw(element(keyed))
			return {
				kind: "access",
				relation,
				keys: source.draw(keysGen(columnsOf[relation])),
				use: source.draw(element(btreeUses))
			}
		}
	],
	[
		2,
		(source) => {
			const relation = source.draw(element(keyed))
			return {
				kind: "law",
				relation,
				keys: source.draw(keysGen(columnsOf[relation])),
				rows: source.draw(element(["every row", "flag true", "flag false"] as const))
			}
		}
	],
	[
		1,
		(source) => ({
			kind: "span predicate",
			scalars: source.draw(array(element(spanScalars), { min: 0, max: 2 }))
		})
	]
])
const intentsGen = array(intentGen, { min: 1, max: 6 })

/** A request's keys: the columns the sketch names, each once, in its order. */
const keysFor = (
	keys: Arr.NonEmptyReadonlyArray<KeySketch<string>>
): Arr.NonEmptyReadonlyArray<{ readonly field: string; readonly dir: "asc" | "desc" }> => {
	const key = (k: KeySketch<string>) => ({
		field: k.column,
		dir: k.desc ? ("desc" as const) : ("asc" as const)
	})
	const [first, ...rest] = keys
	const out: Arr.NonEmptyArray<{ readonly field: string; readonly dir: "asc" | "desc" }> = [
		key(first)
	]
	for (const k of rest) {
		const next = key(k)
		if (Arr.every(out, (o) => o.field !== next.field)) {
			out.push(next)
		}
	}
	return out
}

/** One intent's request as the suite states it (serving.ts RequestSpec). */
const resolveIntent = (intent: Intent): RequestSpec => {
	switch (intent.kind) {
		case "access":
			return {
				kind: "access",
				relation: intent.relation,
				use: intent.use,
				keys: keysFor(intent.keys)
			}
		case "law": {
			const field = flagOf[intent.relation]
			return {
				kind: "law",
				relation: intent.relation,
				keys: Arr.map(keysFor(intent.keys), (k) => k.field),
				rows:
					intent.rows === "every row"
						? everyRow
						: { kind: "selected", where: [{ field, value: intent.rows === "flag true" }] }
			}
		}
		case "span predicate": {
			const scalars = Arr.dedupe(intent.scalars)
			return {
				kind: "access",
				relation: "Booking",
				use: "span predicate",
				keys: Arr.append(
					Arr.map(scalars, (field) => ({ field, dir: "asc" as const })),
					{ field: "during", dir: "asc" as const }
				)
			}
		}
	}
}

const resolveIntents = (intents: ReadonlyArray<Intent>): ReadonlyArray<RequestSpec> =>
	Arr.map(intents, resolveIntent)

type RequestFeature = "a law probe of selected rows" | "a span predicate on during alone"

/** A planted access request: ascending keys over `columns` of `relation`, for `use`. */
const accessIntent = (
	relation: Keyed,
	columns: Arr.NonEmptyReadonlyArray<string>,
	use: BtreeUse
): Intent => ({
	kind: "access",
	relation,
	keys: Arr.map(columns, (column) => ({ column, desc: false })),
	use
})

const requestKept: ReadonlyArray<Kept<ReadonlyArray<Intent>, ServingFeature | RequestFeature>> = [
	{
		note: "an equality pair on (account, created) beside a range on created then account",
		sketch: [
			accessIntent("Event", ["account", "created"], "equality lookup"),
			accessIntent("Event", ["created", "account"], "range")
		],
		draws: "",
		reaches: ["range probe served"]
	},
	{
		note: "a law probe of the remainder deposits on line, the selected side's own selection",
		sketch: [
			{
				kind: "law",
				relation: "Deposit",
				keys: [{ column: "line", desc: false }],
				rows: "flag true"
			}
		],
		draws: "",
		reaches: ["a law probe of selected rows"]
	},
	{
		note: "a key lookup on unrelated descending beside a law probe of the live rows on unrelated, which its index of every row serves",
		sketch: [
			{
				kind: "access",
				relation: "Event",
				keys: [{ column: "unrelated", desc: true }],
				use: "key lookup"
			},
			{
				kind: "law",
				relation: "Event",
				keys: [{ column: "unrelated", desc: false }],
				rows: "flag true"
			}
		],
		draws: "",
		reaches: [
			"a law probe of selected rows",
			"equality probe served",
			"served by a created index",
			"a created index needed"
		]
	},
	{
		note: "law probes of the held bookings on (room, id), on id and on room, whose partial index on (id, room) PostgreSQL sweeps for the probe on room rather than fetch the heap through the span key's GiST index of every row",
		sketch: Arr.map([["room", "id"], ["id"], ["room"]] as const, (columns): Intent => ({
			kind: "law",
			relation: "Booking",
			keys: Arr.map(columns, (column) => ({ column, desc: false })),
			rows: "flag true"
		})),
		draws: "",
		reaches: [
			"read through another planned index than the engine's",
			"swept through another partial B-tree, skip-scan costing it below the heap an index of every row fetches",
			"a created index needed"
		]
	}
]

/** The drawn requests on Indexed, installed, loaded and judged. */
const requestCase = (
	intents: ReadonlyArray<Intent>,
	note: (feature: ServingFeature | RequestFeature) => void
) =>
	Effect.gen(function* () {
		const specs = resolveIntents(intents)
		for (const spec of specs) {
			if (spec.kind === "law" && spec.rows.kind === "selected") {
				note("a law probe of selected rows")
			}
			if (spec.kind === "access" && spec.use === "span predicate" && spec.keys.length === 1) {
				note("a span predicate on during alone")
			}
		}
		const drawn = drawnRequests(specs)
		const { plan } = yield* installRealSchema(Indexed, {
			label: "serving_requests",
			logins: [],
			extensions: [drawn.extension]
		})
		yield* loadAtVolume(plan, indexedLoads)
		const problems = yield* judgeServing(plan, drawn.rowsOf, note)
		assert.deepEqual(
			problems,
			[],
			`PostgreSQL serves every request and needs every created index: ${Arr.join(Arr.map(specs, specText), "; ")}`
		)
	})

/**
 * Requests over the same three columns of Event, each a workload B-tree access whose need takes its columns as a set (an
 * equality lookup) or in order with their directions (a take seek), so that one created index may serve several of them
 * in one key order, or no one order serves two of them. A range is not drawn here: its probe bounds the range column at
 * one value on both sides (serving.ts), which PostgreSQL serves through either order of two columns.
 */
const sharedColumns = ["tenant", "account", "created"] as const
type SharedColumn = (typeof sharedColumns)[number]
const sharedUses = ["equality lookup", "take seek"] as const satisfies ReadonlyArray<AccessUse>
type SharedUse = (typeof sharedUses)[number]

interface SharedSketch {
	readonly keys: Arr.NonEmptyReadonlyArray<KeySketch<SharedColumn>>
	readonly use: SharedUse
}
const sharedGen: Gen<SharedSketch> = (source) => ({
	keys: source.draw(keysGen(sharedColumns)),
	use: source.draw(element(sharedUses))
})

/** One sketch's request: the shared columns it names, each once, in its order. */
const resolveShared = (sketch: SharedSketch): RequestSpec => ({
	kind: "access",
	relation: "Event",
	use: sketch.use,
	keys: keysFor(sketch.keys)
})

/** Every order of a list. */
const arrivals = <A>(xs: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	xs.length <= 1
		? [xs]
		: Arr.flatMap(xs, (x, i) =>
				Arr.map(arrivals([...xs.slice(0, i), ...xs.slice(i + 1)]), (r) => [x, ...r])
			)

type SharedFeature =
	| "an equality lookup beside an order over its columns"
	| "a wider equality lookup beside a narrower order over its columns"
	| "a narrower request beside a wider one over its columns"
	| "one index serving requests of two needs"
	| "two indexes on one column set"

const fieldsOf = (spec: RequestSpec): ReadonlyArray<string> =>
	spec.kind === "access" ? Arr.map(spec.keys, (k) => k.field) : spec.keys

/** What a request set holds (see SharedFeature), judged on the specs alone. */
const sharedNotes = (
	specs: ReadonlyArray<RequestSpec>,
	note: (feature: SharedFeature) => void
): void => {
	for (const a of specs) {
		for (const b of specs) {
			if (a === b || !Arr.every(fieldsOf(b), (f) => fieldsOf(a).includes(f))) {
				continue
			}
			const narrower = fieldsOf(b).length < fieldsOf(a).length
			if (narrower) {
				note("a narrower request beside a wider one over its columns")
			}
			if (
				a.kind === "access" &&
				b.kind === "access" &&
				a.use === "equality lookup" &&
				b.use === "take seek"
			) {
				note(
					narrower
						? "a wider equality lookup beside a narrower order over its columns"
						: "an equality lookup beside an order over its columns"
				)
			}
		}
	}
}

/** A planted shared request: ascending keys over `columns`, for `use`. */
const sharedSketch = (
	columns: Arr.NonEmptyReadonlyArray<SharedColumn>,
	use: SharedUse
): SharedSketch => ({
	keys: Arr.map(columns, (column) => ({ column, desc: false })),
	use
})

/**
 * A seek over two or three shared columns beside a seek over the same columns in reverse order, which no one key order
 * serves, among up to two other requests: the set the planner answers with two indexes on one column set.
 */
const transposedGen: Gen<ReadonlyArray<SharedSketch>> = (source) => {
	const first = source.draw(element(sharedColumns))
	const columns: Arr.NonEmptyReadonlyArray<SharedColumn> = [
		first,
		...source.draw(
			shuffled(
				Arr.filter(sharedColumns, (column) => column !== first),
				{ min: 1, max: 2 }
			)
		)
	]
	return [
		sharedSketch(columns, "take seek"),
		sharedSketch(Arr.reverse(columns), "take seek"),
		...source.draw(array(sharedGen, { min: 0, max: 2 }))
	]
}
/**
 * An equality lookup over two or three shared columns beside a seek over some or all of them, in a drawn order and
 * directions, among up to two other requests: the set one key order serves, the seek's columns first.
 */
const coveringGen: Gen<ReadonlyArray<SharedSketch>> = (source) => {
	const first = source.draw(element(sharedColumns))
	const columns: Arr.NonEmptyReadonlyArray<SharedColumn> = [
		first,
		...source.draw(
			shuffled(
				Arr.filter(sharedColumns, (column) => column !== first),
				{ min: 1, max: 2 }
			)
		)
	]
	const lead = source.draw(element(columns))
	const seek: Arr.NonEmptyReadonlyArray<SharedColumn> = [
		lead,
		...source.draw(
			shuffled(
				Arr.filter(columns, (column) => column !== lead),
				{ min: 0, max: columns.length - 1 }
			)
		)
	]
	return [
		sharedSketch(columns, "equality lookup"),
		{
			keys: Arr.map(seek, (column) => ({ column, desc: source.draw(boolean) })),
			use: "take seek"
		},
		...source.draw(array(sharedGen, { min: 0, max: 2 }))
	]
}
const sharedSetGen: Gen<ReadonlyArray<SharedSketch>> = weighted([
	[2, array(sharedGen, { min: 2, max: 4 })],
	[1, transposedGen],
	[1, coveringGen]
])

/**
 * The drawn requests planned in every order they can arrive in, the plan one list of indexes, then installed in the
 * first order, loaded and judged.
 */
const sharedCase = (
	sketches: ReadonlyArray<SharedSketch>,
	note: (feature: ServingFeature | SharedFeature) => void
) =>
	Effect.gen(function* () {
		const specs = Arr.map(sketches, resolveShared)
		sharedNotes(specs, note)
		const plans = Arr.map(arrivals(specs), (order) => {
			const plan = planRealInstall(Indexed, {
				installation: identity.schema(parsedSchemaName("serving_shared")),
				owner: "serving_owner",
				logins: [],
				extensions: [drawnRequests(order).extension],
				codes: emptyCodebook
			})
			return !plan.ok
				? assert.fail(`the requests do not plan: ${plan.error.message}`)
				: planShape(plan.value)
		})
		const [first, ...others] = plans
		if (first === undefined) {
			return assert.fail("no arrival order")
		}
		for (const other of others) {
			assert.deepEqual(
				other,
				first,
				`one plan in every arrival order: ${Arr.join(Arr.map(specs, specText), "; ")}`
			)
		}
		if (Arr.some(first, (i) => i.uses.length > 1)) {
			note("one index serving requests of two needs")
		}
		const created = Arr.filter(first, (i) => i.origin === "created")
		const columnSet = (i: PlannedShape): ReadonlyArray<string> =>
			Arr.sort(
				Arr.map(i.keys, (k) => k.field),
				Order.String
			)
		if (
			Arr.some(created, (a) =>
				Arr.some(created, (b) => a !== b && Equal.equals(columnSet(a), columnSet(b)))
			)
		) {
			note("two indexes on one column set")
		}
		const drawn = drawnRequests(specs)
		const { plan } = yield* installRealSchema(Indexed, {
			label: "serving_shared",
			logins: [],
			extensions: [drawn.extension]
		})
		yield* loadAtVolume(plan, indexedLoads)
		const problems = yield* judgeServing(plan, drawn.rowsOf, note)
		assert.deepEqual(
			problems,
			[],
			`PostgreSQL serves every request and needs every created index: ${Arr.join(Arr.map(specs, specText), "; ")}`
		)
	})

type ReadSketch = CaseSketch["reads"][number]
type MatchSketch = ReadSketch["rule"]["matches"][number]
type CompareSketch = ReadSketch["rule"]["where"][number]

/** A kept workload sketch's picks, each at its floor, zero, but those that select what the case reaches. */
const zeros = (length: number): ReadonlyArray<number> => Arr.makeBy(length, () => 0)
const floorValue = { cls: 0, sp: 0 } as const
const floorCompare: CompareSketch = { left: 0, op: 0, pick: 0, value: floorValue }
const negation = { source: 0, picks: zeros(2) } as const
const head = { vars: [], names: zeros(6), folds: [] } as const

/** A match of the sources `source` and `derived` pick, every bind at the floor. */
const match = (source: number, derived: number): MatchSketch => ({
	source,
	derived,
	attached: 0,
	binds: Arr.makeBy(7, () => ({ how: 0, pick: 0, value: floorValue }))
})

/**
 * A read of `matches` filtered by `where`, its interior stage a floor match filtered by `inner`, binding its first match's
 * first key field to a parameter a later read may import when `importable` is in its upper half.
 */
const read = (
	matches: ReadonlyArray<MatchSketch>,
	where: ReadonlyArray<CompareSketch>,
	inner: ReadonlyArray<CompareSketch>,
	importable: number
): ReadSketch => ({
	rule: {
		matches,
		where,
		between: [],
		inSet: [],
		allen: [],
		pointIn: [],
		connective: [],
		computed: [],
		negation,
		head,
		interior: { matches: [match(0, 0)], where: inner, negation, head }
	},
	take: { rotate: 0, dirs: zeros(3), size: 0 },
	literalHead: { name: 0, kind: 0, arms: 0, values: zeros(3) },
	importable,
	bindImport: 0,
	named: 0,
	relationParam: { relation: 0, facts: [] },
	closure: { relation: 0, pair: 0, name: 0 },
	attachments: [],
	order: { rotate: 0, dirs: zeros(3), size: 0 },
	probe: { kind: 0, pick: 0 },
	key: { relation: 0, which: 0, fact: 0, absent: 0, roster: 0 }
})

/** The generated workloads kept from failure reports, each replayed first by value (see the header). */
const workloadKept: ReadonlyArray<Kept<CaseSketch, ServingFeature | WorkloadFeature>> = [
	{
		note: "an equality lookup on A's boolean key column, which answers half its rows through the primary key, beside a span predicate on Task binding its closed id but not the numeric of many values after it in the GiST index another span predicate creates",
		sketch: {
			population: "forms",
			swarm: {
				"bind fresh": 2,
				"bind join": 1,
				"bind param": 3,
				"bind parent": 2,
				where: 3,
				"compare literal": 2,
				"compare param": 3,
				aggregate: 2,
				union: 3,
				take: 3,
				ordered: 1,
				attach: 3,
				nested: 2,
				dense: 3,
				"candidate key": 1,
				probe: 1,
				spelled: 1,
				"full head": 2,
				"stated delivery": 2,
				"plain child": 3,
				"keyed child": 1,
				"reflexive child": 2,
				"arm child": 2,
				"handle field": 3,
				import: 3,
				"import bound": 3,
				interior: 3,
				named: 3,
				"computed head": 3,
				"computed group key": 3,
				between: 3,
				"in set": 3,
				"relation param": 3,
				recursive: 3,
				"contract param": 3,
				"typmod param": 3,
				allen: 3,
				"point in": 3,
				"literal head": 3
			},
			perturbation: {
				settings: ["enable_hashjoin = off", "enable_mergejoin = off"],
				multiplier: 1
			},
			ambient: ordinarySession,
			restorage: { shift: 0, respell: 0 },
			roster: 60096,
			span: 46161,
			relations: [
				{
					name: 62495,
					fields: [
						{ name: 27120, kind: 21846, key: 49254 },
						{ name: 32056, kind: 36864, key: 39891 },
						{ name: 7, kind: 4096, key: 27954 },
						{ name: 38655, kind: 4096, key: 38689 }
					],
					candidate: 28767,
					facts: [
						{
							values: [
								{ cls: 55943, sp: 23580 },
								{ cls: 41936, sp: 65267 },
								{ cls: 3112, sp: 16273 },
								{ cls: 32262, sp: 53000 },
								{ cls: 45691, sp: 57200 },
								{ cls: 48312, sp: 59129 },
								{ cls: 43801, sp: 2482 }
							]
						},
						{
							values: [
								{ cls: 63400, sp: 7523 },
								{ cls: 47433, sp: 38810 },
								{ cls: 53811, sp: 10315 },
								{ cls: 638, sp: 35753 },
								{ cls: 65466, sp: 4751 },
								{ cls: 602, sp: 36681 },
								{ cls: 46493, sp: 43708 }
							]
						}
					]
				},
				{
					name: 0,
					fields: [
						{ name: 17154, kind: 36409, key: 6147 },
						{ name: 64511, kind: 8192, key: 8476 }
					],
					candidate: 26083,
					facts: [
						{
							values: [
								{ cls: 61558, sp: 9553 },
								{ cls: 48168, sp: 12841 },
								{ cls: 1241, sp: 43752 },
								{ cls: 47265, sp: 50834 },
								{ cls: 46407, sp: 50296 },
								{ cls: 60134, sp: 17426 },
								{ cls: 1753, sp: 55300 }
							]
						},
						{
							values: [
								{ cls: 46552, sp: 8570 },
								{ cls: 65146, sp: 64960 },
								{ cls: 15276, sp: 53528 },
								{ cls: 51466, sp: 38212 },
								{ cls: 12596, sp: 18648 },
								{ cls: 20421, sp: 19701 },
								{ cls: 57392, sp: 34095 }
							]
						},
						{
							values: [
								{ cls: 8619, sp: 46818 },
								{ cls: 63613, sp: 47838 },
								{ cls: 4370, sp: 53317 },
								{ cls: 59173, sp: 39223 },
								{ cls: 17831, sp: 3201 },
								{ cls: 19919, sp: 34281 },
								{ cls: 60033, sp: 13461 }
							]
						},
						{
							values: [
								{ cls: 62504, sp: 946 },
								{ cls: 56487, sp: 60429 },
								{ cls: 62292, sp: 2211 },
								{ cls: 60364, sp: 6043 },
								{ cls: 301, sp: 46856 },
								{ cls: 38987, sp: 34008 },
								{ cls: 38323, sp: 24422 }
							]
						},
						{
							values: [
								{ cls: 27148, sp: 36686 },
								{ cls: 10064, sp: 52201 },
								{ cls: 47536, sp: 54382 },
								{ cls: 16151, sp: 20764 },
								{ cls: 19279, sp: 61072 },
								{ cls: 31932, sp: 6605 },
								{ cls: 1349, sp: 44087 }
							]
						}
					]
				},
				{
					name: 58272,
					fields: [
						{ name: 65051, kind: 14564, key: 44707 },
						{ name: 19568, kind: 4096, key: 25507 },
						{ name: 13341, kind: 0, key: 38764 },
						{ name: 65533, kind: 36864, key: 45197 }
					],
					candidate: 47335,
					facts: [
						{
							values: [
								{ cls: 31718, sp: 12311 },
								{ cls: 31977, sp: 6822 },
								{ cls: 23848, sp: 43159 },
								{ cls: 2, sp: 44438 },
								{ cls: 44770, sp: 59561 },
								{ cls: 20024, sp: 42982 },
								{ cls: 851, sp: 65494 }
							]
						}
					]
				}
			],
			reads: [
				{
					rule: {
						matches: [
							{
								source: 43828,
								derived: 7694,
								attached: 3029,
								binds: [
									{ how: 17021, pick: 2280, value: { cls: 50129, sp: 9213 } },
									{ how: 43889, pick: 45160, value: { cls: 64902, sp: 16242 } },
									{ how: 5885, pick: 9597, value: { cls: 65292, sp: 11 } },
									{ how: 12208, pick: 49738, value: { cls: 54638, sp: 41735 } },
									{ how: 54560, pick: 23303, value: { cls: 6738, sp: 176 } },
									{ how: 14656, pick: 62454, value: { cls: 24635, sp: 43826 } },
									{ how: 5966, pick: 64872, value: { cls: 45072, sp: 44829 } }
								]
							},
							{
								source: 62565,
								derived: 52801,
								attached: 50087,
								binds: [
									{ how: 16610, pick: 6421, value: { cls: 14965, sp: 42678 } },
									{ how: 10074, pick: 15015, value: { cls: 57851, sp: 30171 } },
									{ how: 2227, pick: 46414, value: { cls: 22525, sp: 29832 } },
									{ how: 55634, pick: 43676, value: { cls: 4093, sp: 14608 } },
									{ how: 28927, pick: 51039, value: { cls: 18499, sp: 18059 } },
									{ how: 6005, pick: 31003, value: { cls: 19368, sp: 3987 } },
									{ how: 38210, pick: 4301, value: { cls: 60895, sp: 35487 } }
								]
							}
						],
						where: [{ left: 65532, op: 1526, pick: 25138, value: { cls: 20500, sp: 11152 } }],
						between: [
							{
								left: 0,
								low: { pick: 18190, value: { cls: 54715, sp: 39565 } },
								high: { pick: 16466, value: { cls: 61894, sp: 3901 } }
							}
						],
						inSet: [
							{
								left: 4847,
								values: [
									{ cls: 41232, sp: 17675 },
									{ cls: 63512, sp: 53387 }
								]
							}
						],
						allen: [{ left: 54982, mask: 7301, right: 15457 }],
						pointIn: [{ span: 40192, point: 55068 }],
						connective: [],
						computed: [],
						negation: { source: 2, picks: [2602, 65246] },
						head: {
							vars: [52310],
							names: [38385, 1410, 65515, 8772, 25453, 63130],
							folds: [
								{ fn: 1436, arg: 46482, padded: 0, scale: 0 },
								{ fn: 1896, arg: 35203, padded: 0, scale: 0 }
							]
						},
						interior: {
							matches: [
								{
									source: 50447,
									derived: 17532,
									attached: 10802,
									binds: [
										{ how: 53461, pick: 54143, value: { cls: 4536, sp: 27902 } },
										{ how: 10190, pick: 26513, value: { cls: 283, sp: 43607 } },
										{ how: 1364, pick: 13998, value: { cls: 5388, sp: 51526 } },
										{ how: 60851, pick: 42942, value: { cls: 63436, sp: 25814 } },
										{ how: 8470, pick: 33663, value: { cls: 25368, sp: 13416 } },
										{ how: 64352, pick: 17182, value: { cls: 56645, sp: 6639 } },
										{ how: 33, pick: 43504, value: { cls: 21497, sp: 35246 } }
									]
								}
							],
							where: [
								{ left: 47663, op: 13235, pick: 45482, value: { cls: 55049, sp: 34892 } },
								{ left: 17495, op: 41364, pick: 42902, value: { cls: 13546, sp: 30186 } }
							],
							negation: { source: 33859, picks: [14871, 9248] },
							head: {
								vars: [11688, 13701],
								names: [47334, 17, 35063, 13335, 40715, 18555],
								folds: [
									{ fn: 30498, arg: 31698, padded: 0, scale: 0 },
									{ fn: 30128, arg: 15465, padded: 0, scale: 0 }
								]
							}
						}
					},
					take: { rotate: 64280, dirs: [21099, 7306, 55735], size: 33742 },
					literalHead: { name: 34989, kind: 28186, arms: 23674, values: [13935, 13243, 57989] },
					importable: 59893,
					bindImport: 10812,
					named: 65462,
					relationParam: {
						relation: 65519,
						facts: [
							{
								values: [
									{ cls: 18351, sp: 64663 },
									{ cls: 65514, sp: 13009 },
									{ cls: 18541, sp: 40951 },
									{ cls: 41820, sp: 14398 },
									{ cls: 1286, sp: 36719 },
									{ cls: 14885, sp: 21890 },
									{ cls: 58108, sp: 48132 }
								]
							},
							{
								values: [
									{ cls: 28024, sp: 50506 },
									{ cls: 41371, sp: 7199 },
									{ cls: 36278, sp: 25223 },
									{ cls: 35382, sp: 62015 },
									{ cls: 14002, sp: 11280 },
									{ cls: 63032, sp: 55163 },
									{ cls: 42997, sp: 12438 }
								]
							}
						]
					},
					closure: { relation: 13672, pair: 57230, name: 7098 },
					attachments: [
						{
							name: 8166,
							link: 19768,
							handle: 1885,
							delivery: 65514,
							take: { rotate: 0, dirs: [0, 0, 0], size: 0 },
							rule: {
								matches: [
									{
										source: 52397,
										derived: 64977,
										attached: 50516,
										binds: [
											{ how: 65528, pick: 53731, value: { cls: 35857, sp: 62918 } },
											{ how: 41607, pick: 61302, value: { cls: 59308, sp: 4609 } },
											{ how: 58584, pick: 37262, value: { cls: 19426, sp: 12263 } },
											{ how: 36345, pick: 37105, value: { cls: 55798, sp: 11749 } },
											{ how: 3053, pick: 6376, value: { cls: 14199, sp: 29798 } },
											{ how: 26416, pick: 49436, value: { cls: 65532, sp: 50441 } },
											{ how: 41197, pick: 2981, value: { cls: 7434, sp: 15268 } }
										]
									},
									{
										source: 2777,
										derived: 19029,
										attached: 50536,
										binds: [
											{ how: 33492, pick: 36476, value: { cls: 1285, sp: 63961 } },
											{ how: 56539, pick: 53746, value: { cls: 7775, sp: 11177 } },
											{ how: 52705, pick: 62835, value: { cls: 59258, sp: 43221 } },
											{ how: 48951, pick: 18687, value: { cls: 8907, sp: 53568 } },
											{ how: 20758, pick: 9863, value: { cls: 23541, sp: 38061 } },
											{ how: 28282, pick: 31414, value: { cls: 49099, sp: 10606 } },
											{ how: 48401, pick: 35105, value: { cls: 2050, sp: 63276 } }
										]
									}
								],
								where: [],
								between: [],
								inSet: [],
								allen: [{ left: 37602, mask: 32639, right: 23043 }],
								pointIn: [],
								connective: [],
								computed: [
									{
										kind: 2,
										arg: 23702,
										op: 36205,
										than: { cls: 7376, sp: 64424 },
										otherwise: { cls: 65408, sp: 37811 },
										reading: 0,
										scale: 0,
										padded: 0
									}
								],
								negation: { source: 3618, picks: [45626, 59906] },
								head: {
									vars: [17783],
									names: [25312, 22497, 33248, 51821, 43006, 61305],
									folds: [
										{ fn: 15648, arg: 51142, padded: 0, scale: 0 },
										{ fn: 56560, arg: 39973, padded: 0, scale: 0 }
									]
								},
								interior: {
									matches: [
										{
											source: 51089,
											derived: 17163,
											attached: 108,
											binds: [
												{ how: 31174, pick: 13739, value: { cls: 6617, sp: 55841 } },
												{ how: 26131, pick: 49041, value: { cls: 64785, sp: 51231 } },
												{ how: 45246, pick: 27016, value: { cls: 58104, sp: 38134 } },
												{ how: 12569, pick: 60873, value: { cls: 7120, sp: 5033 } },
												{ how: 35266, pick: 21858, value: { cls: 0, sp: 6518 } },
												{ how: 65246, pick: 3599, value: { cls: 14727, sp: 46223 } },
												{ how: 13734, pick: 53830, value: { cls: 19742, sp: 65052 } }
											]
										},
										{
											source: 9613,
											derived: 46721,
											attached: 17835,
											binds: [
												{ how: 58743, pick: 4289, value: { cls: 56767, sp: 23414 } },
												{ how: 7538, pick: 65380, value: { cls: 42009, sp: 63790 } },
												{ how: 51051, pick: 38498, value: { cls: 65323, sp: 29245 } },
												{ how: 10836, pick: 56319, value: { cls: 13709, sp: 65130 } },
												{ how: 27047, pick: 6059, value: { cls: 13924, sp: 63044 } },
												{ how: 62841, pick: 63462, value: { cls: 45046, sp: 45605 } },
												{ how: 29017, pick: 1580, value: { cls: 32091, sp: 21585 } }
											]
										}
									],
									where: [{ left: 29291, op: 35503, pick: 51994, value: { cls: 10803, sp: 1631 } }],
									negation: { source: 34107, picks: [55310, 1412] },
									head: {
										vars: [13558, 11403, 57461],
										names: [64854, 34582, 19689, 42278, 44634, 495],
										folds: [
											{ fn: 48688, arg: 27590, padded: 0, scale: 0 },
											{ fn: 9979, arg: 4, padded: 0, scale: 0 }
										]
									}
								}
							},
							nested: {
								name: 20784,
								link: 65487,
								handle: 1,
								delivery: 54551,
								take: { rotate: 0, dirs: [0, 0, 0], size: 0 },
								rule: {
									matches: [
										{
											source: 65533,
											derived: 19624,
											attached: 65527,
											binds: [
												{ how: 24815, pick: 4725, value: { cls: 47317, sp: 28069 } },
												{ how: 31005, pick: 58149, value: { cls: 64082, sp: 8820 } },
												{ how: 20788, pick: 67, value: { cls: 279, sp: 43461 } },
												{ how: 21879, pick: 51520, value: { cls: 50941, sp: 52292 } },
												{ how: 52579, pick: 46896, value: { cls: 34172, sp: 26914 } },
												{ how: 44514, pick: 15631, value: { cls: 49511, sp: 36468 } },
												{ how: 65520, pick: 6865, value: { cls: 59848, sp: 63689 } }
											]
										},
										{
											source: 37604,
											derived: 3918,
											attached: 21910,
											binds: [
												{ how: 28028, pick: 7141, value: { cls: 25726, sp: 29218 } },
												{ how: 34210, pick: 45702, value: { cls: 16008, sp: 16243 } },
												{ how: 685, pick: 10970, value: { cls: 21457, sp: 22598 } },
												{ how: 35157, pick: 7504, value: { cls: 62617, sp: 32843 } },
												{ how: 31749, pick: 11318, value: { cls: 19128, sp: 46196 } },
												{ how: 2554, pick: 16114, value: { cls: 10322, sp: 15661 } },
												{ how: 8114, pick: 52980, value: { cls: 1, sp: 54881 } }
											]
										},
										{
											source: 54674,
											derived: 49147,
											attached: 25192,
											binds: [
												{ how: 64318, pick: 3, value: { cls: 58989, sp: 42670 } },
												{ how: 65216, pick: 12598, value: { cls: 459, sp: 8470 } },
												{ how: 0, pick: 43085, value: { cls: 48433, sp: 28044 } },
												{ how: 12530, pick: 32805, value: { cls: 54505, sp: 5886 } },
												{ how: 31542, pick: 17010, value: { cls: 3213, sp: 42317 } },
												{ how: 54873, pick: 0, value: { cls: 50354, sp: 20346 } },
												{ how: 1, pick: 30789, value: { cls: 57844, sp: 57194 } }
											]
										}
									],
									where: [
										{ left: 35620, op: 7861, pick: 45818, value: { cls: 50280, sp: 59562 } },
										{ left: 47010, op: 54736, pick: 42681, value: { cls: 5311, sp: 41000 } }
									],
									between: [
										{
											left: 53015,
											low: { pick: 47994, value: { cls: 24637, sp: 34124 } },
											high: { pick: 11855, value: { cls: 5804, sp: 39830 } }
										}
									],
									inSet: [],
									allen: [{ left: 54809, mask: 46964, right: 53465 }],
									pointIn: [{ span: 18693, point: 754 }],
									connective: [],
									computed: [],
									negation: { source: 64291, picks: [60057, 36775] },
									head: {
										vars: [62243, 64322, 52801],
										names: [54419, 50185, 29666, 33023, 44227, 5031],
										folds: [
											{ fn: 26700, arg: 42080, padded: 0, scale: 0 },
											{ fn: 65436, arg: 26603, padded: 0, scale: 0 }
										]
									},
									interior: {
										matches: [
											{
												source: 52786,
												derived: 49069,
												attached: 17265,
												binds: [
													{ how: 8997, pick: 30943, value: { cls: 14871, sp: 13463 } },
													{ how: 18733, pick: 65516, value: { cls: 37957, sp: 5460 } },
													{ how: 29000, pick: 55772, value: { cls: 25783, sp: 46987 } },
													{ how: 62458, pick: 6527, value: { cls: 37424, sp: 65284 } },
													{ how: 65499, pick: 32912, value: { cls: 43673, sp: 43653 } },
													{ how: 27053, pick: 38369, value: { cls: 63530, sp: 53538 } },
													{ how: 18970, pick: 46576, value: { cls: 10684, sp: 27056 } }
												]
											}
										],
										where: [],
										negation: { source: 28986, picks: [26031, 42811] },
										head: {
											vars: [2331, 9821],
											names: [28399, 48298, 50326, 11389, 10462, 53422],
											folds: [{ fn: 43685, arg: 0, padded: 0, scale: 0 }]
										}
									}
								}
							}
						}
					],
					order: { rotate: 11721, dirs: [63734, 50548, 56392], size: 4083 },
					probe: { kind: 57125, pick: 7352 },
					key: { relation: 59842, which: 65534, fact: 10380, absent: 11672, roster: 47559 }
				},
				{
					rule: {
						matches: [
							{
								source: 41150,
								derived: 19309,
								attached: 60466,
								binds: [
									{ how: 22878, pick: 32725, value: { cls: 65535, sp: 6251 } },
									{ how: 21504, pick: 40925, value: { cls: 47801, sp: 2111 } },
									{ how: 10171, pick: 55777, value: { cls: 46612, sp: 58881 } },
									{ how: 26030, pick: 44523, value: { cls: 25043, sp: 65535 } },
									{ how: 46973, pick: 1996, value: { cls: 46235, sp: 48589 } },
									{ how: 35815, pick: 15726, value: { cls: 48181, sp: 59672 } },
									{ how: 6273, pick: 60261, value: { cls: 124, sp: 11667 } }
								]
							}
						],
						where: [
							{ left: 25773, op: 8113, pick: 63936, value: { cls: 28393, sp: 59097 } },
							{ left: 55170, op: 26328, pick: 24887, value: { cls: 35710, sp: 17287 } }
						],
						between: [
							{
								left: 40495,
								low: { pick: 55385, value: { cls: 26566, sp: 32807 } },
								high: { pick: 65530, value: { cls: 62365, sp: 38893 } }
							}
						],
						inSet: [
							{
								left: 65529,
								values: [
									{ cls: 2588, sp: 0 },
									{ cls: 30766, sp: 39584 }
								]
							}
						],
						allen: [],
						pointIn: [{ span: 30029, point: 63468 }],
						connective: [],
						computed: [
							{
								kind: 50838,
								arg: 59584,
								op: 10352,
								than: { cls: 15684, sp: 16354 },
								otherwise: { cls: 45713, sp: 59689 },
								reading: 0,
								scale: 0,
								padded: 0
							},
							{
								kind: 28502,
								arg: 30308,
								op: 15178,
								than: { cls: 65534, sp: 46010 },
								otherwise: { cls: 61972, sp: 42824 },
								reading: 0,
								scale: 0,
								padded: 0
							}
						],
						negation: { source: 65453, picks: [47203, 29639] },
						head: {
							vars: [41126],
							names: [37266, 61784, 25322, 51833, 54404, 17056],
							folds: [{ fn: 82, arg: 24887, padded: 0, scale: 0 }]
						},
						interior: {
							matches: [
								{
									source: 63123,
									derived: 427,
									attached: 41755,
									binds: [
										{ how: 35646, pick: 1464, value: { cls: 17680, sp: 34123 } },
										{ how: 54536, pick: 36442, value: { cls: 40594, sp: 31086 } },
										{ how: 48854, pick: 25174, value: { cls: 15045, sp: 17 } },
										{ how: 29945, pick: 40152, value: { cls: 22, sp: 50697 } },
										{ how: 48835, pick: 51874, value: { cls: 31259, sp: 21010 } },
										{ how: 29473, pick: 16616, value: { cls: 13470, sp: 3863 } },
										{ how: 41476, pick: 10558, value: { cls: 31471, sp: 49993 } }
									]
								},
								{
									source: 28755,
									derived: 58227,
									attached: 19095,
									binds: [
										{ how: 20134, pick: 10075, value: { cls: 30667, sp: 0 } },
										{ how: 9839, pick: 9754, value: { cls: 30880, sp: 14922 } },
										{ how: 3648, pick: 20016, value: { cls: 26076, sp: 41494 } },
										{ how: 45402, pick: 49745, value: { cls: 7539, sp: 11551 } },
										{ how: 13896, pick: 55090, value: { cls: 37896, sp: 268 } },
										{ how: 46976, pick: 11421, value: { cls: 58498, sp: 12728 } },
										{ how: 34309, pick: 47126, value: { cls: 55233, sp: 20346 } }
									]
								}
							],
							where: [],
							negation: { source: 25313, picks: [44185, 32820] },
							head: {
								vars: [15941, 16448, 16140],
								names: [28026, 64095, 8495, 48124, 5783, 57162],
								folds: [{ fn: 39599, arg: 37337, padded: 0, scale: 0 }]
							}
						}
					},
					take: { rotate: 16425, dirs: [26839, 3211, 21763], size: 59556 },
					literalHead: { name: 36244, kind: 28770, arms: 29530, values: [15279, 46997, 30820] },
					importable: 38765,
					bindImport: 65436,
					named: 54707,
					relationParam: {
						relation: 50738,
						facts: [
							{
								values: [
									{ cls: 48182, sp: 31 },
									{ cls: 51359, sp: 8513 },
									{ cls: 46913, sp: 65144 },
									{ cls: 22031, sp: 54251 },
									{ cls: 51569, sp: 65415 },
									{ cls: 36313, sp: 29089 },
									{ cls: 36970, sp: 45830 }
								]
							}
						]
					},
					closure: { relation: 37471, pair: 37789, name: 371 },
					attachments: [],
					order: { rotate: 13186, dirs: [1991, 2492, 18026], size: 5207 },
					probe: { kind: 46283, pick: 54543 },
					key: { relation: 65518, which: 19876, fact: 57056, absent: 19275, roster: 64633 }
				},
				{
					rule: {
						matches: [
							{
								source: 42378,
								derived: 22625,
								attached: 65513,
								binds: [
									{ how: 13074, pick: 22751, value: { cls: 65508, sp: 28843 } },
									{ how: 14062, pick: 43146, value: { cls: 61259, sp: 10438 } },
									{ how: 65529, pick: 24053, value: { cls: 11049, sp: 13921 } },
									{ how: 3205, pick: 28955, value: { cls: 51921, sp: 14654 } },
									{ how: 49281, pick: 16271, value: { cls: 54681, sp: 28272 } },
									{ how: 9049, pick: 63284, value: { cls: 16224, sp: 52390 } },
									{ how: 7327, pick: 574, value: { cls: 46688, sp: 2646 } }
								]
							},
							{
								source: 47236,
								derived: 6734,
								attached: 16251,
								binds: [
									{ how: 35648, pick: 61139, value: { cls: 48644, sp: 46142 } },
									{ how: 652, pick: 57101, value: { cls: 17936, sp: 65535 } },
									{ how: 42901, pick: 22163, value: { cls: 11482, sp: 40921 } },
									{ how: 30713, pick: 65523, value: { cls: 5454, sp: 11398 } },
									{ how: 51177, pick: 10947, value: { cls: 23213, sp: 125 } },
									{ how: 65486, pick: 63987, value: { cls: 0, sp: 6220 } },
									{ how: 27170, pick: 17128, value: { cls: 4280, sp: 26481 } }
								]
							},
							{
								source: 3209,
								derived: 22711,
								attached: 38150,
								binds: [
									{ how: 13279, pick: 13356, value: { cls: 4887, sp: 34553 } },
									{ how: 64898, pick: 5846, value: { cls: 61843, sp: 1638 } },
									{ how: 50654, pick: 16621, value: { cls: 24138, sp: 51025 } },
									{ how: 60176, pick: 32534, value: { cls: 55844, sp: 49329 } },
									{ how: 35866, pick: 65434, value: { cls: 17030, sp: 42470 } },
									{ how: 57407, pick: 42982, value: { cls: 48687, sp: 65457 } },
									{ how: 10146, pick: 30012, value: { cls: 18030, sp: 2362 } }
								]
							}
						],
						where: [{ left: 44542, op: 56982, pick: 17861, value: { cls: 26945, sp: 22237 } }],
						between: [],
						inSet: [{ left: 57789, values: [{ cls: 17578, sp: 21950 }] }],
						allen: [{ left: 61425, mask: 12508, right: 33876 }],
						pointIn: [{ span: 4117, point: 50923 }],
						connective: [],
						computed: [
							{
								kind: 48882,
								arg: 4834,
								op: 33872,
								than: { cls: 14744, sp: 10154 },
								otherwise: { cls: 2252, sp: 29642 },
								reading: 0,
								scale: 0,
								padded: 0
							},
							{
								kind: 65526,
								arg: 47334,
								op: 1958,
								than: { cls: 10891, sp: 34543 },
								otherwise: { cls: 22882, sp: 60043 },
								reading: 0,
								scale: 0,
								padded: 0
							}
						],
						negation: { source: 6083, picks: [4371, 43619] },
						head: {
							vars: [],
							names: [65309, 2, 41574, 20680, 24787, 65145],
							folds: [{ fn: 13950, arg: 12675, padded: 0, scale: 0 }]
						},
						interior: {
							matches: [
								{
									source: 42983,
									derived: 61732,
									attached: 65526,
									binds: [
										{ how: 27672, pick: 24218, value: { cls: 65532, sp: 64956 } },
										{ how: 60724, pick: 51665, value: { cls: 33299, sp: 33009 } },
										{ how: 21733, pick: 44, value: { cls: 27086, sp: 5707 } },
										{ how: 31462, pick: 16929, value: { cls: 31193, sp: 49925 } },
										{ how: 63673, pick: 49240, value: { cls: 65475, sp: 22856 } },
										{ how: 54038, pick: 20238, value: { cls: 53829, sp: 17627 } },
										{ how: 50737, pick: 9652, value: { cls: 45991, sp: 64335 } }
									]
								},
								{
									source: 55518,
									derived: 27942,
									attached: 61845,
									binds: [
										{ how: 49175, pick: 57477, value: { cls: 38982, sp: 3667 } },
										{ how: 22784, pick: 10899, value: { cls: 45828, sp: 54479 } },
										{ how: 29956, pick: 46437, value: { cls: 38998, sp: 3 } },
										{ how: 18487, pick: 50030, value: { cls: 37177, sp: 29047 } },
										{ how: 44380, pick: 57033, value: { cls: 40299, sp: 4301 } },
										{ how: 37437, pick: 65523, value: { cls: 6717, sp: 63562 } },
										{ how: 47784, pick: 12095, value: { cls: 19824, sp: 24295 } }
									]
								}
							],
							where: [],
							negation: { source: 27791, picks: [65518, 28851] },
							head: {
								vars: [],
								names: [53052, 31184, 61966, 45518, 35837, 47897],
								folds: [{ fn: 50017, arg: 50505, padded: 0, scale: 0 }]
							}
						}
					},
					take: { rotate: 27013, dirs: [6584, 52801, 60158], size: 0 },
					literalHead: { name: 54763, kind: 65530, arms: 41614, values: [30595, 59321, 29634] },
					importable: 34838,
					bindImport: 26082,
					named: 15152,
					relationParam: { relation: 39601, facts: [] },
					closure: { relation: 33641, pair: 0, name: 16476 },
					attachments: [],
					order: { rotate: 18, dirs: [20291, 26829, 5203], size: 39633 },
					probe: { kind: 27565, pick: 18930 },
					key: { relation: 18724, which: 4342, fact: 51429, absent: 64573, roster: 34209 }
				}
			],
			planted: {
				names: [
					1, 65218, 17901, 65534, 41578, 58234, 41815, 0, 14545, 40657, 64375, 4495, 12973, 13687,
					54559, 42204, 4705, 48722, 65059
				],
				value: { cls: 40923, sp: 1 },
				handle: 0,
				padding: 0,
				side: { kind: 1, values: [0, 2, 1] }
			}
		},
		draws:
			"0.0.0.0.0.0.4.1.0.4.3.3.2.0.0.2.2.0.0.0.0.0.0.0.7.1.5.3.4.5.3.0.1.2.0.2.0.0.0.0.2.0.0.3.0.0.0.1.0.0.1.0.0.2.1.2.3.2.2.1.0.0.0.1.0.2.0.2.2.1.0.4.3.4.4.4.0.0.7.4.6.4.0.0.0.0.1.0.0",
		reaches: [
			"a workload installed",
			"equality probe served",
			"served by a key or enforcement index",
			"overlap probe served",
			"served by a created index",
			"a created index needed"
		]
	},
	{
		note: "a join key on Rel1x0's (HTTPRoute, field1) beside span predicates on (HTTPRoute, field1, fixed0, span40) and (fixed0, span40), whose GiST index on (fixed0, HTTPRoute, field1, span40) PostgreSQL sweeps for the join key, which its own B-tree alone serves",
		sketch: {
			population: "forms",
			swarm: {
				"bind join": 3,
				"bind existential": 3,
				where: 3,
				"compare var": 3,
				"compare param": 3,
				aggregate: 3,
				take: 2,
				ordered: 2,
				probe: 2,
				spelled: 2,
				import: 3,
				interior: 3,
				"contract param": 3,
				"typmod param": 3,
				allen: 3
			},
			perturbation: unperturbed,
			ambient: ordinarySession,
			restorage: { shift: 0, respell: 0 },
			roster: 0,
			span: 0,
			relations: [
				{ name: 0, fields: [], candidate: 0, facts: [] },
				{
					name: 0,
					fields: [
						{ name: 0, kind: 0, key: 0 },
						{ name: 0, kind: 0, key: 32768 },
						{ name: 0, kind: 0, key: 0 }
					],
					candidate: 0,
					facts: []
				}
			],
			reads: [
				read([match(0, 0), match(0, 0), match(57768, 0)], [floorCompare], [], 32768),
				read([match(0, 0), match(40889, 32768), match(53346, 0)], [], [floorCompare], 0)
			],
			planted: {
				names: zeros(19),
				value: floorValue,
				handle: 0,
				padding: 0,
				side: { kind: 0, values: zeros(3) }
			}
		},
		draws: "0.0.0.3.1.0.2.0.0.0.0.0.2.0.0.2.0.0.0.0.2.5.5.2.5.0.3.0.0.4.0.0.4.1.0",
		reaches: [
			"a workload installed",
			"read through another planned index than the engine's",
			"swept through another GiST index, gistcostestimate blind to its key order"
		]
	}
]

const workloadSuite = (runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				suite: "pg/physical/serving-workload",
				draw: drawn(caseSketchGen),
				literal: Formatter.format,
				coverage: required<ServingFeature | WorkloadFeature>(
					["a workload installed", "equality probe served"],
					{ cases: runs, sense: notesOnly }
				),
				kept: workloadKept,
				runs,
				shrink: { kind: "bounded", candidates: 60 },
				concurrency: 1,
				steerEvery: 16,
				caseHang
			},
			(sketch, cx) => Effect.scoped(workloadCase(cx.draw(resolveCase(sketch)), cx.note))
		)
	)

const requestSuite = (runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				suite: "pg/physical/serving-requests",
				draw: drawn(intentsGen),
				literal: Formatter.format,
				coverage: required<ServingFeature | RequestFeature>(
					[
						"equality probe served",
						"range probe served",
						"ordered probe served",
						"overlap probe served",
						"served by a created index",
						"served by a key or enforcement index",
						"a GiST index serving a B-tree request",
						"a created index needed",
						"a law probe of selected rows",
						"a span predicate on during alone"
					],
					{ cases: runs, sense: notesOnly }
				),
				kept: requestKept,
				runs,
				shrink: { kind: "bounded", candidates: 60 },
				concurrency: 1,
				steerEvery: 16,
				caseHang
			},
			(intents, cx) => Effect.scoped(requestCase(intents, cx.note))
		)
	)

const sharedSuite = (runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				suite: "pg/physical/serving-shared",
				draw: drawn(sharedSetGen),
				literal: Formatter.format,
				coverage: required<ServingFeature | SharedFeature>(
					[
						"an equality lookup beside an order over its columns",
						"a wider equality lookup beside a narrower order over its columns",
						"a narrower request beside a wider one over its columns",
						"one index serving requests of two needs",
						"two indexes on one column set",
						"a created index needed"
					],
					{ cases: runs, sense: notesOnly }
				),
				kept: [],
				runs,
				shrink: { kind: "bounded", candidates: 60 },
				concurrency: 1,
				steerEvery: 16,
				caseHang
			},
			(sketches, cx) => Effect.scoped(sharedCase(sketches, cx.note))
		)
	)

layer(Substrate.layer)("index serving, judged by PostgreSQL at volume", (it) => {
	it.effect(
		"every request a generated workload plans is served, and every index it creates is needed",
		workloadSuite(10)
	)
	it.effect(
		"every drawn request is served, and every index the engine creates for them is needed",
		requestSuite(16)
	)
	it.effect(
		"requests over shared columns plan alike in every arrival order, each served, every created index needed",
		sharedSuite(12)
	)
})
