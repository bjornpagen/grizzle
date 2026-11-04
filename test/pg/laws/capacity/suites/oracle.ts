import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order, Schema } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { installCapacity, writerOf } from "#test/pg/laws/capacity/support.ts"
import { assert, contains, defined } from "#test/support/assert.ts"
import {
	capacity,
	contained,
	f,
	mutable,
	on,
	onSelected,
	relation,
	type SchemaDesc,
	within
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { pgErrorFields, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The foreign key, by its role in the expected outcomes. */
const containment = "containment"

/** The rows of Pool and of Item, as PostgreSQL returns them: (id, low, high, open) and (id, pool, weight, live). */
const decodeRows = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Tuple([Schema.Int, Schema.Int, Schema.Int, Schema.Boolean]))
)

const poolWeights = capacity(
	onSelected("Pool", ["id"], { open: true }),
	onSelected("Item", ["pool"], { live: true }),
	within("low", "high"),
	{ kind: "field", field: "weight" }
)

const poolItems = capacity(on("Pool", ["id"]), on("Item", ["pool"]), within(0n, 2n), {
	kind: "count"
})

/** Which of Pool and Item a variant declares mutable: a relation not mutable takes no UPDATE. */
interface PoolsMutability {
	readonly Pool: boolean
	readonly Item: boolean
}

/** A variant of the suite: its name, the mutability of its relations, and the schema name it installs under. */
interface PoolsVariant {
	readonly name: "immutable" | "mutable"
	readonly mutable: PoolsMutability
	readonly installAs: string
}

const variants: Arr.NonEmptyReadonlyArray<PoolsVariant> = [
	{ name: "immutable", mutable: { Pool: false, Item: false }, installAs: "cappooli" },
	{ name: "mutable", mutable: { Pool: true, Item: true }, installAs: "cappoolm" }
]

const pools = (m: PoolsMutability): SchemaDesc => ({
	name: "Pools",
	relations: [
		relation("Pool", { id: f.integer, low: f.integer, high: f.integer, open: f.boolean }, ["id"]),
		relation("Item", { id: f.integer, pool: f.integer, weight: f.integer, live: f.boolean }, ["id"])
	],
	statements: [
		poolWeights,
		poolItems,
		contained(on("Item", ["pool"]), on("Pool", ["id"])),
		...(m.Pool ? [mutable("Pool")] : []),
		...(m.Item ? [mutable("Item")] : [])
	],
	extends: undefined
})

/** The two laws, each read through the naming door from the capacity statement that declares it. */
const sumLaw: LawId = lawNamesOf(pools(variants[0].mutable)).lawOfDesc(poolWeights)
const countLaw: LawId = lawNamesOf(pools(variants[0].mutable)).lawOfDesc(poolItems)

type Op =
	| {
			readonly op: "insertPool"
			readonly id: number
			readonly low: number
			readonly span: number
			readonly open: boolean
	  }
	| {
			readonly op: "insertItem"
			readonly pool: number
			readonly weight: number
			readonly live: boolean
	  }
	| { readonly op: "deletePool"; readonly id: number }
	| { readonly op: "deleteItem"; readonly pick: number }
	| {
			readonly op: "updatePool"
			readonly id: number
			readonly low: number
			readonly span: number
			readonly open: boolean
	  }
	| { readonly op: "rekeyPool"; readonly id: number; readonly to: number }
	| { readonly op: "moveItem"; readonly pick: number; readonly pool: number }
	| {
			readonly op: "updateItem"
			readonly pick: number
			readonly pool: number
			readonly weight: number
			readonly live: boolean
	  }

const poolId = int(1, 4)
/** A pick of an item, resolved against the items stored when its transaction begins. */
const itemPick = int(0, 20)

/** A transaction's operations: insertions, deletions, and UPDATEs of the relations a variant declares mutable. */
const opGen = (m: PoolsMutability): Gen<Op> => {
	const base: Arr.NonEmptyReadonlyArray<Gen<Op>> = [
		(source) => ({
			op: "insertPool",
			id: source.draw(poolId),
			low: source.draw(int(-1, 4)),
			span: source.draw(int(-1, 6)),
			open: source.draw(boolean)
		}),
		(source) => ({
			op: "insertItem",
			pool: source.draw(poolId),
			weight: source.draw(int(-3, 5)),
			live: source.draw(boolean)
		}),
		(source) => ({ op: "deletePool", id: source.draw(poolId) }),
		(source) => ({ op: "deleteItem", pick: source.draw(itemPick) })
	]
	const poolUpdates: ReadonlyArray<Gen<Op>> = [
		(source) => ({
			op: "updatePool",
			id: source.draw(poolId),
			low: source.draw(int(-1, 4)),
			span: source.draw(int(-1, 6)),
			open: source.draw(boolean)
		}),
		(source) => ({ op: "rekeyPool", id: source.draw(poolId), to: source.draw(poolId) })
	]
	const itemUpdates: ReadonlyArray<Gen<Op>> = [
		(source) => ({ op: "moveItem", pick: source.draw(itemPick), pool: source.draw(poolId) }),
		(source) => ({
			op: "updateItem",
			pick: source.draw(itemPick),
			pool: source.draw(poolId),
			weight: source.draw(int(-3, 5)),
			live: source.draw(boolean)
		})
	]
	return oneOf(
		Arr.appendAll(base, [...(m.Pool ? poolUpdates : []), ...(m.Item ? itemUpdates : [])])
	)
}

