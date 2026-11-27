/**
 * Index serving's populations (serving.test.ts): the generated workloads, the drawn requests and the shared ones, each
 * case installed, loaded at volume and judged by PostgreSQL (serving.ts), and the regressions each replays first.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	aimed,
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	recorded,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Result } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"
import type { Direction } from "#compiler/core/order.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { AccessUse } from "#compiler/ir/products.ts"
import type { DeclaredDistinct } from "#compiler/sql/ast.ts"
import { autovacuumAnalyzeScaleMax, autovacuumAnalyzeThresholdMax } from "#compiler/sql/print.ts"
import {
	analyzedAroundAChange,
	drawnRequests,
	judgeServing,
	loadAtVolume,
	type RequestSpec,
	rosterDomainSql,
	type ServingFeature,
	specText,
	type VolumeLoad
} from "#test/pg/physical/serving.ts"
import { ordinarySession } from "#test/support/ambient.ts"
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
import { installFullWorld } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { fixedTypmod, valueClasses } from "#test/support/oracle/gen/domain.ts"
import { installRealSchema, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import { buildMixed, buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type CaseSketch,
	caseSketchGen,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	boundRead,
	type FieldKind,
	fieldKinds,
	type ProgramCase,
	type ProgramField,
	type Stored
} from "#test/support/oracle/public/program.ts"
import { sha256Uuid, spread } from "#test/support/plans.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The values a field of the fixed kind holds in units of its scale, its typmod's (oracle/gen/domain.ts fixedTypmod,
 * numeric(5,2)): every hundredth from -999.99 to 999.99, so a load's series is drawn within the column's precision,
 * where its own value over 100 passed 999.99 past 99,999 rows, a filled state's size, and the fill failed 22003 before
 * any plan was read (serving's rotating seed 0xaf91f91d). A series past them repeats a key the fill skips, as a key of
 * closed handles holds as many rows as its key admits.
 *
 * @limitKind derived
 * @owner the volume loads (serving.fixtures.ts fieldSql)
 * @unit values
 * @scope one fixed field of a load's relation
 * @derivation numeric(p, s) holds 2 · 10^p − 1 values, ±(10^p − 1) / 10^s and every 10^−s between
 * @from oracle/gen/domain.ts fixedTypmod
 */
const fixedValues = 2 * 10 ** fixedTypmod.precision - 1

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
			return `((((${value}) % ${String(fixedValues)}) - ${String((fixedValues - 1) / 2)})::numeric / ${String(10 ** fixedTypmod.scale)})`
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
			return sha256Uuid(`'${salt}:' || (${value})::text`)
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

export type WorkloadFeature =
	| "a workload installed"
	| "a workload refused for an unrepresentable key"
	| "every table's declared statistics installed as declared"

/** A declared number of distinct values as pg_stats reads it back: -1/2^exponent or 2^exponent, exact in a float4. */
const declaredValue = (d: DeclaredDistinct): number =>
	d.kind === "relative" ? -1 / 2 ** d.exponent : 2 ** d.exponent

/**
 * Each column the installed snapshot's manifest declares statistics of: `<table>.<column>`, and its declared number of
 * distinct values as pg_stats reads it back (declaredValue).
 */
const declaredColumns = (snapshot: DeploySnapshot) =>
	Arr.flatMap(snapshot.manifest.objects, (o) =>
		Arr.flatMap(o.ddl, (st) =>
			st.kind === "declareStatistics"
				? Arr.map(st.columns, (c) => ({
						column: `${st.table.name}.${c.column}`,
						distinct: declaredValue(c.distinct)
					}))
				: []
		)
	)

/**
 * Every statistic pg_stats holds of the schema's relations after `analyzedAroundAChange` (serving.ts) analyzed every
 * table over two populations: exactly the declared ones, each declared column's number of distinct values as declared
 * and no sampled statistic beside it, and none of any other column, an index's expression's among them, which ANALYZE
 * samples by its own statistics target. An ANALYZE writes a table's sizes in pg_class whatever its columns' targets
 * (analyze.c do_analyze_rel), so what a declaration keeps is its columns' statistics; the plans it bounds are the
 * contract tier's (test/pg/contracts).
 */
const statisticsKeptAsDeclared = (plan: RealInstallPlan, snapshot: DeploySnapshot) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const held = yield* substrate.admin.queryValues(
			`SELECT st.tablename::text || '.' || st.attname::text || ' ' || coalesce(st.n_distinct::text, '-') || coalesce(CASE WHEN st.most_common_vals IS NOT NULL OR st.histogram_bounds IS NOT NULL OR st.correlation IS NOT NULL THEN ' sampled' END, '') FROM pg_catalog.pg_stats AS st WHERE st.schemaname = $1::text AND NOT st.inherited`,
			[plan.schema]
		)
		assert.deepEqual(
			Arr.sort(
				Arr.map(held, (row) => String(row[0])),
				Order.String
			),
			Arr.sort(
				Arr.map(declaredColumns(snapshot), (c) => `${c.column} ${c.distinct}`),
				Order.String
			),
			"after two VACUUM ANALYZEs, the rows changed between them, every column's statistics are exactly as declared and no other column holds any"
		)
	})

/**
 * Every table's declared statistics as the catalog holds them are those the installed snapshot's manifest declares, as
 * `grizzle generate` drafts it: every table grizzle installs declares its own, an authored or a stored derived
 * relation's, each bookkeeping table's (deploy/snapshot/build.ts targetState) and the live secret's alike, each column's
 * statistics target 0, so no ANALYZE samples it, its declared number of distinct values, and no sampled statistic
 * beside it; and every index the manifest creates stands on a law or the workload's access. What each declares is
 * test/unit/statistics's; that it is installed as declared is here.
 */
