/**
 * A union's further arm is judged beside the arms before it at once (test/types/query/union-join.ts): an arm of one
 * heading that meets every arm before it is admitted, and an arm whose field meets none of them, whose field only some
 * of them deliver at another type, of another heading whose constant tells it from none of them, or attached beside
 * them in their heading, is refused at its own rule with the refusal the checker names (check/checker.ts
 * Checker.union), each judged after four arms. Each shape is a cell of the box; a batch's cells are one program,
 * checked disarmed. Oracle: the checker's refusals of each union, as the README states them.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { unionJoinBox } from "#test/types/query/union-join.dictionary.ts"
import { unionJoinProgram } from "#test/types/query/union-join.ts"

/** Each further arm is admitted or refused at its own rule as the checker unions it. */
export const unionJoin = boxAgreement(finite(word(unionJoinBox)), {
	box: "a union of four arms of one heading and a further arm: one that meets them, one whose field meets none, one whose field some deliver at another type, one of another heading told from none, one attached beside their heading",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: unionJoinProgram,
	oracle: {
		kind: "second-implementation",
		name: "the checker's refusals of each union (check/checker.ts Checker.union)"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"type OneKeySet<Old, New> = [KeyOfAnyArm<Old>] extends [keyof New]\n\t? [keyof New] extends [keyof Old]",
			replacement:
				"type OneKeySet<Old, New> = [KeyOfAnyArm<Old>] extends [KeyOfAnyArm<Old> | keyof New]\n\t? [keyof New | keyof Old] extends [keyof New | keyof Old]",
			why: "Every union is taken for one of one heading (OneKeySet), so arms of two headings are never told apart, and an arm whose constant tells it from no arm of another heading is admitted; the program fails."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				'type AttachedBeside<Old extends AnyArm, New extends AnyArm> = [\n\tOld["attached"] | New["attached"]\n] extends [never]',
			replacement:
				'type AttachedBeside<Old extends AnyArm, New extends AnyArm> = [Old["attached"]] extends [never]',
			why: "Whether any arm attaches is read off the arms before the further arm alone (AttachedBeside), so an attached arm whose heading they share is admitted; the program fails."
		}
	]
})
