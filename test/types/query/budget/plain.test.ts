/**
 * What a query that attaches nothing costs (query/budget/plain.ts): a one-rule query and a union of two rules, each
 * written 20 and 40 times over one schema, each program checked alone by one checker. A query's attachments are a
 * phantom of its type, which every query carries; a query that attaches nothing pays for it no more than the bound its
 * shape measured, and a union holds the attachments of the query it was built on, never its arms', which its records
 * never store.
 *
 * Properties: every program typechecks with no diagnostic, and each query the larger program adds costs at most its
 * shape's measured instantiations. Oracle: the compiler's own counts (test/support/types/batch/measured.ts), against the bound
 * measured when the phantom was cut (plain.ts addedAtMost).
 */
import { costGate } from "#test/support/types/batch/measured.ts"
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
				"\trule<Over, Head2, Ev2 extends InferredEvidence, P2, IHead2, Hc2 extends Carriers, Cx2>(\n\t\tthis: OverSchema<Over>,\n\t\trule: (\n\t\t\tr: Rule<Over>\n\t\t) => Finished<Head2, Ev2, P2, Over, IHead2, Hc2, Cx2> &\n\t\t\tNoInfer<ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>>\n\t): Query<\n\t\tOver,\n\t\tHead | Head2,\n\t\tUnionEvidence<Ev, Ev2, Head, Head2>,\n\t\tP & P2,\n\t\tIHead | IHead2,\n\t\tUnionHeading<UnionArmsOf<Hc> | UnionArmsOf<Hc2>>,\n\t\tCx | Cx2,\n\t\treadonly [...Arms, ArmOf<Head2, Hc2>],\n\t\tAt\n\t>\n",
			replacement:
				"\trule<Over, Head2, Ev2 extends InferredEvidence, P2, IHead2, Hc2 extends Carriers, Cx2, At2>(\n\t\tthis: OverSchema<Over>,\n\t\trule: (\n\t\t\tr: Rule<Over>\n\t\t) => Finished<Head2, Ev2, P2, Over, IHead2, Hc2, Cx2, At2> &\n\t\t\tNoInfer<ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>>\n\t): Query<\n\t\tOver,\n\t\tHead | Head2,\n\t\tUnionEvidence<Ev, Ev2, Head, Head2>,\n\t\tP & P2,\n\t\tIHead | IHead2,\n\t\tUnionHeading<UnionArmsOf<Hc> | UnionArmsOf<Hc2>>,\n\t\tCx | Cx2,\n\t\treadonly [...Arms, ArmOf<Head2, Hc2>],\n\t\tAt | At2\n\t>\n",
			why: "A union holds its arm's attachments beside the query's (`At | At2`), as before the cut: each union of two rules costs 16 more instantiations, 4,059 against its bound of 4,043."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"type BuilderRule = <S, Head, Ev extends InferredEvidence, P, IHead, Hc extends Carriers, Cx, At>(",
			replacement:
				"type BuilderRule = <S, Head, Ev extends Evidence, P, IHead, Hc extends Carriers, Cx, At>(",
			why: "A query's first rule holds the evidence it infers to Evidence whole, its optional members with it, so the checker reads every head field's origin at every find: a one-rule query costs 2,399 instantiations against its bound of 1,534."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"type Mismatched<X, All> = X extends unknown\n\t? | (false extends { [K in keyof X & keyof All]-?: MeetsEvery<X[K], All[K]> }[keyof X & keyof All]\n\t\t\t\t? true\n\t\t\t\t: false)\n\t\t| MismatchedApart<X, All, Exclude<keyof X, keyof All>>\n\t: never\n",
			replacement:
				"type Mismatched<X, All> = X extends unknown\n\t? All extends unknown\n\t\t? false extends { [K in keyof X & keyof All]-?: KeyMeets<X[K], All[K]> }[keyof X & keyof All]\n\t\t\t? true\n\t\t\t: false\n\t\t: never\n\t: never\n",
			why: "A union's further arm is met beside each arm before it, a mapped type of every field it shares with each (Mismatched pairwise), where it is met beside each carrier the arms deliver at a field once: a union of sixteen rules costs 58,474 instantiations against its bound of 55,160."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\tIHead = Head,\n\tin out Hc extends Carriers = HeadingCarriers<Head>,\n\tCx = never,\n\tAt = NoAttachments\n>\n\textends\n\t\tPhantom<{\n\t\t\treadonly headingInvariant: Invariant<Head>",
			replacement:
				"\tIHead = Head,\n\tHc extends Carriers = HeadingCarriers<Head>,\n\tCx = never,\n\tAt = NoAttachments\n>\n\textends\n\t\tPhantom<{\n\t\t\treadonly headingInvariant: Invariant<Head>",
			why: "Finished's carriers are left to the checker's measure, which attach's parent variables, a mapped type of Hc (ParentVars), leave unreliable, so each further arm of a union compares two Finished member by member, attach's signature instantiated at each, as the merged tree's slice B attach did (271ffecf2): a union of two rules costs 3,832 instantiations against its bound of 3,643."
		}
	]
})
