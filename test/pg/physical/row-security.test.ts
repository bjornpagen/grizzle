import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { OpenError } from "#adapter/errors/execution.ts"
import { type AdmissionMismatch, AdmissionRefused } from "#adapter/errors/failures.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { login } from "#compiler/program/workload/login.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { role } from "#compiler/schema/world.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { assert, assertVariant, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { readCatalog, readCatalogWith } from "#test/support/catalog/read.ts"
import { migrated, type Version, withDb, worldRoleOf } from "#test/support/installed.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Row security across migrations on PostgreSQL 19, over Note and Card, each an id and a shelf, and two roles, clerk and
 * keeper, in one login. A case draws two or three versions; in each, each role holds each relation whole or through a
 * query entry whose filter fixes the shelf at a drawn value, and writes it or not. Each version's folder is generated,
 * reviewed and applied by the real runner, which drift-checks the catalog it reaches (`migrated`).
 *
 * The model, read from the catalog after each migration: a table has row security exactly when some writer of it writes
 * it through a narrowed entry, and then holds exactly one policy per writer of it, the narrowed writer's its entry's
 * membership and a whole writer's TRUE, since under row security a role with no policy writes nothing; a table no writer
 * narrows has neither row security nor a policy, the migration dropping both where an earlier version had them. At the
 * last version Db.open admits both roles, and the installed-catalog checker finds nothing. Then a drawn change by hand,
 * row security disabled or forced on every table under it: Db.open refuses exactly the roles that write one of them
 * through a narrowed entry, each with one mismatch per such table, its row security as changed (README "Connecting"),
 * and admits the rest.
 */

/** How a role holds a relation: whole, or through a query entry fixing the shelf at 1 or at 2. */
type Holding = "whole" | "shelf 1" | "shelf 2"

/** What a role does with a relation: how it holds it, and whether it writes it. */
interface Use {
	readonly holds: Holding
	readonly writes: boolean
}

const relationNames = ["Note", "Card"] as const

type RelationName = (typeof relationNames)[number]

const roleNames = ["clerk", "keeper"] as const

type RoleName = (typeof roleNames)[number]

/** A version: each role's use of each relation. */
type Uses = Readonly<Record<RoleName, Readonly<Record<RelationName, Use>>>>

const useGen: Gen<Use> = (source) => ({
	holds: source.draw(element<Holding>(["whole", "shelf 1", "shelf 2"])),
	writes: source.draw(boolean)
})

const usesGen: Gen<Uses> = (source) => ({
	clerk: { Note: source.draw(useGen), Card: source.draw(useGen) },
	keeper: { Note: source.draw(useGen), Card: source.draw(useGen) }
})

const historyGen: Gen<Arr.NonEmptyReadonlyArray<Uses>> = (source) =>
	nonEmpty(source.draw(array(usesGen, { min: 2, max: 3 })), "a history's versions")

/** What a hand does to each table under row security once the last version is migrated. */
type Planted = "disabled" | "forced"

/** A case: the versions migrated in turn, and the change by hand after the last. */
interface RowSecurityCase {
	readonly history: Arr.NonEmptyReadonlyArray<Uses>
	readonly planted: Planted
}

const caseGen: Gen<RowSecurityCase> = (source) => ({
	history: source.draw(historyGen),
	planted: source.draw(element<Planted>(["disabled", "forced"]))
})

/** The version under the declared name `name`, each role holding and writing each relation as `uses` says. */
const versionOf = (name: string, uses: Uses) => {
	const Note = relation("Note", { id: uuid, shelf: pg.integer }, ["id"])
	const Card = relation("Card", { id: uuid, shelf: pg.integer }, ["id"])
	const base = schema(name, { Note, Card }, [])
	/** A relation's facts on one shelf, a query entry whose filter fixes the shelf. */
	const shelvedNote = (shelf: 1 | 2) =>
		query(base).rule((r) => {
			const { id } = v(Note, "note")
			return r.match(Note, { id, shelf }).find({ id })
		})
	const shelvedCard = (shelf: 1 | 2) =>
		query(base).rule((r) => {
			const { id } = v(Card, "card")
			return r.match(Card, { id, shelf }).find({ id })
		})
	/** A role's entry of a relation: the relation whole, or the query of its facts on one shelf. */
	const entryOf = (relationName: RelationName, holding: Holding): EntryValue => {
		switch (holding) {
			case "whole":
				return relationName === "Note" ? Note : Card
			case "shelf 1":
			case "shelf 2": {
				const shelf = holding === "shelf 1" ? 1 : 2
				return relationName === "Note" ? shelvedNote(shelf) : shelvedCard(shelf)
			}
		}
	}
	const roleOf = <N extends RoleName>(roleName: N) => {
		const entries: Record<string, EntryValue> = {}
		const writes: Array<string> = []
		for (const relationName of relationNames) {
			const use = uses[roleName][relationName]
			const entry = `${relationName}${use.holds === "whole" ? "" : "Shelved"}`
			entries[entry] = entryOf(relationName, use.holds)
			if (use.writes) {
				writes.push(entry)
			}
		}
		return role(base, roleName, entries, { write: writes, refresh: [] })
	}
	const clerk = roleOf("clerk")
	const keeper = roleOf("keeper")
	return {
		declared: name,
		schema: base,
		Note,
		Card,
		clerk,
		keeper,
		login: login(base, "desk", [clerk, keeper])
	}
}

