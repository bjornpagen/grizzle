/**
 * The type cost of a union's arms and of a ChangeSet's members read through one (query/budget/unions.ts): a union of
 * rules a further rule negates, as metis's reconciliation negates its mismatches (TS5115 at ConstantsAt over 24 rules,
 * G23), and a ChangeSet of inserts each matching a query bound to relation parameters over a six-rule union, as metis's
 * assign does (TS2590 over 25 inserts, TS2589 over 50, G27). Each program is checked alone at three sizes an equal
 * step apart, each step a whole number of its generator's period.
 *
 * Properties: every program typechecks with no diagnostic, a union of 144 rules among them, and each step adds types
 * and instantiations. A ChangeSet's
 * members grow no faster than linearly (incrementsDoNotGrow): a member reads its own parameters and adds its map to the
 * program's flat intersection, never a map rebuilt over the members before it. A union's arms grow no faster than
 * quadratically (test/support/growth.ts incrementsAtMostDouble): each arm is judged beside every arm before it, as the
 * checker judges every two arms of a union (check/checker.ts Checker.union), and the union's heading, values and keys
 * are read once over every arm, never a type over the union before it. Oracle: the compiler's own counts and
 * diagnostics (test/support/types/batch/measured.ts), compared step against step.
 */
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option } from "effect"
import { incrementsAtMostDouble } from "#test/support/growth.ts"
import type { PreludeAt } from "#test/support/prelude.ts"
import {
	assertClean,
	costGate,
	growthGate,
	measuredEach
} from "#test/support/types/batch/measured.ts"
import { boundMembers, unionArms } from "#test/types/query/budget/unions.dictionary.ts"

/** Each size of a ChangeSet's members typechecks, each step adding types and instantiations, no faster than linearly. */
export const members = growthGate(boundMembers, {
	box: "a ChangeSet's inserts over a bound union with relation parameters",
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "type JointParams<A, B> = A & ([keyof B] extends [never] ? unknown : B)",
			replacement:
				"type JointParams<A, B> = [keyof (A & B)] extends [never] ? unknown : Simplify<A & B>",
			why: "A ChangeSet's parameters are a map rebuilt over the map before it at each member (Simplify<A & B>): each key is read through every member before it, and a relation parameter's rows, an array or a Stream, met once per member, are a union of every choice of one or the other (TS2590, metis's assign at 25 inserts; TS2589 at 50)."
		}
	]
})

/**
 * Each size of a union's arms typechecks, each step adding types and instantiations, its instantiations growing no
 * faster than quadratically.
 */
export const arms = costGate(unionArms, {
	box: "a union of rules a further rule negates",
	name: (dimension) =>
		`${dimension.name} at ${Arr.join(
			Arr.map(dimension.steps.sizes, (n) => `${n}`),
			", "
		)}`,
	measure: (at, dimension) =>
		Effect.gen(function* () {
			const sizes = yield* measuredEach(
				at,
				Arr.map(dimension.steps.sizes, (size) => ({
					size,
					source: (entries: PreludeAt) => dimension.source(size, entries)
				}))
			)
			for (const s of sizes) {
				assertClean(s, dimension.name)
			}
			const instantiationsAt = (size: number): number =>
				defined(
					Option.getOrUndefined(Arr.findFirst(sizes, (m) => m.size === size)),
					`${dimension.name} is measured at ${size}`
				).instantiations
			incrementsAtMostDouble(instantiationsAt, dimension.steps.sizes[0], dimension.name)
		}),
	oracle: {
		kind: "universal",
		name: "the compiler's own counts and diagnostics, compared step against step"
	},
	kills: [
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original:
				"export type UnionArmsOf<H> = H extends UnionHeading<infer C> ? (unknown extends C ? H : C) : H",
			replacement: "export type UnionArmsOf<H> = H",
			why: "A union's heading holds the union heading before it as one arm (UnionArmsOf reads every heading as its own one arm): a read of a key of the last walks every union before it, a type over a type over each arm, which the checker refuses as circular (TS5115 at ConstantsAt, metis's 24 rules) or too deep."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original:
				"\t\t\t\t\tValuesBefore<Ev1> | ValuesOf<Ev2>,\n\t\t\t\t\tkeyof H2 & string,\n\t\t\t\t\treadonly [...Before, ArmOf<Ev2>]\n\t\t\t\t>\n\t\t\t: never\ntype ValuesOf<Ev> =",
			replacement:
				"\t\t\t\t\tValuesAfter<Ev1, Ev2>,\n\t\t\t\t\tkeyof H2 & string,\n\t\t\t\t\treadonly [...Before, ArmOf<Ev2>]\n\t\t\t\t>\n\t\t\t: never\ntype ValuesAfter<Ev1, Ev2> = ValuesBefore<Ev1> | ValuesOf<Ev2>\ntype ValuesOf<Ev> =",
			why: "A union's values are united by an alias over the evidence before them (ValuesAfter<Ev1, Ev2>): the union keeps the alias and its arguments, and the checker instantiates them with it, so each arm's values reach back through every union before it (TS2589 at 96 rules)."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\ttrue extends Mismatched<New, Old>",
			replacement: "\ttrue extends Mismatched<Old | New, Old | New>",
			why: "A further arm is judged with every two arms of the union again, not beside each arm before it: n arms judge n² pairs as the last joins, and the union's instantiations grow as n³."
		}
	]
})
