import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, constant, element, type Gen, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import { type DescKind, decodeDesc, descText } from "#compiler/ir/desc.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

/** The defaults the boundary fills, and the stated values beside them that are none. */
type Site = "scale" | "bind" | "selection"
type Feature =
	| `${Site} omitted`
	| `${Site} stated`
	| "scale nonzero"
	| "bind nonempty"
	| "selection nonempty"

/** How a description is written: each site as the case drew it, noting what it writes, or every default stated. */
type Writing =
	| { readonly kind: "drawn"; readonly note: Case<Feature>["note"] }
	| { readonly kind: "canonical" }

/**
 * A field descriptor: numeric(p), whose zero scale is a site; numeric(p, s) with a nonzero scale, a control; or one
 * with no scale at all.
 */
type FieldSketch =
	| { readonly kind: "numeric"; readonly precision: number; readonly omitScale: boolean }
	| { readonly kind: "scaled"; readonly precision: number; readonly scale: number }
	| { readonly kind: "fixed"; readonly json: Json }

const fixedFields: Arr.NonEmptyReadonlyArray<Json> = [
	{ kind: "pg", type: "integer" },
	{ kind: "uuid" },
	{ kind: "numeric", precision: 10, scale: 2 },
	{ kind: "text", source: "^[a-z]+$", flags: "u" }
]

const precisions: Arr.NonEmptyReadonlyArray<number> = [1, 5, 38, 1000]
const nonzeroScales: Arr.NonEmptyReadonlyArray<number> = [2, -3, 1000]

const fieldGen: Gen<FieldSketch> = oneOf<FieldSketch>([
	(source) => ({
		kind: "numeric",
		precision: source.draw(element(precisions)),
		omitScale: source.draw(boolean)
	}),
	(source) => ({
		kind: "scaled",
		precision: source.draw(element(precisions)),
		scale: source.draw(element(nonzeroScales))
	}),
	map(element(fixedFields), (json): FieldSketch => ({ kind: "fixed", json }))
])

/** A side's selection: the empty one, a site, or a nonempty one. */
type SelectionSketch =
	| { readonly kind: "empty"; readonly omit: boolean }
	| { readonly kind: "selected" }

const selectionGen: Gen<SelectionSketch> = oneOf<SelectionSketch>([
	map(boolean, (omit): SelectionSketch => ({ kind: "empty", omit })),
	constant<SelectionSketch>({ kind: "selected" })
])

interface StatementSketch {
	readonly kind: "contained" | "mirrors"
	readonly left: { readonly relation: number; readonly selection: SelectionSketch }
	readonly right: { readonly relation: number; readonly selection: SelectionSketch }
}

interface SchemaSketch {
	readonly relations: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<FieldSketch>>
	readonly statements: ReadonlyArray<StatementSketch>
}

/** A side's relation is a pick: the relations it selects among are known only once the whole schema is drawn. */
const sideGen: Gen<StatementSketch["left"]> = (source) => ({
	relation: source.draw(pickGen),
	selection: source.draw(selectionGen)
})

/** One to four fields: a first one, and up to three more. */
const fieldsGen: Gen<Arr.NonEmptyReadonlyArray<FieldSketch>> = (source) => [
	source.draw(fieldGen),
	...source.draw(array(fieldGen, { min: 0, max: 3 }))
]

const schemaGen: Gen<SchemaSketch> = (source) => ({
	relations: [source.draw(fieldsGen), ...source.draw(array(fieldsGen, { min: 0, max: 2 }))],
	statements: source.draw(
		array(
			(statement): StatementSketch => ({
				kind: statement.draw(element<StatementSketch["kind"]>(["contained", "mirrors"])),
				left: statement.draw(sideGen),
				right: statement.draw(sideGen)
			}),
			{ min: 0, max: 3 }
		)
	)
})

/**
 * What one match of a query reads: a relation, a relation parameter whose heading holds a field, or an import of a
 * query bound by the empty record (a site) or by a nonempty one.
 */
type SourceSketch =
	| { readonly kind: "relation" }
	| { readonly kind: "param"; readonly field: FieldSketch }
	| {
			readonly kind: "import"
			readonly query: QuerySketch
			readonly bind: BindSketch
	  }

type BindSketch = { readonly kind: "empty"; readonly omit: boolean } | { readonly kind: "bound" }

