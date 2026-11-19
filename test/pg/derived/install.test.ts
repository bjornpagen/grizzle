import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import { baseOf, type Patterns, textInfoOf } from "#compiler/ir/scalar.ts"
import { uuid } from "#compiler/public/fields.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { materializedDerived as runtimeDerived } from "#compiler/schema/relation.ts"
import { printType } from "#compiler/sql/print.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import {
	conservativeSql,
	deferredCaseGen,
	type DeferredFeature,
	deferredFeatures,
	descriptorCaseGen,
	type DescriptorFeature,
	descriptorSchemaOf,
	id,
	type LiteralCase,
	literalCaseGen,
	type LiteralFeature,
	literalFeatures,
	ownedOf,
	sketchOf,
	sorted,
	typmodOf,
	viewAndDefinition,
	viewOf,
	writtenTemplate
} from "#test/pg/derived/install.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined as present, succeeded, unorderedEqual } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { installMigrated as install, loadMigrated as load } from "#test/support/install-migrate.ts"
import { namesOf, parsedName, roleNamesOf } from "#test/support/kernel/naming.ts"
import { checkedIn } from "#test/support/policy.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { patternOf } from "#test/unit/schema/field-sketch.ts"
import { regex } from "#test/unit/schema/support.ts"

/**
 * Derived relations on PostgreSQL 19 inferred descriptors hold: every view column's catalog type, typmod and collation is its descriptor's.
 *
 * Its pre-conversion budget: runs 12, coverage cases 80 (test/pg/derived/install.test.ts at d8eed1786).
 */
export const derivedRelationsOnPostgreSQL19InferredDescriptorsHoldEveryViewColumnsCatalogTypeTypmodAndCollationIsItsDescriptors =
	property.explore(descriptorCaseGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"aggregate count",
			"aggregate sum",
			"aggregate mean",
			"aggregate min",
			"aggregate max",
			"column pg",
			"column numeric",
			"column text",
			"column contract",
			"column closedId",
			"column span",
			"column computedNumeric"
		] satisfies ReadonlyArray<Reached<DescriptorFeature>>,
		check:
			({ substrate2 }, k: Case<DescriptorFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const built = catchCompileError(() => descriptorSchemaOf(c))
							if (!built.ok || !Result.map(checkedIn(built.value), derivedAnalysis).ok) {
								k.note("a schema the compiler refuses")
								return
							}
							const substrate = yield* Substrate
							const installed = yield* install(built.value, {
								ambient: ordinarySession,
								extensions: [],
								label: "derived",
								logins: []
							})
							const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
							const { analysis, view } = viewOf(installed, "D")
							for (const a of c.aggregates) {
								k.note(`aggregate ${a.fn}`)
							}
							for (const col of analysis.heading) {
								k.note(`column ${col.desc.kind}`)
								const column = installed.names.column("D", col.name)
								const expected = printType(fieldColumnType(installed.names, col.type).type)
								const attribute = yield* owner.values(
									`SELECT (a.atttypid = '${Str.replaceAll("'", "''")(expected)}'::regtype)::text, a.atttypmod::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attname = '${column}'`,
									[]
								)
								const [[sameType, typmod, collation]] =
									trusted<Arr.NonEmptyReadonlyArray<readonly [string, string, string]>>(attribute)
								assert.equal(sameType, "true", `D.${col.name} is ${expected}`)
								assert.equal(Number(typmod), typmodOf(col.desc), `D.${col.name} typmod`)
								if (baseOf(col.type).carrier === "text") {
									assert.equal(collation, "pg_c_utf8", `D.${col.name} collation`)
								}
							}
						})
					),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "postgresql",
			name: "the installed view's pg_attribute: each column's type, typmod and collation"
		},
		budget: { runs: 12, steered: 80 },
		kept: [],
		kills: []
	})

/**
 * Derived relations on PostgreSQL 19 a refined-text literal column has its pattern's domain, declared by a field or not, and its refresher and reader see it.
 *
 * Its pre-conversion budget: runs 6, coverage cases 12 (test/pg/derived/install.test.ts at d8eed1786).
 */
