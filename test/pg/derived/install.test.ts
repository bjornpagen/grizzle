import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, type Gen, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, pipe, String as Str } from "effect"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import * as Result from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import type { InferredFieldDesc } from "#compiler/ir/desc.ts"
import { baseOf, textInfoOf } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import { Compute } from "#compiler/public/compute.ts"
import { uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { printObjectName, printType, quoteIdent } from "#compiler/sql/print.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined as present, succeeded } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import {
	type Installed,
	installMigrated as install,
	loadMigrated as load
} from "#test/support/install-migrate.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checkedIn } from "#test/support/policy.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import * as K from "#test/unit/derived/kit.ts"

/** Derived relations installed on PostgreSQL 19 (gate).
 *
 * - the inferred descriptors hold: every view column's catalog type, typmod and collation is the one its inferred field
 *   descriptor names, for every aggregate overload, refinement, roster and contract, a closed id read from its roster's
 *   own facts, which the lowering delivers as a smallint literal, included;
 * - over drawn patterns, a view column of a refined-text literal has its pattern's domain, whether a stored field
 *   declares the pattern or not, and plain text for the wildcard; a role refreshing the relation refreshes the
 *   materialized view, plainly and concurrently, to the definition's rows, and a role reading it reads the literals
 *   through its world's view;
 * - a refresh inside an owner's transaction whose drawn writes leave a deferred containment false (tasks of absent
 *   accounts added, accounts of tasks removed: transaction evidence) equals the definition evaluated by the conservative
 *   lowering on the same snapshot, and the tasks whose account the transaction holds.
 *
 * That every refreshed view equals its definition, over drawn levels, take forms and aggregates, is the derived
 * oracle's; the installed catalog is the catalog spec checker's. */

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

/** The view of a derived relation and its columns, in heading order. */
const viewOf = (installed: Installed, relation: string) => {
	const a = Result.map(checkedIn(installed.installation.owned), derivedAnalysis)
	if (!a.ok) {
		throw a.error
	}
	const r = a.value.relations[relation]
	if (r === undefined) {
		throw new Error(`no derived relation ${relation}`)
	}
	const view = installed.names.relation(relation)
	const columns = Arr.map(r.heading, (c) => installed.names.column(relation, c.name))
	return { analysis: r, view: printObjectName(view), columns }
}

/** The definition's conservative lowering, the oracle baseline that relies on no evidence. */
const conservativeSql = (installed: Installed, relation: string): string => {
	const { analysis } = viewOf(installed, relation)
	const program = lowerConservative(conservativeInput(analysis.query), {
		names: installed.names,
		params: [],
		subject: { kind: "query" }
	})
	if (!program.ok) {
		throw program.error
	}
	return flight(program.value.roots)[0].sql.text
}

/** The view's rows and its definition's rows, each as record text, read in one snapshot. */
const viewAndDefinition = (installed: Installed, relation: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const owner = yield* substrate.session({ ...ownerSession(), label: "oracle" })
		const { view, columns, analysis } = viewOf(installed, relation)
		const names = Arr.map(analysis.heading, (c) => `"${c.name}"`)
		yield* owner.begin
		const stored = yield* owner.values(
			`SELECT ROW(${Arr.join(
				Arr.map(columns, (c) => `"r1"."${c}"`),
				", "
			)})::text FROM ${view} AS "r1"`,
			[]
		)
		const defined = yield* owner.values(
			`SELECT ROW(${Arr.join(
				Arr.map(names, (n) => `"r1".${n}`),
				", "
			)})::text FROM (${conservativeSql(installed, relation)}) AS "r1"`,
			[]
		)
		yield* owner.commit
		const sorted = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
			Arr.sort(
				Arr.map(rows, (r) => String(r[0])),
				Order.String
			)
		return { stored: sorted(stored), defined: sorted(defined) }
	})