/** A one-rule query: one match, its variable in the head, and a head column casting it, or none. */
interface QuerySketch {
	readonly source: SourceSketch
	readonly cast: { readonly kind: "none" } | { readonly kind: "cast"; readonly to: FieldSketch }
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

/** Writes sketches as JSON descriptions, noting each site and control it writes when the writing is the drawn one. */
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

	/** Whether a site the case spelled `omit` is left out: never in the canonical writing. */
	#omits(site: Site, omit: boolean): boolean {
		const omitted = this.#writing.kind === "drawn" && omit
		this.#note(`${site} ${omitted ? "omitted" : "stated"}`)
		return omitted
	}

	field(f: FieldSketch): Json {
		switch (f.kind) {
			case "fixed":
				return f.json
			case "scaled":
				this.#note("scale nonzero")
				return { kind: "numeric", precision: f.precision, scale: f.scale }
			case "numeric":
				return this.#omits("scale", f.omitScale)
					? { kind: "numeric", precision: f.precision }
					: { kind: "numeric", precision: f.precision, scale: 0 }
		}
	}

	#fields(fields: ReadonlyArray<FieldSketch>): Json {
		return Record.fromEntries(Arr.map(fields, (f, i) => [`f${i}`, this.field(f)]))
	}

	#side(relations: number, side: StatementSketch["left"]): Json {
		const relation = `R${pickIndex(side.relation, relations)}`
		const s = side.selection
		if (s.kind === "selected") {
			this.#note("selection nonempty")
			return { relation, fields: ["f0"], selection: { f0: 1 } }
		}
		return this.#omits("selection", s.omit)
			? { relation, fields: ["f0"] }
			: { relation, fields: ["f0"], selection: {} }
	}

	schema(s: SchemaSketch): Json {
		return {
			name: "Defaults",
			relations: Arr.map(s.relations, (fields, i) => ({
				kind: "relation",
				name: `R${i}`,
				fields: this.#fields(fields),
				primaryKey: ["f0"]
			})),
			statements: Arr.map(s.statements, (st) => ({
				kind: st.kind,
				left: this.#side(s.relations.length, st.left),
				right: this.#side(s.relations.length, st.right)
			}))
		}
	}

	#source(source: SourceSketch): Json {
		switch (source.kind) {
			case "relation":
				return { kind: "relation", name: "R0" }
			case "param":
				return { kind: "param", name: "rows", heading: { f0: this.field(source.field) } }
			case "import": {
				const query = this.query(source.query)
				if (source.bind.kind === "bound") {
					this.#note("bind nonempty")
					return { kind: "query", query, bind: { p: { kind: "literal", value: 1 } } }
				}
				return this.#omits("bind", source.bind.omit)
					? { kind: "query", query }
					: { kind: "query", query, bind: {} }
			}
		}
	}

	query(q: QuerySketch): Json {
		const x: Json = { kind: "var", var: "x" }
		const head: Json =
			q.cast.kind === "none"
				? { f0: x }
				: { f0: x, c: { kind: "cast", to: this.field(q.cast.to), arg: x } }
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
	"scale omitted",
	"scale stated",
	"bind omitted",
	"bind stated",
	"selection omitted",
	"selection stated",
	"scale nonzero",
	"bind nonempty",
	"selection nonempty"
]

describe("the Description boundary's defaults", () => {
	it.effect(
		"a description omitting a default and one stating it decode to one canonical text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/ir/defaults",
						literal: Formatter.format,
						draw: drawn((source) => [source.draw(schemaGen), source.draw(queryGen(2))] as const),
						runs: 400,
						shrink: completeShrink,
						coverage: required<Feature>(situations, { cases: 400, sense: notesOnly }),
						kept: [],
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([schema, query], c) =>
						Effect.sync(() => {
							const asDrawn = new Writer({ kind: "drawn", note: c.note })
							const canonical = new Writer({ kind: "canonical" })
							assert.equal(
								decodedText("schema", asDrawn.schema(schema), "drawn"),
								decodedText("schema", canonical.schema(schema), "canonical")
							)
							assert.equal(
								decodedText("query", asDrawn.query(query), "drawn"),
								decodedText("query", canonical.query(query), "canonical")
							)
						})
				)
			)
	)
})
