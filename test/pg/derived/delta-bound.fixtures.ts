/**
 * What the properties of delta-bound.test.ts read: a package's tests, items and controls in a unit sealed at founding,
 * a learner's sittings, item sessions, snapshots, visits, suspensions, ends, attempts and enrolment in the learner's
 * unit, keyed by the learner and then apart, and ledger's stored relations over them that no unit bounds the upkeep of,
 * each stored by its delta form; their template, the writes a case draws, the host's model of what each stored relation
 * holds, and each case's run.
 */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { compileInstallation } from "#compiler/program/install.ts"
import { Type } from "#compiler/public/compute.ts"
import { contract, bool, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { asDataStep } from "#test/support/data-step.ts"
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

const childKey = Symbol("Child")
/** A learner, by a number of its own type, so no package's number leads a learner's key. */
const Child = contract<typeof childKey>()("Child", int4)
const packageNoKey = Symbol("PackageNo")
/** A package, by a number of its own type. */
const PackageNo = contract<typeof packageNoKey>()("PackageNo", int4)

/** A package's test. */
const Test = relation("Test", { package: PackageNo, test: int4 }, ["package", "test"])
/** A package's item, adaptive or not. */
const Item = relation("Item", { package: PackageNo, item: int4, adaptive: bool }, [
	"package",
	"item"
])
/** An item's attempts in a test, as its test's scopes state them: ledger's MemberControl, stored at publication. */
const MemberControl = relation(
	"MemberControl",
	{ package: PackageNo, test: int4, item: int4, tries: int8 },
	["package", "test", "item"]
)
/** An item's outcome variable an external scorer sets: ledger's externallyScored. */
const ExternalOutcome = relation(
	"ExternalOutcome",
	{ package: PackageNo, item: int4, variable: int4 },
	["package", "item", "variable"]
)
/** A learner's sitting of a test, by its stage. */
const TestSession = relation(
	"TestSession",
	{ child: Child, stage: int4, package: PackageNo, test: int4 },
	["child", "stage"]
)
/** A learner's item session, numbered under its item, in the sitting of its stage. */
const ItemSession = relation(
	"ItemSession",
	{ child: Child, package: PackageNo, item: int4, n: int4, stage: int4 },
	["child", "package", "item", "n"]
)
/** A response snapshot of an item session, at its instant. */
const ResponseSnapshot = relation(
	"ResponseSnapshot",
	{ child: Child, package: PackageNo, item: int4, n: int4, at: int4 },
	["child", "package", "item", "n", "at"]
)
/** A sitting's candidate session k, begun at its instant. */
const TestVisit = relation("TestVisit", { child: Child, stage: int4, k: int4, at: int4 }, [
	"child",
	"stage",
	"k"
])
/** The suspension that ended a sitting's candidate session k, at its instant. */
const TestSuspension = relation(
	"TestSuspension",
	{ child: Child, stage: int4, k: int4, at: int4 },
	["child", "stage", "k"]
)
/** A sitting's end, in its candidate session k, at its instant. */
const TestEnd = relation("TestEnd", { child: Child, stage: int4, k: int4, at: int4 }, [
	"child",
	"stage"
])
/** A stage's control, which the application's decision states: ledger's StageControl. */
const StageControl = relation("StageControl", { child: Child, stage: int4, tries: int8 }, [
	"child",
	"stage"
])
/** An attempt of an item session, at its instant. */
const Attempt = relation(
	"Attempt",
	{ child: Child, package: PackageNo, item: int4, n: int4, at: int4 },
	["child", "package", "item", "n", "at"]
)
/** An attempt's processing, run, and whether it left the item session completed: ledger's ProcessedAttempt. */
const Processed = relation(
	"Processed",
	{
		child: Child,
		package: PackageNo,
		item: int4,
		n: int4,
		at: int4,
		completed: bool
	},
	["child", "package", "item", "n", "at"]
)
/** An external scorer's assertion of an attempt's outcome variable: ledger's OutcomeAssertion. */
const OutcomeAssertion = relation(
	"OutcomeAssertion",
	{
		child: Child,
		package: PackageNo,
		item: int4,
		n: int4,
		at: int4,
		variable: int4
	},
	["child", "package", "item", "n", "at", "variable"]
)
/** A learner's enrolment, closed and keyed by the learner alone. */
const Enrolled = relation("Enrolled", { child: Child }, ["child"])
/** An item's response variable whose true value counts no attempt, an end-attempt interaction's: ledger's
 * uncountingResponses, content. */
const Uncounting = relation("Uncounting", { package: PackageNo, item: int4, variable: int4 }, [
	"package",
	"item",
	"variable"
])
/** A response snapshot's boolean value of a variable: ledger's SnapshotSingleBoolean. */
const SnapshotBoolean = relation(
	"SnapshotBoolean",
	{
		child: Child,
		package: PackageNo,
		item: int4,
		n: int4,
		at: int4,
		variable: int4,
		value: bool
	},
	["child", "package", "item", "n", "at", "variable"]
)

/** The content, sealed at founding, and the learner's rows, every one naming content its package's founding wrote. */
const Base = schema(
	"DeltaBoundPg",
	[
		Test,
		Item,
		MemberControl,
		ExternalOutcome,
		TestSession,
		ItemSession,
		ResponseSnapshot,
		TestVisit,
		TestSuspension,
		TestEnd,
		StageControl,
		Attempt,
		Processed,
		OutcomeAssertion,
		Enrolled,
		Uncounting,
		SnapshotBoolean
	],
	[
		unit("Learner", { child: Child }),
		sealed(unit("Package", { package: PackageNo })),
		contained(on(MemberControl, "package", "test"), on(Test, "package", "test")),
		contained(on(MemberControl, "package", "item"), on(Item, "package", "item")),
		contained(on(ExternalOutcome, "package", "item"), on(Item, "package", "item")),
		contained(on(TestSession, "package", "test"), on(Test, "package", "test")),
		contained(on(ItemSession, "child", "stage"), on(TestSession, "child", "stage")),
		contained(on(ItemSession, "package", "item"), on(Item, "package", "item")),
		contained(
			on(ResponseSnapshot, "child", "package", "item", "n"),
			on(ItemSession, "child", "package", "item", "n")
		),
		contained(on(TestVisit, "child", "stage"), on(TestSession, "child", "stage")),
		contained(on(TestSuspension, "child", "stage", "k"), on(TestVisit, "child", "stage", "k")),
		contained(on(TestEnd, "child", "stage", "k"), on(TestVisit, "child", "stage", "k")),
		contained(on(StageControl, "child", "stage"), on(TestSession, "child", "stage")),
		contained(
			on(Attempt, "child", "package", "item", "n"),
			on(ItemSession, "child", "package", "item", "n")
		),
		contained(
			on(Processed, "child", "package", "item", "n", "at"),
			on(Attempt, "child", "package", "item", "n", "at")
		),
		contained(
			on(OutcomeAssertion, "child", "package", "item", "n", "at"),
			on(Attempt, "child", "package", "item", "n", "at")
		),
		contained(on(Uncounting, "package", "item"), on(Item, "package", "item")),
		contained(
			on(SnapshotBoolean, "child", "package", "item", "n", "at"),
			on(ResponseSnapshot, "child", "package", "item", "n", "at")
		)
	]
)

/** Each response snapshot of a sitting's item session, with its stage: ledger's testSnapshots, TestSnapshot's definition. */
const testSnapshots = query(Base).rule((r) => {
	const { child, package: p, item, n, at } = v(ResponseSnapshot, "snapshot")
	const { stage } = v(ItemSession, "session")
	return r
		.match(ResponseSnapshot, { at, child, n, package: p, item })
		.match(ItemSession, { child, n, package: p, item, stage })
		.match(TestSession, { child, stage })
		.find({ at, child, n, package: p, item, stage })
})

/** ledger's TestSnapshot. */
const TestSnapshot = derived("TestSnapshot", testSnapshots)

/** Each item session's control, a member's from its test's content read by reference, a stage's from its stage:
 * ledger's controls, ItemSessionControl's definition. */
const controls = query(Base)
	.rule((r) => {
		const { child, package: p, item, n, stage } = v(ItemSession, "member")
		const { test } = v(TestSession, "sitting")
		const { tries } = v(MemberControl, "control")
		return r
			.match(ItemSession, { child, n, package: p, item, stage })
			.match(TestSession, { child, package: p, test, stage })
			.match(MemberControl, { item, package: p, test, tries })
			.find({ child, n, package: p, item, tries })
	})
	.rule((r) => {
		const { child, package: p, item, n, stage } = v(ItemSession, "staged")
		const { tries } = v(StageControl, "stageControl")
		return r
			.match(ItemSession, { child, n, package: p, item, stage })
			.match(StageControl, { child, stage, tries })
			.find({ child, n, package: p, item, tries })
	})

/** ledger's ItemSessionControl. */
const ItemSessionControl = derived("ItemSessionControl", controls)

/** Each attempt not processed, with its item session's stage: ledger's unprocessedAttempts. */
const unprocessed = query(Base).rule((r) => {
	const { child, package: p, item, n, at } = v(Attempt, "attempt")
	const { stage } = v(ItemSession, "session")
	return r
		.match(Attempt, { at, child, n, package: p, item })
		.match(ItemSession, { child, n, package: p, item, stage })
		.where(r.not(Processed, { at, child, n, package: p, item }))
		.find({ at, child, n, package: p, item, stage })
})

/** Each processed attempt with an externally scored outcome no assertion has scored, with its item session's stage:
 * ledger's unscoredAttempts over pendingExternalScorings. */
const unscored = (() => {
	const pending = query(Base).rule((r) => {
		const { child, package: p, item, n, at } = v(Attempt, "attempt")
		const { variable } = v(ExternalOutcome, "scored")
		return r
			.match(Attempt, { at, child, n, package: p, item })
			.match(ExternalOutcome, { item, package: p, variable })
			.where(r.not(OutcomeAssertion, { at, child, item, n, package: p, variable }))
			.find({ at, child, n, package: p, item, variable })
	})
	return query(Base).rule((r) => {
		const { child, package: p, item, n, at } = v(Processed, "unscored")
		const { stage } = v(ItemSession, "unscoredSession")
		return r
			.match(Processed, { at, child, n, package: p, item })
			.match(ItemSession, { child, n, package: p, item, stage })
			.match(pending, { at, child, n, package: p, item })
			.find({ at, child, n, package: p, item, stage })
	})
})()

/** Each ended sitting none of whose attempts is unprocessed or unscored: ledger's SettledSitting, both queries
 * stored and negated by their names at the sitting. */
const SettledSitting = derived(
	"SettledSitting",
	query(Base).rule((r) => {
		const { child, stage } = v(TestEnd, "end")
		return r
			.match(TestEnd, { child, stage })
			.where(r.not(unprocessed, { child, stage }), r.not(unscored, { child, stage }))
			.find({ child, stage })
	})
)

/**
 * Each sitting holding an attempt not final, unprocessed or unscored: ledger's UnsettledSitting, each rule a seek of its
 * stored import at the sitting (analysis/theory/unit.ts StepBy `seek`), every changed row of it naming its one sitting.
 */
const UnsettledSitting = derived(
	"UnsettledSitting",
	query(Base)
		.rule((r) => {
			const { child, stage } = v(unprocessed, "unsettledUnprocessed")
			return r.match(unprocessed, { child, stage }).find({ child, stage })
		})
		.rule((r) => {
			const { child, stage } = v(unscored, "unsettledUnscored")
			return r.match(unscored, { child, stage }).find({ child, stage })
		})
)

/** Each response snapshot of an enrolled learner, the enrolment matched first: monotone over closed relations. */
const EnrolledSnapshot = derived(
	"EnrolledSnapshot",
	query(Base).rule((r) => {
		const { child, package: p, item, n, at } = v(ResponseSnapshot, "snapshot")
		return r
			.match(Enrolled, { child })
			.match(ResponseSnapshot, { at, child, n, package: p, item })
			.find({ at, child, n, package: p, item })
	})
)

/** The first level: TestSnapshot, ItemSessionControl, SettledSitting, UnsettledSitting and EnrolledSnapshot. */
const Stored = schema.extend(
	[Base],
	"DeltaBoundPg_1",
	[TestSnapshot, ItemSessionControl, SettledSitting, UnsettledSitting, EnrolledSnapshot],
	[]
)

/** Each attempt that counts, no uncounting response of its snapshot true: ledger's countedAttemptsOf. */
const counted = (() => {
	const uncounted = query(Stored).rule((r) => {
		const { child, package: p, item, n, at } = v(Attempt, "uncounted")
		const { variable } = v(Uncounting, "uncounting")
		return r
			.match(Attempt, { at, child, n, package: p, item })
			.match(Uncounting, { item, package: p, variable })
			.match(SnapshotBoolean, { at, child, item, n, package: p, value: true, variable })
			.find({ at, child, n, package: p, item })
	})
	return query(Stored).rule((r) => {
		const { child, package: p, item, n, at } = v(Attempt, "counted")
		return r
			.match(Attempt, { at, child, n, package: p, item })
			.where(r.not(uncounted, { at, child, n, package: p, item }))
			.find({ at, child, n, package: p, item })
	})
})()

/** Each adaptive item session one of whose processed attempts completed it: ledger's completedSessionsOf. */
const completed = query(Stored).rule((r) => {
	const { child, package: p, item, n } = v(Processed, "completing")
	return r
		.match(Processed, { child, completed: true, n, package: p, item })
		.match(Item, { adaptive: true, package: p, item })
		.find({ child, n, package: p, item })
})

/** Each item session's counted attempts, counted. */
const counts = query(Stored).rule((r) => {
	const { child, package: p, item, n, at } = v(counted, "countedAttempt")
	return r
		.match(counted, { at, child, n, package: p, item })
		.find({ child, counted: r.count(), n, package: p, item })
})

/**
 * Each item session that takes another attempt: ledger's ItemSessionOpen, its four rules, the controls read by
 * ItemSessionControl's name, a tried session's by a seek at the session and a range of its limit above its counted
 * attempts.
 */
const ItemSessionOpen = derived(
	"ItemSessionOpen",
	query(Stored)
		.rule((r) => {
			const { child, package: p, item, n, stage } = v(ItemSession, "adaptive")
			return r
				.match(ItemSession, { child, n, package: p, item, stage })
				.match(Item, { adaptive: true, package: p, item })
				.where(r.not(completed, { child, n, package: p, item }), r.not(TestEnd, { child, stage }))
				.find({ child, n, package: p, item })
		})
		.rule((r) => {
			const { child, package: p, item, n, stage } = v(ItemSession, "unlimited")
			const { tries } = v(controls, "noLimit")
			return r
				.match(ItemSession, { child, n, package: p, item, stage })
				.match(controls, { child, n, package: p, item, tries })
				.where(
					r.eq(tries, 0n),
					r.not(Item, { adaptive: true, package: p, item }),
					r.not(TestEnd, { child, stage })
				)
				.find({ child, n, package: p, item })
		})
		.rule((r) => {
			const { child, package: p, item, n, stage } = v(ItemSession, "untried")
			return r
				.match(ItemSession, { child, n, package: p, item, stage })
				.where(
					r.not(Item, { adaptive: true, package: p, item }),
					r.not(counted, { child, n, package: p, item }),
					r.not(TestEnd, { child, stage })
				)
				.find({ child, n, package: p, item })
		})
		.rule((r) => {
			const { child, package: p, item, n, stage } = v(ItemSession, "triedSession")
			const { counted: made } = v(counts, "tried")
			const { tries } = v(controls, "limit")
			return r
				.match(ItemSession, { child, n, package: p, item, stage })
				.match(counts, { child, counted: made, n, package: p, item })
				.match(controls, { child, n, package: p, item, tries })
				.where(
					r.not(Item, { adaptive: true, package: p, item }),
					r.not(TestEnd, { child, stage }),
					r.lt(Type.base(made), tries)
				)
				.find({ child, n, package: p, item })
		})
)

/**
 * Each response snapshot of a sitting inside one of its candidate sessions, with that session's k and its beginning:
 * ledger's SessionSnapshot over testSnapshots imported, whose canonical relation is TestSnapshot's table, read by its
 * name.
 */
const SessionSnapshot = derived(
	"SessionSnapshot",
	query(Stored)
		.rule((r) => {
			const { child, stage, package: p, item, n, at } = v(testSnapshots, "open")
			const { k, at: began } = v(TestVisit, "openVisit")
			return r
				.match(testSnapshots, { at, child, n, package: p, item, stage })
				.match(TestVisit, { at: began, child, k, stage })
				.where(
					r.le(began, at),
					r.not(TestSuspension, { child, k, stage }),
					r.not(TestEnd, { child, stage })
				)
				.find({ at, began, child, k, n, package: p, item, stage })
		})
		.rule((r) => {
			const { child, stage, package: p, item, n, at } = v(testSnapshots, "suspended")
			const { k, at: began } = v(TestVisit, "suspendedVisit")
			const { at: suspended } = v(TestSuspension, "suspension")
			return r
				.match(testSnapshots, { at, child, n, package: p, item, stage })
				.match(TestVisit, { at: began, child, k, stage })
				.match(TestSuspension, { at: suspended, child, k, stage })
				.where(r.le(began, at), r.le(at, suspended))
				.find({ at, began, child, k, n, package: p, item, stage })
		})
		.rule((r) => {
			const { child, stage, package: p, item, n, at } = v(testSnapshots, "ended")
			const { k, at: began } = v(TestVisit, "endedVisit")
			const { at: end } = v(TestEnd, "end")
			return r
				.match(testSnapshots, { at, child, n, package: p, item, stage })
				.match(TestVisit, { at: began, child, k, stage })
				.match(TestEnd, { at: end, child, k, stage })
				.where(r.le(began, at), r.le(at, end))
				.find({ at, began, child, k, n, package: p, item, stage })
		})
)

/** The schema: the content, the learner's rows, and the stored relations of both levels. */
const DeltaBound = schema.extend([Stored], "DeltaBoundPg_2", [SessionSnapshot, ItemSessionOpen], [])

/** DeltaBound installed through its first migration, with no login. */
export const deltaBoundTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "delta bound",
	content: { schema: "DeltaBoundPg", logins: [] },
	versions: [{ schema: DeltaBound, declarations: noDeclarations }],
	options: {
		label: "delta_bound",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The package every case's content is, its test 1 and its items 0, adaptive, and 1, externally scored at variable 0,
 * whose response variable 0 true counts no attempt. */
const contentSql = (installed: Installed): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return [
		`INSERT INTO ${names.table(Test)} (package, test) VALUES (1, 1)`,
		`INSERT INTO ${names.table(Item)} (package, item, adaptive) VALUES (1, 0, true), (1, 1, false)`,
		`INSERT INTO ${names.table(MemberControl)} (package, test, item, tries) VALUES (1, 1, 0, 0), (1, 1, 1, 2)`,
		`INSERT INTO ${names.table(ExternalOutcome)} (package, item, variable) VALUES (1, 1, 0)`,
		`INSERT INTO ${names.table(Uncounting)} (package, item, variable) VALUES (1, 1, 0)`
	]
}

/** Each item's attempts under test 1, MemberControl's rows. */
const memberTries: ReadonlyMap<number, number> = new Map([
	[0, 0],
	[1, 2]
])

/** The items whose outcome an external scorer sets, at variable 0. */
const externallyScored: ReadonlySet<number> = new Set([1])

/** The items whose response variable 0, true, counts no attempt, Uncounting's rows. */
const uncountingItems: ReadonlySet<number> = new Set([1])

/**
 * One transaction of a case, a learner `child`'s write at a stage, a candidate session `k` or an item, at the case's
 * next instant, each writing first in the same transaction what it names and no row stands for: a sitting of test 1 at
 * the stage, its candidate session k begun, an item session of the item in the sitting, an attempt of it, its
 * processing:
 *
 * - `visit`: the sitting's candidate session k begun; `control`: its stage control of 3;
 * - `open`: another item session of the item in the sitting, numbered past the learner's last of the item;
 * - `snapshot`: a response snapshot of the learner's last item session of the item in the sitting, its session 1 begun;
 * - `suspend` and `end`: the sitting's candidate session k suspended, none where it was, or the sitting ended in its
 *   latest session, k where it began none, none where it ended;
 * - `attempt`: an attempt of the learner's last item session of the item in the sitting; `process`: its last attempt
 *   there processed, completing it or not; `score`: the last processed attempt of item 1, the one externally scored,
 *   asserted, none where an assertion scores it already, its processing removed by a data step and run again;
 * - `enrol`: the learner enrolled, none where it is;
 * - `remove`: a data step, as a migration's removes a row of a closed relation (test/support/data-step.ts): the learner's
 *   last snapshot no response value names, its last suspension of a session its sitting ended in or else its last,
 *   its enrolment, or the last processing of the item; none where no such row
 *   stands.
 */
export interface Step {
	readonly kind:
		| "visit"
		| "control"
		| "open"
		| "snapshot"
		| "suspend"
		| "end"
		| "attempt"
		| "process"
		| "score"
		| "enrol"
		| "remove"
	readonly child: number
	readonly stage: number
	readonly k: number
	readonly item: number
	readonly completed: boolean
	readonly removes: "snapshot" | "suspension" | "enrolment" | "processing"
}

const stepGen: Gen<Step> = (s) => ({
	kind: s.draw(
		element([
			"visit",
			"control",
			"open",
			"snapshot",
			"suspend",
			"end",
			"attempt",
			"process",
			"score",
			"enrol",
			"remove"
		] as const)
	),
	child: s.draw(int(1, 2)),
	stage: s.draw(int(1, 2)),
	k: s.draw(int(1, 2)),
	item: s.draw(int(0, 1)),
	completed: s.draw(boolean),
	removes: s.draw(element(["snapshot", "suspension", "enrolment", "processing"] as const))
})

/** A case: its transactions, each committed before the next. */
export interface ExactCase {
	readonly steps: ReadonlyArray<Step>
}

export const exactCase: Gen<ExactCase> = (s) => ({
	steps: s.draw(array(stepGen, { min: 4, max: 24 }))
})

/** What a case reached: each kind of write that changes a stored relation's rows; a suspension of a session that holds
 * snapshots, whose open snapshots its upkeep withdraws and checks at the fact, each still derived by the suspension's
 * rule; and each data step's removal. */
export type ExactFeature =
	| "a snapshot in an open session"
	| "a session suspended over its snapshots"
	| "a sitting ended over its snapshots"
	| "an item session under a control"
	| "an ended sitting settled"
	| "a settled sitting unsettled"
	| "an enrolled learner's snapshot"
	| "a snapshot removed"
	| "a suspension removed"
	| "a suspension removed beneath an end in its session"
	| "a sitting's last pending attempt processed"
	| "a session's counted attempts reaching its limit"
	| "an enrolment removed"
	| "a processing removed"

/** The host's model: the learner's rows as written, each its fields, and the case's clock. */
interface Model {
	readonly sittings: Array<{ readonly child: number; readonly stage: number }>
	readonly controls: Array<{ readonly child: number; readonly stage: number }>
	readonly visits: Array<{
		readonly child: number
		readonly stage: number
		readonly k: number
		readonly at: number
	}>
	readonly suspensions: Array<{
		readonly child: number
		readonly stage: number
		readonly k: number
		readonly at: number
	}>
	readonly ends: Array<{
		readonly child: number
		readonly stage: number
		readonly k: number
		readonly at: number
	}>
	readonly sessions: Array<{
		readonly child: number
		readonly item: number
		readonly n: number
		readonly stage: number
	}>
	readonly snapshots: Array<{
		readonly child: number
		readonly item: number
		readonly n: number
		readonly at: number
	}>
	readonly attempts: Array<{
		readonly child: number
		readonly item: number
		readonly n: number
		readonly at: number
	}>
	readonly processed: Array<{
		readonly child: number
		readonly item: number
		readonly n: number
		readonly at: number
		readonly completed: boolean
	}>
	readonly assertions: Array<{
		readonly child: number
		readonly item: number
		readonly n: number
		readonly at: number
	}>
	readonly enrolled: Set<number>
	/** Each snapshot's value of item 1's uncounting variable, an attempt's response at its instant. */
	readonly booleans: Array<{
		readonly child: number
		readonly item: number
		readonly n: number
		readonly at: number
		readonly value: boolean
	}>
}

const sorted = (rows: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(rows), Order.String)

/** Each stored relation's rows as the model states them, each its record text in the column order `storedRows` reads:
 * each definition read over the model. */
const modelRows = (m: Model) => {
	const sessionOf = (child: number, item: number, n: number) =>
		Option.getOrUndefined(
			Arr.findFirst(m.sessions, (s) => s.child === child && s.item === item && s.n === n)
		)
	const sits = (child: number, stage: number) =>
		Arr.some(m.sittings, (s) => s.child === child && s.stage === stage)
	const testSnapshots = Arr.flatMap(m.snapshots, (s) => {
		const session = sessionOf(s.child, s.item, s.n)
		return session !== undefined && sits(s.child, session.stage)
			? [{ ...s, stage: session.stage }]
			: []
	})
	const sessionSnapshots = Arr.flatMap(testSnapshots, (t) =>
		Arr.flatMap(m.visits, (visit) => {
			if (visit.child !== t.child || visit.stage !== t.stage || visit.at > t.at) {
				return []
			}
			const suspension = Option.getOrUndefined(
				Arr.findFirst(
					m.suspensions,
					(s) => s.child === t.child && s.stage === t.stage && s.k === visit.k
				)
			)
			const end = Option.getOrUndefined(
				Arr.findFirst(m.ends, (e) => e.child === t.child && e.stage === t.stage)
			)
			const open = suspension === undefined && end === undefined
			const suspended = suspension !== undefined && t.at <= suspension.at
			const ended = end !== undefined && end.k === visit.k && t.at <= end.at
			return open || suspended || ended
				? [`(${t.child},${t.stage},${visit.k},1,${t.item},${t.n},${t.at},${visit.at})`]
				: []
		})
	)
	const controls = Arr.flatMap(m.sessions, (s) => [
		...(sits(s.child, s.stage)
			? [`(${s.child},1,${s.item},${s.n},${memberTries.get(s.item)})`]
			: []),
		...(Arr.some(m.controls, (c) => c.child === s.child && c.stage === s.stage)
			? [`(${s.child},1,${s.item},${s.n},3)`]
			: [])
	])
	const stageOf = (child: number, item: number, n: number) => sessionOf(child, item, n)?.stage
	const pendingAt = (child: number, stage: number) =>
		Arr.some(
			m.attempts,
			(a) =>
				a.child === child &&
				stageOf(a.child, a.item, a.n) === stage &&
				!Arr.some(
					m.processed,
					(p) => p.child === a.child && p.item === a.item && p.n === a.n && p.at === a.at
				)
		) ||
		Arr.some(
			m.processed,
			(p) =>
				p.child === child &&
				stageOf(p.child, p.item, p.n) === stage &&
				externallyScored.has(p.item) &&
				!Arr.some(
					m.assertions,
					(a) => a.child === p.child && a.item === p.item && a.n === p.n && a.at === p.at
				)
		)
	const pendingSittings = Arr.flatMap([...m.attempts, ...m.processed], (a) => {
		const stage = stageOf(a.child, a.item, a.n)
		return stage !== undefined && pendingAt(a.child, stage) ? [`(${a.child},${stage})`] : []
	})
	const open = Arr.flatMap(m.sessions, (s) => {
		const ended = Arr.some(m.ends, (e) => e.child === s.child && e.stage === s.stage)
		const adaptive = s.item === 0
		const of = <T extends { readonly child: number; readonly item: number; readonly n: number }>(
			rows: ReadonlyArray<T>
		) => Arr.filter(rows, (r) => r.child === s.child && r.item === s.item && r.n === s.n)
		const completedIt = adaptive && Arr.some(of(m.processed), (p) => p.completed)
		const made = Arr.filter(
			of(m.attempts),
			(a) =>
				!(uncountingItems.has(a.item) && Arr.some(of(m.booleans), (b) => b.at === a.at && b.value))
		).length
		const limits = [
			memberTries.get(s.item) ?? 0,
			...(Arr.some(m.controls, (c) => c.child === s.child && c.stage === s.stage) ? [3] : [])
		]
		const takes =
			!ended &&
			(adaptive
				? !completedIt
				: Arr.some(limits, (t) => t === 0) || made === 0 || Arr.some(limits, (t) => made < t))
		return takes ? [`(${s.child},1,${s.item},${s.n})`] : []
	})
	return {
		TestSnapshot: sorted(
			Arr.map(testSnapshots, (t) => `(${t.child},1,${t.item},${t.n},${t.at},${t.stage})`)
		),
		UnsettledSitting: sorted(pendingSittings),
		ItemSessionOpen: sorted(open),
		SessionSnapshot: sorted(sessionSnapshots),
		ItemSessionControl: sorted(controls),
		SettledSitting: sorted(
			Arr.flatMap(m.ends, (e) => (pendingAt(e.child, e.stage) ? [] : [`(${e.child},${e.stage})`]))
		),
		EnrolledSnapshot: sorted(
			Arr.flatMap(m.snapshots, (s) =>
				m.enrolled.has(s.child) ? [`(${s.child},1,${s.item},${s.n},${s.at})`] : []
			)
		)
	}
}

/** Each stored relation's table's rows, each its record text, sorted. */
const storedRows = (installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const read = (sql: string) =>
			Effect.map(session.values(sql, []), (rows) => sorted(Arr.map(rows, (row) => String(row[0]))))
		return {
			TestSnapshot: yield* read(
				`SELECT ROW(child, package, item, n, at, stage)::text FROM ${names.table(TestSnapshot)}`
			),
			SessionSnapshot: yield* read(
				`SELECT ROW(child, stage, k, package, item, n, at, began)::text FROM ${names.table(SessionSnapshot)}`
			),
			ItemSessionControl: yield* read(
				`SELECT ROW(child, package, item, n, tries)::text FROM ${names.table(ItemSessionControl)}`
			),
			SettledSitting: yield* read(
				`SELECT ROW(child, stage)::text FROM ${names.table(SettledSitting)}`
			),
			EnrolledSnapshot: yield* read(
				`SELECT ROW(child, package, item, n, at)::text FROM ${names.table(EnrolledSnapshot)}`
			),
			UnsettledSitting: yield* read(
				`SELECT ROW(child, stage)::text FROM ${names.table(UnsettledSitting)}`
			),
			ItemSessionOpen: yield* read(
				`SELECT ROW(child, package, item, n)::text FROM ${names.table(ItemSessionOpen)}`
			)
		}
	})