const workFacts = {
	Account: [
		{ id: id(1), name: "alpha" },
		{ id: id(2), name: "beta" },
		{ id: id(3), name: "gamma" }
	],
	Task: [
		{ id: id(11), account: id(1), kind: "Automatic" },
		{ id: id(12), account: id(1), kind: "Automatic" },
		{ id: id(13), account: id(1), kind: "Manual" },
		{ id: id(14), account: id(2), kind: "Automatic" }
	],
	AutomaticTask: [
		{ task: id(11), budget: 100n },
		{ task: id(12), budget: 100n },
		{ task: id(14), budget: 250n }
	],
	ManualTask: [{ task: id(13), operator: "ops" }]
}

/**
 * The atttypmod of an inferred descriptor's column: numeric(p, s)'s, and -1 for every other, a computed numeric's numeric
 * of no typmod among them.
 */
const typmodOf = (desc: InferredFieldDesc): number =>
	desc.kind === "numeric" ? ((desc.precision << 16) | desc.scale) + 4 : -1

/** The accounts the work facts hold, and those and two accounts no fact holds. */
const heldAccounts: ReadonlyArray<string> = [id(1), id(2), id(3)]
const everyAccount: Arr.NonEmptyReadonlyArray<string> = [id(1), id(2), id(3), id(7), id(8)]

/**
 * A transaction's writes before its refresh, under every constraint deferred: tasks added, each of a held account or
 * of an absent one, and held accounts removed whatever tasks they own.
 */
interface DeferredCase {
	readonly added: ReadonlyArray<string>
	readonly removed: ReadonlyArray<string>
}

const deferredCaseGen: Gen<DeferredCase> = (source) => ({
	added: source.draw(array(element(everyAccount), { min: 0, max: 2 })),
	removed: source.draw(subset(heldAccounts, { min: 0, max: 2 }))
})

/** The tasks the definition holds in the transaction: every task, fact or added, whose account it still holds. */
const ownedOf = (c: DeferredCase): ReadonlyArray<string> => {
	const accounts = new Set<string>(Arr.filter(heldAccounts, (a) => !c.removed.includes(a)))
	const tasks = [
		...Arr.map(workFacts.Task, (t) => [t.id, t.account] as const),
		...Arr.map(c.added, (account, i) => [id(16 + i), account] as const)
	]
	return Arr.sort(
		Arr.flatMap(tasks, ([task, account]) => (accounts.has(account) ? [task] : [])),
		Order.String
	)
}

type DeferredFeature =
	| "a task of an absent account added"
	| "a task of a held account added"
	| "an account of tasks removed"

const deferredFeatures = (c: DeferredCase): ReadonlyArray<DeferredFeature> => [
	...(Arr.some(c.added, (a) => !Arr.contains(heldAccounts, a) || c.removed.includes(a))
		? ["a task of an absent account added" as const]
		: []),
	...(Arr.some(c.added, (a) => Arr.contains(heldAccounts, a) && !c.removed.includes(a))
		? ["a task of a held account added" as const]
		: []),
	...(Arr.some(c.removed, (a) => Arr.some(workFacts.Task, (t) => t.account === a))
		? ["an account of tasks removed" as const]
		: [])
]

/** The patterns a case's field and literals are drawn from: three that a domain refines, and the wildcard. */
const patterns = {
	upper: { source: "^[A-Z]{3}$", flags: "u", members: ["ABC", "QRS"] },
	lower: { source: "^[a-z]+$", flags: "u", members: ["abc", "z"] },
	digits: { source: "^[0-9]{2}$", flags: "u", members: ["42", "07"] },
	any: { source: "^.*$", flags: "su", members: ["x", "Q7"] }
} as const

type PatternKey = keyof typeof patterns

const patternKeys: Arr.NonEmptyReadonlyArray<PatternKey> = ["upper", "lower", "digits", "any"]

/** A pattern's refined text. */
const refinedOf = (key: PatternKey) => {
	switch (key) {
		case "upper":
			return str.regex("^[A-Z]{3}$")
		case "lower":
			return str.regex("^[a-z]+$")
		case "digits":
			return str.regex("^[0-9]{2}$")
		case "any":
			return str.regex("^.*$", "su")
	}
}

/** The text a literal of a pattern holds: its first member. */
const memberOf = (key: PatternKey): string => patterns[key].members[0]