const declarationsAsPlanned = (
	plan: RealInstallPlan,
	snapshot: DeploySnapshot,
	note: (feature: ServingFeature | WorkloadFeature) => void
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		for (const o of plan.installation.manifest.objects) {
			if (o.kind === "index") {
				assert.ok(
					Arr.some(o.reasons, (r) => r.kind === "law" || r.kind === "access"),
					`${o.ident} stands on a law or the workload's access`
				)
			}
		}
		const planned = Arr.map(
			declaredColumns(snapshot),
			(c) => `${c.column} 0 ${c.distinct}` as const
		)
		/** Each column of the schema's tables: its table and name, its statistics target and pg_stats' n_distinct, and
		 * whether it holds a sampled statistic. */
		const installed = yield* substrate.admin.queryValues(
			`SELECT c.relname::text || '.' || a.attname::text || ' ' || coalesce(a.attstattarget::text, '-') || ' ' || coalesce(st.n_distinct::text, '-') || coalesce(CASE WHEN st.most_common_vals IS NOT NULL OR st.histogram_bounds IS NOT NULL OR st.correlation IS NOT NULL THEN ' sampled' END, '') FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_stats AS st ON st.schemaname = n.nspname AND st.tablename = c.relname AND st.attname = a.attname AND NOT st.inherited WHERE n.nspname = $1::text AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
			[plan.schema]
		)
		assert.deepEqual(
			Arr.sort(
				Arr.map(installed, (row) => String(row[0])),
				Order.String
			),
			Arr.sort(planned, Order.String),
			"every column of every table holds its declared statistics, its target 0 and nothing sampled"
		)
		const declaredTables = Arr.flatMap(snapshot.manifest.objects, (o) =>
			Arr.flatMap(o.ddl, (st) => (st.kind === "declareStatistics" ? [st.table.name] : []))
		)
		/** Each table's storage parameters, which its declaration sets: its automatic ANALYZE's thresholds at their
		 * maxima. */
		const options = yield* substrate.admin.queryValues(
			`SELECT c.relname::text, pg_catalog.array_to_string(c.reloptions, ',') FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1::text AND c.relkind IN ('r', 'p')`,
			[plan.schema]
		)
		assert.deepEqual(
			Arr.sort(
				Arr.map(options, (row) => `${String(row[0])} ${String(row[1])}`),
				Order.String
			),
			Arr.sort(
				Arr.map(
					declaredTables,
					(t) =>
						`${t} autovacuum_analyze_threshold=${autovacuumAnalyzeThresholdMax},autovacuum_analyze_scale_factor=${autovacuumAnalyzeScaleMax}`
				),
				Order.String
			),
			"every table's automatic ANALYZE waits past its thresholds' maxima"
		)
		if (planned.length > 0) {
			note("every table's declared statistics installed as declared")
		}
	})

/** The generated case's reads as a workload, installed, loaded and judged. */
export const workloadCase = (
	c: ProgramCase,
	note: (feature: ServingFeature | WorkloadFeature) => void
) =>
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
			installFullWorld(built.schema, programs, {
				label: "serving_workload",
				ambient: ordinarySession
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
		yield* declarationsAsPlanned(judged, installed.success.snapshot, note)
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
		const settled = yield* loadAtVolume(judged, loads)
		const problems = yield* judgeServing(settled, note)
		assert.deepEqual(
			problems,
			[],
			`PostgreSQL serves every request and needs every created index\n${printCase(c)}`
		)
		yield* analyzedAroundAChange(settled)
		yield* statisticsKeptAsDeclared(judged, installed.success.snapshot)
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
	bases: []
}

/**
 * Line first, so each deposit's line exists; one deposit per line, so at most one remainder per line; bookings and
 * shifts never overlap at all, so every room's spans and every worker's are disjoint; a booking's id, which no key
 * holds, spread like any other field, so no index on it finds one row the schema does not promise; a shift on standby
 * one row in ten, as a flag is, the middle row every probe samples among them (serving.ts), so btree_gist's split, which
 * halves a page's entries in the column's order, never tells standby's values apart.
 */
const indexedLoads: ReadonlyArray<VolumeLoad> = [
	{ relation: "Line", fields: [["id", sha256Uuid("'line:' || g")]] },
	{
		relation: "Deposit",
		fields: [
			["line", sha256Uuid("'line:' || g")],
			["account", sha256Uuid(`'account:' || ${spread(1, 141)}`)],
			["remainder", "(g % 2 = 0)"]
		]
	},
	{
		relation: "Event",
		fields: [
			["id", sha256Uuid("'event:' || g")],
			["tenant", sha256Uuid(`'tenant:' || ${spread(2, 141)}`)],
			["account", sha256Uuid(`'account:' || ${spread(3, 141)}`)],
			["created", spread(4, 141)],
			["unrelated", spread(5, 141)],
			["live", "(g % 2 = 0)"]
		]
	},
	{
		relation: "Booking",
		fields: [
			["room", sha256Uuid(`'room:' || ${spread(6, 141)}`)],
			["during", "int4range(g * 10, g * 10 + 5)"],
			["id", sha256Uuid(`'booking:' || ${spread(7, 141)}`)],
			["held", "(g % 2 = 0)"]
		]
	},
	{
		relation: "Shift",
		fields: [
			["standby", "(g % 10 = 0)"],
			["worker", sha256Uuid(`'worker:' || ${spread(8, 141)}`)],
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
		closed.ordered("Shade", shadesOf(shades)),
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
			["worker", sha256Uuid(`'rota:' || ${spread(9, 141)}`)],
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
export interface RequestSketch {
	readonly shades: number
	readonly intents: ReadonlyArray<Intent>
}

export const requestSketchGen: Gen<RequestSketch> = (source) => ({
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

export type RequestFeature = ServingFeature | "a span predicate on during alone"

/** The drawn requests on the drawn suite's schema (requestSchema), installed, loaded and judged. */
export const requestCase = (sketch: RequestSketch, note: (feature: RequestFeature) => void) =>
	Effect.gen(function* () {
		const specs = resolveIntents(sketch.intents)
		for (const spec of specs) {
			if (spec.kind === "access" && spec.use === "span predicate" && spec.keys.length === 1) {
				note("a span predicate on during alone")
			}
		}
		const { plan } = yield* installRealSchema(requestSchema(sketch.shades), {
			label: "serving_requests",
			extensions: [drawnRequests(specs)]
		})
		const settled = yield* loadAtVolume(plan, [...indexedLoads, rotaLoad(plan, sketch.shades)])
		const problems = yield* judgeServing(settled, note)
		assert.deepEqual(
			problems,
			[],
			`PostgreSQL serves every request and needs every created index, Rota of ${sketch.shades} shades: ${Arr.join(Arr.map(specs, specText), "; ")}`
		)
	})

/**
 * A workload case's sketch: the program its case sketch resolves to, and the reads it installs: the program's drawn
 * ones, or one read constructed to reach a workload's statistics in their place (statisticsCaseGen), which a witness
 * whose turn aims at that feature draws (workloadAims). The property resolves both on the case's own tape
 * (workloadGen), so a kept sketch installs the reads its case ran.
 */
export interface WorkloadSketch {
	readonly program: CaseSketch
	readonly reads: "drawn" | "a correlated selection"
}

/** A workload of `program` with its drawn reads. */
const drawnReads = (program: CaseSketch): WorkloadSketch => ({ program, reads: "drawn" })

/**
 * The generated workloads kept from failure reports whose fix was the index engine's (physical/indexes/engine.ts),
 * recorded beside the space (gen.ts recorded), each replayed first by its token with the draws its case resolved it by,
 * whose reason says what it reaches (serving.test.ts, and its header).
 */
const workloadRegressions: Arr.NonEmptyReadonlyArray<WorkloadSketch> = [
	drawnReads({
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
	}),
	drawnReads({
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
	}),
	drawnReads({
		population: "forms",
		swarm: {
			"bind fresh": 3,
			"bind join": 3,
			"bind existential": 3,
			"bind param": 3,
			where: 3,
			"compare param": 3,
			negation: 2,
			aggregate: 3,
			union: 3,
			take: 2,
			"attached take": 2,
			ordered: 3,
			attach: 3,
			nested: 1,
			roster: 1,
			dense: 1,
			"candidate key": 2,
			probe: 3,
			spelled: 1,
			"full head": 3,
			"stated delivery": 3,
			"plain child": 2,
			"keyed child": 2,
			"reflexive child": 3,
			"arm child": 2,
			"handle field": 2,
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
				"enable_sort = off",
				"plan_cache_mode = force_generic_plan",
				"parallel_tuple_cost = 0"
			],
			multiplier: 1
		},
		ambient: {
			path: {
				kind: "default"
			},
			settings: [
				{
					parameter: "extra_float_digits",
					value: "0"
				},
				{
					parameter: "TimeZone",
					value: "UTC"
				},
				{
					parameter: "bytea_output",
					value: "hex"
				}
			]
		},
		restorage: {
			shift: 9,
			respell: 574
		},
		roster: 5968,
		span: 42351,
		relations: [
			{
				name: 15389,
				fields: [
					{
						name: 52242,
						kind: 49622,
						key: 36584
					},
					{
						name: 65514,
						kind: 20,
						key: 57170
					},
					{
						name: 19247,
						kind: 26761,
						key: 43612
					}
				],
				candidate: 48264,
				facts: [
					{
						values: [
							{
								cls: 3831,
								sp: 63719
							},
							{
								cls: 10609,
								sp: 0
							},
							{
								cls: 65417,
								sp: 8283
							},
							{
								cls: 45507,
								sp: 31489
							},
							{
								cls: 20770,
								sp: 61533
							},
							{
								cls: 44418,
								sp: 51982
							},
							{
								cls: 45165,
								sp: 38255
							}
						]
					},
					{
						values: [
							{
								cls: 19771,
								sp: 42880
							},
							{
								cls: 59025,
								sp: 33275
							},
							{
								cls: 4,
								sp: 47656
							},
							{
								cls: 102,
								sp: 8672
							},
							{
								cls: 36567,
								sp: 11
							},
							{
								cls: 65474,
								sp: 55345
							},
							{
								cls: 46523,
								sp: 61557
							}
						]
					},
					{
						values: [
							{
								cls: 9687,
								sp: 37249
							},
							{
								cls: 18073,
								sp: 31325
							},
							{
								cls: 30431,
								sp: 5802
							},
							{
								cls: 59554,
								sp: 43440
							},
							{
								cls: 89,
								sp: 58848
							},
							{
								cls: 13416,
								sp: 33832
							},
							{
								cls: 0,
								sp: 43549
							}
						]
					},
					{
						values: [
							{
								cls: 18487,
								sp: 27920
							},
							{
								cls: 839,
								sp: 50113
							},
							{
								cls: 41884,
								sp: 25001
							},
							{
								cls: 65302,
								sp: 37564
							},
							{
								cls: 5634,
								sp: 49364
							},
							{
								cls: 59,
								sp: 19992
							},
							{
								cls: 4798,
								sp: 7
							}
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
							source: 1033,
							derived: 15847,
							attached: 63,
							binds: [
								{
									how: 13949,
									pick: 59009,
									value: {
										cls: 47843,
										sp: 65293
									}
								},
								{
									how: 26654,
									pick: 48178,
									value: {
										cls: 17947,
										sp: 43250
									}
								},
								{
									how: 52647,
									pick: 23664,
									value: {
										cls: 43172,
										sp: 51604
									}
								},
								{
									how: 23228,
									pick: 21734,
									value: {
										cls: 36041,
										sp: 8676
									}
								},
								{
									how: 19756,
									pick: 54240,
									value: {
										cls: 33352,
										sp: 12465
									}
								},
								{
									how: 52648,
									pick: 22453,
									value: {
										cls: 19126,
										sp: 34807
									}
								},
								{
									how: 15818,
									pick: 40671,
									value: {
										cls: 15842,
										sp: 46
									}
								}
							]
						},
						{
							source: 20722,
							derived: 10947,
							attached: 61766,
							binds: [
								{
									how: 37407,
									pick: 1014,
									value: {
										cls: 17755,
										sp: 832
									}
								},
								{
									how: 16082,
									pick: 29670,
									value: {
										cls: 47088,
										sp: 56150
									}
								},
								{
									how: 0,
									pick: 36384,
									value: {
										cls: 41256,
										sp: 51964
									}
								},
								{
									how: 15761,
									pick: 14944,
									value: {
										cls: 20858,
										sp: 54707
									}
								},
								{
									how: 42164,
									pick: 35912,
									value: {
										cls: 2946,
										sp: 21248
									}
								},
								{
									how: 31432,
									pick: 18251,
									value: {
										cls: 32084,
										sp: 3466
									}
								},
								{
									how: 42226,
									pick: 52024,
									value: {
										cls: 40598,
										sp: 14044
									}
								}
							]
						},
						{
							source: 45437,
							derived: 23687,
							attached: 1922,
							binds: [
								{
									how: 34379,
									pick: 52517,
									value: {
										cls: 49517,
										sp: 52781
									}
								},
								{
									how: 6291,
									pick: 8500,
									value: {
										cls: 61739,
										sp: 25693
									}
								},
								{
									how: 776,
									pick: 51159,
									value: {
										cls: 56002,
										sp: 35812
									}
								},
								{
									how: 5932,
									pick: 4517,
									value: {
										cls: 38112,
										sp: 62743
									}
								},
								{
									how: 12395,
									pick: 57223,
									value: {
										cls: 25520,
										sp: 65519
									}
								},
								{
									how: 497,
									pick: 14557,
									value: {
										cls: 19481,
										sp: 48178
									}
								},
								{
									how: 49040,
									pick: 18163,
									value: {
										cls: 46657,
										sp: 55334
									}
								}
							]
						}
					],
					where: [
						{
							left: 9106,
							op: 18110,
							pick: 12200,
							value: {
								cls: 16340,
								sp: 29580
							}
						}
					],
					between: [],
					inSet: [],
					allen: [],
					pointIn: [
						{
							span: 19692,
							point: 1546
						}
					],
					connective: [
						{
							kind: 45987,
							args: [
								{
									left: 21778,
									op: 62710,
									pick: 59169,
									value: {
										cls: 62629,
										sp: 51266
									}
								}
							]
						}
					],
					computed: [],
					negation: {
						source: 10141,
						picks: [52758, 59316]
					},
					head: {
						vars: [56613],
						names: [43887, 34890, 906, 43962, 64, 36085],
						folds: [
							{
								fn: 25115,
								arg: 419,
								padded: 38306,
								scale: 18468
							},
							{
								fn: 42475,
								arg: 9551,
								padded: 706,
								scale: 60412
							}
						]
					},
					interior: {
						matches: [
							{
								source: 9598,
								derived: 39586,
								attached: 24295,
								binds: [
									{
										how: 24779,
										pick: 19675,
										value: {
											cls: 46263,
											sp: 63946
										}
									},
									{
										how: 91,
										pick: 3351,
										value: {
											cls: 24093,
											sp: 287
										}
									},
									{
										how: 54584,
										pick: 47760,
										value: {
											cls: 19703,
											sp: 42352
										}
									},
									{
										how: 28232,
										pick: 40709,
										value: {
											cls: 2423,
											sp: 47487
										}
									},
									{
										how: 4947,
										pick: 18796,
										value: {
											cls: 35468,
											sp: 64552
										}
									},
									{
										how: 16579,
										pick: 39862,
										value: {
											cls: 39294,
											sp: 51004
										}
									},
									{
										how: 11186,
										pick: 24015,
										value: {
											cls: 53774,
											sp: 36048
										}
									}
								]
							},
							{
								source: 8010,
								derived: 30494,
								attached: 36952,
								binds: [
									{
										how: 51941,
										pick: 36717,
										value: {
											cls: 3024,
											sp: 27036
										}
									},
									{
										how: 16151,
										pick: 1870,
										value: {
											cls: 20114,
											sp: 13338
										}
									},
									{
										how: 51569,
										pick: 64038,
										value: {
											cls: 33623,
											sp: 25761
										}
									},
									{
										how: 56584,
										pick: 11351,
										value: {
											cls: 53202,
											sp: 29831
										}
									},
									{
										how: 5028,
										pick: 316,
										value: {
											cls: 39153,
											sp: 25684
										}
									},
									{
										how: 53917,
										pick: 40287,
										value: {
											cls: 54256,
											sp: 61949
										}
									},
									{
										how: 25928,
										pick: 3052,
										value: {
											cls: 3397,
											sp: 11231
										}
									}
								]
							}
						],
						where: [],
						negation: {
							source: 64299,
							picks: [7438, 9]
						},
						head: {
							vars: [31276, 10078],
							names: [59610, 48167, 29, 48147, 24841, 53843],
							folds: [
								{
									fn: 49343,
									arg: 65535,
									padded: 15322,
									scale: 31478
								},
								{
									fn: 24303,
									arg: 53849,
									padded: 25711,
									scale: 42221
								}
							]
						}
					}
				},
				take: {
					rotate: 61538,
					dirs: [0, 42244, 48049],
					size: 1624,
					ties: 32302
				},
				literalHead: {
					name: 22617,
					kind: 64572,
					arms: 65531,
					values: [92, 11999, 61362]
				},
				importable: 32605,
				bindImport: 19454,
				named: 53185,
				relationParam: {
					relation: 38632,
					facts: [
						{
							values: [
								{
									cls: 16354,
									sp: 61738
								},
								{
									cls: 23813,
									sp: 32637
								},
								{
									cls: 34611,
									sp: 64573
								},
								{
									cls: 63178,
									sp: 57197
								},
								{
									cls: 49205,
									sp: 56383
								},
								{
									cls: 8891,
									sp: 48123
								},
								{
									cls: 33306,
									sp: 41612
								}
							]
						},
						{
							values: [
								{
									cls: 38043,
									sp: 24840
								},
								{
									cls: 21201,
									sp: 13173
								},
								{
									cls: 48324,
									sp: 44501
								},
								{
									cls: 29365,
									sp: 20643
								},
								{
									cls: 51449,
									sp: 54620
								},
								{
									cls: 24837,
									sp: 35884
								},
								{
									cls: 46578,
									sp: 52008
								}
							]
						}
					]
				},
				closure: {
					relation: 61790,
					pair: 566,
					name: 40686
				},
				attachments: [],
				order: {
					rotate: 31580,
					dirs: [39215, 30634, 21616],
					size: 61069
				},
				probe: {
					kind: 16719,
					pick: 1092
				},
				key: {
					relation: 58108,
					which: 55238,
					fact: 30441,
					absent: 61111,
					roster: 8584
				}
			}
		],
		planted: {
			names: [
				32250, 26420, 0, 3635, 62854, 65446, 19028, 65534, 63918, 31566, 65530, 10768, 34524, 46387,
				34416, 1470, 28263, 65325, 31848, 64380, 62454, 55929, 48838, 19902, 41975, 2973, 38202,
				20900, 32867, 29327, 44767, 19293, 22709, 32268, 52730, 179, 19262, 56928, 11061, 43621,
				9099, 8444, 56750, 59783, 16737, 62521, 24183, 64213, 61128, 59566, 29319
			],
			value: {
				cls: 60389,
				sp: 28111
			},
			handle: 57172,
			padding: 10829,
			side: {
				kind: 44140,
				values: [12273, 55073, 757]
			}
		}
	}),
	drawnReads({
		population: "spelled",
		swarm: {
			"bind fresh": 2,
			"bind parent": 3,
			"compare literal": 1,
			"compare var": 2,
			"attached take": 3,
			attach: 3,
			nested: 3,
			dense: 3,
			"candidate key": 2,
			"key read": 1,
			probe: 3,
			spelled: 3,
			"full head": 3,
			"stated delivery": 2,
			"plain child": 1,
			"keyed child": 2,
			"arm child": 3,
			"handle field": 1,
			import: 3,
			"import bound": 3,
			interior: 3,
			named: 3,
			"computed head": 1,
			"computed group key": 2,
			between: 2,
			"in set": 2,
			connective: 2,
			"relation param": 1,
			"contract param": 2,
			"typmod param": 1,
			allen: 3
		},
		perturbation: {
			settings: [
				"enable_hashjoin = off",
				"plan_cache_mode = force_generic_plan",
				"min_parallel_table_scan_size = 0"
			],
			multiplier: 1
		},
		ambient: {
			path: {
				kind: "default"
			},
			settings: [
				{
					parameter: "TimeZone",
					value: "UTC"
				},
				{
					parameter: "IntervalStyle",
					value: "postgres_verbose"
				}
			]
		},
		restorage: {
			shift: 12,
			respell: 47
		},
		roster: 60420,
		span: 5421,
		relations: [
			{
				name: 7367,
				fields: [
					{
						name: 15735,
						kind: 21143,
						key: 13659
					},
					{
						name: 53124,
						kind: 7519,
						key: 35702
					},
					{
						name: 61383,
						kind: 0,
						key: 14939
					},
					{
						name: 50896,
						kind: 41534,
						key: 37161
					}
				],
				candidate: 48595,
				facts: [
					{
						values: [
							{
								cls: 23111,
								sp: 60366
							},
							{
								cls: 50562,
								sp: 55688
							},
							{
								cls: 18432,
								sp: 9517
							},
							{
								cls: 63630,
								sp: 2970
							},
							{
								cls: 28653,
								sp: 17749
							},
							{
								cls: 4313,
								sp: 15341
							},
							{
								cls: 65450,
								sp: 17636
							}
						]
					},
					{
						values: [
							{
								cls: 64865,
								sp: 13066
							},
							{
								cls: 18748,
								sp: 19960
							},
							{
								cls: 45985,
								sp: 22384
							},
							{
								cls: 19734,
								sp: 64274
							},
							{
								cls: 19138,
								sp: 65524
							},
							{
								cls: 60149,
								sp: 2
							},
							{
								cls: 44283,
								sp: 49570
							}
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
							source: 380,
							derived: 58169,
							attached: 43992,
							binds: [
								{
									how: 27842,
									pick: 64644,
									value: {
										cls: 6277,
										sp: 61137
									}
								},
								{
									how: 30517,
									pick: 383,
									value: {
										cls: 3219,
										sp: 36823
									}
								},
								{
									how: 29103,
									pick: 32424,
									value: {
										cls: 59237,
										sp: 7960
									}
								},
								{
									how: 33984,
									pick: 26896,
									value: {
										cls: 16079,
										sp: 47020
									}
								},
								{
									how: 63141,
									pick: 30982,
									value: {
										cls: 60593,
										sp: 24772
									}
								},
								{
									how: 16091,
									pick: 1945,
									value: {
										cls: 17030,
										sp: 50488
									}
								},
								{
									how: 42082,
									pick: 46845,
									value: {
										cls: 47445,
										sp: 13905
									}
								}
							]
						}
					],
					where: [],
					between: [],
					inSet: [
						{
							left: 48222,
							values: [
								{
									cls: 33954,
									sp: 50598
								}
							]
						}
					],
					allen: [],
					pointIn: [],
					connective: [
						{
							kind: 16762,
							args: [
								{
									left: 30209,
									op: 42397,
									pick: 11786,
									value: {
										cls: 24621,
										sp: 20062
									}
								}
							]
						}
					],
					computed: [
						{
							kind: 40123,
							reading: 50512,
							arg: 42937,
							op: 35076,
							than: {
								cls: 37518,
								sp: 6397
							},
							otherwise: {
								cls: 59659,
								sp: 58350
							},
							scale: 21997,
							padded: 60087
						}
					],
					negation: {
						source: 28465,
						picks: [24795, 40198]
					},
					head: {
						vars: [],
						names: [40485, 49814, 4404, 8139, 65534, 65323],
						folds: [
							{
								fn: 295,
								arg: 44403,
								padded: 56297,
								scale: 60449
							}
						]
					},
					interior: {
						matches: [
							{
								source: 63174,
								derived: 64292,
								attached: 24193,
								binds: [
									{
										how: 29223,
										pick: 23396,
										value: {
											cls: 38676,
											sp: 39851
										}
									},
									{
										how: 27482,
										pick: 65160,
										value: {
											cls: 61170,
											sp: 917
										}
									},
									{
										how: 64464,
										pick: 28871,
										value: {
											cls: 33327,
											sp: 44994
										}
									},
									{
										how: 6486,
										pick: 62783,
										value: {
											cls: 21355,
											sp: 17757
										}
									},
									{
										how: 620,
										pick: 40130,
										value: {
											cls: 49818,
											sp: 65524
										}
									},
									{
										how: 33307,
										pick: 59144,
										value: {
											cls: 19471,
											sp: 13658
										}
									},
									{
										how: 32250,
										pick: 78,
										value: {
											cls: 23558,
											sp: 52547
										}
									}
								]
							}
						],
						where: [],
						negation: {
							source: 42015,
							picks: [50247, 20807]
						},
						head: {
							vars: [],
							names: [27220, 22, 54666, 57340, 39223, 18307],
							folds: [
								{
									fn: 40617,
									arg: 59143,
									padded: 19581,
									scale: 11757
								},
								{
									fn: 61641,
									arg: 44960,
									padded: 6767,
									scale: 43060
								}
							]
						}
					}
				},
				take: {
					rotate: 3,
					dirs: [578, 45795, 28330],
					size: 24335,
					ties: 23039
				},
				literalHead: {
					name: 23486,
					kind: 22297,
					arms: 45724,
					values: [32109, 35570, 10780]
				},
				importable: 39592,
				bindImport: 51106,
				named: 29428,
				relationParam: {
					relation: 18353,
					facts: []
				},
				closure: {
					relation: 37803,
					pair: 18138,
					name: 13264
				},
				attachments: [
					{
						name: 58963,
						link: 11169,
						handle: 19236,
						delivery: 65512,
						rule: {
							matches: [
								{
									source: 2125,
									derived: 32703,
									attached: 54744,
									binds: [
										{
											how: 49206,
											pick: 56752,
											value: {
												cls: 546,
												sp: 32566
											}
										},
										{
											how: 5428,
											pick: 58485,
											value: {
												cls: 53891,
												sp: 31690
											}
										},
										{
											how: 47591,
											pick: 394,
											value: {
												cls: 55106,
												sp: 6224
											}
										},
										{
											how: 55835,
											pick: 60936,
											value: {
												cls: 1319,
												sp: 46172
											}
										},
										{
											how: 44874,
											pick: 8292,
											value: {
												cls: 16158,
												sp: 55976
											}
										},
										{
											how: 5216,
											pick: 44117,
											value: {
												cls: 14222,
												sp: 54300
											}
										},
										{
											how: 23986,
											pick: 39742,
											value: {
												cls: 52467,
												sp: 51219
											}
										}
									]
								}
							],
							where: [
								{
									left: 4592,
									op: 61541,
									pick: 27657,
									value: {
										cls: 11582,
										sp: 17238
									}
								}
							],
							between: [
								{
									left: 26441,
									low: {
										pick: 31922,
										value: {
											cls: 11349,
											sp: 64154
										}
									},
									high: {
										pick: 29338,
										value: {
											cls: 14280,
											sp: 0
										}
									}
								}
							],
							inSet: [],
							allen: [],
							pointIn: [
								{
									span: 30518,
									point: 4493
								}
							],
							connective: [],
							computed: [],
							negation: {
								source: 1235,
								picks: [18654, 36391]
							},
							head: {
								vars: [29797, 21019, 47432],
								names: [6, 30293, 27197, 18418, 13764, 61470],
								folds: [
									{
										fn: 28331,
										arg: 60684,
										padded: 3599,
										scale: 33590
									},
									{
										fn: 1,
										arg: 58399,
										padded: 59806,
										scale: 3486
									}
								]
							},
							interior: {
								matches: [
									{
										source: 26756,
										derived: 5120,
										attached: 20048,
										binds: [
											{
												how: 58916,
												pick: 19485,
												value: {
													cls: 20730,
													sp: 8506
												}
											},
											{
												how: 370,
												pick: 4062,
												value: {
													cls: 37056,
													sp: 2862
												}
											},
											{
												how: 37043,
												pick: 40809,
												value: {
													cls: 11462,
													sp: 31478
												}
											},
											{
												how: 9109,
												pick: 41210,
												value: {
													cls: 62195,
													sp: 32699
												}
											},
											{
												how: 19103,
												pick: 35406,
												value: {
													cls: 50339,
													sp: 39525
												}
											},
											{
												how: 14034,
												pick: 41931,
												value: {
													cls: 58943,
													sp: 11288
												}
											},
											{
												how: 34219,
												pick: 0,
												value: {
													cls: 30434,
													sp: 15487
												}
											}
										]
									},
									{
										source: 65226,
										derived: 11624,
										attached: 62333,
										binds: [
											{
												how: 65528,
												pick: 63393,
												value: {
													cls: 124,
													sp: 32391
												}
											},
											{
												how: 14933,
												pick: 1984,
												value: {
													cls: 15773,
													sp: 10376
												}
											},
											{
												how: 20240,
												pick: 21433,
												value: {
													cls: 14,
													sp: 33133
												}
											},
											{
												how: 35498,
												pick: 4527,
												value: {
													cls: 1663,
													sp: 11112
												}
											},
											{
												how: 19365,
												pick: 32193,
												value: {
													cls: 22107,
													sp: 54552
												}
											},
											{
												how: 34603,
												pick: 47102,
												value: {
													cls: 8461,
													sp: 47031
												}
											},
											{
												how: 15639,
												pick: 58,
												value: {
													cls: 25729,
													sp: 11086
												}
											}
										]
									}
								],
								where: [
									{
										left: 50438,
										op: 7241,
										pick: 7539,
										value: {
											cls: 48093,
											sp: 41685
										}
									}
								],
								negation: {
									source: 65525,
									picks: [12266, 65534]
								},
								head: {
									vars: [],
									names: [61886, 54, 6119, 38167, 65090, 26289],
									folds: [
										{
											fn: 14608,
											arg: 4994,
											padded: 29648,
											scale: 54931
										},
										{
											fn: 2746,
											arg: 23276,
											padded: 42361,
											scale: 10920
										}
									]
								}
							}
						},
						take: {
							rotate: 43599,
							dirs: [47184, 57675, 30016],
							size: 47990
						},
						nested: {
							name: 61243,
							link: 6,
							handle: 14995,
							delivery: 62838,
							rule: {
								matches: [
									{
										source: 65526,
										derived: 55713,
										attached: 44168,
										binds: [
											{
												how: 57710,
												pick: 43685,
												value: {
													cls: 7373,
													sp: 54962
												}
											},
											{
												how: 50147,
												pick: 64351,
												value: {
													cls: 65497,
													sp: 62648
												}
											},
											{
												how: 46032,
												pick: 55931,
												value: {
													cls: 37386,
													sp: 7139
												}
											},
											{
												how: 42610,
												pick: 35165,
												value: {
													cls: 56158,
													sp: 58884
												}
											},
											{
												how: 29071,
												pick: 64200,
												value: {
													cls: 21615,
													sp: 19293
												}
											},
											{
												how: 17185,
												pick: 4312,
												value: {
													cls: 57882,
													sp: 59406
												}
											},
											{
												how: 48627,
												pick: 2148,
												value: {
													cls: 45631,
													sp: 47442
												}
											}
										]
									},
									{
										source: 65534,
										derived: 53595,
										attached: 33625,
										binds: [
											{
												how: 5,
												pick: 42794,
												value: {
													cls: 49316,
													sp: 46401
												}
											},
											{
												how: 59900,
												pick: 41994,
												value: {
													cls: 19396,
													sp: 54560
												}
											},
											{
												how: 3598,
												pick: 4147,
												value: {
													cls: 1813,
													sp: 13
												}
											},
											{
												how: 37894,
												pick: 17168,
												value: {
													cls: 40142,
													sp: 64552
												}
											},
											{
												how: 12042,
												pick: 498,
												value: {
													cls: 63399,
													sp: 817
												}
											},
											{
												how: 17927,
												pick: 3149,
												value: {
													cls: 16000,
													sp: 59727
												}
											},
											{
												how: 65305,
												pick: 7421,
												value: {
													cls: 43658,
													sp: 6754
												}
											}
										]
									}
								],
								where: [
									{
										left: 17726,
										op: 61562,
										pick: 16556,
										value: {
											cls: 52609,
											sp: 17638
										}
									},
									{
										left: 38514,
										op: 1079,
										pick: 91,
										value: {
											cls: 18472,
											sp: 19352
										}
									}
								],
								between: [],
								inSet: [],
								allen: [
									{
										left: 39109,
										mask: 24456,
										right: 65535
									}
								],
								pointIn: [
									{
										span: 15337,
										point: 47370
									}
								],
								connective: [
									{
										kind: 62421,
										args: [
											{
												left: 57868,
												op: 21288,
												pick: 20726,
												value: {
													cls: 19716,
													sp: 5317
												}
											}
										]
									}
								],
								computed: [
									{
										kind: 65083,
										reading: 65535,
										arg: 2558,
										op: 81,
										than: {
											cls: 64775,
											sp: 43344
										},
										otherwise: {
											cls: 45735,
											sp: 12817
										},
										scale: 34066,
										padded: 40805
									}
								],
								negation: {
									source: 26470,
									picks: [27286, 9163]
								},
								head: {
									vars: [54480, 39580, 35657],
									names: [24593, 62335, 43730, 5832, 61103, 8759],
									folds: [
										{
											fn: 35990,
											arg: 31490,
											padded: 56237,
											scale: 23787
										}
									]
								},
								interior: {
									matches: [
										{
											source: 17728,
											derived: 3760,
											attached: 17756,
											binds: [
												{
													how: 27881,
													pick: 0,
													value: {
														cls: 27127,
														sp: 29162
													}
												},
												{
													how: 37962,
													pick: 49375,
													value: {
														cls: 16409,
														sp: 46855
													}
												},
												{
													how: 64401,
													pick: 50845,
													value: {
														cls: 9708,
														sp: 29489
													}
												},
												{
													how: 65411,
													pick: 9633,
													value: {
														cls: 17697,
														sp: 34298
													}
												},
												{
													how: 11699,
													pick: 65524,
													value: {
														cls: 53148,
														sp: 38289
													}
												},
												{
													how: 5674,
													pick: 8784,
													value: {
														cls: 33820,
														sp: 30001
													}
												},
												{
													how: 0,
													pick: 11090,
													value: {
														cls: 54118,
														sp: 7215
													}
												}
											]
										}
									],
									where: [
										{
											left: 30313,
											op: 34923,
											pick: 56570,
											value: {
												cls: 30976,
												sp: 7515
											}
										}
									],
									negation: {
										source: 25883,
										picks: [32607, 1070]
									},
									head: {
										vars: [61441, 5822, 16168],
										names: [65516, 17198, 56312, 35121, 5618, 17563],
										folds: [
											{
												fn: 24934,
												arg: 64025,
												padded: 44418,
												scale: 30663
											}
										]
									}
								}
							},
							take: {
								rotate: 46893,
								dirs: [63043, 22321, 7897],
								size: 20570
							}
						}
					},
					{
						name: 27568,
						link: 50226,
						handle: 30605,
						delivery: 560,
						rule: {
							matches: [
								{
									source: 41777,
									derived: 13853,
									attached: 39685,
									binds: [
										{
											how: 64498,
											pick: 45086,
											value: {
												cls: 58789,
												sp: 3703
											}
										},
										{
											how: 31112,
											pick: 62132,
											value: {
												cls: 14272,
												sp: 65433
											}
										},
										{
											how: 21768,
											pick: 29968,
											value: {
												cls: 4599,
												sp: 65504
											}
										},
										{
											how: 65408,
											pick: 11515,
											value: {
												cls: 50746,
												sp: 1181
											}
										},
										{
											how: 62133,
											pick: 49150,
											value: {
												cls: 38357,
												sp: 36786
											}
										},
										{
											how: 27833,
											pick: 45789,
											value: {
												cls: 13260,
												sp: 65535
											}
										},
										{
											how: 58108,
											pick: 44474,
											value: {
												cls: 8449,
												sp: 46818
											}
										}
									]
								}
							],
							where: [
								{
									left: 1641,
									op: 60890,
									pick: 27249,
									value: {
										cls: 42272,
										sp: 4121
									}
								},
								{
									left: 64573,
									op: 61721,
									pick: 4332,
									value: {
										cls: 21466,
										sp: 60354
									}
								}
							],
							between: [
								{
									left: 24121,
									low: {
										pick: 6825,
										value: {
											cls: 4211,
											sp: 38246
										}
									},
									high: {
										pick: 45292,
										value: {
											cls: 59092,
											sp: 49180
										}
									}
								}
							],
							inSet: [],
							allen: [
								{
									left: 57489,
									mask: 44511,
									right: 28830
								}
							],
							pointIn: [],
							connective: [
								{
									kind: 6075,
									args: [
										{
											left: 65535,
											op: 41108,
											pick: 44326,
											value: {
												cls: 62345,
												sp: 9555
											}
										}
									]
								}
							],
							computed: [],
							negation: {
								source: 5798,
								picks: [49470, 7733]
							},
							head: {
								vars: [43969, 32024, 57775],
								names: [51955, 250, 58617, 0, 29239, 51474],
								folds: [
									{
										fn: 17967,
										arg: 18761,
										padded: 58369,
										scale: 49085
									}
								]
							},
							interior: {
								matches: [
									{
										source: 26951,
										derived: 81,
										attached: 30970,
										binds: [
											{
												how: 42966,
												pick: 49524,
												value: {
													cls: 41344,
													sp: 56
												}
											},
											{
												how: 2665,
												pick: 12367,
												value: {
													cls: 27972,
													sp: 39329
												}
											},
											{
												how: 35817,
												pick: 32099,
												value: {
													cls: 23820,
													sp: 20458
												}
											},
											{
												how: 17260,
												pick: 62961,
												value: {
													cls: 65532,
													sp: 44756
												}
											},
											{
												how: 8042,
												pick: 11049,
												value: {
													cls: 18909,
													sp: 5050
												}
											},
											{
												how: 11451,
												pick: 32366,
												value: {
													cls: 8852,
													sp: 29827
												}
											},
											{
												how: 56260,
												pick: 53570,
												value: {
													cls: 57913,
													sp: 13302
												}
											}
										]
									}
								],
								where: [],
								negation: {
									source: 26383,
									picks: [61646, 52458]
								},
								head: {
									vars: [51278, 4, 40287],
									names: [18997, 51224, 50519, 24788, 48505, 34496],
									folds: [
										{
											fn: 60838,
											arg: 12090,
											padded: 17088,
											scale: 63588
										}
									]
								}
							}
						},
						take: {
							rotate: 8704,
							dirs: [18677, 40315, 9403],
							size: 30449
						},
						nested: {
							name: 45394,
							link: 50459,
							handle: 23423,
							delivery: 17178,
							rule: {
								matches: [
									{
										source: 27798,
										derived: 16336,
										attached: 65248,
										binds: [
											{
												how: 56059,
												pick: 33620,
												value: {
													cls: 46346,
													sp: 57982
												}
											},
											{
												how: 31239,
												pick: 19461,
												value: {
													cls: 45385,
													sp: 45700
												}
											},
											{
												how: 54973,
												pick: 65483,
												value: {
													cls: 14500,
													sp: 46021
												}
											},
											{
												how: 37645,
												pick: 62106,
												value: {
													cls: 55703,
													sp: 33700
												}
											},
											{
												how: 27493,
												pick: 16743,
												value: {
													cls: 14363,
													sp: 27708
												}
											},
											{
												how: 123,
												pick: 14457,
												value: {
													cls: 48234,
													sp: 55563
												}
											},
											{
												how: 23706,
												pick: 35095,
												value: {
													cls: 24739,
													sp: 20462
												}
											}
										]
									}
								],
								where: [
									{
										left: 28438,
										op: 16916,
										pick: 28263,
										value: {
											cls: 24032,
											sp: 45337
										}
									}
								],
								between: [],
								inSet: [
									{
										left: 4201,
										values: [
											{
												cls: 6444,
												sp: 65510
											},
											{
												cls: 65281,
												sp: 26796
											}
										]
									}
								],
								allen: [],
								pointIn: [
									{
										span: 15333,
										point: 60199
									}
								],
								connective: [
									{
										kind: 7520,
										args: [
											{
												left: 24151,
												op: 52632,
												pick: 35586,
												value: {
													cls: 41950,
													sp: 13860
												}
											}
										]
									}
								],
								computed: [],
								negation: {
									source: 48111,
									picks: [38831, 45665]
								},
								head: {
									vars: [25179, 64590, 35506],
									names: [4616, 25034, 48898, 34977, 43220, 57912],
									folds: [
										{
											fn: 20146,
											arg: 46069,
											padded: 37243,
											scale: 21846
										}
									]
								},
								interior: {
									matches: [
										{
											source: 402,
											derived: 544,
											attached: 4735,
											binds: [
												{
													how: 41354,
													pick: 64614,
													value: {
														cls: 10729,
														sp: 4596
													}
												},
												{
													how: 29,
													pick: 10204,
													value: {
														cls: 27402,
														sp: 25606
													}
												},
												{
													how: 35902,
													pick: 18108,
													value: {
														cls: 15,
														sp: 32871
													}
												},
												{
													how: 12865,
													pick: 45640,
													value: {
														cls: 49576,
														sp: 19832
													}
												},
												{
													how: 38586,
													pick: 47779,
													value: {
														cls: 21272,
														sp: 64879
													}
												},
												{
													how: 23613,
													pick: 29039,
													value: {
														cls: 3779,
														sp: 65535
													}
												},
												{
													how: 45501,
													pick: 5152,
													value: {
														cls: 7745,
														sp: 42658
													}
												}
											]
										},
										{
											source: 41776,
											derived: 20720,
											attached: 50911,
											binds: [
												{
													how: 31786,
													pick: 50002,
													value: {
														cls: 46993,
														sp: 20032
													}
												},
												{
													how: 15959,
													pick: 31707,
													value: {
														cls: 42975,
														sp: 5830
													}
												},
												{
													how: 58486,
													pick: 18903,
													value: {
														cls: 56999,
														sp: 63638
													}
												},
												{
													how: 61553,
													pick: 6,
													value: {
														cls: 29086,
														sp: 24533
													}
												},
												{
													how: 64209,
													pick: 65534,
													value: {
														cls: 751,
														sp: 58115
													}
												},
												{
													how: 22576,
													pick: 65533,
													value: {
														cls: 64948,
														sp: 243
													}
												},
												{
													how: 12524,
													pick: 64914,
													value: {
														cls: 1731,
														sp: 34444
													}
												}
											]
										}
									],
									where: [
										{
											left: 5543,
											op: 41096,
											pick: 61637,
											value: {
												cls: 61335,
												sp: 51504
											}
										},
										{
											left: 63012,
											op: 56866,
											pick: 27377,
											value: {
												cls: 56505,
												sp: 17703
											}
										}
									],
									negation: {
										source: 28504,
										picks: [58877, 31730]
									},
									head: {
										vars: [50295, 6499],
										names: [34112, 17839, 48686, 15817, 21154, 57228],
										folds: [
											{
												fn: 33429,
												arg: 53631,
												padded: 1860,
												scale: 63937
											}
										]
									}
								}
							},
							take: {
								rotate: 32240,
								dirs: [17903, 8782, 65370],
								size: 48812
							}
						}
					}
				],
				order: {
					rotate: 58844,
					dirs: [13835, 5, 65087],
					size: 43595
				},
				probe: {
					kind: 23245,
					pick: 43030
				},
				key: {
					relation: 38719,
					which: 1119,
					fact: 10596,
					absent: 1770,
					roster: 21823
				}
			},
			{
				rule: {
					matches: [
						{
							source: 12357,
							derived: 17990,
							attached: 64384,
							binds: [
								{
									how: 51808,
									pick: 46465,
									value: {
										cls: 63437,
										sp: 26709
									}
								},
								{
									how: 22270,
									pick: 61848,
									value: {
										cls: 60158,
										sp: 42363
									}
								},
								{
									how: 61933,
									pick: 22927,
									value: {
										cls: 46087,
										sp: 10096
									}
								},
								{
									how: 7230,
									pick: 3764,
									value: {
										cls: 4,
										sp: 31067
									}
								},
								{
									how: 53837,
									pick: 36102,
									value: {
										cls: 48310,
										sp: 20197
									}
								},
								{
									how: 22533,
									pick: 37724,
									value: {
										cls: 21681,
										sp: 32711
									}
								},
								{
									how: 264,
									pick: 1755,
									value: {
										cls: 46255,
										sp: 63523
									}
								}
							]
						},
						{
							source: 45025,
							derived: 11545,
							attached: 24367,
							binds: [
								{
									how: 62125,
									pick: 49017,
									value: {
										cls: 54539,
										sp: 18443
									}
								},
								{
									how: 9231,
									pick: 65535,
									value: {
										cls: 6585,
										sp: 56935
									}
								},
								{
									how: 65533,
									pick: 37446,
									value: {
										cls: 10381,
										sp: 60023
									}
								},
								{
									how: 45085,
									pick: 47796,
									value: {
										cls: 48009,
										sp: 1816
									}
								},
								{
									how: 55583,
									pick: 65532,
									value: {
										cls: 64663,
										sp: 4755
									}
								},
								{
									how: 46264,
									pick: 11477,
									value: {
										cls: 55542,
										sp: 22782
									}
								},
								{
									how: 38250,
									pick: 9389,
									value: {
										cls: 33007,
										sp: 2791
									}
								}
							]
						}
					],
					where: [
						{
							left: 41128,
							op: 48885,
							pick: 50180,
							value: {
								cls: 50643,
								sp: 65425
							}
						},
						{
							left: 10686,
							op: 21004,
							pick: 40907,
							value: {
								cls: 28818,
								sp: 31796
							}
						}
					],
					between: [],
					inSet: [],
					allen: [],
					pointIn: [
						{
							span: 60651,
							point: 9739
						}
					],
					connective: [],
					computed: [
						{
							kind: 31563,
							reading: 14702,
							arg: 46795,
							op: 56676,
							than: {
								cls: 33861,
								sp: 29532
							},
							otherwise: {
								cls: 56692,
								sp: 21633
							},
							scale: 1518,
							padded: 1033
						}
					],
					negation: {
						source: 14179,
						picks: [48465, 57665]
					},
					head: {
						vars: [58975, 4194],
						names: [16461, 38249, 40204, 41780, 39602, 818],
						folds: [
							{
								fn: 30544,
								arg: 5221,
								padded: 5033,
								scale: 55193
							},
							{
								fn: 37958,
								arg: 10109,
								padded: 17470,
								scale: 33854
							}
						]
					},
					interior: {
						matches: [
							{
								source: 7,
								derived: 7416,
								attached: 64951,
								binds: [
									{
										how: 34716,
										pick: 45176,
										value: {
											cls: 44303,
											sp: 53230
										}
									},
									{
										how: 57444,
										pick: 7501,
										value: {
											cls: 55004,
											sp: 32010
										}
									},
									{
										how: 15433,
										pick: 27190,
										value: {
											cls: 65217,
											sp: 65473
										}
									},
									{
										how: 529,
										pick: 28034,
										value: {
											cls: 49818,
											sp: 25246
										}
									},
									{
										how: 4455,
										pick: 1288,
										value: {
											cls: 7553,
											sp: 56939
										}
									},
									{
										how: 48583,
										pick: 63642,
										value: {
											cls: 32159,
											sp: 39070
										}
									},
									{
										how: 62325,
										pick: 30939,
										value: {
											cls: 6739,
											sp: 52475
										}
									}
								]
							},
							{
								source: 10524,
								derived: 46106,
								attached: 8685,
								binds: [
									{
										how: 26497,
										pick: 14225,
										value: {
											cls: 2525,
											sp: 36132
										}
									},
									{
										how: 52831,
										pick: 58088,
										value: {
											cls: 7239,
											sp: 39793
										}
									},
									{
										how: 361,
										pick: 27376,
										value: {
											cls: 51384,
											sp: 48554
										}
									},
									{
										how: 5416,
										pick: 0,
										value: {
											cls: 18313,
											sp: 8187
										}
									},
									{
										how: 63489,
										pick: 52741,
										value: {
											cls: 12339,
											sp: 50858
										}
									},
									{
										how: 34173,
										pick: 36695,
										value: {
											cls: 19889,
											sp: 61175
										}
									},
									{
										how: 11363,
										pick: 50618,
										value: {
											cls: 27964,
											sp: 11532
										}
									}
								]
							}
						],
						where: [],
						negation: {
							source: 26523,
							picks: [16996, 6567]
						},
						head: {
							vars: [52123],
							names: [3462, 8327, 40448, 21458, 5773, 14341],
							folds: [
								{
									fn: 22006,
									arg: 61887,
									padded: 45601,
									scale: 54662
								}
							]
						}
					}
				},
				take: {
					rotate: 9239,
					dirs: [945, 31130, 44642],
					size: 61131,
					ties: 54639
				},
				literalHead: {
					name: 49906,
					kind: 21886,
					arms: 36268,
					values: [12004, 41869, 52121]
				},
				importable: 38634,
				bindImport: 65168,
				named: 6272,
				relationParam: {
					relation: 31080,
					facts: [
						{
							values: [
								{
									cls: 2740,
									sp: 48387
								},
								{
									cls: 56440,
									sp: 15
								},
								{
									cls: 14149,
									sp: 48433
								},
								{
									cls: 53830,
									sp: 38710
								},
								{
									cls: 32907,
									sp: 6840
								},
								{
									cls: 58860,
									sp: 50181
								},
								{
									cls: 22914,
									sp: 48522
								}
							]
						},
						{
							values: [
								{
									cls: 62499,
									sp: 65513
								},
								{
									cls: 65533,
									sp: 15852
								},
								{
									cls: 54606,
									sp: 50967
								},
								{
									cls: 19116,
									sp: 45003
								},
								{
									cls: 14106,
									sp: 53319
								},
								{
									cls: 3013,
									sp: 65533
								},
								{
									cls: 15958,
									sp: 5695
								}
							]
						}
					]
				},
				closure: {
					relation: 50779,
					pair: 57914,
					name: 65535
				},
				attachments: [
					{
						name: 61281,
						link: 15440,
						handle: 34838,
						delivery: 65527,
						rule: {
							matches: [
								{
									source: 31016,
									derived: 3832,
									attached: 9285,
									binds: [
										{
											how: 8589,
											pick: 27191,
											value: {
												cls: 40426,
												sp: 36839
											}
										},
										{
											how: 15133,
											pick: 4558,
											value: {
												cls: 34454,
												sp: 47064
											}
										},
										{
											how: 33893,
											pick: 24902,
											value: {
												cls: 32206,
												sp: 24629
											}
										},
										{
											how: 26344,
											pick: 45205,
											value: {
												cls: 52848,
												sp: 54119
											}
										},
										{
											how: 39745,
											pick: 4343,
											value: {
												cls: 65212,
												sp: 65534
											}
										},
										{
											how: 63569,
											pick: 47057,
											value: {
												cls: 43242,
												sp: 34178
											}
										},
										{
											how: 14827,
											pick: 37352,
											value: {
												cls: 16168,
												sp: 10042
											}
										}
									]
								}
							],
							where: [
								{
									left: 6376,
									op: 7474,
									pick: 29235,
									value: {
										cls: 27504,
										sp: 17975
									}
								}
							],
							between: [
								{
									left: 17370,
									low: {
										pick: 28354,
										value: {
											cls: 50287,
											sp: 29289
										}
									},
									high: {
										pick: 47465,
										value: {
											cls: 63866,
											sp: 17192
										}
									}
								}
							],
							inSet: [],
							allen: [
								{
									left: 4657,
									mask: 60675,
									right: 34436
								}
							],
							pointIn: [],
							connective: [
								{
									kind: 10018,
									args: [
										{
											left: 0,
											op: 65535,
											pick: 14279,
											value: {
												cls: 23817,
												sp: 61787
											}
										}
									]
								}
							],
							computed: [
								{
									kind: 49605,
									reading: 33001,
									arg: 7702,
									op: 64253,
									than: {
										cls: 10361,
										sp: 21179
									},
									otherwise: {
										cls: 7534,
										sp: 60037
									},
									scale: 37807,
									padded: 64673
								}
							],
							negation: {
								source: 22715,
								picks: [3048, 59]
							},
							head: {
								vars: [7069, 13642, 16546],
								names: [35117, 52712, 35508, 60169, 3677, 65529],
								folds: [
									{
										fn: 2079,
										arg: 65532,
										padded: 65535,
										scale: 21994
									},
									{
										fn: 10607,
										arg: 56273,
										padded: 17246,
										scale: 31018
									}
								]
							},
							interior: {
								matches: [
									{
										source: 43651,
										derived: 48009,
										attached: 64470,
										binds: [
											{
												how: 32491,
												pick: 53704,
												value: {
													cls: 65362,
													sp: 63152
												}
											},
											{
												how: 65518,
												pick: 6635,
												value: {
													cls: 41005,
													sp: 35774
												}
											},
											{
												how: 27969,
												pick: 17496,
												value: {
													cls: 33906,
													sp: 60598
												}
											},
											{
												how: 33918,
												pick: 24728,
												value: {
													cls: 12381,
													sp: 23413
												}
											},
											{
												how: 35887,
												pick: 31260,
												value: {
													cls: 11638,
													sp: 10300
												}
											},
											{
												how: 25562,
												pick: 65173,
												value: {
													cls: 63955,
													sp: 8134
												}
											},
											{
												how: 0,
												pick: 34495,
												value: {
													cls: 53293,
													sp: 2819
												}
											}
										]
									}
								],
								where: [
									{
										left: 13267,
										op: 19236,
										pick: 61213,
										value: {
											cls: 8386,
											sp: 7011
										}
									},
									{
										left: 17571,
										op: 722,
										pick: 63580,
										value: {
											cls: 44557,
											sp: 43732
										}
									}
								],
								negation: {
									source: 51859,
									picks: [42105, 6461]
								},
								head: {
									vars: [18679, 22573, 57124],
									names: [1980, 39673, 5, 65288, 10580, 35192],
									folds: [
										{
											fn: 65534,
											arg: 14093,
											padded: 37453,
											scale: 64877
										}
									]
								}
							}
						},
						take: {
							rotate: 60162,
							dirs: [6631, 24747, 5339],
							size: 25212
						},
						nested: {
							name: 19387,
							link: 59583,
							handle: 53523,
							delivery: 2226,
							rule: {
								matches: [
									{
										source: 65533,
										derived: 18225,
										attached: 33479,
										binds: [
											{
												how: 37204,
												pick: 54248,
												value: {
													cls: 48683,
													sp: 53652
												}
											},
											{
												how: 29683,
												pick: 11541,
												value: {
													cls: 10017,
													sp: 49250
												}
											},
											{
												how: 2855,
												pick: 45028,
												value: {
													cls: 2764,
													sp: 64858
												}
											},
											{
												how: 4,
												pick: 33304,
												value: {
													cls: 58562,
													sp: 34724
												}
											},
											{
												how: 59431,
												pick: 48824,
												value: {
													cls: 31472,
													sp: 54519
												}
											},
											{
												how: 62431,
												pick: 56051,
												value: {
													cls: 28338,
													sp: 5313
												}
											},
											{
												how: 27714,
												pick: 50049,
												value: {
													cls: 32414,
													sp: 3952
												}
											}
										]
									},
									{
										source: 54485,
										derived: 33210,
										attached: 47550,
										binds: [
											{
												how: 7,
												pick: 55458,
												value: {
													cls: 34304,
													sp: 64916
												}
											},
											{
												how: 50625,
												pick: 17496,
												value: {
													cls: 28188,
													sp: 3904
												}
											},
											{
												how: 28311,
												pick: 15755,
												value: {
													cls: 25847,
													sp: 7359
												}
											},
											{
												how: 32924,
												pick: 34371,
												value: {
													cls: 21902,
													sp: 22121
												}
											},
											{
												how: 61825,
												pick: 37936,
												value: {
													cls: 34392,
													sp: 35879
												}
											},
											{
												how: 53978,
												pick: 8124,
												value: {
													cls: 57483,
													sp: 56602
												}
											},
											{
												how: 12466,
												pick: 58712,
												value: {
													cls: 42718,
													sp: 35316
												}
											}
										]
									},
									{
										source: 25931,
										derived: 19486,
										attached: 37310,
										binds: [
											{
												how: 38671,
												pick: 12301,
												value: {
													cls: 61433,
													sp: 49074
												}
											},
											{
												how: 3968,
												pick: 51122,
												value: {
													cls: 54082,
													sp: 3914
												}
											},
											{
												how: 13943,
												pick: 65533,
												value: {
													cls: 41144,
													sp: 58653
												}
											},
											{
												how: 61377,
												pick: 6982,
												value: {
													cls: 7435,
													sp: 37486
												}
											},
											{
												how: 61152,
												pick: 9029,
												value: {
													cls: 39905,
													sp: 41454
												}
											},
											{
												how: 65534,
												pick: 14862,
												value: {
													cls: 17743,
													sp: 37475
												}
											},
											{
												how: 44933,
												pick: 64504,
												value: {
													cls: 57324,
													sp: 92
												}
											}
										]
									}
								],
								where: [],
								between: [],
								inSet: [
									{
										left: 27978,
										values: [
											{
												cls: 2,
												sp: 19333
											},
											{
												cls: 117,
												sp: 6399
											},
											{
												cls: 38281,
												sp: 18107
											}
										]
									}
								],
								allen: [],
								pointIn: [],
								connective: [
									{
										kind: 16769,
										args: []
									}
								],
								computed: [
									{
										kind: 19152,
										reading: 3387,
										arg: 28679,
										op: 45947,
										than: {
											cls: 32914,
											sp: 65525
										},
										otherwise: {
											cls: 161,
											sp: 45376
										},
										scale: 37638,
										padded: 8298
									}
								],
								negation: {
									source: 7230,
									picks: [49159, 44117]
								},
								head: {
									vars: [24919, 11234],
									names: [44008, 11688, 2, 10437, 13057, 4089],
									folds: [
										{
											fn: 30769,
											arg: 32867,
											padded: 12575,
											scale: 32709
										},
										{
											fn: 49532,
											arg: 35539,
											padded: 41710,
											scale: 1
										}
									]
								},
								interior: {
									matches: [
										{
											source: 59198,
											derived: 19394,
											attached: 28091,
											binds: [
												{
													how: 61403,
													pick: 17785,
													value: {
														cls: 36516,
														sp: 2162
													}
												},
												{
													how: 28265,
													pick: 4,
													value: {
														cls: 17335,
														sp: 60972
													}
												},
												{
													how: 64201,
													pick: 43469,
													value: {
														cls: 30775,
														sp: 22
													}
												},
												{
													how: 57524,
													pick: 11886,
													value: {
														cls: 65510,
														sp: 37564
													}
												},
												{
													how: 36895,
													pick: 53983,
													value: {
														cls: 57490,
														sp: 24217
													}
												},
												{
													how: 39614,
													pick: 26826,
													value: {
														cls: 48,
														sp: 34255
													}
												},
												{
													how: 1680,
													pick: 55576,
													value: {
														cls: 34706,
														sp: 6597
													}
												}
											]
										},
										{
											source: 64272,
											derived: 21019,
											attached: 62142,
											binds: [
												{
													how: 45718,
													pick: 53852,
													value: {
														cls: 31008,
														sp: 58485
													}
												},
												{
													how: 12010,
													pick: 52895,
													value: {
														cls: 46799,
														sp: 0
													}
												},
												{
													how: 36246,
													pick: 0,
													value: {
														cls: 50474,
														sp: 37471
													}
												},
												{
													how: 40043,
													pick: 52601,
													value: {
														cls: 9972,
														sp: 12415
													}
												},
												{
													how: 19709,
													pick: 37422,
													value: {
														cls: 21410,
														sp: 14165
													}
												},
												{
													how: 59075,
													pick: 49601,
													value: {
														cls: 56516,
														sp: 49794
													}
												},
												{
													how: 18675,
													pick: 60471,
													value: {
														cls: 24181,
														sp: 48603
													}
												}
											]
										}
									],
									where: [
										{
											left: 5317,
											op: 22073,
											pick: 25762,
											value: {
												cls: 160,
												sp: 47165
											}
										}
									],
									negation: {
										source: 1128,
										picks: [9845, 82]
									},
									head: {
										vars: [55987],
										names: [41026, 38398, 20804, 15781, 25331, 35450],
										folds: [
											{
												fn: 312,
												arg: 65221,
												padded: 31974,
												scale: 60278
											},
											{
												fn: 4568,
												arg: 41927,
												padded: 19130,
												scale: 64106
											}
										]
									}
								}
							},
							take: {
								rotate: 41535,
								dirs: [64798, 4799, 65534],
								size: 27285
							}
						}
					}
				],
				order: {
					rotate: 49225,
					dirs: [19842, 62138, 61686],
					size: 24068
				},
				probe: {
					kind: 17025,
					pick: 23108
				},
				key: {
					relation: 64441,
					which: 65526,
					fact: 28509,
					absent: 33516,
					roster: 20204
				}
			}
		],
		planted: {
			names: [
				22549, 46394, 33003, 26529, 29056, 54394, 54687, 3269, 32252, 4288, 43820, 7358, 54803,
				21014, 13734, 64602, 43503, 24209, 13811, 45305, 28690, 65524, 57686, 59949, 12353, 44856,
				127, 12005, 33131, 6238, 30945, 60626, 43523, 31, 96, 65535, 24194, 24306, 61372, 22936,
				5725, 6489, 37678, 34312, 65421, 5920, 26920, 59572, 59967, 39892, 34594
			],
			value: {
				cls: 62280,
				sp: 6904
			},
			handle: 52140,
			padding: 51009,
			side: {
				kind: 586,
				values: [20721, 61838, 24023]
			}
		}
	}),
	drawnReads({
		population: "spelled",
		swarm: {
			"bind fresh": 3,
			"bind parent": 2,
			"compare literal": 3,
			"compare var": 2,
			"compare param": 1,
			"attached take": 2,
			ordered: 3,
			attach: 3,
			nested: 3,
			dense: 3,
			"candidate key": 1,
			"key read": 1,
			probe: 2,
			spelled: 3,
			"full head": 3,
			ungrouped: 3,
			"keyed child": 2,
			"arm child": 1,
			import: 2,
			"import bound": 1,
			interior: 3,
			named: 3,
			"computed head": 1,
			"computed group key": 3,
			between: 3,
			"in set": 3,
			connective: 1,
			"relation param": 1,
			recursive: 1,
			"contract param": 3,
			"typmod param": 1,
			allen: 1,
			"point in": 3,
			"literal head": 1
		},
		perturbation: {
			settings: [
				"enable_hashjoin = off",
				"debug_parallel_query = regress",
				"plan_cache_mode = force_generic_plan",
				"parallel_tuple_cost = 0"
			],
			multiplier: 1
		},
		ambient: {
			path: {
				kind: "default"
			},
			settings: [
				{
					parameter: "extra_float_digits",
					value: "1"
				},
				{
					parameter: "IntervalStyle",
					value: "iso_8601"
				},
				{
					parameter: "bytea_output",
					value: "escape"
				}
			]
		},
		restorage: {
			shift: 13,
			respell: 1023
		},
		roster: 38690,
		span: 32938,
		relations: [
			{
				name: 23429,
				fields: [
					{
						name: 23483,
						kind: 53547,
						key: 18
					},
					{
						name: 22169,
						kind: 36841,
						key: 64695
					}
				],
				candidate: 46176,
				facts: [
					{
						values: [
							{
								cls: 6,
								sp: 5452
							},
							{
								cls: 6444,
								sp: 65212
							},
							{
								cls: 3453,
								sp: 25063
							},
							{
								cls: 47268,
								sp: 52295
							},
							{
								cls: 587,
								sp: 49595
							},
							{
								cls: 22692,
								sp: 30111
							},
							{
								cls: 25120,
								sp: 21536
							}
						]
					},
					{
						values: [
							{
								cls: 18353,
								sp: 65059
							},
							{
								cls: 24561,
								sp: 65205
							},
							{
								cls: 12558,
								sp: 40536
							},
							{
								cls: 54441,
								sp: 65424
							},
							{
								cls: 3797,
								sp: 60685
							},
							{
								cls: 57039,
								sp: 813
							},
							{
								cls: 65527,
								sp: 51882
							}
						]
					}
				]
			},
			{
				name: 58918,
				fields: [
					{
						name: 88,
						kind: 40646,
						key: 3541
					},
					{
						name: 26203,
						kind: 36567,
						key: 35263
					},
					{
						name: 45873,
						kind: 14883,
						key: 6964
					}
				],
				candidate: 97,
				facts: [
					{
						values: [
							{
								cls: 63030,
								sp: 3870
							},
							{
								cls: 5322,
								sp: 316
							},
							{
								cls: 20133,
								sp: 36499
							},
							{
								cls: 52256,
								sp: 49929
							},
							{
								cls: 425,
								sp: 48874
							},
							{
								cls: 63199,
								sp: 31697
							},
							{
								cls: 33933,
								sp: 47758
							}
						]
					},
					{
						values: [
							{
								cls: 31292,
								sp: 30303
							},
							{
								cls: 20510,
								sp: 9571
							},
							{
								cls: 39170,
								sp: 54293
							},
							{
								cls: 42590,
								sp: 54084
							},
							{
								cls: 19952,
								sp: 23019
							},
							{
								cls: 65534,
								sp: 31657
							},
							{
								cls: 24463,
								sp: 50951
							}
						]
					},
					{
						values: [
							{
								cls: 3163,
								sp: 53420
							},
							{
								cls: 44007,
								sp: 44993
							},
							{
								cls: 63485,
								sp: 48216
							},
							{
								cls: 48995,
								sp: 61736
							},
							{
								cls: 10138,
								sp: 51271
							},
							{
								cls: 60109,
								sp: 28996
							},
							{
								cls: 53722,
								sp: 53679
							}
						]
					},
					{
						values: [
							{
								cls: 24525,
								sp: 12283
							},
							{
								cls: 21688,
								sp: 20169
							},
							{
								cls: 44488,
								sp: 55326
							},
							{
								cls: 64314,
								sp: 42485
							},
							{
								cls: 38893,
								sp: 21256
							},
							{
								cls: 65534,
								sp: 2566
							},
							{
								cls: 63661,
								sp: 24
							}
						]
					}
				]
			},
			{
				name: 65034,
				fields: [
					{
						name: 9229,
						kind: 56118,
						key: 48218
					},
					{
						name: 56750,
						kind: 23528,
						key: 64758
					},
					{
						name: 48216,
						kind: 65524,
						key: 44933
					}
				],
				candidate: 18374,
				facts: [
					{
						values: [
							{
								cls: 25843,
								sp: 42182
							},
							{
								cls: 28766,
								sp: 47450
							},
							{
								cls: 51181,
								sp: 65533
							},
							{
								cls: 13997,
								sp: 40799
							},
							{
								cls: 51949,
								sp: 49288
							},
							{
								cls: 65504,
								sp: 18074
							},
							{
								cls: 8233,
								sp: 65507
							}
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
							source: 31271,
							derived: 39801,
							attached: 65533,
							binds: [
								{
									how: 1661,
									pick: 27984,
									value: {
										cls: 13,
										sp: 40587
									}
								},
								{
									how: 9842,
									pick: 50213,
									value: {
										cls: 16699,
										sp: 45592
									}
								},
								{
									how: 20972,
									pick: 332,
									value: {
										cls: 490,
										sp: 22886
									}
								},
								{
									how: 61798,
									pick: 2829,
									value: {
										cls: 34926,
										sp: 62018
									}
								},
								{
									how: 4343,
									pick: 63716,
									value: {
										cls: 26765,
										sp: 12056
									}
								},
								{
									how: 40813,
									pick: 26469,
									value: {
										cls: 36494,
										sp: 17325
									}
								},
								{
									how: 3077,
									pick: 39503,
									value: {
										cls: 62629,
										sp: 58428
									}
								}
							]
						},
						{
							source: 24231,
							derived: 49501,
							attached: 34475,
							binds: [
								{
									how: 48875,
									pick: 30980,
									value: {
										cls: 62781,
										sp: 65533
									}
								},
								{
									how: 42840,
									pick: 63716,
									value: {
										cls: 45841,
										sp: 9181
									}
								},
								{
									how: 62612,
									pick: 7216,
									value: {
										cls: 29708,
										sp: 51394
									}
								},
								{
									how: 32198,
									pick: 65533,
									value: {
										cls: 20081,
										sp: 57062
									}
								},
								{
									how: 65428,
									pick: 34231,
									value: {
										cls: 52435,
										sp: 5354
									}
								},
								{
									how: 45445,
									pick: 52637,
									value: {
										cls: 44464,
										sp: 50742
									}
								},
								{
									how: 64921,
									pick: 44212,
									value: {
										cls: 35039,
										sp: 39028
									}
								}
							]
						},
						{
							source: 32423,
							derived: 22969,
							attached: 54601,
							binds: [
								{
									how: 15929,
									pick: 4608,
									value: {
										cls: 5560,
										sp: 40986
									}
								},
								{
									how: 65535,
									pick: 65346,
									value: {
										cls: 48818,
										sp: 54510
									}
								},
								{
									how: 1431,
									pick: 50434,
									value: {
										cls: 60468,
										sp: 4445
									}
								},
								{
									how: 23345,
									pick: 38283,
									value: {
										cls: 21823,
										sp: 25322
									}
								},
								{
									how: 53334,
									pick: 31859,
									value: {
										cls: 33534,
										sp: 64968
									}
								},
								{
									how: 27111,
									pick: 65525,
									value: {
										cls: 144,
										sp: 28577
									}
								},
								{
									how: 49339,
									pick: 26370,
									value: {
										cls: 33816,
										sp: 7001
									}
								}
							]
						}
					],
					where: [],
					between: [
						{
							left: 26168,
							low: {
								pick: 64407,
								value: {
									cls: 33650,
									sp: 62999
								}
							},
							high: {
								pick: 9797,
								value: {
									cls: 43,
									sp: 33916
								}
							}
						}
					],
					inSet: [],
					allen: [],
					pointIn: [
						{
							span: 56896,
							point: 54899
						}
					],
					connective: [],
					computed: [
						{
							kind: 5340,
							reading: 60114,
							arg: 63247,
							op: 38371,
							than: {
								cls: 58935,
								sp: 12678
							},
							otherwise: {
								cls: 59761,
								sp: 1278
							},
							scale: 25914,
							padded: 10610
						},
						{
							kind: 22041,
							reading: 48122,
							arg: 33957,
							op: 2629,
							than: {
								cls: 16958,
								sp: 64654
							},
							otherwise: {
								cls: 14814,
								sp: 32278
							},
							scale: 4486,
							padded: 15999
						}
					],
					negation: {
						source: 15703,
						picks: [57673, 58213]
					},
					head: {
						vars: [39143, 64802],
						names: [24396, 12118, 49788, 20087, 1349, 29033],
						folds: [
							{
								fn: 52243,
								arg: 20310,
								padded: 436,
								scale: 37146
							}
						]
					},
					interior: {
						matches: [
							{
								source: 16243,
								derived: 5050,
								attached: 0,
								binds: [
									{
										how: 20999,
										pick: 65288,
										value: {
											cls: 54239,
											sp: 43184
										}
									},
									{
										how: 144,
										pick: 46868,
										value: {
											cls: 1352,
											sp: 60335
										}
									},
									{
										how: 27024,
										pick: 7322,
										value: {
											cls: 49572,
											sp: 13764
										}
									},
									{
										how: 54339,
										pick: 54967,
										value: {
											cls: 65534,
											sp: 39865
										}
									},
									{
										how: 34835,
										pick: 17417,
										value: {
											cls: 8377,
											sp: 44649
										}
									},
									{
										how: 27351,
										pick: 53340,
										value: {
											cls: 62827,
											sp: 52043
										}
									},
									{
										how: 50205,
										pick: 27356,
										value: {
											cls: 35722,
											sp: 54611
										}
									}
								]
							}
						],
						where: [
							{
								left: 34658,
								op: 59870,
								pick: 4332,
								value: {
									cls: 39739,
									sp: 55386
								}
							},
							{
								left: 5116,
								op: 27820,
								pick: 53754,
								value: {
									cls: 8756,
									sp: 64128
								}
							}
						],
						negation: {
							source: 54698,
							picks: [37449, 30797]
						},
						head: {
							vars: [39508, 42341],
							names: [30605, 12502, 8997, 16167, 15864, 11443],
							folds: [
								{
									fn: 45479,
									arg: 48627,
									padded: 22793,
									scale: 39838
								}
							]
						}
					}
				},
				take: {
					rotate: 13964,
					dirs: [51576, 7262, 35459],
					size: 64074,
					ties: 46068
				},
				literalHead: {
					name: 29531,
					kind: 61079,
					arms: 46983,
					values: [2528, 27926, 58745]
				},
				importable: 65431,
				bindImport: 25065,
				named: 11011,
				relationParam: {
					relation: 10729,
					facts: [
						{
							values: [
								{
									cls: 41160,
									sp: 3830
								},
								{
									cls: 50031,
									sp: 16226
								},
								{
									cls: 43101,
									sp: 42203
								},
								{
									cls: 37460,
									sp: 45714
								},
								{
									cls: 4731,
									sp: 23452
								},
								{
									cls: 29410,
									sp: 34027
								},
								{
									cls: 43345,
									sp: 44635
								}
							]
						},
						{
							values: [
								{
									cls: 1,
									sp: 43783
								},
								{
									cls: 15362,
									sp: 29141
								},
								{
									cls: 47452,
									sp: 13041
								},
								{
									cls: 65456,
									sp: 26808
								},
								{
									cls: 13247,
									sp: 62408
								},
								{
									cls: 55815,
									sp: 21009
								},
								{
									cls: 47904,
									sp: 45153
								}
							]
						},
						{
							values: [
								{
									cls: 65531,
									sp: 41312
								},
								{
									cls: 65474,
									sp: 4
								},
								{
									cls: 58163,
									sp: 39925
								},
								{
									cls: 717,
									sp: 1854
								},
								{
									cls: 60493,
									sp: 49613
								},
								{
									cls: 27309,
									sp: 65455
								},
								{
									cls: 52178,
									sp: 56154
								}
							]
						}
					]
				},
				closure: {
					relation: 18155,
					pair: 24200,
					name: 62580
				},
				attachments: [
					{
						name: 28078,
						link: 52488,
						handle: 49177,
						delivery: 65535,
						rule: {
							matches: [
								{
									source: 36614,
									derived: 58973,
									attached: 30126,
									binds: [
										{
											how: 59545,
											pick: 14402,
											value: {
												cls: 24,
												sp: 65533
											}
										},
										{
											how: 46694,
											pick: 5798,
											value: {
												cls: 32343,
												sp: 58485
											}
										},
										{
											how: 5518,
											pick: 40479,
											value: {
												cls: 2753,
												sp: 39763
											}
										},
										{
											how: 31349,
											pick: 48651,
											value: {
												cls: 51955,
												sp: 6960
											}
										},
										{
											how: 49873,
											pick: 26168,
											value: {
												cls: 24057,
												sp: 16156
											}
										},
										{
											how: 36719,
											pick: 44800,
											value: {
												cls: 62362,
												sp: 15360
											}
										},
										{
											how: 2043,
											pick: 36348,
											value: {
												cls: 57791,
												sp: 0
											}
										}
									]
								}
							],
							where: [
								{
									left: 49892,
									op: 39463,
									pick: 21242,
									value: {
										cls: 6443,
										sp: 19125
									}
								}
							],
							between: [
								{
									left: 33542,
									low: {
										pick: 60333,
										value: {
											cls: 37254,
											sp: 33685
										}
									},
									high: {
										pick: 47131,
										value: {
											cls: 1812,
											sp: 23985
										}
									}
								}
							],
							inSet: [
								{
									left: 20589,
									values: [
										{
											cls: 57595,
											sp: 2004
										},
										{
											cls: 42879,
											sp: 7266
										},
										{
											cls: 15927,
											sp: 12685
										}
									]
								}
							],
							allen: [],
							pointIn: [
								{
									span: 11389,
									point: 45315
								}
							],
							connective: [
								{
									kind: 8208,
									args: []
								}
							],
							computed: [
								{
									kind: 4802,
									reading: 3207,
									arg: 46479,
									op: 32544,
									than: {
										cls: 27896,
										sp: 58114
									},
									otherwise: {
										cls: 26763,
										sp: 8542
									},
									scale: 65534,
									padded: 42644
								}
							],
							negation: {
								source: 58159,
								picks: [65015, 19998]
							},
							head: {
								vars: [43321, 21882, 36530],
								names: [19723, 65535, 24135, 35772, 9784, 12147],
								folds: [
									{
										fn: 35570,
										arg: 46986,
										padded: 43617,
										scale: 56702
									},
									{
										fn: 17230,
										arg: 4798,
										padded: 49216,
										scale: 63117
									}
								]
							},
							interior: {
								matches: [
									{
										source: 50006,
										derived: 24729,
										attached: 36413,
										binds: [
											{
												how: 39556,
												pick: 45681,
												value: {
													cls: 43991,
													sp: 20903
												}
											},
											{
												how: 39197,
												pick: 24579,
												value: {
													cls: 43840,
													sp: 52401
												}
											},
											{
												how: 31961,
												pick: 18303,
												value: {
													cls: 36169,
													sp: 55790
												}
											},
											{
												how: 47982,
												pick: 24607,
												value: {
													cls: 15,
													sp: 28319
												}
											},
											{
												how: 57433,
												pick: 13805,
												value: {
													cls: 44970,
													sp: 22150
												}
											},
											{
												how: 65528,
												pick: 63242,
												value: {
													cls: 5004,
													sp: 14387
												}
											},
											{
												how: 114,
												pick: 58136,
												value: {
													cls: 114,
													sp: 59499
												}
											}
										]
									}
								],
								where: [],
								negation: {
									source: 7127,
									picks: [28973, 14840]
								},
								head: {
									vars: [],
									names: [48056, 65525, 30906, 40216, 63495, 50706],
									folds: [
										{
											fn: 23442,
											arg: 62332,
											padded: 31337,
											scale: 9174
										},
										{
											fn: 31557,
											arg: 35313,
											padded: 57863,
											scale: 7887
										}
									]
								}
							}
						},
						take: {
							rotate: 7847,
							dirs: [4680, 7763, 723],
							size: 27137
						},
						nested: {
							name: 40777,
							link: 38660,
							handle: 58365,
							delivery: 455,
							rule: {
								matches: [
									{
										source: 25625,
										derived: 28606,
										attached: 55050,
										binds: [
											{
												how: 60733,
												pick: 45930,
												value: {
													cls: 423,
													sp: 50056
												}
											},
											{
												how: 7006,
												pick: 21869,
												value: {
													cls: 22181,
													sp: 63389
												}
											},
											{
												how: 45396,
												pick: 14880,
												value: {
													cls: 39670,
													sp: 65411
												}
											},
											{
												how: 61918,
												pick: 39243,
												value: {
													cls: 35970,
													sp: 22907
												}
											},
											{
												how: 1,
												pick: 10571,
												value: {
													cls: 28887,
													sp: 36551
												}
											},
											{
												how: 24346,
												pick: 14859,
												value: {
													cls: 42,
													sp: 43717
												}
											},
											{
												how: 46395,
												pick: 23561,
												value: {
													cls: 15407,
													sp: 44089
												}
											}
										]
									}
								],
								where: [
									{
										left: 2116,
										op: 36981,
										pick: 62597,
										value: {
											cls: 29477,
											sp: 13296
										}
									}
								],
								between: [],
								inSet: [
									{
										left: 2,
										values: [
											{
												cls: 2698,
												sp: 50944
											},
											{
												cls: 5274,
												sp: 40537
											}
										]
									}
								],
								allen: [],
								pointIn: [],
								connective: [],
								computed: [],
								negation: {
									source: 24551,
									picks: [21903, 1691]
								},
								head: {
									vars: [64077],
									names: [1298, 13714, 52616, 65492, 52002, 246],
									folds: [
										{
											fn: 30655,
											arg: 58851,
											padded: 16815,
											scale: 59960
										},
										{
											fn: 37846,
											arg: 1282,
											padded: 6721,
											scale: 24455
										}
									]
								},
								interior: {
									matches: [
										{
											source: 60903,
											derived: 57193,
											attached: 51905,
											binds: [
												{
													how: 28805,
													pick: 54861,
													value: {
														cls: 11503,
														sp: 45
													}
												},
												{
													how: 8,
													pick: 41,
													value: {
														cls: 21118,
														sp: 51410
													}
												},
												{
													how: 36652,
													pick: 58138,
													value: {
														cls: 5817,
														sp: 63580
													}
												},
												{
													how: 0,
													pick: 13112,
													value: {
														cls: 10517,
														sp: 44604
													}
												},
												{
													how: 58876,
													pick: 36944,
													value: {
														cls: 47130,
														sp: 3187
													}
												},
												{
													how: 37865,
													pick: 29703,
													value: {
														cls: 18194,
														sp: 21764
													}
												},
												{
													how: 28953,
													pick: 6469,
													value: {
														cls: 28213,
														sp: 62802
													}
												}
											]
										}
									],
									where: [
										{
											left: 25957,
											op: 51319,
											pick: 14783,
											value: {
												cls: 45041,
												sp: 18462
											}
										},
										{
											left: 1046,
											op: 8194,
											pick: 61125,
											value: {
												cls: 44250,
												sp: 64853
											}
										}
									],
									negation: {
										source: 10807,
										picks: [9030, 23]
									},
									head: {
										vars: [38, 57849, 10444],
										names: [36595, 13458, 45218, 24437, 8470, 24072],
										folds: [
											{
												fn: 46392,
												arg: 23058,
												padded: 65470,
												scale: 9587
											}
										]
									}
								}
							},
							take: {
								rotate: 54212,
								dirs: [57063, 18673, 0],
								size: 24140
							}
						}
					},
					{
						name: 7149,
						link: 11883,
						handle: 50389,
						delivery: 43504,
						rule: {
							matches: [
								{
									source: 1953,
									derived: 26961,
									attached: 32909,
									binds: [
										{
											how: 27335,
											pick: 13646,
											value: {
												cls: 18741,
												sp: 52501
											}
										},
										{
											how: 55714,
											pick: 10335,
											value: {
												cls: 14354,
												sp: 59379
											}
										},
										{
											how: 411,
											pick: 58137,
											value: {
												cls: 41837,
												sp: 21906
											}
										},
										{
											how: 46236,
											pick: 55816,
											value: {
												cls: 40748,
												sp: 55659
											}
										},
										{
											how: 35803,
											pick: 42961,
											value: {
												cls: 50510,
												sp: 52076
											}
										},
										{
											how: 62942,
											pick: 54096,
											value: {
												cls: 13887,
												sp: 28189
											}
										},
										{
											how: 31855,
											pick: 8777,
											value: {
												cls: 61059,
												sp: 9939
											}
										}
									]
								},
								{
									source: 32610,
									derived: 65507,
									attached: 1,
									binds: [
										{
											how: 1282,
											pick: 28415,
											value: {
												cls: 23118,
												sp: 17530
											}
										},
										{
											how: 23647,
											pick: 14735,
											value: {
												cls: 45174,
												sp: 42418
											}
										},
										{
											how: 1161,
											pick: 2,
											value: {
												cls: 44799,
												sp: 55491
											}
										},
										{
											how: 54746,
											pick: 2041,
											value: {
												cls: 43206,
												sp: 10141
											}
										},
										{
											how: 63972,
											pick: 5610,
											value: {
												cls: 38811,
												sp: 37794
											}
										},
										{
											how: 65534,
											pick: 47227,
											value: {
												cls: 196,
												sp: 19327
											}
										},
										{
											how: 57003,
											pick: 4205,
											value: {
												cls: 34680,
												sp: 20449
											}
										}
									]
								}
							],
							where: [
								{
									left: 449,
									op: 4280,
									pick: 37492,
									value: {
										cls: 3423,
										sp: 55586
									}
								},
								{
									left: 55470,
									op: 29981,
									pick: 54475,
									value: {
										cls: 64445,
										sp: 26560
									}
								}
							],
							between: [
								{
									left: 3743,
									low: {
										pick: 44598,
										value: {
											cls: 48869,
											sp: 12248
										}
									},
									high: {
										pick: 65444,
										value: {
											cls: 42093,
											sp: 24577
										}
									}
								}
							],
							inSet: [],
							allen: [
								{
									left: 13896,
									mask: 45267,
									right: 64742
								}
							],
							pointIn: [],
							connective: [
								{
									kind: 20471,
									args: [
										{
											left: 78,
											op: 55172,
											pick: 10474,
											value: {
												cls: 27487,
												sp: 30363
											}
										},
										{
											left: 5926,
											op: 3923,
											pick: 58613,
											value: {
												cls: 25548,
												sp: 13165
											}
										}
									]
								}
							],
							computed: [
								{
									kind: 0,
									reading: 3764,
									arg: 62069,
									op: 16625,
									than: {
										cls: 65535,
										sp: 33281
									},
									otherwise: {
										cls: 5467,
										sp: 50039
									},
									scale: 34888,
									padded: 62326
								}
							],
							negation: {
								source: 43429,
								picks: [4607, 25916]
							},
							head: {
								vars: [34370, 36506],
								names: [63406, 1782, 64400, 20891, 2465, 21556],
								folds: [
									{
										fn: 63625,
										arg: 52976,
										padded: 54041,
										scale: 8711
									},
									{
										fn: 30076,
										arg: 14216,
										padded: 20983,
										scale: 8626
									}
								]
							},
							interior: {
								matches: [
									{
										source: 58344,
										derived: 793,
										attached: 65300,
										binds: [
											{
												how: 13495,
												pick: 54686,
												value: {
													cls: 30245,
													sp: 31293
												}
											},
											{
												how: 53848,
												pick: 39385,
												value: {
													cls: 3759,
													sp: 3917
												}
											},
											{
												how: 36236,
												pick: 28600,
												value: {
													cls: 8279,
													sp: 21305
												}
											},
											{
												how: 53366,
												pick: 58276,
												value: {
													cls: 50721,
													sp: 44606
												}
											},
											{
												how: 32035,
												pick: 2133,
												value: {
													cls: 15763,
													sp: 12843
												}
											},
											{
												how: 48792,
												pick: 3,
												value: {
													cls: 30137,
													sp: 37111
												}
											},
											{
												how: 36196,
												pick: 65525,
												value: {
													cls: 54019,
													sp: 2
												}
											}
										]
									}
								],
								where: [
									{
										left: 2224,
										op: 33858,
										pick: 13085,
										value: {
											cls: 24951,
											sp: 25147
										}
									}
								],
								negation: {
									source: 41276,
									picks: [13577, 33062]
								},
								head: {
									vars: [65535],
									names: [21513, 33810, 3808, 24689, 38791, 20659],
									folds: [
										{
											fn: 14227,
											arg: 65371,
											padded: 48952,
											scale: 37635
										},
										{
											fn: 0,
											arg: 52339,
											padded: 17800,
											scale: 37195
										}
									]
								}
							}
						},
						take: {
							rotate: 31992,
							dirs: [25750, 58768, 4109],
							size: 49533
						},
						nested: {
							name: 65039,
							link: 40187,
							handle: 9986,
							delivery: 2280,
							rule: {
								matches: [
									{
										source: 26452,
										derived: 34607,
										attached: 18668,
										binds: [
											{
												how: 169,
												pick: 416,
												value: {
													cls: 59458,
													sp: 25388
												}
											},
											{
												how: 2952,
												pick: 16568,
												value: {
													cls: 56457,
													sp: 31565
												}
											},
											{
												how: 100,
												pick: 18195,
												value: {
													cls: 20775,
													sp: 44596
												}
											},
											{
												how: 6175,
												pick: 744,
												value: {
													cls: 1112,
													sp: 7466
												}
											},
											{
												how: 14624,
												pick: 2717,
												value: {
													cls: 16,
													sp: 23653
												}
											},
											{
												how: 51283,
												pick: 44145,
												value: {
													cls: 60470,
													sp: 33449
												}
											},
											{
												how: 40956,
												pick: 36931,
												value: {
													cls: 1913,
													sp: 63953
												}
											}
										]
									},
									{
										source: 21919,
										derived: 44551,
										attached: 34044,
										binds: [
											{
												how: 1,
												pick: 49203,
												value: {
													cls: 38387,
													sp: 64666
												}
											},
											{
												how: 17620,
												pick: 22817,
												value: {
													cls: 24185,
													sp: 33232
												}
											},
											{
												how: 7460,
												pick: 20585,
												value: {
													cls: 40314,
													sp: 23428
												}
											},
											{
												how: 60012,
												pick: 44897,
												value: {
													cls: 5931,
													sp: 19414
												}
											},
											{
												how: 51270,
												pick: 54029,
												value: {
													cls: 6646,
													sp: 3139
												}
											},
											{
												how: 41213,
												pick: 13364,
												value: {
													cls: 62328,
													sp: 38663
												}
											},
											{
												how: 22007,
												pick: 13757,
												value: {
													cls: 64290,
													sp: 5
												}
											}
										]
									},
									{
										source: 27534,
										derived: 56080,
										attached: 6747,
										binds: [
											{
												how: 45827,
												pick: 6096,
												value: {
													cls: 53373,
													sp: 60935
												}
											},
											{
												how: 46488,
												pick: 1082,
												value: {
													cls: 44748,
													sp: 25650
												}
											},
											{
												how: 7814,
												pick: 32761,
												value: {
													cls: 8638,
													sp: 147
												}
											},
											{
												how: 9248,
												pick: 45596,
												value: {
													cls: 1596,
													sp: 64905
												}
											},
											{
												how: 23408,
												pick: 60569,
												value: {
													cls: 27541,
													sp: 23253
												}
											},
											{
												how: 27677,
												pick: 49116,
												value: {
													cls: 65529,
													sp: 0
												}
											},
											{
												how: 9322,
												pick: 37484,
												value: {
													cls: 834,
													sp: 20445
												}
											}
										]
									}
								],
								where: [
									{
										left: 42666,
										op: 27574,
										pick: 13430,
										value: {
											cls: 33155,
											sp: 32185
										}
									},
									{
										left: 16938,
										op: 39304,
										pick: 28933,
										value: {
											cls: 47752,
											sp: 53204
										}
									}
								],
								between: [],
								inSet: [
									{
										left: 62878,
										values: [
											{
												cls: 51448,
												sp: 44233
											},
											{
												cls: 38473,
												sp: 3958
											},
											{
												cls: 10,
												sp: 271
											}
										]
									}
								],
								allen: [
									{
										left: 20788,
										mask: 641,
										right: 6720
									}
								],
								pointIn: [],
								connective: [
									{
										kind: 17916,
										args: [
											{
												left: 5808,
												op: 64243,
												pick: 60505,
												value: {
													cls: 102,
													sp: 11264
												}
											}
										]
									}
								],
								computed: [],
								negation: {
									source: 26926,
									picks: [20402, 64574]
								},
								head: {
									vars: [51142, 59098, 33626],
									names: [56116, 2835, 50455, 16334, 57075, 2611],
									folds: [
										{
											fn: 21667,
											arg: 41960,
											padded: 3282,
											scale: 55306
										},
										{
											fn: 57657,
											arg: 60332,
											padded: 3159,
											scale: 55093
										}
									]
								},
								interior: {
									matches: [
										{
											source: 5056,
											derived: 24639,
											attached: 34185,
											binds: [
												{
													how: 16387,
													pick: 38990,
													value: {
														cls: 23336,
														sp: 24538
													}
												},
												{
													how: 19869,
													pick: 24819,
													value: {
														cls: 6611,
														sp: 47028
													}
												},
												{
													how: 35719,
													pick: 7126,
													value: {
														cls: 1723,
														sp: 17577
													}
												},
												{
													how: 54718,
													pick: 32217,
													value: {
														cls: 32132,
														sp: 5
													}
												},
												{
													how: 37417,
													pick: 47283,
													value: {
														cls: 2955,
														sp: 65535
													}
												},
												{
													how: 26549,
													pick: 65221,
													value: {
														cls: 49113,
														sp: 28097
													}
												},
												{
													how: 18400,
													pick: 65508,
													value: {
														cls: 2752,
														sp: 39871
													}
												}
											]
										},
										{
											source: 48498,
											derived: 55752,
											attached: 42944,
											binds: [
												{
													how: 19245,
													pick: 33547,
													value: {
														cls: 64066,
														sp: 50521
													}
												},
												{
													how: 37145,
													pick: 7546,
													value: {
														cls: 38076,
														sp: 55446
													}
												},
												{
													how: 31194,
													pick: 65534,
													value: {
														cls: 20698,
														sp: 61758
													}
												},
												{
													how: 56508,
													pick: 30999,
													value: {
														cls: 43185,
														sp: 39243
													}
												},
												{
													how: 65242,
													pick: 20255,
													value: {
														cls: 33679,
														sp: 40502
													}
												},
												{
													how: 59527,
													pick: 65535,
													value: {
														cls: 61337,
														sp: 30053
													}
												},
												{
													how: 1864,
													pick: 24912,
													value: {
														cls: 64760,
														sp: 65523
													}
												}
											]
										}
									],
									where: [
										{
											left: 57589,
											op: 51,
											pick: 65381,
											value: {
												cls: 65525,
												sp: 49657
											}
										}
									],
									negation: {
										source: 49024,
										picks: [25972, 14985]
									},
									head: {
										vars: [],
										names: [36336, 37763, 5, 57081, 48399, 53681],
										folds: [
											{
												fn: 91,
												arg: 26700,
												padded: 36108,
												scale: 656
											},
											{
												fn: 35247,
												arg: 0,
												padded: 9236,
												scale: 62257
											}
										]
									}
								}
							},
							take: {
								rotate: 26562,
								dirs: [17627, 38627, 20479],
								size: 21711
							}
						}
					}
				],
				order: {
					rotate: 50767,
					dirs: [51308, 1829, 10810],
					size: 65518
				},
				probe: {
					kind: 42918,
					pick: 3529
				},
				key: {
					relation: 44536,
					which: 17912,
					fact: 56002,
					absent: 53940,
					roster: 655
				}
			},
			{
				rule: {
					matches: [
						{
							source: 4088,
							derived: 31392,
							attached: 63328,
							binds: [
								{
									how: 53039,
									pick: 4,
									value: {
										cls: 3211,
										sp: 40347
									}
								},
								{
									how: 58254,
									pick: 28522,
									value: {
										cls: 32102,
										sp: 33222
									}
								},
								{
									how: 44627,
									pick: 49726,
									value: {
										cls: 65535,
										sp: 33506
									}
								},
								{
									how: 38998,
									pick: 51835,
									value: {
										cls: 33178,
										sp: 58706
									}
								},
								{
									how: 14465,
									pick: 127,
									value: {
										cls: 6444,
										sp: 3
									}
								},
								{
									how: 51207,
									pick: 11704,
									value: {
										cls: 59282,
										sp: 60874
									}
								},
								{
									how: 60577,
									pick: 30684,
									value: {
										cls: 5232,
										sp: 36663
									}
								}
							]
						},
						{
							source: 36842,
							derived: 37720,
							attached: 15618,
							binds: [
								{
									how: 63738,
									pick: 21253,
									value: {
										cls: 50095,
										sp: 28824
									}
								},
								{
									how: 37672,
									pick: 9,
									value: {
										cls: 63978,
										sp: 16214
									}
								},
								{
									how: 52408,
									pick: 20951,
									value: {
										cls: 4872,
										sp: 16404
									}
								},
								{
									how: 10132,
									pick: 27268,
									value: {
										cls: 37199,
										sp: 2316
									}
								},
								{
									how: 14329,
									pick: 19940,
									value: {
										cls: 13183,
										sp: 39887
									}
								},
								{
									how: 38292,
									pick: 41024,
									value: {
										cls: 5135,
										sp: 25546
									}
								},
								{
									how: 43232,
									pick: 58660,
									value: {
										cls: 26279,
										sp: 19038
									}
								}
							]
						},
						{
							source: 65535,
							derived: 6144,
							attached: 20941,
							binds: [
								{
									how: 56622,
									pick: 65532,
									value: {
										cls: 14601,
										sp: 15812
									}
								},
								{
									how: 17459,
									pick: 62124,
									value: {
										cls: 10412,
										sp: 44008
									}
								},
								{
									how: 51207,
									pick: 65530,
									value: {
										cls: 28618,
										sp: 29486
									}
								},
								{
									how: 24936,
									pick: 88,
									value: {
										cls: 1,
										sp: 49097
									}
								},
								{
									how: 270,
									pick: 20075,
									value: {
										cls: 12,
										sp: 62835
									}
								},
								{
									how: 62802,
									pick: 28729,
									value: {
										cls: 29589,
										sp: 12775
									}
								},
								{
									how: 7199,
									pick: 49667,
									value: {
										cls: 31,
										sp: 17304
									}
								}
							]
						}
					],
					where: [],
					between: [],
					inSet: [],
					allen: [],
					pointIn: [
						{
							span: 61476,
							point: 24382
						}
					],
					connective: [
						{
							kind: 60791,
							args: [
								{
									left: 61994,
									op: 6490,
									pick: 53060,
									value: {
										cls: 17042,
										sp: 1067
									}
								},
								{
									left: 41884,
									op: 35769,
									pick: 15535,
									value: {
										cls: 5168,
										sp: 30
									}
								}
							]
						}
					],
					computed: [
						{
							kind: 35343,
							reading: 1214,
							arg: 34221,
							op: 52386,
							than: {
								cls: 46758,
								sp: 58941
							},
							otherwise: {
								cls: 48870,
								sp: 41708
							},
							scale: 64992,
							padded: 63842
						},
						{
							kind: 1918,
							reading: 53774,
							arg: 36,
							op: 3516,
							than: {
								cls: 56961,
								sp: 8964
							},
							otherwise: {
								cls: 32193,
								sp: 65504
							},
							scale: 7768,
							padded: 32479
						}
					],
					negation: {
						source: 50190,
						picks: [65462, 54372]
					},
					head: {
						vars: [39369, 18241, 36500],
						names: [15327, 690, 705, 15328, 50124, 7658],
						folds: [
							{
								fn: 49559,
								arg: 21872,
								padded: 49615,
								scale: 59018
							},
							{
								fn: 392,
								arg: 51914,
								padded: 37078,
								scale: 50567
							}
						]
					},
					interior: {
						matches: [
							{
								source: 276,
								derived: 52363,
								attached: 7160,
								binds: [
									{
										how: 44228,
										pick: 50852,
										value: {
											cls: 34328,
											sp: 63785
										}
									},
									{
										how: 60667,
										pick: 48489,
										value: {
											cls: 39054,
											sp: 34647
										}
									},
									{
										how: 53230,
										pick: 63319,
										value: {
											cls: 32598,
											sp: 11926
										}
									},
									{
										how: 46113,
										pick: 7310,
										value: {
											cls: 518,
											sp: 65355
										}
									},
									{
										how: 56168,
										pick: 25036,
										value: {
											cls: 41085,
											sp: 64588
										}
									},
									{
										how: 14121,
										pick: 21970,
										value: {
											cls: 16328,
											sp: 25842
										}
									},
									{
										how: 28637,
										pick: 46450,
										value: {
											cls: 43462,
											sp: 17111
										}
									}
								]
							},
							{
								source: 32200,
								derived: 47440,
								attached: 23376,
								binds: [
									{
										how: 18467,
										pick: 65475,
										value: {
											cls: 7081,
											sp: 34455
										}
									},
									{
										how: 63695,
										pick: 13170,
										value: {
											cls: 34766,
											sp: 20848
										}
									},
									{
										how: 56499,
										pick: 41664,
										value: {
											cls: 65428,
											sp: 30468
										}
									},
									{
										how: 39778,
										pick: 21252,
										value: {
											cls: 1782,
											sp: 33675
										}
									},
									{
										how: 61738,
										pick: 64898,
										value: {
											cls: 7534,
											sp: 61732
										}
									},
									{
										how: 14530,
										pick: 7548,
										value: {
											cls: 44407,
											sp: 27501
										}
									},
									{
										how: 16796,
										pick: 6095,
										value: {
											cls: 51857,
											sp: 40523
										}
									}
								]
							}
						],
						where: [
							{
								left: 38563,
								op: 37303,
								pick: 16415,
								value: {
									cls: 29157,
									sp: 60237
								}
							},
							{
								left: 34714,
								op: 2482,
								pick: 6006,
								value: {
									cls: 26362,
									sp: 56947
								}
							}
						],
						negation: {
							source: 31873,
							picks: [53052, 22729]
						},
						head: {
							vars: [19515, 8420],
							names: [12055, 15894, 1064, 27845, 59, 11873],
							folds: [
								{
									fn: 63594,
									arg: 58766,
									padded: 61598,
									scale: 28978
								},
								{
									fn: 33268,
									arg: 21664,
									padded: 475,
									scale: 47938
								}
							]
						}
					}
				},
				take: {
					rotate: 45306,
					dirs: [56507, 6, 54602],
					size: 52463,
					ties: 56496
				},
				literalHead: {
					name: 55299,
					kind: 30952,
					arms: 18477,
					values: [40451, 50733, 30015]
				},
				importable: 56111,
				bindImport: 38033,
				named: 61913,
				relationParam: {
					relation: 11809,
					facts: [
						{
							values: [
								{
									cls: 65535,
									sp: 20500
								},
								{
									cls: 23308,
									sp: 110
								},
								{
									cls: 46044,
									sp: 65532
								},
								{
									cls: 16821,
									sp: 16530
								},
								{
									cls: 10788,
									sp: 30597
								},
								{
									cls: 22399,
									sp: 18744
								},
								{
									cls: 50431,
									sp: 54127
								}
							]
						},
						{
							values: [
								{
									cls: 62165,
									sp: 65471
								},
								{
									cls: 25263,
									sp: 55541
								},
								{
									cls: 46117,
									sp: 21987
								},
								{
									cls: 19534,
									sp: 58535
								},
								{
									cls: 26793,
									sp: 20912
								},
								{
									cls: 5917,
									sp: 23939
								},
								{
									cls: 46560,
									sp: 53981
								}
							]
						}
					]
				},
				closure: {
					relation: 31446,
					pair: 65102,
					name: 2033
				},
				attachments: [
					{
						name: 8617,
						link: 47272,
						handle: 22,
						delivery: 55445,
						rule: {
							matches: [
								{
									source: 18869,
									derived: 2579,
									attached: 8530,
									binds: [
										{
											how: 974,
											pick: 18294,
											value: {
												cls: 55477,
												sp: 18474
											}
										},
										{
											how: 50772,
											pick: 19738,
											value: {
												cls: 16190,
												sp: 48838
											}
										},
										{
											how: 59893,
											pick: 24755,
											value: {
												cls: 36857,
												sp: 20
											}
										},
										{
											how: 22232,
											pick: 39583,
											value: {
												cls: 35175,
												sp: 19680
											}
										},
										{
											how: 3624,
											pick: 40977,
											value: {
												cls: 58870,
												sp: 18805
											}
										},
										{
											how: 33364,
											pick: 35603,
											value: {
												cls: 46389,
												sp: 51334
											}
										},
										{
											how: 23762,
											pick: 46704,
											value: {
												cls: 62991,
												sp: 4295
											}
										}
									]
								},
								{
									source: 52928,
									derived: 63437,
									attached: 6561,
									binds: [
										{
											how: 7680,
											pick: 57056,
											value: {
												cls: 36108,
												sp: 43263
											}
										},
										{
											how: 65535,
											pick: 59365,
											value: {
												cls: 65531,
												sp: 62795
											}
										},
										{
											how: 6519,
											pick: 38804,
											value: {
												cls: 48610,
												sp: 5
											}
										},
										{
											how: 61507,
											pick: 47186,
											value: {
												cls: 57651,
												sp: 57664
											}
										},
										{
											how: 10963,
											pick: 36934,
											value: {
												cls: 43992,
												sp: 2125
											}
										},
										{
											how: 26615,
											pick: 63273,
											value: {
												cls: 14670,
												sp: 28963
											}
										},
										{
											how: 3236,
											pick: 885,
											value: {
												cls: 57544,
												sp: 53918
											}
										}
									]
								}
							],
							where: [
								{
									left: 34302,
									op: 49728,
									pick: 3485,
									value: {
										cls: 21235,
										sp: 19867
									}
								},
								{
									left: 18133,
									op: 55115,
									pick: 3971,
									value: {
										cls: 45045,
										sp: 18130
									}
								}
							],
							between: [],
							inSet: [
								{
									left: 49206,
									values: [
										{
											cls: 39936,
											sp: 24794
										},
										{
											cls: 26511,
											sp: 48549
										}
									]
								}
							],
							allen: [
								{
									left: 58701,
									mask: 33537,
									right: 65416
								}
							],
							pointIn: [],
							connective: [],
							computed: [
								{
									kind: 45495,
									reading: 34162,
									arg: 43783,
									op: 63445,
									than: {
										cls: 65533,
										sp: 16478
									},
									otherwise: {
										cls: 54750,
										sp: 3360
									},
									scale: 4453,
									padded: 33064
								},
								{
									kind: 25754,
									reading: 45184,
									arg: 11776,
									op: 17232,
									than: {
										cls: 441,
										sp: 65535
									},
									otherwise: {
										cls: 13725,
										sp: 0
									},
									scale: 24620,
									padded: 61946
								}
							],
							negation: {
								source: 50402,
								picks: [65507, 3044]
							},
							head: {
								vars: [8157],
								names: [35433, 40377, 7543, 2082, 918, 64227],
								folds: [
									{
										fn: 33452,
										arg: 8646,
										padded: 28957,
										scale: 39910
									}
								]
							},
							interior: {
								matches: [
									{
										source: 11439,
										derived: 16534,
										attached: 62243,
										binds: [
											{
												how: 10296,
												pick: 58343,
												value: {
													cls: 2949,
													sp: 43441
												}
											},
											{
												how: 31984,
												pick: 57235,
												value: {
													cls: 57456,
													sp: 53796
												}
											},
											{
												how: 12901,
												pick: 1585,
												value: {
													cls: 19321,
													sp: 29275
												}
											},
											{
												how: 2010,
												pick: 4763,
												value: {
													cls: 11092,
													sp: 55080
												}
											},
											{
												how: 65486,
												pick: 63914,
												value: {
													cls: 37420,
													sp: 4810
												}
											},
											{
												how: 65075,
												pick: 65534,
												value: {
													cls: 19319,
													sp: 32315
												}
											},
											{
												how: 17110,
												pick: 8331,
												value: {
													cls: 16295,
													sp: 56434
												}
											}
										]
									}
								],
								where: [],
								negation: {
									source: 52734,
									picks: [4578, 33447]
								},
								head: {
									vars: [64858, 56],
									names: [54797, 41423, 14502, 1813, 38285, 1],
									folds: [
										{
											fn: 2991,
											arg: 33359,
											padded: 3146,
											scale: 12072
										},
										{
											fn: 18646,
											arg: 58016,
											padded: 17595,
											scale: 32719
										}
									]
								}
							}
						},
						take: {
							rotate: 27405,
							dirs: [13702, 44058, 1136],
							size: 65530
						},
						nested: {
							name: 3626,
							link: 34442,
							handle: 9075,
							delivery: 8054,
							rule: {
								matches: [
									{
										source: 27265,
										derived: 39557,
										attached: 18738,
										binds: [
											{
												how: 64725,
												pick: 42644,
												value: {
													cls: 49345,
													sp: 1409
												}
											},
											{
												how: 34984,
												pick: 29336,
												value: {
													cls: 65521,
													sp: 19509
												}
											},
											{
												how: 61377,
												pick: 862,
												value: {
													cls: 64712,
													sp: 5909
												}
											},
											{
												how: 16943,
												pick: 18811,
												value: {
													cls: 42424,
													sp: 2819
												}
											},
											{
												how: 5249,
												pick: 41182,
												value: {
													cls: 25252,
													sp: 7263
												}
											},
											{
												how: 65142,
												pick: 53298,
												value: {
													cls: 60108,
													sp: 34657
												}
											},
											{
												how: 59210,
												pick: 3152,
												value: {
													cls: 22880,
													sp: 11905
												}
											}
										]
									}
								],
								where: [
									{
										left: 39318,
										op: 46927,
										pick: 31,
										value: {
											cls: 45949,
											sp: 26312
										}
									}
								],
								between: [
									{
										left: 22668,
										low: {
											pick: 920,
											value: {
												cls: 16809,
												sp: 35675
											}
										},
										high: {
											pick: 23364,
											value: {
												cls: 11796,
												sp: 36448
											}
										}
									}
								],
								inSet: [
									{
										left: 46514,
										values: [
											{
												cls: 6,
												sp: 6118
											},
											{
												cls: 62523,
												sp: 18
											}
										]
									}
								],
								allen: [],
								pointIn: [],
								connective: [],
								computed: [
									{
										kind: 0,
										reading: 65209,
										arg: 48547,
										op: 48393,
										than: {
											cls: 45380,
											sp: 34851
										},
										otherwise: {
											cls: 8190,
											sp: 65534
										},
										scale: 65532,
										padded: 6399
									}
								],
								negation: {
									source: 27137,
									picks: [115, 9645]
								},
								head: {
									vars: [31009, 13360, 8031],
									names: [42236, 42296, 3825, 2990, 16742, 31907],
									folds: [
										{
											fn: 8066,
											arg: 36146,
											padded: 0,
											scale: 58206
										},
										{
											fn: 65535,
											arg: 4302,
											padded: 22022,
											scale: 1064
										}
									]
								},
								interior: {
									matches: [
										{
											source: 26533,
											derived: 54900,
											attached: 31311,
											binds: [
												{
													how: 12969,
													pick: 57618,
													value: {
														cls: 65440,
														sp: 62112
													}
												},
												{
													how: 17316,
													pick: 47878,
													value: {
														cls: 31356,
														sp: 18112
													}
												},
												{
													how: 9027,
													pick: 19394,
													value: {
														cls: 32864,
														sp: 58052
													}
												},
												{
													how: 65532,
													pick: 49199,
													value: {
														cls: 43955,
														sp: 1996
													}
												},
												{
													how: 65518,
													pick: 26607,
													value: {
														cls: 31094,
														sp: 34149
													}
												},
												{
													how: 65533,
													pick: 65534,
													value: {
														cls: 47671,
														sp: 63511
													}
												},
												{
													how: 48485,
													pick: 65535,
													value: {
														cls: 43444,
														sp: 20635
													}
												}
											]
										}
									],
									where: [
										{
											left: 6207,
											op: 7416,
											pick: 8388,
											value: {
												cls: 65235,
												sp: 59666
											}
										},
										{
											left: 18961,
											op: 2952,
											pick: 6429,
											value: {
												cls: 6075,
												sp: 49598
											}
										}
									],
									negation: {
										source: 34788,
										picks: [2929, 64410]
									},
									head: {
										vars: [],
										names: [60784, 568, 28840, 2693, 14232, 51265],
										folds: [
											{
												fn: 19217,
												arg: 36495,
												padded: 64436,
												scale: 5021
											}
										]
									}
								}
							},
							take: {
								rotate: 26865,
								dirs: [46162, 45738, 52134],
								size: 27490
							}
						}
					},
					{
						name: 19420,
						link: 35736,
						handle: 65534,
						delivery: 19278,
						rule: {
							matches: [
								{
									source: 26800,
									derived: 12195,
									attached: 42709,
									binds: [
										{
											how: 5140,
											pick: 52657,
											value: {
												cls: 47871,
												sp: 22160
											}
										},
										{
											how: 10566,
											pick: 32465,
											value: {
												cls: 15672,
												sp: 52570
											}
										},
										{
											how: 10,
											pick: 52842,
											value: {
												cls: 12214,
												sp: 62856
											}
										},
										{
											how: 54445,
											pick: 28416,
											value: {
												cls: 48472,
												sp: 2014
											}
										},
										{
											how: 65387,
											pick: 52558,
											value: {
												cls: 24206,
												sp: 24759
											}
										},
										{
											how: 42298,
											pick: 62228,
											value: {
												cls: 25455,
												sp: 11500
											}
										},
										{
											how: 33804,
											pick: 34,
											value: {
												cls: 43636,
												sp: 32647
											}
										}
									]
								}
							],
							where: [
								{
									left: 51353,
									op: 35901,
									pick: 65535,
									value: {
										cls: 49977,
										sp: 58333
									}
								}
							],
							between: [
								{
									left: 22744,
									low: {
										pick: 10691,
										value: {
											cls: 34192,
											sp: 24286
										}
									},
									high: {
										pick: 20875,
										value: {
											cls: 38284,
											sp: 59997
										}
									}
								}
							],
							inSet: [],
							allen: [],
							pointIn: [
								{
									span: 47781,
									point: 40732
								}
							],
							connective: [],
							computed: [
								{
									kind: 64021,
									reading: 64689,
									arg: 49551,
									op: 51516,
									than: {
										cls: 50156,
										sp: 8910
									},
									otherwise: {
										cls: 65526,
										sp: 59590
									},
									scale: 7,
									padded: 64883
								}
							],
							negation: {
								source: 20725,
								picks: [7201, 31241]
							},
							head: {
								vars: [45027, 144, 20232],
								names: [10687, 43978, 60782, 63903, 65532, 3792],
								folds: [
									{
										fn: 11538,
										arg: 54917,
										padded: 30580,
										scale: 12442
									}
								]
							},
							interior: {
								matches: [
									{
										source: 52008,
										derived: 41784,
										attached: 65354,
										binds: [
											{
												how: 17631,
												pick: 31502,
												value: {
													cls: 40371,
													sp: 25328
												}
											},
											{
												how: 49342,
												pick: 56619,
												value: {
													cls: 63632,
													sp: 45983
												}
											},
											{
												how: 42032,
												pick: 44657,
												value: {
													cls: 25869,
													sp: 39431
												}
											},
											{
												how: 50117,
												pick: 24984,
												value: {
													cls: 35318,
													sp: 26675
												}
											},
											{
												how: 48049,
												pick: 58019,
												value: {
													cls: 65535,
													sp: 61143
												}
											},
											{
												how: 23233,
												pick: 17139,
												value: {
													cls: 65535,
													sp: 61816
												}
											},
											{
												how: 7655,
												pick: 28154,
												value: {
													cls: 7576,
													sp: 2803
												}
											}
										]
									}
								],
								where: [],
								negation: {
									source: 37903,
									picks: [56952, 513]
								},
								head: {
									vars: [64244, 505],
									names: [18998, 19551, 54581, 29045, 108, 35318],
									folds: [
										{
											fn: 5373,
											arg: 64772,
											padded: 1735,
											scale: 60502
										}
									]
								}
							}
						},
						take: {
							rotate: 2,
							dirs: [3742, 3251, 23058],
							size: 16253
						},
						nested: {
							name: 65514,
							link: 57873,
							handle: 25397,
							delivery: 55726,
							rule: {
								matches: [
									{
										source: 5232,
										derived: 39584,
										attached: 17369,
										binds: [
											{
												how: 9158,
												pick: 7073,
												value: {
													cls: 61310,
													sp: 35422
												}
											},
											{
												how: 56055,
												pick: 6813,
												value: {
													cls: 20219,
													sp: 56143
												}
											},
											{
												how: 53366,
												pick: 50140,
												value: {
													cls: 30719,
													sp: 30095
												}
											},
											{
												how: 2450,
												pick: 60468,
												value: {
													cls: 37250,
													sp: 13318
												}
											},
											{
												how: 44589,
												pick: 65535,
												value: {
													cls: 65535,
													sp: 51136
												}
											},
											{
												how: 33526,
												pick: 50797,
												value: {
													cls: 59191,
													sp: 43157
												}
											},
											{
												how: 63167,
												pick: 37917,
												value: {
													cls: 10581,
													sp: 17360
												}
											}
										]
									},
									{
										source: 22918,
										derived: 39006,
										attached: 45384,
										binds: [
											{
												how: 28336,
												pick: 18187,
												value: {
													cls: 53038,
													sp: 336
												}
											},
											{
												how: 175,
												pick: 65533,
												value: {
													cls: 37746,
													sp: 51435
												}
											},
											{
												how: 7173,
												pick: 41016,
												value: {
													cls: 48619,
													sp: 35287
												}
											},
											{
												how: 48013,
												pick: 16930,
												value: {
													cls: 48188,
													sp: 47925
												}
											},
											{
												how: 34161,
												pick: 51783,
												value: {
													cls: 54606,
													sp: 34096
												}
											},
											{
												how: 37382,
												pick: 17483,
												value: {
													cls: 25982,
													sp: 56853
												}
											},
											{
												how: 34112,
												pick: 24063,
												value: {
													cls: 38621,
													sp: 8480
												}
											}
										]
									}
								],
								where: [
									{
										left: 16542,
										op: 2595,
										pick: 31611,
										value: {
											cls: 43077,
											sp: 34153
										}
									},
									{
										left: 10090,
										op: 46720,
										pick: 65451,
										value: {
											cls: 47549,
											sp: 39560
										}
									}
								],
								between: [
									{
										left: 14633,
										low: {
											pick: 9550,
											value: {
												cls: 65441,
												sp: 48046
											}
										},
										high: {
											pick: 20656,
											value: {
												cls: 14167,
												sp: 9128
											}
										}
									}
								],
								inSet: [],
								allen: [],
								pointIn: [],
								connective: [],
								computed: [
									{
										kind: 23846,
										reading: 11770,
										arg: 50002,
										op: 50532,
										than: {
											cls: 59283,
											sp: 345
										},
										otherwise: {
											cls: 63684,
											sp: 36322
										},
										scale: 47206,
										padded: 37133
									}
								],
								negation: {
									source: 40326,
									picks: [31674, 3632]
								},
								head: {
									vars: [53220, 165, 20692],
									names: [15728, 13344, 38936, 6730, 62979, 55001],
									folds: [
										{
											fn: 19682,
											arg: 26598,
											padded: 47286,
											scale: 64431
										}
									]
								},
								interior: {
									matches: [
										{
											source: 36057,
											derived: 65513,
											attached: 18002,
											binds: [
												{
													how: 42034,
													pick: 20890,
													value: {
														cls: 52064,
														sp: 51
													}
												},
												{
													how: 48574,
													pick: 13023,
													value: {
														cls: 46076,
														sp: 41303
													}
												},
												{
													how: 18302,
													pick: 50857,
													value: {
														cls: 20959,
														sp: 36615
													}
												},
												{
													how: 16430,
													pick: 47095,
													value: {
														cls: 60126,
														sp: 7224
													}
												},
												{
													how: 11565,
													pick: 48447,
													value: {
														cls: 13049,
														sp: 61554
													}
												},
												{
													how: 677,
													pick: 65429,
													value: {
														cls: 54689,
														sp: 12853
													}
												},
												{
													how: 9600,
													pick: 62394,
													value: {
														cls: 20097,
														sp: 55508
													}
												}
											]
										}
									],
									where: [],
									negation: {
										source: 10589,
										picks: [44060, 37948]
									},
									head: {
										vars: [90, 1162],
										names: [53332, 247, 51794, 37967, 51189, 46148],
										folds: [
											{
												fn: 42556,
												arg: 58430,
												padded: 50002,
												scale: 5880
											}
										]
									}
								}
							},
							take: {
								rotate: 60889,
								dirs: [44459, 13327, 50387],
								size: 31482
							}
						}
					}
				],
				order: {
					rotate: 64847,
					dirs: [35754, 26190, 47552],
					size: 41150
				},
				probe: {
					kind: 64600,
					pick: 17018
				},
				key: {
					relation: 36635,
					which: 15420,
					fact: 48073,
					absent: 12246,
					roster: 61371
				}
			}
		],
		planted: {
			names: [
				65018, 16808, 495, 55525, 32884, 4181, 15643, 62904, 35148, 16409, 47877, 36012, 65524,
				51301, 13824, 24712, 1, 42267, 41959, 107, 9409, 56911, 53130, 385, 55, 16751, 54119, 46486,
				34759, 43806, 59, 40779, 23786, 21535, 5937, 25663, 40, 5813, 60381, 11667, 52305, 43883,
				7606, 12076, 3395, 8539, 61788, 13316, 39278, 22954, 41502
			],
			value: {
				cls: 16962,
				sp: 23128
			},
			handle: 50488,
			padding: 58543,
			side: {
				kind: 62186,
				values: [46740, 45607, 61903]
			}
		}
	})
]

/** A field a constructed read binds a parameter at, and the values its type holds. */
type Valued = readonly [ProgramField, Arr.NonEmptyReadonlyArray<TypedLiteral>]

/**
 * The field kinds a constructed selection binds a parameter at: every drawn kind but a span's, whose equality is a
 * GiST predicate of its own, and a vector's, which no statistics object covers.
 */
const selectableKinds: ReadonlySet<FieldKind> = new Set(
	Arr.filter(fieldKinds, (kind) => kind !== "vector" && kind !== "span4" && kind !== "span8")
)

/** A relation and two of its fields no key of it is within, each of selectableKinds. */
interface Correlated {
	readonly stored: Stored
	readonly pair: readonly [Valued, Valued]
}

/**
 * The case's schema read by one read constructed to reach a workload's statistics (program.ts boundRead): a relation's
 * facts whose two fields, drawn among the pairs of selectableKinds no key of the relation is within, are each a
 * parameter, every other field in the head. That is a correlated selection, over which the plan requests extended
 * statistics (physical/access/extract.ts); each parameter's value is drawn among its type's value classes. None where
 * no relation has such a pair. The streams the suite's label fixes held no drawn read the plan requested statistics
 * for.
 */
const statisticsCaseGen =
	(c: ProgramCase): Gen<Option.Option<ProgramCase>> =>
	(source) => {
		const [first, ...rest] = Arr.flatMap(
			c.schema.relations,
			(stored): ReadonlyArray<Correlated> => {
				const keys = [stored.primaryKey, ...stored.candidates]
				const valued = Arr.flatMap(stored.fields, (field): ReadonlyArray<Valued> => {
					const [value, ...values] = valueClasses(field.type, false)
					return selectableKinds.has(field.kind) && value !== undefined
						? [[field, [value, ...values]]]
						: []
				})
				return Arr.flatMap(valued, (a, at) =>
					Arr.flatMap(Arr.drop(valued, at + 1), (b): ReadonlyArray<Correlated> =>
						Arr.some(keys, (key) =>
							Arr.every(key, (f) => f.name === a[0].name || f.name === b[0].name)
						)
							? []
							: [{ stored, pair: [a, b] }]
					)
				)
			}
		)
		if (first === undefined) {
			return Option.none()
		}
		const { stored, pair } = source.draw(element([first, ...rest]))
		return Option.some({
			...c,
			reads: [
				boundRead(
					stored,
					new Map(
						Arr.map(pair, ([field, values]) => [field.name, source.draw(element(values))] as const)
					)
				)
			]
		})
	}

/**
 * The workload a witness whose turn aims at a workload's statistics draws (aimed): a drawn program, installed with a
 * read constructed to reach them in place of its drawn reads.
 */
const workloadAims: ReadonlyArray<readonly [WorkloadFeature, Gen<WorkloadSketch>]> = [
	[
		"every table's declared statistics installed as declared",
		map(caseSketchGen, (program): WorkloadSketch => ({ program, reads: "a correlated selection" }))
	]
]

/**
 * The case a workload sketch installs, resolved on the case's own tape: its program with its drawn reads, or with
 * statisticsCaseGen's read in their place, its drawn reads where no relation has the pair that read needs.
 */
export const workloadGen =
	(sketch: WorkloadSketch): Gen<ProgramCase> =>
	(source) => {
		const c = source.draw(resolveCase(sketch.program))
		switch (sketch.reads) {
			case "drawn":
				return c
			case "a correlated selection":
				return Option.getOrElse(source.draw(statisticsCaseGen(c)), () => c)
		}
	}

/**
 * The workloads a case draws: a program with its drawn reads, the regressions recorded beside them (workloadRegressions),
 * and, for a witness whose turn aims at a workload's statistics, one constructed to reach them (workloadAims).
 */
export const workloadSpace = aimed(
	recorded(map(caseSketchGen, drawnReads), workloadRegressions),
	workloadAims
)