/**
 * One case on a fresh clone, as the owner's direct SQL: the package founded, then each step committed as one
 * transaction with what it names (`Step`), the rule judge running at its COMMIT, and after each, every stored relation's
 * table holding exactly the rows the model's definitions give. A served write inserts alone, every relation closed; a
 * removal is a migration's data step, which lifts the guards and deletes, the upkeep's lost forms and the monotone
 * form's re-derivation of the units it touched judged at its COMMIT.
 */
export const runExact = (
	installed: Installed,
	session: RawSession,
	c: ExactCase,
	reached: Case<ExactFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		yield* standUpJudge(session, installed.installation)
		yield* committedJudged(session, contentSql(installed))
		const m: Model = {
			sittings: [],
			controls: [],
			visits: [],
			suspensions: [],
			ends: [],
			sessions: [],
			snapshots: [],
			attempts: [],
			processed: [],
			assertions: [],
			enrolled: new Set(),
			booleans: []
		}
		for (const [i, step] of c.steps.entries()) {
			const at = i + 1
			const before = modelRows(m)
			const sql: Array<string> = []
			const { child, stage, k, item } = step
			/** The sitting at the stage, written where none stands. */
			const sit = (): void => {
				if (!Arr.some(m.sittings, (s) => s.child === child && s.stage === stage)) {
					sql.push(
						`INSERT INTO ${names.table(TestSession)} (child, stage, package, test) VALUES (${child}, ${stage}, 1, 1)`
					)
					m.sittings.push({ child, stage })
				}
			}
			/** The sitting's candidate session `of`, begun where it was not. */
			const visit = (of: number): void => {
				sit()
				if (!Arr.some(m.visits, (s) => s.child === child && s.stage === stage && s.k === of)) {
					sql.push(
						`INSERT INTO ${names.table(TestVisit)} (child, stage, k, at) VALUES (${child}, ${stage}, ${of}, ${at})`
					)
					m.visits.push({ child, stage, k: of, at })
				}
			}
			/** Another item session of the item in the sitting. */
			const open = (): number => {
				sit()
				const n =
					Option.getOrElse(
						Option.map(
							Arr.findLast(m.sessions, (s) => s.child === child && s.item === item),
							(s) => s.n
						),
						() => 0
					) + 1
				sql.push(
					`INSERT INTO ${names.table(ItemSession)} (child, package, item, n, stage) VALUES (${child}, 1, ${item}, ${n}, ${stage})`
				)
				m.sessions.push({ child, item, n, stage })
				return n
			}
			/** The learner's last item session of the item in the sitting, opened where none stands. */
			const itemSession = (): number =>
				Option.getOrElse(
					Option.map(
						Arr.findLast(
							m.sessions,
							(s) => s.child === child && s.item === item && s.stage === stage
						),
						(s) => s.n
					),
					open
				)
			/** An attempt of that item session, at the instant. */
			const attempt = (): { readonly n: number } => {
				const n = itemSession()
				sql.push(
					`INSERT INTO ${names.table(Attempt)} (child, package, item, n, at) VALUES (${child}, 1, ${item}, ${n}, ${at})`
				)
				m.attempts.push({ child, item, n, at })
				if (uncountingItems.has(item)) {
					sql.push(
						`INSERT INTO ${names.table(ResponseSnapshot)} (child, package, item, n, at) VALUES (${child}, 1, ${item}, ${n}, ${at})`,
						`INSERT INTO ${names.table(SnapshotBoolean)} (child, package, item, n, at, variable, value) VALUES (${child}, 1, ${item}, ${n}, ${at}, 0, ${step.completed})`
					)
					m.snapshots.push({ child, item, n, at })
					m.booleans.push({ child, item, n, at, value: step.completed })
				}
				return { n }
			}
			/** Whether the model's processings hold the attempt `a`'s. */
			const processedAt = (a: { readonly n: number; readonly at: number }) =>
				Arr.some(
					m.processed,
					(p) => p.child === child && p.item === item && p.n === a.n && p.at === a.at
				)
			/** The last unprocessed attempt of the item in the sitting processed, one attempted where none stands. */
			const process = (completed: boolean): { readonly n: number; readonly at: number } => {
				const a = Option.getOrElse(
					Arr.findLast(
						m.attempts,
						(x) =>
							x.child === child &&
							x.item === item &&
							Arr.some(
								m.sessions,
								(s) => s.child === child && s.item === item && s.n === x.n && s.stage === stage
							) &&
							!processedAt(x)
					),
					() => ({ ...attempt(), at })
				)
				sql.push(
					`INSERT INTO ${names.table(Processed)} (child, package, item, n, at, completed) VALUES (${child}, 1, ${item}, ${a.n}, ${a.at}, ${completed})`
				)
				m.processed.push({ child, item, n: a.n, at: a.at, completed })
				return a
			}
			switch (step.kind) {
				case "visit":
					visit(k)
					break
				case "control":
					sit()
					if (!Arr.some(m.controls, (s) => s.child === child && s.stage === stage)) {
						sql.push(
							`INSERT INTO ${names.table(StageControl)} (child, stage, tries) VALUES (${child}, ${stage}, 3)`
						)
						m.controls.push({ child, stage })
					}
					break
				case "open":
					open()
					break
				case "snapshot": {
					visit(1)
					const n = itemSession()
					sql.push(
						`INSERT INTO ${names.table(ResponseSnapshot)} (child, package, item, n, at) VALUES (${child}, 1, ${item}, ${n}, ${at})`
					)
					m.snapshots.push({ child, item, n, at })
					break
				}
				case "suspend":
					visit(k)
					if (
						!Arr.some(m.suspensions, (s) => s.child === child && s.stage === stage && s.k === k)
					) {
						sql.push(
							`INSERT INTO ${names.table(TestSuspension)} (child, stage, k, at) VALUES (${child}, ${stage}, ${k}, ${at})`
						)
						m.suspensions.push({ child, stage, k, at })
					}
					break
				case "end": {
					const last = Arr.reduce(m.visits, 0, (most, x) =>
						x.child === child && x.stage === stage ? Math.max(most, x.k) : most
					)
					const of = last === 0 ? k : last
					visit(of)
					if (!Arr.some(m.ends, (s) => s.child === child && s.stage === stage)) {
						sql.push(
							`INSERT INTO ${names.table(TestEnd)} (child, stage, k, at) VALUES (${child}, ${stage}, ${of}, ${at})`
						)
						m.ends.push({ child, stage, k: of, at })
					}
					break
				}
				case "attempt":
					attempt()
					break
				case "process":
					process(step.completed)
					break
				case "score": {
					/** Whether no assertion scores the attempt `a` of item 1. */
					const unasserted = (a: { readonly n: number; readonly at: number }) =>
						!Arr.some(
							m.assertions,
							(x) => x.child === child && x.item === 1 && x.n === a.n && x.at === a.at
						)
					const scored = Option.getOrElse(
						Arr.findLast(m.processed, (p) => p.child === child && p.item === 1 && unasserted(p)),
						() => (item === 1 ? process(false) : undefined)
					)
					if (scored !== undefined && unasserted(scored)) {
						sql.push(
							`INSERT INTO ${names.table(OutcomeAssertion)} (child, package, item, n, at, variable) VALUES (${child}, 1, 1, ${scored.n}, ${scored.at}, 0)`
						)
						m.assertions.push({ child, item: 1, n: scored.n, at: scored.at })
					}
					break
				}
				case "enrol":
					if (!m.enrolled.has(child)) {
						sql.push(`INSERT INTO ${names.table(Enrolled)} (child) VALUES (${child})`)
						m.enrolled.add(child)
					}
					break
				case "remove": {
					const removed = removal(installed, m, step)
					if (removed === undefined) {
						continue
					}
					yield* committedJudged(session, asDataStep(installed.installation, [removed.sql]))
					removed.apply()
					reached.note(removed.feature)
					break
				}
			}
			if (step.kind !== "remove") {
				if (sql.length === 0) {
					continue
				}
				yield* committedJudged(session, sql)
			}
			const after = modelRows(m)
			noteChanges(before, after, step, reached)
			const stored = yield* storedRows(installed, session)
			assert.deepEqual(
				stored,
				after,
				`after step ${i} of ${Formatter.format(c.steps)}, each stored relation holds its definition's rows over the model`
			)
		}
	})

