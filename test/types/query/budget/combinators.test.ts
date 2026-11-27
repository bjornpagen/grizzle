/**
 * The type cost of the combinators a query is written with beyond its first rule, against the schema it is over
 * (query/budget/combinators.ts): for each, a union's further arm, a rule matching a query bound to its relation
 * parameter, an order and its take, a name, an attachment of a query and an attachment of an arm, the program of
 * `queries` queries each built by it and the program of twice as many, checked alone over a schema of `small` relations
 * and over one of `large`, as edullm's ledger writes its grading statement, union arm after union arm, each matching a
 * query bound to the call's relation parameter, over a level of hundreds of relations (packages/ledger/src/grade.ts).
 *
 * Properties: instantiations per combinator are invariant in schema size. The queries the second program adds, its last
 * `queries` queries, cost exactly as many instantiations over the large schema as over the small one: I(large, 2k) −
 * I(large, k) = I(small, 2k) − I(small, k). A member of a query, an ordered query or a finished arm whose signature names
 * the interface's schema walks it at every call, every relation of it and each relation's field record, so its queries
 * cost more over the larger schema; one that reads its schema off the phantom it is called on (types/query/query.ts
 * OverSchema) costs what it does over any schema. And every program typechecks with no diagnostic. Oracle: the
 * compiler's own counts and diagnostics (test/types/batch/measured.ts), compared across the two schemas.
 */
import { costGate } from "#test/types/batch/measured.ts"
import { combinatorKinds } from "#test/types/query/budget/combinators.dictionary.ts"
import { combinatorCost, combinatorName } from "#test/types/query/budget/combinators.ts"

/** Each combinator's queries cost as many instantiations over the large schema as over the small one. */
export const cost = costGate(combinatorKinds, {
	box: "every combinator a query is written with beyond its first rule",
	name: combinatorName,
	measure: combinatorCost,
	oracle: { kind: "universal", name: "the compiler's own counts, compared across the two schemas" },
	kills: [
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\trule<Over, Head2, Ev2 extends InferredEvidence, P2, IHead2, Hc2 extends Carriers, Cx2>(\n\t\tthis: OverSchema<Over>,\n\t\trule: (\n\t\t\tr: Rule<Over>\n\t\t) => Finished<Head2, Ev2, P2, Over, IHead2, Hc2, Cx2> &\n\t\t\tNoInfer<ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>>\n\t): Query<\n\t\tOver,",
			replacement:
				"\trule<Head2, Ev2 extends InferredEvidence, P2, IHead2, Hc2 extends Carriers, Cx2>(\n\t\trule: (\n\t\t\tr: Rule<S>\n\t\t) => Finished<Head2, Ev2, P2, S, IHead2, Hc2, Cx2> &\n\t\t\tNoInfer<ArmsMeet<Arms, Head, ArmOf<Head2, Hc2>>>\n\t): Query<\n\t\tS,",
			why: "A union's further arm (Query.rule) names the interface's schema, S, in its signature, so each call walks the schema, every relation of it and each relation's field record: an arm cost 1,404 more instantiations over 120 relations than over 3 (PERF-TYPES micro, union of two rules), and edullm's ledger, union arm after union arm over the Delivery level, 85.3M instantiations where it costs 45.6M."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\tbind<Over, const B extends BindingsFor<P>>(\n\t\tthis: OverSchema<Over>,\n\t\tbindings: B & NoStrayParameters<B, P> & RelationBindings<B, P, Over>\n\t): BoundSource<\n\t\tBoundOver<Over, B, P>,",
			replacement:
				"\tbind<const B extends BindingsFor<P>>(\n\t\tbindings: B & NoStrayParameters<B, P> & RelationBindings<B, P, S>\n\t): BoundSource<\n\t\tBoundOver<S, B, P>,",
			why: "A bind (Query.bind) names the interface's schema in its signature, so each rule that matches a bound query walks the schema: 1,457 more instantiations a rule over 120 relations than over 3 (PERF-TYPES micro, a rule matching a query bound to its relation parameter)."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				"\tattach<Over, const Name extends string, C extends Child<Over>, CH, CI, const K extends Delivery>(\n\t\tthis: OverSchema<Over>,\n\t\tname: AttachmentName<Name, Head>,\n\t\tchild: (\n\t\t\tparent: ParentVars<Hc, Ev>\n\t\t) => C & Decoders<CH, CI> & DeliveryClaim<K, ChildEvidence<C>> & OneHeading<CH>,\n\t\tdelivery: K\n\t): Finished<\n\t\tWithChild<Head, Name, CH, K>,\n\t\tEv,\n\t\tSimplify<P & ChildParams<C>>,\n\t\tOver,",
			replacement:
				"\tattach<const Name extends string, C extends Child<S>, CH, CI, const K extends Delivery>(\n\t\tname: AttachmentName<Name, Head>,\n\t\tchild: (\n\t\t\tparent: ParentVars<Hc, Ev>\n\t\t) => C & Decoders<CH, CI> & DeliveryClaim<K, ChildEvidence<C>> & OneHeading<CH>,\n\t\tdelivery: K\n\t): Finished<\n\t\tWithChild<Head, Name, CH, K>,\n\t\tEv,\n\t\tSimplify<P & ChildParams<C>>,\n\t\tS,",
			why: "An arm's attachment (Finished.attach) names the schema S of its interface, which its phantom does not carry, so the checker reads S off the member: every arm returned to a union's further rule is compared through it, 222 more instantiations an arm over 120 relations than over 3 (PERF-TYPES micro, union of two rules)."
		}
	]
})
