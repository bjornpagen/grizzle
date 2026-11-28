/**
 * The matched sources' type cost against the schema they are over (query/budget/sources.ts): for each kind of source a
 * rule matches, a relation, a roster, a query over the schema and a derived relation over one, the program of `rules`
 * rules each matching a source of the kind and the program of twice as many, checked alone over a schema of `small`
 * relations and over one of `large`, as edullm's pantry matches its LOM vocabulary's queries rule after rule over a
 * schema of hundreds of relations (lom.ts PackageFact).
 *
 * Properties: instantiations per match are invariant in schema size. The rules the second program adds, its last
 * `rules` rules, cost exactly as many instantiations over the large schema as over the small one: I(large, 2k) −
 * I(large, k) = I(small, 2k) − I(small, k). Every source is matched in both programs, so what its first use reads once
 * cancels; a match whose rule's evidence holds the source, a query that holds its schema, costs more over the larger
 * schema, by every relation each later instantiation of the rule's types walks. A derived relation's type holds no
 * query (types/derived/derived.ts DefinitionView), so however its shown source is spelled, holding it holds nothing the
 * schema's size moves. And every program typechecks with no diagnostic. Oracle: the compiler's own counts and
 * diagnostics (test/support/types/batch/measured.ts), compared across the two schemas.
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { matchedSources } from "#test/types/query/budget/sources.dictionary.ts"
import { matchCost, sourceKindName } from "#test/types/query/budget/sources.ts"

/** Each kind's matches cost as many instantiations over the large schema as over the small one. */
export const cost = costGate(matchedSources, {
	box: "every kind of source a rule matches",
	name: sourceKindName,
	measure: matchCost,
	oracle: { kind: "universal", name: "the compiler's own counts, compared across the two schemas" },
	kills: [
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original:
				"\t\t\t\t\t\t: SourceShownOf<\n\t\t\t\t\t\t\t\tShownKeysOf<HeadingOf<R>, EvidenceKeys<R>>,\n\t\t\t\t\t\t\t\tHeadingFolds<HeadingOf<R>>,\n\t\t\t\t\t\t\t\tReadsOf<R>\n\t\t\t\t\t\t\t>",
			replacement:
				'\t\t\t\t\t\t: Shown<"source", never, ShownKeysOf<HeadingOf<R>, EvidenceKeys<R>>, HeadingFolds<HeadingOf<R>>, ReadsOf<R>>',
			why: "A query's shown source is written as a reference whose arguments read aliases over the query (ShownOf): the checker defers it, holding the query in its mapper, and each later instantiation of the rule's types instantiates the query again, its schema with it; the query matches' cost grows with the schema."
		}
	]
})
