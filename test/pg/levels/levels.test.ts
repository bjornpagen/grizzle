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
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { exact } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Law } from "#compiler/public/changeset.ts"
import { lawsByStatement, schemaNameOf } from "#compiler/public/schema.ts"
import type { OwnLaw } from "#compiler/types/changeset/changeset.ts"
import { seatOfInstalled } from "#test/pg/fin/installed.ts"
import {
	type CatalogFact,
	catalogFactGen,
	type CatalogFeature,
	Code,
	columnOf,
	disagreed,
	expectedOf,
	type Facts,
	brokenLaws,
	HELD_AT,
	type LawName,
	type Op,
	type Feature,
	historySpace,
	idAt,
	levelsIn,
	levelsTemplate,
	Item,
	type Level,
	type LevelRole,
	plain,
	quote,
	sameRows,
	Sitting
} from "#test/pg/levels/levels.fixtures.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Levels of one installation on PostgreSQL 19 install each level's tables in its own schema, the containment across them over one domain, and grant each role exactly the tables it writes.
 */
export const levelsOfOneInstallationOnPostgreSQL19InstallEachLevelsTablesInItsOwnSchemaTheContainmentAcrossThemOverOneDomainAndGrantEachRoleExactlyTheTablesItWrites =
	property.exhaust(finite(catalogFactGen), {
		needs: { levels: Substrate.seat(levelsTemplate) },
		situations: [
			"a table in its level's schema",
			"no table in another level's schema",
			"privileges on a table the role writes",
			"no privilege on a table the role does not write",
			"the containment across the levels",
			"one contract domain across the levels"
		] satisfies ReadonlyArray<Reached<CatalogFeature>>,
		check:
			({ levels }, c: Case<CatalogFeature>) =>
			(fact) =>
				Effect.flatMap(levels, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const { done, at } = levelsIn(taken)
							const seat = yield* seatOfInstalled(done, ["Item", "Sitting", "Approved"], "levels")
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

							const [expected, situation] = expectedOf(at, fact)
							const rows = yield* seat.session.values(`SELECT (${sqlOf(fact)})::text`, [])
							c.note(situation)
							assert.equal(rows[0]?.[0] === "true", expected, Formatter.format(fact))
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "postgresql",
			name: "the catalog read by the compiler's names, against what the levels' declarations and the roles' write lists state"
		},
		box: "each declared relation at each level, each role on each declared relation, the containment and its domain",
		kept: [],
		kills: []
	})

/**
 * Levels of one installation on PostgreSQL 19 serve a login over each level, commit each transaction exactly when it keeps the containment, and refuse a lower write a higher law forbids by that law named above.
 *
 * Its pre-conversion budget: runs 40, coverage cases 60 (test/pg/levels/levels.test.ts at d8eed1786).
 */
