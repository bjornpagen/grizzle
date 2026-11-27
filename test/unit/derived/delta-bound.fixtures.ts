/**
 * What the property of delta-bound.test.ts reads: a learner's sittings, item sessions and response snapshots, keyed by
 * the learner and then apart, beside a package's tests and items in a unit sealed at founding; its definitions, the
 * holding the rule restated gives each, and what the installation infers and keeps of each.
 */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { UncheckedDelta } from "#compiler/core/causes.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { Type } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	sealed,
	unit
} from "#compiler/public/schema.ts"

const childKey = Symbol("Child")
/** A learner, by a number of its own type, so no package's number leads a learner's key. */
const Child = contract<typeof childKey>()("Child", pg.integer)
const packageNoKey = Symbol("PackageNo")
/** A package, by a number of its own type. */
const PackageNo = contract<typeof packageNoKey>()("PackageNo", pg.integer)

/** A package's test. */
const Test = relation("Test", { package: PackageNo, test: pg.integer }, ["package", "test"])
/** A package's item, adaptive or not. */
const Item = relation("Item", { package: PackageNo, item: pg.integer, adaptive: pg.boolean }, [
	"package",
	"item"
])
/** An item's control in a test, as its test's scopes state it: ledger's MemberControl, stored at publication. */
const MemberControl = relation(
	"MemberControl",
	{ package: PackageNo, test: pg.integer, item: pg.integer, maxAttempts: pg.bigint },
	["package", "test", "item"]
)
/** A learner's sitting of a test, by its stage, the learner's own number of it. */
const TestSession = relation(
	"TestSession",
	{ child: Child, stage: pg.integer, package: PackageNo, test: pg.integer },
	["child", "stage"]
)
/** A learner's item session, numbered under its item, in the sitting of its stage. */
const ItemSession = relation(
	"ItemSession",
	{ child: Child, package: PackageNo, item: pg.integer, n: pg.integer, stage: pg.integer },
	["child", "package", "item", "n"]
)
/** A response snapshot of an item session, at its instant. */
const ResponseSnapshot = relation(
	"ResponseSnapshot",
	{ child: Child, package: PackageNo, item: pg.integer, n: pg.integer, at: pg.integer },
	["child", "package", "item", "n", "at"]
)
/** A sitting's candidate session k, begun at its instant. */
const TestVisit = relation(
	"TestVisit",
	{ child: Child, stage: pg.integer, k: pg.integer, at: pg.integer },
	["child", "stage", "k"]
)
/** A sitting's candidate session k as the application holds it, open: a served write moves its instant or deletes it. */
const Visit = relation(
	"Visit",
	{ child: Child, stage: pg.integer, k: pg.integer, at: pg.integer },
	["child", "stage", "k"]
)
/** The suspension that ended a sitting's candidate session k, at its instant. */
const TestSuspension = relation(
	"TestSuspension",
	{ child: Child, stage: pg.integer, k: pg.integer, at: pg.integer },
	["child", "stage", "k"]
)
/** A sitting's end, in its candidate session k, at its instant. */
const TestEnd = relation(
	"TestEnd",
	{ child: Child, stage: pg.integer, k: pg.integer, at: pg.integer },
	["child", "stage"]
)
/** An item stage's control, which the application's decision states: ledger's StageControl. */
const StageControl = relation(
	"StageControl",
	{ child: Child, stage: pg.integer, maxAttempts: pg.bigint },
	["child", "stage"]
)
/** An attempt of an item session, at its instant. */
const Attempt = relation(
	"Attempt",
	{ child: Child, package: PackageNo, item: pg.integer, n: pg.integer, at: pg.integer },
	["child", "package", "item", "n", "at"]
)
/** An attempt's processing, run, and whether it left the item session completed: ledger's ProcessedAttempt. */
const Processed = relation(
	"Processed",
	{
		child: Child,
		package: PackageNo,
		item: pg.integer,
		n: pg.integer,
		at: pg.integer,
		completed: pg.boolean
	},
	["child", "package", "item", "n", "at"]
)
/** An item's response variable whose true value counts no attempt, an end-attempt interaction's: ledger's
 * uncountingResponses, content. */