/** What a step changed of the stored relations' rows, as the features it reached (`ExactFeature`). */
const noteChanges = (
	before: ReturnType<typeof modelRows>,
	after: ReturnType<typeof modelRows>,
	step: Step,
	reached: Case<ExactFeature>
): void => {
	const gained = (rows: (r: typeof before) => ReadonlyArray<string>) =>
		Arr.some(rows(after), (r) => !rows(before).includes(r))
	const lost = (rows: (r: typeof before) => ReadonlyArray<string>) =>
		Arr.some(rows(before), (r) => !rows(after).includes(r))
	if (step.kind === "snapshot" && gained((r) => r.SessionSnapshot)) {
		reached.note("a snapshot in an open session")
	}
	if (
		step.kind === "suspend" &&
		Arr.some(before.SessionSnapshot, Str.startsWith(`(${step.child},${step.stage},${step.k},`))
	) {
		reached.note("a session suspended over its snapshots")
	}
	if (step.kind === "end" && lost((r) => r.SessionSnapshot)) {
		reached.note("a sitting ended over its snapshots")
	}
	if (
		Arr.some(
			after.ItemSessionControl,
			(r) => Str.endsWith(",3)")(r) && !before.ItemSessionControl.includes(r)
		)
	) {
		reached.note("an item session under a control")
	}
	if (gained((r) => r.SettledSitting)) {
		reached.note("an ended sitting settled")
	}
	if (lost((r) => r.SettledSitting)) {
		reached.note("a settled sitting unsettled")
	}
	if (step.kind === "process" && lost((r) => r.UnsettledSitting)) {
		reached.note("a sitting's last pending attempt processed")
	}
	if (step.kind === "attempt" && lost((r) => r.ItemSessionOpen)) {
		reached.note("a session's counted attempts reaching its limit")
	}
	if (step.kind === "snapshot" && gained((r) => r.EnrolledSnapshot)) {
		reached.note("an enrolled learner's snapshot")
	}
}

