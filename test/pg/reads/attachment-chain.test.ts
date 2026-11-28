/**
 * A chain of attachments, each attached to the one before it, whose children each import one lookup bound to their
 * parent's id, reads on PostgreSQL 19 the rows the parent's value selects at every link (check/checker.ts RuleCheck
 * #bindValue): each link's import is bound to the id column of the head of the chain (attachmentHead), the items or
 * the projection of them below the first link, whose rows and columns every attachment above it delivers as they stand,
 * so every link's import of one lookup at one id is one node, which the lowering reads through the delivered rows'
 * parent key (lower/conservative/deliver.ts parentColumnsRead). edullm's session records, each part attached to the one before
 * it and reading the session's start at the session's terms, read one start per part before.
 *
 * Each case draws the facts, items of three ids and their seeds, and reads every read of the box over them through the
 * installed login: chains of one to four links, each over a lookup of one match of Seed or three, over every item or
 * every item with its id and kind swapped.
 *
 * - Property: every read delivers exactly the model's items, each with exactly the model's seeds at every link.
 * - Oracle: the reads restated over the facts on the host, each item with its seeds of at least each link's index.
 * - Features: each chain length, a projection below the chain that renames its columns, an item with no seed, and a
 *   link that drops a seed an earlier link reads.
 */

import { defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	AttachmentChain,
	type ChainFeature,
	chainInstall,
	chains,
	chainTemplate,
	type Delivered,
	expected,
	factsGen,
	featuresOf,
	nameOf
} from "#test/pg/reads/attachment-chain.fixtures.ts"
import { rowsOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A delivered link row's seed, as a number: the one cell of each element of a link's array. */
const seedOf = (s: unknown): number =>
	Number(typeof s === "object" && s !== null ? Reflect.get(s, "seed") : undefined)

/** A delivered item's cells as numbers, each link's seeds ascending. */
const deliveredOf =
	(links: number) =>
	(row: Readonly<Record<string, unknown>>): Delivered => ({
		id: Number(row["id"]),
		kind: Number(row["kind"]),
		links: Array.from({ length: links }, (_, j) => {
			const cell = row[`link${j}`]
			return Arr.sort(Arr.map(Arr.isArray(cell) ? cell : [], seedOf), Order.Number)
		})
	})

const linkFeature = {
	1: "one link",
	2: "two links",
	3: "three links",
	4: "four links"
} as const satisfies Readonly<Record<1 | 2 | 3 | 4, ChainFeature>>

/**
 * A chain of attachments whose links each import a lookup bound to their parent's id reads the rows the id selects at
 * every link.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aChainOfAttachmentsWhoseLinksImportALookupAtTheirParentsIdReadsTheRowsTheIdSelectsAtEveryLink =
	property.explore(factsGen, {
		needs: { fixture: Substrate.fresh(chainTemplate) },
		situations: [
			"one link",
			"two links",
			"three links",
			"four links",
			"a projection below the chain that renames its columns",
			"an item with no seed",
			"a link that drops a seed an earlier link reads"
		] satisfies ReadonlyArray<Reached<ChainFeature>>,
		check:
			({ fixture }, c: Case<ChainFeature>) =>
			(facts) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(
								AttachmentChain,
								{ Item: facts.items, Seed: facts.seeds },
								chainInstall,
								taken
							)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								for (const chain of chains) {
									const rows = yield* rowsOf(
										defined(db.workload[nameOf(chain)], `the read ${nameOf(chain)}`).once({
											params: {},
											facts: {}
										})
									)
									unorderedEqual(
										Arr.map(rows, deliveredOf(chain.links)),
										expected(chain, facts),
										`${nameOf(chain)}: each item with its seeds at every link, over ${Formatter.format(facts)}`
									)
									c.note(linkFeature[chain.links])
									if (chain.rows === "swapped") {
										c.note("a projection below the chain that renames its columns")
									}
								}
								c.noteAll(featuresOf(facts))
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the reads restated over the facts on the host: each item with its seeds of at least each link's index"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\tnode.kind === "Attach" ? attachmentHead(node.parent) : node\n',
				replacement:
					'\tnode.kind === "Attach" || node.kind === "ProjectSet" ? attachmentHead(node.kind === "Attach" ? node.parent : node.input) : node\n',
				why: "The chain's head is found past a projection below it that renames its columns: each link's import is bound to the id column of the projection's input, the item's id where the delivered row's id is its kind, so the swapped chains deliver the seeds of another id."
			}
		]
	})
