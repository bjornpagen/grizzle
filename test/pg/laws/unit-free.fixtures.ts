/**
 * What unit-free.test.ts reads: four shapes of a rule over a derived relation whose binding leaves the relation's unit
 * free, each modelled on a consumer's law, and each case's run.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	committedJudged,
	type JudgePlan,
	judgeRun,
	type JudgeStatement,
	judgeStatementsOf,
	scannedWork,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

const i = int4

/**
 * metis's PartByBase (proctoring/src/flow-laws.ts:146, its law :159): a learner's proctored parts, keyed by the learner
 * first, read by a projection onto (number, generation), which drops the learner; a provisioning input of another unit
 * contained in it at (number, generation).
 */
const Part = relation("Part", { child: i, number: i, generation: i }, [
	"child",
	"number",
	"generation"
])
const Input = relation("Input", { root: i, number: i, generation: i }, [
	"root",
	"number",
	"generation"
])
const PartBase = schema(
	"UnitFreePart",
	[Part, Input],
	[unit("Learner", { child: i }), unit("Root", { root: i })]
)
const PartByBase = derived(
	"PartByBase",
	query(PartBase).rule((r) => {
		const { child, number, generation } = v(Part, "part")
		return r.match(Part, { child, number, generation }).find({ number, generation })
	})
)
const PartLaws = schema.extend(
	[PartBase],
	"UnitFreePart_1",
	[PartByBase],
	[contained(on(Input, "number", "generation"), on(PartByBase, "number", "generation"))]
)

/**
 * metis's AwardDemanded (xp-flow/src/award-requests.ts:76, its laws :108 and :116): a learner's ended tests joined to
 * the assignment of each and its evaluation, three relations of the learner's unit, read by its assignment's number
 * alone; an award request contained in it, and it contained in the grading requests, each at the number.
 */
const TestEnd = relation("TestEnd", { child: i, stage: i }, ["child", "stage"])
const Assignment = relation("Assignment", { child: i, number: i, stage: i }, ["child", "number"])
const Evaluated = relation("Evaluated", { child: i, number: i }, ["child", "number"])
const AwardRequested = relation("AwardRequested", { number: i }, ["number"])
const GradingRequest = relation("GradingRequest", { number: i }, ["number"])
const AwardBase = schema(
	"UnitFreeAward",
	[TestEnd, Assignment, Evaluated, AwardRequested, GradingRequest],
	[unit("Learner", { child: i })]
)
const AwardDemanded = derived(
	"AwardDemanded",
	query(AwardBase).rule((r) => {
		const { child, stage, number } = v(Assignment, "assignment")
		return r
			.match(TestEnd, { child, stage })
			.match(Assignment, { child, number, stage })
			.match(Evaluated, { child, number })
			.find({ number })
	})
)
const AwardLaws = schema.extend(
	[AwardBase],
	"UnitFreeAward_1",
	[AwardDemanded],
	[
		contained(on(AwardRequested, "number"), on(AwardDemanded, "number")),
		contained(on(AwardDemanded, "number"), on(GradingRequest, "number"))
	]
)

/**
 * metis's Submitted (assignment/src/views.ts:170, its law xp/src/level.ts:103): each submission of a learner's sitting,
 * its event joined to its instant, the learner in its heading, read by the sitting's number alone; a legacy report
 * contained in it at the number.
 */
const SittingEvent = relation("SittingEvent", { child: i, number: i, step: i, kind: i }, [
	"child",
	"number",
	"step"
])
const EventAt = relation("EventAt", { child: i, number: i, step: i, at: i }, [
	"child",
	"number",
	"step"
])
const Report = relation("Report", { number: i }, ["number"])
const SubmittedBase = schema(
	"UnitFreeSubmitted",
	[SittingEvent, EventAt, Report],
	[unit("Learner", { child: i })]
)
const Submitted = derived(
	"Submitted",
	query(SubmittedBase).rule((r) => {
		const { child, number, step, at } = v(EventAt, "at")
		return r
			.match(SittingEvent, { child, number, step, kind: 2 })
			.match(EventAt, { child, number, step, at })
			.find({ child, number, at })
	})
)
const SubmittedLaws = schema.extend(
	[SubmittedBase],
	"UnitFreeSubmitted_1",
	[Submitted],
	[contained(on(Report, "number"), on(Submitted, "number"))]
)

