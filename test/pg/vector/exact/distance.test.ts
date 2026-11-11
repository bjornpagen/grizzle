/**
 * Exact cosine distance on PostgreSQL 19 and the pinned pgvector.
 *
 * - Exact: over a drawn population installed with an HNSW index present, for every account and a probe that is a
 *   stored embedding, a drawn vector or one at a norm bound, the scored statements of both artifacts deliver exactly
 *   the eligible facts at their native distances, each once, the ordered ones in distance-then-key order, ties by the
 *   key; with sequential scans disabled, no exact statement plans the HNSW index (while an ORDER BY ... LIMIT over the
 *   view does, the premise); and approximateNearest's conservative form is the exact top five.
 * - Cosine domain: across the admitted cosine domain, at few dimensions, the HNSW limit and the storage limit, every
 *   pair's distance is finite and in [0, 2], exactly 0, 2 and 1 for identical, opposite and orthogonal pairs, whose
 *   float32 sums pgvector accumulates alike; and vector_norm agrees with the host's norm within its derived bound
 *   (test/pg/vector/support.ts normTolerance).
 * - Norm CHECK: the column's CHECK admits exactly the native cosine domain, and the host's norm and codec agree with it
 *   away from the bounds.
 * - Norm: the host's norm agrees with vector_norm on generated binary32 vectors within its derived bound.
 *
 * Oracle: PostgreSQL itself: the eligible facts' native cosine_distance from a scan no index orders, the eligibility
 * applied on the host; the specification of cosine distance's range and its exact values; vector_norm and the CHECK.
 *
 * Plants: vector-cosine-as-l2 (Compute.cosineDistance lowers to l2_distance), vector-norm-float32 (the host's norm
 * sums in binary32), vector-cosine-domain-exclusive (the host's cosine domain excludes its bounds).
 *
 * Features: each probe kind, a tie ordered by the key, each width and pair kind, each side of each norm bound.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { sample } from "@grizzle/testing/source"
import { double, float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { runOfProcess } from "@grizzle/testing/vitest/run"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { indices } from "#compiler/core/array.ts"
import type { Json } from "#compiler/core/canonical.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import { cosineNormMax, cosineNormMin, vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { pg, uuid, Vector, type Uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { normTolerance } from "#test/pg/vector/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, contains, defined, lacks, nonEmpty } from "#test/support/assert.ts"
import {
	compileTemplate,
	type FixtureSchema,
	paramTexts,
	scalarsOnly,
	testCompile
} from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf, parsedSchemaName, roleNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { expectConstraint } from "#test/support/substrate/expect.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import { codecOf } from "#test/unit/codec/support.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import { Q, T } from "#test/unit/lower/conservative/fixtures.ts"

const vectorType = (dims: number): ScalarType => scalarOf({ kind: "vector", dimensions: dims }, {})

/** Vector columns at the three dimension counts the domain is argued for, each with its CHECK. */
const Narrow = relation("Narrow", { id: uuid, value: pg.vector(4) }, ["id"])
const Wide = relation("Wide", { id: uuid, value: pg.vector(2000) }, ["id"])
const Widest = relation("Widest", { id: uuid, value: pg.vector(16000) }, ["id"])
const Widths = schema("VectorWidths", [Narrow, Wide, Widest], [])

/** The text of any vector's components, the codec's text form without its domain check: the carrier's own. */
const rawText = (v: Vector): string => Vector.componentText(v)

