/**
 * A family's owner written through a role's query entry, on PostgreSQL 19, through grizzle's own apply: Stores own a
 * counted family of Items (test/support/families/entry-owner.ts), and each declared shape of the entry-owner box is a
 * role writing Store through its entry over the north stores, its head holding none, either or both of the family's
 * count and stock, its filter the fixed region alone or the free label too (`label` is never "zz"); a keeper writes
 * Store and Item whole.
 *
 * A case draws a stored state, stores at three keys, each absent or in a region under a label with up to two Items,
 * and one write through one entry role: an insert, a put or a delete of a store at a stored or a fresh key, under a
 * label the label filter admits or refuses. The oracle is a model of the entry over the family: the role sees exactly
 * the north stores its filter admits; an insert or a put of a fact outside the entry is `outside-world`; one at a key a
 * store the role cannot see holds is `invariant-rejected` on Store's key, as is an insert at a key a visible store holds
 * under another label; a put of a visible store sets its label and leaves its count, its stock and its Items as they
 * are; a fresh store is inserted with no Item, its count and stock at their starts; a delete of a visible store with
 * Items is `invariant-rejected` on its family's laws, and of one the role cannot see is `no-change`, as is every write
 * that leaves the stores as they were, an insert of a visible store under its own label among them. A case that is both
 * outside the entry and at an unseen store's key may report either, as the README promises.
 */
