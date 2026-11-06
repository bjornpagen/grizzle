import { describe, it } from "@effect/vitest"
import { exhaust, explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { EncodingFailure, isCompileError } from "#compiler/core/errors.ts"
import { cosineNormMax, cosineNormMin } from "#compiler/ir/carriers.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { templateFor } from "#compiler/program/template.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid, Vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { assert, faulted, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import * as search from "#test/support/fixtures/api/search.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { codecOf } from "#test/unit/codec/support.ts"

const dims = search.DocumentVector.dimensions
const lowest = cosineNormMin.value
const highest = cosineNormMax.value
/** Half the least norm: four components of it have the least norm exactly. */
const quarterNorm = lowest / 2

/** The largest finite float32. */
const floatMax = Math.fround(3.4028234663852886e38)

/**
 * A component: the bounds and their neighbours, values that underflow or overflow float32, the non-finite ones, -0,
 * and any float.
 */
const componentGen = oneOf([
	element([
		0,
		-0,
		1,
		quarterNorm,
		lowest,
		Math.fround(lowest * (1 - 2 ** -24)),
		highest,
		highest * (1 + 2 ** -23),
		highest * 2,
		1e-50,
		1e39,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY
	]),
	float(-floatMax, floatMax)
])

/**
 * A buffer: of the field's dimensions or not, its components drawn one by one, all equal (four components of half the
 * least norm have the least norm exactly), small components inside the domain with -0 among them, which reach an admitted buffer
 * holding -0, or one component at a bound of the norm and the others zero, whose norm is that bound; and whether the
 * caller writes zeros into it after the check.
 */
interface BufferSketch {
	readonly length: number
	readonly components: ReadonlyArray<number>
	readonly zeroedAfter: boolean
}

const bufferGen: Gen<BufferSketch> = (source) => ({
	length: source.draw(element([dims, dims, dims, dims - 1, dims + 1])),
	components: source.draw(
		oneOf([
			array(componentGen, { min: dims + 1, max: dims + 1 }),
			map(componentGen, (x) => Array.from({ length: dims + 1 }, () => x)),
			array(element([-0, 0, 1, quarterNorm]), { min: dims + 1, max: dims + 1 }),
			map(element([lowest, highest, -lowest, -highest]), (bound) =>
				Array.from({ length: dims + 1 }, (_, i) => (i === 0 ? bound : 0))
			)
		])
	),
	zeroedAfter: source.draw(boolean)
})

/** The verdict of the cosine domain on a float32 buffer. */
type Verdict = "vectorDimensions" | "vectorNonFinite" | "vectorNorm" | "admitted"
const verdictOf = (buffer: Float32Array): { readonly verdict: Verdict; readonly norm: number } => {
	const norm = Math.sqrt(buffer.reduce((sum, x) => sum + x * x, 0))
	if (buffer.length !== dims) {
		return { verdict: "vectorDimensions", norm }
	}
	if (!buffer.every(Number.isFinite)) {
		return { verdict: "vectorNonFinite", norm }
	}
	return { verdict: norm >= lowest && norm <= highest ? "admitted" : "vectorNorm", norm }
}

type DomainFeature =
	| "admitted at a bound"
	| "admitted inside"
	| "a norm below the domain"
	| "a norm above the domain"
	| "a non-finite component"
	| "other dimensions"
	| "an underflowing component"
	| "-0 written as 0"
	| "a buffer zeroed after its check"

/**
 * Planted: an admitted buffer holding -0, and each bound of the norm, which the drawn buffers reach a few times a run.
 */
const domainKept: ReadonlyArray<Kept<BufferSketch, DomainFeature>> = [
	{
		note: "-0 among the components of a buffer of the greatest norm",
		sketch: { length: dims, components: [-0, highest, 0, -0, 0], zeroedAfter: false },
		draws: "",
		reaches: ["-0 written as 0", "admitted at a bound"]
	},
	{
		note: "four components of half the least norm, of the least norm, zeroed after the check",
		sketch: {
			length: dims,
			components: Array.from({ length: dims + 1 }, () => quarterNorm),
			zeroedAfter: true
		},
		draws: "",
		reaches: ["admitted at a bound", "a buffer zeroed after its check"]
	}
]

const literalQuery = (literal: Vector<4>) =>
	query(search.Search).rule((r) => {
		const { document, revision, value } = v(search.DocumentEmbedding, "documentEmbedding")
		return r
			.match(search.DocumentEmbedding, { document, revision, value })
			.find({ document, distance: Compute.cosineDistance(value, literal) })
	})

const sqlOf = (built: unknown) =>
	Arr.map(succeeded(compileTemplate(built, undefined, testCompile)).conservative, (s) => s.sql)

describe("the cosine domain", () => {
	it.effect(
		"admits exactly the buffers of the field's dimensions, finite, of a norm in [cosineNormMin, cosineNormMax], at Vector.from and at every encode",
		(ctx) =>
			Effect.gen(function* () {
				const codec = codecOf(scalarOf({ kind: "vector", dimensions: dims }, {}), emptyCodebook)
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/vector/cosine-domain",
							draw: sketched(bufferGen, (b) => b),
							literal: Formatter.format,
							coverage: required<DomainFeature>(
								[
									"admitted at a bound",
									"admitted inside",
									"a norm below the domain",
									"a norm above the domain",
									"a non-finite component",
									"other dimensions",
									"an underflowing component",
									"-0 written as 0",
									"a buffer zeroed after its check"
								],
								{ cases: 300, sense: notesOnly }
							),
							kept: domainKept,
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ length, components, zeroedAfter }, c) =>
							Effect.sync(() => {
								const buffer = Float32Array.from(components.slice(0, length))
								const { verdict, norm } = verdictOf(buffer)
								if (Arr.some(components.slice(0, length), (x) => x !== 0 && Math.fround(x) === 0)) {
									c.note("an underflowing component")
								}
								const from = Vector.from<number>(buffer, dims)
								if (verdict !== "admitted") {
									c.note(
										verdict === "vectorDimensions"
											? "other dimensions"
											: verdict === "vectorNonFinite"
												? "a non-finite component"
												: norm < lowest
													? "a norm below the domain"
													: "a norm above the domain"
									)
									assert.ok(!from.ok && from.error instanceof EncodingFailure)
									assert.equal(from.error.reason._tag, verdict)
									if (verdict !== "vectorDimensions") {
										faulted(codec.encode(Vector.make(buffer, dims)), verdict)
									}
									return
								}
								c.note(
									norm === lowest || norm === highest ? "admitted at a bound" : "admitted inside"
								)
								const refined = succeeded(from)
								assert.ok(
									refined !== buffer &&
										refined.length === buffer.length &&
										refined.every((x, i) => Object.is(x, buffer[i])),
									"the refined vector is a copy of the caller's buffer, component for component"
								)
								assert.equal(Vector.norm(refined), norm)
								if (buffer.some((x) => Object.is(x, -0))) {
									c.note("-0 written as 0")
								}
								assert.equal(
									succeeded(codec.encode(refined)),
									`[${Arr.join(
										Arr.map([...buffer], (x) => String(Object.is(x, -0) ? 0 : x)),
										","
									)}]`
								)
								if (!zeroedAfter) {
									return
								}
								c.note("a buffer zeroed after its check")
								const text = succeeded(codec.encode(refined))
								buffer.fill(0)
								assert.equal(
									succeeded(codec.encode(refined)),
									text,
									"the refined vector is a copy, so zeroing the caller's buffer after its check reaches none of it"
								)
								faulted(
									codec.encode(Vector.make(buffer, dims)),
									"vectorNorm",
									"the buffer itself, branded by Vector.make, is checked again at its encode"
								)
							})
					)
				)
			})
	)

	it.effect(
		"refuses a vector literal outside the domain when the query is built, and holds one inside as it was then",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/vector/literal-domain",
						/** Inside the domain, a zero norm, and a norm below its least and above its greatest. */
						generator: element<readonly [number, number, number, number]>([
							[0, 0, 1, 0],
							[0, 0, 0, 0],
							[0, 0, lowest / 2, 0],
							[0, 0, highest * 2, 0]
						]),
						literal: Formatter.format,
						limit: 4,
						coverage: requiredInSpace<"held as built" | "refused when built">([
							"held as built",
							"refused when built"
						]),
						caseHang
					},
					(xs, c) =>
						Effect.sync(() => {
							const buffer = Float32Array.from(xs)
							if (verdictOf(buffer).verdict !== "admitted") {
								c.note("refused when built")
								assert.throws(
									() => literalQuery(Vector.make(buffer, 4)),
									(e) => isCompileError(e) && e.reason._tag === "MalformedDescription"
								)
								return
							}
							c.note("held as built")
							const built = literalQuery(Vector.make(buffer, 4))
							buffer.fill(1)
							assert.deepEqual(
								sqlOf(built),
								sqlOf(literalQuery(Vector.make(Float32Array.from(xs), 4)))
							)
						})
				)
			)
	)
})

