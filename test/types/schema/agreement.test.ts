import { Array as Arr } from "effect"
import {
	keptFaultCase,
	schemaCases,
	schemaProgram,
	schemaRequired
} from "#test/support/agreement/schemas.ts"
import { agreement, boxAgreement } from "#test/types/batch/agreement.ts"
/**
 * The schema agreement (test/support/agreement/schemas.ts), a program a batch checks disarmed, each case a module of
 * its own: over drawn schemas and probes, the types infer what the engine describes, each field's host, fact and keys,
 * and refuse exactly what it refuses, naming its refusal. Oracle: the engine's description of each drawn schema. The
 * witnesses reach every construct, every fault and every refusal it names. Beside it, the kept faults no drawn probe
 * plants, each alone on one base.
 */
import { schemaKeptBox } from "#test/types/schema/agreement.dictionary.ts"

/**
 * Over drawn schemas and probes, the types infer what the engine describes and refuse exactly what it refuses.
 */
export const schemas = agreement(schemaCases, {
	situations: schemaRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: schemaProgram,
	oracle: { kind: "second-implementation", name: "the engine's description of each drawn schema" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "\t\t\t: true extends SameAs<UnderName<Relations, NameStated<R>>, R>",
			replacement: "\t\t\t: NameStated<R> extends keyof Relations",
			why: "A statement's relation is admitted wherever the schema holds a relation of its name, the relation held under another name among them (types/schema/schema.ts Undeclared); the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"\treadonly statements: readonly [...StatementsBelow<Base>, ...StatementsFromNames<Named, Relations>]",
			replacement:
				'\treadonly statements: readonly [\n\t\t...StatementsBelow<Base>,\n\t\t...StatementsFromNames<Named, Relations>,\n\t\t...ReadonlyArray<Fragments["statements"][number]>\n\t]',
			why: "A level's statements are an open tuple again, its fragments' statements spread as ReadonlyArray after its own (types/schema/schema.ts), so every drawn schema's StatementsOf is no longer the tuple its calls wrote; the agreement's program fails."
		},
		{
			file: "packages/engine/src/analysis/theory/families.ts",
			original:
				'\tconst parent = drawnOfTree(fieldTerm(t, parentTerm, "a tree\'s side", loc))\n\tconst at = drawnOfTree(fieldTerm(t, atTerm, "a tree\'s side", loc))',
			replacement:
				'\tconst parent = drawnField(t, fieldTerm(t, parentTerm, "a tree\'s side", loc), "parent", loc)\n\tconst at = drawnField(t, fieldTerm(t, atTerm, "a tree\'s side", loc), "index", loc)',
			why: "A tree's parent and index go back on the generic family check (analysis/theory/families.ts treeShape), so the engine refuses a caller's parent or index as MalformedDescription where the types name the tree's shape; the treeSideWritten probe fails placement."
		}
	]
})

/**
 * Each kept fault, a side over a selection by counted, ordered and tree, on the base the agreement's floor first drew:
 * the types refuse exactly what the engine refuses.
 */
export const keptFaults = boxAgreement(schemaKeptBox, {
	box: "every kept fault, each alone on one base",
	situations: [],
	notes: (fault) => keptFaultCase(fault).notes,
	checking: "disarmed",
	program: (faults, entry) => schemaProgram(Arr.map(faults, keptFaultCase), entry),
	oracle: { kind: "second-implementation", name: "the engine's description of the kept base" },
	kept: [],
	kills: []
})