const id = (prefix: number, n: number): Uuid =>
	`00000000-0000-4000-${pipe(prefix.toString(16), Str.padStart(4, "0"))}-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The element at an index, and a value found, which the test's own fixture guarantees. */
const at = <A>(list: ReadonlyArray<A>, index: number): A => {
	const item = list[index]
	if (item === undefined) {
		throw new Error(`no element at ${index} of ${list.length}`)
	}
	return item
}

const accountA = id(0xa, 1)
const accountB = id(0xa, 2)

/**
 * The run's draw of the facts' and the probes' components: one value of the label's rotating stream under the run's
 * seed, the same in every process of one run and new in every run, never a fixed seed. Each use salts it.
 */
const runDraw = Effect.map(runOfProcess, (run) =>
	defined(
		sample(
			int(0, 2 ** 31 - 1),
			rotatingSeed(run.seed, floorSeed("pg/vector/exact/distance")),
			1
		)[0],
		"the run's draw"
	)
)

/** A mulberry32 generator over the run's draw, salted per use. */
const random = (draw: number, salt: number) => {
	const seed = draw ^ salt
	let a = seed >>> 0
	return (): number => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const textOf = (v: Vector): string => {
	const text = codecOf(vectorType(v.length), emptyCodebook).encode(v)
	if (!text.ok) {
		throw new Error(`codec refused a fixture vector: ${text.error}`)
	}
	return text.value
}

interface Embedding {
	readonly document: string
	readonly revision: bigint
	readonly value: Vector
}

interface Facts {
	readonly documents: ReadonlyArray<{ readonly id: string; readonly account: string }>
	readonly current: ReadonlyArray<{ readonly document: string; readonly revision: bigint }>
	readonly embeddings: ReadonlyArray<Embedding>
}

/**
 * 90 documents over two accounts, one to three embedded revisions each. Every seventh document's current revision is
 * pending (no embedding yet), every eleventh has no current revision. Documents 1, 2 and 4 share one embedding at
 * their current revision, as do 5 and 8, so their distances tie whatever the query vector.
 */
const facts = (draw: number): Facts => {
	const next = random(draw, 0x5ea2c4)
	const documents: Array<Facts["documents"][number]> = []
	const current: Array<Facts["current"][number]> = []
	const embeddings: Array<Embedding> = []
	const shared = new Map<number, Vector>()
	const component = () => Math.fround(next() * 2 - 1)
	for (let i = 1; i <= 90; i++) {
		const document = id(0xd, i)
		documents.push({ id: document, account: i % 3 === 0 ? accountB : accountA })
		const revisions = 1 + (i % 3)
		for (let r = 1; r <= revisions; r++) {
			const drawnValue = Vector.make(
				Float32Array.of(component(), component(), component(), component()),
				4
			)
			/** The first of each sharing group plants its current embedding; the others take it. */
			const group = i === 1 || i === 2 || i === 4 ? 1 : i === 5 || i === 8 ? 5 : 0
			const takes = r === revisions && group !== 0 && i !== group
			const value = takes ? defined(shared.get(group), `document ${group}'s embedding`) : drawnValue
			if (r === revisions && i === group) {
				shared.set(group, value)
			}
			embeddings.push({ document, revision: BigInt(r), value })
		}
		if (i % 11 === 0) {
			continue
		}
		current.push({ document, revision: BigInt(i % 7 === 0 ? revisions + 1 : revisions) })
	}
	return { documents, current, embeddings }
}

/**
 * The HNSW index the test creates itself, named without the naming rule's markers: the installation creates none, as no
 * approximate program is in its workload.
 */
const hnsw = "document_embedding_value_hnsw"

const values = (rows: ReadonlyArray<ReadonlyArray<string>>): string =>
	Arr.join(
		Arr.map(rows, (r) => `(${Arr.join(r, ", ")})`),
		", "
	)

const load = (schema: string, f: Facts) => {
	const t = (name: string) => `"${schema}"."${name}"`
	return Effect.gen(function* () {
		const { admin } = yield* Substrate
		yield* admin.query(
			`INSERT INTO ${t("document")} ("id", "account", "title") VALUES ${values(Arr.map(f.documents, (d) => [`'${d.id}'::uuid`, `'${d.account}'::uuid`, `'title ${d.id}'`]))}`,
			[]
		)
		yield* admin.query(
			`INSERT INTO ${t("document_current")} ("document", "revision") VALUES ${values(Arr.map(f.current, (c) => [`'${c.document}'::uuid`, `${c.revision}::bigint`]))}`,
			[]
		)
		yield* admin.query(
			`INSERT INTO ${t("document_embedding")} ("document", "revision", "value") VALUES ${values(Arr.map(f.embeddings, (e) => [`'${e.document}'::uuid`, `${e.revision}::bigint`, `'${textOf(e.value)}'::"vector_ext"."vector"(4)`]))}`,
			[]
		)
		yield* admin.query(
			`CREATE INDEX "${hnsw}" ON ${t("document_embedding")} USING hnsw ("value" "vector_ext"."vector_cosine_ops")`,
			[]
		)
		yield* admin.query(
			`VACUUM ANALYZE ${t("document")}, ${t("document_current")}, ${t("document_embedding")}`,
			[]
		)
	})
}

/** The raw text rows of one statement, its placeholders filled by the statement's own encoders. */
const runRaw = (
	session: RawSession,
	spec: StatementSpec,
	params: Readonly<Record<string, unknown>>,
	prefix: string
) => {
	const texts = paramTexts(spec, params, scalarsOnly)
	return Effect.map(session.values(`${prefix}${spec.sql}`, texts), (rows) =>
		Arr.map(rows, (row) =>
			Arr.map(row, (c) => (typeof c === "string" ? c : jsonText(trusted<Json>(c))))
		)
	)
}

