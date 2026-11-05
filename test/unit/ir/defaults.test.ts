import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { type Array as Arr, Effect, Formatter } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import { type DescKind, decodeDesc, descText } from "#compiler/ir/desc.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The one default the boundary fills, an import's empty bind map, and the stated values beside it. Every other part
 * of a description is stated: a numeric's scale, a law side's selection.
 */
type Feature = "bind omitted" | "bind stated" | "bind nonempty"

/** How a description is written: the bind map as the case drew it, noting what it writes, or always stated. */
type Writing =
	| { readonly kind: "drawn"; readonly note: Case<Feature>["note"] }
	| { readonly kind: "canonical" }

/** The field descriptors a relation parameter's heading or a cast names, each stated whole. */
const fields: Arr.NonEmptyReadonlyArray<Json> = [
	{ kind: "pg", type: "integer" },
	{ kind: "uuid" },
	{ kind: "numeric", precision: 10, scale: 2 },
	{ kind: "numeric", precision: 1000, scale: 0 },
	{ kind: "text", source: "^[a-z]+$", flags: "u" }
]

const fieldGen: Gen<Json> = element(fields)

/**
 * What one match of a query reads: a relation, a relation parameter whose heading holds a field, or an import of a
 * query bound by the empty record (a site) or by a nonempty one.
 */
type SourceSketch =
	| { readonly kind: "relation" }
	| { readonly kind: "param"; readonly field: Json }
	| {
			readonly kind: "import"
			readonly query: QuerySketch
			readonly bind: BindSketch
	  }

type BindSketch = { readonly kind: "empty"; readonly omit: boolean } | { readonly kind: "bound" }

/** A one-rule query: one match, its variable in the head, and a head column casting it, or none. */
interface QuerySketch {
	readonly source: SourceSketch
	readonly cast: { readonly kind: "none" } | { readonly kind: "cast"; readonly to: Json }
}

const castGen: Gen<QuerySketch["cast"]> = oneOf<QuerySketch["cast"]>([
	constant<QuerySketch["cast"]>({ kind: "none" }),
	map(fieldGen, (to): QuerySketch["cast"] => ({ kind: "cast", to }))
])

const bindGen: Gen<BindSketch> = oneOf<BindSketch>([
	map(boolean, (omit): BindSketch => ({ kind: "empty", omit })),
	constant<BindSketch>({ kind: "bound" })
])

/** A query whose imports nest at most `depth` deep. */
const queryGen = (depth: number): Gen<QuerySketch> => {
	const leaves: Arr.NonEmptyReadonlyArray<Gen<SourceSketch>> = [
		constant<SourceSketch>({ kind: "relation" }),
		map(fieldGen, (field): SourceSketch => ({ kind: "param", field }))
	]
	const source =
		depth === 0
			? oneOf(leaves)
			: oneOf<SourceSketch>([
					...leaves,
					(inner) => ({
						kind: "import",
						query: inner.draw(queryGen(depth - 1)),
						bind: inner.draw(bindGen)
					})
				])
	return (sketch) => ({ source: sketch.draw(source), cast: sketch.draw(castGen) })
}

/** Writes sketches as JSON descriptions, noting each bind map it writes when the writing is the drawn one. */
class Writer {
	readonly #writing: Writing

	constructor(writing: Writing) {
		this.#writing = writing
	}

	#note(feature: Feature): void {
		if (this.#writing.kind === "drawn") {
			this.#writing.note(feature)
		}
	}

	/** Whether an empty bind map the case spelled `omit` is left out: never in the canonical writing. */
	#omitsBind(omit: boolean): boolean {
		const omitted = this.#writing.kind === "drawn" && omit
		this.#note(omitted ? "bind omitted" : "bind stated")
		return omitted
	}

	#source(source: SourceSketch): Json {
		switch (source.kind) {
			case "relation":
				return { kind: "relation", name: "R0" }
			case "param":
				return { kind: "param", name: "rows", heading: { f0: source.field } }
			case "import": {
				const query = this.query(source.query)
				if (source.bind.kind === "bound") {
					this.#note("bind nonempty")
					return { kind: "query", query, bind: { p: { kind: "literal", value: 1 } } }
				}
				return this.#omitsBind(source.bind.omit)
					? { kind: "query", query }
					: { kind: "query", query, bind: {} }
			}
		}
	}

	query(q: QuerySketch): Json {
		const x: Json = { kind: "var", var: "x" }
		const head: Json =
			q.cast.kind === "none" ? { f0: x } : { f0: x, c: { kind: "cast", to: q.cast.to, arg: x } }
		return {
			stage: {
				kind: "rules",
				arms: [
					{
						vars: [{ id: "x" }],
						matches: [{ source: this.#source(q.source), bindings: { f0: x } }],
						where: [],
						head,
						interiors: [],
						attach: []
					}
				]
			}
		}
	}
}

/** The canonical text of a description as the boundary decodes it. */
const decodedText = (kind: DescKind, json: Json, writing: Writing["kind"]): string => {
	const decoded = decodeDesc(kind, json)
	if (!decoded.ok) {
		throw new Error(`the ${writing} ${kind} description is refused: ${decoded.error.message}`)
	}
	const text = descText(decoded.value)
	if (!text.ok) {
		throw new Error(`the decoded ${kind} has no canonical text: ${text.error.message}`)
	}
	return text.value
}

const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"bind omitted",
	"bind stated",
	"bind nonempty"
]

describe("the Description boundary's defaults", () => {
	it.effect(
		"a query omitting an import's empty bind map and one stating it decode to one canonical text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/defaults",
						literal: Formatter.format,
						draw: drawn((source) => source.draw(queryGen(2))),
						runs: 400,
						shrink: completeShrink,
						coverage: required<Feature>(situations, { cases: 400, sense: notesOnly }),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(query, c) =>
						Effect.sync(() => {
							const asDrawn = new Writer({ kind: "drawn", note: c.note })
							const canonical = new Writer({ kind: "canonical" })
							assert.equal(
								decodedText("query", asDrawn.query(query), "drawn"),
								decodedText("query", canonical.query(query), "canonical")
							)
						})
				)
			)
	)
})
