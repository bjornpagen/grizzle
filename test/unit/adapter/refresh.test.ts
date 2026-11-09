import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	subset,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Option, Order, Result, String as Str } from "effect"
import { textArray } from "#adapter/admission/roles.ts"
import {
	CommitUnknown,
	ExecutionFailure,
	StaleSnapshot,
	TransientFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import { LayerReleased } from "#adapter/errors/failures.ts"
import { concurrentRefreshDetail, concurrentRefreshPosition } from "#adapter/refresh/detail.ts"
import { runRefresh } from "#adapter/refresh/run.ts"
import {
	populatedParams,
	populatedSql,
	refreshBlock,
	refreshPlan
} from "#adapter/refresh/statements.ts"
import { type RefreshTarget, refreshTargets } from "#adapter/refresh/targets.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import type { RoleDesc } from "#compiler/ir/desc.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type AnyRelation,
	type AnySchema,
	derived,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { materializedDerived as derivedOver } from "#compiler/schema/relation.ts"
import { admitRole, roleDescOf } from "#compiler/schema/world.ts"
import { assert, defined, refusalLoc, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { prologueIn } from "#test/support/flight/model.ts"
import {
	answeringScript,
	immediateDelivery,
	rows,
	type StatementAnswer,
	scriptedPool,
	scriptedSession,
	texts
} from "#test/support/flight/scripted.ts"
import { atDeclaredName, installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

import { regex } from "arkregex"
import { paramText } from "#test/support/wire.ts"

/**
 * db.refresh without PostgreSQL: which views a call refreshes and in which order, its refusals before any SQL, the
 * catalog statements and the block that decide plain or CONCURRENTLY in the server, its one flight on a scripted
 * session (test/support/flight/scripted.ts), and how each way the flight can fail ends the refresh.
 */
const Sitting = relation(
	"Sitting",
	{ id: uuid, student: uuid, week: pg.integer, passed: pg.boolean },
	["id"]
)
const Edu = schema("Edu", { Sitting }, [])

/** A role value's Description, as Db.open parses it. */
const declaredOf = (value: unknown): RoleDesc =>
	defined(roleDescOf(value), "a role built by role(...)")

/**
 * The definition of the derived relation numbered `n`: each student's sittings from week n on, so no two numbers give
 * one definition.
 */
const definitionOf = (n: number) =>
	queryOver(Edu).rule((r: RuleValue) => {
		const { id, student, week } = varsOver(Sitting, "sitting")
		return r
			.match(Sitting, { id, student, week })
			.where(r.ge(week, n))
			.find({ student, total: r.count() })
	})

/**
 * A schema of derived relations, drawn as the levels above Edu, each a record of one to three relations, derived or
 * base, in declared order; the role's refresh list, each derived relation in it or not; and the values a call names,
 * each a derived relation of the schema or a JavaScript look-alike of one, a derived relation of another definition
 * under one of the schema's names, one the schema lacks, or a value that is no derived relation.
 */
type Requested =
	| { readonly kind: "a derived relation of the schema"; readonly pick: number }
	| { readonly kind: "a look-alike of one"; readonly pick: number }
	| { readonly kind: "another definition under its name"; readonly pick: number }
	| { readonly kind: "a derived relation the schema lacks" }
	| {
			readonly kind: "no derived relation"
			readonly value: "a base relation" | "a name" | "a number" | "an empty object"
	  }

interface TargetsCase {
	readonly levels: ReadonlyArray<ReadonlyArray<"derived" | "base">>
	readonly refresh: ReadonlyArray<boolean>
	readonly requested: Arr.NonEmptyReadonlyArray<Requested>
}

const requestedGen: Gen<Requested> = weighted<Requested>([
	[
		6,
		(source) => ({ kind: "a derived relation of the schema", pick: source.draw(int(0, 0xffff)) })
	],
	[2, (source) => ({ kind: "a look-alike of one", pick: source.draw(int(0, 0xffff)) })],
	[
		1,
		(source) => ({ kind: "another definition under its name", pick: source.draw(int(0, 0xffff)) })
	],
	[1, constant({ kind: "a derived relation the schema lacks" })],
	[
		1,
		(source) => ({
			kind: "no derived relation",
			value: source.draw(
				element(["a base relation", "a name", "a number", "an empty object"] as const)
			)
		})
	]
])

const targetsCaseGen: Gen<TargetsCase> = (source) => {
	const first = source.draw(array(element(["derived", "base"] as const), { min: 0, max: 2 }))
	const levels = [
		["derived" as const, ...first],
		...source.draw(
			array(array(element(["derived", "base"] as const), { min: 1, max: 3 }), { min: 0, max: 2 })
		)
	]
	const derivedCount = Arr.filter(Arr.flatten(levels), (k) => k === "derived").length
	return {
		levels,
		refresh: source.draw(array(boolean, { min: derivedCount, max: derivedCount })),
		requested: [source.draw(requestedGen), ...source.draw(array(requestedGen, { min: 0, max: 4 }))]
	}
}

/** A derived relation of a drawn schema: its name, its number, its level and its position in that level's record. */
interface Declared {
	readonly name: string
	readonly n: number
	readonly level: number
	readonly position: number
	readonly value: unknown
}

/** The derived relation numbered `n`, named `D<n>`. */
const derivedAt = (n: number) => derivedOver(`D${n}`, definitionOf(n), [])

/** The schema a case draws, its derived relations, and the Description of its role. */
const built = (c: TargetsCase) => {
	const declared: Array<Declared> = []
	const entries: Record<string, unknown> = { Sitting }
	let base: AnySchema = Edu
	let count = 0
	for (const [index, kinds] of c.levels.entries()) {
		const record: Record<string, AnyRelation | ReturnType<typeof derivedAt>> = {}
		for (const [position, kind] of kinds.entries()) {
			const n = count++
			if (kind === "base") {
				const value = relation(`X${n}`, { id: uuid }, ["id"])
				record[`X${n}`] = value
				entries[`X${n}`] = value
			} else {
				const value = derivedAt(n)
				record[`D${n}`] = value
				entries[`D${n}`] = value
				declared.push({ name: `D${n}`, n, level: index + 1, position, value })
			}
		}
		base = schema.extend(base, `Level${index + 1}`, record, [])
	}
	const refreshed = Arr.filter(declared, (_, i) => c.refresh[i] === true)
	const refresher = admitRole(
		base,
		"refresher",
		entries,
		{ refresh: Arr.map(refreshed, (d) => d.name) },
		[]
	).desc
	return {
		schema: base,
		declared,
		refreshed: new Set(Arr.map(refreshed, (d) => d.name)),
		refresher
	}
}

/** The model's verdict on one named value: a target, outside the role, or no derived relation of the schema. */
type ValueVerdict =
	| { readonly kind: "target"; readonly declared: Declared }
	| { readonly kind: "outside"; readonly name: string }
	| { readonly kind: "malformed" }

type TargetsFeature =
	| Requested["kind"]
	| "refreshed in level order"
	| "a relation named twice"
	| "a later level's relation named first"
	| "refused OutsideRole"
	| "refused MalformedDescription"

describe("db.refresh targets", () => {
	it.effect(
		"are the named relations once each, in level order then declared order, and a value outside the role or no derived relation of the schema is refused",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/refresh-targets",
						draw: drawn(targetsCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the refresh order and refusals restated over the drawn levels and refresh list"
						},
						coverage: required<TargetsFeature>(
							[
								"a derived relation of the schema",
								"a look-alike of one",
								"another definition under its name",
								"a derived relation the schema lacks",
								"no derived relation",
								"refreshed in level order",
								"a relation named twice",
								"a later level's relation named first",
								"refused OutsideRole",
								"refused MalformedDescription"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 80,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const b = built(c)
							const artifacts = succeeded(testArtifacts(b.schema, testCompile))
							const names = installationNamesOf(installationOf(b.schema, atDeclaredName))
							const pickOf = (pick: number): Declared =>
								defined(b.declared[pick % b.declared.length], "a derived relation")
							const valueOf = (r: Requested): unknown => {
								switch (r.kind) {
									case "a derived relation of the schema":
										return pickOf(r.pick).value
									case "a look-alike of one": {
										const d = pickOf(r.pick)
										return { kind: "derived", name: d.name, definition: definitionOf(d.n) }
									}
									case "another definition under its name":
										return derivedOver(pickOf(r.pick).name, definitionOf(1_000), [])
									case "a derived relation the schema lacks":
										return derivedOver("Lacking", definitionOf(0), [])
									case "no derived relation":
										switch (r.value) {
											case "a base relation":
												return Sitting
											case "a name":
												return pickOf(0).name
											case "a number":
												return 1
											case "an empty object":
												return {}
										}
								}
							}
							const verdictOf = (r: Requested): ValueVerdict => {
								switch (r.kind) {
									case "a derived relation of the schema":
									case "a look-alike of one": {
										const d = pickOf(r.pick)
										return b.refreshed.has(d.name)
											? { kind: "target", declared: d }
											: { kind: "outside", name: d.name }
									}
									case "another definition under its name":
									case "a derived relation the schema lacks":
									case "no derived relation":
										return { kind: "malformed" }
								}
							}
							const verdicts = Arr.map(c.requested, verdictOf)
							const result = refreshTargets(b.refresher, artifacts, Arr.map(c.requested, valueOf))
							for (const r of c.requested) {
								k.note(r.kind)
							}
							const refusal = Arr.findFirst(verdicts, (v) => v.kind !== "target")
							if (Option.isSome(refusal)) {
								assert.ok(Result.isFailure(result), "a refused value refuses the call")
								const e = result.failure
								assert.equal(formatLoc(refusalLoc(e)), "db.refresh")
								const verdict = refusal.value
								if (verdict.kind === "outside") {
									assert.deepEqual(
										e.reason._tag === "OutsideRole"
											? { role: e.reason.role, access: e.reason.access }
											: e.reason._tag,
										{ role: "refresher", access: { kind: "refresh", relation: verdict.name } }
									)
									k.note("refused OutsideRole")
								} else {
									assert.equal(e.reason._tag, "MalformedDescription")
									k.note("refused MalformedDescription")
								}
								return
							}
							const named = Arr.flatMap(verdicts, (v) => (v.kind === "target" ? [v.declared] : []))
							const expected = Arr.sort(
								Arr.dedupeWith(named, (x, y) => x.name === y.name),
								Order.mapInput(
									Order.Tuple([Order.Number, Order.Number]),
									(d: Declared) => [d.level, d.position] as const
								)
							)
							assert.deepEqual<ReadonlyArray<unknown>>(
								Arr.map(succeeded(result), (t) => ({
									relation: t.relation,
									level: t.level,
									position: t.position,
									view: t.view
								})),
								Arr.map(expected, (d) => ({
									relation: d.name,
									level: d.level,
									position: d.position,
									view: {
										schema: conversionOf(`Level${d.level}`),
										name: names.tableIdent({ name: d.name })
									}
								}))
							)
							k.note("refreshed in level order")
							if (named.length > expected.length) {
								k.note("a relation named twice")
							}
							if (
								Arr.some(named, (d, i) =>
									Arr.some(named.slice(i + 1), (later) => later.level < d.level)
								)
							) {
								k.note("a later level's relation named first")
							}
						})
				)
			)
	)
})

/**
 * PostgreSQL's reading of a text[] literal whose elements are all quoted (array_in): inside the quotes a backslash
 * takes the next character as it is and a bare quote ends the element; any other text is no such literal.
 */
const readTextArray = (literal: string): ReadonlyArray<string> | "unread" => {
	if (literal === "{}") {
		return []
	}
	if (!Str.startsWith("{")(literal)) {
		return "unread"
	}
	const out: Array<string> = []
	let i = 1
	for (;;) {
		if (literal[i] !== '"') {
			return "unread"
		}
		i++
		let element = ""
		for (;;) {
			const ch = literal[i]
			if (ch === undefined) {
				return "unread"
			}
			if (ch === '"') {
				break
			}
			if (ch === "\\") {
				const next = literal[i + 1]
				if (next === undefined) {
					return "unread"
				}
				element += next
				i += 2
			} else {
				element += ch
				i++
			}
		}
		out.push(element)
		i++
		if (literal[i] === "}") {
			return i === literal.length - 1 ? out : "unread"
		}
		if (literal[i] !== ",") {
			return "unread"
		}
		i++
	}
}

/** A block's DETAIL: one naming a target's position, or one naming none. */
type Detail =
	| { readonly kind: "a position"; readonly position: number }
	| { readonly kind: "no position"; readonly detail: string | undefined }

/** Every position below a hundred, and the near misses of a DETAIL that names one. */
const detailGen: Gen<Detail> = oneOf<Detail>([
	map(int(0, 99), (position) => ({ kind: "a position", position })),
	map(
		element([
			undefined,
			"",
			"ConcurrentRefresh ",
			"ConcurrentRefresh 01",
			"ConcurrentRefresh -1",
			"x 1"
		]),
		(detail) => ({ kind: "no position", detail })
	)
])

type TextArrayFeature =
	| "no element"
	| "an empty element"
	| "an element with a quote"
	| "an element with a backslash"
	| "an element with a comma or brace"
	| "a repeated view"

describe("plain or CONCURRENTLY", () => {
	it.effect(
		"passes the views as one text[] literal PostgreSQL reads back as them, each once, whatever their order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/adapter/text-array",
						draw: drawn(
							array(
								string(characterOf(["a", "Z", " ", '"', "\\", ",", "{", "}", "é", "😀"]), {
									min: 0,
									max: 5
								}),
								{ min: 0, max: 4 }
							)
						),
						literal: Formatter.format,
						coverage: required<TextArrayFeature>(
							[
								"no element",
								"an empty element",
								"an element with a quote",
								"an element with a backslash",
								"an element with a comma or brace",
								"a repeated view"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(views, c) =>
						Effect.sync(() => {
							if (views.length === 0) {
								c.note("no element")
							}
							for (const view of views) {
								if (view === "") {
									c.note("an empty element")
								}
								if (Str.includes('"')(view)) {
									c.note("an element with a quote")
								}
								if (Str.includes("\\")(view)) {
									c.note("an element with a backslash")
								}
								if (regex("[,{}]", "u").test(view)) {
									c.note("an element with a comma or brace")
								}
							}
							if (new Set(views).size < views.length) {
								c.note("a repeated view")
							}
							assert.deepEqual(readTextArray(textArray(views)), views)
							const params = populatedParams("edu", views)
							const [schemaParam, viewsParam] = params
							assert.equal(schemaParam, paramText("edu"))
							const read = readTextArray(defined(viewsParam, "the views parameter"))
							assert.ok(read !== "unread", "the views parameter is no text[] literal")
							unorderedEqual(read, [...new Set(views)], "each view once")
							assert.deepEqual(
								populatedParams("edu", Arr.reverse(views)),
								params,
								"whatever their order"
							)
						})
				)
			)
	)

	it.effect(
		"names the refused target by its position in refresh order, and nothing else as one",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/adapter/refresh-position",
						generator: detailGen,
						literal: Formatter.format,
						limit: 200,
						coverage: requiredInSpace<Detail["kind"]>(["a position", "no position"]),
						caseHang
					},
					(detail, c) =>
						Effect.sync(() => {
							c.note(detail.kind)
							assert.equal(
								concurrentRefreshPosition(
									detail.kind === "a position"
										? concurrentRefreshDetail(detail.position)
										: detail.detail
								),
								detail.kind === "a position" ? detail.position : undefined
							)
						})
				)
			)
	)
})