const Uncounting = relation(
	"Uncounting",
	{ package: PackageNo, item: pg.integer, variable: pg.integer },
	["package", "item", "variable"]
)
/** A response snapshot's boolean value of a variable: ledger's SnapshotSingleBoolean. */
const SnapshotBoolean = relation(
	"SnapshotBoolean",
	{
		child: Child,
		package: PackageNo,
		item: pg.integer,
		n: pg.integer,
		at: pg.integer,
		variable: pg.integer,
		value: pg.boolean
	},
	["child", "package", "item", "n", "at", "variable"]
)
/** An item's outcome variable an external scorer sets: ledger's externallyScored, content. */
const ExternalOutcome = relation(
	"ExternalOutcome",
	{ package: PackageNo, item: pg.integer, variable: pg.integer },
	["package", "item", "variable"]
)
/** An external scorer's assertion of an attempt's outcome variable: ledger's OutcomeAssertion. */
const OutcomeAssertion = relation(
	"OutcomeAssertion",
	{
		child: Child,
		package: PackageNo,
		item: pg.integer,
		n: pg.integer,
		at: pg.integer,
		variable: pg.integer
	},
	["child", "package", "item", "n", "at", "variable"]
)
/** A sitting's final evaluation, inserted once it settles: ledger's SittingFinal. */
const SittingFinal = relation("SittingFinal", { child: Child, stage: pg.integer, at: pg.integer }, [
	"child",
	"stage"
])

/** A learner's enrolment, closed. */
const Enrolled = relation("Enrolled", { child: Child }, ["child"])
/** A learner's standing membership, open: a served write deletes it. */
const Membership = relation("Membership", { child: Child, since: pg.integer }, ["child"])

/** The learner's rows and the content, every learner's row naming content its package's founding wrote. */
export const DeltaBase = schema(
	"DeltaBound",
	[
		Test,
		Item,
		MemberControl,
		TestSession,
		ItemSession,
		ResponseSnapshot,
		TestVisit,
		Visit,
		TestSuspension,
		TestEnd,
		StageControl,
		Attempt,
		Processed,
		Uncounting,
		SnapshotBoolean,
		ExternalOutcome,
		OutcomeAssertion,
		SittingFinal,
		Enrolled,
		Membership
	],
	[
		unit("Learner", { child: Child }),
		mutable(Membership),
		mutable(Visit),
		sealed(unit("Package", { package: PackageNo })),
		contained(on(MemberControl, "package", "test"), on(Test, "package", "test")),
		contained(on(MemberControl, "package", "item"), on(Item, "package", "item")),
		contained(on(TestSession, "package", "test"), on(Test, "package", "test")),
		contained(on(ItemSession, "child", "stage"), on(TestSession, "child", "stage")),
		contained(on(ItemSession, "package", "item"), on(Item, "package", "item")),
		contained(
			on(ResponseSnapshot, "child", "package", "item", "n"),
			on(ItemSession, "child", "package", "item", "n")
		),
		contained(on(TestVisit, "child", "stage"), on(TestSession, "child", "stage")),
		contained(on(Visit, "child", "stage"), on(TestSession, "child", "stage")),
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
		contained(on(Uncounting, "package", "item"), on(Item, "package", "item")),
		contained(
			on(SnapshotBoolean, "child", "package", "item", "n", "at"),
			on(ResponseSnapshot, "child", "package", "item", "n", "at")
		),
		contained(on(ExternalOutcome, "package", "item"), on(Item, "package", "item")),
		contained(
			on(OutcomeAssertion, "child", "package", "item", "n", "at"),
			on(Attempt, "child", "package", "item", "n", "at")
		),
		contained(on(SittingFinal, "child", "stage"), on(TestEnd, "child", "stage"))
	]
)

/** Each response snapshot of a sitting's item session, with its stage: ledger's testSnapshots, TestSnapshot's definition. */
export const testSnapshots = query(DeltaBase).rule((r) => {
	const { child, package: p, item, n, at } = v(ResponseSnapshot, "snapshot")
	const { stage } = v(ItemSession, "session")
	return r
		.match(ResponseSnapshot, { at, child, n, package: p, item })
		.match(ItemSession, { child, n, package: p, item, stage })
		.match(TestSession, { child, stage })
		.find({ at, child, n, package: p, item, stage })
})

/** ledger's TestSnapshot. */
export const TestSnapshot = derived("TestSnapshot", testSnapshots)

/** The snapshots' level, where TestSnapshot stands. */
export const DeltaSnapshots = schema.extend([DeltaBase], "DeltaBound_1", [TestSnapshot], [])