/**
 * pantry's value containments (qti/overlay-queries interaction.ts:914 and the like): each node of a package joined to
 * its attribute, read by the attribute's base type alone, contained in the base types a roster admits.
 */
const Node = relation("Node", { package: i, path: i, start: i, kind: i }, [
	"package",
	"path",
	"start"
])
const Attribute = relation("Attribute", { package: i, path: i, start: i, base: i }, [
	"package",
	"path",
	"start"
])
const BaseType = relation("BaseType", { base: i }, ["base"])
const ValueBase = schema(
	"UnitFreeValue",
	[Node, Attribute, BaseType],
	[unit("Package", { package: i })]
)
const NodeBase = derived(
	"NodeBase",
	query(ValueBase).rule((r) => {
		const { package: pkg, path, start, base } = v(Attribute, "attribute")
		const { kind } = v(Node, "node")
		return r
			.match(Node, { package: pkg, path, start, kind })
			.match(Attribute, { package: pkg, path, start, base })
			.find({ package: pkg, path, start, base })
	})
)
const ValueLaws = schema.extend(
	[ValueBase],
	"UnitFreeValue_1",
	[NodeBase],
	[contained(on(NodeBase, "base"), on(BaseType, "base"))]
)

/** The four shapes, each by the consumer law it is modelled on. */
export const unitFreeShapes = ["PartByBase", "AwardDemanded", "Submitted", "NodeBase"] as const
export type UnitFreeShape = (typeof unitFreeShapes)[number]

