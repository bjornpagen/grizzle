/** What generated-subset.test.ts reads: its roster, its variants, its box of generations and what each one proves. */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Result } from "effect"
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import { type ClosedIdField, closedId, generated, pg, variant } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"

/** The roster's handles, in its order. */
const handles = ["p", "q", "r", "s"] as const

/** A handle of the roster. */
export type Handle = (typeof handles)[number]

/** The roster every closed id of the box is of. */
const Mark = closed.ordered("Mark", handles)

/** A variant over the subset p, q of Mark: its tag is a closed id of p and q. */
const V = variant("V", Mark, { p: {}, q: { n: pg.integer } })

/** A variant whose arm p holds a closed id of the subset p, which its domain's CHECK holds to p's code. */
const W = variant("W", Mark, { p: { c: closedId(Mark, { only: ["p"] }) }, q: {} })

/** The subsets a generated column of the box is declared over: p alone, p and q, and every handle. */
const columns = ["p", "pq", "every"] as const

export type Column = (typeof columns)[number]

/** The handles each column holds. */
export const heldBy: { readonly [C in Column]: ReadonlyArray<Handle> } = {
	p: ["p"],
	pq: ["p", "q"],
	every: handles
}

/** A column's descriptor. */
const columnField = (c: Column): ClosedIdField<typeof Mark, Handle> => {
	switch (c) {
		case "p":
			return closedId(Mark, { only: ["p"] })
		case "pq":
			return closedId(Mark, { only: ["p", "q"] })
		case "every":
			return closedId(Mark)
	}
}

/**
 * A generation of a closed id over T's written fields: `src`, a closed id of p, `full`, one of every handle, `v` of V
 * and `w` of W, and `k`, an integer:
 * - `tag`: V's tag, a closed id of its arms' handles;
 * - `copy`: src itself;
 * - `cond`, `when` and `cases`: src, or `handle` where a conditional, a guard's otherwise or a case of W's other arm
 *   takes it, a bare literal branch;
 * - `named`: Mark.handle(handle), a closed id of the roster;
 * - `cast`: full cast into the column's own type.
 */
export type Generation =
	| { readonly kind: "tag" | "copy" | "cast" }
	| { readonly kind: "cond" | "when" | "cases" | "named"; readonly handle: Handle }

/**
 * A value of W made by a generation, its arm p's field `c` a literal handle, src, or full: a field of a subset takes a
 * value of that subset alone.
 */
export type Made =
	| { readonly kind: "literal"; readonly handle: Handle }
	| { readonly kind: "src" | "full" }

/** A case: a generation into a column, a key's field or not, or a made value of W. */
export type GeneratedCase =
	| {
			readonly door: "closedId"
			readonly generation: Generation
			readonly column: Column
			readonly keyed: boolean
	  }
	| { readonly door: "made"; readonly made: Made }

const handle: Gen<Handle> = element(handles)

/** A generation: each kind, a literal branch's kind at each handle. */
const generationGen: Gen<Generation> = oneOf<Generation>([
	map(element(["tag", "copy", "cast"] as const), (kind) => ({ kind })),
	(s) => ({
		kind: s.draw(element(["cond", "when", "cases", "named"] as const)),
		handle: s.draw(handle)
	})
])

/** A made value's field: a literal at each handle, src, or full. */
const madeGen: Gen<Made> = oneOf<Made>([
	map(handle, (h) => ({ kind: "literal", handle: h })),
	map(element(["src", "full"] as const), (kind) => ({ kind }))
])

/** The box: every generation into every column, a key's field and not, and every made value. */
export const generatedCases: Gen<GeneratedCase> = oneOf<GeneratedCase>([
	(s) => ({
		door: "closedId",
		generation: s.draw(generationGen),
		column: s.draw(element(columns)),
		keyed: s.draw(boolean)
	}),
	map(madeGen, (made) => ({ door: "made", made }))
])

/**
 * The handles a generation's value can be, as the specification reads it apart from the engine: V's arms', src's, a
 * conditional's branches' together, and every handle for a named handle, whose type is the roster's; none for a cast,
 * which holds its column's own handles where it narrows none and is refused where it does.
 */