/**
 * Each response snapshot of a sitting inside one of its candidate sessions, with that session's k and its beginning:
 * ledger's sessionSnapshots, over `snapshots`, TestSnapshot itself or the query its definition is.
 */
export const sessionSnapshotsOf = (snapshots: typeof TestSnapshot | typeof testSnapshots) =>
	query(DeltaSnapshots)
		.rule((r) => {
			const { child, stage, package: p, item, n, at } = v(snapshots, "open")
			const { k, at: began } = v(TestVisit, "openVisit")
			return r
				.match(snapshots, { at, child, n, package: p, item, stage })
				.match(TestVisit, { at: began, child, k, stage })
				.where(
					r.le(began, at),
					r.not(TestSuspension, { child, k, stage }),
					r.not(TestEnd, { child, stage })
				)
				.find({ at, began, child, k, n, package: p, item, stage })
		})
		.rule((r) => {
			const { child, stage, package: p, item, n, at } = v(snapshots, "suspended")
			const { k, at: began } = v(TestVisit, "suspendedVisit")
			const { at: suspended } = v(TestSuspension, "suspension")
			return r
				.match(snapshots, { at, child, n, package: p, item, stage })
				.match(TestVisit, { at: began, child, k, stage })
				.match(TestSuspension, { at: suspended, child, k, stage })
				.where(r.le(began, at), r.le(at, suspended))
				.find({ at, began, child, k, n, package: p, item, stage })
		})
		.rule((r) => {
			const { child, stage, package: p, item, n, at } = v(snapshots, "ended")
			const { k, at: began } = v(TestVisit, "endedVisit")
			const { at: end } = v(TestEnd, "end")
			return r
				.match(snapshots, { at, child, n, package: p, item, stage })
				.match(TestVisit, { at: began, child, k, stage })
				.match(TestEnd, { at: end, child, k, stage })
				.where(r.le(began, at), r.le(at, end))
				.find({ at, began, child, k, n, package: p, item, stage })
		})

/** Each item session's control, a member's from its test's content, an item stage's from its stage: ledger's
 * ItemSessionControl, MemberControl read by reference. */
const controlsOf = () =>
	query(DeltaSnapshots)
		.rule((r) => {
			const { child, package: p, item, n, stage } = v(ItemSession, "member")
			const { test } = v(TestSession, "sitting")
			const { maxAttempts } = v(MemberControl, "control")
			return r
				.match(ItemSession, { child, n, package: p, item, stage })
				.match(TestSession, { child, package: p, test, stage })
				.match(MemberControl, { item, maxAttempts, package: p, test })
				.find({ child, maxAttempts, n, package: p, item })
		})
		.rule((r) => {
			const { child, package: p, item, n, stage } = v(ItemSession, "staged")
			const { maxAttempts } = v(StageControl, "stageControl")
			return r
				.match(ItemSession, { child, n, package: p, item, stage })
				.match(StageControl, { child, maxAttempts, stage })
				.find({ child, maxAttempts, n, package: p, item })
		})

/** Each attempt not processed, with its item session's stage: ledger's unprocessedAttempts. */
const unprocessedOf = () =>
	query(DeltaSnapshots).rule((r) => {
		const { child, package: p, item, n, at } = v(Attempt, "attempt")
		const { stage } = v(ItemSession, "session")
		return r
			.match(Attempt, { at, child, n, package: p, item })
			.match(ItemSession, { child, n, package: p, item, stage })
			.where(r.not(Processed, { at, child, n, package: p, item }))
			.find({ at, child, n, package: p, item, stage })
	})

/** Each adaptive item session one of whose processed attempts completed it: ledger's completedSessionsOf. */
const completedOf = () =>
	query(DeltaSnapshots).rule((r) => {
		const { child, package: p, item, n } = v(Processed, "completing")
		return r
			.match(Processed, { child, completed: true, n, package: p, item })
			.match(Item, { adaptive: true, package: p, item })
			.find({ child, n, package: p, item })
	})