/**
 * The complete exact oracle: every stored embedding's native distance from a scan with no ORDER BY, which no ANN
 * index can serve, then the example's eligibility applied on the host: the account's documents at their current revision.
 */
const oracle = (schema: string, f: Facts, account: string, probe: Vector) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(
			`SELECT "document"::text, "revision"::text, "vector_ext"."cosine_distance"("value", $1::text::"vector_ext"."vector"(4))::text FROM "${schema}"."document_embedding"`,
			[textOf(probe)]
		)
		const distance = new Map(
			Arr.map(rows, (r) => [`${String(r[0])}|${String(r[1])}`, String(r[2])])
		)
		const accountOf = new Map(Arr.map(f.documents, (d) => [d.id, d.account]))
		const eligible: Array<readonly [string, string, string]> = []
		for (const c of f.current) {
			if (accountOf.get(c.document) !== account) {
				continue
			}
			const d = distance.get(`${c.document}|${c.revision}`)
			if (d !== undefined) {
				eligible.push([d, c.document, String(c.revision)])
			}
		}
		return {
			eligible,
			all: Arr.map(rows, (r) => [String(r[2]), String(r[0]), String(r[1])] as const)
		}
	})

type ScoredRow = readonly [string, string, string]

/** Scored rows by distance, then document, then revision. */
const byDistanceThenKey: Order.Order<ScoredRow> = Order.combineAll([
	Order.mapInput(Order.Number, (r: ScoredRow) => Number(r[0])),
	Order.mapInput(Order.String, (r: ScoredRow) => r[1]),
	Order.mapInput(Order.Number, (r: ScoredRow) => Number(r[2]))
])

const sortedTexts = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => Arr.join(r, "|")),
		Order.String
	)

const expectNormAgrees = (v: Vector, native: number, label: string): void => {
	const host = Vector.norm(v)
	assert.equal(Number.isFinite(native) && native > 0, true, `${label}: vector_norm is ${native}`)
	assert.ok(
		Math.abs(host - native) <= normTolerance(v.length, native),
		`${label}: host ${host}, vector_norm ${native}`
	)
	if (v.filter((x) => x !== 0).length === 1) {
		assert.equal(host, native, label)
	}
}

/** The template of `q` as `role` reads it, under the installation's schema name. */
const compiled = (q: unknown, role: FixtureSchema, schema: string): OracleTemplate => {
	const r = compileTemplate(q, role, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schema))
	})
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/**
 * A probe: a stored embedding by its place among the facts', any drawn vector of the cosine domain, or an axis at a
 * bound of its norm.
 */
type ProbeSketch =
	| { readonly kind: "stored"; readonly index: number }
	| { readonly kind: "drawn"; readonly norm: number; readonly direction: DirectionSketch }
	| {
			readonly kind: "bound"
			readonly axis: number
			readonly greatest: boolean
			readonly negative: boolean
	  }

/** What a probe was, and whether its distances tied. */
type ProbeFeature =
	| "a stored embedding"
	| "a drawn probe"
	| "a probe at a norm bound"
	| "a tie ordered by the key"

/** The feature each kind of probe reaches. */
const probeFeatureOf: { readonly [K in ProbeSketch["kind"]]: ProbeFeature } = {
	stored: "a stored embedding",
	drawn: "a drawn probe",
	bound: "a probe at a norm bound"
}

const probeKinds = Object.freeze(Rec.keys(probeFeatureOf))

/** Where a dimension count lies: few, at the HNSW index's limit, or at the storage limit. */
type WidthFeature = "few dimensions" | "the HNSW limit" | "the storage limit"

const widthFeatureOf = (dims: number): WidthFeature =>
	dims === vectorMaxDimensions.value
		? "the storage limit"
		: dims === hnswPolicy.maxDimensions.value
			? "the HNSW limit"
			: "few dimensions"

/** A dimension count of each width: two to eight, or either limit. */
const dimsOf: { readonly [W in WidthFeature]: Gen<number> } = {
	"few dimensions": int(2, 8),
	"the HNSW limit": constant(hnswPolicy.maxDimensions.value),
	"the storage limit": constant(vectorMaxDimensions.value)
}

const widthFeatures = Object.freeze(Rec.keys(dimsOf))

