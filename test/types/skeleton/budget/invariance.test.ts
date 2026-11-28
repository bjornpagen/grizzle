/**
 * Write inference at scale (skeleton/budget/generate.ts): the growing-schema ChangeSet program at its largest size,
 * beside its twin, the same declarations over the first and the last relation's neighbourhoods alone, each probe a cell
 * of the program's box, checked disarmed beside the program at scale and its twin, the batch's own lines.
 *
 * Properties: the program typechecks at scale, every ChangeSet applied through its workload's handle; the head a
 * contract host reaches, a relation's fact and candidate keys, and the relations a ChangeSet writes, at the first and
 * the last relation, are identical to the twin's; and a ChangeSet in a workload over a role that does not write its
 * relation, and a query's rows inserted into another relation, raise exactly the diagnostics, codes and refusals, they
 * raise over the twin. Oracle: the twin, a program at the smallest scale the probes read.
 */
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { skeletonProgram } from "#test/types/skeleton/budget/generate.ts"
import { skeletonProbes } from "#test/types/skeleton/budget/invariance.dictionary.ts"

/**
 * At scale, every probe infers what the twin infers, and refuses what the twin refuses, as the twin refuses it.
 */
export const invariance = boxAgreement(skeletonProbes, {
	box: "every probe of the 200-relation ChangeSet program against its twin",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: skeletonProgram,
	oracle: {
		kind: "second-implementation",
		name: "the twin, the same declarations at the smallest scale the probes read"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"type KeyIndexOf<S> = {\n\treadonly [K in KeySideOf<StatementOf<S>> as NameOf<SourceOf<K>>]: TermsOf<K>\n} & { readonly [name: string]: never }",
			replacement:
				"type KeyIndexOf<S> =\n\tStatementsOf<S> extends { readonly 99: unknown }\n\t\t? { readonly [name: string]: never }\n\t\t: {\n\t\t\t\treadonly [K in KeySideOf<StatementOf<S>> as NameOf<SourceOf<K>>]: TermsOf<K>\n\t\t\t} & { readonly [name: string]: never }",
			why: "A schema's declared candidate keys (KeyIndexOf) are dropped once it holds a hundred statements, which the twin never does and the program at scale does; the invariance property fails."
		}
	]
})
