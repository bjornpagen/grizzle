/**
 * Rules over queries through grizzle's migrations, on PostgreSQL 19: a migration that adds a rule over a query, or
 * changes one or a definition it reads, runs its violation query over the stored rows and fails exactly where a row
 * breaks it, the rule it installs holds at every COMMIT after, through a declared rename of a table its query reads,
 * and the migrated catalog is a fresh install's of the second version, through a field the rule reads dropped and added
 * again and a table it reads dropped.
 *
 * A case draws rows of Fact(id, k, a), S(id, k, b, c) and T(a, b), the first version's rule over J2 = Fact ⋈ S on k
 * (none, or J2's facts whose b is not 0 contained in T), the second's (those facts, every fact of J2, or the facts of
 * Unpaired contained in T, the facts of J2 whose k no S row shares whose b is a T row's a: a negated join of S and T),
 * and one change of the second version: none; Fact renamed to Moved, as declared; Fact dropped, as declared, and Moved
 * added in its place, a new identity holding none of Fact's rows, so the judge's captures of Fact go with its table; or
 * S's b turned from a field its caller writes into one generated from c, which the migration drops and adds again (a
 * rewritten field), under S's captures (physical/ddl/rules.ts addRules), statement triggers that name no column, so no
 * trigger stands over the redefined column and each capture keeps its name. Every S row holds c
 * equal to b, so b keeps its value. A case constructed to reach the change of a definition a rule reads keeps the first
 * version's selected rule as it is and widens J2 to every pair of a Fact row and an S row, whatever their k: the same
 * law, a containment being named by its sides, whose check is a new one, since the definition it reads changed. It
 * stores a Fact row of one k and an S row of the other whose b is 1, so the first J2 holds no fact and the rows keep
 * its rule, while the widened J2 holds their pair, which no T row holds. That case, and one for each required situation
 * a drawn case reaches in one case of twenty or fewer (a changed rule or a rule over a negated join refused over rows
 * that break it, S's captures kept through b's redefinition, a write refused after a rename), is
 * constructed (constructed), and a witness whose turn aims at what it reaches draws it (aimed). The rows are
 * stored under the first version, where its rule admits them. The oracle is the rule restated over the rows: the second
 * migration fails, its violation check raising 23000, exactly when the rows it carries break its rule; once it applies,
 * the migrated schema holds the catalog a fresh install of the second version holds, both read from PostgreSQL's
 * catalog (test/pg/migrate/support.ts sameCatalog): its triggers, constraints, indexes and columns; and one transaction
 * writing drawn rows of Fact (or Moved), S and T commits exactly when the rows then keep the installed rule, and is
 * otherwise refused at COMMIT with 23503.
 *
 * Features: an added and a changed rule, each refused over rows that break it and applied over rows that keep it; a
 * rule kept through the widening of J2 refused over rows that break it; the same over a negated join; a write the
 * installed rule admits committed and one it breaks refused at COMMIT; a rule over a renamed table refusing such a
 * write; S's captures kept under their names through a column the migration drops and adds again, read off
 * PostgreSQL's catalog before and after the migration (S's b at another attnum, and S's triggers by name); and a
 * capture on a table the migration drops (Fact's, read off the catalog before it).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import {
	caseGen,
	constructed,
	Disagreed,
	factName,
	type Feature,
	keeps,
	newT,
	noRows,
	secondJoin,
	type STriggers,
	sTriggersOf,
	tableOf,
	triggerNamesOf,
	union,
	versionOf
} from "#test/pg/laws/rule-query-migrate.fixtures.ts"
import { sameCatalog } from "#test/pg/migrate/support.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { attempt, refusalText } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Rules over queries through migrations on PostgreSQL 19 fail a migration adding or changing a rule over a query exactly where the stored rows break it, leave a fresh install's catalog where it applies, and hold the rule it installs at every COMMIT after.
 *
 * Its pre-conversion budget: runs 24, coverage cases 60 (test/pg/laws/rule-query-migrate.test.ts at d8eed1786).
 */
