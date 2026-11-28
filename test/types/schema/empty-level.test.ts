/**
 * The empty level's types (test/types/schema/empty-level.ts): a read of no relation over schema.empty, and what roles
 * that hold all, or nothing, of the base make of it, beside reads over levels holding relations the role does not hold;
 * a cell typechecks exactly where the rule admits it. Each statement is a cell of the box; a batch's cells are one
 * program, checked disarmed. Oracle: the rule, stated per cell.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { emptyLevelBox } from "#test/types/schema/empty-level.dictionary.ts"
import { emptyLevelProgram } from "#test/types/schema/empty-level.ts"

/** Admits a read over the empty level on every role, and refuses a read over a level the role does not hold whole. */
export const emptyLevel = boxAgreement(finite(word(emptyLevelBox)), {
	box: "a read over the empty level served by a role holding nothing of the base and by one holding it whole, its rows committed by the first, one bound to a relation parameter of a read over the base, one a role's query entry, and one bound by a rule's parameters and matched by a rule over the first role, den's census, and over the base's extension, and reads of the base's relation over the base and over an extension of no relation of its own, served by the first and matched by a rule over it",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: emptyLevelProgram,
	oracle: {
		kind: "specification",
		name: "the empty level is the level below every root, which every role holds whole, and no other level is held without its relations"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\textends QueryBase, Phantom<{ readonly schema: Invariant<S> | Invariant<EmptyLevel> }> {}\n",
			replacement: "\textends QueryBase, Phantom<{ readonly schema: Invariant<S> }> {}\n",
			why: "A level's reader of queries admits its own level's alone, never a query over the empty level beside it, so the workloads, the commit and the role's query entry of a read over the empty level are refused, and their directive-free cells fail (K3)."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t\t? [SX] extends [EmptyLevel]\n\t\t\t? never\n\t\t\t: SX\n",
			replacement: "\t\t? SX\n",
			why: "A read over the empty level bound to a relation parameter raises the program it is bound in to the empty level, which is no level of the base nor the base of it, so the bind is refused (K4)."
		},
		{
			file: "packages/engine/src/types/schema/world.ts",
			original: "\t\t\t: [QuerySchema<V>] extends [EmptyLevel]\n",
			replacement: "\t\t\t: [QuerySchema<V>] extends [never]\n",
			why: "A role's query entry is held to the levels of its base alone, the empty level no level of it, so the query entry over the empty level is refused (K5)."
		},
		{
			file: "packages/engine/src/types/query/rule.ts",
			original: '\t\t: [B["schema" & keyof B]] extends [Invariant<EmptyLevel>]\n',
			replacement: '\t\t: [B["schema" & keyof B]] extends [never]\n',
			why: "A rule's match is held to the levels of its own level alone, the empty level no level of it (RequireLevel): its match of a read over the empty level bound by the rule's parameters is refused, \"the query is not over a level of this query's schema\", over a role and over a schema, metis's 296 refusals at each census of den's roots derived from their keys (K6)."
		},
		{
			file: "packages/engine/src/types/query/rule.ts",
			original: '\t\t: [B["schema" & keyof B]] extends [Invariant<EmptyLevel>]\n',
			replacement: '\t\t: [B["schema" & keyof B]] extends [unknown]\n',
			why: "A rule's match admits a source over any level (RequireLevel): a rule over a role holding nothing of the base matches a read of the base's relation, which its directive names refused (K7)."
		}
	]
})