describe("the vector schema in a template's premise", () => {
	const Note = relation("Note", { id: uuid, n: pg.bigint }, ["id"])
	const Notes = schema("Notes", { Note }, [])
	const notes = query(Notes).rule((r) => {
		const { id, n } = v(Note, "note")
		return r.match(Note, { id, n }).find({ id, n })
	})
	const reading = {
		identity: undefined,
		read: "rows",
		context: "snapshot"
	} as const

	it.effect(
		"records the extension schema of a template reading a vector, which its SQL follows",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/vector/template-premise",
						generator: (source) =>
							[
								source.draw(
									element<"a vector search" | "no vector">(["a vector search", "no vector"])
								),
								source.draw(
									element<"vector_ext" | "embeddings_ext">(["vector_ext", "embeddings_ext"])
								)
							] as const,
						literal: Formatter.format,
						limit: 4,
						coverage: requiredInSpace<"a vector search" | "no vector">([
							"a vector search",
							"no vector"
						]),
						caseHang
					},
					([reads, vectorSchema], c) =>
						Effect.sync(() => {
							c.note(reads)
							const [q, s] =
								reads === "a vector search" ? [search.byDistance, search.Search] : [notes, Notes]
							const input = succeeded(parseSchemaInput(s))
							const artifacts = succeeded(testArtifacts(s, { ...testCompile, vectorSchema }))
							const template = succeeded(
								templateFor(succeeded(queryInput(q)), input, artifacts, reading)
							).template
							const other = vectorSchema === "vector_ext" ? "embeddings_ext" : "vector_ext"
							if (reads === "no vector") {
								assert.deepEqual(template.requirements.extensions, [])
								assert.deepEqual(template.requirements.extensionSchemas, {})
								return
							}
							assert.deepEqual(template.requirements.extensionSchemas, { vector: vectorSchema })
							for (const statement of Arr.appendAll(template.optimized, template.conservative)) {
								assert.ok(!Str.includes(`"${other}"`)(statement.sql), `no statement names ${other}`)
							}
						})
				)
			)
	)
})