type Built = ReturnType<typeof versionOf>

/** An admission mismatch as a case compares it: its stage, its check and the value observed. */
type Shown = readonly [stage: AdmissionMismatch["stage"], check: string, observed: string]

const shown = (m: AdmissionMismatch): Shown => [m.stage, m.check, m.observed]

/** A policy as the rule judges it: its table, its roles, and whether both its USING and its WITH CHECK admit every
 * row. */
interface PolicySeen {
	readonly table: string
	readonly roles: ReadonlyArray<string>
	readonly holds: "every row" | "narrowed"
}

/** What one version's catalog holds of row security: the tables with it, sorted, and the policies. */
interface Seen {
	readonly rowSecure: ReadonlyArray<string>
	readonly policies: ReadonlyArray<PolicySeen>
}

/**
 * What a version's catalog should hold: row security on each table some writer narrows, and there each writer's
 * policy, narrowed or TRUE; nothing on any other table.
 */
const expectedAt = (uses: Uses, b: Built, tableOf: (r: RelationName) => string): Seen => {
	const secured = Arr.filter(relationNames, (r) =>
		Arr.some(roleNames, (who) => uses[who][r].writes && uses[who][r].holds !== "whole")
	)
	return {
		rowSecure: Arr.sort(Arr.map(secured, tableOf), Order.String),
		policies: Arr.flatMap(secured, (r) =>
			Arr.flatMap(roleNames, (who): ReadonlyArray<PolicySeen> =>
				uses[who][r].writes
					? [
							{
								table: tableOf(r),
								roles: [worldRoleOf(who === "clerk" ? b.clerk : b.keeper)],
								holds: uses[who][r].holds === "whole" ? "every row" : "narrowed"
							}
						]
					: []
			)
		)
	}
}

type RowSecurityFeature =
	| "a narrowed writer beside a whole one"
	| "a narrowed reader that writes nothing"
	| "row security added"
	| "row security dropped"
	| "a narrowed writer's filter changed"
	| `a narrowed writer refused, row security ${Planted}`
	| "a role admitted beside a changed table"

const secureds = (uses: Uses): ReadonlyArray<RelationName> =>
	Arr.filter(relationNames, (r) =>
		Arr.some(roleNames, (who) => uses[who][r].writes && uses[who][r].holds !== "whole")
	)

/** The relations a role writes through a narrowed entry. */
const narrowedBy = (uses: Uses, who: RoleName): ReadonlyArray<RelationName> =>
	Arr.filter(relationNames, (r) => uses[who][r].writes && uses[who][r].holds !== "whole")

const featuresOf = (
	history: Arr.NonEmptyReadonlyArray<Uses>
): ReadonlyArray<RowSecurityFeature> => [
	...(Arr.some(history, (uses) =>
		Arr.some(relationNames, (r) => {
			const writers = Arr.filter(roleNames, (who) => uses[who][r].writes)
			return (
				Arr.some(writers, (who) => uses[who][r].holds !== "whole") &&
				Arr.some(writers, (who) => uses[who][r].holds === "whole")
			)
		})
	)
		? ["a narrowed writer beside a whole one" as const]
		: []),
	...(Arr.some(history, (uses) =>
		Arr.some(roleNames, (who) =>
			Arr.some(relationNames, (r) => !uses[who][r].writes && uses[who][r].holds !== "whole")
		)
	)
		? ["a narrowed reader that writes nothing" as const]
		: []),
	...Arr.flatMap(
		Arr.zip<Uses, Uses>(history, Arr.drop(history, 1)),
		([was, now]): ReadonlyArray<RowSecurityFeature> => [
			...(Arr.some(secureds(now), (r) => !secureds(was).includes(r))
				? ["row security added" as const]
				: []),
			...(Arr.some(secureds(was), (r) => !secureds(now).includes(r))
				? ["row security dropped" as const]
				: []),
			...(Arr.some(roleNames, (who) =>
				Arr.some(
					relationNames,
					(r) =>
						was[who][r].writes &&
						now[who][r].writes &&
						was[who][r].holds !== "whole" &&
						now[who][r].holds !== "whole" &&
						was[who][r].holds !== now[who][r].holds
				)
			)
				? ["a narrowed writer's filter changed" as const]
				: [])
		]
	)
]

