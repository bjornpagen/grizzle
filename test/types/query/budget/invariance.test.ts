/**
 * The query facade's inference at scale (query/budget/generate.ts): the growing-schema program at its largest size,
 * beside its twin, the same declarations over the first and the last relation's neighbourhoods alone, each probe a cell
 * of the program's box, checked disarmed beside the program at scale and its twin, the batch's own lines.
 *
 * Properties: the program typechecks at scale; every parameter, head, evidence and key inferred at the first and the
 * last relation is identical to the twin's; and every refusal probe there, a get of a query not proved at most one row,
 * a parameter of another type and an order by a field one arm lacks, raises exactly the diagnostics, codes and
 * refusals, that it raises over the twin. Oracle: the twin, a program at the smallest scale the probes read.
 */
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { queryProgram } from "#test/support/types/query/budget/generate.ts"
import { queryProbes } from "#test/types/query/budget/invariance.dictionary.ts"

/**
 * At scale, every probe infers what the twin infers, and refuses what the twin refuses, as the twin refuses it.
 */
export const invariance = boxAgreement(queryProbes, {
	box: "every probe of the 200-relation query program against its twin",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: queryProgram,
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
