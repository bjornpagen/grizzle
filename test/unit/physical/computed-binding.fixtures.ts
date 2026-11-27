/** What the property of computed-binding.test.ts reads: its box, each case's schema, and its judgement. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { keyTermText } from "#compiler/physical/indexes/engine.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic, Num, Text, Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Openable, opened } from "#test/support/open.ts"
import { owning } from "#test/support/policy.ts"

/** The term a step binds U's g to, of T's x: a sum, a conditional, or a bounded text's guarded cast. */
const terms = ["a sum", "a conditional", "a bounded text's guarded cast"] as const
/** How the rule is judged: whole over the units a transaction wrote (immutable relations), or by its probes. */
const judgements = ["whole", "probes"] as const

export interface Case {
	readonly term: (typeof terms)[number]
	readonly judged: (typeof judgements)[number]
}

export const caseGen: Gen<Case> = (s) => ({
	term: s.draw(element(terms)),
	judged: s.draw(element(judgements))
})

export type Feature = Case["term"] | `judged by ${Case["judged"]}`

/** Any text. */
const anyText = str.regex("^.*$", "su")

/** A text of at most 40 bytes, the cast's target, and one of at most 60, U's g: the cast's type is not g's. */
const short = str.bytes(40, anyText)
const wider = str.bytes(60, anyText)

/** A case's judgement as its schema's statements: every relation open, mutable inside the unit of its key's first field,
 * T's and U's package and S's pack, two units, where its probes judge the rule. */
const mutability = (c: Case, relations: ReadonlyArray<Openable<FieldBase>>) =>
	c.judged === "probes" ? opened(relations) : []

/**
 * Each term's schema: T(package, id, x) and U(package, id, g, w), keyed by package first, and S(pack, w); D, the w
 * of each U row of a T row's package whose g is the term of the T row's x; and D contained in S.
 */
const schemaOf = (c: Case) => {
	switch (c.term) {
		case "a sum": {
			const T = relation("T", { package: pg.integer, id: pg.integer, x: pg.integer }, [
				"package",
				"id"
			])
			const U = relation(
				"U",
				{ package: pg.integer, id: pg.integer, g: pg.integer, w: pg.integer },
				["package", "id"]
			)
			const S = relation("S", { pack: pg.integer, w: pg.integer }, ["pack", "w"])
			const Base = schema("computed_binding", [T, U, S], mutability(c, [T, U, S]))
			const D = derived(
				"D",
				query(Base).rule((r) => {
					const { package: unit, x } = v(T, "t")
					const { w } = v(U, "u")
					return r
						.match(T, { package: unit, x })
						.match(U, { package: unit, g: Num.add(x, 1), w })
						.find({ package: unit, w })
				})
			)
			return schema.extend(
				[Base],
				"computed_binding_1",
				[D],
				[contained(on(D, "package", "w"), on(S, "pack", "w"))]
			)
		}
		case "a conditional": {
			const T = relation("T", { package: pg.integer, id: pg.integer, x: pg.integer }, [
				"package",
				"id"
			])
			const U = relation(
				"U",
				{ package: pg.integer, id: pg.integer, g: pg.integer, w: pg.integer },
				["package", "id"]
			)
			const S = relation("S", { pack: pg.integer, w: pg.integer }, ["pack", "w"])
			const Base = schema("computed_binding", [T, U, S], mutability(c, [T, U, S]))
			const D = derived(
				"D",
				query(Base).rule((r) => {
					const { package: unit, x } = v(T, "t")
					const { w } = v(U, "u")
					return r
						.match(T, { package: unit, x })
						.match(U, { package: unit, g: Logic.cond(Logic.le(x, 10), x, 0), w })
						.find({ package: unit, w })
				})
			)
			return schema.extend(
				[Base],
				"computed_binding_1",
				[D],
				[contained(on(D, "package", "w"), on(S, "pack", "w"))]
			)
		}
		case "a bounded text's guarded cast": {
			const T = relation("T", { package: pg.integer, id: pg.integer, x: anyText }, [
				"package",
				"id"
			])
			const U = relation("U", { package: pg.integer, id: pg.integer, g: wider, w: pg.integer }, [
				"package",
				"id"
			])
			const S = relation("S", { pack: pg.integer, w: pg.integer }, ["pack", "w"])
			const Base = schema("computed_binding", [T, U, S], mutability(c, [T, U, S]))
			const D = derived(
				"D",
				query(Base).rule((r) => {
					const { package: unit, x } = v(T, "t")
					const { w } = v(U, "u")
					return r
						.match(T, { package: unit, x })
						.match(U, {
							package: unit,
							g: Logic.when(
								Num.within(Text.octetLength(x), 0, 40),
								() => Type.cast(x, short),
								Type.literal(short, "")
							),
							w
						})
						.find({ package: unit, w })
				})
			)
			return schema.extend(
				[Base],
				"computed_binding_1",
				[D],
				[contained(on(D, "package", "w"), on(S, "pack", "w"))]
			)
		}
	}
}

/**
 * One case: the installation plans an index of U whose keys are exactly package and g, the columns the step that reads
 * U binds, g to the term of the channel it passes T's x in by; a whole rule's led by its unit's key, package.
 */
export const judged = (c: Case, note: (f: Feature) => void): void => {
	const owned = owning(schemaOf(c))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	assert.ok(
		Arr.every(installation.laws.rules, (r) => (r.rule.kind === "whole") === (c.judged === "whole")),
		`the containment is judged ${c.judged === "whole" ? "whole" : "by its probes"}`
	)
	const serving = Arr.filter(
		installation.indexes,
		(index) =>
			index.relation === "U" &&
			index.method === "btree" &&
			Arr.join(
				Arr.sort(
					Arr.map(index.keys, (k) => keyTermText(k.column)),
					Order.String
				),
				","
			) === "g,package"
	)
	const [first] = serving
	if (first === undefined) {
		return assert.fail(
			`U is read by (package, g), g bound to ${c.term} of T's x, so an index of exactly those columns serves it`
		)
	}
	if (c.judged === "whole") {
		assert.equal(
			keyTermText(defined(first.keys[0], "an index's first key").column),
			"package",
			"a whole rule's index leads with its unit's key"
		)
	}
	note(c.term)
	note(`judged by ${c.judged}`)
}
