import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { exact, ordered } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Data,
	Effect,
	Exit,
	Formatter,
	Layer,
	Option,
	Order,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	lawsOf,
	login,
	on,
	relation,
	role,
	roleNameOf,
	schema,
	schemaNameOf,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { levelNameAt } from "#test/support/oracle/install/real.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { loginLayer } from "#test/support/worlds.ts"

/**
 * One installation of two levels on PostgreSQL: a lower level `Lo` (a content model's items) and an upper level built
 * on it under its own name (sittings of those items), each in its own PostgreSQL schema, the upper level's sitting
 * contained in the lower level's item by a deferred foreign key across schemas over one contract domain, the root's.
 * A login over each level opens the one installation's snapshot: the lower one compiled from the lower level alone,
 * the upper one's role holding the lower level whole, read only, and writing only sittings.
 *
 * The oracle is the installed catalog and the rule restated over the facts:
 * - each level's table lives in its own level's PostgreSQL schema and in no other; the foreign key runs from the upper
 *   table to the lower one; both columns are of the one contract domain; the upper role holds no privilege on the lower
 *   table, nor the lower role on the upper one;
 * - a layer of a login over a lower level whose content differs from the installation's at that position is refused,
 *   whatever its name;
 * - each drawn transaction commits exactly when the state it leaves keeps the containment; a sitting of an item that is
 *   not there is refused by the containment as the upper level states it, and a deletion of an item a sitting holds,
 *   through the lower login, by that law named `above` the lower level, `{ kind: "above", level, law }`, the law as
 *   lawsOf(upper) lists it, witness unreported;
 * - after every transaction the upper role reads the fused query, sittings joined to their items, and a query over the
 *   lower level, the items, exactly as the facts hold them.
 */

const Code = contract("Code", uuid)
const Kind = closed("Kind", ["Practice", "Test"])
const Item = relation("Item", { id: Code, n: pg.integer }, ["id"])
const Sitting = relation("Sitting", { id: uuid, item: Code, kind: closedId(Kind) }, ["id"])

/** The two levels and their worlds under `name`, the upper level under its allocated name (levelNameAt). */
const levelsAt = (name: string) => {
	const lower = schema(name, { Kind, Item }, [])
	const upper = schema.extend(lower, levelNameAt(name, 1), { Sitting }, [
		contained(on(Sitting, "item"), on(Item, "id"))
	])
	const author = role(lower, "author", wholeEntriesOf(lower), { write: writableNamesOf(lower) })
	const learner = role(upper, "learner", wholeEntriesOf(upper), { write: ["Sitting"] })
	return {
		lower,
		upper,
		author,
		learner,
		authorApp: login(lower, "author_app", [author]),
		app: login(upper, "app", [learner])
	}
}

/** The lower level under `name` with another relation: another content at the root's position. */
const otherLowerAt = (name: string) => {
	const Other = relation("Other", { id: uuid }, ["id"])
	const lower = schema(name, { Kind, Item, Other }, [])
	const author = role(lower, "author", wholeEntriesOf(lower), { write: writableNamesOf(lower) })
	return login(lower, "author_app", [author])
}

/** The ids a case draws from: few, so sittings meet items and deletions meet references. */
const POOL = 4
const ids: Arr.NonEmptyReadonlyArray<Uuid> = [
	"00000000-0000-4000-8000-000000000000",
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
	"00000000-0000-4000-8000-000000000003"
]
const idAt = (i: number): Uuid => defined(ids[i], `id ${i} of the pool`)

type Op =
	| { readonly kind: "addItem"; readonly id: number; readonly n: number }
	| { readonly kind: "dropItem"; readonly id: number }
	| {
			readonly kind: "addSitting"
			readonly id: number
			readonly item: number
			readonly test: boolean
	  }
	| { readonly kind: "dropSitting"; readonly id: number }

const idGen: Gen<number> = int(0, POOL - 1)
const opGen: Gen<Op> = weighted<Op>([
	[3, (s) => ({ kind: "addItem", id: s.draw(idGen), n: s.draw(int(0, 9)) })],
	[2, (s) => ({ kind: "dropItem", id: s.draw(idGen) })],
	[
		3,
		(s) => ({
			kind: "addSitting",
			id: s.draw(idGen),
			item: s.draw(idGen),
			test: s.draw(element([false, true]))
		})
	],
	[1, (s) => ({ kind: "dropSitting", id: s.draw(idGen) })]
])
const historyGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 10 })

type Feature =
	| "an item added"
	| "an item deleted"
	| "a held item's deletion refused from above"
	| "a sitting added"
	| "a dangling sitting refused"
	| "a sitting deleted"
	| "a fused read of a sitting"