/**
 * How a refresh ends, over its one flight on a scripted session: the targets a call names among three derived relations
 * (B and A at level 1, written in that order, and C at level 2 over B), which of their views the catalog reports
 * populated, and one fault where the flight can meet one. The oracle is the contract of run.ts restated: a committed
 * refresh ran BEGIN, the fence, the role's entry, the populated read of each PostgreSQL schema the views live in (each
 * level's own), the block over the views in refresh order and
 * COMMIT, in one flight, CONCURRENTLY exactly for the populated views; 40001 and 40P01 anywhere are TransientFailure; the
 * block's grizzle concurrent change naming a target's position is TransientFailure{ConcurrentRefresh} of that target,
 * and one naming no target is the server's report; the fence's refusals are StaleSnapshot; every other refusal is
 * ExecutionFailure with the server's report; a connection lost anywhere in the flight, which carries COMMIT, is
 * CommitUnknown, and one the server ended at a statement TransportFailure at stage transport; an acquisition refused is
 * TransportFailure at stage acquire. A failed refresh commits nothing.
 */
const Weekly = query(Edu).rule((r) => {
	const { id, student, week, passed } = v(Sitting, "sitting")
	return r.match(Sitting, { id, student, week, passed }).find({
		student,
		week,
		sittings: r.count(),
		passes: r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0))
	})
})
const Totals = query(Edu).rule((r) => {
	const { id, student } = v(Sitting, "sitting")
	return r.match(Sitting, { id, student }).find({ student, total: r.count() })
})
const B = derived.materialized("B", Weekly)
const A = derived.materialized("A", Totals)
const Level1 = schema.extend(Edu, "Level1", { B, A }, [])
const Busy = query(Level1).rule((r) => {
	const { student, week } = v(B, "b")
	return r.match(B, { student, week }).find({ week, students: r.count() })
})
const C = derived.materialized("C", Busy)
const Reports = schema.extend(Level1, "Reports", { C }, [])
const Refresher = role(Reports, "refresher", Reports.relations, { refresh: ["A", "B", "C"] })
const reports = succeeded(testArtifacts(Reports, testCompile))
const reportsNames = installationNamesOf(installationOf(Reports, atDeclaredName))