/** Each attempt that counts, no uncounting response of its snapshot true: ledger's countedAttemptsOf. */
const countedOf = () => {
	const uncounted = query(DeltaSnapshots).rule((r) => {
		const { child, package: p, item, n, at } = v(Attempt, "uncounted")
		const { variable } = v(Uncounting, "uncounting")
		return r
			.match(Attempt, { at, child, n, package: p, item })
			.match(Uncounting, { item, package: p, variable })
			.match(SnapshotBoolean, { at, child, item, n, package: p, value: true, variable })
			.find({ at, child, n, package: p, item })
	})
	return query(DeltaSnapshots).rule((r) => {
		const { child, package: p, item, n, at } = v(Attempt, "counted")
		return r
			.match(Attempt, { at, child, n, package: p, item })
			.where(r.not(uncounted, { at, child, n, package: p, item }))
			.find({ at, child, n, package: p, item })
	})
}

/** Each processed attempt with an externally scored outcome no assertion has scored, with its item session's stage:
 * ledger's unscoredAttempts over pendingExternalScorings. */
const unscoredOf = () => {
	const pending = query(DeltaSnapshots).rule((r) => {
		const { child, package: p, item, n, at } = v(Attempt, "attempt")
		const { variable } = v(ExternalOutcome, "scored")
		return r
			.match(Attempt, { at, child, n, package: p, item })
			.match(ExternalOutcome, { item, package: p, variable })
			.where(r.not(OutcomeAssertion, { at, child, item, n, package: p, variable }))
			.find({ at, child, n, package: p, item, variable })
	})
	return query(DeltaSnapshots).rule((r) => {
		const { child, package: p, item, n, at } = v(Processed, "unscored")
		const { stage } = v(ItemSession, "unscoredSession")
		return r
			.match(Processed, { at, child, n, package: p, item })
			.match(ItemSession, { child, n, package: p, item, stage })
			.match(pending, { at, child, n, package: p, item })
			.find({ at, child, n, package: p, item, stage })
	})
}

/** Each sitting that holds an attempt not final, unprocessed or unscored: ledger's unsettledSittings. */
const unsettledOf = () => {
	const unprocessed = unprocessedOf()
	const unscored = unscoredOf()
	return query(DeltaSnapshots)
		.rule((r) => {
			const { child, stage } = v(unprocessed, "unsettledUnprocessed")
			return r.match(unprocessed, { child, stage }).find({ child, stage })
		})
		.rule((r) => {
			const { child, stage } = v(unscored, "unsettledUnscored")
			return r.match(unscored, { child, stage }).find({ child, stage })
		})
}

/**
 * A definition of the box, each of ledger's in the box's terms, every query it imports under no binding a canonical
 * relation, stored where admission keeps it and then read by its name (analysis/schema.ts storedImport), read in place
 * otherwise:
 *
 * - `snapshots`: TestSnapshot, each response snapshot with its sitting's stage, its relations keyed by the learner and
 *   then apart, so its unit is the learner: stored by its checked delta form, a removed snapshot's stage, which its
 *   row binds no field of, read from the stored table at the snapshot;
 * - `session snapshots`: SessionSnapshot over the stored TestSnapshot, each snapshot inside a candidate session, its
 *   visits, suspensions and end negated and matched by their keys: stored by its checked delta form, a suspension's or
 *   an end's withdrawn snapshots read from TestSnapshot at the sitting, a removed snapshot's facts from the stored
 *   table at the snapshot;
 * - `imported session snapshots`: SessionSnapshot over testSnapshots, the query TestSnapshot's definition is, imported,
 *   whose canonical relation is TestSnapshot's stored table: stored by its checked delta form, as over TestSnapshot;
 * - `controls`: ItemSessionControl, each item session's control, a member's read from the package's content by reference,
 *   an item stage's from its stage: stored by its checked delta form;
 * - `open sessions`: ItemSessionOpen, each item session that takes another attempt, its four rules: adaptive ones until
 *   completed, others under a limit of none, untried ones, and tried ones under their limit, matching the controls and
 *   the counted attempts' counts and negating the completed and the counted ones, each import stored: stored by its
 *   checked delta form, a tried session's control, the controls' canonical relation keyed by its whole heading, read
 *   by a seek at the session and a range of its limit above the counted attempts (analysis/theory/unit.ts StepBy
 *   `seek`);
 * - `settled sittings`: SettledSitting, each ended sitting none of whose attempts is unprocessed or unscored, two stored
 *   imports negated at the sitting: stored by its checked delta form;
 * - `unsettled sittings`: UnsettledSitting, each sitting holding an unprocessed or an unscored attempt, its two rules
 *   each matching a stored import at the sitting, a seek of each, every changed row of either naming its one sitting:
 *   stored by its checked delta form;
 * - `unsettled finals`: UnsettledFinal, each final sitting matched to the unsettled ones, an import of two rules whose
 *   canonical relation, UnsettledSitting's, is stored, so read by its name at its key: stored, its unit bounding it;
 * - `suspended sittings`: each sitting one of whose candidate sessions a suspension ended, the visit and the suspension
 *   joined at the session, an existence test that reads rows: stored at the sitting, its upkeep monotone over closed
 *   relations, its head reaching them by a probe, no seek;
 * - `visited item sessions`: each candidate session of a sitting that holds an item session, a seek of the item sessions
 *   at the sitting whose changed rows name every session of it, by no key: monotone, stored;
 * - `late visits`: each sitting a candidate session numbered above 1 began after instant 100, a range of two columns of
 *   the visits, which no index range serves: stored at the sitting, monotone, by a probe;
 * - `non-member snapshots`: each response snapshot a member snapshot is none of, the member snapshots' query, live for
 *   its open membership, negated: live (`negation`);
 * - `enrolled snapshots`: each response snapshot of an enrolled learner, Enrolled closed, keyed by the learner alone and
 *   matched first, so a removed enrolment's candidate binds the learner alone and no lost fact is read at the fact or at
 *   more than the unit: monotone over closed relations, stored, a data step's removal re-deriving the learners it touched;
 * - `member snapshots`: the same over Membership, open: live (`open`), a served delete of a membership withdrawing the
 *   learner's every snapshot, which no read at the fact finds.
 */
