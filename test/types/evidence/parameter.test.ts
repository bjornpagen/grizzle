/**
 * A child query a function builds over its parent's field (test/types/evidence/parameter.ts): the function takes the
 * field as an input term, `Term<Uuid, unknown, InputOrigin, "uuid">`, and over every schema and delivery of its box:
 *
 * - its child proves a delivery exactly where the same child written inline over the parent's own variable proves it,
 *   and raises the same refusal where it does not (a twin label for the two);
 * - an app's parent variable is taken by the function's parameter, and the app that attaches the function's query has
 *   the head of the app that writes it inline;
 * - a comment the function builds over the node's id, taken as an input term that an equality fixes the comment's key
 *   to, proves the option, as the same comment inline over an equality with the node's own variable does, and the two
 *   apps have one head; neither proves the one child, refused by its Refusal in both schemas, which the comment
 *   matched inline on the node's own variable proves where the schema proves existence (README, "grizzle knows each
 *   result's keys"): the deliveries that rest on the equality itself.
 *
 * Each schema and delivery is a cell of the box, and so is each schema's keyed comment; a batch's cells are one program,
 * checked disarmed. Oracle: the inline child, whose verdicts are the evidence's (an array always, an option over the key
 * the parent fixes, the one child where the schema proves existence). Not stated: a function generic over the field,
 * `<D extends Meets<Uuid, "uuid">>`, defers the equality's evidence until the call and proves neither option nor one, a
 * known limit of the types, which no contract promises either way.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { parameterBox } from "#test/types/evidence/parameter.dictionary.ts"
import { parameterProgram } from "#test/types/evidence/parameter.ts"

/** Proves each delivery exactly where the same child inline proves it, and keeps the inline app's head. */
export const parameter = boxAgreement(finite(word(parameterBox)), {
	box: "every schema of the probe (comments within the nodes, and one for every node) by every delivery (array, option, one), and each schema's comment keyed by an equality with the node's id",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: parameterProgram,
	oracle: {
		kind: "second-implementation",
		name: "the same child written inline over the parent's own variable"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: "type OriginNeeds<O, FixedFields extends string> = unknown extends O",
			replacement: "type OriginNeeds<O, FixedFields extends string> = [InputOrigin] extends [O]",
			why: "An equality with a bare input term (InputOrigin and no parent's origin) determines nothing (types/evidence/evidence.ts OriginNeeds reads it as lost), so the option of the comment the function builds over the node's id is refused where the inline one proves it; the program fails."
		}
	]
})
