/**
 * A generated field with no value refuses its write as one outcome, `invariant-rejected` on the field's law
 * (analysis/theory/description.ts generatedLaw) witnessed by the key of the first stated row whose term has no value,
 * whatever the write's shape and whoever finds the NULL: the nesting's walk, which evaluates every generated field of
 * each row it fills (runtime/write/fill.ts `filler`); or PostgreSQL, whose NOT NULL refuses a row whose field no fill
 * reads (23502), a family's edit's among them, which its additions statement draws in SQL, judged by the host as the
 * shell judges it (runtime/write/witness.ts hostJudgement).
 *
 * The schema is an ordered family of members, each of a kind whose weight a closed relation gives, a generated field
 * that is NULL at the kind the relation lacks. One fold sums the members' quantities over a selection, another sums
 * their weights. A case is one family, written two ways through bindWrite: an owner inserted with its members nested,
 * and an owner inserted with none beside its members put one by one, which the edit appends in order. A write the host
 * binds is planned over reads that find nothing stored; where one of its rows has a missing weight, PostgreSQL's NOT
 * NULL refuses the family statement that writes them, and the outcome is the host's judgement of that statement.
 *
 * The oracle, the specification: a write with a member of a missing weight is `invariant-rejected` on Member.w's law,
 * witnessed by the first such member's id, whichever path wrote it; every other write is accepted.
 *
 * Bound: every selection (none, the weight alone, the quantity and the weight), with and without the weight fold, over
 * every family of up to three members, each of three kinds and two quantities.
 *
 * Features: each selection, the weight fold or not, a missing weight at each place a fill reads it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	accepted,
	caseGen,
	type Outcome,
	outcomeOn,
	pathsAt,
	shapeOf,
	type StopSituation,
	weightLaw,
	weightRead
} from "#test/unit/write/fill-stop.fixtures.ts"

/** A generated field with no value refuses its write on the field's law, witnessed by the first such member, whether the nesting, an edit or PostgreSQL finds it. */
export const aGeneratedFieldWithNoValueRefusesItsWriteOnTheFieldsLawWitnessedByTheFirstSuchMemberWhetherTheNestingAnEditOrPostgreSQLFindsIt =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"refused: an edit's fill reads the first missing weight",
			"refused: a missing weight no fill reads",
			"refused: a missing weight no fill reads before one a fill reads",
			"accepted"
		] satisfies ReadonlyArray<Reached<StopSituation>>,
		check: (_, k: Case<StopSituation>) => (c) =>
			Effect.gen(function* () {
				const paths = pathsAt(c.selection, c.weighed)
				const missing = Arr.findFirstIndex(c.members, (m) => m.kind === "unweighed")
				const specified: Outcome = Option.match(missing, {
					onNone: () => accepted,
					onSome: (i) => ({
						kind: "invariant-rejected",
						law: weightLaw,
						witness: { kind: "key", relation: "Member", values: { id: uuidOf(i + 1) } }
					})
				})
				const nested = yield* outcomeOn(
					paths.nested,
					shapeOf(paths, "nested", c.members),
					Option.isSome(missing)
				)
				const edited = yield* outcomeOn(
					paths.edited,
					shapeOf(paths, "edited", c.members),
					Option.isSome(missing)
				)
				assert.deepEqual(nested, specified, "the nested insert's outcome")
				assert.deepEqual(edited, specified, "the edit's outcome")
				const unweighed = Arr.filter(c.members, (m) => m.kind === "unweighed")
				const [first] = unweighed
				if (first === undefined) {
					k.note("accepted")
					return
				}
				k.note(
					weightRead(c, first)
						? "refused: an edit's fill reads the first missing weight"
						: "refused: a missing weight no fill reads"
				)
				if (!weightRead(c, first) && Arr.some(unweighed, (m) => weightRead(c, m))) {
					k.note("refused: a missing weight no fill reads before one a fill reads")
				}
			}),
		oracle: {
			kind: "specification",
			name: "invariant-rejected on Member.w's law, witnessed by the first member of a missing weight, on every path"
		},
		box: "every selection of the quantity fold, with and without the weight fold, over every family of up to three members, each of three kinds and two quantities",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original: '\t\t\treturn { _tag: "GeneratedNull", law: stop.law }',
				replacement: '\t\t\treturn encodeFailure("integerRange", place)',
				why: "A generated field with no value at a row a fill reads is refused as integerRange (runtime/write/fill.ts fillRefusal), not invariant-rejected on its law."
			}
		]
	})