export const derivedRelationsOnPostgreSQL19ARefinedTextLiteralColumnHasItsPatternsDomainDeclaredByAFieldOrNotAndItsRefresherAndReaderSeeIt =
	property.explore(literalCaseGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a literal of a pattern a field declares",
			"a literal of a pattern no field declares",
			"a literal of the wildcard",
			"rows refreshed",
			"no row refreshed"
		] satisfies ReadonlyArray<Reached<LiteralFeature>>,
		check:
			({ substrate2 }, k: Case<LiteralFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const declared = patternOf(c.declared)
							const Coded = relation(
								"Coded",
								{ id: uuid, code: regex(declared.source, declared.flags) },
								["id"]
							)
							const C = schema("C", [Coded], [])
							const literalOf = (l: LiteralCase["first"]) => {
								const { source, flags } = patternOf(sketchOf(c, l.pattern))
								return computeCore.literal(regex(source, flags), l.member)
							}
							const literals = queryOver(C).rule((r: RuleValue) => {
								const vars = varsOver(Coded, "coded")
								return r.match(Coded, { id: vars["id"] }).find({
									id: vars["id"],
									first: literalOf(c.first),
									second: literalOf(c.second)
								})
							})
							const Literals = runtimeDerived("Literals", literals, [])
							const Ext = schema.extend(C, "Ext", [Literals], [])
							const viewer = role(Ext, "viewer", { Literals })
							const refresher = role(
								Ext,
								"refresher",
								{ Coded, Literals },
								{ refresh: ["Literals"] }
							)
							const installed = yield* install(Ext, {
								ambient: ordinarySession,
								extensions: [],
								label: "derived",
								logins: [login(Ext, "server", [viewer, refresher])]
							})
							const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
							const { view } = viewOf(installed, "Literals")
							/**
							 * Each pattern's type as regtype prints it: the installation's domain of it, or text for the
							 * wildcard, which no domain refines.
							 */
							const typeOf = (l: LiteralCase["first"]): string => {
								const { source, flags } = patternOf(sketchOf(c, l.pattern))
								const patterns: Patterns = [{ source, flags }]
								const info = textInfoOf(patterns, succeeded(textLookup(patterns)))
								if (info === "wildcard") {
									return "text"
								}
								const domain = installed.names.textDomain(info)
								if (domain === undefined) {
									return assert.fail(`the installation names no domain of ${source}`)
								}
								return `${domain.schema}.${domain.name}`
							}
							const rows = yield* owner.values(
								`SELECT a.attname::text, a.atttypid::regtype::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attnum > 0`,
								[]
							)
							const column = (field: string) => installed.names.column("Literals", field)
							unorderedEqual(rows, [
								[column("first"), typeOf(c.first), "pg_c_utf8"],
								[column("id"), "uuid", "-"],
								[column("second"), typeOf(c.second), "pg_c_utf8"]
							])
							yield* load(installed, {
								Coded: Arr.map(c.codes, (code, i) => ({ id: id(i + 1), code }))
							})
							const refreshing = yield* substrate.session({
								...worldSession(installed.world(refresher)),
								label: "refresher"
							})
							yield* refreshing.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
							yield* refreshing.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
							const { stored, defined } = yield* viewAndDefinition(installed, "Literals")
							assert.deepEqual(stored, defined)
							/** The viewer reads the domain-typed columns through its world's view of Literals. */
							const viewing = yield* substrate.session({
								...worldSession(installed.world(viewer)),
								label: "viewer"
							})
							const seen = roleNamesOf(installed, viewer)
							const read = (field: string) => `${seen.column("Literals", field)}::text`
							const viewingRows = yield* viewing.values(
								`SELECT ${read("id")}, ${read("first")}, ${read("second")} FROM ${seen.view("Literals")}`,
								[]
							)
							unorderedEqual(
								viewingRows,
								Arr.map(c.codes, (_, i) => [id(i + 1), c.first.member, c.second.member])
							)
							k.noteAll(literalFeatures(c))
						})
					),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "second-implementation",
			name: "each literal's pattern's installed domain, and the definition's rows by the conservative lowering"
		},
		budget: { runs: 6, steered: 12 },
		kept: [],
		kills: []
	})

/**
 * Derived relations on PostgreSQL 19 a refresh inside an owner's transaction whose writes leave a deferred containment false equals the definition there.
 *
 * Its pre-conversion budget: runs 8, coverage cases 12 (test/pg/derived/install.test.ts at d8eed1786).
 */
export const derivedRelationsOnPostgreSQL19ARefreshInsideAnOwnersTransactionWhoseWritesLeaveADeferredContainmentFalseEqualsTheDefinitionThere =
	property.explore(deferredCaseGen, {
		needs: { written: Substrate.seat(writtenTemplate) },
		situations: [
			"a task of an absent account added",
			"a task of a held account added",
			"an account of tasks removed"
		] satisfies ReadonlyArray<Reached<DeferredFeature>>,
		check:
			({ written }, k: Case<DeferredFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const { substrate, value: installed } = yield* written
					const names = namesOf(installed)
					const { view, columns } = viewOf(installed, "OwnedTasks")
					const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
					/** A handle of Kind as the code the installation's codebook gives it. */
					const manual = codeOf(
						present(
							installed.names.codes.rosters.get(parsedName(W.Kind.name)),
							"the installation's codes of Kind"
						),
						"Manual"
					)
					return yield* Effect.ensuring(
						Effect.gen(function* () {
							yield* owner.begin
							yield* owner.query("SET CONSTRAINTS ALL DEFERRED", [])
							for (const [i, account] of c.added.entries()) {
								const task = id(16 + i)
								yield* owner.query(
									`INSERT INTO ${names.table(W.Task)} (${names.column(W.Task, "id")}, ${names.column(W.Task, "account")}, ${names.column(W.Task, "kind")}) VALUES ('${task}'::uuid, '${account}'::uuid, ${manual}::smallint)`,
									[]
								)
								yield* owner.query(
									`INSERT INTO ${names.table(W.ManualTask)} (${names.column(W.ManualTask, "task")}, ${names.column(W.ManualTask, "operator")}) VALUES ('${task}'::uuid, 'ops')`,
									[]
								)
							}
							for (const account of c.removed) {
								yield* owner.query(
									`DELETE FROM ${names.table(W.Account)} WHERE ${names.column(W.Account, "id")} = '${account}'::uuid`,
									[]
								)
							}
							yield* owner.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`, [])
							const stored = yield* owner.values(
								`SELECT "r1"."${columns[0]}"::text FROM ${view} AS "r1"`,
								[]
							)
							const defined = yield* owner.values(
								`SELECT "r1"."id"::text FROM (${conservativeSql(installed, "OwnedTasks")}) AS "r1"`,
								[]
							)
							assert.deepEqual(sorted(stored), sorted(defined))
							assert.deepEqual<ReadonlyArray<string>>(sorted(stored), ownedOf(c))
							k.noteAll(deferredFeatures(c))
						}),
						Effect.orDie(owner.rollback)
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the tasks whose account the transaction holds, on the host, and the definition's conservative lowering"
		},
		budget: { runs: 8, steered: 12 },
		kept: [],
		kills: []
	})