export const rulesOverQueriesThroughMigrationsOnPostgreSQL19FailAMigrationAddingOrChangingARuleOverAQueryExactlyWhereTheStoredRowsBreakItLeaveAFreshInstallsCatalogWhereItAppliesAndHoldTheRuleItInstallsAtEveryCOMMITAfter =
	property.explore(aimed(caseGen, constructed), {
		needs: { substrate: Substrate.installing },
		situations: [
			"an added rule the stored rows break refused",
			"an added rule the stored rows keep applied",
			"a changed rule the stored rows break refused",
			"a changed rule the stored rows keep applied",
			"a rule kept through a change of its definition the stored rows break refused",
			"a rule over a renamed table holds after the rename",
			"a write the installed rule admits committed",
			"a write the installed rule breaks refused at COMMIT",
			"a rule over a negated join the stored rows break refused",
			"a rule over a negated join the stored rows keep applied",
			"S's captures kept under their names through a redefined column",
			"a capture on a dropped table"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, n: Case<Feature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const rows = keeps(c.stored, c.first, "onK") ? c.stored : noRows
						const carried = c.change === "dropped" ? { ...rows, facts: [] } : rows
						const breaks = !keeps(carried, c.second, secondJoin(c))
						let schemaIdent = ""
						const triggers: Array<STriggers> = []
						let factTriggers: ReadonlyArray<string> = []
						const declared = (version: number): Declarations =>
							version === 1 && c.change === "renamed"
								? {
										renames: [
											{
												from: { kind: "relation", relation: parsedName("Fact") },
												to: { kind: "relation", relation: parsedName("Moved") }
											}
										],
										drops: []
									}
								: version === 1 && c.change === "dropped"
									? {
											renames: [],
											drops: [{ kind: "relation", relation: parsedName("Fact") }]
										}
									: noDeclarations
						const store = (owner: RawSession) =>
							Effect.gen(function* () {
								const statements = [
									...Arr.map(
										rows.facts,
										([k, a], i) =>
											`INSERT INTO ${tableOf(schemaIdent, "Fact")} (id, k, a) VALUES (${i + 1}, ${k}, ${a})`
									),
									...Arr.map(
										rows.s,
										([k, b], i) =>
											`INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, b, c) VALUES (${i + 1}, ${k}, ${b}, ${b})`
									),
									...Arr.map(
										newT(rows, []),
										([a, b]) =>
											`INSERT INTO ${tableOf(schemaIdent, "T")} (a, b) VALUES (${a}, ${b})`
									)
								]
								const verdict = yield* attempt(owner, statements)
								if (verdict.kind !== "committed") {
									return yield* Effect.die(
										new Error(
											`the first version refused rows its rule keeps: ${refusalText(verdict.fields)}`
										)
									)
								}
							}).pipe(Effect.orDie)
						const outcome = yield* Effect.result(
							migrated({
								label: "rule_migrate",
								schemaName: { kind: "unique" },
								first: (name) => {
									schemaIdent = identifierOf(identity.schema(parsedSchemaName(name)))
									return { schema: versionOf(name, c, false), logins: [] }
								},
								later: [(name) => ({ schema: versionOf(name, c, true), logins: [] })],
								apply: { kind: "noPlaceholders" },
								declared,
								observe: Option.some((version: number, owner: RawSession) =>
									Effect.gen(function* () {
										if (version === 0) {
											yield* store(owner)
											factTriggers = yield* triggerNamesOf(owner, tableOf(schemaIdent, "Fact"))
										}
										const read = yield* sTriggersOf(owner, tableOf(schemaIdent, "S"))
										triggers.push(read)
									})
								)
							})
						)
						const kind = c.first === "none" ? "an added" : "a changed"
						if (outcome._tag === "Failure") {
							const failure = outcome.failure
							const refusedByCheck =
								failure._tag === "MigrateError" &&
								failure.reason._tag === "StatementFailed" &&
								failure.reason.failure._tag === "ServerError" &&
								failure.reason.failure.sqlstate === "23000"
							if (!breaks || !refusedByCheck) {
								return yield* new Disagreed({
									message: `the migration failed (${failure.message}; ${failure._tag === "MigrateError" && failure.reason._tag === "Drifted" ? Formatter.format(failure.reason.mismatches) : ""}) where the stored rows ${breaks ? "break" : "keep"} its rule: ${Formatter.format(c)}`
								})
							}
							n.note(`${kind} rule the stored rows break refused`)
							if (c.change === "widened") {
								n.note(
									"a rule kept through a change of its definition the stored rows break refused"
								)
							}
							if (c.second === "negated") {
								n.note("a rule over a negated join the stored rows break refused")
							}
							return
						}
						if (breaks) {
							return yield* new Disagreed({
								message: `the migration applied a rule the stored rows break: ${Formatter.format(c)}`
							})
						}
						n.note(`${kind} rule the stored rows keep applied`)
						if (c.second === "negated") {
							n.note("a rule over a negated join the stored rows keep applied")
						}
						const m = outcome.success
						const [before, after] = triggers
						if (before !== undefined && after !== undefined && before.b !== after.b) {
							if (
								before.names.length > 0 &&
								Arr.every(before.names, (t) => Arr.contains(after.names, t))
							) {
								n.note("S's captures kept under their names through a redefined column")
							}
						}
						if (c.change === "dropped" && factTriggers.length > 0) {
							n.note("a capture on a dropped table")
						}
						const fresh = yield* migrated({
							label: "rule_migrate_fresh",
							schemaName: { kind: "unique" },
							first: (name) => ({ schema: versionOf(name, c, true), logins: [] }),
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: Option.none()
						})
						yield* sameCatalog(
							m.installation,
							fresh.installation,
							"the migrated second version against a fresh install of it"
						)
						const written = [
							...Arr.map(
								c.written.facts,
								([k, a], i) =>
									`INSERT INTO ${tableOf(schemaIdent, factName(c, true))} (id, k, a) VALUES (${100 + i}, ${k}, ${a})`
							),
							...Arr.map(c.written.s, ([k, b], i) =>
								c.change === "redefined"
									? `INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, c) VALUES (${100 + i}, ${k}, ${b})`
									: `INSERT INTO ${tableOf(schemaIdent, "S")} (id, k, b, c) VALUES (${100 + i}, ${k}, ${b}, ${b})`
							),
							...Arr.map(
								newT(c.written, rows.t),
								([a, b]) => `INSERT INTO ${tableOf(schemaIdent, "T")} (a, b) VALUES (${a}, ${b})`
							)
						]
						const lawful = keeps(union(carried, c.written), c.second, secondJoin(c))
						const verdict = yield* attempt(m.owner, written)
						if (verdict.kind === "committed" && lawful) {
							n.note("a write the installed rule admits committed")
							return
						}
						if (
							verdict.kind === "committed" ||
							lawful ||
							verdict.moment.kind !== "commit" ||
							verdict.fields.code !== "23503"
						) {
							return yield* new Disagreed({
								message: `a write ${lawful ? "keeping" : "breaking"} the installed rule ${verdict.kind === "committed" ? "committed" : `was refused by ${refusalText(verdict.fields)}`}, where the rule refuses exactly a breaking write at COMMIT with 23503: ${Formatter.format(c)}`
							})
						}
						n.note("a write the installed rule breaks refused at COMMIT")
						if (c.change === "renamed") {
							n.note("a rule over a renamed table holds after the rename")
						}
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the rule restated over the rows: a migration installing it applies exactly when the stored rows keep it, and a write after it commits exactly when the rows then keep it; and PostgreSQL's catalog of a fresh install of the second version"
		},
		budget: { runs: 24, steered: 60 },
		kept: [],
		kills: []
	})
