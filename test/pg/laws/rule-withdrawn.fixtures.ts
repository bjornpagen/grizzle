/** What the property of rule-withdrawn.test.ts reads: the schema and its template, the space, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { baselineRuleChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { countColumn } from "#compiler/physical/ddl/deltas.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { capturedDeltasOf, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * A learner's sittings in the unit of the sitting, every relation mutable: Assignment, keyed by (child, number); Event,
 * a sitting's one event, keyed the same way, of a kind, 1 a start; and Log, a sitting's notes at instants, keyed by
 * (child, number, at), which no write here fills, read so that every definition over it reads a holder at fields its
 * unit binds no key of, and is read live, never stored (analysis/derived/storage.ts unboundedUpkeep), as metis's
 * AssignmentStatus is. Over them, as AssignmentStatus reads its sittings:
 *
 * - Status, each sitting's status: 0 where the assignment has no event, which reads Assignment at its key, its event's
 *   kind, and 2 for a note;
 * - Started, each sitting whose event is a start, or that holds a note.
 *
 * Two rules the judge holds whole, each a containment of the assignments: Assignment ⊆ Status, whose target reads its
 * source at the containment's fields, which hold Assignment's key, so a row Assignment loses opens no fact through the
 * target (analysis/theory/unit.ts withdrawnAlone); and Assignment ⊆ Started, which a start's removal or its kind's
 * change breaks, its target reading Event at the containment's fields, Event's key, with no row of Event the root
 * requires.
 */
const Assignment = relation("Assignment", { child: int4, number: int4 }, ["child", "number"])
const Event = relation("Event", { child: int4, number: int4, kind: int4 }, ["child", "number"])
const Log = relation("Log", { child: int4, number: int4, at: int4 }, ["child", "number", "at"])

const Base = schema(
	"Withdrawn",
	[Assignment, Event, Log],
	[
		mutable(Assignment),
		mutable(Event),
		mutable(Log),
		unit("Sitting", { child: int4, number: int4 })
	]
)

const Status = derived(
	"Status",
	query(Base)
		.rule((r) => {
			const { child, number } = v(Assignment, "assignment")
			return r
				.match(Assignment, { child, number })
				.where(r.not(Event, { child, number }))
				.find({ child, number, kind: 0 })
		})
		.rule((r) => {
			const { child, number, kind } = v(Event, "event")
			return r.match(Event, { child, number, kind }).find({ child, number, kind })
		})
		.rule((r) => {
			const { child, number, at } = v(Log, "log")
			return r.match(Log, { child, number, at }).find({ child, number, kind: 2 })
		})
)

const Started = derived(
	"Started",
	query(Base)
		.rule((r) => {
			const { child, number } = v(Event, "event")
			return r.match(Event, { child, number, kind: 1 }).find({ child, number })
		})
		.rule((r) => {
			const { child, number, at } = v(Log, "log")
			return r.match(Log, { child, number, at }).find({ child, number })
		})
)

const Withdrawn = schema.extend(
	[Base],
	"Withdrawn_top",
	[Status, Started],
	[
		contained(on(Assignment, "child", "number"), on(Status, "child", "number")),
		contained(on(Assignment, "child", "number"), on(Started, "child", "number"))
	]
)

