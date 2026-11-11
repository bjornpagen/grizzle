/**
 * What a definition reads and what inputs it needs (schema/walk.ts queryUses) through an import: the import's bound
 * parameters are the binding's, so an importer needs exactly its own parameters, the import's parameters its binding
 * leaves open (every one, when it matches the import itself), and the parameters its binding expressions use; it
 * reads its own relations and the import's.
 *
 * Property: over drawn imports and importers (a schema of two relations of three uuid fields; an import over one of
 * them whose second and third fields are each left free, bound to a variable or to a parameter named from a pool of
 * three; an importer over one of them that matches the import itself or binds each of the import's parameters to a
 * variable, a parameter of its own from the same pool, a literal, or nothing, and perhaps a parameter of its own in
 * a condition), queryUses' inputs and relations are exactly the rule's, each compared as a set.
 *
 * Oracle: the rule above, stated over the sketch (expectedInputs).
 *
 * Plant: walk-bound-input-kept (queryUses keeps every input of a bound import, its bound parameters included).
 *
 * Features: an input bound to a variable, to an importer's parameter, to a literal, or left open; the import matched
 * itself; an importer's parameter named as an import's; a parameterless importer of a parameterized import.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int, map, option, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, queryValueDesc, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

type Binding =
	| { readonly kind: "open" }
	| { readonly kind: "variable" }
	| { readonly kind: "parameter"; readonly name: number }
	| { readonly kind: "literal" }

/** How the import binds one of its free fields: left free, to a variable, or to a parameter by its name's number. */
type Field =
	| { readonly kind: "free" }
	| { readonly kind: "variable" }
	| { readonly kind: "parameter"; readonly name: number }

interface ImportCase {
	readonly imported: number
	readonly importer: number
	readonly fields: readonly [Field, Field]
	/** Whether the importer binds the import, or matches it itself. */
	readonly binds: boolean
	/** The binding of each parameter name of the pool, read only for the names the import holds. */
	readonly bindings: readonly [Binding, Binding, Binding]
	readonly own: Option.Option<number>
}

const pool = 3

const parameterName = (n: number): string => `p${n}`

const fieldGen: Gen<Field> = weighted<Field>([
	[1, (): Field => ({ kind: "free" })],
	[1, (): Field => ({ kind: "variable" })],
	[2, map(int(0, pool - 1), (name): Field => ({ kind: "parameter", name }))]
])

const bindingGen: Gen<Binding> = weighted<Binding>([
	[1, (): Binding => ({ kind: "open" })],
	[1, (): Binding => ({ kind: "variable" })],
	[2, map(int(0, pool - 1), (name): Binding => ({ kind: "parameter", name }))],
	[1, (): Binding => ({ kind: "literal" })]
])

const importCaseGen: Gen<ImportCase> = (source) => ({
	imported: source.draw(int(0, 1)),
	importer: source.draw(int(0, 1)),
	fields: [source.draw(fieldGen), source.draw(fieldGen)],
	binds: source.draw(int(0, 3)) > 0,
	bindings: [source.draw(bindingGen), source.draw(bindingGen), source.draw(bindingGen)],
	own: source.draw(option(int(0, pool - 1)))
})

const R0 = relation("R0", { f0: uuid, f1: uuid, f2: uuid }, ["f0"])
const R1 = relation("R1", { f0: uuid, f1: uuid, f2: uuid }, ["f0"])
const S = schema("S", [R0, R1], [])

const relationAt = (i: number) => (i === 0 ? R0 : R1)

/** The parameter names the import holds. */
const importParameters = (c: ImportCase): ReadonlyArray<number> =>
	Arr.dedupe(Arr.flatMap(c.fields, (f) => (f.kind === "parameter" ? [f.name] : [])))

const bindingOf = (c: ImportCase, name: number): Binding => defined(c.bindings[name])