import { layer } from "@effect/vitest"
import { drawn as drawnCase, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { type AnySchema, login, role } from "#compiler/public/schema.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { assert, deepEquals, defined } from "#test/support/assert.ts"
import {
	entryName,
	entryRole,
	type Filter,
	type Holds,
	type Op,
	roleName,
	shopOf
} from "#test/support/families/entry-owner.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { applyRuntime } from "#test/support/runtime-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayer } from "#test/support/worlds.ts"
import type { BuiltRole } from "#test/support/worlds/execute/build.ts"

const holdsAll = ["neither", "count", "end", "both"] as const
const statedFilters = ["region", "label"] as const

/** The uuid of the `n`th key of a kind: stores 0x0, items 0xa0. */
const uuidAt = (base: number, n: number): Uuid =>
	`00000000-0000-4000-8000-${Str.padStart(12, "0")((base + n).toString(16))}`

type Region = "north" | "south"
type Label = "a" | "b" | "zz"

interface StoredStore {
	readonly key: number
	readonly region: Region
	readonly label: Label
	readonly qtys: ReadonlyArray<number>
}

interface Write {
	readonly holds: Holds
	readonly filter: Extract<Filter, "region" | "label">
	readonly op: Op
	readonly key: number
	readonly label: Label
}

interface EntryCase {
	readonly stores: ReadonlyArray<StoredStore>
	readonly write: Write
}

const caseGen: Gen<EntryCase> = (source) => {
	const stores = Arr.flatMap(Arr.range(1, 3), (key): ReadonlyArray<StoredStore> =>
		source.draw(element([true, false] as const))
			? [
					{
						key,
						region: source.draw(element(["north", "south"] as const)),
						label: source.draw(element(["a", "b", "zz"] as const)),
						qtys: source.draw(array(int(0, 3), { min: 0, max: 2 }))
					}
				]
			: []
	)
	return {
		stores,
		write: {
			holds: source.draw(element(holdsAll)),
			filter: source.draw(element(statedFilters)),
			op: source.draw(element(["insert", "put", "delete"] as const)),
			key: source.draw(int(1, 4)),
			label: source.draw(element(["a", "b", "zz"] as const))
		}
	}
}

/** A store's row as the model holds it and the table reads back: id, region, label, count and stock. */
type Row = ReadonlyArray<string>

const rowOf = (s: StoredStore): Row => [
	uuidAt(0, s.key),
	s.region,
	s.label,
	String(s.qtys.length),
	String(Arr.reduce(s.qtys, 0, (sum, q) => sum + q))
]

/** What the model expects of a write: its outcome's kind, with the laws it is refused on, and the stores it leaves. */
type Expected =
	| { readonly kind: "accepted"; readonly stores: ReadonlyArray<StoredStore> }
	| { readonly kind: "key law" }
	| { readonly kind: "family laws" }
	| { readonly kind: "outside" }
	| { readonly kind: "outside or key law" }

type Feature =
	| `${Op}: ${"a visible store" | "an unseen store" | "a fresh key"}`
	| `${"insert" | "put"} of a fact outside the entry`
	| "a delete of a visible store with Items"
	| `a head holding ${Holds}`

const expectedOf = (c: EntryCase): { readonly expected: Expected; readonly situation: Feature } => {
	const w = c.write
	const inside = (region: Region, label: Label): boolean =>
		region === "north" && (w.filter !== "label" || label !== "zz")
	const stored = Arr.findFirst(c.stores, (s) => s.key === w.key)
	const others = Arr.filter(c.stores, (s) => s.key !== w.key)
	const where = Option.match(stored, {
		onNone: () => "a fresh key" as const,
		onSome: (s) =>
			inside(s.region, s.label) ? ("a visible store" as const) : ("an unseen store" as const)
	})
	const situation: Feature = `${w.op}: ${where}`
	if (w.op === "delete") {
		if (
			Option.isNone(stored) ||
			!inside(stored.value.region, stored.value.label) ||
			stored.value.label !== w.label
		) {
			return { expected: { kind: "accepted", stores: c.stores }, situation }
		}
		return Arr.isReadonlyArrayNonEmpty(stored.value.qtys)
			? { expected: { kind: "family laws" }, situation: "a delete of a visible store with Items" }
			: { expected: { kind: "accepted", stores: others }, situation }
	}
	const outside = !inside("north", w.label)
	if (Option.isSome(stored) && !inside(stored.value.region, stored.value.label)) {
		return { expected: outside ? { kind: "outside or key law" } : { kind: "key law" }, situation }
	}
	if (outside) {
		return { expected: { kind: "outside" }, situation: `${w.op} of a fact outside the entry` }
	}
	if (Option.isNone(stored)) {
		return {
			expected: {
				kind: "accepted",
				stores: [...c.stores, { key: w.key, region: "north", label: w.label, qtys: [] }]
			},
			situation
		}
	}
	if (w.op === "insert" && stored.value.label !== w.label) {
		return { expected: { kind: "key law" }, situation }
	}
	return {
		expected: {
			kind: "accepted",
			stores: [...others, { ...stored.value, label: w.label }]
		},
		situation
	}
}

/** The version under the declared name `name`: the box's schema, an entry role per declared shape and the keeper. */
const versionOf = (name: string) => {
	const built = shopOf(name)
	const base: AnySchema = built.shop
	const writers = new Map(
		Arr.flatMap(holdsAll, (holds) =>
			Arr.map(
				statedFilters,
				(filter) => [roleName(holds, filter), entryRole(built, holds, filter)] as const
			)
		)
	)
	const wholes: Readonly<Record<string, EntryValue>> = { Store: built.Store, Item: built.Item }
	const write: ReadonlyArray<string> = ["Store", "Item"]
	const keeper: BuiltRole = role(base, "keeper", wholes, { write })
	const roles: readonly [BuiltRole, ...Array<BuiltRole>] = [keeper, ...writers.values()]
	return {
		built,
		keeper,
		writers,
		login: login<AnySchema, string, readonly [BuiltRole, ...Array<BuiltRole>]>(base, "desk", roles)
	}
}

type Built = ReturnType<typeof versionOf>

layer(Substrate.layer, { excludeTestServices: true })(
	"a family's owner written through a role's query entry on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"inserts, puts and deletes the north stores each entry sees as the model of the entry over the family states, leaving every count, stock and Item as the family holds them",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const substrate = yield* Substrate
						let version: Built | undefined
						const m = yield* migrated({
							label: "entry_owner",
							schemaName: { kind: "unique" },
							first: (name: string): Version => {
								version = versionOf(name)
								return { schema: version.built.shop, logins: [version.login] }
							},
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: Option.none()
						})
						const b = defined(version, "the version")
						const names = namesOf(m)
						const store = names.table(b.built.Store)
						const items = names.table(b.built.Item)
						const sc = (f: "id" | "region" | "label" | "items" | "stock") =>
							names.column(b.built.Store, f)
						const owner = yield* substrate.session({ ...ownerSession(), label: "entry owner" })
						const rows = Effect.map(
							owner.values(
								`SELECT ${sc("id")}::text, ${sc("region")}, ${sc("label")}, ${sc("items")}::text, ${sc("stock")}::text FROM ${store} ORDER BY 1`,
								[]
							),
							(read): ReadonlyArray<Row> => Arr.map(read, (row) => Arr.map(row, String))
						)
						const itemCount = Effect.map(
							owner.values(`SELECT count(*)::text FROM ${items}`, []),
							(read) => String(read[0]?.[0])
						)
						return yield* Effect.gen(function* () {
							const keeper = yield* Db.open(defined(b.login.roles["keeper"], "the keeper"), {})
							const opened = yield* Effect.forEach(b.writers.keys(), (name) =>
								Effect.map(
									Db.open(defined(b.login.roles[name], "an entry role"), {}),
									(db) => [name, db] as const
								)
							)
							const writers = new Map(opened)
							return yield* explore(
								{
									suite: "write/entry-owner",
									draw: drawnCase(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "second-implementation",
										name: "a model of the entry over the family: the north stores its filter admits, put in place, inserted at the family's starts, deleted only without Items"
									},
									coverage: required<Feature>(
										[
											...Arr.flatMap(["insert", "put", "delete"] as const, (op) =>
												Arr.map(
													["a visible store", "an unseen store", "a fresh key"] as const,
													(where): Feature => `${op}: ${where}`
												)
											),
											"insert of a fact outside the entry",
											"put of a fact outside the entry",
											"a delete of a visible store with Items",
											...Arr.map(holdsAll, (holds): Feature => `a head holding ${holds}`)
										],
										{ cases: 120, sense: notesOnly }
									),
									kept: [],
									runs: 32,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 8,
									caseHang
								},
								(c, run) =>
									Effect.gen(function* () {
										yield* owner.query(`TRUNCATE ${store}, ${items}`, [])
										const seeded = yield* applyRuntime(
											keeper,
											changeSetOver
												.empty(b.keeper)
												.insert(
													defined(b.keeper.relations["Store"], "the keeper's Store"),
													Arr.map(c.stores, (s) => ({
														id: uuidAt(0, s.key),
														region: s.region,
														label: s.label
													}))
												)
												.insert(
													defined(b.keeper.relations["Item"], "the keeper's Item"),
													Arr.flatMap(c.stores, (s) =>
														Arr.map(s.qtys, (qty, i) => ({
															id: uuidAt(0xa0, s.key * 4 + i),
															store: uuidAt(0, s.key),
															region: s.region,
															qty: BigInt(qty)
														}))
													)
												),
											{}
										)
										assert.equal(
											seeded.kind,
											Arr.isReadonlyArrayNonEmpty(c.stores) ? "accepted" : "no-change",
											"the keeper's state"
										)
										const before = yield* itemCount
										const w = c.write
										const writer = defined(writers.get(roleName(w.holds, w.filter)), "the writer")
										const writerRole = defined(
											b.writers.get(roleName(w.holds, w.filter)),
											"the writer's role"
										)
										const relation = defined(
											writerRole.relations[entryName(w.holds, w.filter)],
											"the writer's entry"
										)
										const fact = { id: uuidAt(0, w.key), label: w.label }
										const empty = changeSetOver.empty(writerRole)
										const changes =
											w.op === "insert"
												? empty.insert(relation, [fact])
												: w.op === "put"
													? empty.put(relation, [fact])
													: empty.delete(relation, [fact])
										const outcome = yield* applyRuntime(writer, changes, {})
										const after = yield* rows
										const stored = Arr.sort(
											Arr.map(c.stores, rowOf),
											Order.mapInput(Order.String, (r: Row) => defined(r[0], "a store's id"))
										)
										const { expected, situation } = expectedOf(c)
										const laws =
											outcome.kind === "invariant-rejected"
												? Arr.sort(
														Arr.map(outcome.refused.laws, (l) => l.kind),
														Order.String
													)
												: []
										const what = `${Formatter.format(c)}: ${outcome.kind} ${Formatter.format(laws)}, leaving ${Formatter.format(after)}`
										switch (expected.kind) {
											case "accepted": {
												const left = Arr.sort(
													Arr.map(expected.stores, rowOf),
													Order.mapInput(Order.String, (r: Row) => defined(r[0], "a store's id"))
												)
												assert.deepEqual(after, left, what)
												assert.equal(
													outcome.kind,
													deepEquals(left, stored) ? "no-change" : "accepted",
													what
												)
												break
											}
											case "key law":
												assert.deepEqual(
													[outcome.kind, laws],
													["invariant-rejected", ["primaryKey"]],
													what
												)
												break
											case "family laws":
												assert.deepEqual(
													[outcome.kind, laws],
													["invariant-rejected", ["contained", "family"]],
													what
												)
												break
											case "outside":
												assert.equal(outcome.kind, "outside-world", what)
												break
											case "outside or key law":
												assert.ok(
													outcome.kind === "outside-world" ||
														(outcome.kind === "invariant-rejected" &&
															Arr.contains(laws, "primaryKey")),
													what
												)
												break
										}
										if (expected.kind !== "accepted") {
											assert.deepEqual(after, stored, what)
										}
										const itemsAfter = yield* itemCount
										assert.equal(itemsAfter, before, `${what}: the Items`)
										run.note(situation)
										run.note(`a head holding ${w.holds}`)
									})
							)
						}).pipe(Effect.scoped, withLayer(loginLayer(m, b.login)))
					}).pipe(Effect.scoped)
				)
		)
	}
)