/** The prologue a refresh runs behind: the fence on the installation's ledger, then its role. */
const asRefresher = prologueIn(reportsNames.schema)

/** Where in the flight a fault lands. */
type Where = "the fence" | "the role's entry" | "the populated read" | "the block" | "COMMIT"

/** The SQLSTATEs a refusal draws: each code the contract reads, and others it passes on. */
const refusals: Arr.NonEmptyReadonlyArray<Sqlstate> = [
	sqlstates.serializationFailure,
	sqlstates.deadlockDetected,
	sqlstates.grizzleConcurrentChange,
	sqlstates.lockNotAvailable,
	sqlstates.grizzleMigrating,
	sqlstates.grizzleMigrated,
	sqlstates.insufficientPrivilege,
	sqlstates.uniqueViolation,
	sqlstates.cardinalityViolation,
	sqlstates.undefinedTable
]

/** A grizzle concurrent change's DETAIL: a position in refresh order, in range or past it, or none. */
type BlockDetail =
	| { readonly kind: "a position"; readonly position: number }
	| { readonly kind: "none" }

type RefreshFault =
	| { readonly kind: "none" }
	| { readonly kind: "acquisition refused" }
	| {
			readonly kind: "refused"
			readonly where: Where
			readonly sqlstate: Sqlstate
			readonly detail: BlockDetail
	  }
	| { readonly kind: "lost"; readonly where: Where }
	| { readonly kind: "ended by the server"; readonly where: Exclude<Where, "COMMIT"> }

