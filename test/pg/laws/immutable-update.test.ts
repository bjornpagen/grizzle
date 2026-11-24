/**
 * An immutable relation refuses every UPDATE that changes a row, the owner's included (physical/ddl/immutable.ts): no
 * role holds UPDATE on it, and its table's immutability guard refuses the table's owner, who holds every privilege, with
 * the error a role meets, insufficient_privilege naming the table. A unit-local rule's judge reads its relations under
 * this premise (analysis/theory/unit.ts wholeRule): it takes a unit from the rows a transaction gave a relation only
 * where it lost one there, and an UPDATE gives one and loses none, so an UPDATE the guard let through would commit a
 * state no judge read.
 *
 * Over each unit shape's whole judge of rule-whole.fixtures.ts, a document stored whole, then the owner's UPDATE of a
 * node's kind or parent, a key field of it, or an expression's type, to a drawn value at a drawn row: refused, nothing
 * stored changed, where it changes the row; run where it sets the value the row holds.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { runRewrite, rewriteGen } from "#test/pg/laws/immutable-update.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The owner's UPDATE of an immutable relation is refused wherever it changes a row, with insufficient_privilege naming
 * its table, and runs where it changes none.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anUpdateOfAnImmutableRelationThatChangesARowIsRefusedToTheOwnerToo = property.explore(
	rewriteGen,
	{
		needs: Substrate.oneOf(judgeTemplates, Substrate.fresh),
		situations: [
			"an UPDATE of a field beside the key refused",
			"an UPDATE of a key field refused",
			"an UPDATE of an expression refused",
			"an UPDATE that changes no row runs"
		],
		check: (judges, c) => (rewrite) =>
			Effect.gen(function* () {
				const judge = yield* judges[`whole ${rewrite.shape}`]
				const session = yield* judge.substrate.session({ ...ownerSession(), label: "owner" })
				yield* standUpJudge(session, judge.value.installation)
				yield* runRewrite(judge.value, session, rewrite, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "the row a drawn UPDATE meets and the value it sets: a change of the row refused under insufficient_privilege naming its table, every stored row as it was, and an UPDATE to the value the row holds run"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/immutable.ts",
				original: "\t\tif (relation.mutable || !isNonEmpty(fixed)) {",
				replacement: "\t\tif (relation.mutable || isNonEmpty(fixed)) {",
				why: "No immutable relation's table carries the guard, as before it, so the owner's UPDATE of a node's kind commits beside its document's other rows, a fact changed in place that no unit-local rule's judge reads."
			},
			{
				file: "packages/engine/src/physical/ddl/immutable.ts",
				original:
					'\t\tf.writing.kind === "generated" || relation.inPlace.includes(f.name) ? [] : [f.column]',
				replacement: '\t\tf.writing.kind === "generated" || f.position > 0 ? [] : [f.column]',
				why: "The guard holds only a relation's first field fixed, so an UPDATE of a node's kind, its parent or an expression's type commits."
			}
		]
	}
)