/** A literal of a pattern's refined text, holding its first member. */
const literalOf = (key: PatternKey) => {
	switch (key) {
		case "upper":
			return Compute.literal(str.regex("^[A-Z]{3}$"), "ABC")
		case "lower":
			return Compute.literal(str.regex("^[a-z]+$"), "abc")
		case "digits":
			return Compute.literal(str.regex("^[0-9]{2}$"), "42")
		case "any":
			return Compute.literal(str.regex("^.*$", "su"), "x")
	}
}

/** A case: Coded's field's pattern, its rows' codes, and the patterns of the derived relation's two literals. */
interface LiteralCase {
	readonly declared: PatternKey
	readonly codes: ReadonlyArray<string>
	readonly first: PatternKey
	readonly second: PatternKey
}

const literalCaseGen: Gen<LiteralCase> = (source) => {
	const declared = source.draw(element(patternKeys))
	return {
		declared,
		codes: source.draw(array(element(patterns[declared].members), { min: 0, max: 3 })),
		first: source.draw(element(patternKeys)),
		second: source.draw(element(patternKeys))
	}
}

type LiteralFeature =
	| "a literal of a pattern a field declares"
	| "a literal of a pattern no field declares"
	| "a literal of the wildcard"
	| "rows refreshed"
	| "no row refreshed"

const literalFeatures = (c: LiteralCase): ReadonlyArray<LiteralFeature> => [
	...Arr.map([c.first, c.second], (key): LiteralFeature =>
		key === "any"
			? "a literal of the wildcard"
			: key === c.declared
				? "a literal of a pattern a field declares"
				: "a literal of a pattern no field declares"
	),
	c.codes.length > 0 ? "rows refreshed" : "no row refreshed"
]

