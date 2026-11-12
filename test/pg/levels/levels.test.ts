/**
 * One installation of two levels on PostgreSQL: a lower level `Lo` (a content model's items) and an upper level built
 * on it under its own name (sittings of those items), each in its own PostgreSQL schema, the upper level's sitting
 * contained in the lower level's item by a deferred foreign key across schemas over one contract domain, the root's.
 * A login over each level opens the one installation's snapshot: the lower one compiled from the lower level alone,
 * the upper one's role holding the lower level whole, read only, and writing only sittings. The installation is drafted
 * and served as `grizzle generate` drafts it with both logins (test/support/install-migrate.ts installGenerated), so it
 * holds the live source of the upper login's reads, and each login is served from the file generate wrote for it.
 *
 * The oracle is the installed catalog and the rule restated over the facts:
 * - the catalog, exhausted over its box: each declared relation's table lives in the schema of the level that declares
 *   it and in no other; each role holds a privilege on a table, or on a column of it, exactly when it writes its
 *   relation, reading every other through its views; a deferred foreign key runs from the upper table to the lower one; both columns are of the one contract
 *   domain;
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
 * Features: of the catalog, a table in its level's schema and none in another's, privileges on a written table and
 * none on another, the containment and its domain; of the transactions, an item added and deleted, a held item's
 * deletion refused from above, a sitting added and deleted, a dangling sitting refused, and a fused read of a sitting.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): levels-catalog-writer-ungranted (a writer is granted nothing on the
 * table it writes) and levels-above-unnamed (a law of a level above the one a layer serves is named as that
 * level's own law, not as a law above).
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { exact, set, structuralHash } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	String as Str
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { roleNameOf } from "#adapter/served/served.ts"
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
import { answered, rowsOf } from "#test/support/calls.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Code = contract("Code", uuid)
const Kind = closed("Kind", ["Practice", "Test"])
const Item = relation("Item", { id: Code, n: pg.integer }, ["id"])
const Sitting = relation("Sitting", { id: uuid, item: Code, kind: closedId(Kind) }, ["id"])

/** A level of the installation. */
type Level = "lower" | "upper"

/** A role of the installation, by the level whose login holds it. */
type LevelRole = "author" | "learner"

/**
 * The two levels and their worlds under `name`, the upper level under its allocated name (levelNameAt), each login's
 * workload holding its role's writes of the facts each call gives: the author adds and deletes items, and the learner
 * adds and deletes sittings and reads the fused query, sittings joined to their items, and the lower level's items.
 */