/** A removal's data step: the relation it deletes from, its DELETE, its change to the model and its feature; none where
 * the row it names stands nowhere. */
const removal = (
	installed: Installed,
	m: Model,
	step: Step
):
	| {
			readonly relation: string
			readonly sql: string
			readonly apply: () => void
			readonly feature: ExactFeature
	  }
	| undefined => {
	const names = namesOf(installed)
	const drop =
		<T>(rows: Array<T>, row: T) =>
		() => {
			rows.splice(rows.indexOf(row), 1)
		}
	switch (step.removes) {
		case "snapshot": {
			const row = Option.getOrUndefined(
				Arr.findLast(
					m.snapshots,
					(s) =>
						s.child === step.child &&
						!Arr.some(
							m.booleans,
							(b) => b.child === s.child && b.item === s.item && b.n === s.n && b.at === s.at
						)
				)
			)
			return row === undefined
				? undefined
				: {
						relation: "ResponseSnapshot",
						sql: `DELETE FROM ${names.table(ResponseSnapshot)} WHERE child = ${row.child} AND package = 1 AND item = ${row.item} AND n = ${row.n} AND at = ${row.at}`,
						apply: drop(m.snapshots, row),
						feature: "a snapshot removed"
					}
		}
		case "suspension": {
			/** Whether the sitting of `x` ended in its session. */
			const endedIn = (x: { readonly child: number; readonly stage: number; readonly k: number }) =>
				Arr.some(m.ends, (e) => e.child === x.child && e.stage === x.stage && e.k === x.k)
			const ofChild = Arr.filter(m.suspensions, (x) => x.child === step.child)
			const row = Option.getOrUndefined(
				Option.orElse(Arr.findLast(ofChild, endedIn), () => Arr.last(ofChild))
			)
			return row === undefined
				? undefined
				: {
						relation: "TestSuspension",
						sql: `DELETE FROM ${names.table(TestSuspension)} WHERE child = ${row.child} AND stage = ${row.stage} AND k = ${row.k}`,
						apply: drop(m.suspensions, row),
						feature: endedIn(row)
							? "a suspension removed beneath an end in its session"
							: "a suspension removed"
					}
		}
		case "enrolment":
			return m.enrolled.has(step.child)
				? {
						relation: "Enrolled",
						sql: `DELETE FROM ${names.table(Enrolled)} WHERE child = ${step.child}`,
						apply: () => {
							m.enrolled.delete(step.child)
						},
						feature: "an enrolment removed"
					}
				: undefined
		case "processing": {
			const row = Option.getOrUndefined(
				Arr.findLast(m.processed, (p) => p.child === step.child && p.item === step.item)
			)
			return row === undefined
				? undefined
				: {
						relation: "Processed",
						sql: `DELETE FROM ${names.table(Processed)} WHERE child = ${row.child} AND package = 1 AND item = ${row.item} AND n = ${row.n} AND at = ${row.at}`,
						apply: drop(m.processed, row),
						feature: "a processing removed"
					}
		}
	}
}

