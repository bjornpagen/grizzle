/** What the properties of anchored.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, increasing, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { type EstimatedNode, planNodes } from "#bench/harness/explain.ts"
import { digestOf, queueSchema, SeatNo, Slot } from "#bench/queue/support/queue.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import { QueueKind, Resource } from "#test/support/fixtures/api/queue.ts"
import { seededTemplate } from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { volumeFill } from "#test/support/substrate/fill.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A deletion whose member is its relation's own facts reads that relation once.
 *
 * The work queue's claim deletes the Wanted facts its pick names: a member that matches Wanted and returns its fields.
 * The DELETE's target plays that match, so the deletion statement reads Wanted once, by its key, where comparing the
 * member against the relation read it twice, two index probes per claim. The same holds for every anchored member:
 * one joined to a relation parameter, and one that selects the relation's facts by a parameter.
 *
 * The queue schema is installed and loaded with enough Work and Wanted items that a
 * probe by key is far cheaper than a scan, and analyzed. Each member's ChangeSet is compiled against the installation
 * (`compileWrite`), and in one transaction the statements before its deletion that make the carriers it
 * reads run with fixed parameters; then its deletion is planned (EXPLAIN, FORMAT JSON) and the transaction rolled
 * back. A case draws the member's shape and every parameter's value: digests of loaded items and of none, a relation
 * parameter of no keys to several, the claim's kind, resource, slot, seat and instants; PostgreSQL plans the deletion
 * for those values, as a custom plan does. The property is the plan's contract, not its text: exactly one node reads
 * Wanted, and an index condition bounds it, whatever the values. Each shape is a required feature, as are a relation
 * parameter of no keys and one of several, and while one is pending a steered case is constructed to reach it (`aims`):
 * its shape, or the relation parameter's member with no keys or two to four.
 */
export type Shape =
	| "the claim's deletion of the Wanted items its pick names"
	| "a deletion of the Wanted items a relation parameter names"
	| "a deletion of the Wanted item a parameter selects"

export type AnchoredFeature =
	| `${Shape}: Wanted read once, by an index condition`
	| "a relation parameter of no keys"
	| "a relation parameter of several keys"

/** Wanted and Work items loaded, keyed by digest: enough that a probe per input row is the right join at any estimate of
 * a relation parameter's arrays, their length in a custom plan and the default ten in a generic one. */
const items = 200_000

/**
 * One member's shape, and every parameter any member reads, drawn: the plan is the deletion's for these values. An item
 * is named by its number, whose digest the load computes (digestOf): within the load for 1 to `items`, of no item
 * beyond.
 */
interface Anchored {
	readonly shape: Shape
	readonly keys: ReadonlyArray<number>
	readonly from: number
	readonly key: number
	readonly params: Readonly<Record<string, unknown>>
}

const itemGen = int(1, 2 * items)

const SHAPES: Arr.NonEmptyReadonlyArray<Shape> = [
	"the claim's deletion of the Wanted items its pick names",
	"a deletion of the Wanted items a relation parameter names",
	"a deletion of the Wanted item a parameter selects"
]

/** The member a relation parameter's keys reach the deletion through. */
export const named: Shape = "a deletion of the Wanted items a relation parameter names"

/** A relation parameter of no keys, and one of several. */
const noKeys = constant<ReadonlyArray<number>>([])

const severalKeys = increasing(1, 2 * items, { min: 2, max: 4 })

/** A relation parameter's keys: none, or one to four items. */
const keysGen = weighted<ReadonlyArray<number>>([
	[1, noKeys],
	[2, increasing(1, 2 * items, { min: 1, max: 4 })]
])

/** A case of a shape `shapes` draws and a relation parameter `keysOf` draws, every other parameter drawn. */
const anchoredOf =
	(shapes: Gen<Shape>, keysOf: Gen<ReadonlyArray<number>>): Gen<Anchored> =>
	(source) => {
		const shape = source.draw(shapes)
		const keys = source.draw(keysOf)
		return {
			shape,
			params: {
				kind: source.draw(element(QueueKind.handles)),
				slot: Slot(source.draw(int(0, 3))),
				now: Instant(BigInt(source.draw(int(0, 3)))),

				resource: source.draw(element(Resource.handles)),
				fromSeat: SeatNo(source.draw(int(0, 3))),
				expires: Instant(BigInt(source.draw(int(0, 3))))
			},
			keys,
			from: source.draw(itemGen),
			key: source.draw(itemGen)
		}
	}

