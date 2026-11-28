/** What the property of rule-regained.test.ts reads: the schema and its template, the space, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { baselineRuleChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { countColumn } from "#compiler/physical/ddl/deltas.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { instant, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { capturedDeltasOf, judgedDeltaReadsOf, raisedRule } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * A sitting's rows, every relation closed, each sitting's in the unit of the sitting s, whose one clock orders every
 * instant of its relations (ir/instant.ts scopeOrder): a test's deadline (Test), keyed by the test apart from every
 * sitting's rows, so each rule over them reads two units' rows and is probed; a sitting of a test (Session); a candidate
 * session of it (Visit); the session's end, of a kind, at the sitting's instant (End); and a response in a session at
 * the sitting's instant (Snap). Each child is contained in its parent.
 *
 * - Inside, each response inside its candidate session: one the session has no end of, or one stated no later than an
 *   end of it, qti-pie's "Inside a candidate session". Its ended arm reads the end at exactly the fields the open
 *   arm's negation reads it at and its instant, no earlier than the response's by the clock, so a row End gains
 *   withdraws no response from Inside (analysis/theory/query.ts regainedBy): Snap ⊆ Inside reads no row End gains.
 * - Within, the same but for an end of kind 1 alone, its ended arm reading End at its kind beside the negation's
 *   fields, as qti-pie's reads the end's own kind: an end of kind 0 under a response withdraws it, and Snap ⊆ Within reads
 *   the rows End gains.
 */
const Test = relation("Test", { test: int4, cap: int4 }, ["test"])
const Session = relation("Session", { s: int4, test: int4 }, ["s"])
const Visit = relation("Visit", { s: int4, k: int4 }, ["s", "k"])
const End = relation("End", { s: int4, k: int4, why: int4, at: instant }, ["s", "k", "at"])
const Snap = relation("Snap", { s: int4, k: int4, n: int4, at: instant }, ["s", "k", "n", "at"])

const Base = schema(
	"Regained",
	[Test, Session, Visit, End, Snap],
	[
		contained(on(Session, "test"), on(Test, "test")),
		contained(on(Visit, "s"), on(Session, "s")),
		contained(on(End, "s", "k"), on(Visit, "s", "k")),
		contained(on(Snap, "s", "k"), on(Visit, "s", "k")),
		unit("Sitting", { s: int4 })
	]
)

const Inside = derived(
	"Inside",
	query(Base)
		.rule((r) => {
			const { s, k, n, at } = v(Snap, "snap")
			const { test } = v(Session, "session")
			return r
				.match(Snap, { s, k, n, at })
				.match(Visit, { s, k })
				.match(Session, { s, test })
				.match(Test, { test })
				.where(r.not(End, { s, k }))
				.find({ s, k, n, at })
		})
		.rule((r) => {
			const { s, k, n, at } = v(Snap, "snap")
			const { test } = v(Session, "session")
			const { at: ended } = v(End, "end")
			return r
				.match(Snap, { s, k, n, at })
				.match(Visit, { s, k })
				.match(Session, { s, test })
				.match(Test, { test })
				.match(End, { s, k, at: ended })
				.where(r.le(at, ended))
				.find({ s, k, n, at })
		})
)

const Within = derived(
	"Within",
	query(Base)
		.rule((r) => {
			const { s, k, n, at } = v(Snap, "snap")
			const { test } = v(Session, "session")
			return r
				.match(Snap, { s, k, n, at })
				.match(Visit, { s, k })
				.match(Session, { s, test })
				.match(Test, { test })
				.where(r.not(End, { s, k }))
				.find({ s, k, n, at })
		})
		.rule((r) => {
			const { s, k, n, at } = v(Snap, "snap")
			const { test } = v(Session, "session")
			const { at: ended } = v(End, "end")
			return r
				.match(Snap, { s, k, n, at })
				.match(Visit, { s, k })
				.match(Session, { s, test })
				.match(Test, { test })
				.match(End, { s, k, why: 1, at: ended })
				.where(r.le(at, ended))
				.find({ s, k, n, at })
		})
)

const Regained = schema.extend(
	[Base],
	"Regained_top",
	[Inside, Within],
	[
		contained(on(Snap, "s", "k", "n", "at"), on(Inside, "s", "k", "n", "at")),
		contained(on(Snap, "s", "k", "n", "at"), on(Within, "s", "k", "n", "at"))
	]
)