/**
 * A bound case: learner 1's measured sitting, stage 1, its candidate session 1 begun, its item sessions of both items
 * and `few` snapshots of item 1's, and its ended and settled sitting, stage 2, learner 1 enrolled, and learner 0's the
 * same, unenrolled; beside `background` other learners, each a sitting of its own with a visit, an item session, a
 * snapshot and a processed attempt, none for tables of a page and 2,048 for tables of many; then `more` other learners
 * so, and `more` other sittings of learners 1 and 0 each, each begun, with an item session, two snapshots, a processed
 * and scored attempt and its end, before the second measure.
 */
export interface BoundCase {
	readonly background: 0 | 2048
	readonly few: 1 | 4
	readonly more: 16 | 64
}

export const boundGen: Gen<BoundCase> = (s) => ({
	background: s.draw(element([0, 2048] as const)),
	few: s.draw(element([1, 4] as const)),
	more: s.draw(element([16, 64] as const))
})

/** The writes a bound case measures, each learner 1's at its measured sittings, each one transaction rolled back. */
export type Write =
	| "snapshot"
	| "suspension"
	| "end"
	| "item session"
	| "attempt in an ended sitting"
	| "attempt in an open sitting"
	| "processing of a pending attempt"

const writes: ReadonlyArray<Write> = [
	"snapshot",
	"suspension",
	"end",
	"item session",
	"attempt in an ended sitting",
	"attempt in an open sitting",
	"processing of a pending attempt"
]