export const anchoredGen: Gen<Anchored> = anchoredOf(element(SHAPES), keysGen)

/** The feature each shape's case reaches. */
export const readByIndex = (shape: Shape): AnchoredFeature =>
	`${shape}: Wanted read once, by an index condition`

/** The case each required feature is aimed at while it is pending, constructed to reach it: a witness whose turn aims at
 * one draws that case (aimed), the case it runs, prints and keeps. */
export const aims: Arr.NonEmptyReadonlyArray<readonly [AnchoredFeature, Gen<Anchored>]> = [
	["a relation parameter of no keys", anchoredOf(constant(named), noKeys)],
	["a relation parameter of several keys", anchoredOf(constant(named), severalKeys)],
	...Arr.map(SHAPES, (shape) => [readByIndex(shape), anchoredOf(constant(shape), keysGen)] as const)
]

/** Every node of a plan that reads `relation`'s rows: not the DELETE itself, nor a bitmap index scan, which only yields
 * row locations to its heap scan. */
export const reads = (plan: EstimatedNode, relation: string): ReadonlyArray<EstimatedNode> =>
	planNodes(plan)
		.filter(
			(n) =>
				Option.contains(n.relation, relation) &&
				Option.isNone(n.operation) &&
				n.nodeType !== "Bitmap Index Scan"
		)
		.toArray()

/** An index condition bounds the read: an Index Cond on an index scan, a Recheck Cond on a bitmap heap scan. */
export const bounded = (n: EstimatedNode): boolean =>
	((n.nodeType === "Index Scan" || n.nodeType === "Index Only Scan") &&
		Option.isSome(n.indexCond)) ||
	(n.nodeType === "Bitmap Heap Scan" && Option.isSome(n.recheckCond))

const item = "(g + 1)"

/** The relations whose user triggers the fill disables, as its search named them before its cases. */
const governed = ["Work", "Wanted"] as const

/**
 * The queue schema installed once per member with `items` rows of Work and Wanted filled under their user triggers
 * disabled, then vacuumed and analyzed, where the search did all of it once before its cases (install-migrate.ts
 * seededTemplate): each case only plans a deletion, inside a transaction it rolls back.
 */
export const queueTemplate = seededTemplate({
	declaredIn: import.meta,
	name: "anchored",
	schema: queueSchema("Queue"),
	options: { ambient: ordinarySession, label: "anchored", extensions: [], logins: [] },
	seed: (o) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const names = o.installation.names
			const table = (relation: string) => printObjectName(names.relation(relation))
			const column = (relation: string, field: string) => quoteIdent(names.column(relation, field))
			const codeIn = (roster: string, handle: string): string =>
				`${codeOf(defined(names.codes.rosters.get(parsedName(roster)), `the codes of ${roster}`), handle)}::smallint`
			yield* transaction(
				s.admin,
				Arr.map(governed, (t) => `ALTER TABLE ${table(t)} DISABLE TRIGGER USER`)
			)
			yield* volumeFill(s.admin, [
				{
					tables: [
						{
							table: table("Work"),
							columns: [
								[column("Work", "key"), digestOf(item)],
								[column("Work", "kind"), codeIn("Kind", "render")],
								[column("Work", "slot"), "0"],
								[column("Work", "standing"), codeIn("Standing", "wanted")],
								[column("Work", "epoch"), "0"],
								[column("Work", "enqueued"), item]
							]
						},
						{
							table: table("Wanted"),
							columns: [
								[column("Wanted", "key"), digestOf(item)],
								[column("Wanted", "due"), "0"],
								[column("Wanted", "attempts"), "0"]
							]
						}
					],
					rows: items,
					conflicts: "refused"
				}
			])
			yield* transaction(
				s.admin,
				Arr.map(governed, (t) => `ALTER TABLE ${table(t)} ENABLE TRIGGER USER`)
			)
			yield* s.admin.query(`VACUUM (ANALYZE) ${Arr.join(Arr.map(governed, table), ", ")}`, [])
		})
})
