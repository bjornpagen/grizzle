/**
 * A containment into a fixed target, through grizzle's lowering on PostgreSQL 19: a document row states its node's
 * context, the node being of kind `document`, its own document and at depth 0, as `contained(on(Document, "node"),
 * on(select(Node, (n) => n.and(n.eq(n.kind, "document"), n.eq(n.document, n.id), n.eq(n.depth, 0n))), "id"))`. The
 * target's selection fixes kind and depth to values and document to its term id, beyond its term. Its superkey would
 * hold Node's id and the fixed fields, Document a constant column for each of kind and depth; its own column, Node's id
 * under the selection, under a UNIQUE Node's primary key implies too, costs the schema less, so the foreign key
 * references that (laws/model/plan.ts sharedTargets).
 *
 * - **The specification turned into a checker:** the containment's meaning, the target's selection read row by row: a
 *   state commits exactly when every document row's node is a node of kind `document` whose document is itself and
 *   whose depth is 0. A refusal must be 23503 by Document's foreign key, reporting the containment's law.
 *
 * The box: nodes 0 and 1, each absent or of a kind, a document and a depth, and every subset of document rows over
 * them, nodes written first, in one transaction.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { codeOf } from "#compiler/ir/codes.ts"
import { seatIn } from "#test/pg/fin/installed.ts"
import {
	Disagreed,
	type FixedTargetFeature,
	fixedTargetTemplate,
	type Kind,
	missedOf,
	NodeKind,
	RELATIONS,
	sketchGen
} from "#test/pg/laws/fixed-target.fixtures.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A containment into a target fixed by values and by its own term on PostgreSQL 19 commit exactly the states whose every document row's node is of kind document, its own document and at depth 0, refusing the rest by the document's foreign key.
 */
export const aContainmentIntoATargetFixedByValuesAndByItsOwnTermOnPostgreSQL19CommitExactlyTheStatesWhoseEveryDocumentRowsNodeIsOfKindDocumentItsOwnDocumentAndAtDepth0RefusingTheRestByTheDocumentsForeignKey =
	property.exhaust(finite(sketchGen), {
		needs: { seated: Substrate.seat(fixedTargetTemplate) },
		situations: [
			"committed",
			"committed a document",
			"refused for no node",
			"refused for a node of another kind",
			"refused for a node of another document",
			"refused for a node deeper"
		] satisfies ReadonlyArray<Reached<FixedTargetFeature>>,
		check:
			({ seated }, c: Case<FixedTargetFeature>) =>
			(s) =>
				Effect.gen(function* () {
					const taken = yield* seated
					const seat = yield* seatIn(taken, RELATIONS, "fixed_target")
					const codec = Arr.findFirst(
						[...seat.installed.names.codes.rosters.values()],
						(r) => r.roster === NodeKind.name
					)
					const code = (k: Kind) => codeOf(Option.getOrThrow(codec), k)
					const laws = seat.lawsOf("containment")

					const col = (r: string, f: string) => seat.column(r, f)
					const nodes = Arr.flatMap(s.nodes, (n, id) =>
						n === undefined ? [] : [`(${id}, ${code(n.kind)}, ${n.document}, ${n.depth})`]
					)
					const statements = [
						...(nodes.length === 0
							? []
							: [
									`INSERT INTO ${seat.table("Node")} (${col("Node", "id")}, ${col("Node", "kind")}, ${col("Node", "document")}, ${col("Node", "depth")}) VALUES ${Arr.join(nodes, ", ")}`
								]),
						...(s.documents.length === 0
							? []
							: [
									`INSERT INTO ${seat.table("Document")} (${col("Document", "node")}) VALUES ${Arr.join(
										Arr.map(s.documents, (id) => `(${id})`),
										", "
									)}`
								])
					]
					const real = yield* attempt(seat.session, statements)
					const missed = Arr.flatMap(s.documents, (id) => missedOf(s, id))
					if (real.kind === "committed") {
						if (missed.length > 0) {
							return yield* new Disagreed({
								message: `committed a state whose document rows meet no node (${Arr.join(missed, ", ")}): ${Formatter.format(s)}`
							})
						}
						c.note(s.documents.length > 0 ? "committed a document" : "committed")
						return
					}
					const named = seat.refusedBy(real.fields)
					if (
						real.fields.code !== "23503" ||
						missed.length === 0 ||
						!Option.exists(
							named,
							(k) =>
								k.kind === "foreign" &&
								k.relation === "Document" &&
								Arr.some(k.laws, (l) => laws.includes(l))
						)
					) {
						return yield* new Disagreed({
							message: `refused ${momentText(real.moment)} by ${refusalText(real.fields)}, where the state's document rows miss ${Formatter.format(missed)}: ${Formatter.format(s)}`
						})
					}
					for (const m of Arr.dedupe(missed)) {
						c.note(`refused for ${m}`)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the containment's meaning as a checker: every document row's node of kind document, its own document, at depth 0"
		},
		box: "nodes 0 and 1, each absent or of kind document or element, of document 0 or 1 and at depth 0 or 1, and every subset of document rows over them, nodes written first",
		kept: [],
		kills: []
	})
