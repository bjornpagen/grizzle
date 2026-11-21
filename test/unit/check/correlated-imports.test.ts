/**
 * An import bound to an outer value, a term of an attachment's parent row or a variable of the reader's rule, is one
 * node for every read of it at that value in a check (check/checker.ts importedKey, boundPart, #correlatedImport): its
 * key is the node and the column the value is read through, so every read of one query at one node's values reads one
 * import, correlated to that node, and a call of a declared function at such imports is one call for every read of its
 * fields (#closedCall), where each read built every import again, a description's sharing expanded into a tree
 * (edullm's sittingItem: one session's start, its run's every field read under every value row of its record, the
 * run's arguments each a lookup bound to the parent's terms, 147K nodes in one query).
 *
 * The box, exhausted: an attachment under each Item reading 1, 2, 3 or 4 fields of one call of a declared function of
 * three rows arguments, of which 1 or 3 are each an import of a lookup bound to the parent item's id, the rest closed.
 *
 * Property, per case: each field read adds the same nodes to the checked query, whatever number of its arguments is
 * bound to the parent: the arguments and the call are built once for the check. Oracle: linearity, read off the reads,
 * and the bound arguments' count changing no read's nodes. Kill: an import bound to an outer value has no key, built at
 * each read, so each field read builds the bound arguments again and adds more where more are bound.
 *
 * And every import term is bound to the outermost value it reads, in every reading (#bindValue): a parameter the
 * importer bound to an outer value is bound to that value itself, never to a column of the reading rule's region that
 * reads it again, so a lookup imported by several queries, each bound to its own parameter, which their reader binds to
 * one parent's id, is one node for all of them, where each query's rule bound it to a column of its own. The box: one
 * attachment under each Item making 1 to 4 reads, each its own query importing one lookup of Seed (one match or three)
 * bound to its own parameter, bound to the parent's id. Property: each read adds the same nodes whatever the lookup's
 * size. Kill: a parameter bound to an outer value is read through the rule's own column, so each read builds the
 * lookup again and adds more where the lookup is larger.
 *
 * Features: one field read, several; one bound argument, three; one read, several.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	checkedNodes,
	fieldsGen,
	nestedNodes,
	readersGen
} from "#test/unit/check/correlated-imports.fixtures.ts"

/** Every read of one call at one parent's values reads one call: each field read adds its own node alone. */
export const everyReadOfOneCallAtOneParentsValuesReadsOneCall = property.exhaust(
	finite(fieldsGen),
	{
		needs: {},
		situations: ["one field read", "several field reads"],
		check: (_, k) => (fields) =>
			Effect.sync(() => {
				k.note(fields === 1 ? "one field read" : "several field reads")
				const step = checkedNodes(1, 2) - checkedNodes(1, 1)
				for (const bound of [1, 3] as const) {
					assert.equal(
						checkedNodes(bound, fields),
						checkedNodes(bound, 1) + (fields - 1) * step,
						`${fields} field reads over ${bound} bound arguments add what one read and ${fields - 1} reads more of one field's own nodes do`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "linearity: f field reads add f − 1 times one field read's own nodes, whatever number of arguments is bound to the parent"
		},
		box: "an attachment reading 1, 2, 3 and 4 fields of one call of three rows arguments, 1 or 3 of them an import bound to the parent item's id",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\t: this.#correlatedImport(key, () => this.#importAt(src, values, loc))\n",
				replacement: "\t\t\t: this.#importAt(src, values, loc)\n",
				why: "An import bound to an outer value is built at each read, as it was: each field read builds the call's bound arguments again, so it adds more nodes where more arguments are bound, the description's sharing a tree."
			}
		]
	}
)

/** A lookup imported at two removes by several reads of one parent's value is one node: each read adds its own alone. */
export const aLookupImportedThroughSeveralQueriesAtOneParentsValueIsOneNode = property.exhaust(
	finite(readersGen),
	{
		needs: {},
		situations: ["one read", "several reads"],
		check: (_, k) => (readers) =>
			Effect.sync(() => {
				k.note(readers === 1 ? "one read" : "several reads")
				const step = nestedNodes("small", 2) - nestedNodes("small", 1)
				for (const size of ["small", "large"] as const) {
					assert.equal(
						nestedNodes(size, readers),
						nestedNodes(size, 1) + (readers - 1) * step,
						`${readers} reads over a ${size} lookup add what one read and ${readers - 1} reads more of one read's own nodes do`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "linearity: r reads add r − 1 times one read's own nodes, whatever the lookup's size"
		},
		box: "one attachment making 1 to 4 reads, each its own query importing one lookup of Seed, one match or three, bound to its own parameter, bound to the parent's id",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\t\t\treturn resolved.kind !== "column" || this.cx.held(resolved)\n',
				replacement: '\t\t\treturn resolved.kind !== "column"\n',
				why: "A parameter bound to an outer value is read through a column of the reading rule's own region, as it was: each query's rule binds the lookup to a column of its own, so every read builds the lookup again and adds more where it is larger."
			}
		]
	}
)