const dimsGen: Gen<number> = oneOf(nonEmpty(Rec.values(dimsOf), "a generator per width"))

/** A direction's component: a multiple of 2^-20 in [-1, 1], so a direction that is not zero has a length to scale by. */
const gridComponent: Gen<number> = map(int(-(2 ** 20), 2 ** 20), (n) => n / 2 ** 20)

/** A direction: every component drawn, or every 97th, the rest zero, which a sum over many dimensions meets. */
interface DirectionSketch {
	readonly sparse: boolean
	readonly components: ReadonlyArray<number>
}

const directionGen =
	(dims: number): Gen<DirectionSketch> =>
	(source) => {
		const sparse = dims > 8 && source.draw(boolean)
		const count = sparse ? Math.ceil(dims / 97) : dims
		return { sparse, components: source.draw(array(gridComponent, { min: count, max: count })) }
	}

/** A direction's components at `dims` dimensions, never all zero. */
const directionOf = (dims: number, sketch: DirectionSketch): Array<number> => {
	const direction = Arr.map(indices(dims), (i) =>
		sketch.sparse
			? i % 97 === 0
				? (sketch.components[i / 97] ?? 0)
				: 0
			: (sketch.components[i] ?? 0)
	)
	return Arr.some(direction, (x) => x !== 0)
		? direction
		: Arr.map(direction, (_, i) => (i === 0 ? 1 : 0))
}

/**
 * The vector of `dims` dimensions in a direction with host norm as close to `norm` as binary32 allows inside the
 * domain.
 */
const scaled = (dims: number, norm: number, direction: ReadonlyArray<number>): Vector => {
	const length = Math.sqrt(Arr.reduce(direction, 0, (a, x) => a + x * x))
	for (let factor = norm / length; ; factor *= norm > 1 ? 1 - 2 ** -20 : 1 + 2 ** -20) {
		const v = Vector.make(
			Float32Array.from(direction, (x) => x * factor),
			dims
		)
		if (Vector.inCosineDomain(v)) {
			return v
		}
	}
}

/** A norm in the cosine domain: either bound, or any power of two between them. */
const normGen: Gen<number> = oneOf([
	constant(cosineNormMin.value),
	constant(cosineNormMax.value),
	map(double(Math.log2(cosineNormMin.value), Math.log2(cosineNormMax.value)), (e) => 2 ** e)
])

/**
 * A norm well inside the cosine domain, any power of two from 2^-20 to 2^20. pgvector sums a cosine's squares in
 * binary32, so a probe near the least norm has a finite distance but not one near the host's binary64 distance; the
 * bounds themselves are probed by the axes, whose one square is exact.
 */
const ordinaryNormGen: Gen<number> = map(double(-20, 20), (e) => 2 ** e)

/** A vector of the domain: a norm and a direction. */
interface VectorDraw {
	readonly norm: number
	readonly direction: DirectionSketch
}

/**
 * A pair: two drawn vectors, whose distance is free; a vector and itself (0), its negation (2); or two axes at the two
 * bounds (1).
 */
type PairDraw =
	| { readonly kind: "free"; readonly a: VectorDraw; readonly b: VectorDraw }
	| { readonly kind: "identical"; readonly a: VectorDraw }
	| { readonly kind: "opposite"; readonly a: VectorDraw }
	| { readonly kind: "orthogonal axes" }

type PairFeature = WidthFeature | PairDraw["kind"]

const vectorDrawGen =
	(dims: number): Gen<VectorDraw> =>
	(source) => ({ norm: source.draw(normGen), direction: source.draw(directionGen(dims)) })

const pairDrawGen = (dims: number): Gen<PairDraw> =>
	oneOf<PairDraw>([
		(source) => ({
			kind: "free",
			a: source.draw(vectorDrawGen(dims)),
			b: source.draw(vectorDrawGen(dims))
		}),
		map(vectorDrawGen(dims), (a): PairDraw => ({ kind: "identical", a })),
		map(vectorDrawGen(dims), (a): PairDraw => ({ kind: "opposite", a })),
		constant<PairDraw>({ kind: "orthogonal axes" })
	])

/** Pairs at a dimension count `dims` draws. */
const pairsAt =
	(dims: Gen<number>): Gen<{ readonly dims: number; readonly pairs: ReadonlyArray<PairDraw> }> =>
	(source) => {
		const n = source.draw(dims)
		return { dims: n, pairs: source.draw(array(pairDrawGen(n), { min: 1, max: n > 8 ? 2 : 6 })) }
	}

