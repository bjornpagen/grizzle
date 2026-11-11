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
 * - each drawn transaction commits exactly when the state it leaves keeps the containment; a sitting of an item that is
 *   not there is refused by the containment as the upper level states it, and a deletion of an item a sitting holds,
 *   through the lower login, by that law named `above` the lower level, `{ kind: "above", level, law }`, the law as
 *   lawsOf(upper) lists it, witness unreported;
 * - after every transaction the upper role reads the fused query, sittings joined to their items, and a query over the
 *   lower level, the items, exactly as the facts hold them, each read compared as the set it is.
 *
 * The catalog's facts are read by the names the compiler derives (core/identity.ts) for each level's schema, each
 * relation's table and each role, never spelled.
 *
 * Features: an item added and deleted, a held item's deletion refused from above, a sitting added and deleted, a
 * dangling sitting refused, and a fused read of a sitting.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): levels-above-unnamed (a law of a level above the one a layer serves is
 * named as that level's own law, not as a law above).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { exact, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Layer, Option, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
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
import { workload } from "#compiler/public/workload.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Code = contract("Code", uuid)
const Kind = closed("Kind", ["Practice", "Test"])
const Item = relation("Item", { id: Code, n: pg.integer }, ["id"])
const Sitting = relation("Sitting", { id: uuid, item: Code, kind: closedId(Kind) }, ["id"])

/**
 * The two levels and their worlds under `name`, the upper level under its allocated name (levelNameAt), each login's
 * workload holding its role's writes of the facts each call gives: the author adds and deletes items, and the learner
 * adds and deletes sittings and reads the fused query, sittings joined to their items, and the lower level's items.
 */
const levelsAt = (name: string) => {
	const lower = schema(name, { Kind, Item }, [])
	const upper = schema.extend(lower, levelNameAt(name, 1), { Sitting }, [
		contained(on(Sitting, "item"), on(Item, "id"))
	])
	const author = role(lower, "author", wholeEntriesOf(lower), { write: writableNamesOf(lower) })
	const learner = role(upper, "learner", wholeEntriesOf(upper), { write: ["Sitting"] })
	const fused = query(upper).rule((r) => {
		const { id, item, kind } = v(Sitting, "sitting")
		const { n } = v(Item, "item")
		return r.match(Sitting, { id, item, kind }).match(Item, { id: item, n }).find({ id, n })
	})
	const items = query(lower).rule((r) => {
		const { id, n } = v(Item, "item")
		return r.match(Item, { id, n }).find({ id, n })
	})
	return {
		lower,
		upper,
		author,
		learner,
		authorApp: login(lower, "author_app", [author], {
			workload: [
				workload(author, {
					addItem: ChangeSet.empty(lower).insert(Item, []),
					dropItem: ChangeSet.empty(lower).delete(Item, [])
				})
			]
		}),
		app: login(upper, "app", [learner], {
			workload: [
				workload(learner, {
					addSitting: ChangeSet.empty(upper).insert(Sitting, []),
					dropSitting: ChangeSet.empty(upper).delete(Sitting, []),
					fused,
					items
				})
			]
		})
	}
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

/** Rows of an id and an n, each as its plain fields, for a comparison as a set. */
const plain = (rows: ReadonlyArray<{ readonly id: string; readonly n: number }>) =>
	Arr.map(rows, (r) => ({ id: r.id, n: r.n }))

/** Two reads of rows of an id and an n agree as sets: each row once, in any order. */
const sameRows = set(structuralHash, exact)

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
						const quote = (text: string) => `'${Str.replaceAll("'", "''")(text)}'`
						/** A relation's table in a level's schema, both as the compiler names them, as a regclass literal. */
						const tableIn = (schemaName: string, relation: string) =>
							quote(
								`${quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaName))))}.${quoteIdent(identifierOf(identity.table(parsedName(relation))))}`
							)
						/** Whether a boolean the owner's session reads holds. */
						const holds = (sql: string) =>
							Effect.map(
								session.values(`SELECT (${sql})::text`, []),
								(rows) => rows[0]?.[0] === "true"
							)
						const lowerItem = tableIn(lowerSchema, "Item")
						const upperSitting = tableIn(upperSchema, "Sitting")
						const placed: ReadonlyArray<readonly [string, string]> = [
							[
								`to_regclass(${lowerItem}) IS NOT NULL`,
								"Item's table is in the lower level's schema"
							],
							[
								`to_regclass(${upperSitting}) IS NOT NULL`,
								"Sitting's table is in the upper level's schema"
							],
							[
								`to_regclass(${tableIn(lowerSchema, "Sitting")}) IS NULL`,
								"no Sitting in the lower level's schema"
							],
							[
								`to_regclass(${tableIn(upperSchema, "Item")}) IS NULL`,
								"no Item in the upper level's schema"
							],
							[
								`EXISTS (SELECT FROM pg_catalog.pg_constraint WHERE contype = 'f' AND conrelid = ${upperSitting}::regclass AND confrelid = ${lowerItem}::regclass AND condeferred)`,
								"a deferred foreign key runs from the upper table into the lower one"
							],
							[
								`(SELECT atttypid FROM pg_catalog.pg_attribute WHERE attrelid = ${lowerItem}::regclass AND attname = ${quote(identifierOf(identity.column(parsedName("id"))))}) = (SELECT atttypid FROM pg_catalog.pg_attribute WHERE attrelid = ${upperSitting}::regclass AND attname = ${quote(identifierOf(identity.column(parsedName("item"))))})`,
								"both columns are of the root's one contract domain"
							],
							[
								`NOT has_table_privilege(${quote(roleNameOf(at.learner))}, ${lowerItem}, 'SELECT,INSERT,UPDATE,DELETE')`,
								"the upper role holds no privilege on the lower table"
							],
							[
								`NOT has_table_privilege(${quote(roleNameOf(at.author))}, ${upperSitting}, 'SELECT,INSERT,UPDATE,DELETE')`,
								"the lower role holds no privilege on the upper table"
							]
						]
						for (const [fact, what] of placed) {
							const held = yield* holds(fact)
							assert.ok(held, what)
						}

						const lowerServed = yield* servedFixture(done, at.authorApp)
						const upperServed = yield* servedFixture(done, at.app)
						const lowerContext = yield* Layer.build(lowerServed.layer)
						const upperContext = yield* Layer.build(upperServed.layer)
						const author = yield* Db.open(lowerServed.login.roles.author, {}).pipe(
							Effect.provideContext(lowerContext)
						)
						const learner = yield* Db.open(upperServed.login.roles.learner, {}).pipe(
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
												const outcome = yield* author.workload.addItem.apply(
													{ insert: { Item: [{ id: Code(idAt(op.id)), n: op.n }] } },
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
												const outcome = yield* author.workload.dropItem.apply(
													{ delete: { Item: [{ id: Code(idAt(op.id)), n }] } },
													{}
												)
												if (held) {
													if (
														outcome.kind !== "invariant-rejected" ||
														outcome.witness.kind !== "unreported" ||
														!namesExactly(outcome, refusedLaws(outcome.refused), above)
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
												const outcome = yield* learner.workload.addSitting.apply(
													{
														insert: {
															Sitting: [
																{
																	id: idAt(op.id),
																	item: Code(idAt(op.item)),
																	kind: op.test ? "Test" : "Practice"
																}
															]
														}
													},
													{}
												)
												if (!facts.items.has(op.item)) {
													if (
														!namesExactly(
															outcome,
															outcome.kind === "invariant-rejected"
																? refusedLaws(outcome.refused)
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
												const outcome = yield* learner.workload.dropSitting.apply(
													{
														delete: {
															Sitting: [
																{
																	id: idAt(op.id),
																	item: Code(idAt(s.item)),
																	kind: s.test ? "Test" : "Practice"
																}
															]
														}
													},
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
										const joined = yield* (yield* learner.workload.fused.execute({})).collect
										const expectedJoin = plain(
											Arr.map([...facts.sittings], ([id, sitting]) => ({
												id: idAt(id),
												n: defined(facts.items.get(sitting.item), "a held item")
											}))
										)
										const joinDiffers = sameRows(plain(joined), expectedJoin)
										if (Option.isSome(joinDiffers)) {
											return yield* disagreed(`the fused read: ${joinDiffers.value}`)
										}
										if (expectedJoin.length > 0) {
											c.note("a fused read of a sitting")
										}
										const read = yield* (yield* learner.workload.items.execute({})).collect
										const expectedItems = plain(
											Arr.map([...facts.items], ([id, n]) => ({ id: idAt(id), n }))
										)
										const itemsDiffer = sameRows(plain(read), expectedItems)
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
