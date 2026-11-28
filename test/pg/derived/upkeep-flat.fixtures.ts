/** What the properties of upkeep-flat.test.ts read: the shapes' schemas and templates, their box, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Num, Type } from "#compiler/public/compute.ts"
import { natural, bool, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, mutable, relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import { lawsHold, routineScopes } from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	committedJudged,
	type JudgePlan,
	type JudgeStatement,
	judgeRun,
	judgeStatementsOf,
	raisedRule,
	scannedWork,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** A sitting's fields, a learner's stage, which leads every key of a sitting's facts. */
const sitting = { child: int4, stage: int4 } as const

/** A sitting's candidate sessions, each begun at its instant, numbered from 0. */
const Visit = relation("Visit", { ...sitting, k: natural, at: int8 }, ["child", "stage", "k"])
/** The candidate session a suspension ended, at its instant. */
const Suspension = relation("Suspension", { ...sitting, k: natural, at: int8 }, [
	"child",
	"stage",
	"k"
])
/** Each presentation of a member in a candidate session, by its instant. */
const Presented = relation("Presented", { ...sitting, at: int8, k: natural }, [
	"child",
	"stage",
	"at"
])
/** A sitting's end, in the candidate session it ended. */
const End = relation("End", { ...sitting, k: natural, at: int8 }, ["child", "stage"])

/** The four relations, closed, in the learner's unit: a write inserts, never updates or deletes. */
const Sittings = schema(
	"UpkeepFlat",
	[Visit, Suspension, Presented, End],
	[unit("Learner", { child: int4 })]
)

/**
 * The ledger's SittingOrder in the box's terms: two instants of a sitting, by what they are, each pair of one sitting's
 * clock. Its unit, the sitting (child, stage), is wider than the learner's, and every holder is closed, so a write only
 * inserts its facts: a visit and the suspension that ended it, a suspension and the next visit (k + 1, a computed key),
 * a visit and each presentation in it, each presentation and the suspension of its visit, and each of them and the
 * sitting's end.
 */
const Order = derived(
	"Order",
	query(Sittings)
		.rule((r) => {
			const { child, stage, k, at: earlier } = v(Visit, "visit")
			const { at: later } = v(Suspension, "suspension")
			return r
				.match(Visit, { at: earlier, child, k, stage })
				.match(Suspension, { at: later, child, k, stage })
				.find({ child, earlier, later, stage, strict: Type.literal(bool, true) })
		})
		.rule((r) => {
			const next = v(Visit, "next")
			const { k, at: earlier } = v(Suspension, "suspension")
			return r
				.match(Suspension, { at: earlier, child: next.child, k, stage: next.stage })
				.match(Visit, { at: next.at, child: next.child, k: next.k, stage: next.stage })
				.where(r.eq(Type.base(next.k), Num.add(Type.base(k), 1n)))
				.find({
					child: next.child,
					earlier,
					later: next.at,
					stage: next.stage,
					strict: Type.literal(bool, true)
				})
		})
		.rule((r) => {
			const { child, stage, k, at: earlier } = v(Visit, "visit")
			const { at: later } = v(Presented, "presented")
			return r
				.match(Visit, { at: earlier, child, k, stage })
				.match(Presented, { at: later, child, k, stage })
				.find({ child, earlier, later, stage, strict: Type.literal(bool, false) })
		})
		.rule((r) => {
			const { child, stage, k, at: later } = v(Suspension, "suspension")
			const { at: earlier } = v(Presented, "presented")
			return r
				.match(Suspension, { at: later, child, k, stage })
				.match(Presented, { at: earlier, child, k, stage })
				.find({ child, earlier, later, stage, strict: Type.literal(bool, true) })
		})
		.rule((r) => {
			const { child, stage, at: earlier } = v(Visit, "visit")
			const { at: later } = v(End, "end")
			return r
				.match(Visit, { at: earlier, child, stage })
				.match(End, { at: later, child, stage })
				.find({ child, earlier, later, stage, strict: Type.literal(bool, true) })
		})
		.rule((r) => {
			const { child, stage, at: earlier } = v(Suspension, "suspension")
			const { at: later } = v(End, "end")
			return r
				.match(Suspension, { at: earlier, child, stage })
				.match(End, { at: later, child, stage })
				.find({ child, earlier, later, stage, strict: Type.literal(bool, true) })
		})
		.rule((r) => {
			const { child, stage, at: earlier } = v(Presented, "presented")
			const { at: later } = v(End, "end")
			return r
				.match(Presented, { at: earlier, child, stage })
				.match(End, { at: later, child, stage })
				.find({ child, earlier, later, stage, strict: Type.literal(bool, true) })
		})
)

