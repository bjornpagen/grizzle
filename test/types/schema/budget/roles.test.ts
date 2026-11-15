/**
 * A role's type cost against the base its level extends (schema/budget/roles.ts): the derived relations of the level
 * a full role is over, and the laws over them, each program checked alone over a base of `small` relations and over
 * one of `large`, with a full role over the level and its readers, and without them, its control, as edullm's pantry
 * opens its author role over Qti, a level of derived relations over QtiBase.
 *
 * Properties: instantiations per derived relation of the role's level, and per law over a derived relation, are
 * invariant in the size of the base. The role and its readers add exactly as many instantiations to the program over
 * twice as many derived relations, or twice as many laws, over the large base as over the small one: (R − C)(large, 2k)
 * − (R − C)(large, k) = (R − C)(small, 2k) − (R − C)(small, k), R the program with the role and C its control. The role
 * holds no derived relation (each a live view), and keeps no law over one, but its type reads every relation of its
 * level and every law: which it holds (FullBaseOf, UnheldOf) and which it keeps (KeptStatements). A derived relation
 * holds its definition, a query over the base, so a test of it, or of a statement naming it, that the checker
 * instantiates whole costs more over the larger base, by every relation it walks, for each relation or law the second
 * program adds. The control pays what using the level costs anywhere (roles.ts), so the difference is the role's. And
 * every program typechecks with no diagnostic. Oracle: the compiler's own counts and diagnostics
 * (test/types/batch/measured.ts), compared across the two bases.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import type { PreludeAt } from "#test/support/prelude.ts"
import { assertClean, measuredEach } from "#test/types/batch/measured.ts"
import { type RoleShape, roleProgram } from "#test/types/schema/budget/roles.ts"

/**
 * The derived relations or laws of the first program, and the bases' sizes. The second program has twice as many; the
 * small base holds twice as many relations as the most derived relations, each of them over one of its own, and the
 * large one four times as many as the small, so a derived relation or a law that walks the base walks every relation
 * the large base adds, three for each of the small one's, for each relation or law the second program adds.
 */
const added = 5
const derived = 2 * added
const small = 2 * derived
const large = 4 * small

/** What one law measures: the shape of its first program over the base of `relations`, and of its second. */
type Dimension = {
	readonly what: string
	readonly shape: (relations: number, count: number, role: boolean) => RoleShape
}

const dimensions: ReadonlyArray<Dimension> = [
	{
		what: "derived relation of the role's level, with a key over it",
		shape: (relations, count, role) => ({ relations, derived: count, laws: 0, role })
	},
	{
		what: "law over a derived relation of the role's level",
		shape: (relations, count, role) => ({ relations, derived, laws: count, role })
	}
]

/** The eight programs of one dimension, in order: `added` and twice as many, over each base, with the role and without. */
const shapes = Arr.flatMap([true, false], (role) =>
	Arr.map(
		[
			{ relations: small, count: added },
			{ relations: small, count: 2 * added },
			{ relations: large, count: added },
			{ relations: large, count: 2 * added }
		] as const,
		(at) => ({ ...at, role })
	)
)

layer(NodeServices.layer, { excludeTestServices: true })("the role programs", (it) => {
	for (const dimension of dimensions) {
		it.effect(
			`a full role costs as many instantiations for each ${dimension.what} over ${large} base relations as over ${small}`,
			() =>
				Effect.gen(function* () {
					const measured = yield* measuredEach(
						"test/types/schema",
						Arr.map(shapes, (at) => ({
							size: at.relations,
							source: (entries: PreludeAt) =>
								roleProgram(dimension.shape(at.relations, at.count, at.role), entries)
						}))
					)
					for (const m of measured) {
						assertClean(m, `the role program of each ${dimension.what}`)
					}
					const count = (i: number): number =>
						defined(measured[i], `the program of each ${dimension.what} at ${i}`).instantiations
					const role = (i: number): number => count(i) - count(i + 4)
					const step = { small: role(1) - role(0), large: role(3) - role(2) }
					assert.equal(
						step.large,
						step.small,
						`the role adds ${step.large} instantiations for the last ${added} of each ${dimension.what} over ${large} base relations and ${step.small} over ${small}`
					)
				})
		)
	}
})
