/** What the properties of refresh.test.ts read: its spaces, models and helpers. */

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
} from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import {
	CommitUnknown,
	ExecutionFailure,
	StaleSnapshot,
	TransientFailure,
	TransportFailure
} from "#adapter/errors/execution.ts"
import { concurrentRefreshDetail } from "#adapter/refresh/detail.ts"
import { populatedSql } from "#adapter/refresh/statements.ts"
import { type RefreshTarget } from "#adapter/refresh/targets.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
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
import { defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { prologueIn } from "#test/support/flight/model.ts"
import {
	answeringScript,
	immediateDelivery,
	rows,
	scriptedSession,
	sentSql,
	type StatementAnswer
} from "#test/support/flight/scripted.ts"
import { atDeclaredName, installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

/**
 * db.refresh without PostgreSQL: which views a call refreshes and in which order, its refusals before any SQL, the
 * catalog statements and the block that decide plain or CONCURRENTLY in the server, its one flight on a scripted
 * session (test/support/flight/scripted.ts), and how each way the flight can fail ends the refresh.
 *
 * Oracles: the refresh order and refusals restated over the drawn targets; PostgreSQL's array literal read back by a
 * reader written here; a DETAIL names a position exactly when the block spelled one; and run.ts's contract of how each
 * fault ends the refresh, restated.
 *
 * Features: each target set and refusal; each awkward element of the views' literal and a repeated view; each DETAIL a
 * block may raise; each fault of the flight.
 */
export const Sitting = relation(
	"Sitting",
	{ id: uuid, student: uuid, week: pg.integer, passed: pg.boolean },
	["id"]
)

const Edu = schema("Edu", [Sitting], [])

/** A role value's Description, as Db.open parses it. */
export const roleDeclaredOf = (value: unknown): RoleDesc =>
	defined(roleDescOf(value), "a role built by role(...)")

/**
 * The definition of the derived relation numbered `n`: each student's sittings from week n on, so no two numbers give
 * one definition.
 */
export const definitionOf = (n: number) =>
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
export type Requested =
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

export const targetsCaseGen: Gen<TargetsCase> = (source) => {
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
export interface Declared {
	readonly name: string
	readonly n: number
	readonly level: number
	readonly position: number
	readonly value: unknown
}

/** The derived relation numbered `n`, named `D<n>`. */
const derivedAt = (n: number) => derivedOver(`D${n}`, definitionOf(n), [])

/** The schema a case draws, its derived relations, and the Description of its role. */
export const built = (c: TargetsCase) => {
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
		base = schema.extend(base, `Level${index + 1}`, Rec.values(record), [])
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
export type ValueVerdict =
	| { readonly kind: "target"; readonly declared: Declared }
	| { readonly kind: "outside"; readonly name: string }
	| { readonly kind: "malformed" }

export type TargetsFeature =
	| Requested["kind"]
	| "refreshed in level order"
	| "a relation named twice"
	| "a later level's relation named first"
	| "refused OutsideRole"
	| "refused MalformedDescription"

/**
 * PostgreSQL's reading of a text[] literal whose elements are all quoted (array_in): inside the quotes a backslash
 * takes the next character as it is and a bare quote ends the element; any other text is no such literal.
 */
export const readTextArray = (literal: string): ReadonlyArray<string> | "unread" => {
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

/**
 * A block's DETAIL: one naming a target's position, or a near miss naming none, each its own case: no DETAIL, the
 * empty one, the tag alone, a position with a leading zero, a negative position, and a position after another word.
 */
export type Detail =
	| { readonly kind: "a position"; readonly position: number }
	| { readonly kind: "no detail" }
	| { readonly kind: "the empty detail" }
	| { readonly kind: "the tag alone" }
	| { readonly kind: "a position with a leading zero"; readonly digit: number }
	| { readonly kind: "a negative position"; readonly magnitude: number }
	| {
			readonly kind: "a position after another word"
			readonly word: string
			readonly position: number
	  }

/** Every position below a hundred, and every near miss of a DETAIL that names one, over small digits and words. */
export const detailGen: Gen<Detail> = oneOf<Detail>([
	map(int(0, 99), (position) => ({ kind: "a position", position })),
	constant({ kind: "no detail" }),
	constant({ kind: "the empty detail" }),
	constant({ kind: "the tag alone" }),
	map(int(0, 9), (digit) => ({ kind: "a position with a leading zero", digit })),
	map(int(1, 9), (magnitude) => ({ kind: "a negative position", magnitude })),
	(source) => ({
		kind: "a position after another word",
		word: source.draw(string(characterOf(["x", "y"]), { min: 1, max: 2 })),
		position: source.draw(int(0, 9))
	})
])

/** The DETAIL text of a case, built from the block's own spelling of a position (concurrentRefreshDetail). */
export const detailText = (d: Detail): string | undefined => {
	switch (d.kind) {
		case "a position":
			return concurrentRefreshDetail(d.position)
		case "no detail":
			return undefined
		case "the empty detail":
			return ""
		case "the tag alone":
			return Str.slice(0, -1)(concurrentRefreshDetail(0))
		case "a position with a leading zero":
			return `${concurrentRefreshDetail(0)}${d.digit}`
		case "a negative position":
			return concurrentRefreshDetail(-d.magnitude)
		case "a position after another word":
			return `${d.word} ${d.position}`
	}
}

export type TextArrayFeature =
	| "no element"
	| "an empty element"
	| "an element with a quote"
	| "an element with a backslash"
	| "an element with a comma or brace"
	| "a repeated view"

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

export const B = derived.materialized("B", Weekly)

export const A = derived.materialized("A", Totals)

const Level1 = schema.extend(Edu, "Level1", [B, A], [])

const Busy = query(Level1).rule((r) => {
	const { student, week } = v(B, "b")
	return r.match(B, { student, week }).find({ week, students: r.count() })
})

export const C = derived.materialized("C", Busy)

const Reports = schema.extend(Level1, "Reports", [C], [])

export const Refresher = role(Reports, "refresher", Reports.relations, { refresh: ["A", "B", "C"] })

export const reports = succeeded(testArtifacts(Reports, testCompile))

export const reportsNames = installationNamesOf(installationOf(Reports, atDeclaredName))

/** The prologue a refresh runs behind: the fence on the installation's ledger, then its role. */
export const asRefresher = prologueIn(reportsNames.schema)

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

export const endingCaseGen: Gen<EndingCase> = (source) => {
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
export type Told =
	| { readonly kind: "refreshed"; readonly ran: ReadonlyArray<readonly [string, boolean]> }
	| { readonly kind: "transient"; readonly reason: TransientTag; readonly sqlstate: string }
	| { readonly kind: "concurrent refresh"; readonly relation: string }
	| { readonly kind: "execution"; readonly sqlstate: string }
	| { readonly kind: "stale"; readonly reason: string }
	| { readonly kind: "commit unknown" }
	| { readonly kind: "transport"; readonly stage: string }
	| { readonly kind: "other"; readonly failure: unknown }

/** Whether `failure` is a transient refusal, of any of the reasons one can carry. */
const isTransient = (failure: unknown): failure is TransientFailure =>
	failure instanceof TransientFailure

export const told = (failure: unknown): Told => {
	if (isTransient(failure)) {
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
export const expectedEnding = (c: EndingCase, targets: ReadonlyArray<RefreshTarget>): Told => {
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
	sql === asRefresher.fence.text.sql
		? "the fence"
		: sql === asRefresher.enter.text.sql
			? "the role's entry"
			: sql === populatedSql
				? "the populated read"
				: "the block"

/** The scripted session a case's server is: answering as PostgreSQL does but where its fault lands. */
export const sessionOf = (c: EndingCase, populatedViews: ReadonlyArray<string>) => {
	const fault = c.fault
	const lands = (where: Where): boolean =>
		(fault.kind === "refused" || fault.kind === "lost" || fault.kind === "ended by the server") &&
		fault.where === where
	return scriptedSession(
		{
			...answeringScript,
			statement: (query): StatementAnswer => {
				const where = whereOf(sentSql(query))
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

export type EndingFeature =
	| "refreshed"
	| "refreshed CONCURRENTLY"
	| `refused at ${Where}`
	| `lost at ${Where}`
	| "ended by the server"
	| "acquisition refused"
	| Told["kind"]
