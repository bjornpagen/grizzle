import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { bindLength, bindOverrun } from "#adapter/wire/batch.ts"
import { type BindFeature, caseGen, pgBind } from "#test/unit/adapter/bind.fixtures.ts"

/**
 * A statement's Bind message is as long as pg writes it, and a flight is refused before it is sent exactly at its
 * first message past the limit.
 *
 * Budget: its suite's count before the conversion (unit/adapter/bind-length: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aStatementsBindMessageIsAsLongAsPgWritesItAndAFlightIsRefusedBeforeItIsSentExactlyAtItsFirstMessagePastTheLimit =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"refused at the first statement",
			"refused at a later statement",
			"admitted at exactly the limit",
			"admitted below the limit"
		] satisfies ReadonlyArray<Reached<BindFeature>>,
		check: (_, k: Case<BindFeature>) => (c) =>
			Effect.sync(() => {
				const lengths = Arr.map(c.statements, (statement) => {
					const sent = pgBind(statement)
					assert.equal(sent[0], 0x42, "a Bind message")
					const declared = sent.readInt32BE(1)
					assert.equal(sent.length, 1 + declared, "its length word counts all but its type byte")
					assert.equal(bindLength(statement), declared)
					return declared
				})
				const chosen = defined(lengths[c.at % lengths.length], "the statement the limit falls by")
				const limit =
					c.limit === "short of" ? chosen - 1 : c.limit === "at" ? chosen : chosen + c.past
				const first = Arr.findFirstIndex(lengths, (bytes) => bytes > limit)
				const refused = bindOverrun(c.statements, limit)
				if (Option.isNone(first)) {
					assert.equal(refused, undefined, `no message is longer than ${limit}`)
					k.note(
						Arr.contains(lengths, limit)
							? "admitted at exactly the limit"
							: "admitted below the limit"
					)
					return
				}
				assert.deepEqual(refused?.bound, {
					kind: "message",
					statement: first.value,
					bytes: defined(lengths[first.value]),
					limit
				})
				k.note(
					first.value === 0 ? "refused at the first statement" : "refused at a later statement"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "pg's own Connection writing each Bind message, its length word the length"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/batch.ts",
				original: "\t\tif (bytes > limit) {",
				replacement: "\t\tif (bytes >= limit) {",
				why: "A Bind message exactly as long as the limit is refused."
			}
		]
	})