/** A shape's template: its schema, `declared` over base `base`, installed through its first migration, with no login. */
const templateOf = (
	shape: UnitFreeShape,
	base: string,
	declared: FixtureSchema
): SubstrateTemplate<Installed> =>
	migratedTemplate({
		declaredIn: import.meta,
		name: `unit free ${shape}`,
		content: { schema: base, logins: [] },
		versions: [{ schema: declared, declarations: noDeclarations }],
		options: {
			label: `unit_free_${Str.toLowerCase(shape)}`,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})

export const unitFreeTemplates: Readonly<Record<UnitFreeShape, SubstrateTemplate<Installed>>> = {
	PartByBase: templateOf("PartByBase", "UnitFreePart", PartLaws),
	AwardDemanded: templateOf("AwardDemanded", "UnitFreeAward", AwardLaws),
	Submitted: templateOf("Submitted", "UnitFreeSubmitted", SubmittedLaws),
	NodeBase: templateOf("NodeBase", "UnitFreeValue", ValueLaws)
}

/** A case: its shape, and the units stored beside the background before the second measure. */
export interface UnitFreeCase {
	readonly shape: UnitFreeShape
	readonly more: number
}

export const unitFreeGen: Gen<UnitFreeCase> = (s) => ({
	shape: s.draw(element(unitFreeShapes)),
	more: s.draw(element([600, 900] as const))
})

export type UnitFreeFeature = `${UnitFreeShape} measured`

/**
 * The units every case stores beside its own, each with one row of each of the shape's relations of a unit, so a read
 * of a table whole, or of every unit's rows, reads past the rows at the touched binding, which a read at its keys reads
 * alone.
 *
 * @limitKind derived
 * @owner the unit-free locality (unit-free.test.ts)
 * @unit units
 * @scope the background each case measures beside
 * @evidence ~/.cache/grizzle/DECLSTATS-work/unitscale/run3.sh, its output unitscale3.log beside it (2026-11-23): a
 *   delta's reader declared at 10 rows is read by a probe of the key at every table from 2^10 rows, a hash over a scan below; at 2,048 rows each table is a dozen pages
 */
const background = 2048

/**
 * The statements that store units `from` to `to` of `shape`, unit u with one row of each of its relations of a unit, at
 * number 100u: the case's own unit is 1, the background's 2 on.
 */
const unitsSql = (
	shape: UnitFreeShape,
	installed: Installed,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const t = namesOf(installed).table
	const series = `FROM generate_series(${from}, ${to}) AS g(u)`
	switch (shape) {
		case "PartByBase":
			return [`INSERT INTO ${t(Part)} (child, number, generation) SELECT u, 100 * u, 1 ${series}`]
		case "AwardDemanded":
			return [
				`INSERT INTO ${t(TestEnd)} (child, stage) SELECT u, 1 ${series}`,
				`INSERT INTO ${t(Assignment)} (child, number, stage) SELECT u, 100 * u, 1 ${series}`,
				`INSERT INTO ${t(Evaluated)} (child, number) SELECT u, 100 * u ${series}`,
				`INSERT INTO ${t(GradingRequest)} (number) SELECT 100 * u ${series}`
			]
		case "Submitted":
			return [
				`INSERT INTO ${t(SittingEvent)} (child, number, step, kind) SELECT u, 100 * u, 1, 2 ${series}`,
				`INSERT INTO ${t(EventAt)} (child, number, step, at) SELECT u, 100 * u, 1, 5 ${series}`
			]
		case "NodeBase":
			return [
				`INSERT INTO ${t(Node)} (package, path, start, kind) SELECT u, 1, 0, 1 ${series}`,
				`INSERT INTO ${t(Attribute)} (package, path, start, base) SELECT u, 1, 0, 1 ${series}`
			]
	}
}

/** The statements a case stores before any measure beside its units: the base types a roster admits. */
const fixedSql = (shape: UnitFreeShape, installed: Installed): ReadonlyArray<string> =>
	shape === "NodeBase"
		? [
				`INSERT INTO ${namesOf(installed).table(BaseType)} (base) SELECT b FROM generate_series(1, 3) AS g(b)`
			]
		: []

/**
 * The write a case's judge is measured at: one that probes the derived relation at the binding that leaves its unit
 * free, the containment's source at unit 1's number, or a new attribute of unit 1's package, whose base type the
 * containment reads.
 */
const touchSql = (shape: UnitFreeShape, installed: Installed): ReadonlyArray<string> => {
	const t = namesOf(installed).table
	switch (shape) {
		case "PartByBase":
			return [`INSERT INTO ${t(Input)} (root, number, generation) VALUES (1, 100, 1)`]
		case "AwardDemanded":
			return [`INSERT INTO ${t(AwardRequested)} (number) VALUES (100)`]
		case "Submitted":
			return [`INSERT INTO ${t(Report)} (number) VALUES (100)`]
		case "NodeBase":
			return [
				`INSERT INTO ${t(Node)} (package, path, start, kind) VALUES (1, 2, 0, 1)`,
				`INSERT INTO ${t(Attribute)} (package, path, start, base) VALUES (1, 2, 0, 2)`
			]
	}
}

/**
 * The judge's work over the touch (`touchSql`), explained on `session` while the deltas hold its rows, in a transaction
 * rolled back (test/support/judge.ts judgeRun): each statement the judge runs over them.
 */
const touchedWork = (shape: UnitFreeShape, installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		yield* session.begin
		const work = yield* Effect.onError(
			Effect.gen(function* () {
				for (const sql of touchSql(shape, installed)) {
					yield* session.query(sql, [])
				}
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

/** Each statement measured: its work (test/support/judge.ts scannedWork). */
const measured = (plans: ReadonlyArray<JudgePlan<JudgeStatement>>) =>
	Arr.map(plans, (p) => ({
		rows: scannedWork(p.plan)
	}))

/**
 * One case on a fresh clone, in one session: the shape's unit 1 stored after `background` units, so a scan of a table
 * reaches its rows last, committed, and the judge's work at the touch measured, each statement under its routine's own
 * advice (test/support/judge.ts judgeRun); then `more` units stored beside them, committed, and the work measured
 * again. Each statement does the same work both times (test/support/judge.ts scannedWork): the probe of the
 * derived relation at its unit-free binding reads the rows at that binding alone, a chain of keyed reads from the
 * binding, never the units beside them.
 */
export const runUnitFree = (
	installed: Installed,
	session: RawSession,
	d: UnitFreeCase,
	c: Case<UnitFreeFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(session, installed.installation)
		yield* committedJudged(session, [
			...fixedSql(d.shape, installed),
			...unitsSql(d.shape, installed, 2, background + 1),
			...unitsSql(d.shape, installed, 1, 1)
		])
		const fewPlans = yield* touchedWork(d.shape, installed, session)
		yield* committedJudged(
			session,
			unitsSql(d.shape, installed, background + 2, background + 1 + d.more)
		)
		const manyPlans = yield* touchedWork(d.shape, installed, session)
		const few = measured(fewPlans)
		const many = measured(manyPlans)
		assert.ok(
			Arr.some(few, (w) => w.rows > 0),
			`${Formatter.format(d)}: some judged statement reads the touched rows`
		)
		assert.deepEqual(
			many,
			few,
			`${Formatter.format(d)}: each judged statement does the same work beside ${background} units and beside ${background + d.more}`
		)
		c.note(`${d.shape} measured`)
	})