interface EndingCase {
	readonly named: Arr.NonEmptyReadonlyArray<"A" | "B" | "C">
	readonly populated: ReadonlyArray<"A" | "B" | "C">
	readonly fault: RefreshFault
}

const whereGen = element<Where>([
	"the fence",
	"the role's entry",
	"the populated read",
	"the block",
	"COMMIT"
])

const endingCaseGen: Gen<EndingCase> = (source) => {
	const all = ["A", "B", "C"] as const
	const first = source.draw(element(all))
	return {
		named: [first, ...source.draw(subset(all, { min: 0, max: 3 }))],
		populated: source.draw(subset(all, { min: 0, max: 3 })),
		fault: source.draw(
			weighted<RefreshFault>([
				[2, constant({ kind: "none" })],
				[1, constant({ kind: "acquisition refused" })],
				[
					6,
					(inner) => ({
						kind: "refused",
						where: inner.draw(whereGen),
						sqlstate: inner.draw(element(refusals)),
						detail: inner.draw(
							oneOf<BlockDetail>([
								constant({ kind: "none" }),
								(at) => ({ kind: "a position", position: at.draw(int(0, 4)) })
							])
						)
					})
				],
				[1, (inner) => ({ kind: "lost", where: inner.draw(whereGen) })],
				[
					1,
					(inner) => ({
						kind: "ended by the server",
						where: inner.draw(
							element<Exclude<Where, "COMMIT">>([
								"the fence",
								"the role's entry",
								"the populated read",
								"the block"
							])
						)
					})
				]
			])
		)
	}
}

