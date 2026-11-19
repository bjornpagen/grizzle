import { indices } from "@bjornpagen/grizzle-text/base/array"
import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import { floorSeed } from "@bjornpagen/testing/random"
import { sample } from "@bjornpagen/testing/source"
import { double, float } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Order, Record as Rec, String as Str, pipe } from "effect"
import { hnswPolicy } from "#compiler/check/approximate/policy.ts"
import { type Json } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { type StatementSpec } from "#compiler/ir/products.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { type ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { type Uuid, Vector, pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/scalar/values/fault.ts"
import { normTolerance } from "#test/pg/vector/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import {
	type FixtureSchema,
	compileTemplate,
	paramTexts,
	scalarsOnly,
	testCompile
} from "#test/support/compile.ts"
import { type OracleTemplate } from "#test/support/conservative.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { Id } from "#test/support/ids.ts"
import { type Installed, installedTemplate, seededTemplate } from "#test/support/install-migrate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import { codecOf } from "#test/unit/codec/support.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import { Q, T } from "#test/unit/lower/conservative/fixtures.ts"
export const vectorType = (dims: number): ScalarType =>
	scalarOf({ kind: "vector", dimensions: dims }, {})

/** Vector columns at the three dimension counts the domain is argued for, each with its CHECK. */
const Narrow = relation("Narrow", { id: Id, value: pg.vector(4) }, ["id"])
const Wide = relation("Wide", { id: Id, value: pg.vector(2000) }, ["id"])
const Widest = relation("Widest", { id: Id, value: pg.vector(16000) }, ["id"])
const Widths = schema("VectorWidths", [Narrow, Wide, Widest], [])

/** The text of any vector's components, the codec's text form without its domain check: the carrier's own. */
export const rawText = (v: Vector): string => Vector.componentText(v)

