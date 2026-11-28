/**
 * A join no value of a write's single statement restricts, which its parts read joined to a carried part by its
 * columns, is computed once at the keys its reads read it at (lower/shapes/share/statements.ts keyedShares, keys.ts,
 * StatementSharing #keyedBody): one part of the statement holds the join's rows whose columns match a row of its key
 * set, an EXISTS over a DISTINCT CTE that reads its readers' keys from the carried part, and every read of it reads that
 * part. Each read restated the join whole, which PostgreSQL planned again at each: edullm's ledger grade read every
 * item's response declarations, a join of four reads of the attributes, 36 times, each joined to the gradable runs by
 * the item, 934 MB of the grade's 1,186 MB of planning.
 *
 * The box, exhausted: a call of four rows arguments, one, two or all four reading every item's labels (a join of Tag and
 * Label) joined to the open items of the call's sessions by the item, or alone; a second member writing the open items,
 * so the statement carries them as a part.
 *
 * Oracle: specification, the labels read by two arguments or four scanned once, in one part that reads no Item and keeps
 * its rows by an EXISTS over its key set; read by one argument, or alone, scanned where each argument reads them.
 *
 * Features: by the open items; alone.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	boxGen,
	type Content,
	labelParts,
	printsOf,
	scans,
	statementsOf
} from "#test/unit/write/restricted-share.fixtures.ts"

/**
 * A join a write's parts read joined to a carried part by its columns is computed once in the statement, at the keys
 * its reads read it at, where two arguments or more read it so.
 */
export const aJoinTheStatementsPartsReadJoinedToACarriedPartIsComputedOnceAtTheKeysItsReadsReadItAt =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: ["by the open items", "alone"],
		check: (_, k: Case<Content>) => (box) =>
			Effect.sync(() => {
				k.note(box.content)
				const statements = statementsOf(box)
				const sql = Arr.join(statements, "\n")
				const restricted = box.content === "by the open items" && box.reading > 1
				assert.equal(
					Arr.reduce(statements, 0, (n, s) => n + scans(s, "tag")),
					restricted ? 1 : box.reading,
					`${box.reading} arguments reading the labels ${box.content}: Tag scanned ${restricted ? "once" : "at each"}\n${sql}`
				)
				const parts = labelParts(sql)
				const held = Arr.map(parts, (p) => `${p.name}${p.keptByKeys ? " read at its key set" : ""}`)
				const heldOnce: boolean = parts.length === 1 && Arr.every(parts, (p) => p.keptByKeys)
				assert.equal(
					heldOnce,
					restricted,
					`${box.reading} arguments reading the labels ${box.content}: ${restricted ? "one part holds them, read LATERAL per key of its key set" : "no part holds them"} (${Arr.join(held, ", ")})\n${sql}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the labels two arguments read by the open items computed once, at the keys the open items' part gives them; otherwise where each reads them"
		},
		box: "one, two or four of a call's four arguments reading every item's labels joined to the open items by the item, or alone, a second member carrying the open items",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\tif (atRows || (once && readers(site.occurrence.source) === 1)) {\n",
				replacement: "\t\t\t\tif (atRows || once) {\n",
				why: "A site of one row before it is read at that row's values however many readers the statement holds of it: the two arguments reading the labels by the open items each read them at their own rows, two derivations where one part holds them."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: '\t\t\tcase "byKeys":\n',
				replacement: '\t\t\tcase "byKeys":\n\t\t\t\treturn whole\n',
				why: "No share is carried at its keys, as before: each argument that reads the labels restates the join of Tag and Label, and Tag is scanned once per argument."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keyed.ts",
				original:
					"\t\t\tdistinctCore(headingTargetsOf(node, atKey.map), [keyRows.item, atKey.item], undefined)\n",
				replacement:
					"\t\t\tdistinctCore(headingTargetsOf(node, rows.map), [rows.item], undefined)\n",
				why: "The keyed share's part holds the join whole, every item's labels, no LATERAL per key of its key set: the join materialized whole, unrestricted."
			}
		]
	})

/**
 * A write's single statement is the one print of its parts: each write it composes is built and never printed apart
 * (write/insert/statement.ts StatementWriting), since a part reads the CTEs the single statement holds, its shared sub-queries'
 * among them, which the single statement alone binds (sql/scope.ts), and its text would be thrown away. So the
 * write's compile prints each statement it sends once and nothing else, where each part printed its own text beside
 * the single statement's.
 *
 * The count is work, never time: V8's precise coverage counts each call of sql/emit.ts printedOf, the printer's one
 * door, which prints every bound statement, emitText's and emitSelect's, and of the composed statements' text maker,
 * unprintedText (kernel/calls.ts everyCallCount). The box is the property above's, exhausted.
 *
 * Oracle: specification, one print a statement the artifact sends, and one composition a part (the two inserts).
 *
 * Features: by the open items; alone.
 */
export const aWritesSingleStatementIsTheOnePrintOfThePartsItComposes = property.exhaust(
	finite(boxGen),
	{
		needs: {},
		situations: ["by the open items", "alone"],
		check: (_, k: Case<Content>) => (box) =>
			Effect.gen(function* () {
				k.note(box.content)
				const counted = yield* printsOf(box)
				assert.equal(
					counted.prints,
					counted.sent,
					`${box.reading} arguments reading the labels ${box.content}: the statements printed, ${counted.sent} sent`
				)
				assert.equal(counted.composed, 2, "the two inserts, the single statement's parts")
			}),
		oracle: {
			kind: "specification",
			name: "one print a statement the artifact sends, one composition a part"
		},
		box: "one, two or four of a call's four arguments reading every item's labels joined to the open items by the item, or alone, a second member carrying the open items",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/program/compile.ts",
				original: "\t\t\t\t\t\t\t{ ...w, start, text: unprintedText, share: lowering.parts },\n",
				replacement: "\t\t\t\t\t\t\t{ ...w, start, share: lowering.parts },\n",
				why: "A single statement's parts printed as its writes are built, texts nothing sends, which read the CTEs only the single statement binds: the scope check refuses one that reads a shared sub-query, and the prints outnumber the statements sent."
			}
		]
	}
)