layer(Substrate.layer)("row security across migrations", (it) => {
	it.effect(
		"a table has row security and every writer's policy exactly while some writer narrows it, across migrations, and Db.open refuses a narrowed writer of a table whose row security a hand changed",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/physical/row-security",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: 'row security exactly where a writer narrows, one policy per writer there, read from the catalog after each migration; Db.open\'s admission of a role, refused exactly for a narrowed writer of a changed table (README "Connecting")'
						},
						coverage: required<RowSecurityFeature>(
							[
								"a narrowed writer beside a whole one",
								"a narrowed reader that writes nothing",
								"row security added",
								"row security dropped",
								"a narrowed writer's filter changed",
								"a narrowed writer refused, row security disabled",
								"a narrowed writer refused, row security forced",
								"a role admitted beside a changed table"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 6,
						shrink: { kind: "bounded", candidates: 8 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					({ history, planted }, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								k.noteAll(featuresOf(history))
								const substrate = yield* Substrate
								const built: Array<Built> = []
								const version =
									(uses: Uses) =>
									(name: string): Version => {
										const b = versionOf(name, uses)
										built.push(b)
										return { schema: b.schema, logins: [b.login] }
									}
								const seen: Array<Seen> = []
								const [first, ...later] = Arr.map(history, version)
								const m = yield* migrated({
									label: "row_security",
									schemaName: { kind: "unique" },
									first,
									later,
									apply: { kind: "noPlaceholders" },
									register: true,
									declared: () => noDeclarations,
									observe: Option.some((i: number, owner: RawSession) =>
										Effect.gen(function* () {
											const b = defined(built[i], `version ${i}`)
											const installed = identifierOf(identity.schema(parsedSchemaName(b.declared)))
											const read = yield* readCatalogWith(
												(sql, params) => owner.values(sql, params),
												installed
											)
											assert.ok(
												read.kind === "present",
												`the migrated schema ${installed} is absent`
											)
											seen.push({
												rowSecure: Arr.sort(
													Arr.flatMap(read.catalog.tables, (t): ReadonlyArray<string> =>
														t.rowSecurity ? [t.name] : []
													),
													Order.String
												),
												policies: Arr.map(read.catalog.policies, (p): PolicySeen => ({
													table: p.table,
													roles: p.roles,
													holds:
														Option.exists(p.using, (u) => u === "true") &&
														Option.exists(p.check, (c) => c === "true")
															? "every row"
															: "narrowed"
												}))
											})
										})
									)
								})
								const last = defined(built[built.length - 1], "the last version")
								const names = namesOf(m)
								const tableOf = (r: RelationName): string =>
									names.tableIdent(r === "Note" ? last.Note : last.Card)
								assert.equal(seen.length, history.length, "a reading after each migration")
								for (const [i, uses] of history.entries()) {
									const b = defined(built[i], `version ${i}`)
									const at = defined(seen[i], `the reading of version ${i}`)
									const want = expectedAt(uses, b, tableOf)
									assert.deepEqual(
										at.rowSecure,
										want.rowSecure,
										`the tables under row security at ${i}`
									)
									unorderedEqual(at.policies, want.policies, `the policies at ${i}`)
								}
								yield* m.reapply
								yield* withDb(m, last.login.roles.clerk, () => Effect.void)
								yield* withDb(m, last.login.roles.keeper, () => Effect.void)
								const read = yield* readCatalog(substrate.admin, m.schema)
								assert.ok(read.kind === "present", `the migrated schema ${m.schema} is absent`)
								assert.deepEqual(
									checkInstalled(read.catalog, installedScope(m.installation, m.snapshot)),
									[]
								)
								const lastUses = Arr.lastNonEmpty(history)
								const changed = secureds(lastUses)
								for (const r of changed) {
									yield* substrate.admin.query(
										`ALTER TABLE ${quoteIdent(m.schema)}.${quoteIdent(tableOf(r))} ${planted === "disabled" ? "DISABLE" : "FORCE"} ROW LEVEL SECURITY`,
										[]
									)
								}
								for (const who of roleNames) {
									const opened = yield* Effect.result(
										withDb(
											m,
											who === "clerk" ? last.login.roles.clerk : last.login.roles.keeper,
											() => Effect.void
										)
									)
									const expected = Arr.map(narrowedBy(lastUses, who), (r): Shown => [
										"privileges",
										`row security of ${tableOf(r)}`,
										planted
									])
									if (!Arr.isReadonlyArrayNonEmpty(expected)) {
										assertVariant(opened, "_tag", "Success", `${who} admitted`)
										if (Arr.isReadonlyArrayNonEmpty(changed)) {
											k.note("a role admitted beside a changed table")
										}
										continue
									}
									assertVariant(opened, "_tag", "Failure", `${who} refused`)
									const error = opened.failure
									assertInstanceOf(error, OpenError)
									const reason = error.reason
									assertInstanceOf(reason, AdmissionRefused)
									unorderedEqual(Arr.map(reason.mismatches, shown), expected)
									k.note(`a narrowed writer refused, row security ${planted}`)
								}
							})
						)
				)
			)
	)
})
