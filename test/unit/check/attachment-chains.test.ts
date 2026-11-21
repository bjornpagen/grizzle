/**
 * An attachment is refused as attached twice exactly where one chain attaches its name twice (check/checker.ts
 * attachIn, StageOut carries): under an import an attachment builds no node a row is read from, so the names a chain
 * attaches travel with the chain, never on the node its rows are read from, which another chain may share. Two
 * imports, each attaching `a` once over the approximate nearest of one source, read one search node (one search for
 * one identity, check/approximate), and each import's chain recorded its attachment on that node, so the second import
 * was refused as attaching `a` twice, a query no chain of which attaches a name twice (at fba746ba, its chain's walk
 * read the node's names).
 *
 * The box, exhausted: a chain attaching `a` over the nearest documents of one source, once or twice, read as the query
 * or imported, and, imported, beside no other chain, one attaching `a` once itself, or one attaching `b`. A chain
 * attaching a name twice is a Description no builder writes (query/build/attach.ts attachmentName refuses it).
 *
 * Property: a case's query is refused as MalformedDescription at its chain's attachment exactly where the chain
 * attaches `a` twice, and admitted otherwise. Oracle: specification, a chain attaches each name once. Kill: an
 * attachment never refused as attached twice, under which a chain attaching `a` twice is admitted.
 *
 * Features: read as the query; imported alone; beside a chain of the same name; beside a chain of another name; each
 * with the chain attaching its name twice.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { placeOf, refused, refusalLoc, succeeded } from "#test/support/assert.ts"
import {
	attachmentLoc,
	type ChainCase,
	chainCaseGen,
	chainQuery,
	checkedChain
} from "#test/unit/check/attachment-chains.fixtures.ts"

type Situation =
	`${"read as the query" | "imported alone" | "beside a chain of the same name" | "beside a chain of another name"}${"" | ", attached twice"}`

/** A case's situation. */
const situationOf = (c: ChainCase): Situation => {
	const twice = c.doubled ? ", attached twice" : ""
	if (c.where === "root") {
		return `read as the query${twice}`
	}
	switch (c.beside) {
		case "none":
			return `imported alone${twice}`
		case "the same name":
			return `beside a chain of the same name${twice}`
		case "another name":
			return `beside a chain of another name${twice}`
	}
}

/** A query is refused as attaching a name twice exactly where one of its chains attaches a name twice. */
export const anAttachmentIsRefusedAsAttachedTwiceExactlyWhereOneChainAttachesItsNameTwice =
	property.exhaust(finite(chainCaseGen), {
		needs: {},
		situations: [
			"read as the query",
			"read as the query, attached twice",
			"imported alone",
			"imported alone, attached twice",
			"beside a chain of the same name",
			"beside a chain of the same name, attached twice",
			"beside a chain of another name",
			"beside a chain of another name, attached twice"
		],
		check: (_, k) => (c) =>
			Effect.sync(() => {
				const situation = situationOf(c)
				k.note(situation)
				const q = chainQuery(c)
				const checked = checkedChain(q)
				if (!c.doubled) {
					succeeded(checked, `${situation}: no chain attaches a name twice`)
					return
				}
				const refusal = refused(
					checked,
					"MalformedDescription",
					`${situation}: its chain attaches a twice`
				)
				assert.deepEqual(
					placeOf(refusalLoc(refusal)),
					placeOf(attachmentLoc(q)),
					`${situation}: refused at its chain's attachment`
				)
			}),
		oracle: { kind: "specification", name: "a chain attaches each name once" },
		box: "a chain attaching a over one approximate search, once or twice, read as the query or imported alone, beside a chain attaching a, or beside one attaching b",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tif (carried.has(desc.name)) {\n",
				replacement: "\t\tif (false) {\n",
				why: "No attachment is refused as attached twice, so a chain attaching a twice, read as the query or imported, is admitted."
			}
		]
	})
