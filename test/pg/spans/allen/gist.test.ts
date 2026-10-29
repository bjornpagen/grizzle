import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, pipe, String as Str } from "effect"
import { planIndexNames, planNodeTypes } from "#bench/harness/explain.ts"
import { allenFormula } from "#compiler/allen/lower.ts"
import { allenRelations, fullAllenMask, parseAllenMask } from "#compiler/allen/mask.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { pg, span, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { compileSpanDesc, installSpans } from "#test/pg/spans/allen/support.ts"
import { contains, defined, lacks, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, paramTexts, testCompile } from "#test/support/compile.ts"
import { decodedQuery, type AuthoredExprDesc as ExprDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"

const Booking = relation("Booking", { room: uuid, during: span(pg.bigint), guest: uuid }, [
	"room",
	"during"
])

const Visit = relation(
	"Visit",
	{ id: pg.integer, room: uuid, during: span(pg.bigint), note: pg.integer },
	["id"]
)
const Rooms = schema("Rooms", { Booking, Visit }, [])

/** The workload program whose span predicate requests Visit's GiST (room, during): one room's visits meeting a window. */
const visitsInWindow = query(Rooms).rule((r) => {
	const { id, during } = v(Visit)
	return r
		.match(Visit, { id, room: r.param("room", Visit.fields.room), during })
		.where(r.allen(during, ALLEN.intersects, r.param("w", Visit.fields.during)))
		.find({ id })
})

const relationNames = ["Booking", "Visit"] as const
type RelationName = (typeof relationNames)[number]
/** A field of each relation that no index holds, so no index scan of a whole index can produce the head. */
const outsideField: Readonly<Record<RelationName, string>> = { Booking: "guest", Visit: "note" }

/**
 * Booking holds `perRoom` spans [10k, 10k + 5) per room, so its spans lie in [0, 10·perRoom); Visit holds
 * rooms·perRoom spans [i, i + 1 + i mod 7), across the rooms in turn, so its spans lie in [0, rooms·perRoom + 7).
 */
const sizes = [
	{ name: "100 rows", rooms: 4, perRoom: 25 },
	{ name: "4000 rows", rooms: 20, perRoom: 200 }
] as const
type Size = (typeof sizes)[number]
const spanTop = (size: Size, relationName: RelationName): number =>
	relationName === "Booking" ? size.perRoom * 10 : size.rooms * size.perRoom

const roomId = (r: number): string =>
	`00000000-0000-4000-8000-${pipe(r.toString(16), Str.padStart(12, "0"))}`

/**
 * A rule over `relationName` with its span bound to `s`, filtered by `where`, and, by room, its room bound to the
 * parameter `room`; its head is the span and the field the GiST does not hold.
 */
const roomRule = (relationName: RelationName, where: ExprDesc, prefix: Prefix): QueryDesc => {
	const outside = outsideField[relationName]
	return decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [
					{ id: "s", origin: { relation: relationName, field: "during" } },
					{ id: "o", origin: { relation: relationName, field: outside } }
				],
				matches: [
					{
						source: { kind: "relation", name: relationName },
						bindings:
							prefix === "by room"
								? {
										room: { kind: "param", name: "room" },
										during: { kind: "var", var: "s" },
										[outside]: { kind: "var", var: "o" }
									}
								: { during: { kind: "var", var: "s" }, [outside]: { kind: "var", var: "o" } }
					}
				],
				where: [where],
				head: { s: { kind: "var", var: "s" }, o: { kind: "var", var: "o" } },
				interiors: [],
				attach: []
			}
		]
	})
}

const allenWhere = (mask: number): ExprDesc => ({
	kind: "allen",
	left: { kind: "var", var: "s" },
	mask,
	right: { kind: "param", name: "w" }
})

const pointWhere: ExprDesc = {
	kind: "pointIn",
	point: { kind: "param", name: "t" },
	span: { kind: "var", var: "s" }
}

/** r.pointIn(Compute.lower(s), w) or r.pointIn(Compute.upper(s), w). */
const endpointWhere = (upper: boolean): ExprDesc => ({
	kind: "pointIn",
	point: { kind: "compute", fn: upper ? "upper" : "lower", args: [{ kind: "var", var: "s" }] },
	span: { kind: "param", name: "w" }
})

/** The masks planted beside any other: each basic relation and each named mask. */
const plantedMasks: Arr.NonEmptyReadonlyArray<number> = Arr.appendAll(
	Arr.map(allenRelations, (r) => ALLEN[r]),
	[ALLEN.intersects, ALLEN.covers, ALLEN.within, ALLEN.precedes]
)