export const canBe = (g: Generation): ReadonlyArray<Handle> | undefined => {
	switch (g.kind) {
		case "tag":
			return ["p", "q"]
		case "copy":
			return ["p"]
		case "cond":
		case "when":
		case "cases": {
			const branches: ReadonlyArray<Handle> = ["p", g.handle]
			return Arr.dedupe(branches)
		}
		case "named":
			return handles
		case "cast":
			return undefined
	}
}

/** What a case's schema installs: its CHECKs of a closed id subset by field, or the refusal of its compile. */
export type Installed =
	| { readonly kind: "installed"; readonly subsetChecks: (field: string) => number }
	| { readonly kind: "refused"; readonly error: CompileError }

/** The schema of a case's relation T, compiled as `grizzle generate` compiles it, or its refusal. */
const installedOf = (build: () => unknown): Installed => {
	const outcome = Result.try({
		try: () => {
			const desc = defined(schemaDescOf(build()), "the case's description")
			const owned = own(desc)
			if (!owned.ok) {
				throw owned.error
			}
			const codes = firstCodebook(rostersOf(owned.value))
			const installation = compileInstallation(
				owned.value,
				completeInstallOptions(
					owned.value,
					[identity.schema(parsedSchemaName("generated"))],
					[],
					[],
					codes
				)
			)
			if (!installation.ok) {
				throw installation.error
			}
			return installation.value
		},
		catch: (thrown) => thrown
	})
	if (Result.isFailure(outcome)) {
		const thrown = outcome.failure
		if (!isCompileError(thrown)) {
			throw thrown
		}
		return { kind: "refused", error: thrown }
	}
	const tables = Arr.flatMap(outcome.success.manifest.objects, (o) =>
		o.kind === "table"
			? Arr.flatMap(o.ddl, (statement) => (statement.kind === "createTable" ? [statement] : []))
			: []
	)
	return {
		kind: "installed",
		subsetChecks: (field) => {
			const name = identifierOf(identity.subsetCheck("T", field))
			return Arr.flatMap(tables, (t) =>
				Arr.filter(t.secondary, (c) => c.kind === "check" && c.name === name)
			).length
		}
	}
}

/** The installation of a case: T of the written fields, its generated field `g` the case's. */
export const installedCase = (c: GeneratedCase): Installed => {
	const written = {
		k: pg.integer,
		src: closedId(Mark, { only: ["p"] }),
		full: closedId(Mark),
		v: V,
		w: W
	}
	if (c.door === "made") {
		const made = c.made
		return installedOf(() =>
			schema(
				"Generated",
				[
					Mark,
					relation.generated("T", written, ["k"], (r) => ({
						g: generated(
							W,
							W.make("p", {
								c: made.kind === "literal" ? made.handle : made.kind === "src" ? r.src : r.full
							})
						)
					}))
				],
				[]
			)
		)
	}
	const { generation: g, column, keyed } = c
	const field = columnField(column)
	return installedOf(() =>
		schema(
			"Generated",
			[
				Mark,
				relation.generated("T", written, keyed ? ["k", "g"] : ["k"], (r) => {
					switch (g.kind) {
						case "tag":
							return { g: generated(field, V.tag(r.v)) }
						case "copy":
							return { g: generated(field, r.src) }
						case "cond":
							return { g: generated(field, Logic.cond(Logic.eq(r.k, 1), r.src, g.handle)) }
						case "when":
							return {
								g: generated(
									field,
									Logic.when(Num.nonzero(r.k), () => r.src, g.handle)
								)
							}
						case "cases":
							return { g: generated(field, W.cases(r.w, { p: (a) => a.c, q: () => g.handle })) }
						case "named":
							return { g: generated(field, Mark.handle(g.handle)) }
						case "cast":
							return { g: generated(field, Type.cast(r.full, field)) }
					}
				})
			],
			[]
		)
	)
}

/** Whether every handle of `values` is one of `held`'s. */
export const within = (values: ReadonlyArray<Handle>, held: ReadonlyArray<Handle>): boolean =>
	Arr.every(values, (h) => held.includes(h))

/** A made value's field c, of the subset p, takes p alone: a literal p, or src, of p. */
export const madeHolds = (m: Made): boolean =>
	m.kind === "src" || (m.kind === "literal" && m.handle === "p")
