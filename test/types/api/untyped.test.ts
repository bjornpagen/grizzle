/**
 * A builder's list or record holding a member typed any (test/types/api/untyped.ts): over the box of every builder that
 * captures a list or a record, by every typing of what it captures, and the kept Object.values leak, a call is refused
 * exactly when a list or record it captures holds a member typed any, at the first argument that holds one, and every
 * other call is admitted with a schema's nestings kept. Each call is a cell of the box; a batch's cells are one
 * program, checked disarmed. Oracle: the box's own typing of each captured list and record.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { untypedBox } from "#test/types/api/untyped.dictionary.ts"
import { untypedProgram } from "#test/types/api/untyped.ts"

/**
 * Over every builder by every typing of the lists and records it captures, and the Object.values leak, refuses exactly
 * the calls holding a member typed any, at the first argument that holds one, and admits every other with a schema's
 * nestings kept.
 */
export const untyped = boxAgreement(finite(word(untypedBox)), {
	box: "every builder that captures a list or a record (schema, schema.extend, role, login, workload) by every typing of the lists and records it captures, and the Object.values leak",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: untypedProgram,
	oracle: { kind: "specification", name: "the box's own typing of each captured list and record" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original:
				'\t\t? Refusal<"a member typed any, which every check admits: type each member of the list or record">',
			replacement: "\t\t? unknown",
			why: "A member typed any is admitted (types/core/phantom.ts MembersTyped answers unknown for it); the program fails."
		},
		{
			file: "packages/engine/src/types/schema/world.ts",
			original:
				"type IsUntyped<R> = symbol extends keyof R ? (0 extends 1 & R ? true : false) : false",
			replacement: "type IsUntyped<R> = [R] extends [never] ? false : false",
			why: "A login's roles holding a member typed any are refused by its roles' verdict too (types/schema/world.ts RolesOver), and the two refusals, intersected, name neither: the login whose roles hold any carries no refusal of the member."
		}
	]
})
