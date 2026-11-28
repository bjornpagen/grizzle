/**
 * schema(...), role(...) and the lookups by name at scale (schema/budget/generate.ts): the statement-scale program at
 * its largest size, beside its twin, the same declarations over the first and the last relation's neighbourhoods and
 * the first generated relation alone, each probe a cell of the program's box, checked disarmed beside the program at
 * scale and its twin, the batch's own lines.
 *
 * Properties: the program typechecks at scale, a role over every relation and one over a Pick of half of them read as
 * schemas among it; the head of a query over the last relation, the first's and the last's candidate keys, and a
 * generated relation's fact and addition are identical to the twin's; and a statement naming a relation no level
 * declares, a relation under another name and a role's entry of a stranger raise exactly the diagnostics, codes and
 * refusals, they raise over the twin. Oracle: the twin, a program at the smallest scale the probes read.
 */
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { statementProgram } from "#test/types/schema/budget/generate.ts"
import { statementProbes } from "#test/types/schema/budget/invariance.dictionary.ts"

/**
 * At scale, every probe infers what the twin infers, and refuses what the twin refuses, as the twin refuses it.
 */
export const invariance = boxAgreement(statementProbes, {
	box: "every probe of the 2,000-relation schema against its twin",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: statementProgram,
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
			why: "A schema's declared candidate keys (KeyIndexOf) are dropped once it holds a hundred statements, which the twin never does and the program at scale does: the first relation's candidate keys at 2,000 relations are not the twin's."
		}
	]
})
