/**
 * An immutable relation, a closed one, refuses every DELETE of a row, every TRUNCATE and every UPDATE that changes a
 * row, the owner's included (physical/ddl/immutable.ts): no role holds UPDATE or DELETE on it, and its table's immutability guard refuses
 * the table's owner, who holds every privilege, with the error a role meets, insufficient_privilege naming the table. A
 * closed relation's facts are inserted, never changed or removed: a unit-local rule's judge reads its relations under this
 * premise (analysis/theory/unit.ts wholeRule), taking a unit from the rows a transaction gave a relation only where it
 * lost one there, and so does a stored relation's upkeep, whose delta program reads a closed holder's added rows alone
 * at every write but a migration's data step (analysis/theory/upkeep.ts), so a write the guard let through would commit a
 * state no judge and no upkeep read.
 *
 * Over each unit shape's whole judge of rule-whole.fixtures.ts, a document stored whole, then the owner's DELETE of a
 * node's or an expression's row, TRUNCATE of the nodes or the expressions, or UPDATE of a node's kind or parent, a key
 * field of it, or an expression's type, to a drawn value, at a drawn row: a DELETE or a TRUNCATE refused, nothing stored
 * changed; an UPDATE refused alike where it changes the row, and run where it sets the value the row holds.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { runRewrite, rewriteGen } from "#test/pg/laws/immutable-update.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The owner's DELETE of an immutable relation's row is refused, and its TRUNCATE of the relation, and its UPDATE
 * wherever it changes a row, with insufficient_privilege naming its table; an UPDATE that changes none runs.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDeleteATruncateOrAnUpdateOfAnImmutableRelationThatChangesARowIsRefusedToTheOwnerToo =
	property.explore(rewriteGen, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.fresh),
		situations: [
			"an UPDATE of a field beside the key refused",
			"an UPDATE of a key field refused",
			"an UPDATE of an expression refused",
			"an UPDATE that changes no row runs",
			"a DELETE of a node refused",
			"a DELETE of an expression refused",
			"a TRUNCATE of the nodes refused",
			"a TRUNCATE of the expressions refused"
		],
		check: (judges, c) => (rewrite) =>
			Effect.gen(function* () {
				const judge = yield* judges[`whole ${rewrite.shape}`]
				const session = yield* judge.substrate.session({ ...ownerSession(), label: "owner" })
				yield* runRewrite(judge.value, session, rewrite, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "the row a drawn DELETE or UPDATE meets and the value it sets, and the table a TRUNCATE empties: a DELETE, a TRUNCATE, and an UPDATE that changes the row, refused under insufficient_privilege naming its table, every stored row as it was, and an UPDATE to the value the row holds run"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/immutable.ts",
				original: "\t\tif (relation.mutable) {",
				replacement: "\t\tif (relation.mutable || true) {",
				why: "No immutable relation's table carries the guard, so the owner's UPDATE of a node's kind commits beside its document's other rows, a fact changed in place that no unit-local rule's judge reads, and its DELETE of a row commits, a fact removed."
			},
			{
				file: "packages/engine/src/sql/catalog.ts",
				original: '\trows: { events: "BEFORE UPDATE OR DELETE", level: "ROW" },',
				replacement: '\trows: { events: "BEFORE UPDATE", level: "ROW" },',
				why: "The guard back to UPDATE alone: the owner's DELETE of a closed relation's row commits, a fact removed that no served write could remove, which a stored relation's delta program, reading a closed holder's added rows alone, never takes back out of its table."
			},
			{
				file: "packages/engine/src/physical/ddl/immutable.ts",
				original:
					'const guardFirings = ["rows", "truncate"] as const satisfies NonEmptyReadonlyArray<GuardFiring>',
				replacement:
					'const guardFirings = ["rows"] as const satisfies NonEmptyReadonlyArray<GuardFiring>',
				why: "No closed relation's table carries the TRUNCATE guard, which no row trigger fires for: the owner's TRUNCATE of the nodes or the expressions commits, every fact of the closed relation removed at once."
			},
			{
				file: "packages/engine/src/physical/ddl/immutable.ts",
				original:
					'\t\tf.writing.kind === "generated" || relation.inPlace.includes(f.name) ? [] : [f.column]',
				replacement: '\t\tf.writing.kind === "generated" || f.position > 0 ? [] : [f.column]',
				why: "The guard holds only a relation's first field fixed, so an UPDATE of a node's kind, its parent or an expression's type commits."
			}
		]
	})
