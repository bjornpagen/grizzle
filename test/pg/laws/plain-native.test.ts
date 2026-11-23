/**
 * A plain containment into a target a key holds apart is discharged natively, and its foreign key states the law
 * exactly (laws/model/plan.ts containmentDischarge): its referencing columns are its source's fields, each NOT NULL as
 * every column of a relation is, so MATCH SIMPLE checks every source row, and its referenced columns are its target's
 * fields under the UNIQUE of a declared key or of a superkey that key implies, so the rows it finds at a source row's
 * values are exactly the target's facts the law asks for. On PostgreSQL 19, over PlainNative
 * (plain-native.fixtures.ts): C contained in B at its primary key, in G at its declared key (g, j), in F at a superkey
 * and in E at its every field, every relation immutable and keyed by its unit g first, so each containment joins
 * within one unit, the shape 59de77629 judged whole where its target holds a field it does not reference.
 *
 * Each case writes up to six states, each in a transaction of its own that replaces the last: lawful ones, and ones a
 * change of a lawful state breaks, a target row dropped or changed under its source, or G's key broken by a repeated
 * value.
 *
 * Oracle: specification, the laws' meaning turned into a checker (plain-native.fixtures.ts brokenBy): every
 * containment is held by a foreign key and none by the judge, and a state commits exactly when it breaks no law, a
 * refused one under 23505 for G's key or 23503 for a containment it breaks, through the installation's constraint map.
 *
 * Features: a committed state, a refusal by each containment and by G's key, and a target row removed under its
 * source.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type PlainFeature,
	plainTemplate,
	runPlain,
	space
} from "#test/pg/laws/plain-native.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every plain containment into a target a key holds is its foreign key, which refuses exactly the states that break
 * it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aPlainContainmentIntoATargetAKeyHoldsIsItsForeignKeyWhichRefusesExactlyTheStatesThatBreakIt =
	property.explore(space, {
		needs: { plain: Substrate.fresh(plainTemplate) },
		situations: [
			"committed",
			"refused by a containment into a primary key",
			"refused by a containment into a declared key",
			"refused by a containment into a superkey",
			"refused by a containment into a target's every field",
			"refused by G's key",
			"a target row removed under its source"
		] satisfies ReadonlyArray<Reached<PlainFeature>>,
		check:
			({ plain }, c) =>
			(states) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* plain
					const session = yield* substrate.session({ ...ownerSession(), label: "writer" })
					yield* runPlain(value, session, states, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the laws' meaning: every containment a foreign key, and a state commits exactly when it breaks no law, refused otherwise under a law it breaks"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t(isPlain(d) && keyHolds(projected, d.to)) ||",
				replacement: "\t\tfalse ||",
				why: "A plain containment into a key of a unit-local target is the rule judge's, as 59de77629 judged one into a target with a field it does not reference: the containments into B, G and F are the judge's, not foreign keys; the property fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t: { columns: source, targetColumns: sideColumns(to) }",
				replacement: "\t\t\t: { columns: source, targetColumns: sideColumns(to).toReversed() }",
				why: "A foreign key meets its source's columns with its target's in the reverse order, so C's g is compared with B's i and its i with B's g: it refuses lawful states and admits broken ones; the property fails."
			}
		]
	})