export type BoundFeature =
	| `${"TestSnapshot" | "SessionSnapshot" | "ItemSessionControl" | "SettledSitting" | "UnsettledSitting" | "ItemSessionOpen" | "EnrolledSnapshot"}'s upkeep ran`
	| "tables of a page"
	| "tables of many pages"

/** The instant every measured write stands at, after every row a case writes. */
const measuredAt = 1_000_000

/** The SQL of `write` (`Write`), learner 1's, each a served write. A data step's removal is no write the judge's bound
 * covers: no capture records a closed relation's removed rows, and its bracket's re-check reads what it reads whole. */
const writeSql = (installed: Installed, write: Write): ReadonlyArray<string> => {
	const names = namesOf(installed)
	switch (write) {
		case "snapshot":
			return [
				`INSERT INTO ${names.table(ResponseSnapshot)} (child, package, item, n, at) VALUES (1, 1, 1, 1, ${measuredAt})`
			]
		case "suspension":
			return [
				`INSERT INTO ${names.table(TestSuspension)} (child, stage, k, at) VALUES (1, 1, 1, ${measuredAt})`
			]
		case "end":
			return [
				`INSERT INTO ${names.table(TestEnd)} (child, stage, k, at) VALUES (1, 1, 1, ${measuredAt})`
			]
		case "item session":
			return [
				`INSERT INTO ${names.table(ItemSession)} (child, package, item, n, stage) VALUES (1, 1, 1, 2, 1)`
			]
		case "attempt in an ended sitting":
			return [
				`INSERT INTO ${names.table(Attempt)} (child, package, item, n, at) VALUES (1, 1, 0, 2, ${measuredAt})`
			]
		case "attempt in an open sitting":
			return [
				`INSERT INTO ${names.table(Attempt)} (child, package, item, n, at) VALUES (1, 1, 1, 1, ${measuredAt})`
			]
		case "processing of a pending attempt":
			return [
				`INSERT INTO ${names.table(Processed)} (child, package, item, n, at, completed) VALUES (1, 1, 1, 1, 50, false)`
			]
	}
}