/** How a refresh ended, as its caller tells endings apart: by tag, reason, SQLSTATE and stage. */
type Told =
	| { readonly kind: "refreshed"; readonly ran: ReadonlyArray<readonly [string, boolean]> }
	| { readonly kind: "transient"; readonly reason: TransientTag; readonly sqlstate: string }
	| { readonly kind: "concurrent refresh"; readonly relation: string }
	| { readonly kind: "execution"; readonly sqlstate: string }
	| { readonly kind: "stale"; readonly reason: string }
	| { readonly kind: "commit unknown" }
	| { readonly kind: "transport"; readonly stage: string }
	| { readonly kind: "other"; readonly failure: unknown }

const told = (failure: unknown): Told => {
	if (failure instanceof TransientFailure) {
		return failure.reason._tag === "ConcurrentRefresh"
			? { kind: "concurrent refresh", relation: failure.reason.relation }
			: { kind: "transient", reason: failure.reason._tag, sqlstate: failure.error.sqlstate }
	}
	if (failure instanceof ExecutionFailure && failure.reason._tag === "ServerError") {
		return { kind: "execution", sqlstate: failure.reason.sqlstate }
	}
	if (failure instanceof StaleSnapshot) {
		return { kind: "stale", reason: failure.reason._tag }
	}
	if (failure instanceof CommitUnknown) {
		return { kind: "commit unknown" }
	}
	if (failure instanceof TransportFailure) {
		return { kind: "transport", stage: failure.stage }
	}
	return { kind: "other", failure }
}