export type Shape =
	| "snapshots"
	| "session snapshots"
	| "imported session snapshots"
	| "controls"
	| "open sessions"
	| "settled sittings"
	| "unsettled sittings"
	| "unsettled finals"
	| "suspended sittings"
	| "visited item sessions"
	| "open visits' item sessions"
	| "late visits"
	| "non-member snapshots"
	| "enrolled snapshots"
	| "member snapshots"

const shapes = [
	"snapshots",
	"session snapshots",
	"imported session snapshots",
	"controls",
	"open sessions",
	"settled sittings",
	"unsettled sittings",
	"unsettled finals",
	"suspended sittings",
	"visited item sessions",
	"open visits' item sessions",
	"late visits",
	"non-member snapshots",
	"enrolled snapshots",
	"member snapshots"
] as const satisfies ReadonlyArray<Shape>

export const shapeGen: Gen<Shape> = (s) => s.draw(element(shapes))

/** The name of the box's derived relation, whose holding a case reads. */
export const derivedName = "Held"

/** The derived relation of `shape`, over the snapshots' level. */
const derivedOf = (shape: Shape) => {
	switch (shape) {
		case "snapshots":
			return derived(derivedName, testSnapshots)
		case "session snapshots":
			return derived(derivedName, sessionSnapshotsOf(TestSnapshot))
		case "imported session snapshots":
			return derived(derivedName, sessionSnapshotsOf(testSnapshots))
		case "controls":
			return derived(derivedName, controlsOf())
		case "open sessions": {
			const controls = controlsOf()
			const completed = completedOf()
			const counted = countedOf()
			const counts = query(DeltaSnapshots).rule((r) => {
				const { child, package: p, item, n, at } = v(counted, "countedAttempt")
				return r
					.match(counted, { at, child, n, package: p, item })
					.find({ child, counted: r.count(), n, package: p, item })
			})
			return derived(
				derivedName,
				query(DeltaSnapshots)
					.rule((r) => {
						const { child, package: p, item, n, stage } = v(ItemSession, "adaptive")
						return r
							.match(ItemSession, { child, n, package: p, item, stage })
							.match(Item, { adaptive: true, package: p, item })
							.where(
								r.not(completed, { child, n, package: p, item }),
								r.not(TestEnd, { child, stage })
							)
							.find({ child, n, package: p, item })
					})
					.rule((r) => {
						const { child, package: p, item, n, stage } = v(ItemSession, "unlimited")
						const { maxAttempts } = v(controls, "noLimit")
						return r
							.match(ItemSession, { child, n, package: p, item, stage })
							.match(controls, { child, maxAttempts, n, package: p, item })
							.where(
								r.eq(maxAttempts, 0n),
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
						const { maxAttempts } = v(controls, "limit")
						return r
							.match(ItemSession, { child, n, package: p, item, stage })
							.match(counts, { child, counted: made, n, package: p, item })
							.match(controls, { child, maxAttempts, n, package: p, item })
							.where(
								r.not(Item, { adaptive: true, package: p, item }),
								r.not(TestEnd, { child, stage }),
								r.lt(Type.base(made), maxAttempts)
							)
							.find({ child, n, package: p, item })
					})
			)
		}
		case "settled sittings": {
			const unprocessed = unprocessedOf()
			const unscored = unscoredOf()
			return derived(
				derivedName,
				query(DeltaSnapshots).rule((r) => {
					const { child, stage } = v(TestEnd, "end")
					return r
						.match(TestEnd, { child, stage })
						.where(r.not(unprocessed, { child, stage }), r.not(unscored, { child, stage }))
						.find({ child, stage })
				})
			)
		}
		case "unsettled sittings":
			return derived(derivedName, unsettledOf())
		case "enrolled snapshots":
			return derived(derivedName, snapshotsOf(Enrolled))
		case "member snapshots":
			return derived(derivedName, snapshotsOf(Membership))
		case "suspended sittings":
			return derived(
				derivedName,
				query(DeltaSnapshots).rule((r) => {
					const { child, stage, k } = v(Visit, "suspendedVisit")
					const { at } = v(TestSuspension, "suspension")
					return r
						.match(Visit, { child, k, stage })
						.match(TestSuspension, { at, child, k, stage })
						.find({ child, stage })
				})
			)
		case "visited item sessions":
			return derived(
				derivedName,
				query(DeltaSnapshots).rule((r) => {
					const { child, stage, k } = v(TestVisit, "visit")
					const { item } = v(ItemSession, "itemSession")
					return r
						.match(TestVisit, { child, k, stage })
						.match(ItemSession, { child, item, stage })
						.find({ child, k, stage })
				})
			)
		case "open visits' item sessions":
			return derived(
				derivedName,
				query(DeltaSnapshots).rule((r) => {
					const { child, stage, k } = v(Visit, "openVisit")
					const { item } = v(ItemSession, "openItemSession")
					return r
						.match(Visit, { child, k, stage })
						.match(ItemSession, { child, item, stage })
						.find({ child, k, stage })
				})
			)
		case "late visits":
			return derived(
				derivedName,
				query(DeltaSnapshots).rule((r) => {
					const { child, stage } = v(TestSession, "sitting")
					const { k, at } = v(Visit, "lateVisit")
					return r
						.match(TestSession, { child, stage })
						.match(Visit, { at, child, k, stage })
						.where(r.gt(k, 1), r.gt(at, 100))
						.find({ child, stage })
				})
			)
		case "non-member snapshots": {
			const members = snapshotsOf(Membership)
			return derived(
				derivedName,
				query(DeltaSnapshots).rule((r) => {
					const { child, package: p, item, n, at } = v(ResponseSnapshot, "snapshot")
					return r
						.match(ResponseSnapshot, { at, child, n, package: p, item })
						.where(r.not(members, { at, child, n, package: p, item }))
						.find({ at, child, n, package: p, item })
				})
			)
		}
		case "unsettled finals": {
			const unsettled = unsettledOf()
			return derived(
				derivedName,
				query(DeltaSnapshots).rule((r) => {
					const { child, stage } = v(SittingFinal, "unsettledFinal")
					return r
						.match(SittingFinal, { child, stage })
						.match(unsettled, { child, stage })
						.find({ child, stage })
				})
			)
		}
	}
}

/**
 * Each response snapshot of a learner `Of` holds, Enrolled or Membership, read by the learner alone and matched first, so
 * the snapshots follow it in the arm's relaxation order (analysis/theory/query.ts relaxation): a removed row of `Of`
 * drops them, its candidate binding the learner alone, the snapshots' other fields free.
 */
const snapshotsOf = (Of: typeof Enrolled | typeof Membership) =>
	query(DeltaSnapshots).rule((r) => {
		const { child, package: p, item, n, at } = v(ResponseSnapshot, "snapshot")
		return r
			.match(Of, { child })
			.match(ResponseSnapshot, { at, child, n, package: p, item })
			.find({ at, child, n, package: p, item })
	})

/** The schema of a case: the base, the snapshots' level, and above it the case's derived relation. */
export const deltaSchemaOf = (shape: Shape) =>
	schema.extend([DeltaSnapshots], "DeltaBoundTop", [derivedOf(shape)], [])

/**
 * Where the installation keeps a case's derived relation: `stored`, its upkeep bound by its unit or by its checked
 * delta form; or `live` for its upkeep, with why its delta form is no checked one; or live for another reason.
 */
export type Holding =
	| {
			readonly kind: "stored"
			readonly bound: "unit" | "delta"
			readonly loss: "checked" | "unit" | "closed" | "none"
	  }
	| { readonly kind: "unbounded"; readonly delta: UncheckedDelta["reason"] }
	| { readonly kind: "other"; readonly what: string }

/**
 * The holding the rule restated gives each shape (analysis/derived/storage.ts boundOf): every shape's unit is the
 * learner, its sittings, item sessions and snapshots keyed apart past it, so no unit bounds its upkeep but those
 * stored at the sitting, the unsettled finals', the suspended sittings' and the late visits', rooted there. The
 * snapshots, the session snapshots in both forms, the controls, the open sessions, the settled sittings, the unsettled
 * sittings and the enrolled snapshots join relations reached from their heads by keys or by seeks whose changed rows
 * name their facts by keys, and negate relations alone, a stored import among them by its name, each fact a write
 * withdraws read at the fact or from the stored table at more than the learner: checked; a removed enrolment, whose
 * candidate is the learner alone, is no write's but a data step's, a closed relation's removed rows read by none
 * (analysis/theory/upkeep.ts sidesOf). The visited item sessions, reached by a seek whose rows name their facts by no
 * key, negate nothing and hold closed relations alone: monotone. A form over closed relations alone that negates none
 * loses no fact to a served write, so its loss is closed (ClosedLoss), a data step's bracket making the table its
 * definition's rows again (physical/ddl/recheck.ts): the snapshots', the controls', the enrolled snapshots' and the
 * visited item sessions'; every other checked one loses facts to a write that adds a negated relation's rows or changes
 * a stored relation's, checked at the fact. The suspended sittings and the late visits, reached by a probe, a join of
 * the open visit and the suspension and a range of two columns of the open visit, and the open visits' item sessions,
 * by a seek whose rows name their facts by no key, hold an open relation, Visit, whose rows a served write removes: the
 * first two, stored at the sitting, keep it by a monotone form whose loss re-derives the units a removal touched (a
 * unit form), a checked form's had any of them been reached by keys; the third, and the member snapshots, are live for
 * it (`open`), stored by its checked form had its seek named its facts by keys. The non-member snapshots negate a live
 * query (`negation`).
 */
export const holdingOf = (shape: Shape): Holding => {
	switch (shape) {
		case "snapshots":
		case "controls":
		case "enrolled snapshots":
		case "visited item sessions":
			return { kind: "stored", bound: "delta", loss: "closed" }
		case "session snapshots":
		case "imported session snapshots":
		case "open sessions":
		case "settled sittings":
		case "unsettled sittings":
			return { kind: "stored", bound: "delta", loss: "checked" }
		case "unsettled finals":
			return { kind: "stored", bound: "unit", loss: "checked" }
		case "suspended sittings":
		case "late visits":
			return { kind: "stored", bound: "unit", loss: "unit" }
		case "member snapshots":
		case "open visits' item sessions":
			return { kind: "unbounded", delta: "open" }
		case "non-member snapshots":
			return { kind: "unbounded", delta: "negation" }
	}
}

/** The holding the compile states (`Holding`). */
export const holdingStated = (artifacts: SchemaArtifacts): Holding => {
	const holding = artifacts.laws.checked.holdings.get(derivedName)
	if (holding?.kind === "stored") {
		const upkeep = Option.getOrUndefined(
			Arr.findFirst(artifacts.laws.theory.upkeeps, (u) => u.relation === derivedName)
		)
		return {
			kind: "stored",
			bound: holding.bound,
			loss: upkeep?.form.kind === "delta" ? upkeep.form.lost.kind : "none"
		}
	}
	if (holding?.kind === "live" && holding.why.kind === "unboundedUpkeep") {
		return { kind: "unbounded", delta: holding.why.delta.reason }
	}
	return {
		kind: "other",
		what:
			holding === undefined
				? "no holding"
				: holding.why.kind === "notUnitLocal"
					? `${holding.why.lacks.condition}: ${holding.why.lacks.detail}`
					: holding.why.kind
	}
}