/**
 * The SQL of sittings of each learner of `children` at each stage of `stages`, each begun at instant 1, with an item
 * session of item 1 numbered by its stage plus `offset`, `snapshots` snapshots of it at instants 2 on, and an attempt at
 * instant 2, processed, and, where `ended`, the sitting ended at instant 100; each range inclusive, set-based.
 */
const sittingsSql = (
	installed: Installed,
	children: readonly [number, number],
	stages: readonly [number, number],
	offset: number,
	snapshots: number,
	ended: boolean
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const series = `FROM generate_series(${children[0]}, ${children[1]}) AS c(child), generate_series(${stages[0]}, ${stages[1]}) AS s(stage)`
	return [
		`INSERT INTO ${names.table(TestSession)} (child, stage, package, test) SELECT child, stage, 1, 1 ${series}`,
		`INSERT INTO ${names.table(TestVisit)} (child, stage, k, at) SELECT child, stage, 1, 1 ${series}`,
		`INSERT INTO ${names.table(ItemSession)} (child, package, item, n, stage) SELECT child, 1, 1, stage + ${offset}, stage ${series}`,
		`INSERT INTO ${names.table(ResponseSnapshot)} (child, package, item, n, at) SELECT child, 1, 1, stage + ${offset}, at ${series}, generate_series(2, ${snapshots + 1}) AS t(at)`,
		`INSERT INTO ${names.table(Attempt)} (child, package, item, n, at) SELECT child, 1, 1, stage + ${offset}, 2 ${series}`,
		`INSERT INTO ${names.table(Processed)} (child, package, item, n, at, completed) SELECT child, 1, 1, stage + ${offset}, 2, false ${series}`,
		`INSERT INTO ${names.table(OutcomeAssertion)} (child, package, item, n, at, variable) SELECT child, 1, 1, stage + ${offset}, 2, 0 ${series}`,
		`INSERT INTO ${names.table(Attempt)} (child, package, item, n, at) SELECT child, 1, 1, stage + ${offset}, 3 ${series}`,
		...(ended
			? [
					`INSERT INTO ${names.table(TestEnd)} (child, stage, k, at) SELECT child, stage, 1, 100 ${series}`
				]
			: [])
	]
}