/** A refusal's meaning anywhere but at the fence or the block: SERIALIZABLE's two refusals retry, the rest fail. */
const classified = (sqlstate: Sqlstate): Told =>
	sqlstate === sqlstates.serializationFailure
		? { kind: "transient", reason: "SerializationFailure", sqlstate }
		: sqlstate === sqlstates.deadlockDetected
			? { kind: "transient", reason: "Deadlock", sqlstate }
			: { kind: "execution", sqlstate }

/** The contract's ending of a case, over its targets in refresh order. */
const expectedEnding = (c: EndingCase, targets: ReadonlyArray<RefreshTarget>): Told => {
	const fault = c.fault
	switch (fault.kind) {
		case "none":
			return {
				kind: "refreshed",
				ran: Arr.map(
					targets,
					(t) => [t.relation, Arr.some(c.populated, (p) => p === t.relation)] as const
				)
			}
		case "acquisition refused":
			return { kind: "transport", stage: "acquire" }
		case "lost":
			return { kind: "commit unknown" }
		case "ended by the server":
			return { kind: "transport", stage: "transport" }
		case "refused":
			switch (fault.where) {
				case "the fence":
					return fault.sqlstate === sqlstates.lockNotAvailable
						? { kind: "stale", reason: "Migrating" }
						: classified(fault.sqlstate)
				case "the role's entry":
					return fault.sqlstate === sqlstates.grizzleMigrating
						? { kind: "stale", reason: "Migrating" }
						: fault.sqlstate === sqlstates.grizzleMigrated
							? { kind: "stale", reason: "Migrated" }
							: classified(fault.sqlstate)
				case "the populated read":
				case "the block": {
					const target =
						fault.sqlstate === sqlstates.grizzleConcurrentChange &&
						fault.detail.kind === "a position"
							? targets[fault.detail.position]
							: undefined
					return target === undefined
						? classified(fault.sqlstate)
						: { kind: "concurrent refresh", relation: target.relation }
				}
				case "COMMIT":
					return classified(fault.sqlstate)
			}
	}
}

/** The refusal a fault's server sends. */
const refusalOf = (fault: Extract<RefreshFault, { readonly kind: "refused" }>) =>
	serverError({
		...nothingReported,
		sqlstate: fault.sqlstate,
		detail:
			fault.detail.kind === "a position"
				? concurrentRefreshDetail(fault.detail.position)
				: undefined
	})

/** Which statement of the flight a query is, by its text. */
const whereOf = (sql: string): Exclude<Where, "COMMIT"> =>
	sql === asRefresher.fence.sql
		? "the fence"
		: sql === asRefresher.enter.sql
			? "the role's entry"
			: sql === populatedSql
				? "the populated read"
				: "the block"

