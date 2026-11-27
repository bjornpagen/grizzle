/** What the property of computed-import.test.ts reads: its box, each case's schema, and its judgement. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic, Num } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { opened } from "#test/support/open.ts"
import { owning } from "#test/support/policy.ts"

/** The term D matches the union's g at, of T's x: a sum or a conditional. */
const terms = ["a sum", "a conditional"] as const
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

/**
 * The case's schema: T(package, id, x) and U(package, id, g, w), keyed by package first, and S(pack, w), keyed by its
 * pack, immutable unless the case is probed, open then each inside the unit of its key's first field, so the
 * containment reads two units; Low, the union of U's rows of w at most 5 and of w above 9, an import of two rules read
 * whole; D, the w of each Low row of a T row's package whose g is the case's term of the T row's x; and D in S.
 */
const schemaOf = (c: Case) => {
	const T = relation("T", { package: pg.integer, id: pg.integer, x: pg.integer }, ["package", "id"])
	const U = relation("U", { package: pg.integer, id: pg.integer, g: pg.integer, w: pg.integer }, [
		"package",
		"id"
	])
	const S = relation("S", { pack: pg.integer, w: pg.integer }, ["pack", "w"])
	const Base = schema("computed_import", [T, U, S], c.judged === "probes" ? opened([T, U, S]) : [])
	const low = query(Base)
		.rule((r) => {
			const { package: unit, g, w } = v(U, "u")
			return r.match(U, { package: unit, g, w }).where(r.le(w, 5)).find({ package: unit, g, w })
		})
		.rule((r) => {
			const { package: unit, g, w } = v(U, "u")
			return r.match(U, { package: unit, g, w }).where(r.gt(w, 9)).find({ package: unit, g, w })
		})
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { package: unit, x } = v(T, "t")
			const { w } = v(low, "u")
			return r
				.match(T, { package: unit, x })
				.match(low, {
					package: unit,
					g: c.term === "a sum" ? Num.add(x, 1) : Logic.cond(Logic.le(x, 10), x, 0),
					w
				})
				.find({ package: unit, w })
		})
	)
	return schema.extend(
		[Base],
		"computed_import_1",
		[D],
		[contained(on(D, "package", "w"), on(S, "pack", "w"))]
	)
}

/** One case: the schema compiles to its installation, its judge's statements among it. */
export const judged = (c: Case, note: (f: Feature) => void): void => {
	const owned = owning(schemaOf(c))
	const installation = compileInstallation(owned, installOptions(owned))
	assert.ok(
		installation.ok,
		`a containment over a union matched at ${c.term} of another match's variable compiles: ${installation.ok ? "" : installation.error.message}`
	)
	assert.ok(
		Arr.every(
			installation.value.laws.rules,
			(r) => (r.rule.kind === "whole") === (c.judged === "whole")
		),
		`the containment is judged ${c.judged === "whole" ? "whole" : "by its probes"}`
	)
	note(c.term)
	note(`judged by ${c.judged}`)
}
