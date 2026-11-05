import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { array, element, filter, type Gen, int } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { completeShrink } from "@grizzle/testing/shrink"
import { sample } from "@grizzle/testing/source"
import { float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { runOfProcess } from "@grizzle/testing/vitest/run"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	String as Str
} from "effect"
import { planIndexNames } from "#bench/harness/explain.ts"
import { indices } from "#compiler/core/array.ts"
import type { Json } from "#compiler/core/canonical.ts"
import type { CodecFault } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { pg, uuid, Vector, type Uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/vector.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, contains, defined, lacks } from "#test/support/assert.ts"
import { compileTemplate, paramTexts, testCompile } from "#test/support/compile.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { namesOf, parsedSchemaName, roleNamesOf } from "#test/support/kernel/naming.ts"
import { expectConstraint } from "#test/support/substrate/expect.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import { codecOf } from "#test/unit/codec/support.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import { Q, T } from "#test/unit/lower/conservative/fixtures.ts"

const vectorType = (dims: number): ScalarType => scalarOf({ kind: "vector", dimensions: dims }, {})
const codec4 = codecOf(vectorType(4))

/** Vector columns at the three dimension counts the domain is argued for, each with its CHECK. */
const Narrow = relation("Narrow", { id: uuid, value: pg.vector(4) }, ["id"])
const Wide = relation("Wide", { id: uuid, value: pg.vector(2000) }, ["id"])
const Widest = relation("Widest", { id: uuid, value: pg.vector(16000) }, ["id"])
const Widths = schema("VectorWidths", { Narrow, Wide, Widest }, [])

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

const found = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw new Error(`no ${what}`)
	}
	return value
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
	const text = codecOf(vectorType(v.length)).encode(v)
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
	const texts = paramTexts(spec, params)
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

/** Host double-precision cosine distance, for a tolerance check on the native float32 kernel. */
const hostDistance = (a: Float32Array, b: Float32Array): number => {
	let dot = 0
	let na = 0
	let nb = 0
	for (const [i, x] of a.entries()) {
		const y = found(b[i], `component ${i}`)
		dot += x * y
		na += x ** 2
		nb += y ** 2
	}
	return 1 - Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb)))
}

/** One unit in the last place of a positive normal double. */
const ulp = (x: number): number => 2 ** (Math.floor(Math.log2(x)) - 52)

/**
 * How far the host norm may lie from vector_norm's: both sum the same n exact double squares (a binary32 square fits
 * a double), in index order on the host and in whatever order pgvector's -fassociative-math build vectorizes, so
 * each sum is within (n - 1) units of 2^-53 of the exact one, relatively; the square root halves that and adds half
 * an ulp on either side. A float32 accumulator or a square taken before widening errs by about 2^-24 per term, far
 * beyond this bound at every dimension count.
 */
const normTolerance = (dimensions: number, norm: number): number =>
	dimensions * 2 ** -53 * norm + ulp(norm)

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
const compiled = (q: unknown, role: unknown, schema: string): QueryTemplate => {
	const r = compileTemplate(q, role, {
		...testCompile,
		installation: identity.schema(parsedSchemaName(schema))
	})
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}

/** How long one case of a distance check may run. */
const caseHang = Duration.minutes(2)

/** An account searched, and a probe searched with, by its place among the test's probes. */
type ProbeFeature = `account ${"A" | "B"}` | `probe ${number}`

/** The two accounts of the facts, by the letter a report names them. */
const accounts: Arr.NonEmptyReadonlyArray<readonly [account: string, label: "A" | "B"]> = [
	[accountA, "A"],
	[accountB, "B"]
]

/** The dimension counts the cosine domain is argued for, and the norms its pairs are scaled to. */
const dimensionCounts = [4, 2000, 16000] as const
type Dimensions = (typeof dimensionCounts)[number]

/** A dimension count checked whole. */
type DimensionFeature = `dimensions ${Dimensions}`

/** A vector relation and its dimension count. */
type Width = readonly [relation: typeof Narrow | typeof Wide | typeof Widest, dims: Dimensions]

/** The vector relation of each dimension count, with its CHECK. */
const widths: Arr.NonEmptyReadonlyArray<Width> = [
	[Narrow, 4],
	[Wide, 2000],
	[Widest, 16000]
]

/** How far a CHECK case's norm lies from its bound, relatively: below, at and above it, near and far. */
const nudges = [-(2 ** -20), -(2 ** -36), 0, 2 ** -36, 2 ** -20] as const

/** A width, a bound of the cosine domain and a nudge from it: the CHECK's space. */
type CheckCase = readonly [width: Width, bound: number, nudge: number]