const pairsGen = pairsAt(dimsGen)

/** A pair's vectors, and the distance its construction fixes. */
const pairOf = (
	dims: number,
	pair: PairDraw
): { readonly a: Vector; readonly b: Vector; readonly distance: number | undefined } => {
	const vectorOf = (v: VectorDraw) => scaled(dims, v.norm, directionOf(dims, v.direction))
	const axis = (i: number, x: number) =>
		Vector.make(
			Float32Array.from(indices(dims), (j) => (j === i ? x : 0)),
			dims
		)
	switch (pair.kind) {
		case "free":
			return { a: vectorOf(pair.a), b: vectorOf(pair.b), distance: undefined }
		case "identical": {
			const a = vectorOf(pair.a)
			return { a, b: a, distance: 0 }
		}
		case "opposite": {
			const a = vectorOf(pair.a)
			return {
				a,
				b: Vector.make(
					a.map((x) => -x),
					dims
				),
				distance: 2
			}
		}
		case "orthogonal axes":
			return {
				a: axis(0, cosineNormMin.value),
				b: axis(dims - 1, cosineNormMax.value),
				distance: 1
			}
	}
}

/** The relations of the widths, each a vector column with its CHECK. */
const widthRelations = nonEmpty(Rec.values(Widths.relations), "the widths' relations")

/**
 * A CHECK case: a relation, a bound of the cosine domain, a relative nudge from it, none or a power of two below or
 * above, and a direction.
 */
interface CheckCase {
	readonly relation: number
	readonly greatest: boolean
	readonly nudge: number
	readonly direction: DirectionSketch
}

type CheckFeature =
	| WidthFeature
	| "admitted away from the bounds"
	| "refused away from the bounds"
	| "decided near a bound"

/** A CHECK case on the relation at `relations`' place. */
const checkCaseOf =
	(relations: Gen<number>): Gen<CheckCase> =>
	(source) => {
		const relation = source.draw(relations)
		return {
			relation,
			greatest: source.draw(boolean),
			nudge: source.draw(
				oneOf([
					constant(0),
					(inner) => (inner.draw(boolean) ? -1 : 1) * 2 ** -inner.draw(int(16, 40))
				])
			),
			direction: source.draw(directionGen(at(widthRelations, relation).fields.value.dimensions))
		}
	}

const checkCaseGen = checkCaseOf(int(0, widthRelations.length - 1))

/** The largest finite binary32 value. */
const maxFloat32 = (2 - 2 ** -23) * 2 ** 127

/**
 * Any finite binary32 components, signed zero and subnormals included, at up to 2000 dimensions, with at least one
 * nonzero component, by construction: one drawn place holds a nonzero magnitude, from the least subnormal up, with a
 * drawn sign; magnitudes spread over the whole range, which stresses summation order.
 */
const binary32Vector: Gen<Vector> = (source) => {
	const dims = source.draw(int(1, 2000))
	const components = source.draw(array(float(-maxFloat32, maxFloat32), { min: dims, max: dims }))
	const at = source.draw(int(0, dims - 1))
	const magnitude = source.draw(float(2 ** -149, maxFloat32))
	const nonzero = source.draw(boolean) ? -magnitude : magnitude
	return Vector.make(
		Float32Array.from(components, (x, place) => (place === at ? nonzero : x)),
		dims
	)
}

