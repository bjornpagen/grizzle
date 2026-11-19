/** What the properties of walk.test.ts read: its spaces, models and helpers. */

import { type Gen, int, map, option, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"

import { defined } from "@bjornpagen/testing/assert"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { Id } from "#test/support/ids.ts"

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

export const importCaseGen: Gen<ImportCase> = (source) => ({
	imported: source.draw(int(0, 1)),
	importer: source.draw(int(0, 1)),
	fields: [source.draw(fieldGen), source.draw(fieldGen)],
	binds: source.draw(int(0, 3)) > 0,
	bindings: [source.draw(bindingGen), source.draw(bindingGen), source.draw(bindingGen)],
	own: source.draw(option(int(0, pool - 1)))
})

const R0 = relation("R0", { f0: Id, f1: Id, f2: Id }, ["f0"])

const R1 = relation("R1", { f0: Id, f1: Id, f2: Id }, ["f0"])

const S = schema("S", [R0, R1], [])

const relationAt = (i: number) => (i === 0 ? R0 : R1)

/** The parameter names the import holds. */
const importParameters = (c: ImportCase): ReadonlyArray<number> =>
	Arr.dedupe(Arr.flatMap(c.fields, (f) => (f.kind === "parameter" ? [f.name] : [])))

const bindingOf = (c: ImportCase, name: number): Binding => defined(c.bindings[name])

/** The importer, built through the builders a JavaScript caller drives. */
export const importerOf = (c: ImportCase): unknown => {
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
								f.kind === "variable" ? vars[name] : r.param(parameterName(f.name), Id)
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
									return [[parameterName(name), r.param(parameterName(b.name), Id)] as const]
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
			onSome: (name) => matched.where(r.eq(vars["f1"], r.param(parameterName(name), Id)))
		})
		return conditioned.find({ f0: vars["f0"] })
	})
}

/** The inputs the rule gives the importer, as `queryUses` spells a parameter. */
export const expectedInputs = (c: ImportCase): ReadonlyArray<string> => {
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

export type ImportFeature =
	| "an input bound to a variable"
	| "an input bound to an importer's parameter"
	| "an input bound to a literal"
	| "an input the binding leaves open"
	| "the import matched itself"
	| "an importer's parameter named as an import's"
	| "a parameterless importer of a parameterized import"

export const featuresOf = (
	c: ImportCase,
	inputs: ReadonlyArray<string>
): ReadonlyArray<ImportFeature> => {
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