/** The facts the host holds: items by id with their n, sittings by id with their item and kind. */
interface Facts {
	readonly items: Map<number, number>
	readonly sittings: Map<number, { readonly item: number; readonly test: boolean }>
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

const disagreed = (message: string) => Effect.fail(new Disagreed({ message }))

/** A refusal names exactly `law`. */
const namesExactly = (
	outcome: { readonly kind: string },
	refused: ReadonlyArray<Law> | undefined,
	law: Law
): boolean =>
	outcome.kind === "invariant-rejected" &&
	refused?.length === 1 &&
	Option.isNone(exact(refused[0], law))

/** Rows of an id and an n, in id order. */
const byId = (rows: ReadonlyArray<{ readonly id: string; readonly n: number }>) =>
	Arr.sort(
		Arr.map(rows, (r) => ({ id: r.id, n: r.n })),
		Order.mapInput(Order.String, (r: { readonly id: string }) => r.id)
	)

layer(Substrate.layer, { excludeTestServices: true })(
	"levels of one installation on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"install each level in its own schema with a foreign key across them, serve a login over each level, and refuse a lower write a higher law forbids by that law named above",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const declared = levelsAt("Levels")
						const done = yield* installMigrated(declared.upper, {
							ambient: ordinarySession,
							label: "levels",
							logins: [declared.authorApp, declared.app],
							extensions: []
						})
						const at = levelsAt(done.schema)
						const lowerSchema = schemaNameOf(at.lower)
						const upperSchema = schemaNameOf(at.upper)
						const seat = yield* seatOfInstalled(done, ["Item", "Sitting"], "levels")
						const session = seat.session
						const one = (sql: string) =>
							Effect.map(session.values(sql, []), (rows) => String(rows[0]?.[0]))
						const quote = (s: string) => `'${Str.replaceAll("'", "''")(s)}'`
						const table = (schemaName: string, name: string) => quote(`"${schemaName}"."${name}"`)

						/** The catalog: each table in its level's schema, the foreign key across, one domain, no grant across. */
						const placed = yield* one(
							`SELECT concat_ws(',', to_regclass(${table(lowerSchema, "item")}) IS NOT NULL, to_regclass(${table(upperSchema, "sitting")}) IS NOT NULL, to_regclass(${table(lowerSchema, "sitting")}) IS NULL, to_regclass(${table(upperSchema, "item")}) IS NULL)`
						)
						assert.equal(placed, "t,t,t,t", "each table in its own level's schema")
						const across = yield* one(
							`SELECT count(*) FROM pg_catalog.pg_constraint WHERE contype = 'f' AND conrelid = ${table(upperSchema, "sitting")}::regclass AND confrelid = ${table(lowerSchema, "item")}::regclass AND condeferred`
						)
						assert.equal(
							across,
							"1",
							"one deferred foreign key from the upper table into the lower one"
						)
						const domains = yield* one(
							`SELECT (SELECT atttypid FROM pg_catalog.pg_attribute WHERE attrelid = ${table(lowerSchema, "item")}::regclass AND attname = 'id') = (SELECT atttypid FROM pg_catalog.pg_attribute WHERE attrelid = ${table(upperSchema, "sitting")}::regclass AND attname = 'item')`
						)
						assert.equal(domains, "true", "both columns of the root's one contract domain")
						const grants = yield* one(
							`SELECT concat_ws(',', has_table_privilege(${quote(roleNameOf(at.learner))}, ${table(lowerSchema, "item")}, 'SELECT,INSERT,UPDATE,DELETE'), has_table_privilege(${quote(roleNameOf(at.author))}, ${table(upperSchema, "sitting")}, 'SELECT,INSERT,UPDATE,DELETE'))`
						)
						assert.equal(grants, "f,f", "no privilege on the other level's table")

						/** A lower level of other content at the root's position is no level of the installation. */
						const other = yield* Effect.exit(
							Layer.build(loginLayer(done, otherLowerAt(done.schema)))
						)
						assert.equal(
							Exit.isFailure(other),
							true,
							"a login over a lower level of other content is refused"
						)

						const lowerContext = yield* Layer.build(loginLayer(done, at.authorApp))
						const upperContext = yield* Layer.build(loginLayer(done, at.app))
						const author = yield* Db.open(at.authorApp.roles.author, {}).pipe(
							Effect.provideContext(lowerContext)
						)
						const learner = yield* Db.open(at.app.roles.learner, {}).pipe(
							Effect.provideContext(upperContext)
						)
						const containment = defined(
							Arr.findFirst(lawsOf(at.upper), (l) => l.kind === "contained").pipe(
								Option.getOrUndefined
							),
							"the upper level states its containment"
						)
						const above: Law = {
							kind: "above",
							level: levelNameAt(done.schema, 1),
							law: containment
						}
						const fused = query(at.upper).rule((r) => {
							const { id, item, kind } = v(Sitting, "sitting")
							const { n } = v(Item, "item")
							return r
								.match(Sitting, { id, item, kind })
								.match(Item, { id: item, n })
								.find({ id, n })
						})
						const items = query(at.lower).rule((r) => {
							const { id, n } = v(Item, "item")
							return r.match(Item, { id, n }).find({ id, n })
						})

						return yield* explore(
							{
								suite: "pg/levels/levels",
								draw: drawn(historyGen),
								literal: Formatter.format,
								oracle: {
									kind: "specification",
									name: "the containment restated over the facts: a transaction commits exactly when the state it leaves keeps it, a refusal names its law as the level that states it, above the lower level for a lower write, and every read agrees with the facts"
								},
								coverage: required<Feature>(
									[
										"an item added",
										"an item deleted",
										"a held item's deletion refused from above",
										"a sitting added",
										"a dangling sitting refused",
										"a sitting deleted",
										"a fused read of a sitting"
									],
									{ cases: 60, sense: notesOnly }
								),
								kept: [],
								runs: 40,
								shrink: { kind: "bounded", candidates: 30 },
								concurrency: 1,
								steerEvery: 8,
								caseHang
							},
							(history, c) =>
								Effect.gen(function* () {
									yield* cleared(seat, ["Sitting", "Item"])
									const facts: Facts = { items: new Map(), sittings: new Map() }
									for (const op of history) {
										switch (op.kind) {
											case "addItem": {
												if (facts.items.has(op.id)) {
													continue
												}
												const outcome = yield* author.apply(
													ChangeSet.empty(at.lower).insert(Item, [
														{ id: Code(idAt(op.id)), n: op.n }
													]),
													{}
												)
												if (outcome.kind !== "accepted") {
													return yield* disagreed(
														`adding item ${op.id} answered ${Formatter.format(outcome)}`
													)
												}
												facts.items.set(op.id, op.n)
												c.note("an item added")
												break
											}
											case "dropItem": {
												const n = facts.items.get(op.id)
												if (n === undefined) {
													continue
												}
												const held = Arr.some([...facts.sittings.values()], (s) => s.item === op.id)
												const outcome = yield* author.apply(
													ChangeSet.empty(at.lower).delete(Item, [{ id: Code(idAt(op.id)), n }]),
													{}
												)
												if (held) {
													if (
														outcome.kind !== "invariant-rejected" ||
														outcome.witness.kind !== "unreported" ||
														!namesExactly(outcome, outcome.refused.laws, above)
													) {
														return yield* disagreed(
															`deleting held item ${op.id} answered ${Formatter.format(outcome)}, not a refusal by ${Formatter.format(above)}`
														)
													}
													c.note("a held item's deletion refused from above")
													break
												}
												if (outcome.kind !== "accepted") {
													return yield* disagreed(
														`deleting item ${op.id} answered ${Formatter.format(outcome)}`
													)
												}
												facts.items.delete(op.id)
												c.note("an item deleted")
												break
											}
											case "addSitting": {
												if (facts.sittings.has(op.id)) {
													continue
												}
												const outcome = yield* learner.apply(
													ChangeSet.empty(at.upper).insert(Sitting, [
														{
															id: idAt(op.id),
															item: Code(idAt(op.item)),
															kind: op.test ? "Test" : "Practice"
														}
													]),
													{}
												)
												if (!facts.items.has(op.item)) {
													if (
														!namesExactly(
															outcome,
															outcome.kind === "invariant-rejected"
																? outcome.refused.laws
																: undefined,
															containment
														)
													) {
														return yield* disagreed(
															`a sitting of absent item ${op.item} answered ${Formatter.format(outcome)}, not a refusal by ${Formatter.format(containment)}`
														)
													}
													c.note("a dangling sitting refused")
													break
												}
												if (outcome.kind !== "accepted") {
													return yield* disagreed(
														`adding sitting ${op.id} answered ${Formatter.format(outcome)}`
													)
												}
												facts.sittings.set(op.id, { item: op.item, test: op.test })
												c.note("a sitting added")
												break
											}
											case "dropSitting": {
												const s = facts.sittings.get(op.id)
												if (s === undefined) {
													continue
												}
												const outcome = yield* learner.apply(
													ChangeSet.empty(at.upper).delete(Sitting, [
														{
															id: idAt(op.id),
															item: Code(idAt(s.item)),
															kind: s.test ? "Test" : "Practice"
														}
													]),
													{}
												)
												if (outcome.kind !== "accepted") {
													return yield* disagreed(
														`deleting sitting ${op.id} answered ${Formatter.format(outcome)}`
													)
												}
												facts.sittings.delete(op.id)
												c.note("a sitting deleted")
												break
											}
										}
										const joined = yield* (yield* learner.execute(fused, {})).collect
										const expectedJoin = byId(
											Arr.map([...facts.sittings], ([id, sitting]) => ({
												id: idAt(id),
												n: defined(facts.items.get(sitting.item), "a held item")
											}))
										)
										const joinDiffers = ordered(exact)(byId(joined), expectedJoin)
										if (Option.isSome(joinDiffers)) {
											return yield* disagreed(`the fused read: ${joinDiffers.value}`)
										}
										if (expectedJoin.length > 0) {
											c.note("a fused read of a sitting")
										}
										const read = yield* (yield* learner.execute(items, {})).collect
										const expectedItems = byId(
											Arr.map([...facts.items], ([id, n]) => ({ id: idAt(id), n }))
										)
										const itemsDiffer = ordered(exact)(byId(read), expectedItems)
										if (Option.isSome(itemsDiffer)) {
											return yield* disagreed(
												`the lower level's query on the upper role: ${itemsDiffer.value}`
											)
										}
									}
								})
						)
					})
				)
		)
	}
)