/** Regained installed through its first migration, with no login: the template every case clones. */
export const regainedTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "regained",
	content: { schema: "Regained", logins: [] },
	versions: [{ schema: Regained, declarations: noDeclarations }],
	options: {
		label: "regained",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** One write of a transaction, every one an insert: a sitting with its candidate session, a response, or an end. */
export type Op =
	| { readonly kind: "sitting"; readonly k: number }
	| { readonly kind: "snap"; readonly k: number; readonly n: number }
	| { readonly kind: "end"; readonly k: number; readonly why: number }

/** A case: its transactions, each its writes in order, each judged against every law's whole check. */
export interface Schedule {
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const sessions = [1, 2] as const
const responses = [1, 2] as const
const whys = [0, 1] as const

const opGen: Gen<Op> = weighted<Op>([
	[2, (s) => ({ kind: "sitting", k: s.draw(element(sessions)) })],
	[3, (s) => ({ kind: "snap", k: s.draw(element(sessions)), n: s.draw(element(responses)) })],
	[2, (s) => ({ kind: "end", k: s.draw(element(sessions)), why: s.draw(element(whys)) })]
])

const scheduleGen: Gen<Schedule> = (s) => ({
	transactions: s.draw(array(array(opGen, { min: 1, max: 3 }), { min: 1, max: 4 }))
})

/** The situations a search must reach. */
export type RegainedFeature =
	| "committed"
	| "refused by a rule"
	| "an end added under a response that stood"
	| "an end of kind 0 added under a response that stood"
	| "a response added after its session's end"

export const regainedFeatures: Arr.NonEmptyReadonlyArray<RegainedFeature> = [
	"committed",
	"refused by a rule",
	"an end added under a response that stood",
	"an end of kind 0 added under a response that stood",
	"a response added after its session's end"
]

/** A sitting with candidate session k and a response in it, then an end of kind `why`. */
const endedUnder = (why: number): Schedule => ({
	transactions: [
		[
			{ kind: "sitting", k: 1 },
			{ kind: "snap", k: 1, n: 1 }
		],
		[{ kind: "end", k: 1, why }]
	]
})

/** For each situation, a case constructed to reach it. */
const regainedAims: ReadonlyArray<readonly [RegainedFeature, Gen<Schedule>]> = [
	["an end added under a response that stood", () => endedUnder(1)],
	["an end of kind 0 added under a response that stood", () => endedUnder(0)],
	[
		"a response added after its session's end",
		(s) => ({
			transactions: [
				[
					{ kind: "sitting", k: 1 },
					{ kind: "end", k: 1, why: s.draw(element(whys)) }
				],
				[{ kind: "snap", k: 1, n: 1 }]
			]
		})
	]
]

export const regainedSpace = aimed(scheduleGen, regainedAims)

/**
 * The statements of one write, on the installation's names, each instant its transaction's stamp at the sitting's key
 * (test/support/kernel/naming.ts stampCall): each inserts test 1, its sitting and candidate session k, each where it
 * stands not, so every containment holds; a response and an end then read the stamp.
 */
const statementsOf = (installed: Installed, op: Op): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const stamped = (relation: typeof End | typeof Snap) =>
		`${names.stampCall(relation, "at", ["1"], "0")} AS st`
	const sitting = [
		`INSERT INTO ${names.table(Test)} (test, cap) VALUES (1, 5) ON CONFLICT DO NOTHING`,
		`INSERT INTO ${names.table(Session)} (s, test) VALUES (1, 1) ON CONFLICT DO NOTHING`,
		`INSERT INTO ${names.table(Visit)} (s, k) VALUES (1, ${op.k}) ON CONFLICT DO NOTHING`
	]
	switch (op.kind) {
		case "sitting":
			return sitting
		case "snap":
			return [
				...sitting,
				`INSERT INTO ${names.table(Snap)} (s, k, n, at) SELECT 1, ${op.k}, ${op.n}, st.__instant FROM ${stamped(Snap)} ON CONFLICT DO NOTHING`
			]
		case "end":
			return [
				...sitting,
				`INSERT INTO ${names.table(End)} (s, k, why, at) SELECT 1, ${op.k}, ${op.why}, st.__instant FROM ${stamped(End)} ON CONFLICT DO NOTHING`
			]
	}
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/**
 * Judges the state `session`'s transaction leaves against each rule's whole check (its violation query over every
 * fact, lowered by the oracle baseline, deploy/snapshot/violation.ts baselineRuleChecks), which reads no delta, then
 * runs the judge and the deferred foreign keys (SET CONSTRAINTS ALL IMMEDIATE): they must refuse exactly when a law is
 * broken, naming a rule that is where a rule refuses. Answers whether they refused.
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
		if (refused.value.code !== "23514") {
			return true
		}
		const { table, constraint } = refused.value
		const owner = Option.flatMap(table, (name) =>
			Arr.findFirst(
				[Test, Session, Visit, End, Snap],
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
				message: `refused under ${constraint ?? "no constraint"} where the laws broken are ${Formatter.format([...broken])}, ${where}`
			})
		}
		return true
	})

/**
 * Holds the judge's probes to the clock's class: Snap ⊆ Inside reads no row End gains and records the regain in its
 * covers (laws/model/model.ts RuleTrigger `covered`), while Snap ⊆ Within reads them; each reads the rows Snap gains.
 */
export const coverage = (installed: Installed) => {
	const installation = installed.installation
	const reads = judgedDeltaReadsOf(installation)
	const news = (relation: string) =>
		Arr.findFirst(capturedDeltasOf(installation, relation), (d) =>
			Arr.contains(d.columns, countColumn)
		).pipe(Option.map((d) => d.name))
	const ruleInto = (target: string) =>
		defined(
			Arr.findFirst(installation.laws.rules, (r) =>
				Str.includes(`in ${target}(`)(r.law.named.display)
			).pipe(Option.getOrUndefined),
			`the rule into ${target}`
		)
	const readsNews = (target: string, relation: string) => {
		const rule = ruleInto(target)
		const delta = news(relation)
		return (
			Option.isSome(delta) &&
			Arr.some(
				reads,
				(r) =>
					Option.contains(raisedRule(r.statement), identifierOf(rule.named)) &&
					r.deltas.has(delta.value)
			)
		)
	}
	assert.ok(
		!readsNews("Inside", "End"),
		"Snap ⊆ Inside reads no row End gains: its ended arm regains it"
	)
	assert.ok(
		Arr.some(
			ruleInto("Inside").covered,
			(c) => c.relation === "End" && Arr.some(c.covers, (cover) => cover.kind === "clock")
		),
		"Snap ⊆ Inside records End's regain"
	)
	assert.ok(
		readsNews("Within", "End"),
		"Snap ⊆ Within reads the rows End gains: its ended arm reads End's kind"
	)
	assert.ok(
		readsNews("Inside", "Snap") && readsNews("Within", "Snap"),
		"each reads the rows Snap gains"
	)
}

/** The situations one transaction reaches, from its writes and the rows that stood before it. */
const reachedBy = (
	ops: ReadonlyArray<Op>,
	before: ReadonlySet<string>
): ReadonlyArray<RegainedFeature> => {
	const reached: Array<RegainedFeature> = []
	for (const o of ops) {
		if (o.kind === "end" && before.has(`Snap ${o.k}`)) {
			reached.push("an end added under a response that stood")
			if (o.why === 0) {
				reached.push("an end of kind 0 added under a response that stood")
			}
		}
		if (o.kind === "snap" && before.has(`End ${o.k}`)) {
			reached.push("a response added after its session's end")
		}
	}
	return reached
}

/** The candidate sessions that stand with a response, as `Snap k`, and with an end, as `End k`. */
const standingOf = (installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const rows: Array<string> = []
		for (const relation of [Snap, End]) {
			for (const row of yield* session.values(`SELECT k FROM ${names.table(relation)}`, [])) {
				rows.push(`${relation.name} ${String(row[0])}`)
			}
		}
		return new Set(rows)
	})

/**
 * One case on its own clone: each transaction's writes in order on an owner session at SERIALIZABLE, its end judged as
 * `judged` judges it: refused, the transaction rolls back; accepted, it commits.
 */
export const runSchedule = (
	installed: Installed,
	session: RawSession,
	schedule: Schedule,
	c: Case<RegainedFeature>
) =>
	Effect.gen(function* () {
		for (const [place, ops] of schedule.transactions.entries()) {
			const where = `transaction ${place} of ${Formatter.format(schedule)}`
			yield* session.begin
			const before = yield* standingOf(installed, session)
			for (const op of ops) {
				for (const statement of statementsOf(installed, op)) {
					yield* session.query(statement, [])
				}
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