/** The sittings and Order, stored at the sitting. */
const UpkeepFlat = schema.extend([Sittings], "UpkeepFlat_1", [Order], [])

/** UpkeepFlat installed through its first migration, with no login. */
export const upkeepFlatTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "upkeep flat",
	content: { schema: "UpkeepFlat", logins: [] },
	versions: [{ schema: UpkeepFlat, declarations: noDeclarations }],
	options: {
		label: "upkeep_flat",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The one-row writes a sitting's calls make, each measured at its COMMIT: a resumption, a suspension, a move. */
const writes = ["visit", "suspension", "presentation"] as const
export type SittingWrite = (typeof writes)[number]

/**
 * A case: the write measured, `write`; the candidate sessions the sitting holds at the first measure, `few`, and at the
 * second, ten times as many; and the presentations of each, `per`.
 */
export interface FlatCase {
	readonly write: SittingWrite
	readonly few: 1 | 4
	readonly per: 1 | 3
}

export const flatGen: Gen<FlatCase> = (s) => ({
	write: s.draw(element(writes)),
	few: s.draw(element([1, 4] as const)),
	per: s.draw(element([1, 3] as const))
})

export type FlatFeature = `the upkeep of Order ran at a ${SittingWrite}`

/** The child and stage every case's sitting is at. */
const child = 1
const stage = 1

/** The instant of candidate session `k`'s beginning: each session's instants lie in [1000 k, 1000 k + 1000). */
const visitAt = (k: number): number => 1000 * k

/**
 * The statements that store candidate sessions `from` to `to` of the case's sitting, each with `per` presentations, and
 * a suspension of each but the last, `to`, which stays open, as the sitting's current session is: so a sitting of any
 * length has one open session, `to`, holding `per` presentations, which each measured write extends.
 */
const sessionsSql = (installed: Installed, from: number, to: number, per: number) => {
	const names = namesOf(installed)
	const series = (last: number) => `FROM generate_series(${from}, ${last}) AS g(k)`
	return [
		`INSERT INTO ${names.table(Visit)} (child, stage, k, at) SELECT ${child}, ${stage}, k, 1000 * k ${series(to)}`,
		`INSERT INTO ${names.table(Presented)} (child, stage, at, k) SELECT ${child}, ${stage}, 1000 * k + 100 * j, k ${series(to)}, generate_series(1, ${per}) AS h(j)`,
		...(to > from
			? [
					`INSERT INTO ${names.table(Suspension)} (child, stage, k, at) SELECT ${child}, ${stage}, k, 1000 * k + 900 ${series(to - 1)}`
				]
			: [])
	]
}

/** The suspension of the open session `k`, which a sitting's growth past it writes first. */
const suspendSql = (installed: Installed, k: number) =>
	`INSERT INTO ${namesOf(installed).table(Suspension)} (child, stage, k, at) VALUES (${child}, ${stage}, ${k}, ${visitAt(k) + 900})`

/**
 * The measured write over a sitting whose open session is `open`, with `per` presentations: a resumption, the next
 * session begun (its earlier suspension the computed key k + 1 reaches, none here, the open one never suspended); the
 * open session suspended; or a further presentation in it.
 */
const writeSql = (installed: Installed, w: SittingWrite, open: number, per: number): string => {
	const names = namesOf(installed)
	switch (w) {
		case "visit":
			return `INSERT INTO ${names.table(Visit)} (child, stage, k, at) VALUES (${child}, ${stage}, ${open + 1}, ${visitAt(open + 1)})`
		case "suspension":
			return suspendSql(installed, open)
		case "presentation":
			return `INSERT INTO ${names.table(Presented)} (child, stage, at, k) VALUES (${child}, ${stage}, ${visitAt(open) + 100 * (per + 1)}, ${open})`
	}
}

/**
 * The judge's work at COMMIT of the write `w` over a sitting whose open session is `open`, measured on `session` in a
 * transaction rolled back, before the judge reads its deltas (test/support/judge.ts judgeRun): each statement Order's
 * upkeep runs over them under its routine's advice, with its work (`scannedWork`).
 */
const writeWork = (
	installed: Installed,
	session: RawSession,
	w: SittingWrite,
	open: number,
	per: number
) =>
	Effect.gen(function* () {
		yield* session.begin
		const work = yield* Effect.onError(
			Effect.gen(function* () {
				yield* session.query(writeSql(installed, w, open, per), [])
				return yield* judgeRun(
					(sql) => session.values(sql, []),
					installed.installation,
					judgeStatementsOf(installed.installation)
				)
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		return work
	})

/** A statement of the judge, named for a report: an upkeep's write by its relation, a rule's test by its rule. */
const named = (statement: JudgeStatement): string => {
	switch (statement.kind) {
		case "upkeep":
			return `the ${statement.statement.kind} of ${statement.relation}'s upkeep`
		case "rule":
			return `a test of rule ${Formatter.format(raisedRule(statement.statement))}`
	}
}

/** Each statement measured, named (`named`), with its work (`scannedWork`). */
const measured = (plans: ReadonlyArray<JudgePlan<JudgeStatement>>) =>
	Arr.map(plans, (p) => ({ statement: named(p.statement), rows: scannedWork(p.plan) }))

/**
 * One case on a fresh clone, in one session: the sitting of `few` candidate sessions, each with `per` presentations, the
 * last open, committed, and the judge's work at the write's COMMIT measured (`writeWork`); then the open session
 * suspended and `9 few` sessions more added after it, the last again open, committed, and the work measured again over
 * the same write at the new open session. Each statement reads the same rows both times: Order's upkeep reads the rows
 * the written row reaches along each rule, by its keys and the computed key k + 1, and the presentations of the one
 * session a suspension ends, never the sitting's other sessions, which the second measure's ten times as many add to.
 */
export const runFlat = (
	installed: Installed,
	session: RawSession,
	d: FlatCase,
	c: Case<FlatFeature>
) =>
	Effect.gen(function* () {
		assert.ok(
			Arr.some(installed.installation.laws.theory.upkeeps, (u) => u.relation === "Order"),
			"Order stored at the sitting, an upkeep of the installation's"
		)
		yield* standUpJudge(session, installed.installation)
		yield* committedJudged(session, sessionsSql(installed, 0, d.few - 1, d.per))
		const few = yield* writeWork(installed, session, d.write, d.few - 1, d.per)
		const many = 10 * d.few
		yield* committedJudged(session, [
			suspendSql(installed, d.few - 1),
			...sessionsSql(installed, d.few, many - 1, d.per)
		])
		const more = yield* writeWork(installed, session, d.write, many - 1, d.per)
		assert.deepEqual(
			measured(more),
			measured(few),
			`${Formatter.format(d)}: each statement the judge runs at the write's COMMIT reads the same rows beside ${d.few} candidate sessions of the sitting and beside ${many}`
		)
		const order = installed.names.relation("Order").name
		for (const p of [...few, ...more]) {
			assert.ok(
				p.statement.kind !== "upkeep" || !antiJoinsOver(p.plan, order),
				`${Formatter.format(d)}: ${named(p.statement)} anti-joins its stored table, where an insert's conflict on its primary key is one probe of its index`
			)
		}
		assert.ok(
			Arr.some(few, (p) => p.statement.kind === "upkeep" && p.statement.relation === "Order"),
			"Order's upkeep among the statements the write's COMMIT runs"
		)
		c.note(`the upkeep of Order ran at a ${d.write}`)
	})

/**
 * Whether `plan` holds an anti join whose inner side reads the table `table`: a NOT EXISTS over the stored table, which
 * PostgreSQL may hash whole (JUDGEDELTA2's item_session_variable, 30,523 rows hashed in each statement).
 */
const antiJoinsOver = (plan: PlanNode, table: string): boolean =>
	Iterator.from(planNodes(plan)).some(
		(n) =>
			Option.contains(n.joinType, "Anti") &&
			Arr.some(
				n.children,
				(inner) =>
					Option.contains(inner.parentRelationship, "Inner") &&
					Iterator.from(planNodes(inner)).some((x) => Option.contains(x.relation, table))
			)
	)

/** A package's nodes, closed, in the package's unit, sealed: the one write that founds a package, its publish, writes
 * every node and every attribute of it, and no other write changes them. */
const Node = relation("Node", { package: int4, node: int4, kind: int4 }, ["package", "node"])
/** Each attribute of a node, by its name. */
const Attribute = relation("Attribute", { package: int4, node: int4, name: int4, value: int4 }, [
	"package",
	"node",
	"name"
])

/** The two relations in the sealed unit of their package. */
const Packages = schema(
	"FoundFlat",
	[Node, Attribute],
	[sealed(unit("Package", { package: int4 }))]
)

/**
 * Each attribute of a node beside the node's kind, a join of two occurrences at the node, stored at the package's
 * nodes, over a founded unit: its upkeep is the unit form's, run at the publish alone, whose delta is the whole package
 * (analysis/theory/upkeep.ts `founded`).
 */
const Named = derived(
	"Named",
	query(Packages).rule((r) => {
		const { package: p, node, kind } = v(Node, "node")
		const { name, value } = v(Attribute, "attribute")
		return r
			.match(Node, { kind, node, package: p })
			.match(Attribute, { name, node, package: p, value })
			.find({ kind, name, node, package: p, value })
	})
)

/** The packages and Named. */
const FoundFlat = schema.extend([Packages], "FoundFlat_1", [Named], [])

/** FoundFlat installed through its first migration, with no login. */
export const foundFlatTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "found flat",
	content: { schema: "FoundFlat", logins: [] },
	versions: [{ schema: FoundFlat, declarations: noDeclarations }],
	options: {
		label: "found_flat",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** A publish: the nodes of the one package it founds, and the attributes of each. */
export interface FoundCase {
	readonly nodes: 1 | 8
	readonly per: 1 | 3
}

export const foundGen: Gen<FoundCase> = (s) => ({
	nodes: s.draw(element([1, 8] as const)),
	per: s.draw(element([1, 3] as const))
})

export type FoundFeature =
	`the upkeep of Named ran at a publish of ${FoundCase["per"]} attributes a node`

/**
 * The rows `plan`, an INSERT's, inserts or meets a conflict on: the rows its source produced, the ModifyTable's input,
 * every loop's.
 */
const insertedRows = (plan: PlanNode): number =>
	Arr.reduce(
		Arr.filter(
			plan.children,
			(c) =>
				!Option.contains(c.parentRelationship, "InitPlan") &&
				!Option.contains(c.parentRelationship, "SubPlan")
		),
		0,
		(sum, c) => sum + c.actualRows * c.actualLoops
	)

/**
 * One case on a fresh clone: the package's publish, every node and attribute of it in one transaction, and the judge's
 * work at its COMMIT measured in that transaction, rolled back (test/support/judge.ts judgeRun). Named's upkeep is the
 * unit form's, the DELETE of its removal and an INSERT of its definition at the package's nodes, and the INSERT's source derives each of
 * Named's facts once, `nodes × per` rows: no gained rule of each occurrence reads the publish's rows again, which would
 * derive every fact once from the nodes' delta and once more from the attributes'.
 */
export const runFound = (
	installed: Installed,
	session: RawSession,
	d: FoundCase,
	c: Case<FoundFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		yield* standUpJudge(session, installed.installation)
		yield* session.begin
		const plans = yield* Effect.onError(
			Effect.gen(function* () {
				yield* session.query(
					`INSERT INTO ${names.table(Node)} (package, node, kind) SELECT 1, n, n % 2 FROM generate_series(1, ${d.nodes}) AS g(n)`,
					[]
				)
				yield* session.query(
					`INSERT INTO ${names.table(Attribute)} (package, node, name, value) SELECT 1, n, a, n * a FROM generate_series(1, ${d.nodes}) AS g(n), generate_series(1, ${d.per}) AS h(a)`,
					[]
				)
				return yield* judgeRun(
					(sql) => session.values(sql, []),
					installed.installation,
					judgeStatementsOf(installed.installation)
				)
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		const upkept = Arr.filter(
			plans,
			(p) => p.statement.kind === "upkeep" && p.statement.relation === "Named"
		)
		assert.deepEqual(
			Arr.dedupeAdjacent(
				Arr.map(upkept, (p) => (p.statement.kind === "upkeep" ? p.statement.statement.kind : ""))
			),
			["delete", "insert"],
			`${Formatter.format(d)}: Named's upkeep at a publish is the unit form's removal DELETE and INSERT`
		)
		const inserted = Arr.reduce(
			Arr.filter(
				upkept,
				(p) => p.statement.kind === "upkeep" && p.statement.statement.kind === "insert"
			),
			0,
			(sum, p) => sum + insertedRows(p.plan)
		)
		assert.equal(
			inserted,
			d.nodes * d.per,
			`${Formatter.format(d)}: Named's upkeep at a publish derives each of its ${d.nodes * d.per} facts once`
		)
		c.note(`the upkeep of Named ran at a publish of ${d.per} attributes a node`)
	})

/** A sitting's candidate sessions, open: a writer updates and deletes them, in the learner's unit. */
const OpenVisit = relation("Visit", { ...sitting, k: natural, at: int8 }, ["child", "stage", "k"])
/** The candidate session a suspension ended, open. */
const OpenSuspension = relation("Suspension", { ...sitting, k: natural, at: int8 }, [
	"child",
	"stage",
	"k"
])
/** A sitting's end, open. */
const OpenEnd = relation("End", { ...sitting, k: natural, at: int8 }, ["child", "stage"])
/** Each presentation of a member in a candidate session, by its instant, open. */
const OpenPresented = relation("Presented", { ...sitting, at: int8, k: natural }, [
	"child",
	"stage",
	"at"
])

/** A learner's cohort, closed, one row a learner. */
const Cohort = relation("Cohort", { child: int4, cohort: int4 }, ["child"])

/** The four relations, open, in the learner's unit, beside the learner's cohort. */
const OpenSittings = schema(
	"LostFlat",
	[OpenVisit, OpenSuspension, OpenEnd, OpenPresented, Cohort],
	[
		unit("Learner", { child: int4 }),
		mutable(OpenVisit),
		mutable(OpenSuspension),
		mutable(OpenEnd),
		mutable(OpenPresented)
	]
)

/**
 * The sessions a sitting has open: each visit no suspension ended, of a sitting not ended, AssignmentStatus's shape:
 * one holder's row read at its key from the fact, beside negations at its session and at its sitting. Its head reaches
 * every match by its key, so it is kept by its checked form (analysis/theory/upkeep.ts).
 */
const Open = derived(
	"Open",
	query(OpenSittings).rule((r) => {
		const { child, stage, k, at } = v(OpenVisit, "visit")
		return r
			.match(OpenVisit, { at, child, k, stage })
			.where(r.not(OpenSuspension, { child, k, stage }), r.not(OpenEnd, { child, stage }))
			.find({ at, child, k, stage })
	})
)

/**
 * The sittings with a session open, AssignmentStatus's rule of a latest event: a visit no suspension ended, its session
 * read at no key from the fact, the sitting, and its negation reading the session: no form but the unit form keeps it,
 * since a check of a sitting would read its every visit for one no suspension ended.
 */
const Waiting = derived(
	"Waiting",
	query(OpenSittings).rule((r) => {
		const { child, stage, k } = v(OpenVisit, "visit")
		return r
			.match(OpenVisit, { child, k, stage })
			.where(r.not(OpenSuspension, { child, k, stage }))
			.find({ child, stage })
	})
)

/**
 * The sessions a suspension ended, each visit beside its suspension's instant and its learner's cohort: unit-local at
 * the learner alone, whose cohort it reads at the learner's key, so a removed visit's lost candidate, which leaves the
 * instant and the cohort free, reads the facts at the visit from Suspended's own table at the learner and the visit's
 * fields past it (query.ts lostFacts, readAtStored): a visit's delete reads its one session's fact, never the learner's
 * every suspended session.
 */
const Suspended = derived(
	"Suspended",
	query(OpenSittings).rule((r) => {
		const { child, stage, k, at } = v(OpenVisit, "visit")
		const { at: ended } = v(OpenSuspension, "suspension")
		const { cohort } = v(Cohort, "cohort")
		return r
			.match(OpenVisit, { at, child, k, stage })
			.match(OpenSuspension, { at: ended, child, k, stage })
			.match(Cohort, { child, cohort })
			.find({ at, child, cohort, ended, k, stage })
	})
)

/** The open sittings and Open, Waiting and Suspended, stored at the sitting. */
const LostFlat = schema.extend([OpenSittings], "LostFlat_1", [Open, Waiting, Suspended], [])

/** LostFlat installed through its first migration, with no login. */
export const lostFlatTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "lost flat",
	content: { schema: "LostFlat", logins: [] },
	versions: [{ schema: LostFlat, declarations: noDeclarations }],
	options: {
		label: "lost_flat",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * The one-row writes of an open sitting measured at their COMMIT, each moving Open's facts: the open session suspended
 * (a negation's insert withdraws its fact), the next session visited (a fact gained), the open visit deleted (a fact's
 * row removed), the last suspension deleted (a negation's removal gives a fact back), and the open visit's instant
 * moved (a fact lost and another gained). The sitting's end, a negation at the sitting, is no row of the box: its lost
 * rule's candidates are the visits of the sitting, each read and checked, the arm's rows at the negated row's key
 * (query.ts lostFacts), where the stored table's facts there are the open visits alone.
 */
const lostWrites = ["suspension", "visit", "unvisit", "unsuspend", "move"] as const
export type LostWrite = (typeof lostWrites)[number]

/** A case: the write, the sessions at the first measure (`few`, ten times as many at the second), and presentations
 * each (`per`). */
export interface LostCase {
	readonly write: LostWrite
	readonly few: 2 | 4
	readonly per: 1 | 3
}

export const lostGen: Gen<LostCase> = (s) => ({
	write: s.draw(element(lostWrites)),
	few: s.draw(element([2, 4] as const)),
	per: s.draw(element([1, 3] as const))
})

export type LostFeature =
	`the checked upkeep of Open ran at ${"a suspension" | "a visit" | "a visit's delete" | "a suspension's delete" | "a visit's move"}`

/** The feature a write reaches. */
const lostFeatureOf = {
	suspension: "the checked upkeep of Open ran at a suspension",
	visit: "the checked upkeep of Open ran at a visit",
	unvisit: "the checked upkeep of Open ran at a visit's delete",
	unsuspend: "the checked upkeep of Open ran at a suspension's delete",
	move: "the checked upkeep of Open ran at a visit's move"
} as const satisfies { readonly [W in LostWrite]: LostFeature }

/** The statements that store sessions `from` to `to` of the sitting, `per` presentations each, a suspension of each
 * but the last, `to`, which stays open. */
const openSessionsSql = (installed: Installed, from: number, to: number, per: number) => {
	const names = namesOf(installed)
	const series = (last: number) => `FROM generate_series(${from}, ${last}) AS g(k)`
	return [
		`INSERT INTO ${names.table(OpenVisit)} (child, stage, k, at) SELECT ${child}, ${stage}, k, 1000 * k ${series(to)}`,
		`INSERT INTO ${names.table(OpenPresented)} (child, stage, at, k) SELECT ${child}, ${stage}, 1000 * k + 100 * j, k ${series(to)}, generate_series(1, ${per}) AS h(j)`,
		...(to > from
			? [
					`INSERT INTO ${names.table(OpenSuspension)} (child, stage, k, at) SELECT ${child}, ${stage}, k, 1000 * k + 900 ${series(to - 1)}`
				]
			: [])
	]
}

/** The measured write over a sitting whose open session is `open`. */
const lostSql = (installed: Installed, w: LostWrite, open: number): string => {
	const names = namesOf(installed)
	const at = `child = ${child} AND stage = ${stage}`
	switch (w) {
		case "suspension":
			return `INSERT INTO ${names.table(OpenSuspension)} (child, stage, k, at) VALUES (${child}, ${stage}, ${open}, ${visitAt(open) + 900})`
		case "visit":
			return `INSERT INTO ${names.table(OpenVisit)} (child, stage, k, at) VALUES (${child}, ${stage}, ${open + 1}, ${visitAt(open + 1)})`
		case "unvisit":
			return `DELETE FROM ${names.table(OpenVisit)} WHERE ${at} AND k = ${open}`
		case "unsuspend":
			return `DELETE FROM ${names.table(OpenSuspension)} WHERE ${at} AND k = ${open - 1}`
		case "move":
			return `UPDATE ${names.table(OpenVisit)} SET at = ${visitAt(open) + 50} WHERE ${at} AND k = ${open}`
	}
}

/**
 * Each read of a table in `plan` that reads more than one row a loop, kept or filtered (PostgreSQL reports both per
 * loop), named: a checked form's DELETE holds none. It reads the candidate facts, each at the keys its region binds, the
 * definition at each fact, the closure from its head, one probe of a key for each occurrence, and the stored table's
 * row at the fact; the DELETE's own target node writes, and reads nothing.
 */
const overProbes = (plan: PlanNode): ReadonlyArray<string> =>
	Iterator.from(planNodes(plan))
		.filter(
			(n) =>
				Option.isSome(n.relation) &&
				n.nodeType !== "ModifyTable" &&
				n.actualRows + n.rowsRemovedByFilter > 1
		)
		.map(
			(n) =>
				`${n.nodeType} on ${Option.getOrElse(n.relation, () => "")}: ${n.actualRows} rows and ${n.rowsRemovedByFilter} filtered a loop, ${n.actualLoops} loops`
		)
		.toArray()

/** Open's and Suspended's facts at other sittings for each session of the measured one (`otherSittingsSql`). */
const othersPer = 1000

/**
 * The statements that store, at each of the other sittings `from` to `to` of the learner, stages past the measured one,
 * one open visit and one suspended: Open's facts and Suspended's there, a thousand of each for each session of the
 * measured sitting, which grow with the box as the sitting does, so each table is one PostgreSQL reads by its key, and a
 * read of it whole, or at the learner alone, reads ten times as many rows beside the second measure.
 */
const otherSittingsSql = (installed: Installed, from: number, to: number) => {
	const names = namesOf(installed)
	const series = `FROM generate_series(${from}, ${to}) AS g(s)`
	return [
		`INSERT INTO ${names.table(OpenVisit)} (child, stage, k, at) SELECT ${child}, g.s, k, 1000 * k ${series}, generate_series(0, 1) AS h(k)`,
		`INSERT INTO ${names.table(OpenSuspension)} (child, stage, k, at) SELECT ${child}, g.s, 1, 1900 ${series}`
	]
}

/**
 * One case on a fresh clone: the sitting of `few` sessions, the last open, committed; the judge's work at the write's
 * COMMIT measured, rolled back; then the sitting grown to ten times as many, the last open again, committed, and the
 * same write measured at the new open session. Every statement of an upkeep kept by its checked form reads the same rows
 * both times, and each run of a checked form's removal reads at most one row a loop of every table (`overProbes`): the
 * facts the write withdraws and their checks at their facts, never the sitting's other sessions.
 */
export const runLost = (
	installed: Installed,
	session: RawSession,
	d: LostCase,
	c: Case<LostFeature>
) =>
	Effect.gen(function* () {
		const checked = new Set(
			Arr.flatMap(installed.installation.laws.theory.upkeeps, (u) =>
				u.form.kind === "delta" && u.form.lost.kind === "checked" ? [u.relation] : []
			)
		)
		assert.ok(checked.has("Open"), "Open kept by its checked form")
		assert.ok(checked.has("Suspended"), "Suspended kept by its checked form")
		const work = (open: number) =>
			Effect.gen(function* () {
				yield* session.begin
				const plans = yield* Effect.onError(
					Effect.gen(function* () {
						yield* session.query(lostSql(installed, d.write, open), [])
						const run = yield* judgeRun(
							(sql) => session.values(sql, []),
							installed.installation,
							judgeStatementsOf(installed.installation)
						)
						/** The routines of the checked upkeeps measured, whose plans the laws hold over. */
						const routines = new Set(
							Arr.flatMap(run, (p) =>
								p.statement.kind === "upkeep" && checked.has(p.statement.relation)
									? [`${p.statement.routine.schema}.${p.statement.routine.name}`]
									: []
							)
						)
						for (const scope of routineScopes(installed.installation)) {
							if (
								scope.vehicle.kind === "routine" &&
								routines.has(`${scope.vehicle.routine.schema}.${scope.vehicle.routine.name}`)
							) {
								yield* lawsHold(session, scope)
							}
						}
						return run
					}),
					() => Effect.ignore(session.rollback)
				)
				yield* session.rollback
				return Arr.filter(
					plans,
					(p) => p.statement.kind === "upkeep" && checked.has(p.statement.relation)
				)
			})
		yield* standUpJudge(session, installed.installation)
		yield* committedJudged(session, [
			`INSERT INTO ${namesOf(installed).table(Cohort)} (child, cohort) VALUES (${child}, 1)`,
			...openSessionsSql(installed, 0, d.few - 1, d.per),
			...otherSittingsSql(installed, stage + 1, stage + othersPer * d.few)
		])
		const few = yield* work(d.few - 1)
		const many = 10 * d.few
		yield* committedJudged(session, [
			`INSERT INTO ${namesOf(installed).table(OpenSuspension)} (child, stage, k, at) VALUES (${child}, ${stage}, ${d.few - 1}, ${visitAt(d.few - 1) + 900})`,
			...openSessionsSql(installed, d.few, many - 1, d.per),
			...otherSittingsSql(installed, stage + othersPer * d.few + 1, stage + othersPer * many)
		])
		const more = yield* work(many - 1)
		for (const p of [...few, ...more]) {
			if (p.statement.kind === "upkeep" && p.statement.statement.kind === "delete") {
				assert.deepEqual(
					overProbes(p.plan),
					[],
					`${Formatter.format(d)}: ${named(p.statement)} reads a table by more than a probe of one row`
				)
			}
		}
		assert.deepEqual(
			measured(more),
			measured(few),
			`${Formatter.format(d)}: each statement of a checked upkeep reads the same rows beside ${d.few} sessions of the sitting and beside ${many}`
		)
		assert.ok(
			Arr.some(few, (p) => p.statement.kind === "upkeep" && p.statement.relation === "Open"),
			"Open's upkeep among the statements the write's COMMIT runs"
		)
		c.note(lostFeatureOf[d.write])
	})