/** The scripted session a case's server is: answering as PostgreSQL does but where its fault lands. */
const sessionOf = (c: EndingCase, populatedViews: ReadonlyArray<string>) => {
	const fault = c.fault
	const lands = (where: Where): boolean =>
		(fault.kind === "refused" || fault.kind === "lost" || fault.kind === "ended by the server") &&
		fault.where === where
	return scriptedSession(
		{
			...answeringScript,
			statement: (query): StatementAnswer => {
				const where = whereOf(query.sql)
				if (lands(where)) {
					switch (fault.kind) {
						case "refused":
							return { _tag: "refused", error: refusalOf(fault) }
						case "lost":
							return { _tag: "lose" }
						case "ended by the server":
							return {
								_tag: "fatal",
								error: serverError({ ...nothingReported, sqlstate: sqlstates.outOfMemory })
							}
						case "none":
						case "acquisition refused":
							break
					}
				}
				return where === "the populated read"
					? rows(Arr.map(populatedViews, (view) => [view, "true"]))
					: rows([])
			},
			commit: () =>
				fault.kind === "refused" && fault.where === "COMMIT"
					? refusalOf(fault)
					: fault.kind === "lost" && fault.where === "COMMIT"
						? "lose"
						: undefined
		},
		immediateDelivery
	)
}

type EndingFeature =
	| "refreshed"
	| "refreshed CONCURRENTLY"
	| `refused at ${Where}`
	| `lost at ${Where}`
	| "ended by the server"
	| "acquisition refused"
	| Told["kind"]

describe("how a refresh ends", () => {
	it.effect(
		"as its one SERIALIZABLE flight's answers say: committed in refresh order, retryable on SERIALIZABLE's refusals and a rewritten view, stale at the fence, unknown when COMMIT may have run, and the server's report otherwise",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/refresh-endings",
						draw: drawn(endingCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the refresh transaction's endings, restated from run.ts over the fault the server meets"
						},
						coverage: required<EndingFeature>(
							[
								"refreshed",
								"refreshed CONCURRENTLY",
								"refused at the fence",
								"refused at the role's entry",
								"refused at the populated read",
								"refused at the block",
								"refused at COMMIT",
								"lost at the block",
								"lost at COMMIT",
								"ended by the server",
								"acquisition refused",
								"transient",
								"concurrent refresh",
								"execution",
								"stale",
								"commit unknown",
								"transport"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const targets = succeeded(
								refreshTargets(
									declaredOf(Refresher),
									reports,
									Arr.map(c.named, (name) => (name === "A" ? A : name === "B" ? B : C))
								)
							)
							const populatedViews = Arr.map(c.populated, (name) =>
								reportsNames.tableIdent({ name })
							)
							const session = sessionOf(c, populatedViews)
							const exit = yield* Effect.exit(
								runRefresh(
									{
										prologue: asRefresher,
										pool: scriptedPool({
											lease:
												c.fault.kind === "acquisition refused"
													? Effect.fail(new LayerReleased())
													: Effect.succeed(session)
										})
									},
									refreshPlan(targets)
								)
							)
							const expected = expectedEnding(c, targets)
							if (Exit.isSuccess(exit)) {
								const ran = Arr.map(
									exit.value.statements,
									(s) => [s.relation, s.concurrently] as const
								)
								assert.deepEqual<Told>({ kind: "refreshed", ran }, expected)
								const [only, ...rest] = session.flights()
								assert.deepEqual(rest, [], "one flight")
								assert.deepEqual(texts(only), [
									"BEGIN ISOLATION LEVEL SERIALIZABLE",
									asRefresher.fence.sql,
									asRefresher.enter.sql,
									...Arr.map(
										Arr.dedupe(Arr.map(targets, (t) => t.view.schema)),
										() => populatedSql
									),
									refreshBlock(Arr.map(targets, (t) => t.view)),
									"COMMIT"
								])
								k.note("refreshed")
								if (Arr.some(ran, ([, concurrently]) => concurrently)) {
									k.note("refreshed CONCURRENTLY")
								}
								return
							}
							const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
							const ending = told(failure)
							assert.deepEqual(ending, expected)
							assert.deepEqual(session.committed(), [], "a failed refresh commits nothing")
							k.note(ending.kind)
							const fault = c.fault
							switch (fault.kind) {
								case "refused":
									k.note(`refused at ${fault.where}`)
									break
								case "lost":
									k.note(`lost at ${fault.where}`)
									break
								case "ended by the server":
									k.note("ended by the server")
									break
								case "acquisition refused":
									k.note("acquisition refused")
									break
								case "none":
									break
							}
						})
				)
			)
	)
})
