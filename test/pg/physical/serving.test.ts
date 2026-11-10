import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Equal, Formatter, Order, Result, String as Str } from "effect"
import type { TestContext } from "vitest"
import { isCompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import type { Direction } from "#compiler/core/order.ts"
import { codeOf, emptyCodebook } from "#compiler/ir/codes.ts"
import type { AccessUse } from "#compiler/ir/products.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import {
	drawnRequests,
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
import { workloadOver } from "#test/support/compile.ts"
import {
	closed,
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
import {
	installRealSchema,
	planRealInstall,
	type RealInstallPlan
} from "#test/support/oracle/install/real.ts"
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
import { upTo } from "#test/support/up-to.ts"

/**
 * Index serving judged by PostgreSQL, over generated schemas and workloads and over drawn index requests, at volume.
 *
 * The index engine (physical/indexes/engine.ts) claims, for every request it plans, an index that serves it, and it
 * creates an index only for a request nothing installed serves. PostgreSQL is the judge of both claims (serving.ts):
 * every request's probe must run through an index the installation planned, with an index condition, one descent, no
 * sort and a bounded count of touched buffers, and through its own index alone searching every condition it states, so
 * no filtered row; and every created index must be needed, some request it holds going unserved once it is dropped. The
 * serving rule is never restated here.
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
 *   a closed id, then a numeric of many values the predicate leaves unbound, does not serve; a join key on a key column
 *   and a column of many values, beside span predicates whose GiST index holds both after its lead, which PostgreSQL
 *   sweeps for the join key, a residue no plan the engine makes avoids (serving.ts), and which drawn workloads reach
 *   about once in 200 cases; a span predicate on a field of a two-field key and a span, beside a take seek whose
 *   B-tree holds both after that field, which the load makes unique on its own, so that without the predicate's GiST
 *   index PostgreSQL finds its one row through the B-tree, whose filter on the span removes none: the GiST index is
 *   needed still, since the B-tree does not search the span by overlap (serving.ts); a span predicate on a text
 *   field of a key, which the load fills with two ideographs, and a span, whose GiST index, led by that text, PostgreSQL
 *   19's btree_gist prices by its leading bytes, so its probe reads past its bound, a residue PostgreSQL 20 removes
 *   (serving.ts); a join key planned on the B-tree a range creates, led by a column the join key fixes and holding a
 *   boolean it leaves unbound before its other column, which PostgreSQL reads by a skip scan over the boolean in two
 *   descents (serving.ts); and a range on a closed handle by equality and a numeric of many values by a range, beside
 *   span predicates whose GiST index holds both, which places its entries by the numeric, so that its scan would read
 *   the range across every handle, three times the range's share: a B-tree serves it (physical/indexes/engine.ts).
 * - Drawn requests. A fixed schema holds a plain table, a span key's GiST index (Booking, on room and during), two span
 *   keys' GiST indexes led by a column of few values, a boolean (Shift, on standby, worker and during, standby true on
 *   one row in ten) and a closed id of a drawn roster of four to eight handles (Rota, on shade, worker and during, shade
 *   its first handle on nine rows in ten), a selected side's unique (at most one remainder deposit per line) beside a foreign key on its column, and the engine is
 *   handed drawn requests on it: workload B-tree requests of every use, law probes, and GiST span predicates on during
 *   with any of Booking's scalars. Its kept cases plant the requests a planner is tempted to serve wrongly: an equality
 *   pair beside a range over the same two columns in the other order, which one index serves; law probes on Event's
 *   (tenant, account) and (tenant, account, id), the second planned on the primary key, which PostgreSQL reads through
 *   the index on (tenant, account) at the same cost, rechecking id on the rows of its sampled pair, its choice and not
 *   the engine's claim (serving.ts); and, on Shift and on Rota of five and of eight shades, whose GiST indexes place
 *   their entries by worker, their first column of many values: a range on worker after the column of few values, and
 *   a law probe and a range on that column alone, which the index holds in order but whose scan reads the range across
 *   every value of that column, or every entry; and a lookup and a range on worker alone, which the index holds after
 *   that column, unbound, so that its scan descends once per value of it: a B-tree serves each.
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

type WorkloadFeature =
	| "a workload installed"
	| "a workload refused for an unrepresentable key"
	| "a workload's statistics installed as requested"

/** The letter pg_statistic_ext.stxkind holds for each kind a statistics object states. */
const kindLetter = { ndistinct: "d", dependencies: "f", mcv: "m" } as const

/**
 * The installation's extended statistics as the catalog holds them are those its manifest creates, each over its
 * columns with every kind it states, and every index and statistics object the manifest creates stands on a law or
 * the workload's access: whether each is planned is test/unit/workload's, that it is installed as planned is here.
 */
const statisticsAsPlanned = (
	plan: RealInstallPlan,
	note: (feature: ServingFeature | WorkloadFeature) => void
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const created = Arr.filter(
			plan.installation.manifest.objects,
			(o) => o.kind === "index" || o.kind === "statistics"
		)
		for (const o of created) {
			assert.ok(
				Arr.some(o.reasons, (r) => r.kind === "law" || r.kind === "access"),
				`${o.ident} stands on a law or the workload's access`
			)
		}
		const sorted = (items: ReadonlyArray<string>) => Arr.join(Arr.sort(items, Order.String), ",")
		const planned = Arr.flatMap(created, (o) =>
			Arr.flatMap(o.ddl, (st) =>
				st.kind === "createStatistics"
					? [
							[
								st.name.name,
								sorted(Arr.map(st.statistics, (k) => kindLetter[k])),
								sorted(st.columns)
							] as const
						]
					: []
			)
		)
		/** Each statistics object: its name, its kinds and its columns' names, each list joined by U+0001. */
		const installed = yield* substrate.admin.queryValues(
			`SELECT s.stxname::text, pg_catalog.array_to_string(s.stxkind, chr(1)), (SELECT pg_catalog.string_agg(a.attname::text, chr(1)) FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = s.stxrelid AND a.attnum = ANY (s.stxkeys)) FROM pg_catalog.pg_statistic_ext AS s JOIN pg_catalog.pg_namespace AS n ON n.oid = s.stxnamespace WHERE n.nspname = $1::text`,
			[plan.schema]
		)
		const listed = (cell: unknown): string => sorted(Str.split(String(cell), "\u0001"))
		assert.deepEqual(
			Arr.sort(
				Arr.map(installed, (row) =>
					Arr.join([String(row[0]), listed(row[1]), listed(row[2])], " ")
				),
				Order.String
			),
			Arr.sort(
				Arr.map(planned, (row) => Arr.join(row, " ")),
				Order.String
			),
			"the installed statistics are the planned ones, each over its columns with each of its kinds"
		)
		if (planned.length > 0) {
			note("a workload's statistics installed as requested")
		}
	})

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
		const installed = yield* Effect.result(
			installRealSchema(built.schema, {
				label: "serving_workload",
				logins: [],
				extensions: [
					workloadOver([{ login: "server", workloads: [workload(built.schema, programs)] }])
				]
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
		yield* statisticsAsPlanned(judged, note)
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
		const problems = yield* judgeServing(judged, note)
		assert.deepEqual(
			problems,
			[],
			`PostgreSQL serves every request and needs every created index\n${printCase(c)}`
		)
	})

/**
 * Event: a plain table under its primary key. Booking: a span key, so a GiST index on (room, during) whose room column
 * btree_gist serves by equality. Shift: a span key led by a boolean, so a GiST index on (standby, worker, during) that
 * places its entries by worker, its first column of many values. Line and Deposit: a foreign key on Deposit's line
 * beside a unique over its remainder deposits' lines (at most one per line), which its primary key (account, line)
 * cannot serve. Each holds a boolean a law's selection reads.
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
		relation(
			"Shift",
			{ standby: f.boolean, worker: f.uuid, during: f.span(f.integer, undefined) },
			["standby", "worker", "during"]
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
 * Line first, so each deposit's line exists; one deposit per line, so at most one remainder per line; bookings and
 * shifts never overlap at all, so every room's spans and every worker's are disjoint; a booking's id, which no key
 * holds, spread like any other field, so no index on it finds one row the schema does not promise; a shift on standby
 * one row in ten, as a flag is, the middle row every probe samples among them (serving.ts), so btree_gist's split, which
 * halves a page's entries in the column's order, never tells standby's values apart.
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
	},
	{
		relation: "Shift",
		fields: [
			["standby", "(g % 10 = 0)"],
			["worker", `md5('worker:' || ${spread(8, 141)})::uuid`],
			["during", "int4range(g * 10, g * 10 + 5)"]
		]
	}
]

/** Rota's roster, of `count` shades. */
const shadesOf = (count: number): ReadonlyArray<string> => upTo(count, (at) => `shade${at}`)

/**
 * The drawn requests' schema: Indexed, and Rota, a span key led by a closed id of `shades` handles, so a GiST index on
 * (shade, worker, during) that places its entries by worker, its first column of many values.
 */
const requestSchema = (shades: number): SchemaDesc => ({
	...Indexed,
	relations: [
		...Indexed.relations,
		closed("Shade", shadesOf(shades)),
		relation(
			"Rota",
			{ shade: f.closedId("Shade"), worker: f.uuid, during: f.span(f.integer, undefined) },
			["shade", "worker", "during"]
		)
	]
})

/**
 * Rota's rows: on its first shade nine rows in ten, as a default is, and on the others in turn on the tenth, the middle
 * row every probe samples among them (serving.ts), so btree_gist's split never tells the shades apart; a worker spread
 * like any other field; rotas that never overlap, by the codes `plan` minted.
 */
const rotaLoad = (plan: RealInstallPlan, shades: number): VolumeLoad => {
	const codec = defined(
		plan.installation.names.codes.rosters.get(parsedName("Shade")),
		"the installation's codes of Shade"
	)
	const codes = Arr.join(
		Arr.map(shadesOf(shades), (h) => String(codeOf(codec, h))),
		", "
	)
	return {
		relation: "Rota",
		fields: [
			[
				"shade",
				`(ARRAY[${codes}]::int2[])[CASE WHEN g % 10 = 0 THEN 2 + (g / 10) % ${shades - 1} ELSE 1 END]::${rosterDomainSql(plan, "Shade")}`
			],
			["worker", `md5('rota:' || ${spread(9, 141)})::uuid`],
			["during", "int4range(g * 10, g * 10 + 5)"]
		]
	}
}

/** The relations a drawn B-tree request keys, with the columns it may key. */
const keyed = ["Event", "Booking", "Shift", "Rota", "Deposit"] as const
type Keyed = (typeof keyed)[number]
const columnsOf: Readonly<Record<Keyed, Arr.NonEmptyReadonlyArray<string>>> = {
	Event: ["tenant", "account", "created", "unrelated", "id"],
	Booking: ["room", "id"],
	Shift: ["standby", "worker"],
	Rota: ["shade", "worker"],
	Deposit: ["line", "account"]
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
 * A drawn request, by what it asks: a workload B-tree access, a law's probe, or a GiST
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
				keys: source.draw(keysGen(columnsOf[relation]))
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

/**
 * The sizes of Rota's roster the drawn suite draws: from four shades, the fewest at which a GiST index's scan past one
 * left unbound, its rows held evenly, reads more than one descent's buffers (physical/indexes/engine.ts), to eight.
 * Rota's rows hold its first shade nine in ten (rotaLoad), where that read stays within one descent's buffers at each
 * count, so only the claim (serving.ts unboundBeforeLead) finds such a scan unserved.
 */
const fewestShades = 4
const mostShades = 8

/** A drawn suite's case: Rota's roster, of `fewestShades` to `mostShades` shades, and the requests handed the engine. */
interface RequestSketch {
	readonly shades: number
	readonly intents: ReadonlyArray<Intent>
}

const requestSketchGen: Gen<RequestSketch> = (source) => ({
	shades: source.draw(int(fewestShades, mostShades)),
	intents: source.draw(intentsGen)
})

/** A request's keys: the columns the sketch names, each once, in its order. */
const keysFor = (
	keys: Arr.NonEmptyReadonlyArray<KeySketch<string>>
): Arr.NonEmptyReadonlyArray<{ readonly field: string; readonly dir: Direction }> => {
	const key = (k: KeySketch<string>) => ({
		field: k.column,
		dir: k.desc ? ("desc" as const) : ("asc" as const)
	})
	const [first, ...rest] = keys
	const out: Arr.NonEmptyArray<{ readonly field: string; readonly dir: Direction }> = [key(first)]
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
		case "law":
			return {
				kind: "law",
				relation: intent.relation,
				keys: Arr.map(keysFor(intent.keys), (k) => k.field)
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

type RequestFeature = ServingFeature | "a span predicate on during alone"

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

/** A kept case's Rota, of `shades` shades, as the kept cases on a GiST index led by a column of few values name it. */
const rotaOf = (shades: number) =>
	({ target: "Rota", few: "shade", holds: `a closed id of ${shades} handles`, shades }) as const

const requestKept: ReadonlyArray<Kept<RequestSketch, RequestFeature>> = [
	{
		note: "an equality pair on (account, created) beside a range on created then account",
		sketch: {
			shades: fewestShades,
			intents: [
				accessIntent("Event", ["account", "created"], "equality lookup"),
				accessIntent("Event", ["created", "account"], "range")
			]
		},
		draws: "",
		reaches: ["range probe served"]
	},
	{
		note: "law probes on (tenant, account) and on (tenant, account, id), the second planned on the primary key, which PostgreSQL reads through the index on (tenant, account) at the same cost, rechecking id on the rows of its sampled pair",
		sketch: {
			shades: fewestShades,
			intents: Arr.map(
				[
					["tenant", "account"],
					["tenant", "account", "id"]
				] as const,
				(columns): Intent => ({
					kind: "law",
					relation: "Event",
					keys: Arr.map(columns, (column) => ({ column, desc: false }))
				})
			)
		},
		draws: "",
		reaches: [
			"served by a key or enforcement index",
			"read through another planned index that does not search every condition of its probe",
			"a created index needed"
		]
	},
	...Arr.flatMap(
		[
			{ target: "Shift", few: "standby", holds: "a boolean", shades: fewestShades } as const,
			rotaOf(fewestShades + 1),
			rotaOf(mostShades)
		],
		({ target, few, holds, shades }): ReadonlyArray<Kept<RequestSketch, RequestFeature>> => [
			{
				note: `a range on ${target}'s worker after its ${few}, ${holds}, which ${target}'s GiST index holds in that order and places by worker, so that its scan reads the range across every value of ${few}, and a B-tree serves it`,
				sketch: { shades, intents: [accessIntent(target, [few, "worker"], "range")] },
				draws: "",
				reaches: ["range probe served", "served by a created index", "a created index needed"]
			},
			{
				note: `a law probe and a range on ${target}'s ${few} alone, ${holds}, which ${target}'s GiST index leads with and places by worker, so that its scan reads every entry, and a B-tree serves both`,
				sketch: {
					shades,
					intents: [
						{ kind: "law", relation: target, keys: [{ column: few, desc: false }] },
						accessIntent(target, [few], "range")
					]
				},
				draws: "",
				reaches: [
					"equality probe served",
					"range probe served",
					"served by a created index",
					"a created index needed"
				]
			},
			{
				note: `an equality lookup and a range on ${target}'s worker alone, which ${target}'s GiST index holds after its ${few}, ${holds}, unbound, so that its scan descends once per value of ${few}, and a B-tree serves both`,
				sketch: {
					shades,
					intents: [
						accessIntent(target, ["worker"], "equality lookup"),
						accessIntent(target, ["worker"], "range")
					]
				},
				draws: "",
				reaches: [
					"equality probe served",
					"range probe served",
					"served by a created index",
					"a created index needed"
				]
			}
		]
	)
]

/** The drawn requests on the drawn suite's schema (requestSchema), installed, loaded and judged. */
const requestCase = (sketch: RequestSketch, note: (feature: RequestFeature) => void) =>
	Effect.gen(function* () {
		const specs = resolveIntents(sketch.intents)
		for (const spec of specs) {
			if (spec.kind === "access" && spec.use === "span predicate" && spec.keys.length === 1) {
				note("a span predicate on during alone")
			}
		}
		const { plan } = yield* installRealSchema(requestSchema(sketch.shades), {
			label: "serving_requests",
			logins: [],
			extensions: [drawnRequests(specs)]
		})
		yield* loadAtVolume(plan, [...indexedLoads, rotaLoad(plan, sketch.shades)])
		const problems = yield* judgeServing(plan, note)
		assert.deepEqual(
			problems,
			[],
			`PostgreSQL serves every request and needs every created index, Rota of ${sketch.shades} shades: ${Arr.join(Arr.map(specs, specText), "; ")}`
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
				extensions: [drawnRequests(order)],
				codes: emptyCodebook,
				compile: compileInstallation
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
		const { plan } = yield* installRealSchema(Indexed, {
			label: "serving_shared",
			logins: [],
			extensions: [drawnRequests(specs)]
		})
		yield* loadAtVolume(plan, indexedLoads)
		const problems = yield* judgeServing(plan, note)
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
const zeros = (length: number): ReadonlyArray<number> => upTo(length, () => 0)
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
	take: { rotate: 0, dirs: zeros(3), size: 0, ties: 0 },
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
					take: { rotate: 64280, dirs: [21099, 7306, 55735], size: 33742, ties: 0 },
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
					take: { rotate: 16425, dirs: [26839, 3211, 21763], size: 59556, ties: 0 },
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
					take: { rotate: 27013, dirs: [6584, 52801, 60158], size: 0, ties: 0 },
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
			"swept through another index, awaiting upstream/gist-costestimate-column-position"
		]
	},
	{
		note: "a span predicate on Timestamptztypmodin's (PolyOverleft, span80) beside a take seek whose B-tree holds both, PolyOverleft a field of the two-field key the load makes unique on its own: without the predicate's GiST index PostgreSQL finds its one row through the B-tree, whose filter on span80 removes none, yet the B-tree does not search span80 by overlap, so the GiST index is needed",
		sketch: {
			population: "delivered",
			swarm: {
				"bind fresh": 3,
				"bind parent": 3,
				"compare literal": 1,
				take: 3,
				"attached take": 2,
				ordered: 2,
				attach: 3,
				nested: 1,
				dense: 3,
				"candidate key": 1,
				probe: 1,
				spelled: 3,
				"full head": 3,
				ungrouped: 3,
				"stated delivery": 3,
				"keyed child": 3,
				"reflexive child": 3,
				"arm child": 3,
				"handle field": 3,
				import: 2,
				"import bound": 1,
				named: 2,
				"computed head": 2,
				"computed group key": 3,
				between: 1,
				"in set": 3,
				connective: 3,
				"relation param": 3,
				recursive: 3,
				"contract param": 3,
				"typmod param": 1,
				allen: 3,
				"point in": 3,
				"literal head": 1
			},
			perturbation: {
				settings: [
					"enable_hashjoin = off",
					"enable_mergejoin = off",
					"debug_parallel_query = regress",
					"plan_cache_mode = force_generic_plan"
				],
				multiplier: 1
			},
			ambient: {
				path: { kind: "grizzleFirst" },
				settings: [
					{ parameter: "extra_float_digits", value: "-15" },
					{ parameter: "TimeZone", value: "Pacific/Chatham" },
					{ parameter: "DateStyle", value: "SQL, DMY" },
					{ parameter: "IntervalStyle", value: "sql_standard" },
					{ parameter: "bytea_output", value: "escape" }
				]
			},
			restorage: { shift: 61, respell: 748 },
			roster: 13788,
			span: 64309,
			relations: [
				{
					name: 14540,
					fields: [
						{ name: 6761, kind: 9515, key: 53999 },
						{ name: 13648, kind: 9010, key: 62444 }
					],
					candidate: 25300,
					facts: []
				}
			],
			reads: [
				{
					rule: {
						matches: [
							{
								source: 30135,
								derived: 65298,
								attached: 31128,
								binds: [
									{ how: 121, pick: 55830, value: { cls: 65523, sp: 2761 } },
									{ how: 38604, pick: 0, value: { cls: 22918, sp: 24697 } },
									{ how: 15395, pick: 254, value: { cls: 7269, sp: 33407 } },
									{ how: 19325, pick: 17258, value: { cls: 41803, sp: 40735 } },
									{ how: 47758, pick: 15164, value: { cls: 65535, sp: 42196 } },
									{ how: 4707, pick: 38995, value: { cls: 63845, sp: 8017 } },
									{ how: 65345, pick: 6608, value: { cls: 58331, sp: 23794 } }
								]
							},
							{
								source: 14786,
								derived: 0,
								attached: 5978,
								binds: [
									{ how: 30177, pick: 15012, value: { cls: 5746, sp: 1788 } },
									{ how: 7942, pick: 12565, value: { cls: 8847, sp: 54179 } },
									{ how: 26710, pick: 38706, value: { cls: 29770, sp: 61258 } },
									{ how: 106, pick: 29890, value: { cls: 25414, sp: 39200 } },
									{ how: 61392, pick: 47845, value: { cls: 65513, sp: 48628 } },
									{ how: 24779, pick: 4001, value: { cls: 59158, sp: 139 } },
									{ how: 3, pick: 5, value: { cls: 27493, sp: 51189 } }
								]
							}
						],
						where: [],
						between: [],
						inSet: [{ left: 55062, values: [{ cls: 25487, sp: 17 }] }],
						allen: [{ left: 1339, mask: 55344, right: 63875 }],
						pointIn: [],
						connective: [],
						computed: [],
						negation: { source: 54287, picks: [9723, 31047] },
						head: {
							vars: [],
							names: [32943, 53145, 9774, 51476, 8658, 1549],
							folds: [{ fn: 10317, arg: 6765, padded: 25164, scale: 21778 }]
						},
						interior: {
							matches: [
								{
									source: 535,
									derived: 47660,
									attached: 54108,
									binds: [
										{ how: 424, pick: 20268, value: { cls: 11730, sp: 31648 } },
										{ how: 61648, pick: 41888, value: { cls: 40297, sp: 4069 } },
										{ how: 35235, pick: 12986, value: { cls: 12314, sp: 6965 } },
										{ how: 61907, pick: 64414, value: { cls: 47619, sp: 10371 } },
										{ how: 30067, pick: 19682, value: { cls: 17327, sp: 65528 } },
										{ how: 38017, pick: 34694, value: { cls: 7456, sp: 41804 } },
										{ how: 22945, pick: 16948, value: { cls: 15143, sp: 33410 } }
									]
								}
							],
							where: [],
							negation: { source: 54001, picks: [36738, 16756] },
							head: {
								vars: [],
								names: [15679, 18021, 65467, 3001, 55682, 41010],
								folds: [{ fn: 20339, arg: 47319, padded: 17833, scale: 11505 }]
							}
						}
					},
					take: { rotate: 28110, dirs: [0, 10130, 5151], size: 17417, ties: 30585 },
					literalHead: { name: 2897, kind: 18854, arms: 1657, values: [10263, 57710, 53144] },
					importable: 64472,
					bindImport: 60259,
					named: 6648,
					relationParam: { relation: 51347, facts: [] },
					closure: { relation: 19894, pair: 44410, name: 25979 },
					attachments: [],
					order: { rotate: 32861, dirs: [28780, 55012, 6700], size: 4081 },
					probe: { kind: 16283, pick: 50564 },
					key: { relation: 54720, which: 43671, fact: 11342, absent: 42834, roster: 14268 }
				},
				{
					rule: {
						matches: [
							{
								source: 54299,
								derived: 57816,
								attached: 20157,
								binds: [
									{ how: 1220, pick: 26790, value: { cls: 65481, sp: 3296 } },
									{ how: 19798, pick: 65534, value: { cls: 59122, sp: 45813 } },
									{ how: 32785, pick: 21577, value: { cls: 18669, sp: 13920 } },
									{ how: 62554, pick: 30027, value: { cls: 43460, sp: 65529 } },
									{ how: 21870, pick: 60252, value: { cls: 47070, sp: 45380 } },
									{ how: 0, pick: 42373, value: { cls: 51988, sp: 23053 } },
									{ how: 29945, pick: 55303, value: { cls: 26379, sp: 41781 } }
								]
							}
						],
						where: [],
						between: [],
						inSet: [],
						allen: [],
						pointIn: [],
						connective: [],
						computed: [],
						negation: { source: 29455, picks: [29854, 0] },
						head: {
							vars: [],
							names: [36471, 4, 45665, 25760, 0, 53021],
							folds: [{ fn: 42660, arg: 42543, padded: 48620, scale: 21725 }]
						},
						interior: {
							matches: [
								{
									source: 62166,
									derived: 0,
									attached: 65534,
									binds: [
										{ how: 39871, pick: 40986, value: { cls: 51479, sp: 19380 } },
										{ how: 64882, pick: 10324, value: { cls: 65524, sp: 52233 } },
										{ how: 65521, pick: 40551, value: { cls: 1582, sp: 57813 } },
										{ how: 53731, pick: 36072, value: { cls: 26998, sp: 65474 } },
										{ how: 28049, pick: 49663, value: { cls: 59118, sp: 2 } },
										{ how: 47382, pick: 55238, value: { cls: 39034, sp: 20487 } },
										{ how: 19953, pick: 11290, value: { cls: 11136, sp: 65535 } }
									]
								}
							],
							where: [],
							negation: { source: 10425, picks: [902, 25551] },
							head: {
								vars: [],
								names: [64942, 60503, 24, 21781, 29991, 63427],
								folds: [{ fn: 30749, arg: 47950, padded: 43523, scale: 6650 }]
							}
						}
					},
					take: { rotate: 3166, dirs: [57139, 51031, 46939], size: 42621, ties: 22937 },
					literalHead: { name: 49732, kind: 55390, arms: 12126, values: [2037, 52486, 37194] },
					importable: 0,
					bindImport: 1959,
					named: 441,
					relationParam: { relation: 62406, facts: [] },
					closure: { relation: 65494, pair: 12695, name: 61772 },
					attachments: [],
					order: { rotate: 27241, dirs: [16515, 7745, 2059], size: 37029 },
					probe: { kind: 579, pick: 55791 },
					key: { relation: 7240, which: 47464, fact: 16069, absent: 63666, roster: 2267 }
				}
			],
			planted: {
				names: [
					45480, 58728, 16152, 16285, 34604, 59149, 23836, 13179, 36374, 59908, 50118, 21539, 54857,
					53932, 21986, 26527, 41699, 24620, 39561, 18190, 57862, 13992, 36787, 55450, 59508, 22525,
					49956, 63876, 14958, 58258, 12498, 20229, 3741, 16896, 37, 27263, 47063, 63782, 13996,
					17645, 0, 57761, 34782, 56883, 8500, 0, 1
				],
				value: { cls: 2, sp: 1 },
				handle: 0,
				padding: 2,
				side: { kind: 0, values: [0, 2, 0] }
			}
		},
		draws: "0.0.1.0.0.0.0.0.1.0.0.0.2.0.0.1.0.0.0.0.0.0.0.0.0.0",
		reaches: [
			"a workload installed",
			"overlap probe served",
			"ordered probe served",
			"served by a created index",
			"a created index needed"
		]
	},
	{
		note: "a span predicate on Rel1x0's (Bool, span40), Bool a text field of its key the load fills with two ideographs, whose GiST index, led by that text, btree_gist prices by its leading bytes through PostgreSQL 19: the predicate's one row takes 26 buffers of the index's 207 pages",
		sketch: {
			population: "swarm",
			swarm: {
				"bind fresh": 1,
				"bind param": 1,
				negation: 1,
				"key read": 1,
				spelled: 3,
				"handle field": 1,
				interior: 1,
				recursive: 1,
				"typmod param": 1,
				allen: 1,
				"point in": 3
			},
			perturbation: { settings: [], multiplier: 1 },
			ambient: { path: { kind: "default" }, settings: [] },
			restorage: { shift: 0, respell: 0 },
			roster: 0,
			span: 0,
			relations: [
				{ name: 0, fields: [{ name: 0, kind: 0, key: 0 }], candidate: 0, facts: [] },
				{
					name: 0,
					fields: [
						{ name: 0, kind: 29128, key: 0 },
						{ name: 0, kind: 0, key: 0 },
						{ name: 0, kind: 0, key: 32768 }
					],
					candidate: 0,
					facts: []
				}
			],
			reads: [
				{
					rule: {
						matches: [match(32768, 0), match(32768, 0)],
						where: [],
						between: [],
						inSet: [],
						allen: [],
						pointIn: [],
						connective: [],
						computed: [],
						negation: { source: 32768, picks: [0, 43691] },
						head: { vars: [], names: zeros(6), folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }] },
						interior: {
							matches: [match(0, 0)],
							where: [],
							negation,
							head: { vars: [], names: zeros(6), folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }] }
						}
					},
					take: { rotate: 0, dirs: zeros(3), size: 0, ties: 0 },
					literalHead: { name: 0, kind: 0, arms: 0, values: zeros(3) },
					importable: 0,
					bindImport: 0,
					named: 0,
					relationParam: { relation: 0, facts: [] },
					closure: { relation: 0, pair: 0, name: 0 },
					attachments: [],
					order: { rotate: 0, dirs: zeros(3), size: 0 },
					probe: { kind: 0, pick: 0 },
					key: { relation: 0, which: 0, fact: 0, absent: 0, roster: 0 }
				}
			],
			planted: {
				names: zeros(47),
				value: floorValue,
				handle: 0,
				padding: 0,
				side: { kind: 0, values: zeros(3) }
			}
		},
		draws: "0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0",
		reaches: [
			"a workload installed",
			"overlap probe served",
			"served by a created index",
			"swept through a GiST index led by multibyte text, which btree_gist prices by its leading bytes",
			"a created index needed"
		]
	},
	{
		note: "a join key on Rel1x0's (Bool, tick0) planned on the B-tree a range creates on (tick0, field1, Bool), led by tick0, whose field1 the join key leaves unbound is a boolean: PostgreSQL reads the join key by a skip scan over field1 in 2 descents within tick0's rows, as many as a boolean holds",
		sketch: {
			population: "forms",
			swarm: {
				"bind fresh": 1,
				"bind join": 1,
				"bind existential": 1,
				"bind literal": 1,
				"bind param": 3,
				"bind parent": 1,
				where: 3,
				"compare literal": 1,
				"compare var": 1,
				"compare param": 3,
				aggregate: 2,
				union: 3,
				take: 3,
				"attached take": 1,
				ordered: 1,
				attach: 1,
				nested: 1,
				roster: 1,
				dense: 3,
				"candidate key": 1,
				probe: 3,
				spelled: 1,
				"full head": 1,
				"stated delivery": 1,
				"plain child": 1,
				"keyed child": 1,
				"reflexive child": 1,
				"arm child": 1,
				"handle field": 1,
				import: 3,
				"import bound": 3,
				interior: 3,
				named: 3,
				"computed head": 3,
				"computed group key": 3,
				between: 3,
				"in set": 3,
				connective: 3,
				"relation param": 3,
				recursive: 3,
				"contract param": 3,
				"typmod param": 3,
				allen: 3,
				"point in": 3,
				"literal head": 3
			},
			perturbation: { settings: [], multiplier: 1 },
			ambient: { path: { kind: "default" }, settings: [] },
			restorage: { shift: 0, respell: 0 },
			roster: 0,
			span: 0,
			relations: [
				{ name: 0, fields: [{ name: 0, kind: 7282, key: 0 }], candidate: 0, facts: [] },
				{
					name: 0,
					fields: [
						{ name: 0, kind: 0, key: 0 },
						{ name: 0, kind: 0, key: 0 },
						{ name: 0, kind: 24576, key: 32768 },
						{ name: 0, kind: 16384, key: 0 }
					],
					candidate: 0,
					facts: []
				},
				{ name: 0, fields: [{ name: 0, kind: 0, key: 0 }], candidate: 0, facts: [] }
			],
			reads: [
				{
					rule: {
						matches: [
							{
								source: 21846,
								derived: 0,
								attached: 0,
								binds: [
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
								]
							},
							{
								source: 49152,
								derived: 0,
								attached: 0,
								binds: [
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
									{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
								]
							}
						],
						where: [
							{ left: 21846, op: 0, pick: 0, value: { cls: 0, sp: 0 } },
							{ left: 0, op: 0, pick: 0, value: { cls: 0, sp: 0 } }
						],
						between: [
							{
								left: 0,
								low: { pick: 0, value: { cls: 0, sp: 0 } },
								high: { pick: 0, value: { cls: 0, sp: 0 } }
							}
						],
						inSet: [],
						allen: [],
						pointIn: [],
						connective: [
							{ kind: 0, args: [{ left: 0, op: 0, pick: 0, value: { cls: 0, sp: 0 } }] }
						],
						computed: [],
						negation: { source: 0, picks: [0, 0] },
						head: {
							vars: [],
							names: [0, 0, 0, 0, 0, 0],
							folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }]
						},
						interior: {
							matches: [
								{
									source: 0,
									derived: 0,
									attached: 0,
									binds: [
										{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
										{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
									]
								}
							],
							where: [],
							negation: { source: 0, picks: [0, 0] },
							head: {
								vars: [],
								names: [0, 0, 0, 0, 0, 0],
								folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }]
							}
						}
					},
					take: { rotate: 0, dirs: [0, 0, 0], size: 0, ties: 0 },
					literalHead: { name: 0, kind: 0, arms: 0, values: [0, 0, 0] },
					importable: 0,
					bindImport: 0,
					named: 0,
					relationParam: { relation: 0, facts: [] },
					closure: { relation: 0, pair: 0, name: 0 },
					attachments: [
						{
							name: 0,
							link: 0,
							handle: 0,
							delivery: 0,
							rule: {
								matches: [
									{
										source: 0,
										derived: 0,
										attached: 0,
										binds: [
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
										]
									},
									{
										source: 21846,
										derived: 0,
										attached: 0,
										binds: [
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
											{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
										]
									}
								],
								where: [],
								between: [],
								inSet: [],
								allen: [],
								pointIn: [],
								connective: [],
								computed: [],
								negation: { source: 0, picks: [0, 0] },
								head: {
									vars: [],
									names: [0, 0, 0, 0, 0, 0],
									folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }]
								},
								interior: {
									matches: [
										{
											source: 0,
											derived: 0,
											attached: 0,
											binds: [
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
											]
										}
									],
									where: [],
									negation: { source: 0, picks: [0, 0] },
									head: {
										vars: [],
										names: [0, 0, 0, 0, 0, 0],
										folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }]
									}
								}
							},
							take: { rotate: 0, dirs: [0, 0, 0], size: 0 },
							nested: {
								name: 0,
								link: 0,
								handle: 0,
								delivery: 0,
								rule: {
									matches: [
										{
											source: 0,
											derived: 0,
											attached: 0,
											binds: [
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
												{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
											]
										}
									],
									where: [],
									between: [],
									inSet: [],
									allen: [],
									pointIn: [],
									connective: [],
									computed: [],
									negation: { source: 0, picks: [0, 0] },
									head: {
										vars: [],
										names: [0, 0, 0, 0, 0, 0],
										folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }]
									},
									interior: {
										matches: [
											{
												source: 0,
												derived: 0,
												attached: 0,
												binds: [
													{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
													{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
													{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
													{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
													{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
													{ how: 0, pick: 0, value: { cls: 0, sp: 0 } },
													{ how: 0, pick: 0, value: { cls: 0, sp: 0 } }
												]
											}
										],
										where: [],
										negation: { source: 0, picks: [0, 0] },
										head: {
											vars: [],
											names: [0, 0, 0, 0, 0, 0],
											folds: [{ fn: 0, arg: 0, padded: 0, scale: 0 }]
										}
									}
								},
								take: { rotate: 0, dirs: [0, 0, 0], size: 0 }
							}
						}
					],
					order: { rotate: 0, dirs: [0, 0, 0], size: 0 },
					probe: { kind: 0, pick: 0 },
					key: { relation: 0, which: 0, fact: 0, absent: 0, roster: 0 }
				}
			],
			planted: {
				names: [
					0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
					0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
				],
				value: { cls: 0, sp: 0 },
				handle: 0,
				padding: 0,
				side: { kind: 0, values: [0, 0, 0] }
			}
		},
		draws:
			"0.2.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.2.0.0.1.2.0.1.1.2.0.0.0.0.0.0.3.0.0.0.0.1.0.1.0.0.0",
		reaches: [
			"a workload installed",
			"equality probe served",
			"range probe served",
			"served by a created index",
			"read by a skip scan over closed keys after a fixed lead",
			"a created index needed"
		]
	},
	{
		note: "a range on Overlaps' JsonbPretty, a closed handle, by equality and its fixed0, a numeric of many values, by a range, beside span predicates whose GiST index holds both: GiST places its entries by fixed0, so its scan would read the range across every handle, and the range is planned on a B-tree of its own",
		sketch: {
			population: "forms",
			swarm: {
				"bind join": 2,
				"bind existential": 3,
				"bind param": 3,
				"bind parent": 1,
				where: 3,
				"compare literal": 2,
				"compare param": 3,
				negation: 1,
				union: 3,
				"attached take": 3,
				ordered: 2,
				attach: 1,
				nested: 1,
				roster: 1,
				dense: 3,
				"candidate key": 1,
				probe: 2,
				spelled: 3,
				"full head": 3,
				"stated delivery": 1,
				"plain child": 3,
				"keyed child": 2,
				"reflexive child": 1,
				"arm child": 1,
				"handle field": 3,
				import: 3,
				"import bound": 3,
				interior: 3,
				named: 3,
				"computed head": 3,
				"computed group key": 3,
				between: 3,
				"in set": 3,
				connective: 3,
				"relation param": 3,
				recursive: 3,
				"contract param": 3,
				"typmod param": 3,
				allen: 3,
				"point in": 3,
				"literal head": 3
			},
			perturbation: {
				settings: [
					"enable_hashjoin = off",
					"enable_mergejoin = off",
					"plan_cache_mode = force_generic_plan",
					"parallel_tuple_cost = 0"
				],
				multiplier: 1
			},
			ambient: {
				path: { kind: "grizzleFirst" },
				settings: [
					{ parameter: "extra_float_digits", value: "-15" },
					{ parameter: "DateStyle", value: "SQL, DMY" },
					{ parameter: "IntervalStyle", value: "postgres_verbose" },
					{ parameter: "bytea_output", value: "hex" }
				]
			},
			restorage: { shift: 20, respell: 307 },
			roster: 16278,
			span: 2405,
			relations: [
				{
					name: 15808,
					fields: [
						{ name: 53523, kind: 43840, key: 64870 },
						{ name: 59244, kind: 37327, key: 39640 }
					],
					candidate: 26278,
					facts: []
				}
			],
			reads: [
				{
					rule: {
						matches: [
							{
								source: 0,
								derived: 64291,
								attached: 43767,
								binds: [
									{ how: 37555, pick: 27524, value: { cls: 49374, sp: 1516 } },
									{ how: 7748, pick: 55268, value: { cls: 29927, sp: 33887 } },
									{ how: 23298, pick: 2147, value: { cls: 53534, sp: 27584 } },
									{ how: 3282, pick: 4937, value: { cls: 401, sp: 59876 } },
									{ how: 59280, pick: 65449, value: { cls: 28168, sp: 64324 } },
									{ how: 41436, pick: 10487, value: { cls: 60963, sp: 6 } },
									{ how: 42788, pick: 24769, value: { cls: 20661, sp: 16578 } }
								]
							}
						],
						where: [{ left: 38686, op: 54038, pick: 37604, value: { cls: 51641, sp: 6774 } }],
						between: [
							{
								left: 20701,
								low: { pick: 57237, value: { cls: 44455, sp: 50277 } },
								high: { pick: 65008, value: { cls: 6877, sp: 10560 } }
							}
						],
						inSet: [{ left: 28509, values: [] }],
						allen: [{ left: 2, mask: 6685, right: 60500 }],
						pointIn: [{ span: 17455, point: 1609 }],
						connective: [],
						computed: [
							{
								kind: 49547,
								reading: 19987,
								arg: 47491,
								op: 65535,
								than: { cls: 38635, sp: 16730 },
								otherwise: { cls: 48947, sp: 12925 },
								scale: 27244,
								padded: 29494
							}
						],
						negation: { source: 61306, picks: [64484, 42170] },
						head: {
							vars: [],
							names: [6, 43698, 3825, 36990, 27330, 14355],
							folds: [
								{ fn: 43802, arg: 33049, padded: 43049, scale: 12844 },
								{ fn: 42686, arg: 50526, padded: 36686, scale: 44489 }
							]
						},
						interior: {
							matches: [
								{
									source: 65528,
									derived: 53540,
									attached: 55380,
									binds: [
										{ how: 42107, pick: 63020, value: { cls: 44792, sp: 3575 } },
										{ how: 45640, pick: 27905, value: { cls: 9140, sp: 53039 } },
										{ how: 55103, pick: 18831, value: { cls: 10, sp: 10026 } },
										{ how: 9917, pick: 54, value: { cls: 51577, sp: 47191 } },
										{ how: 18792, pick: 11639, value: { cls: 59982, sp: 42177 } },
										{ how: 31067, pick: 6617, value: { cls: 6498, sp: 57374 } },
										{ how: 55624, pick: 35662, value: { cls: 14127, sp: 44078 } }
									]
								}
							],
							where: [],
							negation: { source: 8295, picks: [58239, 42972] },
							head: {
								vars: [150, 26312],
								names: [9613, 65472, 45806, 7598, 5775, 52550],
								folds: [{ fn: 55027, arg: 44895, padded: 31569, scale: 29906 }]
							}
						}
					},
					take: { rotate: 15542, dirs: [6911, 21951, 51802], size: 14930, ties: 64065 },
					literalHead: { name: 22778, kind: 3930, arms: 14367, values: [12672, 22880, 2] },
					importable: 5896,
					bindImport: 13661,
					named: 29646,
					relationParam: {
						relation: 3565,
						facts: [
							{
								values: [
									{ cls: 6893, sp: 11890 },
									{ cls: 7067, sp: 45097 },
									{ cls: 59260, sp: 59583 },
									{ cls: 45588, sp: 37703 },
									{ cls: 63952, sp: 55919 },
									{ cls: 53303, sp: 31593 },
									{ cls: 33578, sp: 14731 }
								]
							},
							{
								values: [
									{ cls: 64650, sp: 60243 },
									{ cls: 2918, sp: 53339 },
									{ cls: 15093, sp: 2414 },
									{ cls: 41693, sp: 65535 },
									{ cls: 27867, sp: 18555 },
									{ cls: 19663, sp: 23306 },
									{ cls: 38221, sp: 409 }
								]
							}
						]
					},
					closure: { relation: 40, pair: 60501, name: 63939 },
					attachments: [],
					order: { rotate: 65535, dirs: [65328, 36233, 19400], size: 61993 },
					probe: { kind: 5300, pick: 63266 },
					key: { relation: 11615, which: 60076, fact: 26252, absent: 36817, roster: 65495 }
				},
				{
					rule: {
						matches: [
							{
								source: 33795,
								derived: 46284,
								attached: 15579,
								binds: [
									{ how: 55758, pick: 65228, value: { cls: 470, sp: 65424 } },
									{ how: 21578, pick: 63814, value: { cls: 27243, sp: 21433 } },
									{ how: 43717, pick: 13525, value: { cls: 50827, sp: 52142 } },
									{ how: 24749, pick: 47301, value: { cls: 65530, sp: 49558 } },
									{ how: 30434, pick: 15852, value: { cls: 37047, sp: 53002 } },
									{ how: 45225, pick: 50967, value: { cls: 65534, sp: 10 } },
									{ how: 8910, pick: 64536, value: { cls: 7023, sp: 31678 } }
								]
							},
							{
								source: 28707,
								derived: 28163,
								attached: 20599,
								binds: [
									{ how: 52566, pick: 21932, value: { cls: 43059, sp: 24188 } },
									{ how: 59929, pick: 1422, value: { cls: 9984, sp: 62679 } },
									{ how: 45128, pick: 11180, value: { cls: 53628, sp: 64169 } },
									{ how: 44296, pick: 34436, value: { cls: 7, sp: 39511 } },
									{ how: 15207, pick: 130, value: { cls: 33400, sp: 32902 } },
									{ how: 24101, pick: 31555, value: { cls: 48290, sp: 29718 } },
									{ how: 38976, pick: 2473, value: { cls: 46365, sp: 1 } }
								]
							},
							{
								source: 4929,
								derived: 6890,
								attached: 51783,
								binds: [
									{ how: 27523, pick: 20795, value: { cls: 27898, sp: 13453 } },
									{ how: 34359, pick: 58313, value: { cls: 47970, sp: 7999 } },
									{ how: 1026, pick: 56211, value: { cls: 8480, sp: 59306 } },
									{ how: 23449, pick: 13828, value: { cls: 6804, sp: 8992 } },
									{ how: 36934, pick: 8492, value: { cls: 10172, sp: 62036 } },
									{ how: 8741, pick: 7317, value: { cls: 62390, sp: 44343 } },
									{ how: 37435, pick: 44234, value: { cls: 41300, sp: 39676 } }
								]
							}
						],
						where: [
							{ left: 4957, op: 65276, pick: 41972, value: { cls: 15669, sp: 4711 } },
							{ left: 34722, op: 39796, pick: 61341, value: { cls: 54036, sp: 16410 } }
						],
						between: [
							{
								left: 38157,
								low: { pick: 39807, value: { cls: 36204, sp: 2926 } },
								high: { pick: 1, value: { cls: 58527, sp: 45558 } }
							}
						],
						inSet: [
							{
								left: 56975,
								values: [
									{ cls: 22987, sp: 13456 },
									{ cls: 43120, sp: 5031 },
									{ cls: 1, sp: 47337 }
								]
							}
						],
						allen: [{ left: 63981, mask: 44638, right: 24978 }],
						pointIn: [],
						connective: [],
						computed: [],
						negation: { source: 807, picks: [49805, 13148] },
						head: {
							vars: [12076, 58068],
							names: [40519, 59648, 14875, 4699, 50758, 13710],
							folds: [{ fn: 29398, arg: 4981, padded: 26, scale: 42669 }]
						},
						interior: {
							matches: [
								{
									source: 11609,
									derived: 26261,
									attached: 65004,
									binds: [
										{ how: 46155, pick: 65519, value: { cls: 20776, sp: 65512 } },
										{ how: 18520, pick: 50658, value: { cls: 46179, sp: 2051 } },
										{ how: 2, pick: 20676, value: { cls: 2678, sp: 52107 } },
										{ how: 40495, pick: 6695, value: { cls: 4492, sp: 16712 } },
										{ how: 15796, pick: 20281, value: { cls: 30885, sp: 24516 } },
										{ how: 51967, pick: 42409, value: { cls: 26366, sp: 61057 } },
										{ how: 43296, pick: 1751, value: { cls: 20716, sp: 39849 } }
									]
								}
							],
							where: [],
							negation: { source: 39781, picks: [30166, 50222] },
							head: {
								vars: [],
								names: [55048, 80, 53261, 58492, 62245, 61226],
								folds: [
									{ fn: 23839, arg: 37792, padded: 30384, scale: 14369 },
									{ fn: 55927, arg: 61996, padded: 16280, scale: 31622 }
								]
							}
						}
					},
					take: { rotate: 6691, dirs: [45885, 37080, 25586], size: 16980, ties: 56 },
					literalHead: { name: 19095, kind: 22339, arms: 40053, values: [44916, 7554, 42356] },
					importable: 17128,
					bindImport: 15077,
					named: 58446,
					relationParam: {
						relation: 34448,
						facts: [
							{
								values: [
									{ cls: 48563, sp: 9989 },
									{ cls: 65534, sp: 39352 },
									{ cls: 19829, sp: 59493 },
									{ cls: 5066, sp: 39093 },
									{ cls: 37443, sp: 6807 },
									{ cls: 50599, sp: 62102 },
									{ cls: 13224, sp: 7139 }
								]
							},
							{
								values: [
									{ cls: 58590, sp: 32921 },
									{ cls: 53246, sp: 46721 },
									{ cls: 25812, sp: 9726 },
									{ cls: 1043, sp: 12847 },
									{ cls: 36709, sp: 64910 },
									{ cls: 54824, sp: 16268 },
									{ cls: 45432, sp: 81 }
								]
							}
						]
					},
					closure: { relation: 2538, pair: 28512, name: 56269 },
					attachments: [
						{
							name: 18988,
							link: 56656,
							handle: 46238,
							delivery: 19643,
							rule: {
								matches: [
									{
										source: 35018,
										derived: 34625,
										attached: 10223,
										binds: [
											{ how: 28678, pick: 30394, value: { cls: 44707, sp: 50560 } },
											{ how: 18777, pick: 3525, value: { cls: 55575, sp: 54756 } },
											{ how: 25897, pick: 31398, value: { cls: 29090, sp: 5720 } },
											{ how: 3844, pick: 16776, value: { cls: 32658, sp: 59375 } },
											{ how: 46986, pick: 57650, value: { cls: 13711, sp: 39138 } },
											{ how: 18082, pick: 51992, value: { cls: 36091, sp: 26352 } },
											{ how: 98, pick: 62129, value: { cls: 32532, sp: 28257 } }
										]
									},
									{
										source: 22750,
										derived: 17643,
										attached: 49131,
										binds: [
											{ how: 41696, pick: 65506, value: { cls: 10554, sp: 43297 } },
											{ how: 34560, pick: 30943, value: { cls: 20997, sp: 6037 } },
											{ how: 43696, pick: 59815, value: { cls: 23984, sp: 39730 } },
											{ how: 835, pick: 64566, value: { cls: 21386, sp: 0 } },
											{ how: 45531, pick: 19488, value: { cls: 59495, sp: 61478 } },
											{ how: 21610, pick: 37590, value: { cls: 40187, sp: 9418 } },
											{ how: 16558, pick: 282, value: { cls: 60177, sp: 53286 } }
										]
									}
								],
								where: [
									{ left: 64389, op: 59666, pick: 61804, value: { cls: 52300, sp: 8007 } },
									{ left: 96, op: 21887, pick: 20767, value: { cls: 63577, sp: 29717 } }
								],
								between: [],
								inSet: [],
								allen: [{ left: 16908, mask: 63596, right: 21266 }],
								pointIn: [{ span: 14418, point: 63141 }],
								connective: [],
								computed: [],
								negation: { source: 35479, picks: [0, 39455] },
								head: {
									vars: [],
									names: [40546, 3974, 13917, 24228, 17778, 32587],
									folds: [{ fn: 50749, arg: 8771, padded: 13907, scale: 23345 }]
								},
								interior: {
									matches: [
										{
											source: 9037,
											derived: 9592,
											attached: 38168,
											binds: [
												{ how: 3979, pick: 1912, value: { cls: 32362, sp: 36897 } },
												{ how: 8900, pick: 39860, value: { cls: 55871, sp: 30514 } },
												{ how: 60910, pick: 60887, value: { cls: 65532, sp: 18583 } },
												{ how: 5, pick: 34929, value: { cls: 47771, sp: 37847 } },
												{ how: 9021, pick: 62163, value: { cls: 23525, sp: 57209 } },
												{ how: 18295, pick: 22499, value: { cls: 7526, sp: 9906 } },
												{ how: 53301, pick: 55068, value: { cls: 34379, sp: 64652 } }
											]
										}
									],
									where: [],
									negation: { source: 34059, picks: [11940, 8172] },
									head: {
										vars: [63514, 57059],
										names: [48607, 3154, 57611, 58642, 39642, 28723],
										folds: [{ fn: 37352, arg: 10818, padded: 49953, scale: 19260 }]
									}
								}
							},
							take: { rotate: 33182, dirs: [31990, 35601, 149], size: 4061 },
							nested: {
								name: 37370,
								link: 48915,
								handle: 31134,
								delivery: 927,
								rule: {
									matches: [
										{
											source: 65525,
											derived: 62701,
											attached: 16937,
											binds: [
												{ how: 12, pick: 33841, value: { cls: 19187, sp: 27097 } },
												{ how: 51988, pick: 65375, value: { cls: 4028, sp: 17136 } },
												{ how: 45479, pick: 56464, value: { cls: 3610, sp: 65306 } },
												{ how: 64033, pick: 65509, value: { cls: 27098, sp: 53865 } },
												{ how: 19417, pick: 48476, value: { cls: 36213, sp: 20846 } },
												{ how: 53593, pick: 55351, value: { cls: 42263, sp: 45808 } },
												{ how: 13411, pick: 63830, value: { cls: 31000, sp: 37738 } }
											]
										},
										{
											source: 61232,
											derived: 46055,
											attached: 30897,
											binds: [
												{ how: 45036, pick: 22928, value: { cls: 65534, sp: 34665 } },
												{ how: 32166, pick: 58673, value: { cls: 60404, sp: 9252 } },
												{ how: 63844, pick: 10586, value: { cls: 25374, sp: 0 } },
												{ how: 55245, pick: 62267, value: { cls: 18217, sp: 52302 } },
												{ how: 940, pick: 40046, value: { cls: 45338, sp: 46416 } },
												{ how: 57367, pick: 6904, value: { cls: 28844, sp: 9816 } },
												{ how: 47856, pick: 26229, value: { cls: 28071, sp: 19207 } }
											]
										}
									],
									where: [],
									between: [
										{
											left: 61647,
											low: { pick: 29210, value: { cls: 55861, sp: 4610 } },
											high: { pick: 23507, value: { cls: 23853, sp: 2 } }
										}
									],
									inSet: [{ left: 16625, values: [{ cls: 64789, sp: 39399 }] }],
									allen: [],
									pointIn: [{ span: 50967, point: 2865 }],
									connective: [
										{
											kind: 16314,
											args: [
												{ left: 65529, op: 18653, pick: 48023, value: { cls: 53607, sp: 15238 } }
											]
										}
									],
									computed: [
										{
											kind: 35573,
											reading: 3135,
											arg: 29732,
											op: 28659,
											than: { cls: 52980, sp: 14033 },
											otherwise: { cls: 20081, sp: 56831 },
											scale: 1421,
											padded: 6131
										},
										{
											kind: 62554,
											reading: 65523,
											arg: 32084,
											op: 29287,
											than: { cls: 4404, sp: 47110 },
											otherwise: { cls: 48706, sp: 33552 },
											scale: 624,
											padded: 8161
										}
									],
									negation: { source: 61966, picks: [64805, 38729] },
									head: {
										vars: [39771, 59652],
										names: [16271, 30683, 33446, 64977, 7810, 44984],
										folds: [{ fn: 60543, arg: 5161, padded: 51469, scale: 25192 }]
									},
									interior: {
										matches: [
											{
												source: 15392,
												derived: 42574,
												attached: 97,
												binds: [
													{ how: 21280, pick: 614, value: { cls: 7433, sp: 65526 } },
													{ how: 39244, pick: 5343, value: { cls: 29427, sp: 2045 } },
													{ how: 21251, pick: 45974, value: { cls: 19914, sp: 10026 } },
													{ how: 20325, pick: 56821, value: { cls: 130, sp: 20828 } },
													{ how: 24753, pick: 54204, value: { cls: 55342, sp: 50355 } },
													{ how: 37980, pick: 50619, value: { cls: 3553, sp: 28487 } },
													{ how: 38253, pick: 22347, value: { cls: 54833, sp: 56842 } }
												]
											},
											{
												source: 51127,
												derived: 59033,
												attached: 16468,
												binds: [
													{ how: 55666, pick: 47986, value: { cls: 38070, sp: 13132 } },
													{ how: 50376, pick: 53647, value: { cls: 30471, sp: 7502 } },
													{ how: 42, pick: 41160, value: { cls: 3997, sp: 1294 } },
													{ how: 18747, pick: 15233, value: { cls: 2123, sp: 39198 } },
													{ how: 56822, pick: 23104, value: { cls: 48262, sp: 58938 } },
													{ how: 35690, pick: 30209, value: { cls: 38177, sp: 14766 } },
													{ how: 57934, pick: 45343, value: { cls: 6000, sp: 53573 } }
												]
											}
										],
										where: [],
										negation: { source: 416, picks: [62772, 27313] },
										head: {
											vars: [22018, 45740, 14504],
											names: [4659, 15331, 33982, 3128, 34619, 36820],
											folds: [
												{ fn: 56148, arg: 21000, padded: 7814, scale: 46043 },
												{ fn: 66, arg: 65386, padded: 51767, scale: 4939 }
											]
										}
									}
								},
								take: { rotate: 64308, dirs: [15272, 65532, 18262], size: 65432 }
							}
						}
					],
					order: { rotate: 62903, dirs: [40024, 24403, 50043], size: 13851 },
					probe: { kind: 43517, pick: 14120 },
					key: { relation: 57070, which: 54075, fact: 54330, absent: 50620, roster: 50441 }
				},
				{
					rule: {
						matches: [
							{
								source: 46438,
								derived: 29298,
								attached: 26943,
								binds: [
									{ how: 43664, pick: 35459, value: { cls: 10804, sp: 52760 } },
									{ how: 29259, pick: 65531, value: { cls: 48818, sp: 61784 } },
									{ how: 54971, pick: 36671, value: { cls: 48055, sp: 61383 } },
									{ how: 63024, pick: 9358, value: { cls: 27975, sp: 59650 } },
									{ how: 86, pick: 17488, value: { cls: 7968, sp: 7690 } },
									{ how: 64125, pick: 65388, value: { cls: 28489, sp: 45843 } },
									{ how: 60797, pick: 59537, value: { cls: 35854, sp: 53519 } }
								]
							}
						],
						where: [{ left: 46923, op: 17420, pick: 8183, value: { cls: 5, sp: 35113 } }],
						between: [],
						inSet: [],
						allen: [],
						pointIn: [],
						connective: [],
						computed: [
							{
								kind: 46592,
								reading: 27641,
								arg: 57303,
								op: 4668,
								than: { cls: 63874, sp: 28257 },
								otherwise: { cls: 45394, sp: 40468 },
								scale: 16149,
								padded: 6243
							},
							{
								kind: 65411,
								reading: 55006,
								arg: 38089,
								op: 43603,
								than: { cls: 30419, sp: 52204 },
								otherwise: { cls: 9835, sp: 16042 },
								scale: 52502,
								padded: 30990
							}
						],
						negation: { source: 53463, picks: [6627, 59125] },
						head: {
							vars: [],
							names: [24080, 64876, 56894, 38311, 19583, 52357],
							folds: [{ fn: 8927, arg: 49110, padded: 65494, scale: 41492 }]
						},
						interior: {
							matches: [
								{
									source: 63618,
									derived: 18222,
									attached: 38380,
									binds: [
										{ how: 4170, pick: 7356, value: { cls: 13720, sp: 5281 } },
										{ how: 15665, pick: 65246, value: { cls: 45336, sp: 23019 } },
										{ how: 2685, pick: 65506, value: { cls: 33550, sp: 65531 } },
										{ how: 25058, pick: 41572, value: { cls: 53940, sp: 1 } },
										{ how: 29803, pick: 21384, value: { cls: 29184, sp: 61081 } },
										{ how: 2404, pick: 5714, value: { cls: 32624, sp: 15716 } },
										{ how: 60775, pick: 45141, value: { cls: 65280, sp: 36320 } }
									]
								},
								{
									source: 65535,
									derived: 41733,
									attached: 58564,
									binds: [
										{ how: 4229, pick: 41073, value: { cls: 16774, sp: 5809 } },
										{ how: 27488, pick: 27647, value: { cls: 61099, sp: 4603 } },
										{ how: 60095, pick: 8723, value: { cls: 13984, sp: 45635 } },
										{ how: 1, pick: 36747, value: { cls: 11136, sp: 21294 } },
										{ how: 61284, pick: 33915, value: { cls: 13586, sp: 47991 } },
										{ how: 23302, pick: 30472, value: { cls: 60213, sp: 61749 } },
										{ how: 64535, pick: 48087, value: { cls: 17219, sp: 52099 } }
									]
								}
							],
							where: [
								{ left: 51934, op: 36253, pick: 14959, value: { cls: 1843, sp: 103 } },
								{ left: 32976, op: 21907, pick: 62779, value: { cls: 27914, sp: 9553 } }
							],
							negation: { source: 29773, picks: [36005, 6689] },
							head: {
								vars: [51374],
								names: [59938, 54271, 9911, 38843, 13305, 64395],
								folds: [
									{ fn: 49788, arg: 60027, padded: 20211, scale: 10201 },
									{ fn: 27, arg: 55592, padded: 16755, scale: 53585 }
								]
							}
						}
					},
					take: { rotate: 4513, dirs: [50934, 34228, 61154], size: 40938, ties: 59358 },
					literalHead: { name: 61486, kind: 28477, arms: 3334, values: [22119, 8833, 7781] },
					importable: 44573,
					bindImport: 58218,
					named: 5070,
					relationParam: {
						relation: 51239,
						facts: [
							{
								values: [
									{ cls: 65532, sp: 21672 },
									{ cls: 32210, sp: 33734 },
									{ cls: 32989, sp: 16117 },
									{ cls: 51441, sp: 7027 },
									{ cls: 25453, sp: 9219 },
									{ cls: 14891, sp: 42984 },
									{ cls: 15938, sp: 1300 }
								]
							},
							{
								values: [
									{ cls: 62107, sp: 47771 },
									{ cls: 39236, sp: 26611 },
									{ cls: 1469, sp: 439 },
									{ cls: 31169, sp: 65535 },
									{ cls: 452, sp: 3836 },
									{ cls: 1568, sp: 64449 },
									{ cls: 45912, sp: 29426 }
								]
							},
							{
								values: [
									{ cls: 32503, sp: 61184 },
									{ cls: 13031, sp: 18673 },
									{ cls: 25444, sp: 12252 },
									{ cls: 12087, sp: 39879 },
									{ cls: 64270, sp: 23250 },
									{ cls: 65207, sp: 65533 },
									{ cls: 29208, sp: 31067 }
								]
							}
						]
					},
					closure: { relation: 35804, pair: 57658, name: 65302 },
					attachments: [],
					order: { rotate: 3682, dirs: [59996, 24655, 60402], size: 35232 },
					probe: { kind: 28557, pick: 64549 },
					key: { relation: 20821, which: 64290, fact: 10257, absent: 22048, roster: 18947 }
				}
			],
			planted: {
				names: [
					31612, 65534, 45808, 1895, 27447, 63840, 39833, 63613, 47232, 33539, 53512, 34930, 10103,
					37925, 56611, 50608, 29882, 51345, 59825, 34819, 24190, 8017, 64199, 15524, 16221, 61708,
					13366, 34354, 23101, 24731, 22749, 11984, 18283, 47835, 28235, 27419, 63512, 49862, 20699,
					30893, 23354, 60872, 9728, 1265, 65072, 19084, 26014, 62225, 453, 0, 61090
				],
				value: { cls: 14609, sp: 15334 },
				handle: 13571,
				padding: 29156,
				side: { kind: 15588, values: [28912, 21291, 0] }
			}
		},
		draws:
			"1.0.0.5.6.3.2.2.2.1.4.6.5.5.4.3.1.2.1.2.0.1.7.6.6.2.0.1.2.2.0.6.3.4.1.8.0.1.1.5.0.6.0.7.3.4.1.2.2.2.0.6.3.5.0.6.0.7.5.8.8.7.1.3.0.2.1.2.1.0.1.3.5.2.8.5.2.2.1.4.2.1.5.1.1.3.2.8.3.1.2.2.2",
		reaches: [
			"a workload installed",
			"a workload's statistics installed as requested",
			"equality probe served",
			"served by a key or enforcement index",
			"overlap probe served",
			"served by a created index",
			"range probe served",
			"a created index needed"
		]
	}
]

const workloadSuite = (runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				oracle: { kind: "unstated" },
				suite: "pg/physical/serving-workload",
				draw: drawn(caseSketchGen),
				literal: Formatter.format,
				coverage: required<ServingFeature | WorkloadFeature>(
					[
						"a workload installed",
						"equality probe served",
						"a workload's statistics installed as requested"
					],
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
				oracle: { kind: "unstated" },
				suite: "pg/physical/serving-requests",
				draw: drawn(requestSketchGen),
				literal: Formatter.format,
				coverage: required<RequestFeature>(
					[
						"equality probe served",
						"range probe served",
						"ordered probe served",
						"overlap probe served",
						"served by a created index",
						"served by a key or enforcement index",
						"a GiST index serving a B-tree request",
						"a created index needed",
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
			(sketch, cx) => Effect.scoped(requestCase(sketch, cx.note))
		)
	)

const sharedSuite = (runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				oracle: { kind: "unstated" },
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