const checkCases: Gen<CheckCase> = (source) =>
	[
		source.draw(element(widths)),
		source.draw(element([cosineNormMin, cosineNormMax])),
		source.draw(element(nudges))
	] as const

/** The largest finite binary32 value. */
const maxFloat32 = (2 - 2 ** -23) * 2 ** 127

/**
 * Any finite binary32 components, signed zero and subnormals included, at up to 2000 dimensions, with at least one
 * nonzero component; magnitudes spread over the whole range, which stresses summation order.
 */
const binary32Vector: Gen<Vector> = (source) => {
	const dims = source.draw(int(1, 2000))
	const components = source.draw(
		filter(
			array(float(-maxFloat32, maxFloat32), { min: dims, max: dims }),
			(xs) => Arr.some(xs, (x) => x !== 0),
			10
		)
	)
	return Vector.make(Float32Array.from(components), dims)
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
					const next = random(draw, 0x9e37)
					const probes: Arr.NonEmptyReadonlyArray<Vector> = [
						Option.getOrThrowWith(
							Arr.findFirst(f.embeddings, (e) => e.document === id(0xd, 1) && e.revision === 2n),
							() => new Error("no stored embedding")
						).value,
						Vector.make(Float32Array.of(1, 0, 0, 0), 4),
						Vector.make(Float32Array.of(next() - 0.5, next() - 0.5, next() - 0.5, next() - 0.5), 4),
						Vector.make(Float32Array.of(2 ** -16, 0, 0, 0), 4),
						Vector.make(Float32Array.of(0, 0, -65536, 0), 4)
					]
					const probeIndices = Arr.range(0, probes.length - 1)
					let ties = 0
					yield* exhaust(
						{
							suite: "pg/vector/exact/distance",
							generator: (source) =>
								[source.draw(element(accounts)), source.draw(element(probeIndices))] as const,
							literal: ([[, label], index]) => `account ${label}, probe ${index}`,
							limit: accounts.length * probes.length,
							coverage: requiredInSpace<ProbeFeature>([
								"account A",
								"account B",
								...Arr.map(probeIndices, (index): ProbeFeature => `probe ${index}`)
							]),
							caseHang
						},
						([[account, label], index], k) =>
							Effect.gen(function* () {
								const probe = at(probes, index)
								const params = { account, vector: probe }
								const { eligible } = yield* oracle(installed.schema, f, account, probe)
								assert.ok(eligible.length > 10)
								const expected = Arr.sort(eligible, byDistanceThenKey)
								for (const [d, document, revision] of expected) {
									const value = Number(d)
									assert.equal(Number.isFinite(value) && value >= 0 && value <= 2, true)
									const stored = Option.getOrThrowWith(
										Arr.findFirst(
											f.embeddings,
											(e) => e.document === document && String(e.revision) === revision
										),
										() => new Error("no stored embedding")
									)
									assert.ok(Math.abs(value - hostDistance(stored.value, probe)) < 1e-6)
								}
								for (let i = 1; i < expected.length; i++) {
									if (expected[i]?.[0] === expected[i - 1]?.[0]) {
										ties++
									}
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
								k.note(`account ${label}`)
								k.note(`probe ${index}`)
							})
					)
					assert.ok(ties >= probes.length)

					yield* searcher.values("SET enable_seqscan = off", [])
					const params = { account: accountA, vector: at(probes, 2) }
					for (const spec of Arr.appendAll(scoredSpecs, orderedSpecs)) {
						const [plan] = yield* runRaw(searcher, spec, params, "EXPLAIN (FORMAT JSON) ")
						lacks(planIndexNames(defined(plan, "the EXPLAIN row")[0]), hnsw)
					}
					const [annPlan] = yield* searcher.values(
						`EXPLAIN (FORMAT JSON) SELECT "document" FROM ${roleNamesOf(installed, worlds.searcher).view("DocumentEmbedding")} ORDER BY "value" OPERATOR("vector_ext".<=>) $1::text::"vector_ext"."vector"(4) LIMIT 5`,
						[textOf(at(probes, 2))]
					)
					contains(planIndexNames(defined(annPlan, "the EXPLAIN row")[0]), hnsw)
					yield* searcher.values("RESET enable_seqscan", [])

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
					return yield* exhaust(
						{
							suite: "pg/vector/exact/distance/nearest",
							generator: element(probeIndices),
							literal: (index: number) => `probe ${index}`,
							limit: probes.length,
							coverage: requiredInSpace<ProbeFeature>(
								Arr.map(probeIndices, (index): ProbeFeature => `probe ${index}`)
							),
							caseHang
						},
						(index, k) =>
							Effect.gen(function* () {
								const probe = at(probes, index)
								const probeText = codec4.encode(probe)
								if (!probeText.ok) {
									throw new Error(probeText.error)
								}
								const rows = yield* s.admin.queryValues(
									`SELECT t."distance"::text, t."document"::text, t."revision"::text FROM (${statement.sql.text}) AS t`,
									[probeText.value]
								)
								const { all } = yield* oracle(installed.schema, f, accountA, probe)
								const top = Arr.sort(all, byDistanceThenKey).slice(0, 5)
								assert.deepEqual(
									sortedTexts(Arr.map(rows, (r) => Arr.map(r, String))),
									sortedTexts(top)
								)
								k.note(`probe ${index}`)
							})
					)
				})
			)
	)

	it.effect(
		"is finite and within [0, 2] across the admitted cosine domain, at 4, 2000 and 16000 dimensions",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const draw = yield* runDraw
					return yield* exhaust(
						{
							suite: "pg/vector/exact/cosine-domain",
							generator: element(dimensionCounts),
							literal: (dims: Dimensions) => `${dims} dimensions`,
							limit: dimensionCounts.length,
							coverage: requiredInSpace<DimensionFeature>(
								Arr.map(dimensionCounts, (dims): DimensionFeature => `dimensions ${dims}`)
							),
							caseHang
						},
						(dims, k) =>
							Effect.gen(function* () {
								const next = random(draw, 0xc05e ^ dims)
								/**
								 * A vector of `dims` dimensions in a drawn direction with host norm as close to `norm` as
								 * binary32 allows inside the domain; `sparse` keeps only every 97th component.
								 */
								const scaled = (norm: number, sparse: boolean): Vector => {
									const direction = Arr.map(indices(dims), (i) =>
										sparse && i % 97 !== 0 ? 0 : next() * 2 - 1
									)
									let length = Math.sqrt(Arr.reduce(direction, 0, (a, x) => a + x * x))
									if (length === 0) {
										direction[0] = 1
										length = 1
									}
									for (
										let factor = norm / length;
										;
										factor *= norm > 1 ? 1 - 2 ** -20 : 1 + 2 ** -20
									) {
										const v = Vector.make(
											Float32Array.from(direction, (x) => x * factor),
											dims
										)
										if (Vector.inCosineDomain(v)) {
											return v
										}
									}
								}
								const negate = (v: Vector): Vector =>
									Vector.make(
										v.map((x) => -x),
										v.length
									)
								/**
								 * A pair, and the distance its construction fixes: identical (0), opposite (2), orthogonal (1),
								 * or none.
								 */
								type Pair = {
									readonly a: Vector
									readonly b: Vector
									readonly expect:
										| { readonly kind: "fixed"; readonly distance: number }
										| { readonly kind: "free" }
								}
								const free = { kind: "free" } as const
								const fixed = (distance: number) => ({ kind: "fixed", distance }) as const
								const pairs: Array<Pair> = []
								const norms = [2 ** -16, 2 ** -8, 1, 2 ** 8, 2 ** 16]
								const sparse = dims > 4
								const runs = dims === 16000 ? 2 : dims === 2000 ? 6 : 40
								for (let r = 0; r < runs; r++) {
									const na = at(norms, r % norms.length)
									const nb = at(norms, (r * 3 + 1) % norms.length)
									const a = scaled(na, sparse && r % 2 === 0)
									const b = scaled(nb, sparse && r % 3 === 0)
									pairs.push(
										{ a, b, expect: free },
										{ a, b: a, expect: fixed(0) },
										{ a, b: negate(a), expect: fixed(2) }
									)
								}
								/** Orthogonal axes at the two bounds. */
								const axis = (i: number, x: number) =>
									Vector.make(
										Float32Array.from(indices(dims), (j) => (j === i ? x : 0)),
										dims
									)
								pairs.push({ a: axis(0, 2 ** -16), b: axis(dims - 1, 2 ** 16), expect: fixed(1) })
								pairs.push({
									a: scaled(2 ** -16, false),
									b: scaled(2 ** 16, false),
									expect: free
								})
								const payload = jsonText(
									Arr.map(pairs, (p, ord) => ({ ord, a: textOf(p.a), b: textOf(p.b) }))
								)
								const rows = yield* s.admin.queryValues(
									`SELECT "vector_ext"."cosine_distance"(r.a::"vector_ext"."vector", r.b::"vector_ext"."vector")::text, "vector_ext"."vector_norm"(r.a::"vector_ext"."vector")::text, "vector_ext"."vector_norm"(r.b::"vector_ext"."vector")::text FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, a text, b text) ORDER BY r.ord`,
									[payload]
								)
								assert.equal(rows.length, pairs.length, `${dims} dimensions`)
								for (const [i, row] of rows.entries()) {
									const d = Number(row[0])
									const p = at(pairs, i)
									assert.equal(
										Number.isFinite(d) && d >= 0 && d <= 2,
										true,
										`pair ${dims}:${i} gives ${String(row[0])}`
									)
									if (p.expect.kind === "fixed") {
										assert.ok(Math.abs(d - p.expect.distance) < 1e-5, `pair ${dims}:${i}`)
									}
									expectNormAgrees(p.a, Number(row[1]), `pair ${dims}:${i} a`)
									expectNormAgrees(p.b, Number(row[2]), `pair ${dims}:${i} b`)
								}
								k.note(`dimensions ${dims}`)
							})
					)
				})
			)
	)

	it.effect(
		"the CHECK admits exactly the native cosine domain, and the host agrees away from the bounds, at 4, 2000 and 16000 dimensions",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const draw = yield* runDraw
					const world = fullWorld(Widths)
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
					const next = random(draw, 0xb0d5)
					let n = 0
					/** How many vectors away from the bounds each table admitted and refused, by its name. */
					const tallies = new Map<string, { admitted: number; refused: number }>()
					const checked = yield* exhaust(
						{
							suite: "pg/vector/exact/norm-check",
							generator: checkCases,
							literal: ([[relation], bound, nudge]: CheckCase) =>
								`${relation.name} near ${bound} by ${nudge}`,
							limit: widths.length * 2 * nudges.length,
							coverage: requiredInSpace<DimensionFeature>(
								Arr.map(widths, ([, dims]): DimensionFeature => `dimensions ${dims}`)
							),
							caseHang
						},
						([[relation, dims], bound, nudge], k) =>
							Effect.gen(function* () {
								const table = relation.name
								const constraint = names.normCheck(relation, "value")
								const insert = (v: Vector) =>
									writer.values(
										`INSERT INTO ${names.table(relation)} ("id", "value") VALUES ($1::text::uuid, $2::text::"vector_ext"."vector"(${dims}))`,
										[id(0xe, ++n), rawText(v)]
									)
								const tally = tallies.get(table) ?? { admitted: 0, refused: 0 }
								tallies.set(table, tally)
								for (let r = 0; r < 2; r++) {
									const direction = Array.from({ length: dims }, () => next() * 2 - 1)
									const length = Math.sqrt(Arr.reduce(direction, 0, (a, x) => a + x * x))
									const factor = (bound * (1 + nudge)) / length
									const v = Vector.make(
										Float32Array.from(direction, (x) => x * factor),
										dims
									)
									const [row] = yield* s.admin.queryValues(
										`SELECT "vector_ext"."vector_norm"($1::text::"vector_ext"."vector"(${dims}))::text`,
										[rawText(v)]
									)
									const native = Number(row?.[0])
									const label = `${table} near ${bound} by ${nudge}`
									expectNormAgrees(v, native, label)
									/** The CHECK is vector_norm between the bounds: it admits exactly the native domain. */
									const inside = native >= cosineNormMin && native <= cosineNormMax
									if (inside) {
										yield* insert(v)
									} else {
										const refused = yield* expectConstraint(insert(v), constraint, "23514")
										assert.equal(refused.code, "23514")
									}
									/**
									 * Away from the bounds by more than the summation rounding, the host decides alike, and the
									 * codec refuses what the CHECK refuses before any SQL.
									 */
									const host = Vector.norm(v)
									const tolerance = normTolerance(dims, host)
									const margin = Math.min(
										Math.abs(host - cosineNormMin),
										Math.abs(host - cosineNormMax)
									)
									if (margin > 4 * tolerance) {
										assert.equal(Vector.inCosineDomain(v), inside, label)
										const encoded = codecOf(vectorType(dims)).encode(v)
										const expected: "admitted" | CodecFault = inside ? "admitted" : "vectorNorm"
										assert.equal(encoded.ok ? "admitted" : encoded.error, expected, label)
										tally[inside ? "admitted" : "refused"]++
									}
								}
								k.note(`dimensions ${dims}`)
							})
					)
					assert.equal(tallies.size, widths.length)
					for (const [table, tally] of tallies) {
						assert.ok(tally.admitted >= 4, table)
						assert.ok(tally.refused >= 4, table)
					}
					return checked
				})
			),
		120_000
	)

	it.effect("the host norm agrees with vector_norm on generated binary32 vectors", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				return yield* explore(
					{
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