layer(Substrate.layer)("exact cosine distance", (it) => {
	it.effect(
		"equals the complete exact oracle with an HNSW index present, never plans the ANN path, and ties by the key",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const draw = yield* runDraw
					const worlds = search.searchWorlds(search.Search)
					const installed = yield* install(search.Search, {
						ambient: ordinarySession,
						label: "vsearch",
						logins: [worlds.server],
						extensions: []
					})
					const f = facts(draw)
					yield* load(installed.schema, f)
					const searcher = yield* s.session({
						...worldSession(installed.world(worlds.searcher)),
						label: "searcher"
					})
					const scored = compiled(search.scoredDocuments, worlds.searcher, installed.declared)
					const ordered = compiled(search.byDistance, worlds.searcher, installed.declared)
					const scoredSpecs = Arr.appendAll(scored.optimized, scored.conservative)
					const orderedSpecs = Arr.appendAll(ordered.optimized, ordered.conservative)
					/**
					 * approximateNearest's conservative form is the exact top-k of its source: here every
					 * stored embedding scored against the probe, its five nearest by distance, then document and revision.
					 */
					const q = new Q()
					const embedding = q.base(
						{
							name: "DocumentEmbedding",
							heading: heading(
								["document", T.uuid],
								["revision", T.int8],
								["value", vectorType(4)]
							),
							primaryKey: ["document", "revision"]
						},
						conservativeMeta
					)
					const scoredAll = q.project(
						embedding,
						[
							["document", "document"],
							["revision", "revision"],
							[
								"distance",
								[
									q.op(
										"vector:cosine_distance(vector,vector)",
										[q.col(embedding, "value"), q.param("probe", vectorType(4), "compare")],
										T.float8
									),
									T.float8
								]
							]
						],
						conservativeMeta
					)
					const nearest = q.node({
						kind: "ApproximateNearest",
						source: scoredAll,
						score: "distance",
						take: 5n,
						params: [ParamId("probe")],
						sealed: true,
						heading: scoredAll.heading,
						loc: undefined,
						meta: conservativeMeta
					})
					const program = lowerConservative(conservativeInput(q.build(nearest)), {
						names: installed.names,
						params: [],
						subject: { kind: "query" }
					})
					if (!program.ok) {
						throw new Error(program.error.message)
					}
					const statement = flight(program.value.roots)[0]
					const accounts = nonEmpty(
						Arr.dedupe(Arr.map(f.documents, (d) => d.account)),
						"the facts' accounts"
					)
					const probeOfKind: { readonly [K in ProbeSketch["kind"]]: Gen<ProbeSketch> } = {
						stored: map(int(0, f.embeddings.length - 1), (index): ProbeSketch => ({
							kind: "stored",
							index
						})),
						drawn: (source): ProbeSketch => ({
							kind: "drawn",
							norm: source.draw(ordinaryNormGen),
							direction: source.draw(directionGen(4))
						}),
						bound: (source): ProbeSketch => ({
							kind: "bound",
							axis: source.draw(int(0, 3)),
							greatest: source.draw(boolean),
							negative: source.draw(boolean)
						})
					}
					const probeGen: Gen<ProbeSketch> = oneOf(
						nonEmpty(Rec.values(probeOfKind), "a generator per probe kind")
					)
					const probeOf = (sketch: ProbeSketch): Vector => {
						switch (sketch.kind) {
							case "stored":
								return at(f.embeddings, sketch.index).value
							case "drawn":
								return scaled(4, sketch.norm, directionOf(4, sketch.direction))
							case "bound": {
								const bound = sketch.greatest ? cosineNormMax.value : cosineNormMin.value
								return Vector.make(
									Float32Array.from(indices(4), (i) =>
										i === sketch.axis ? (sketch.negative ? -bound : bound) : 0
									),
									4
								)
							}
						}
					}
					return yield* explore(
						{
							suite: "pg/vector/exact/distance",
							draw: drawn((source) => ({
								account: source.draw(element(accounts)),
								probe: source.draw(probeGen)
							})),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "every stored embedding's native cosine_distance from a scan no index orders, the eligibility applied on the host"
							},
							coverage: required<ProbeFeature>(
								[
									"a stored embedding",
									"a drawn probe",
									"a probe at a norm bound",
									"a tie ordered by the key"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						({ account, probe: drawnProbe }, k) =>
							Effect.gen(function* () {
								const sketch = Option.getOrElse(
									Option.flatMap(k.steering, (pending) =>
										Option.map(
											Arr.findFirst(probeKinds, (kind) => pending.has(probeFeatureOf[kind])),
											(kind) => k.draw(probeOfKind[kind])
										)
									),
									() => drawnProbe
								)
								k.note(probeFeatureOf[sketch.kind])
								const probe = probeOf(sketch)
								const params = { account, vector: probe }
								const { eligible, all } = yield* oracle(installed.schema, f, account, probe)
								assert.ok(eligible.length > 10)
								const expected = Arr.sort(eligible, byDistanceThenKey)
								for (const [d] of expected) {
									const value = Number(d)
									assert.equal(Number.isFinite(value) && value >= 0 && value <= 2, true)
								}
								if (Arr.some(expected, (r, i) => i > 0 && expected[i - 1]?.[0] === r[0])) {
									k.note("a tie ordered by the key")
								}
								for (const spec of scoredSpecs) {
									/** Heading order is distance, document, revision (the checker's canonical column order). */
									const rows = yield* runRaw(searcher, spec, params, "")
									assert.deepEqual(sortedTexts(rows), sortedTexts(expected))
									assert.equal(new Set(Arr.map(rows, (r) => Arr.join(r, "|"))).size, rows.length)
								}
								for (const spec of orderedSpecs) {
									const rows = yield* runRaw(searcher, spec, params, "")
									assert.deepEqual(
										rows,
										Arr.map(expected, (r) => [...r])
									)
								}
								yield* searcher.values("SET enable_seqscan = off", [])
								for (const spec of Arr.appendAll(scoredSpecs, orderedSpecs)) {
									const [plan] = yield* runRaw(searcher, spec, params, "EXPLAIN (FORMAT JSON) ")
									lacks(planIndexNames(defined(plan, "the EXPLAIN row")[0]), hnsw)
								}
								const [annPlan] = yield* searcher.values(
									`EXPLAIN (FORMAT JSON) SELECT "document" FROM ${roleNamesOf(installed, worlds.searcher).view("DocumentEmbedding")} ORDER BY "value" OPERATOR("vector_ext".<=>) $1::text::"vector_ext"."vector"(4) LIMIT 5`,
									[textOf(probe)]
								)
								contains(planIndexNames(defined(annPlan, "the EXPLAIN row")[0]), hnsw)
								yield* searcher.values("RESET enable_seqscan", [])
								/** approximateNearest's conservative form: the exact top five of every stored embedding. */
								const nearest = yield* s.admin.queryValues(
									`SELECT t."distance"::text, t."document"::text, t."revision"::text FROM (${statement.sql.text}) AS t`,
									[textOf(probe)]
								)
								const top = Arr.sort(all, byDistanceThenKey).slice(0, 5)
								assert.deepEqual(
									sortedTexts(Arr.map(nearest, (r) => Arr.map(r, String))),
									sortedTexts(top)
								)
							})
					)
				})
			)
	)

	it.effect(
		"is finite and within [0, 2] across the admitted cosine domain, at few dimensions, the HNSW limit and the storage limit",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					return yield* explore(
						{
							suite: "pg/vector/exact/cosine-domain",
							draw: drawn(pairsGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "cosine distance lies in [0, 2], is 0, 2 and 1 for identical, opposite and orthogonal pairs, and vector_norm agrees with the host's"
							},
							coverage: required<PairFeature>(
								[
									"few dimensions",
									"the HNSW limit",
									"the storage limit",
									"free",
									"identical",
									"opposite",
									"orthogonal axes"
								],
								{ cases: 24, sense: notesOnly }
							),
							kept: [],
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(drawnPairs, k) =>
							Effect.gen(function* () {
								const { dims, pairs } = Option.getOrElse(
									Option.flatMap(k.steering, (pending) =>
										Option.map(
											Arr.findFirst(widthFeatures, (feature) => pending.has(feature)),
											(feature) => k.draw(pairsAt(dimsOf[feature]))
										)
									),
									() => drawnPairs
								)
								k.note(widthFeatureOf(dims))
								const built = Arr.map(pairs, (pair) => {
									k.note(pair.kind)
									return pairOf(dims, pair)
								})
								const payload = jsonText(
									Arr.map(built, (p, ord) => ({ ord, a: textOf(p.a), b: textOf(p.b) }))
								)
								const rows = yield* s.admin.queryValues(
									`SELECT "vector_ext"."cosine_distance"(r.a::"vector_ext"."vector", r.b::"vector_ext"."vector")::text, "vector_ext"."vector_norm"(r.a::"vector_ext"."vector")::text, "vector_ext"."vector_norm"(r.b::"vector_ext"."vector")::text FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, a text, b text) ORDER BY r.ord`,
									[payload]
								)
								assert.equal(rows.length, built.length, `${dims} dimensions`)
								for (const [i, row] of rows.entries()) {
									const d = Number(row[0])
									const p = at(built, i)
									assert.equal(
										Number.isFinite(d) && d >= 0 && d <= 2,
										true,
										`pair ${dims}:${i} gives ${String(row[0])}`
									)
									if (p.distance !== undefined) {
										assert.equal(d, p.distance, `pair ${dims}:${i}`)
									}
									expectNormAgrees(p.a, Number(row[1]), `pair ${dims}:${i} a`)
									expectNormAgrees(p.b, Number(row[2]), `pair ${dims}:${i} b`)
								}
							})
					)
				})
			)
	)

	it.effect(
		"the CHECK admits exactly the native cosine domain, and the host agrees away from the bounds, at few dimensions, the HNSW limit and the storage limit",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const world = fullWorld(Widths, {})
					const installed = yield* install(Widths, {
						ambient: ordinarySession,
						label: "vwidth",
						logins: [world.server],
						extensions: []
					})
					const names = namesOf(installed)
					const writer = yield* s.session({
						...worldSession(installed.world(world.app)),
						label: "writer"
					})
					let n = 0
					return yield* explore(
						{
							suite: "pg/vector/exact/norm-check",
							draw: drawn(checkCaseGen),
							literal: Formatter.format,
							oracle: {
								kind: "postgresql",
								name: "the column's CHECK, vector_norm between the bounds, against the host's norm and codec"
							},
							coverage: required<CheckFeature>(
								[
									"admitted away from the bounds",
									"refused away from the bounds",
									"few dimensions",
									"the HNSW limit",
									"the storage limit"
								],
								{ cases: 36, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(drawnCheck, k) =>
							Effect.gen(function* () {
								const drawnCase = Option.getOrElse(
									Option.flatMap(k.steering, (pending) =>
										Option.map(
											Arr.findFirstIndex(widthRelations, (r) =>
												pending.has(widthFeatureOf(r.fields.value.dimensions))
											),
											(place) => k.draw(checkCaseOf(constant(place)))
										)
									),
									() => drawnCheck
								)
								const relation = at(widthRelations, drawnCase.relation)
								const dims = relation.fields.value.dimensions
								k.note(widthFeatureOf(dims))
								const constraint = names.normCheck(relation, "value")
								const bound = drawnCase.greatest ? cosineNormMax.value : cosineNormMin.value
								const direction = directionOf(dims, drawnCase.direction)
								const length = Math.sqrt(Arr.reduce(direction, 0, (a, x) => a + x * x))
								const factor = (bound * (1 + drawnCase.nudge)) / length
								const v = Vector.make(
									Float32Array.from(direction, (x) => x * factor),
									dims
								)
								const insert = writer.values(
									`INSERT INTO ${names.table(relation)} ("id", "value") VALUES ($1::text::uuid, $2::text::"vector_ext"."vector"(${dims}))`,
									[id(0xe, ++n), rawText(v)]
								)
								const [row] = yield* s.admin.queryValues(
									`SELECT "vector_ext"."vector_norm"($1::text::"vector_ext"."vector"(${dims}))::text`,
									[rawText(v)]
								)
								const native = Number(row?.[0])
								const label = `${relation.name} near ${bound} by ${drawnCase.nudge}`
								expectNormAgrees(v, native, label)
								/** The CHECK is vector_norm between the bounds: it admits exactly the native domain. */
								const inside = native >= cosineNormMin.value && native <= cosineNormMax.value
								if (inside) {
									yield* insert
								} else {
									const refused = yield* expectConstraint(insert, constraint, "23514")
									assert.equal(refused.code, "23514")
								}
								/**
								 * Away from the bounds by more than the summation rounding, the host decides alike, and the
								 * codec refuses what the CHECK refuses before any SQL.
								 */
								const host = Vector.norm(v)
								const margin = Math.min(
									Math.abs(host - cosineNormMin.value),
									Math.abs(host - cosineNormMax.value)
								)
								if (margin <= 4 * normTolerance(dims, host)) {
									k.note("decided near a bound")
									return
								}
								k.note(inside ? "admitted away from the bounds" : "refused away from the bounds")
								assert.equal(Vector.inCosineDomain(v), inside, label)
								const encoded = codecOf(vectorType(dims), emptyCodebook).encode(v)
								const expected: "admitted" | CodecFault = inside ? "admitted" : "vectorNorm"
								assert.equal(encoded.ok ? "admitted" : encoded.error, expected, label)
							})
					)
				})
			)
	)

	it.effect("the host norm agrees with vector_norm on generated binary32 vectors", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				return yield* explore(
					{
						oracle: {
							kind: "postgresql",
							name: "vector_norm, within the host norm's derived bound"
						},
						suite: "pg/vector/exact/norm",
						draw: drawn(array(binary32Vector, { min: 1, max: 100 })),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 4,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(batch) =>
						Effect.gen(function* () {
							const payload = jsonText(Arr.map(batch, (v, ord) => ({ ord, a: rawText(v) })))
							const rows = yield* s.admin.queryValues(
								`SELECT "vector_ext"."vector_norm"(r.a::"vector_ext"."vector")::text FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, a text) ORDER BY r.ord`,
								[payload]
							)
							assert.equal(rows.length, batch.length)
							for (const [k, row] of rows.entries()) {
								expectNormAgrees(at(batch, k), Number(row[0]), `vector ${k}`)
							}
						})
				)
			})
		)
	)
})
