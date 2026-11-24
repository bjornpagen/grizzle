/**
 * The structural check of a query description (check/description.ts validateQueryStructure) validates each query once
 * for its compile under each reading and each way it is entered, as a query of its own or as an attachment's child
 * (check/session.ts CheckSession validated): a query is one value every reader of it shares (query/build/state.ts
 * publicDesc), so a compile's descriptions are one DAG of queries, and each check walked its description as the tree
 * its sharing expands into, entering a query once for every path to it, which grows as the product of the reads along
 * a chain of imports, and again in every check of the compile. edullm's QTI database generate allocated 22.5 GiB in the
 * walk's rule visits at 94aa830e1 (its heap profile), 17.7 GiB of them in imported queries' rules.
 *
 * The box, drawn: a chain of two to seven queries, each above the bottom one reading the query below it one to three
 * times, each read an import or an attachment, the bottom query holding nothing amiss, a variable its rule does not
 * declare, a parent variable or a self source; and one to three members of one compile, each importing the chain.
 *
 * Properties: a description is refused exactly where its bottom query is malformed as it is entered, a parent variable
 * only where an import enters it, with the refusal of the bottom query checked alone; a check that refuses nothing
 * enters each query once for each way it is read, where the paths to it are many; and the members of one compile are
 * each refused as the bottom query alone is, or, refusing nothing, enter the chain once between them. Kills: an
 * attachment's child entered as a query of its own; every query entered on every path to it, the tree walk's work; a
 * query recorded before its walk passes, which lets a malformed import through at the next member; and no record for
 * the compile, which walks the chain again for every member.
 *
 * Features: each plant; a query imported twice; a query attached; a query imported and attached; two members or more.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { int, map } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { validateQueryStructure } from "#compiler/check/description.ts"
import { CheckSession } from "#compiler/check/session.ts"
import {
	type Box,
	boxGen,
	descriptionOf,
	entriesOf,
	memberOf,
	type Plant,
	pathsOf,
	refusedAt
} from "#test/unit/check/structure-sharing.fixtures.ts"

type Situation =
	| `planted: ${Plant}`
	| "a query imported twice"
	| "a query attached"
	| "a query imported and attached"

/** The box's situations, noted on `c`. */
const noteBox = (box: Box, c: Case<Situation>): void => {
	c.note(`planted: ${box.plant}`)
	if (Arr.some(box.levels, (reads) => Arr.filter(reads, (r) => r === "import").length > 1)) {
		c.note("a query imported twice")
	}
	if (Arr.some(box.levels, (reads) => Arr.contains(reads, "attachment"))) {
		c.note("a query attached")
	}
	if (Arr.some(box.levels, (reads) => new Set(reads).size > 1)) {
		c.note("a query imported and attached")
	}
}

/** A shared query is refused exactly where it is malformed as it is entered, as it is refused alone. */
export const aSharedQueryIsRefusedExactlyWhereItIsMalformedAsItIsEnteredAsItIsRefusedAlone =
	property.explore(boxGen, {
		needs: {},
		situations: [
			"planted: none",
			"planted: a stranger variable",
			"planted: a parent variable",
			"planted: a self source",
			"a query imported twice",
			"a query attached",
			"a query imported and attached"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (box) =>
			Effect.sync(() => {
				const { root, bottom } = descriptionOf(box, { count: 0 })
				const checked = validateQueryStructure(root, { read: "rows", session: CheckSession.own() })
				if (refusedAt(box)) {
					assert.ok(!checked.ok, `the description over a bottom query with ${box.plant} is refused`)
					const alone = validateQueryStructure(bottom, {
						read: "rows",
						session: CheckSession.own()
					})
					assert.ok(!alone.ok, "the bottom query alone is refused")
					assert.deepEqual(checked.error, alone.error, "the refusal is the bottom query's own")
				} else {
					assert.ok(checked.ok, `the description over a bottom query with ${box.plant} is valid`)
				}
				noteBox(box, c)
			}),
		oracle: {
			kind: "specification",
			name: "the scope rules of check/description.ts over the bottom query as each read enters it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/description.ts",
				original: "\tattachment: { recursiveStep: false, attachment: true }\n",
				replacement: "\tattachment: { recursiveStep: false, attachment: false }\n",
				why: "An attachment's child is entered as a query of its own, so a parent variable it reads is refused: a bottom query read only by attachments, valid, is refused, and the search fails."
			}
		]
	})