/**
 * The judge's work at COMMIT of `write`, measured on `session` in a transaction rolled back, before the judge reads its
 * deltas (test/support/judge.ts judgeRun): each statement it runs over them, as phase A runs them, explained with
 * ANALYZE and BUFFERS.
 */
const writeWork = (installed: Installed, session: RawSession, write: Write) =>
	Effect.gen(function* () {
		yield* session.begin
		const work = yield* Effect.onError(
			Effect.gen(function* () {
				for (const sql of writeSql(installed, write)) {
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

/** A statement of the judge, named: an upkeep's write by its relation, a rule's test by its kind. */
const named = (statement: JudgeStatement): string => {
	switch (statement.kind) {
		case "upkeep":
			return `the ${statement.statement.kind} of ${statement.relation}'s upkeep`
		case "rule":
			return "a rule's test"
	}
}

/** Each statement measured, named, with its work (test/support/judge.ts scannedWork). */
const measured = (plans: ReadonlyArray<JudgePlan<JudgeStatement>>) =>
	Arr.map(plans, (p) => ({
		statement: named(p.statement),
		rows: scannedWork(p.plan)
	}))

/**
 * One bound case on a fresh clone, in one session: the content founded, the background, learner 1's enrolment, the
 * measured sittings of learners 1 and 0 at stage 1 and their ended sittings at stage 2 committed, and the judge's work
 * at each write of `writes` measured (`writeWork`); then `more` other learners and `more` other sittings of learners 1
 * and 0 committed, and the work measured again, each statement under its routine's own advice (test/support/judge.ts
 * judgeRun). Its work is the same both times: a write's upkeep reads the rows it wrote outward, each stored relation beneath it by an index of its own at the keys the rows bind, the sitting's snapshots at a
 * suspension or an end, and each fact it withdraws at the fact or from its own table at the fields the fact's candidate
 * binds, a removed snapshot's facts at the snapshot; never another sitting of the learner or another learner's.
 */
export const runBound = (
	installed: Installed,
	session: RawSession,
	d: BoundCase,
	c: Case<BoundFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		yield* standUpJudge(session, installed.installation)
		yield* committedJudged(session, contentSql(installed))
		yield* committedJudged(session, [
			...(d.background > 0
				? sittingsSql(installed, [2, d.background + 1], [1, 1], 0, 1, false)
				: []),
			`INSERT INTO ${names.table(Enrolled)} (child) VALUES (1)`,
			`INSERT INTO ${names.table(TestSession)} (child, stage, package, test) SELECT child, stage, 1, 1 FROM generate_series(0, 1) AS c(child), generate_series(1, 2) AS s(stage)`,
			`INSERT INTO ${names.table(TestVisit)} (child, stage, k, at) SELECT child, stage, 1, 1 FROM generate_series(0, 1) AS c(child), generate_series(1, 2) AS s(stage)`,
			`INSERT INTO ${names.table(ItemSession)} (child, package, item, n, stage) SELECT child, 1, item, n, stage FROM generate_series(0, 1) AS c(child), (VALUES (0, 1, 1), (1, 1, 1), (0, 2, 2)) AS i(item, n, stage)`,
			`INSERT INTO ${names.table(ResponseSnapshot)} (child, package, item, n, at) SELECT child, 1, 1, 1, at FROM generate_series(0, 1) AS c(child), generate_series(2, ${d.few + 1}) AS t(at)`,
			`INSERT INTO ${names.table(Attempt)} (child, package, item, n, at) SELECT child, 1, 0, 2, 2 FROM generate_series(0, 1) AS c(child)`,
			`INSERT INTO ${names.table(Processed)} (child, package, item, n, at, completed) SELECT child, 1, 0, 2, 2, true FROM generate_series(0, 1) AS c(child)`,
			`INSERT INTO ${names.table(Attempt)} (child, package, item, n, at) SELECT child, 1, 1, 1, 50 FROM generate_series(0, 1) AS c(child)`,
			`INSERT INTO ${names.table(TestEnd)} (child, stage, k, at) SELECT child, 2, 1, 100 FROM generate_series(0, 1) AS c(child)`
		])
		const measure = () =>
			Effect.forEach(writes, (write) =>
				Effect.map(writeWork(installed, session, write), (plans) => ({
					write,
					plans,
					work: measured(plans)
				}))
			)
		const few = yield* measure()
		const first = d.background + 2
		yield* committedJudged(session, [
			...sittingsSql(installed, [first, first + d.more - 1], [1, 1], 0, 1, false),
			...sittingsSql(installed, [0, 1], [3, d.more + 2], 100, 2, true)
		])
		const many = yield* measure()
		assert.deepEqual(
			Arr.map(many, (w) => ({ write: w.write, work: w.work })),
			Arr.map(few, (w) => ({ write: w.write, work: w.work })),
			`${Formatter.format(d)}: each statement the judge runs at each measured write does the same work beside ${d.background} other learners and the measured learner's two sittings and beside ${d.background + d.more} and ${d.more + 2}`
		)
		c.note(d.background === 0 ? "tables of a page" : "tables of many pages")
		for (const relation of [
			"TestSnapshot",
			"SessionSnapshot",
			"ItemSessionControl",
			"SettledSitting",
			"UnsettledSitting",
			"ItemSessionOpen",
			"EnrolledSnapshot"
		] as const) {
			if (
				Arr.some(few, (w) =>
					Arr.some(
						w.plans,
						(p) => p.statement.kind === "upkeep" && p.statement.relation === relation
					)
				)
			) {
				c.note(`${relation}'s upkeep ran`)
			}
		}
	})
