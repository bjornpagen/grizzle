/**
 * What a query that attaches nothing costs (query/budget/plain.ts): a one-rule query and a union of two rules, each
 * written 20 and 40 times over one schema, each program checked alone by one checker. A query's attachments are a
 * phantom of its type, which every query carries; a query that attaches nothing pays for it no more than the bound its
 * shape measured, and a union holds the attachments of the query it was built on, never its arms', which its records
 * never store.
 *
 * Properties: every program typechecks with no diagnostic, and each query the larger program adds costs at most its
 * shape's measured instantiations. Oracle: the compiler's own counts (test/types/batch/measured.ts), against the bound
 * measured when the phantom was cut (plain.ts addedAtMost).
 */
import { costGate } from "#test/types/batch/measured.ts"
import { plainQueries } from "#test/types/query/budget/plain.dictionary.ts"
import { plainCost, plainShapeName } from "#test/types/query/budget/plain.ts"

/** Each shape's added query costs at most its measured instantiations. */
export const cost = costGate(plainQueries, {
	box: "every shape of a query that attaches nothing",
	name: plainShapeName,
	measure: plainCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts, against each shape's measured bound"
	},
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\trule<Over, Head2, Ev2 extends Evidence, P2, IHead2, Hc2 extends Carriers, Cx2>(\n\t\tthis: OverSchema<Over>,\n\t\trule: (\n\t\t\tr: Rule<Over>\n\t\t) => Finished<Head2, Ev2, P2, Over, IHead2, Hc2, Cx2> &\n\t\t\tNoInfer<ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>>\n\t): Query<\n\t\tOver,\n\t\tHead | Head2,\n\t\tUnionEvidence<Ev, Ev2, Head, Head2>,\n\t\tP & P2,\n\t\tIHead | IHead2,\n\t\tUnionHeading<UnionArmsOf<Hc> | UnionArmsOf<Hc2>>,\n\t\tCx | Cx2,\n\t\treadonly [...Arms, ArmOf<Head2, Hc2>],\n\t\tAt\n\t>\n",
			replacement:
				"\trule<Over, Head2, Ev2 extends Evidence, P2, IHead2, Hc2 extends Carriers, Cx2, At2>(\n\t\tthis: OverSchema<Over>,\n\t\trule: (\n\t\t\tr: Rule<Over>\n\t\t) => Finished<Head2, Ev2, P2, Over, IHead2, Hc2, Cx2, At2> &\n\t\t\tNoInfer<ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>>\n\t): Query<\n\t\tOver,\n\t\tHead | Head2,\n\t\tUnionEvidence<Ev, Ev2, Head, Head2>,\n\t\tP & P2,\n\t\tIHead | IHead2,\n\t\tUnionHeading<UnionArmsOf<Hc> | UnionArmsOf<Hc2>>,\n\t\tCx | Cx2,\n\t\treadonly [...Arms, ArmOf<Head2, Hc2>],\n\t\tAt | At2\n\t>\n",
			why: "A union holds its arm's attachments beside the query's (`At | At2`), as before the cut: each union of two rules costs 16 more instantiations, 5,842 against its bound of 5,826."
		}
	]
})
