/**
 * The live leader's reading of a replication stream into route keys (packages/grizzle/src/adapter/live/changes.ts):
 * drawn pgoutput messages of one transaction over a routed table, a whole-read table, an unread table and the
 * installation's migrations ledger, read by the transaction reader, against the coverage rule restated over the drawn
 * changes.
 *
 * - Each change of a routed table is, for each side it carries, the keyed key at that side's value of the routed column
 *   where the side says it, and the table's key where it does not: a NULL, a TOASTed value left unchanged, a column a
 *   key-only old image leaves out, an update's old side with no old image beyond its key. A change of a table read whole
 *   is its table's key; of an unread table, nothing; of the ledger, whatever row it writes, `migrated`, a migration.
 *   Oracle: the rule, restated over the drawn change, a second implementation.
 *
 * Features: an insert, an update with a whole old image, one with a key-only image, one with none, a delete, a NULL
 * routed value, an unchanged TOASTed value, a change of a whole-read table, of an unread table, and of the ledger.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { transactionReader } from "#adapter/live/changes.ts"
import type { Message } from "#adapter/live/pgoutput.ts"
import { lengthHashedKeyings, longFamily } from "#test/support/kernel/long-keys.ts"
import {
	type Change,
	changeGen,
	expectedOf,
	type Feature,
	ledger,
	ledgerId,
	messageOf,
	relationMessages,
	routedId,
	tables,
	textsOf,
	unreadId,
	wholeId
} from "#test/unit/live/changes.fixtures.ts"

/**
 * The live leader's reading of a replication stream a transaction's keys are the coverage rule's.
 *
 * Budget: its suite's count before the conversion (unit/live/changes: 500 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLiveLeadersReadingOfAReplicationStreamATransactionsKeysAreTheCoverageRules =
	property.explore((s) => ({ steps: s.draw(array(changeGen, { min: 1, max: 6 })) }), {
		needs: {},
		situations: [
			"an insert",
			"an update with a whole old image",
			"an update with a key-only image",
			"an update with none",
			"a delete",
			"a NULL routed value",
			"an unchanged TOASTed value",
			"a change of a whole-read table",
			"a change of an unread table",
			"a change of the ledger"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, c: Case<Feature>) =>
			({ steps }) =>
				Effect.sync(() => {
					const reader = transactionReader(tables, ledger)
					const messages: ReadonlyArray<Message> = [
						...relationMessages,
						{ kind: "begin", xid: 9 },
						...Arr.map(steps, messageOf),
						{ kind: "commit", endLsn: 42n }
					]
					const read = Arr.flatMap(messages, (message) => {
						const transaction = reader.read(message)
						assert.ok(Result.isSuccess(transaction), "every drawn message is read")
						return transaction.success === undefined ? [] : [transaction.success]
					})
					assert.equal(read.length, 1, "the stream holds one transaction")
					const [transaction] = read
					assert.ok(transaction !== undefined, "one transaction")
					assert.equal(transaction.xid, 9)
					assert.equal(transaction.endLsn, 42n)
					assert.deepEqual(
						textsOf(transaction.notifications),
						textsOf(Arr.flatMap(steps, expectedOf)),
						"the transaction's keys are the rule's"
					)
					for (const change of steps) {
						if (change.relation === wholeId) {
							c.note("a change of a whole-read table")
						}
						if (change.relation === unreadId) {
							c.note("a change of an unread table")
						}
						if (change.relation === ledgerId) {
							c.note("a change of the ledger")
						}
						switch (change.kind) {
							case "insert":
								c.note("an insert")
								break
							case "update":
								c.note(
									change.old.image === "whole"
										? "an update with a whole old image"
										: change.old.image === "key"
											? "an update with a key-only image"
											: "an update with none"
								)
								break
							case "delete":
								c.note("a delete")
								break
						}
						const next = change.kind === "delete" ? undefined : change.next
						if (next?.kind === "null") {
							c.note("a NULL routed value")
						}
						if (next?.kind === "unchanged") {
							c.note("an unchanged TOASTed value")
						}
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the coverage rule over the drawn changes"
		},
		budget: { runs: 500, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/changes.ts",
				original:
					"\t\t\t\t\tmessage.name === ledger\n\t\t\t\t\t\t? ledgerRoutes\n\t\t\t\t\t\t: relationRoutes(tables, message.name, message.columns)",
				replacement: "\t\t\t\t\trelationRoutes(tables, message.name, message.columns)",
				why: "The ledger is read as a table no program reads, so a migration ends no live read; the change property fails."
			}
		]
	})

/**
 * The live leader keys no native Map or Set by a transaction's key V8 hashes by its length alone: a transaction of one
 * to six inserts into the routed table, each routed value one of a family of two to four distinct texts of one length
 * past 16,383 units (kernel/long-keys.ts longFamily), is read to its keys, each value's keyed key once, and no native
 * Map or Set was keyed by such a text (kernel/long-keys.ts lengthHashedKeyings): a transaction's keys are held once
 * each by their text as an identity, in a TextsMap (core/text.ts), which hashes it by its digest, where a native Map of
 * the texts would be one chain, each insert comparing its key with every key of the chain.
 *
 * Budget: 40 independent cases and 0 steered, each a few long values.
 */