const levelsAt = (name: string) => {
	const lowerOwn = { Kind, Item }
	const upperOwn = { Sitting }
	const lower = schema(name, Rec.values(lowerOwn), [])
	const upper = schema.extend(lower, levelNameAt(name, 1), Rec.values(upperOwn), [
		contained(on(Sitting, "item"), on(Item, "id"))
	])
	const authorWrites = writableNamesOf(lower)
	const learnerWrites = ["Sitting"] as const
	const author = role(lower, "author", wholeEntriesOf(lower), { write: authorWrites })
	const learner = role(upper, "learner", wholeEntriesOf(upper), { write: learnerWrites })
	/** The relations each level declares itself, as its schema(...) or schema.extend(...) was given them. */
	const declares: { readonly [L in Level]: ReadonlyArray<string> } = {
		lower: Rec.keys(lowerOwn),
		upper: Rec.keys(upperOwn)
	}
	/** The relations each role writes, as its role(...) was given them. */
	const writes: { readonly [R in LevelRole]: ReadonlyArray<string> } = {
		author: authorWrites,
		learner: learnerWrites
	}
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
		declares,
		writes,
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
	outcome.kind === "refused" && refused?.length === 1 && Option.isNone(exact(refused[0], law))

/** Rows of an id and an n, each as its plain fields, for a comparison as a set. */
const plain = (rows: ReadonlyArray<{ readonly id: string; readonly n: number }>) =>
	Arr.map(rows, (r) => ({ id: r.id, n: r.n }))

/** Two reads of rows of an id and an n agree as sets: each row once, in any order. */
const sameRows = set(structuralHash, exact)

/**
 * A fact of the installed catalog the levels' declarations decide: a declared relation's table in a level's schema; a
 * role's privileges on a declared relation's table; the upper level's containment held by a deferred foreign key from
 * its table into the lower one; and its two columns of the root's one contract domain.
 */
type CatalogFact =
	| Readonly<{ kind: "placed"; relation: string; level: Level }>
	| Readonly<{ kind: "privileged"; role: LevelRole; relation: string }>
	| Readonly<{ kind: "containment" }>
	| Readonly<{ kind: "domain" }>

const levels = ["lower", "upper"] as const satisfies ReadonlyArray<Level>
const levelRoles = ["author", "learner"] as const satisfies ReadonlyArray<LevelRole>
const levelRelations: Arr.NonEmptyReadonlyArray<string> = [Item.name, Sitting.name]
const factKinds = ["placed", "privileged", "containment", "domain"] as const

/** Every fact of the box: each relation at each level, each role on each relation, and the two of the containment. */
const catalogFactGen: Gen<CatalogFact> = (source) => {
	const kind = source.draw(element(factKinds))
	switch (kind) {
		case "placed":
			return {
				kind,
				relation: source.draw(element(levelRelations)),
				level: source.draw(element(levels))
			}
		case "privileged":
			return {
				kind,
				role: source.draw(element(levelRoles)),
				relation: source.draw(element(levelRelations))
			}
		case "containment":
		case "domain":
			return { kind }
	}
}

type CatalogFeature =
	| "a table in its level's schema"
	| "no table in another level's schema"
	| "privileges on a table the role writes"
	| "no privilege on a table the role does not write"
	| "the containment across the levels"
	| "one contract domain across the levels"

/**
 * What the declarations say of a fact, and the situation it is: a relation's table is in a level's schema exactly when
 * that level declares the relation; a role holds a privilege on a table exactly when it writes the relation, reading
 * every other through its views; the containment and the domain hold.
 */
const expectedOf = (
	declared: ReturnType<typeof levelsAt>,
	fact: CatalogFact
): readonly [holds: boolean, situation: CatalogFeature] => {
	switch (fact.kind) {
		case "placed": {
			const holds = Arr.contains(declared.declares[fact.level], fact.relation)
			return [holds, holds ? "a table in its level's schema" : "no table in another level's schema"]
		}
		case "privileged": {
			const holds = Arr.contains(declared.writes[fact.role], fact.relation)
			return [
				holds,
				holds
					? "privileges on a table the role writes"
					: "no privilege on a table the role does not write"
			]
		}
		case "containment":
			return [true, "the containment across the levels"]
		case "domain":
			return [true, "one contract domain across the levels"]
	}
}

/** The installation of the two levels and their logins under an allocated name, and the levels under that name. */
const installedLevels = Effect.gen(function* () {
	const generated = yield* installGenerated(
		(name) => {
			const at = levelsAt(name)
			return { schema: at.upper, logins: [at.authorApp, at.app] }
		},
		{ label: "levels", ambient: ordinarySession }
	)
	const done = generated.installed
	return { generated, done, at: levelsAt(done.declared) }
})

layer(Substrate.layer, { excludeTestServices: true })(
	"levels of one installation on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"install each level's tables in its own schema, the containment across them over one domain, and grant each role exactly the tables it writes",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { done, at } = yield* installedLevels
						const seat = yield* seatOfInstalled(done, ["Item", "Sitting"], "levels")
						const quote = (text: string) => `'${Str.replaceAll("'", "''")(text)}'`
						const schemaOf: { readonly [L in Level]: string } = {
							lower: schemaNameOf(at.lower),
							upper: schemaNameOf(at.upper)
						}
						const roleOf: { readonly [R in LevelRole]: string } = {
							author: roleNameOf(at.author, {}),
							learner: roleNameOf(at.learner, {})
						}
						/** A relation's table in a level's schema, both as the compiler names them, as a regclass literal. */
						const tableIn = (level: Level, relation: string) =>
							quote(
								`${quoteIdent(identifierOf(identity.schema(parsedSchemaName(schemaOf[level]))))}.${quoteIdent(identifierOf(identity.table(parsedName(relation))))}`
							)
						const columnOf = (field: string) =>
							quote(identifierOf(identity.column(parsedName(field))))
						const lowerItem = tableIn("lower", Item.name)
						const upperSitting = tableIn("upper", Sitting.name)
						/** The boolean the catalog answers for a fact. */
						const sqlOf = (fact: CatalogFact): string => {
							switch (fact.kind) {
								case "placed":
									return `to_regclass(${tableIn(fact.level, fact.relation)}) IS NOT NULL`
								case "privileged": {
									const role = quote(roleOf[fact.role])
									const table = tableIn(
										Arr.contains(at.declares.lower, fact.relation) ? "lower" : "upper",
										fact.relation
									)
									return `has_table_privilege(${role}, ${table}, 'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege(${role}, ${table}, 'SELECT,INSERT,UPDATE')`
								}
								case "containment":
									return `EXISTS (SELECT FROM pg_catalog.pg_constraint WHERE contype = 'f' AND conrelid = ${upperSitting}::regclass AND confrelid = ${lowerItem}::regclass AND condeferred)`
								case "domain":
									return `(SELECT atttypid FROM pg_catalog.pg_attribute WHERE attrelid = ${lowerItem}::regclass AND attname = ${columnOf("id")}) = (SELECT atttypid FROM pg_catalog.pg_attribute WHERE attrelid = ${upperSitting}::regclass AND attname = ${columnOf("item")})`
							}
						}
						return yield* exhaust(
							{
								suite: "pg/levels/catalog",
								generator: catalogFactGen,
								literal: Formatter.format,
								box: "each declared relation at each level, each role on each declared relation, the containment and its domain",
								oracle: {
									kind: "postgresql",
									name: "the catalog read by the compiler's names, against what the levels' declarations and the roles' write lists state"
								},
								coverage: requiredInSpace<CatalogFeature>([
									"a table in its level's schema",
									"no table in another level's schema",
									"privileges on a table the role writes",
									"no privilege on a table the role does not write",
									"the containment across the levels",
									"one contract domain across the levels"
								]),
								caseHang
							},
							(fact, c) =>
								Effect.gen(function* () {
									const [expected, situation] = expectedOf(at, fact)
									const rows = yield* seat.session.values(`SELECT (${sqlOf(fact)})::text`, [])
									c.note(situation)
									assert.equal(rows[0]?.[0] === "true", expected, Formatter.format(fact))
								})
						)
					})
				)
		)

		it.effect(
			"serve a login over each level, commit each transaction exactly when it keeps the containment, and refuse a lower write a higher law forbids by that law named above",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { generated, done, at } = yield* installedLevels
						const seat = yield* seatOfInstalled(done, ["Item", "Sitting"], "levels")
						const lowerServed = servedGenerated(generated, at.authorApp)
						const upperServed = servedGenerated(generated, at.app)
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
												const outcome = yield* answered(
													author.workload.addItem.once({
														params: {},
														facts: { insert: { Item: [{ id: Code(idAt(op.id)), n: op.n }] } }
													})
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
												const outcome = yield* answered(
													author.workload.dropItem.once({
														params: {},
														facts: { delete: { Item: [{ id: Code(idAt(op.id)), n }] } }
													})
												)
												if (held) {
													if (
														outcome.kind !== "refused" ||
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
												const outcome = yield* answered(
													learner.workload.addSitting.once({
														params: {},
														facts: {
															insert: {
																Sitting: [
																	{
																		id: idAt(op.id),
																		item: Code(idAt(op.item)),
																		kind: op.test ? "Test" : "Practice"
																	}
																]
															}
														}
													})
												)
												if (!facts.items.has(op.item)) {
													if (
														!namesExactly(
															outcome,
															outcome.kind === "refused" ? refusedLaws(outcome.refused) : undefined,
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
												const outcome = yield* answered(
													learner.workload.dropSitting.once({
														params: {},
														facts: {
															delete: {
																Sitting: [
																	{
																		id: idAt(op.id),
																		item: Code(idAt(s.item)),
																		kind: s.test ? "Test" : "Practice"
																	}
																]
															}
														}
													})
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
										const joined = yield* rowsOf(
											learner.workload.fused.once({ params: {}, facts: {} })
										)
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
										const read = yield* rowsOf(
											learner.workload.items.once({ params: {}, facts: {} })
										)
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