/** A check that refuses nothing enters each shared query once for each way it is read. */
export const aCheckThatRefusesNothingEntersEachSharedQueryOnceForEachWayItIsRead = property.explore(
	map(boxGen, (box) => ({ ...box, plant: "none" as const })),
	{
		needs: {},
		situations: [],
		check: () => (box) =>
			Effect.sync(() => {
				const reads = { count: 0 }
				const { root } = descriptionOf(box, reads)
				assert.ok(
					validateQueryStructure(root, { read: "rows", session: CheckSession.own() }).ok,
					"the description is valid"
				)
				assert.equal(
					reads.count,
					entriesOf(box),
					`the check enters its queries ${entriesOf(box)} times, not once on each of ${pathsOf(box)} paths`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one entry of each query for each way its reader reads it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/description.ts",
				original: "\t\tif (validated.has(q)) {\n",
				replacement: "\t\tif (validated.has(q) && !validated.has(q)) {\n",
				why: "Every query is entered on every path to it, the tree walk's work: a query read twice is entered twice, the entries are the paths, and the search fails."
			}
		]
	}
)

/**
 * The members of one compile are each refused as the shared chain's bottom query alone is, or, refusing nothing, enter
 * the chain once between them.
 */
export const theMembersOfOneCompileAreEachRefusedAsTheSharedQueryAloneIsOrEnterItOnceBetweenThem =
	property.explore((source) => ({ box: source.draw(boxGen), members: source.draw(int(1, 3)) }), {
		needs: {},
		situations: [
			"planted: none",
			"planted: a stranger variable",
			"planted: a parent variable",
			"planted: a self source",
			"a query imported twice",
			"a query attached",
			"a query imported and attached"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check:
			(_, c: Case<Situation>) =>
			({ box, members }) =>
				Effect.sync(() => {
					const reads = { count: 0 }
					const { root, bottom } = descriptionOf(box, reads)
					const session = CheckSession.own()
					const checks: Array<ReturnType<typeof validateQueryStructure>> = []
					for (let i = 1; i <= members; i++) {
						checks.push(validateQueryStructure(memberOf(root, i, reads), { read: "rows", session }))
					}
					if (refusedAt(box)) {
						const alone = validateQueryStructure(bottom, {
							read: "rows",
							session: CheckSession.own()
						})
						assert.ok(!alone.ok, "the bottom query alone is refused")
						for (const checked of checks) {
							assert.ok(!checked.ok, "every member over a malformed chain is refused")
							assert.deepEqual(checked.error, alone.error, "each refusal is the bottom query's own")
						}
					} else {
						assert.ok(
							Arr.every(checks, (checked) => checked.ok),
							"every member is valid"
						)
						assert.equal(
							reads.count,
							members + entriesOf(box),
							`${members} members enter their own queries once each and the chain ${entriesOf(box)} times between them`
						)
					}
					noteBox(box, c)
				}),
		oracle: {
			kind: "specification",
			name: "one validation of each query for the compile under each reading and entry"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/description.ts",
				original: "\t\tthis.stage(q.stage, entered[entry])\n\t\tvalidated.add(q)\n",
				replacement: "\t\tvalidated.add(q)\n\t\tthis.stage(q.stage, entered[entry])\n",
				why: "A query is recorded before its walk passes: the first member is refused at the malformed bottom query, which is recorded all the same, and the next member is let through, so the search fails."
			},
			{
				file: "packages/engine/src/check/description.ts",
				original:
					"\t\tconst validated = this.options.session.validated[this.options.read][entry]\n",
				replacement: "\t\tconst validated = new WeakSet<InferredQuery>()\n",
				why: "No query is recorded for the compile, so every member walks the whole chain again, on every path to each query: the entries are the paths for every member, and the search fails."
			}
		]
	})