export const theLiveLeaderKeysNoNativeMapByATransactionsKeyV8HashesByItsLength = property.explore(
	(s) => {
		const family = longFamily(s.draw(int(2, 4)))
		return {
			family,
			values: s.draw(array((t) => t.draw(int(0, family.length - 1)), { min: 1, max: 6 }))
		}
	},
	{
		needs: {},
		situations: ["one value inserted twice", "several values"] satisfies ReadonlyArray<
			Reached<"one value inserted twice" | "several values">
		>,
		check:
			(_, c: Case<"one value inserted twice" | "several values">) =>
			({ family, values }) =>
				Effect.gen(function* () {
					const steps: ReadonlyArray<Change> = Arr.map(values, (at) => ({
						kind: "insert",
						relation: routedId,
						next: { kind: "text", text: family[at] ?? assert.fail("a value of the family") }
					}))
					const messages: ReadonlyArray<Message> = [
						...relationMessages,
						{ kind: "begin", xid: 9 },
						...Arr.map(steps, messageOf),
						{ kind: "commit", endLsn: 42n }
					]
					const [read, keyings] = yield* lengthHashedKeyings(
						Effect.sync(() => {
							const reader = transactionReader(tables, ledger)
							return Arr.flatMap(messages, (message) => {
								const transaction = reader.read(message)
								return Result.isSuccess(transaction) && transaction.success !== undefined
									? [transaction.success]
									: []
							})
						})
					)
					assert.equal(keyings, 0, "no native Map or Set keyed by a key past the hashed length")
					const [transaction] = read
					assert.ok(read.length === 1 && transaction !== undefined, "one transaction")
					assert.equal(
						transaction.notifications.length,
						new Set(values).size,
						"each value's key once"
					)
					assert.deepEqual(
						textsOf(transaction.notifications),
						textsOf(Arr.flatMap(steps, expectedOf)),
						"the transaction's keys are each value's keyed key"
					)
					c.note(
						new Set(values).size < values.length ? "one value inserted twice" : "several values"
					)
				}),
		oracle: {
			kind: "specification",
			name: "each routed value's keyed key once, no native keying by it"
		},
		budget: { runs: 40, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/text.ts",
				original: "\treturn mintTextsId({ texts, digest: digest >> 1, belowSurrogates })",
				replacement:
					'\treturn mintTextsId({ texts, digest: texts.join("\\u0000"), belowSurrogates })',
				why: "A TextsMap keys its buckets by an identity's texts joined, a native Map of strings, as a transaction's Map of keys by their text did: a transaction of values past the hashed length keys a native Map by each key, one chain."
			}
		]
	}
)