/** A case: whether it starts from the populated lawful state, and its transactions. */
interface CapacityCase {
	readonly populated: boolean
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const capacityCaseGen = (m: PoolsMutability): Gen<CapacityCase> => {
	const transaction = array(opGen(m), { min: 1, max: 6 })
	return (source) => ({
		populated: source.draw(boolean),
		transactions: source.draw(array(transaction, { min: 1, max: 4 }))
	})
}

/** What a case reaches: its start, and each transaction's outcome. */
type CapacityOracleFeature = "accepted" | "rejected" | "populated start" | "empty start"

interface PoolRow {
	readonly id: number
	readonly low: number
	readonly high: number
	readonly open: boolean
}

interface ItemRow {
	readonly id: number
	readonly pool: number
	readonly weight: number
	readonly live: boolean
}

/** The brute-force evaluation of both laws and the containment on one state: what it violates. */
const violated = (
	poolRows: ReadonlyArray<PoolRow>,
	itemRows: ReadonlyArray<ItemRow>
): ReadonlyArray<string> => {
	const out = new Set<string>()
	if (Arr.some(itemRows, (i) => !Arr.some(poolRows, (p) => p.id === i.pool))) {
		out.add(containment)
	}
	for (const p of poolRows) {
		const group = Arr.filter(itemRows, (i) => i.pool === p.id)
		if (group.length > 2) {
			out.add(countLaw)
		}
		if (!p.open) {
			continue
		}
		const total = Arr.reduce(
			Arr.filter(group, (i) => i.live),
			0,
			(s, i) => s + i.weight
		)
		if (total < p.low || total > p.high) {
			out.add(sumLaw)
		}
	}
	return [...out]
}

/**
 * Generated transactions against two capacity laws sharing their tables.
 *
 * A law is a query that must be empty, so a transaction commits exactly when the brute-force evaluation of every
 * law on its final state finds no violation. Each case runs a few transactions in the schema's full role, each of
 * random insertions, updates, rekeys and deletions; before COMMIT the transaction reads its own final state, the host
 * evaluates both laws on it, and COMMIT must succeed exactly when both hold, or else raise 23000 with one of the two
 * laws' identities. Starting from the empty state, every accepted transaction leaves a lawful state for the next, as
 * the incremental checks assume.
 *
 * - `pool_open_true_item_live_true_weight`: for each open pool, the total weight of its live items lies within the
 *   pool's own `low` and `high`, both `ref` bounds over a field weight that may be negative.
 * - `pool_item_count`: every pool, open or not, holds at most two items, live or not.
 * - The containment the schema declares beside them: every item's pool exists, a deferred foreign key whose violation
 *   is a 23503 at COMMIT.
 *
 * Both relations are `mutable` in one variant and immutable in the other; the generator emits UPDATEs of a relation
 * only where the variant declares it mutable. The mutable variant also moves items between pools alone, so an old group left below its lower bound is judged: the
 * lower bounds are mostly positive, and a function that checked only a mover's new group would commit violations.
 * Cases are explored each from the empty state or a populated lawful one, and the population must reach
 * both starts and both outcomes.
 */
export const capacityOracleSuite = (): void => {
	layer(Substrate.layer)("capacity laws over generated transactions", (it) => {
		for (const variant of variants) {
			it.effect(`${variant.name}: a transaction commits iff its final state is lawful`, (ctx) =>
				searched(ctx, capacityOracle(variant))
			)
		}
	})
}

/** One variant's search: its schema installed, and its cases run by one writer. */
const capacityOracle = (variant: PoolsVariant) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const install = yield* installCapacity(pools(variant.mutable), variant.installAs)
		const residuals: ReadonlyArray<string> = Arr.sort(
			Arr.map(install.installation.laws.residuals, (r) => r.lawId),
			Order.String
		)
		assert.deepEqual(residuals, Arr.sort([countLaw, sumLaw], Order.String))
		const pool = install.table("Pool")
		const item = install.table("Item")
		const w = yield* writerOf(install, "writer")
		return yield* explore(
			{
				/**
				 * The owner's TRUNCATE fires no row trigger, so the empty state needs no law check.
				 *
				 * A populated case starts from a lawful state, through the law: four open pools within [1, 6],
				 * each holding one live item of weight 2. Moving such an item alone empties its old pool
				 * below the lower bound while the new pool stays lawful, so only the old group's check refuses
				 * it.
				 *
				 * A case that fails inside a transaction leaves none open for the next case's TRUNCATE.
				 */
				suite: `laws/capacity-oracle/${variant.name}`,
				draw: drawn(capacityCaseGen(variant.mutable)),
				literal: Formatter.format,
				kept: [],
				runs: 40,
				concurrency: 1,
				steerEvery: 16,
				/**
				 * Each candidate is a case against the server: a complete shrink of a failure only some runs reproduce never
				 * ends (laws/families/suites/family.ts), so it stops after 300.
				 */
				shrink: { kind: "bounded", candidates: 300 },
				coverage: required<CapacityOracleFeature>(
					["accepted", "rejected", "populated start", "empty start"],
					{ cases: 40, sense: notesOnly }
				),
				caseHang: Duration.minutes(2)
			},
			(k, c) =>
				Effect.gen(function* () {
					let nextItem = 1
					yield* admin.query(`TRUNCATE ${item}, ${pool}`, [])
					c.note(k.populated ? "populated start" : "empty start")
					if (k.populated) {
						yield* w.begin
						yield* w.query(
							`INSERT INTO ${pool} ("id", "low", "high", "open") VALUES (1, 1, 6, true), (2, 1, 6, true), (3, 1, 6, true), (4, 1, 6, true)`,
							[]
						)
						for (const p of [1, 2, 3, 4]) {
							yield* w.query(
								`INSERT INTO ${item} ("id", "pool", "weight", "live") VALUES (${nextItem++}, ${p}, 2, true)`,
								[]
							)
						}
						yield* w.commit
					}
					for (const ops of k.transactions) {
						const items = Arr.map(
							yield* admin.queryValues(`SELECT "id" FROM ${item} ORDER BY "id"`, []),
							(r) => Number(r[0])
						)
						const pick = (n: number): number => items[n % Math.max(items.length, 1)] ?? 0
						yield* w.begin
						/** The statement one operation of a transaction sends. */
						const statementOf = (o: (typeof ops)[number]): string => {
							switch (o.op) {
								case "insertPool":
									return `INSERT INTO ${pool} ("id", "low", "high", "open") VALUES (${o.id}, ${o.low}, ${o.low + o.span}, ${o.open}) ON CONFLICT DO NOTHING`
								case "insertItem":
									return `INSERT INTO ${item} ("id", "pool", "weight", "live") VALUES (${nextItem++}, ${o.pool}, ${o.weight}, ${o.live})`
								case "deletePool":
									return `DELETE FROM ${pool} WHERE "id" = ${o.id}`
								case "deleteItem":
									return `DELETE FROM ${item} WHERE "id" = ${pick(o.pick)}`
								case "updatePool":
									return `UPDATE ${pool} SET "low" = ${o.low}, "high" = ${o.low + o.span}, "open" = ${o.open} WHERE "id" = ${o.id}`
								case "rekeyPool":
									return `UPDATE ${pool} SET "id" = ${o.to} WHERE "id" = ${o.id} AND NOT EXISTS (SELECT 1 FROM ${pool} AS r1 WHERE r1."id" = ${o.to})`
								case "moveItem":
									return `UPDATE ${item} SET "pool" = ${o.pool} WHERE "id" = ${pick(o.pick)}`
								case "updateItem":
									return `UPDATE ${item} SET "pool" = ${o.pool}, "weight" = ${o.weight}, "live" = ${o.live} WHERE "id" = ${pick(o.pick)}`
							}
						}
						for (const o of ops) {
							yield* w.query(statementOf(o), [])
						}
						const poolRows = yield* decodeRows(
							yield* w.values(`SELECT "id", "low", "high", "open" FROM ${pool}`, [])
						)
						const itemRows = yield* decodeRows(
							yield* w.values(`SELECT "id", "pool", "weight", "live" FROM ${item}`, [])
						)
						const expected = violated(
							Arr.map(poolRows, ([id, low, high, open]) => ({ id, low, high, open })),
							Arr.map(itemRows, ([id, p, weight, live]) => ({ id, pool: p, weight, live }))
						)
						const outcome = yield* Effect.match(w.commit, {
							onSuccess: () => ({ committed: true as const }),
							onFailure: (error) => ({ committed: false as const, error })
						})
						const describe = Formatter.format({ ops, poolRows, itemRows, expected })
						if (outcome.committed) {
							assert.deepEqual(expected, [], `committed a violation: ${describe}`)
							c.note("accepted")
							continue
						}
						assert.equal(Schema.is(TransactionRolledBack)(outcome.error), false, describe)
						const fields = pgErrorFields(outcome.error)
						if (fields?.code === "23503") {
							assert.equal(fields.constraint, install.foreignKey("Item"), describe)
							contains(expected, containment, `refused a contained state: ${describe}`)
						} else {
							assert.equal(fields?.code, "23000", describe)
							contains(
								expected,
								defined(fields?.constraint, describe),
								`refused a lawful state: ${describe}`
							)
						}
						c.note("rejected")
					}
				}).pipe(Effect.onError(() => Effect.ignore(w.rollback)))
		)
	})