layer(Substrate.layer)("derived relations on PostgreSQL 19", (it) => {
	it.effect(
		"inferred descriptors hold for every aggregate overload, refinement, roster and contract",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const installed = yield* install(K.KitReports, {
						ambient: ordinarySession,
						extensions: [],
						label: "derived",
						logins: []
					})
					const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
					return yield* exhaust(
						{
							suite: "derived/install/descriptors",
							generator: element([
								"Sums",
								"Means",
								"Extremes",
								"Facts",
								"Computed",
								"Kinds"
							] as const),
							literal: Formatter.format,
							limit: 6,
							coverage: noCoverage,
							caseHang
						},
						(relation) =>
							Effect.gen(function* () {
								const { analysis, view } = viewOf(installed, relation)
								for (const c of analysis.heading) {
									const column = installed.names.column(relation, c.name)
									const desc = c.desc
									const expected = printType(columnType(installed.names, c.type).type)
									const attribute = yield* owner.values(
										`SELECT (a.atttypid = '${Str.replaceAll("'", "''")(expected)}'::regtype)::text, a.atttypmod::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attname = '${column}'`,
										[]
									)
									const [[sameType, typmod, collation]] =
										trusted<Arr.NonEmptyReadonlyArray<readonly [string, string, string]>>(attribute)
									assert.equal(sameType, "true", `${relation}.${c.name} is ${expected}`)
									assert.equal(Number(typmod), typmodOf(desc), `${relation}.${c.name} typmod`)
									if (baseOf(c.type).carrier === "text") {
										assert.equal(collation, "pg_c_utf8", `${relation}.${c.name} collation`)
									}
								}
							})
					)
				})
			)
	)

	it.effect(
		"a refined-text literal column has its pattern's domain, declared by a field or not, and its refresher and reader see it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/derived/install/literals",
						draw: drawn(literalCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "each literal's pattern's installed domain, and the definition's rows by the conservative lowering"
						},
						coverage: required<LiteralFeature>(
							[
								"a literal of a pattern a field declares",
								"a literal of a pattern no field declares",
								"a literal of the wildcard",
								"rows refreshed",
								"no row refreshed"
							],
							{ cases: 12, sense: notesOnly }
						),
						kept: [],
						runs: 6,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(c, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								const substrate = yield* Substrate
								const Coded = relation("Coded", { id: uuid, code: refinedOf(c.declared) }, ["id"])
								const C = schema("C", { Coded }, [])
								const literals = query(C).rule((r) => {
									const { id } = v(Coded, "coded")
									return r.match(Coded, { id }).find({
										id,
										first: literalOf(c.first),
										second: literalOf(c.second)
									})
								})
								const Literals = derived("Literals", literals)
								const Ext = schema.extend(C, { Literals }, [])
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
								const typeOf = (key: PatternKey): string => {
									const pattern = patterns[key]
									const info = textInfoOf(
										pattern.source,
										pattern.flags,
										succeeded(textLookup(pattern.source, pattern.flags))
									)
									if (info.regex === "wildcard") {
										return "text"
									}
									const domain = installed.names.textDomain(info.regex)
									if (domain === undefined) {
										return assert.fail(`the installation names no domain of ${pattern.source}`)
									}
									return `${domain.schema}.${domain.name}`
								}
								const rows = yield* owner.values(
									`SELECT a.attname::text, a.atttypid::regtype::text, a.attcollation::regcollation::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${view}'::regclass AND a.attnum > 0 ORDER BY a.attnum`,
									[]
								)
								assert.deepEqual(rows, [
									["first", typeOf(c.first), "pg_c_utf8"],
									["id", "uuid", "-"],
									["second", typeOf(c.second), "pg_c_utf8"]
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
								const seen = `${quoteIdent(installed.role(viewer))}.${quoteIdent(installed.names.relation("Literals").name)}`
								const viewingRows = yield* viewing.values(
									`SELECT "id"::text, "first"::text, "second"::text FROM ${seen} ORDER BY 1`,
									[]
								)
								assert.deepEqual(
									viewingRows,
									Arr.map(c.codes, (_, i) => [id(i + 1), memberOf(c.first), memberOf(c.second)])
								)
								k.noteAll(literalFeatures(c))
							})
						)
				)
			)
	)

	it.effect(
		"a refresh inside an owner's transaction whose writes leave a deferred containment false equals the definition there",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const ownedTasks = query(W.Work).rule((r) => {
						const { id: t, account } = v(W.Task, "task")
						return r
							.match(W.Task, { id: t, account })
							.match(W.Account, { id: account })
							.find({ id: t })
					})
					const OwnedTasks = derived("OwnedTasks", ownedTasks)
					/** Account's name lies outside the referenced key, which makes Task.account -> Account.id deferred. */
					const Written = schema.extend(W.Work, { OwnedTasks }, [])
					const installed = yield* install(Written, {
						ambient: ordinarySession,
						extensions: [],
						label: "derived",
						logins: []
					})
					const names = namesOf(installed)
					const { view, columns } = viewOf(installed, "OwnedTasks")
					const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
					const constraint = yield* owner.values(
						`SELECT condeferrable::text FROM pg_catalog.pg_constraint WHERE conrelid = '${names.table(W.Task)}'::regclass AND contype = 'f'`,
						[]
					)
					const [[deferrable]] = trusted<Arr.NonEmptyReadonlyArray<readonly [string]>>(constraint)
					assert.equal(deferrable, "true")
					yield* load(installed, workFacts)
					/** A handle of Kind as the code the installation's codebook gives it. */
					const manual = codeOf(
						present(
							installed.names.codes.rosters.get(parsedName(W.Kind.name)),
							"the installation's codes of Kind"
						),
						"Manual"
					)
					yield* owner.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
					const sorted = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
						Arr.sort(
							Arr.map(rows, (r) => String(r[0])),
							Order.String
						)
					return yield* explore(
						{
							suite: "pg/derived/install/deferred-refresh",
							draw: drawn(deferredCaseGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the tasks whose account the transaction holds, on the host, and the definition's conservative lowering"
							},
							coverage: required<DeferredFeature>(
								[
									"a task of an absent account added",
									"a task of a held account added",
									"an account of tasks removed"
								],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(c, k) =>
							Effect.ensuring(
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
					)
				})
			)
	)
})