export const levelsOfOneInstallationOnPostgreSQL19ServeALoginOverEachLevelCommitEachTransactionExactlyWhenItKeepsTheContainmentAndRefuseALowerWriteAHigherLawForbidsByThatLawNamedAbove =
	property.explore(historySpace, {
		needs: { levels: Substrate.seat(levelsTemplate) },
		situations: [
			"an item added",
			"an item deleted",
			"a held item's deletion refused from above",
			"a sitting added",
			"a dangling sitting refused",
			"a sitting deleted",
			"a fused read of a sitting",
			"a selected item added",
			"an unapproved selected item refused from above",
			"an approval added",
			"an approval's deletion refused",
			"an approval deleted",
			"a test sitting added",
			"a test sitting of an unselected item refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ levels }, c: Case<Feature>) =>
			(history) =>
				Effect.flatMap(levels, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const { generated, done, at } = levelsIn(taken)
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
							const lawOf = lawsByStatement(at.upper)
							const lawNamed = (name: LawName): OwnLaw =>
								defined(lawOf(at.laws[name])[0], `the upper level's law ${name}`)
							const level = levelNameAt(done.schema, 1)
							/** The law a refusal of `by`'s write names for `name`: the lower login's above the level that states it. */
							const namedBy = (by: LevelRole, name: LawName): Law =>
								by === "author" ? { kind: "above", level, law: lawNamed(name) } : lawNamed(name)

							const item = (id: number, n: number) => ({ id: Code(idAt(id)), n })
							const sitting = (
								id: number,
								s: { readonly item: number; readonly test: boolean }
							) => ({
								id: idAt(id),
								item: Code(idAt(s.item)),
								kind: s.test ? ("Test" as const) : ("Practice" as const)
							})
							const approval = (id: number) => ({ id: Code(idAt(id)) })
							/**
							 * One op's call through the login that writes it, the facts it leaves where it is accepted, and the
							 * situation each verdict is; undefined for an op the facts make moot, an addition of a fact held or a
							 * deletion of one absent.
							 */
							const stepOf = (op: Op, f: Facts) =>
								Effect.gen(function* () {
									switch (op.kind) {
										case "addItem": {
											if (f.items.has(op.id)) {
												return undefined
											}
											const outcome = yield* answered(
												author.workload.addItem.once({
													params: {},
													facts: { insert: { Item: [item(op.id, op.n)] } }
												})
											)
											return {
												by: "author" as const,
												outcome,
												next: { ...f, items: new Map([...f.items, [op.id, op.n]]) },
												accepted:
													op.n >= HELD_AT
														? ("a selected item added" as const)
														: ("an item added" as const),
												refused: "an unapproved selected item refused from above" as const
											}
										}
										case "dropItem": {
											const n = f.items.get(op.id)
											if (n === undefined) {
												return undefined
											}
											const outcome = yield* answered(
												author.workload.dropItem.once({
													params: {},
													facts: { delete: { Item: [item(op.id, n)] } }
												})
											)
											const items = new Map(f.items)
											items.delete(op.id)
											return {
												by: "author" as const,
												outcome,
												next: { ...f, items },
												accepted: "an item deleted" as const,
												refused: "a held item's deletion refused from above" as const
											}
										}
										case "addSitting": {
											if (f.sittings.has(op.id)) {
												return undefined
											}
											const outcome = yield* answered(
												learner.workload.addSitting.once({
													params: {},
													facts: { insert: { Sitting: [sitting(op.id, op)] } }
												})
											)
											return {
												by: "learner" as const,
												outcome,
												next: {
													...f,
													sittings: new Map([
														...f.sittings,
														[op.id, { item: op.item, test: op.test }]
													])
												},
												accepted: op.test
													? ("a test sitting added" as const)
													: ("a sitting added" as const),
												refused: f.items.has(op.item)
													? ("a test sitting of an unselected item refused" as const)
													: ("a dangling sitting refused" as const)
											}
										}
										case "dropSitting": {
											const held = f.sittings.get(op.id)
											if (held === undefined) {
												return undefined
											}
											const outcome = yield* answered(
												learner.workload.dropSitting.once({
													params: {},
													facts: { delete: { Sitting: [sitting(op.id, held)] } }
												})
											)
											const sittings = new Map(f.sittings)
											sittings.delete(op.id)
											return {
												by: "learner" as const,
												outcome,
												next: { ...f, sittings },
												accepted: "a sitting deleted" as const,
												refused: undefined
											}
										}
										case "addApproval": {
											if (f.approved.has(op.id)) {
												return undefined
											}
											const outcome = yield* answered(
												learner.workload.addApproval.once({
													params: {},
													facts: { insert: { Approved: [approval(op.id)] } }
												})
											)
											return {
												by: "learner" as const,
												outcome,
												next: { ...f, approved: new Set([...f.approved, op.id]) },
												accepted: "an approval added" as const,
												refused: undefined
											}
										}
										case "dropApproval": {
											if (!f.approved.has(op.id)) {
												return undefined
											}
											const outcome = yield* answered(
												learner.workload.dropApproval.once({
													params: {},
													facts: { delete: { Approved: [approval(op.id)] } }
												})
											)
											const approved = new Set(f.approved)
											approved.delete(op.id)
											return {
												by: "learner" as const,
												outcome,
												next: { ...f, approved },
												accepted: "an approval deleted" as const,
												refused: "an approval's deletion refused" as const
											}
										}
									}
								})

							let facts: Facts = { items: new Map(), sittings: new Map(), approved: new Set() }
							for (const op of history) {
								const step = yield* stepOf(op, facts)
								if (step === undefined) {
									continue
								}
								const broken = brokenLaws(step.next)
								if (broken.length === 0) {
									if (step.outcome.kind !== "accepted") {
										return yield* disagreed(
											`${Formatter.format(op)} answered ${Formatter.format(step.outcome)} over a state that keeps every law`
										)
									}
									facts = step.next
									c.note(step.accepted)
								} else {
									const named =
										step.outcome.kind === "refused" ? refusedLaws(step.outcome.refused) : []
									const allowed = Arr.map(broken, (name) => namedBy(step.by, name))
									if (
										step.outcome.kind !== "refused" ||
										(step.by === "author" && step.outcome.witness.kind !== "unreported") ||
										!Arr.every(named, (law) =>
											Arr.some(allowed, (a) => Option.isNone(exact(law, a)))
										) ||
										step.refused === undefined
									) {
										return yield* disagreed(
											`${Formatter.format(op)} answered ${Formatter.format(step.outcome)}, not a refusal by one of ${Formatter.format(allowed)}`
										)
									}
									c.note(step.refused)
								}
								const joined = yield* rowsOf(learner.workload.fused.once({ params: {}, facts: {} }))
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
								const read = yield* rowsOf(learner.workload.items.once({ params: {}, facts: {} }))
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
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the containment restated over the facts: a transaction commits exactly when the state it leaves keeps it, a refusal names its law as the level that states it, above the lower level for a lower write, and every read agrees with the facts"
		},
		budget: { runs: 40, steered: 60 },
		kept: [],
		kills: []
	})