/**
 * One drawn plan: a data size, a predicate (a mask other than the full one, pointIn, or the span's lower or upper
 * endpoint in the window), and the room, window and point picks its parameters take. A case reads each relation under
 * the predicate, with the room prefix bound and without, so every case reaches every relation and prefix.
 */
interface PlanSketch {
	readonly size: Size
	readonly predicate:
		| { readonly kind: "allen"; readonly mask: number }
		| { readonly kind: "pointIn" }
		| { readonly kind: "endpointIn"; readonly upper: boolean }
	readonly room: number
	readonly start: number
	readonly length: number
}

const predicateGen: Gen<PlanSketch["predicate"]> = oneOf<PlanSketch["predicate"]>([
	map(oneOf([element(plantedMasks), int(1, fullAllenMask - 1)]), (mask) => ({
		kind: "allen",
		mask
	})),
	constant({ kind: "pointIn" }),
	map(boolean, (upper) => ({ kind: "endpointIn", upper }))
])

const planSketchGen: Gen<PlanSketch> = (source) => ({
	size: source.draw(element<Size>(sizes)),
	predicate: source.draw(predicateGen),
	room: source.draw(int(0, 2 ** 31 - 1)),
	start: source.draw(int(0, 2 ** 31 - 1)),
	length: source.draw(int(1, 40))
})

/** What a plan's predicate is: a formula of one disjunct, a union of several, pointIn, or an endpoint in the window. */
type PredicateKind = "one disjunct" | "a union" | "pointIn" | "an endpoint in the window"
/** Whether a read binds the room prefix of the GiST's key. */
type Prefix = "by room" | "unprefixed"
const prefixes = ["by room", "unprefixed"] as const satisfies ReadonlyArray<Prefix>
type PlanFeature = `${RelationName} ${PredicateKind} ${Prefix}` | `size ${Size["name"]}`

const predicateKinds: ReadonlyArray<PredicateKind> = [
	"one disjunct",
	"a union",
	"pointIn",
	"an endpoint in the window"
]

const predicateKind = (predicate: PlanSketch["predicate"]): PredicateKind => {
	if (predicate.kind === "pointIn") {
		return "pointIn"
	}
	if (predicate.kind === "endpointIn") {
		return "an endpoint in the window"
	}
	const mask = defined(parseAllenMask(predicate.mask), `the mask ${predicate.mask}`)
	return allenFormula(mask).length === 1 ? "one disjunct" : "a union"
}

/**
 * Planted: each kind of predicate on the smaller data, which every relation reads with and without the room prefix. The
 * masks are the first planted one of one disjunct and the least mask of a union.
 */
const maskOf = (kind: PredicateKind): number =>
	Option.getOrThrowWith(
		Arr.findFirst(
			[...plantedMasks, ...Arr.makeBy(fullAllenMask - 1, (i) => i + 1)],
			(mask) => predicateKind({ kind: "allen", mask }) === kind
		),
		() => new Error(`no mask of ${kind}`)
	)

const planKept: ReadonlyArray<Kept<PlanSketch, PlanFeature>> = Arr.map(
	predicateKinds,
	(kind): Kept<PlanSketch, PlanFeature> => ({
		note: `every relation under ${kind}, by room and unprefixed`,
		sketch: {
			size: sizes[0],
			predicate:
				kind === "pointIn"
					? { kind: "pointIn" }
					: kind === "an endpoint in the window"
						? { kind: "endpointIn", upper: false }
						: { kind: "allen", mask: maskOf(kind) },
			room: 1,
			start: 7,
			length: 9
		},
		draws: "",
		reaches: Arr.flatMap(relationNames, (relation) =>
			Arr.map(prefixes, (prefix): PlanFeature => `${relation} ${kind} ${prefix}`)
		)
	})
)

const requiredFeatures: ReadonlyArray<PlanFeature> = [
	...Arr.flatMap(relationNames, (r) =>
		Arr.flatMap(predicateKinds, (k) => Arr.map(prefixes, (p): PlanFeature => `${r} ${k} ${p}`))
	),
	...Arr.map(sizes, (s): PlanFeature => `size ${s.name}`)
]

