/**
 * A call's facts past one share are drawn, bound and sent a share at a time (adapter/apply/shares.ts drawShares and
 * eachShare), so the host holds one share's bound facts and its statements' parameters, never every fact's: a call of
 * one, four and sixteen shares' worth of facts binds one share at a time, the next only once the last is sent and its
 * executions built, each share within one share's bytes, and the shares together every fact once, where binding every
 * share before sending any held them all at once (edullm's learning-commons split its release across child processes, a
 * whole release in one call past the 4 GiB heap). It counts the binder's own work, the shares bound and not yet sent
 * and each one's facts and bytes, never a collected heap's reading, whose timing the machine's load moves.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { writeBatching } from "#compiler/runtime/write/transport.ts"
import {
	type Drawn,
	drawnGen,
	type Feature,
	type Grouped,
	type GroupedFeature,
	groupedGen,
	runGrouped,
	runShares
} from "#test/unit/write/shares.fixtures.ts"

/** Each relation's rows by its name. */
const byRelation = Order.mapInput(
	Order.String,
	([relation]: readonly [string, unknown]) => relation
)

/**
 * A call of many shares' worth of facts holds on the host what a call of one share holds: one share bound at a time.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCallOfManySharesOfFactsHoldsOnTheHostWhatACallOfOneShareHolds = property.explore(
	drawnGen,
	{
		needs: {},
		situations: ["a narrow body", "a wide body"] satisfies ReadonlyArray<Feature>,
		check: (_, c: Case<Feature>) => (d: Drawn) =>
			Effect.map(runShares(d, c), ({ one, four, sixteen }) => {
				assert.ok(
					sixteen.shares >= 16 && four.shares >= 4,
					`${Formatter.format(d)}: the calls are drawn in ${four.shares} and ${sixteen.shares} shares`
				)
				for (const call of [one, four, sixteen]) {
					assert.equal(
						call.most,
						1,
						`${Formatter.format(d)}: a call of ${call.shares} shares binds ${call.most} at once`
					)
					assert.ok(
						Arr.every(call.held, (share) => share.bytes <= writeBatching.bytes),
						`${Formatter.format(d)}: a share of a call of ${call.shares} holds past one share's bytes: ${Formatter.format(call.held)}`
					)
					assert.equal(
						Arr.reduce(call.held, 0, (sum, share) => sum + share.facts),
						call.facts,
						`${Formatter.format(d)}: the shares of a call of ${call.shares} hold every fact once`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "bound: every call binds one share at a time, each within one share's bytes, the shares every fact once"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/shares.ts",
				original: "\t\tfor (const share of shares) {\n\t\t\tconst bound = yield* bind(share)",
				replacement:
					"\t\tconst all = yield* Effect.forEach(Arr.fromIterable(shares), bind)\n\t\tfor (const bound of all) {",
				why: "Every share is bound before any is sent, so the call holds every fact's bound form at once, sixteen shares' worth sixteen times one."
			}
		]
	}
)

/**
 * A call of learning-commons' families drawn in shares of whole groups fills every row as the whole call does: an
 * owner's ordered members, a tree's nodes and an area's counted members each in their owner's share, and a tree node's
 * counted marks in the share of its tree, so every count, end, slot and tree position the host draws is the whole
 * call's. qti-pie's import, pantry's Node trees and their Attributes, drawn in shares since PIN 3's admission rides the
 * flight (write/program/admission.ts), had each Attribute keyed by its node's `start`, which no tree root's fact
 * states, so a document's attributes went to shares apart from its tree, every node was inserted with an empty
 * `attrs`, and AL3 refused a package that holds every required attribute (QP-PUBFACTS, the drill's choice package).
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCallOfFamiliesDrawnInSharesOfWholeGroupsFillsEveryRowAsTheWholeCallDoes =
	property.explore(groupedGen, {
		needs: {},
		situations: [
			"a call of several shares",
			"a group past a share",
			"a tree's nodes and their marks past a share"
		] satisfies ReadonlyArray<GroupedFeature>,
		check: (_, c: Case<GroupedFeature>) => (d: Grouped) =>
			Effect.map(runGrouped(d, c), ({ whole, shared }) => {
				assert.deepEqual(
					Arr.sort([...shared], byRelation),
					Arr.sort([...whole], byRelation),
					`${Formatter.format(d)}: the shares' inserted rows are the whole call's`
				)
			}),
		oracle: {
			kind: "universal",
			name: "every relation's rows the shares insert, as the host fills them, are the whole call's"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/write/shares.test.ts#aCallOfFamiliesDrawnInSharesOfWholeGroupsFillsEveryRowAsTheWholeCallDoes@small-stack:7.0:0.0.0.0.0"
				),
				reason:
					"QP-PUBFACTS' refused import in miniature: two trees of three nodes, each node marked once, drawn in shares of 200 bytes. Keyed by the marks' (root, start), which no root's fact states, every mark went to a share apart from its tree, and each node was inserted with no marks and a weight of 0, as pantry's drill package's every Node was with an empty attrs, which AL3 refused (lvc-pin3-draft at grizzle 8aea9fea)",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/shares.ts",
				original: "\tconst holders = holdersBySlot(program)",
				replacement: "\tconst holders = new Map<string, ReadonlyArray<FamilyHolder>>()",
				why: "An area and its counted members are drawn as facts of their own, so a share holds an area with some of its members, and the host counts it at those alone."
			},
			{
				file: "packages/engine/src/write/program/decide.ts",
				original:
					'\t\tpairs.map((g) => defined(held.get(g[side].name), "a pair every holder holds"))',
				replacement: "\t\tfamily.group.map((g) => g[side].name)",
				why: "A family's facts are keyed by every field of its group, each by its own name, whether the fact holds it or not, as before QP-PUBFACTS: a tree root's fact holds no node's start, so a node's marks go to shares apart from its tree, and the node is inserted with no marks and a weight of 0."
			}
		]
	})