export const id = (prefix: number, n: number): Uuid =>
	`00000000-0000-4000-${pipe(prefix.toString(16), Str.padStart(4, "0"))}-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The element at an index, and a value found, which the test's own fixture guarantees. */
export const at = <A>(list: ReadonlyArray<A>, index: number): A => {
	const item = list[index]
	if (item === undefined) {
		throw new Error(`no element at ${index} of ${list.length}`)
	}
	return item
}

const accountA = id(0xa, 1)
const accountB = id(0xa, 2)

/**
 * The facts' draw: one value of the label's floor stream, so the facts are the template's, installed, loaded and
 * analyzed once per member (searchTemplate), their structure (the accounts, the revisions, the pending, missing and
 * shared embeddings) planted by index. What a run draws anew is each case's probe, from the case's own decisions, so a
 * replay token gives the probe again.
 */
const factsDraw = defined(
	sample(int(0, 2 ** 31 - 1), floorSeed("pg/vector/exact/distance"), 1)[0],
	"the floor stream's draw"
)

/** A mulberry32 generator over the facts' draw, salted per use. */
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

export const textOf = (v: Vector): string => {
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
const factsOf = (draw: number): Facts => {
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

/** The template's facts (factsDraw). */
const documentFacts = factsOf(factsDraw)

/**
 * The HNSW index the test creates itself, named without the naming rule's markers: the installation creates none, as no
 * approximate program is in its workload.
 */
export const hnsw = "document_embedding_value_hnsw"

const values = (rows: ReadonlyArray<ReadonlyArray<string>>): string =>
	Arr.join(
		Arr.map(rows, (r) => `(${Arr.join(r, ", ")})`),
		", "
	)

const load = (schema: string) => {
	const f = documentFacts
	const t = (name: string) => `"${schema}"."${name}"`
	return Effect.gen(function* () {
		const { admin } = yield* Substrate
		yield* admin.query(
			`INSERT INTO ${t("document")} ("id", "account", "title") VALUES ${values(Arr.map(f.documents, (d) => [`'${d.id}'::Id`, `'${d.account}'::Id`, `'title ${d.id}'`]))}`,
			[]
		)
		yield* admin.query(
			`INSERT INTO ${t("document_current")} ("document", "revision") VALUES ${values(Arr.map(f.current, (c) => [`'${c.document}'::Id`, `${c.revision}::bigint`]))}`,
			[]
		)
		yield* admin.query(
			`INSERT INTO ${t("document_embedding")} ("document", "revision", "value") VALUES ${values(Arr.map(f.embeddings, (e) => [`'${e.document}'::Id`, `${e.revision}::bigint`, `'${textOf(e.value)}'::"vector_ext"."vector"(4)`]))}`,
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

/** The search fixture's worlds: the searcher reads, the server login serves both roles. */
export const searchWorlds = search.searchWorlds(search.Search)

/**
 * The search fixture with the facts loaded, the HNSW index created and the tables analyzed, as a template (install-migrate.ts
 * seededTemplate): installed once per member, where each search installed and loaded it before its cases. Its seat
 * empties no table: a case only reads.
 */
export const searchTemplate = seededTemplate({
	declaredIn: import.meta,
	name: "exact distance search",
	schema: search.Search,
	options: {
		ambient: ordinarySession,
		label: "vsearch",
		logins: [searchWorlds.server],
		extensions: []
	},
	seed: (installed) => load(installed.schema)
})

/** The raw text rows of one statement, its placeholders filled by the statement's own encoders. */
export const runRaw = (
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
export const oracle = (schema: string, account: string, probe: Vector) =>
	Effect.gen(function* () {
		const f = documentFacts
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
export const byDistanceThenKey: Order.Order<ScoredRow> = Order.combineAll([
	Order.mapInput(Order.Number, (r: ScoredRow) => Number(r[0])),
	Order.mapInput(Order.String, (r: ScoredRow) => r[1]),
	Order.mapInput(Order.Number, (r: ScoredRow) => Number(r[2]))
])

export const sortedTexts = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => Arr.join(r, "|")),
		Order.String
	)

export const expectNormAgrees = (v: Vector, native: number, label: string): void => {
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
export type ProbeFeature =
	| "a stored embedding"
	| "a drawn probe"
	| "a probe at a norm bound"
	| "a tie ordered by the key"

/** The feature each kind of probe reaches. */
export const probeFeatureOf: { readonly [K in ProbeSketch["kind"]]: ProbeFeature } = {
	stored: "a stored embedding",
	drawn: "a drawn probe",
	bound: "a probe at a norm bound"
}

const probeKinds = Object.freeze(Rec.keys(probeFeatureOf))

/** Where a dimension count lies: few, at the HNSW index's limit, or at the storage limit. */
type WidthFeature = "few dimensions" | "the HNSW limit" | "the storage limit"

export const widthFeatureOf = (dims: number): WidthFeature =>
	dims === vectorMaxDimensions
		? "the storage limit"
		: dims === hnswPolicy.maxDimensions
			? "the HNSW limit"
			: "few dimensions"

/** A dimension count of each width: two to eight, or either limit. */
const dimsOf: { readonly [W in WidthFeature]: Gen<number> } = {
	"few dimensions": int(2, 8),
	"the HNSW limit": constant(hnswPolicy.maxDimensions),
	"the storage limit": constant(vectorMaxDimensions)
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
export const directionOf = (dims: number, sketch: DirectionSketch): Array<number> => {
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
	constant(cosineNormMin),
	constant(cosineNormMax),
	map(double(Math.log2(cosineNormMin), Math.log2(cosineNormMax)), (e) => 2 ** e)
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

export type PairFeature = WidthFeature | PairDraw["kind"]

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

/** Each width, with the pairs a case whose turn aims at it draws (aimed): pairs at a dimension count of that width. */
const pairAims: ReadonlyArray<
	readonly [PairFeature, Gen<{ readonly dims: number; readonly pairs: ReadonlyArray<PairDraw> }>]
> = Arr.map(widthFeatures, (feature) => [feature, pairsAt(dimsOf[feature])] as const)

/** A pair's vectors, and the distance its construction fixes. */
export const pairOf = (
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
				a: axis(0, cosineNormMin),
				b: axis(dims - 1, cosineNormMax),
				distance: 1
			}
	}
}

/** The relations of the widths, each a vector column with its CHECK. */
export const widthRelations = nonEmpty(Rec.values(Widths.relations), "the widths' relations")

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

export type CheckFeature =
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

/** Each relation's width, with the CHECK case a case whose turn aims at it draws (aimed): one on that relation. */
const checkAims: ReadonlyArray<readonly [CheckFeature, Gen<CheckCase>]> = Arr.map(
	widthRelations,
	(r, place) => [widthFeatureOf(r.fields.value.dimensions), checkCaseOf(constant(place))] as const
)

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

/** The facts' accounts, each a case's reader. */
const accounts = nonEmpty(
	Arr.dedupe(Arr.map(documentFacts.documents, (d) => d.account)),
	"the facts' accounts"
)

/** A probe of each kind: a stored embedding by its place, a drawn vector of an ordinary norm, or an axis at a bound. */
const probeOfKind: { readonly [K in ProbeSketch["kind"]]: Gen<ProbeSketch> } = {
	stored: map(int(0, documentFacts.embeddings.length - 1), (index): ProbeSketch => ({
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

/** A probe case: an account and its probe. */
interface ProbeCase {
	readonly account: (typeof accounts)[number]
	readonly probe: ProbeSketch
}

/** A case of an account and the probe `probe` draws. */
const probeCaseOf =
	(probe: Gen<ProbeSketch>): Gen<ProbeCase> =>
	(source) => ({ account: source.draw(element(accounts)), probe: source.draw(probe) })

/** Probe cases of any kind, each kind's feature aimed at by a case of its kind's probe (aimed). */
export const probeCases = aimed(
	probeCaseOf(oneOf(nonEmpty(Rec.values(probeOfKind), "a generator per probe kind"))),
	Arr.map(probeKinds, (kind) => [probeFeatureOf[kind], probeCaseOf(probeOfKind[kind])] as const)
)

/** A probe's vector: the stored embedding at its place, the drawn vector, or the axis at its bound. */
export const probeOf = (sketch: ProbeSketch): Vector => {
	switch (sketch.kind) {
		case "stored":
			return at(documentFacts.embeddings, sketch.index).value
		case "drawn":
			return scaled(4, sketch.norm, directionOf(4, sketch.direction))
		case "bound": {
			const bound = sketch.greatest ? cosineNormMax : cosineNormMin
			return Vector.make(
				Float32Array.from(indices(4), (i) =>
					i === sketch.axis ? (sketch.negative ? -bound : bound) : 0
				),
				4
			)
		}
	}
}

/** The scored and the ordered statements of both artifacts, as the searcher reads them under the installation's name. */
export const searchSpecs = (installed: Installed) => {
	const scored = compiled(search.scoredDocuments, searchWorlds.searcher, installed.declared)
	const ordered = compiled(search.byDistance, searchWorlds.searcher, installed.declared)
	return {
		scored: Arr.appendAll(scored.optimized, scored.conservative),
		ordered: Arr.appendAll(ordered.optimized, ordered.conservative)
	}
}

/**
 * approximateNearest's conservative form over the installation's names: the exact top-k of its source, here every
 * stored embedding scored against the probe, its five nearest by distance, then document and revision, lowered with
 * the probe declared as the checker declares it, since a placeholder is cast by its parameter's declared type
 * (lower/conservative/context.ts scalarParam).
 */
export const nearestStatement = (installed: Installed) => {
	const q = new Q()
	const embedding = q.base(
		{
			name: "DocumentEmbedding",
			heading: heading(["document", T.uuid], ["revision", T.int8], ["value", vectorType(4)]),
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
	const nearestQuery = q.build(nearest)
	const program = lowerConservative(conservativeInput(nearestQuery), {
		names: installed.names,
		params: nearestQuery.params,
		subject: { kind: "query" }
	})
	if (!program.ok) {
		throw new Error(program.error.message)
	}
	return defined(flight(program.value.roots)[0], "the nearest program's statement")
}

/** The widths' full world: its server login serves the full role `app`, the writer. */
export const widthsWorld = fullWorld(Widths, {})

/**
 * The widths installed once per member (install-migrate.ts installedTemplate), where each search installed them before
 * its cases; the seat empties every table after a case.
 */
export const widthsTemplate = installedTemplate({
	declaredIn: import.meta,
	name: "exact distance widths",
	schema: Widths,
	options: {
		ambient: ordinarySession,
		label: "vwidth",
		logins: [widthsWorld.server],
		extensions: []
	}
})

/** Generated binary32 vectors, one to a hundred a case. */
export const binary32Vectors = array(binary32Vector, { min: 1, max: 100 })

/** Pairs at a dimension count of any width, each width aimed at by pairs at a count of that width (aimed). */
export const pairCases = aimed(pairsGen, pairAims)

/** CHECK cases on any width's relation, each width aimed at by a case on that width's relation (aimed). */
export const checkCases = aimed(checkCaseGen, checkAims)