layer(Substrate.layer)("GiST span indexes", (it) => {
	/** One installation per data size, filled and analyzed, with its reader. */
	const install = (size: Size) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const plan = succeeded(
				compileTestWorkload(
					[{ login: "server", workloads: [workload(Rooms, { visitsInWindow })] }],
					Rooms,
					testCompile
				),
				"the workload compiles"
			)
			const installed = yield* installSpans(Rooms, {
				label: "gist",
				extensions: [workloadExtension(plan)]
			})
			const schemaName = quoteIdent(installed.schema)
			yield* s.admin.queryValues(
				`INSERT INTO ${schemaName}."booking" ("room", "during", "guest")
SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(r), 12, '0'))::uuid, int8range(k * 10, k * 10 + 5), md5(r::text || ':' || k::text)::uuid
FROM generate_series(0, ${size.rooms - 1}) AS r, generate_series(0, ${size.perRoom - 1}) AS k`,
				[]
			)
			yield* s.admin.queryValues(
				`INSERT INTO ${schemaName}."visit" ("id", "room", "during", "note")
SELECT i, ('00000000-0000-4000-8000-' || lpad(to_hex(i % ${size.rooms}), 12, '0'))::uuid, int8range(i, i + 1 + i % 7), i % 13
FROM generate_series(0, ${size.rooms * size.perRoom - 1}) AS i`,
				[]
			)
			yield* s.admin.queryValues(`VACUUM ANALYZE ${schemaName}."booking"`, [])
			yield* s.admin.queryValues(`VACUUM ANALYZE ${schemaName}."visit"`, [])
			const reader = yield* s.session({ ...worldSession(installed.world), label: "reader" })
			/**
			 * Each relation's GiST: Booking's span key, a primary WITHOUT OVERLAPS over its span, and the access index the
			 * engine created over Visit's (room, during).
			 */
			const names = installationNamesOf(installed.installation)
			const gist: Readonly<Record<RelationName, string>> = {
				Booking: names.fieldConstraint(Booking, "pk", ["room", "during"]),
				Visit: names.accessIndex(Visit, ["room", "during"])
			}
			return { installed, reader, gist }
		})

	it.effect(
		"reads the span relation through its GiST index for every mask and pointIn the search draws",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					/** Every size's installation, made before the first case. */
					const installs = new Map(
						yield* Effect.forEach(sizes, (size) =>
							Effect.map(install(size), (opened) => [size.name, opened] as const)
						)
					)
					return yield* explore(
						{
							suite: "spans/allen-gist",
							draw: drawn(planSketchGen),
							literal: Formatter.format,
							features: features<PlanFeature>(requiredFeatures),
							kept: planKept,
							runs: 80,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							steering: { kind: "none" },
							caseHang: Duration.minutes(2)
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const { installed, reader, gist } = defined(
									installs.get(sketch.size.name),
									`the installation of ${sketch.size.name}`
								)
								c.note(`size ${sketch.size.name}`)
								const kind = predicateKind(sketch.predicate)
								const where =
									sketch.predicate.kind === "pointIn"
										? pointWhere
										: sketch.predicate.kind === "endpointIn"
											? endpointWhere(sketch.predicate.upper)
											: allenWhere(sketch.predicate.mask)
								/**
								 * The conservative artifact keeps an endpoint in the window as written, which no index drives.
								 */
								const judged =
									sketch.predicate.kind === "endpointIn"
										? (["optimized"] as const)
										: (["optimized", "conservative"] as const)
								yield* reader.begin
								yield* reader.query("SET LOCAL enable_seqscan = off", [])
								yield* reader.query("SET LOCAL enable_indexscan = off", [])
								yield* reader.query("SET LOCAL enable_indexonlyscan = off", [])
								for (const relation of relationNames) {
									const top = spanTop(sketch.size, relation)
									const start = BigInt(sketch.start % top)
									const w = { start, end: start + BigInt(sketch.length) }
									for (const prefix of prefixes) {
										const read: PlanFeature = `${relation} ${kind} ${prefix}`
										c.note(read)
										const params =
											prefix === "by room"
												? { room: roomId(sketch.room % sketch.size.rooms), w, t: start }
												: { w, t: start }
										const template = compileSpanDesc(
											roomRule(relation, where, prefix),
											Rooms,
											installed.schema
										)
										for (const artifact of judged) {
											const spec = defined(template[artifact][0], `the ${artifact} statement`)
											const rows = yield* reader.values(
												`EXPLAIN (FORMAT JSON) ${spec.sql}`,
												paramTexts(spec, params)
											)
											const explained = defined(rows[0]?.[0], "the EXPLAIN cell")
											const nodeTypes = planNodeTypes(explained)
											contains(
												planIndexNames(explained),
												gist[relation],
												`the ${artifact} plan of ${read} reads ${relation}'s GiST: ${Arr.join(nodeTypes, " > ")}`
											)
											lacks(
												nodeTypes,
												"Seq Scan",
												`the ${artifact} plan of ${read} scans no relation sequentially: ${Arr.join(nodeTypes, " > ")}`
											)
										}
									}
								}
								yield* reader.rollback
							})
					)
				})
			),
		600_000
	)
})
