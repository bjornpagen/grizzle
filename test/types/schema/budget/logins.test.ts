/**
 * A login, its workloads and a ChangeSet over its role, over a schema of qti-pie's size and shape, at scale
 * (schema/budget/logins.ts).
 *
 * Property: the login-scale program, checked alone at three relation counts an equal step apart, each step a whole
 * number of its modules, the largest past qti-pie's 370 relations by more than half again, typechecks with no
 * diagnostic, no expression of it past TypeScript's 5,000,000 instantiations, and its types and instantiations grow
 * no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow): the second step adds no more than the
 * first, so the role, the login and the ChangeSet over the role cost no more per relation at a larger schema. Oracle:
 * the compiler's own counts, compared step against step.
 *
 * Plant (~/.cache/grizzle-release/TYPEREGRESS/plants): declared-as-clause.patch restores c614875c's Declared, a level's
 * record keyed by an `as NameOf<X>` clause, which the checker instantiates over every relation of the level at each
 * lookup by name and each keyof (qti-pie's TS2589 at its author login): the program's increments grow, 2.45M then
 * 3.41M instantiations a step, where they are equal.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assertClean, assertGrowthLaw, measuredSizes } from "#test/types/batch/measured.ts"
import { generateLoginSource, loginSizes } from "#test/types/schema/budget/logins.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the login-scale schema", (it) => {
	it.effect(
		`typechecks a login, its workloads and a ChangeSet over its role at ${Arr.join(
			Arr.map(loginSizes.sizes, (n) => `${n}`),
			", "
		)} relations listed by module, with no diagnostic, its types and instantiations growing no faster than linearly`,
		() =>
			Effect.gen(function* () {
				const sizes = yield* measuredSizes("test/types/schema", loginSizes, generateLoginSource)
				for (const s of sizes) {
					assertClean(s, "the login-scale schema")
				}
				assertGrowthLaw("the login-scale schema", loginSizes, sizes)
			})
	)
})