/** The importer, built through the builders a JavaScript caller drives. */
const importerOf = (c: ImportCase): unknown => {
	const imported = relationAt(c.imported)
	const importValue = queryOver(S).rule((r: RuleValue) => {
		const vars = varsOver(imported, "i")
		const bindings = Rec.fromEntries(
			Arr.flatMap(c.fields, (f, i) => {
				const name = `f${i + 1}`
				return f.kind === "free"
					? []
					: [
							[
								name,
								f.kind === "variable" ? vars[name] : r.param(parameterName(f.name), uuid)
							] as const
						]
			})
		)
		return r.match(imported, { ...bindings, f0: vars["f0"] }).find({ f0: vars["f0"] })
	})
	const outer = relationAt(c.importer)
	return queryOver(S).rule((r: RuleValue) => {
		const vars = varsOver(outer, "o")
		const source = c.binds
			? importValue.bind(
					Rec.fromEntries(
						Arr.flatMap(importParameters(c), (name): ReadonlyArray<readonly [string, unknown]> => {
							const b = bindingOf(c, name)
							switch (b.kind) {
								case "open":
									return []
								case "variable":
									return [[parameterName(name), vars["f1"]] as const]
								case "parameter":
									return [[parameterName(name), r.param(parameterName(b.name), uuid)] as const]
								case "literal":
									return [[parameterName(name), "00000000-0000-4000-8000-000000000001"] as const]
							}
						})
					)
				)
			: importValue
		const matched = r
			.match(outer, { f0: vars["f0"], f1: vars["f1"] })
			.match(source, { f0: vars["f0"] })
		const conditioned = Option.match(c.own, {
			onNone: () => matched,
			onSome: (name) => matched.where(r.eq(vars["f1"], r.param(parameterName(name), uuid)))
		})
		return conditioned.find({ f0: vars["f0"] })
	})
}

/** The inputs the rule gives the importer, as `queryUses` spells a parameter. */
const expectedInputs = (c: ImportCase): ReadonlyArray<string> => {
	const imported = importParameters(c)
	const open = c.binds ? Arr.filter(imported, (n) => bindingOf(c, n).kind === "open") : imported
	const fromBindings = c.binds
		? Arr.flatMap(imported, (n) => {
				const b = bindingOf(c, n)
				return b.kind === "parameter" ? [b.name] : []
			})
		: []
	const own = Option.toArray(c.own)
	return Arr.sort(
		Arr.map(Arr.dedupe([...open, ...fromBindings, ...own]), (n) => `parameter ${parameterName(n)}`),
		Order.String
	)
}

type ImportFeature =
	| "an input bound to a variable"
	| "an input bound to an importer's parameter"
	| "an input bound to a literal"
	| "an input the binding leaves open"
	| "the import matched itself"
	| "an importer's parameter named as an import's"
	| "a parameterless importer of a parameterized import"

const featuresOf = (c: ImportCase, inputs: ReadonlyArray<string>): ReadonlyArray<ImportFeature> => {
	const imported = importParameters(c)
	const kinds = c.binds ? Arr.map(imported, (n) => bindingOf(c, n).kind) : []
	return [
		...(Arr.contains(kinds, "variable") ? ["an input bound to a variable" as const] : []),
		...(Arr.contains(kinds, "parameter")
			? ["an input bound to an importer's parameter" as const]
			: []),
		...(Arr.contains(kinds, "literal") ? ["an input bound to a literal" as const] : []),
		...(Arr.contains(kinds, "open") ? ["an input the binding leaves open" as const] : []),
		...(!c.binds && imported.length > 0 ? ["the import matched itself" as const] : []),
		...(Option.exists(c.own, (n) => Arr.contains(imported, n))
			? ["an importer's parameter named as an import's" as const]
			: []),
		...(inputs.length === 0 && imported.length > 0
			? ["a parameterless importer of a parameterized import" as const]
			: [])
	]
}

describe("queryUses over imports", () => {
	it.effect(
		"needs exactly the parameters an import's binding leaves open or uses, beside its own, and reads the import's relations",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/import-uses",
						draw: drawn(importCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "an importer's inputs are its own, the import's its binding leaves open, and those its binding expressions use"
						},
						coverage: required<ImportFeature>(
							[
								"an input bound to a variable",
								"an input bound to an importer's parameter",
								"an input bound to a literal",
								"an input the binding leaves open",
								"the import matched itself",
								"an importer's parameter named as an import's",
								"a parameterless importer of a parameterized import"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const desc = defined(queryValueDesc(importerOf(c)), "a query value the builder made")
							const uses = queryUses(desc)
							const inputs = Arr.sort([...uses.inputs], Order.String)
							assert.deepEqual<ReadonlyArray<string>>(inputs, expectedInputs(c))
							assert.deepEqual<ReadonlyArray<string>>(
								Arr.sort([...uses.relations], Order.String),
								Arr.sort(Arr.dedupe([`R${c.imported}`, `R${c.importer}`]), Order.String)
							)
							k.noteAll(featuresOf(c, inputs))
						})
				)
			)
	)
})