/** Withdrawn installed through its first migration, with no login: the template every case clones. */
export const withdrawnTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "withdrawn",
	content: { schema: "Withdrawn", logins: [] },
	versions: [{ schema: Withdrawn, declarations: noDeclarations }],
	options: {
		label: "withdrawn",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

const children = [1, 2] as const
const numbers = [1, 2] as const
const kinds = [0, 1] as const

/** One write of a transaction: an assignment or a sitting's event put or deleted, an event put over one that stands. */
export type Op =
	| {
			readonly kind: "put" | "remove"
			readonly relation: "Assignment"
			readonly child: number
			readonly number: number
	  }
	| {
			readonly kind: "put"
			readonly relation: "Event"
			readonly child: number
			readonly number: number
			readonly event: number
	  }
	| {
			readonly kind: "remove"
			readonly relation: "Event"
			readonly child: number
			readonly number: number
	  }

/** A case: its transactions, each its writes in order, each judged against every law's whole check. */
export interface Schedule {
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const at = (s: Parameters<Gen<Op>>[0]) => ({
	child: s.draw(element(children)),
	number: s.draw(element(numbers))
})

const opGen: Gen<Op> = weighted<Op>([
	[3, (s) => ({ kind: "put", relation: "Assignment", ...at(s) })],
	[2, (s) => ({ kind: "remove", relation: "Assignment", ...at(s) })],
	[3, (s) => ({ kind: "put", relation: "Event", ...at(s), event: s.draw(element(kinds)) })],
	[2, (s) => ({ kind: "remove", relation: "Event", ...at(s) })]
])

const scheduleGen: Gen<Schedule> = (s) => ({
	transactions: s.draw(array(array(opGen, { min: 1, max: 4 }), { min: 1, max: 4 }))
})

/** The situations a search must reach. */
export type WithdrawnFeature =
	| "committed"
	| "refused by a rule"
	| "an assignment and its start added in one transaction"
	| "an assignment deleted"
	| "a start deleted under its assignment"
	| "a start's kind changed under its assignment"

export const withdrawnFeatures: Arr.NonEmptyReadonlyArray<WithdrawnFeature> = [
	"committed",
	"refused by a rule",
	"an assignment and its start added in one transaction",
	"an assignment deleted",
	"a start deleted under its assignment",
	"a start's kind changed under its assignment"
]

/** An assignment and its start, committed: what each aim writes first. */
const started = (child: number, number: number): ReadonlyArray<Op> => [
	{ kind: "put", relation: "Assignment", child, number },
	{ kind: "put", relation: "Event", child, number, event: 1 }
]

/** For each situation, a case constructed to reach it. */
const withdrawnAims: ReadonlyArray<readonly [WithdrawnFeature, Gen<Schedule>]> = [
	[
		"an assignment deleted",
		(s) => {
			const { child, number } = at(s)
			return {
				transactions: [
					started(child, number),
					[{ kind: "remove", relation: "Assignment", child, number }]
				]
			}
		}
	],
	[
		"a start deleted under its assignment",
		(s) => {
			const { child, number } = at(s)
			return {
				transactions: [
					started(child, number),
					[{ kind: "remove", relation: "Event", child, number }]
				]
			}
		}
	],
	[
		"a start's kind changed under its assignment",
		(s) => {
			const { child, number } = at(s)
			return {
				transactions: [
					started(child, number),
					[{ kind: "put", relation: "Event", child, number, event: 0 }]
				]
			}
		}
	]
]

export const withdrawnSpace = aimed(scheduleGen, withdrawnAims)

/** The statement of one write, on the installation's names. */
const statementOf = (installed: Installed, op: Op): string => {
	const names = namesOf(installed)
	const table = names.table(op.relation === "Assignment" ? Assignment : Event)
	const where = `child = ${op.child} AND number = ${op.number}`
	if (op.kind === "remove") {
		return `DELETE FROM ${table} WHERE ${where}`
	}
	return op.relation === "Assignment"
		? `INSERT INTO ${table} (child, number) VALUES (${op.child}, ${op.number}) ON CONFLICT DO NOTHING`
		: `INSERT INTO ${table} (child, number, kind) VALUES (${op.child}, ${op.number}, ${op.event}) ON CONFLICT (child, number) DO UPDATE SET kind = EXCLUDED.kind`
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/**
 * Judges the state `session`'s transaction leaves against each rule's whole check (its violation query over every
 * fact, lowered by the oracle baseline, deploy/snapshot/violation.ts baselineRuleChecks), which reads no delta, then
 * runs the judge (SET CONSTRAINTS ALL IMMEDIATE): it must refuse exactly when a rule is broken, naming one that is.
 * Answers whether it refused.
 */
const judged = (installed: Installed, session: RawSession, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const broken = new Set<LawId>()
		for (const c of baselineRuleChecks(installation)) {
			const found = yield* session.values(`SELECT EXISTS (${printStatement(c.query)})`, [])
			if (found[0]?.[0] === true) {
				broken.add(c.law)
			}
		}
		const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (Option.isNone(refused)) {
			if (broken.size > 0) {
				return yield* new Disagreed({
					message: `the judge accepted a state that breaks ${Formatter.format([...broken])}, ${where}`
				})
			}
			return false
		}
		const { table, constraint } = refused.value
		const owner = Option.flatMap(table, (name) =>
			Arr.findFirst(
				[Assignment, Event, Log],
				(r) => installation.names.relation(r.name).name === name
			)
		)
		const laws =
			Option.isNone(owner) || constraint === undefined
				? []
				: (lawsOfConstraint(
						installation.constraintToLaw,
						{ kind: "table", name: installation.names.relation(owner.value.name).name },
						constraint
					) ?? [])
		if (!Arr.some(laws, (law) => broken.has(law))) {
			return yield* new Disagreed({
				message: `refused under ${refused.value.code} ${constraint ?? "naming no constraint"} where the laws broken are ${Formatter.format([...broken])}, ${where}`
			})
		}
		return true
	})

/**
 * Holds the judge's regions and captures to what can break each rule: Status and Started read live, so each rule reads
 * their holders itself; Assignment ⊆ Status's region reads no row Assignment loses, a row it loses opening no fact
 * through a target that reads it at its key (analysis/theory/unit.ts withdrawnAlone), so no capture writes them; and
 * Assignment ⊆ Started's reads the rows Event loses, whose removal breaks it.
 */
export const coverage = (installed: Installed) => {
	const installation: Installation = installed.installation
	for (const name of ["Status", "Started"]) {
		assert.equal(
			installation.checked.holdings.get(name)?.kind,
			"live",
			`${name} is read live: its rule reads Log at fields its unit binds no key of`
		)
	}
	const sidesOf = (target: string) => {
		const rule = defined(
			Arr.findFirst(installation.laws.rules, (r) =>
				Str.includes(`in ${target}(`)(r.law.named.display)
			).pipe(Option.getOrUndefined),
			`the rule into ${target}`
		)
		return rule.rule.kind === "whole"
			? rule.rule.sides
			: assert.fail(`the rule into ${target} is judged whole: its relations sit in one unit`)
	}
	const reads = (target: string, relation: string, side: "added" | "removed") =>
		Arr.some(sidesOf(target), (s) => s.relation === relation && s.side === side)
	assert.ok(
		!reads("Status", "Assignment", "removed"),
		"Assignment ⊆ Status reads no row Assignment loses: its target reads Assignment at its key"
	)
	assert.ok(
		reads("Started", "Event", "removed"),
		"Assignment ⊆ Started reads the rows Event loses: its root requires no row of Event"
	)
	assert.deepEqual(
		Arr.filter(
			capturedDeltasOf(installation, "Assignment"),
			(d) => !Arr.contains(d.columns, countColumn)
		),
		[],
		"no capture writes Assignment's removed rows"
	)
}

/** The situations one transaction reaches, from its writes and the rows that stood before it. */
const reachedBy = (
	ops: ReadonlyArray<Op>,
	before: ReadonlySet<string>
): ReadonlyArray<WithdrawnFeature> => {
	const reached: Array<WithdrawnFeature> = []
	const stood = (relation: string, o: Op) => before.has(`${relation} ${o.child} ${o.number}`)
	if (
		Arr.some(
			ops,
			(o) =>
				o.relation === "Assignment" &&
				o.kind === "put" &&
				Arr.some(
					ops,
					(e) =>
						e.relation === "Event" &&
						e.kind === "put" &&
						e.event === 1 &&
						e.child === o.child &&
						e.number === o.number
				)
		)
	) {
		reached.push("an assignment and its start added in one transaction")
	}
	if (
		Arr.some(
			ops,
			(o) => o.relation === "Assignment" && o.kind === "remove" && stood("Assignment", o)
		)
	) {
		reached.push("an assignment deleted")
	}
	if (
		Arr.some(
			ops,
			(o) =>
				o.relation === "Event" && o.kind === "remove" && stood("Start", o) && stood("Assignment", o)
		)
	) {
		reached.push("a start deleted under its assignment")
	}
	if (
		Arr.some(
			ops,
			(o) =>
				o.relation === "Event" &&
				o.kind === "put" &&
				o.event === 0 &&
				stood("Start", o) &&
				stood("Assignment", o)
		)
	) {
		reached.push("a start's kind changed under its assignment")
	}
	return reached
}

/** The rows that stand, as `Assignment child number` and, for each event that is a start, `Start child number`. */
const standingOf = (installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const rows: Array<string> = []
		for (const row of yield* session.values(
			`SELECT child, number FROM ${names.table(Assignment)}`,
			[]
		)) {
			rows.push(`Assignment ${String(row[0])} ${String(row[1])}`)
		}
		for (const row of yield* session.values(
			`SELECT child, number FROM ${names.table(Event)} WHERE kind = 1`,
			[]
		)) {
			rows.push(`Start ${String(row[0])} ${String(row[1])}`)
		}
		return new Set(rows)
	})

/**
 * One case on its own clone: each transaction's writes in order on an owner session at SERIALIZABLE, its end judged as
 * `judged` judges it: refused, the transaction rolls back; accepted, it commits.
 */
export const runSchedule = (
	installed: Installed,
	admin: PgConnection,
	session: RawSession,
	schedule: Schedule,
	c: Case<WithdrawnFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(admin, installed.installation)
		yield* standUpJudge(session, installed.installation)
		for (const [place, ops] of schedule.transactions.entries()) {
			const where = `transaction ${place} of ${Formatter.format(schedule)}`
			yield* session.begin
			const before = yield* standingOf(installed, session)
			for (const op of ops) {
				yield* session.query(statementOf(installed, op), [])
			}
			c.noteAll(reachedBy(ops, before))
			if (yield* judged(installed, session, where)) {
				c.note("refused by a rule")
				yield* session.rollback
			} else {
				yield* session.commit
				c.note("committed")
			}
		}
	})
