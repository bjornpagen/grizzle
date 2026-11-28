/** What ready-keys.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { type PlanNode, planNodes, scannedRows } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { closedId, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	context,
	derived,
	key,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import {
	fullWorldRole,
	type PgClassState,
	pgClassStates,
	servedRead,
	servedRun,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { readWork } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { indexesRead, plainIndexesOf } from "#test/support/read-indexes.ts"

/** A Clerk user, as metis's ClerkUser. */
const Clerk = str.regex("^user_[0-9A-Za-z]{1,64}$")

/** A person, as metis's TimebackUser. */
const Person = str.bytes(1020, str.regex("^.{1,255}$", "su"))

/** A learner as the ledger keys it, a text of another refinement, as metis's Child (LearnerId). */
const Learner = str.bytes(69, str.regex("^.+$", "su"))

const Name = str.bytes(200, str.regex("^.+$", "su"))

/** The signed-in Clerk user, as metis's Session. */
const Session = context("Session", { sub: Clerk })

/**
 * How the ledger's views live: `stored`, each learner's sittings under the learner's unit (metis's `unit("Learner",
 * { child })`), so the installation stores the status and the valid sittings at the learner's key, as metis's
 * installation does (analysis/derived/storage.ts); or `live`, under no unit, each view read through its definition.
 */
export type Storage = "stored" | "live"

/** The ledger, its views and its reads, its views living as `storage` says, its schema named `name`. */
const ledgerOf = <const Name extends string>(storage: Storage, name: Name) => {
	/**
	 * A sitting ledger shaped as metis's assignment level: the people, each Clerk user's person, the tests and the withdrawn
	 * ones, each learner's assignments by number (a number holds one assignment, whichever learner's), each sitting's
	 * events at their steps, and each sitting's invalidations and their reinstatements.
	 */
	const People = relation("Person", { person: Person }, ["person"])
	const ClerkAccount = relation("ClerkAccount", { clerk: Clerk, person: Person }, ["clerk"])
	const Test = relation("Test", { test: pg.bigint, name: Name, grade: pg.integer }, ["test"])
	const TestWithdrawn = relation("TestWithdrawn", { test: pg.bigint }, ["test"])
	const Assignment = relation(
		"Assignment",
		{ child: Learner, number: natural, test: pg.bigint, priority: pg.integer },
		["child", "number"]
	)
	const EventKind = closed.unordered("EventKind", ["start", "pause", "submit", "abandon"])
	const SittingEvent = relation(
		"SittingEvent",
		{ child: Learner, number: natural, step: natural, next: natural, kind: closedId(EventKind) },
		["child", "number", "step"]
	)
	const Invalidation = relation(
		"Invalidation",
		{ child: Learner, number: natural, change: natural },
		["child", "number", "change"]
	)
	const Reinstatement = relation(
		"Reinstatement",
		{ child: Learner, number: natural, change: natural },
		["child", "number", "change"]
	)
	/**
	 * Each sitting's attempts and each attempt's responses, shaped as den's steps and value families: an attempt keyed by
	 * its own number alone, carrying its learner, its sitting and the round of the sitting it was made in, which no key
	 * and no containment holds, and a response keyed by its learner, its attempt and its item, contained at the learner
	 * and the attempt in the attempt's.
	 */
	const Attempt = relation(
		"Attempt",
		{ attempt: natural, child: Learner, number: natural, round: natural },
		["attempt"]
	)
	const Response = relation(
		"Response",
		{ child: Learner, attempt: natural, item: natural, value: pg.integer },
		["child", "attempt", "item"]
	)

	/**
	 * A staff ledger shaped as metis's ops level: the capabilities a person may be granted, each person's grants, the
	 * capabilities a super admin's grant implies, and the programs an operator runs, the capability each needs and those
	 * that write.
	 */
	const Capability = closed.unordered("Capability", [
		"teacher",
		"assignTests",
		"readOnly",
		"superAdmin"
	])
	const Grant = relation("Grant", { person: Person, capability: closedId(Capability) }, [
		"person",
		"capability"
	])
	const SuperAdminImplies = closed.relation(
		"SuperAdminImplies",
		{ capability: closedId(Capability) },
		["capability"],
		[{ capability: "teacher" }, { capability: "assignTests" }]
	)
	const Program = closed.unordered("OpsProgram", ["coachReview", "invalidate"])
	const ProgramNeeds = closed.relation(
		"ProgramNeeds",
		{ program: closedId(Program), capability: closedId(Capability) },
		["program"],
		[
			{ program: "coachReview", capability: "teacher" },
			{ program: "invalidate", capability: "assignTests" }
		]
	)
	const ProgramWrites = closed.relation(
		"ProgramWrites",
		{ program: closedId(Program) },
		["program"],
		[{ program: "invalidate" }]
	)

	const Stored = schema(
		name,
		[
			People,
			ClerkAccount,
			Test,
			TestWithdrawn,
			Assignment,
			EventKind,
			SittingEvent,
			Invalidation,
			Reinstatement,
			Attempt,
			Response,
			Capability,
			Grant,
			SuperAdminImplies,
			Program,
			ProgramNeeds,
			ProgramWrites
		],
		[
			key(on(Assignment, "number")),
			...(storage === "stored" ? [unit("Learner", { child: Learner })] : []),
			contained(on(Grant, "person"), on(People, "person")),
			contained(on(ClerkAccount, "person"), on(People, "person")),
			contained(on(Assignment, "child"), on(People, "person")),
			contained(on(Assignment, "test"), on(Test, "test")),
			contained(on(SittingEvent, "child", "number"), on(Assignment, "child", "number")),
			contained(on(Invalidation, "child", "number"), on(Assignment, "child", "number")),
			contained(
				on(Reinstatement, "child", "number", "change"),
				on(Invalidation, "child", "number", "change")
			),
			contained(on(Attempt, "child", "number"), on(Assignment, "child", "number")),
			contained(on(Response, "child", "attempt"), on(Attempt, "child", "attempt"))
		]
	)

	const Status = closed.unordered("SittingStatus", [
		"ASSIGNED",
		"IN_PROGRESS",
		"PAUSED",
		"COMPLETED",
		"ABANDONED"
	])

	/** Each sitting's status from its events, as metis's AssignmentStatus: a union of five rules. */
	const AssignmentStatus = derived(
		"AssignmentStatus",
		query(Stored)
			.rule((r) => {
				const { child, number } = v(Assignment, "assignment")
				return r
					.match(Assignment, { child, number })
					.where(r.not(SittingEvent, { child, number }))
					.find({ child, number, status: Status.handle("ASSIGNED") })
			})
			.rule((r) => {
				const { child, number, next } = v(SittingEvent, "latest")
				return r
					.match(SittingEvent, { child, number, next, kind: "start" })
					.where(r.not(SittingEvent, { child, number, step: next }))
					.find({ child, number, status: Status.handle("IN_PROGRESS") })
			})
			.rule((r) => {
				const { child, number, next } = v(SittingEvent, "latest")
				return r
					.match(SittingEvent, { child, number, next, kind: "pause" })
					.where(r.not(SittingEvent, { child, number, step: next }))
					.find({ child, number, status: Status.handle("PAUSED") })
			})
			.rule((r) => {
				const { child, number } = v(SittingEvent, "closing")
				return r
					.match(SittingEvent, { child, number, kind: "submit" })
					.find({ child, number, status: Status.handle("COMPLETED") })
			})
			.rule((r) => {
				const { child, number } = v(SittingEvent, "closing")
				return r
					.match(SittingEvent, { child, number, kind: "abandon" })
					.find({ child, number, status: Status.handle("ABANDONED") })
			})
	)

	/** Each sitting's invalidation no reinstatement lifts. */
	const standing = query(Stored).rule((r) => {
		const { child, number, change } = v(Invalidation, "standing")
		return r
			.match(Invalidation, { child, number, change })
			.where(r.not(Reinstatement, { child, number, change }))
			.find({ child, number })
	})

	/** The sittings that count, as metis's Valid. */
	const Valid = derived(
		"Valid",
		query(Stored).rule((r) => {
			const { child, number } = v(Assignment, "assignment")
			return r
				.match(Assignment, { child, number })
				.where(r.not(standing, { child, number }))
				.find({ child, number })
		})
	)

	/** Each person's grants in force, as metis's EffectiveGrant: their own, and a super admin's every implied one. */
	const EffectiveGrant = derived(
		"EffectiveGrant",
		query(Stored)
			.rule((r) => {
				const { person, capability } = v(Grant, "grant")
				return r.match(Grant, { person, capability }).find({ person, capability })
			})
			.rule((r) => {
				const { person } = v(Grant, "admin")
				const { capability } = v(SuperAdminImplies, "implied")
				return r
					.match(Grant, { person, capability: "superAdmin" })
					.match(SuperAdminImplies, { capability })
					.find({ person, capability })
			})
	)

	const Views = schema.extend(
		[Stored],
		`${name}_1` as const,
		[Status, AssignmentStatus, Valid, EffectiveGrant],
		[]
	)

	/**
	 * The programs each Clerk user may run, as metis's OperatorMay: one whose person holds the capability it needs, and,
	 * for a program that writes, holds no grant of reading only.
	 */
	const OperatorMay = derived(
		"OperatorMay",
		query(Views)
			.rule((r) => {
				const { clerk, person } = v(ClerkAccount, "account")
				const { program, capability } = v(ProgramNeeds, "needs")
				return r
					.match(ClerkAccount, { clerk, person })
					.match(ProgramNeeds, { program, capability })
					.match(EffectiveGrant, { person, capability })
					.where(r.not(ProgramWrites, { program }))
					.find({ clerk, program })
			})
			.rule((r) => {
				const { clerk, person } = v(ClerkAccount, "account")
				const { program, capability } = v(ProgramNeeds, "needs")
				return r
					.match(ClerkAccount, { clerk, person })
					.match(ProgramNeeds, { program, capability })
					.match(EffectiveGrant, { person, capability })
					.match(ProgramWrites, { program })
					.where(r.not(EffectiveGrant, { person, capability: "readOnly" }))
					.find({ clerk, program })
			})
	)

	const Ops = schema.extend([Views], `${name}_2` as const, [OperatorMay], [])

	/** The programs the signed-in operator may run, as metis's `may`. */
	const may = query(Ops).rule((r) => {
		const { clerk, program } = v(OperatorMay, "may")
		return r.match(Session, { sub: clerk }).match(OperatorMay, { clerk, program }).find({ program })
	})

	/**
	 * One sitting as a coach reviews it, as metis's coachReading's `sitting`: the guard of the signed-in operator's
	 * permission to review, beside the sitting the call names by its number, its test and its status.
	 */
	const coachSitting = query(Ops).rule((r) => {
		const number = r.param("number", natural)
		const { child, test } = v(Assignment, "assignment")
		const { name, grade } = v(Test, "test")
		const { status } = v(AssignmentStatus, "status")
		return r
			.match(may, { program: "coachReview" })
			.match(Assignment, { number, child, test })
			.match(Test, { test, name, grade })
			.match(AssignmentStatus, { number, status })
			.find({ number, child, name, grade, status })
	})

	/**
	 * The signed-in learner's listed assignments, as metis's myAssignments: the claims' Clerk user, its person, the person's
	 * assignments, each one's status read by its number alone, its validity by its number, and its test, a withdrawn test's
	 * and an abandoned sitting's kept out.
	 */
	const myAssignments = query(Ops).rule((r) => {
		const { sub: signedIn } = v(Session, "session")
		const { number, child: learner, test, priority } = v(Assignment, "listed")
		const { status } = v(AssignmentStatus, "listedStatus")
		const { name, grade } = v(Test, "listedTest")
		return r
			.match(Session, { sub: signedIn })
			.match(ClerkAccount, { clerk: signedIn, person: learner })
			.match(Assignment, { number, child: learner, test, priority })
			.match(AssignmentStatus, { number, status })
			.match(Valid, { number })
			.match(Test, { test, name, grade })
			.where(
				r.in(status, ["ASSIGNED", "IN_PROGRESS", "PAUSED", "COMPLETED"]),
				r.not(TestWithdrawn, { test })
			)
			.find({ number, status, name, grade, priority, child: learner })
	})

	/**
	 * One of the signed-in learner's listed assignments, by its number, as metis's myAssignment: the list's rule at the
	 * call's number.
	 */
	const myAssignment = query(Ops).rule((r) => {
		const { sub: signedIn } = v(Session, "session")
		const { number, child: learner, test, priority } = v(Assignment, "opened")
		const { status } = v(AssignmentStatus, "openedStatus")
		const { name, grade } = v(Test, "openedTest")
		return r
			.match(Session, { sub: signedIn })
			.match(ClerkAccount, { clerk: signedIn, person: learner })
			.match(Assignment, { number, child: learner, test, priority })
			.match(AssignmentStatus, { number, status })
			.match(Valid, { number })
			.match(Test, { test, name, grade })
			.where(
				r.eq(number, r.param("number", natural)),
				r.in(status, ["ASSIGNED", "IN_PROGRESS", "PAUSED", "COMPLETED"]),
				r.not(TestWithdrawn, { test })
			)
			.find({ number, status, name, grade, priority, child: learner })
	})

	/**
	 * The signed-in learner's open sittings of the test the call names, an invalidated one kept out, at most two, the lowest
	 * numbers first, as metis's myOpenSittingsOf.
	 */
	const myOpenSittingsOf = query(Ops)
		.rule((r) => {
			const { sub: signedIn } = v(Session, "recoverySession")
			const { number, child: learner, test } = v(Assignment, "recovered")
			const { status } = v(AssignmentStatus, "recoveredStatus")
			return r
				.match(Session, { sub: signedIn })
				.match(ClerkAccount, { clerk: signedIn, person: learner })
				.match(Assignment, { number, child: learner, test })
				.match(AssignmentStatus, { number, status })
				.match(Valid, { number })
				.where(
					r.eq(test, r.param("test", pg.bigint)),
					r.in(status, ["ASSIGNED", "IN_PROGRESS", "PAUSED"])
				)
				.find({ number })
		})
		.orderBy(["number", "asc"])
		.take(2)

	/**
	 * The responses of one round's attempts, as den's scope reads (UNITKEY's class b2): the attempts at the call's round,
	 * which no key and no index the laws build leads with, and each attempt's responses joined on the attempt alone, whose
	 * learner the attempt's row holds (lower/optimize/eliminate R03.containedEquality), so each attempt's responses are
	 * read at its learner and itself, their key's prefix.
	 */
	const responsesOf = query(Ops).rule((r) => {
		const { attempt } = v(Attempt, "attempt")
		const { item, value } = v(Response, "response")
		return r
			.match(Attempt, { attempt, round: r.param("round", natural) })
			.match(Response, { attempt, item, value })
			.find({ attempt, item, value })
	})

	return {
		Ops,
		EventKind,
		Capability,
		tables: [
			People,
			ClerkAccount,
			Test,
			TestWithdrawn,
			Assignment,
			SittingEvent,
			Invalidation,
			Reinstatement,
			Attempt,
			Response,
			Grant
		],
		People,
		ClerkAccount,
		Test,
		TestWithdrawn,
		Assignment,
		SittingEvent,
		Invalidation,
		Reinstatement,
		Attempt,
		Response,
		Grant,
		reads: {
			list: myAssignments,
			guard: coachSitting,
			one: myAssignment,
			open: myOpenSittingsOf,
			responses: responsesOf
		}
	}
}

/** The ledger of each storage. */
const ledgers = {
	stored: ledgerOf("stored", "ReadyKeys"),
	live: ledgerOf("live", "ReadyKeysLive")
} as const

/**
 * The ledger of `storage` installed through its first migration under `name` and `label`, with a reader whose workload's
 * indexes its reads earn.
 */
const templateOf = (storage: Storage, name: string, label: string) => {
	const ledger = ledgers[storage]
	return fullWorldTemplate({
		declaredIn: import.meta,
		name,
		fixture: ledger.Ops,
		programs: {
			myAssignments: ledger.reads.list,
			myAssignment: ledger.reads.one,
			myOpenSittingsOf: ledger.reads.open,
			coachSitting: ledger.reads.guard,
			responsesOf: ledger.reads.responses
		},
		contexts: [Session],
		label,
		ambient: ordinarySession
	})
}

/**
 * The ledger of `storage` installed through its first migration with no workload: the indexes its laws ask alone,
 * beside which the workload's access built the rest.
 */
const lawsOnlyOf = (storage: Storage, name: string, label: string) => {
	const ledger = ledgers[storage]
	return migratedTemplate({
		declaredIn: import.meta,
		name,
		content: { schema: ledger.Ops.name, logins: [] },
		versions: [{ schema: ledger.Ops, declarations: noDeclarations }],
		options: {
			label,
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})
}

/** The stored ledger's laws alone. */
export const storedLawsTemplate = lawsOnlyOf(
	"stored",
	"ready keys stored laws",
	"ready_keys_stored_laws"
)

/** The live ledger's laws alone. */
export const liveLawsTemplate = lawsOnlyOf("live", "ready keys live laws", "ready_keys_live_laws")

/** The ledger with its views stored at the learner's unit, as metis's installation holds them. */
export const storedTemplate = templateOf("stored", "ready keys stored", "ready_keys_stored")

/** The ledger with its views live, read through their definitions. */
export const liveTemplate = templateOf("live", "ready keys live", "ready_keys_live")

/**
 * The read a case explains under the claims: learner 1's list (myAssignments), a coach's review of learner 1's first
 * sitting behind the guard of the signed-in operator's permission (coachSitting), learner 1's first sitting by its number
 * (myAssignment), learner 1's open sittings of its first sitting's test (myOpenSittingsOf), or the responses of learner
 * 1's first sitting's attempts (responsesOf, den's scope read).
 */
export type Read = "list" | "guard" | "one" | "open" | "responses"

/**
 * A case: the learners stored, each with `assignments` assignments of `tests` tests, each sitting's events by its place
 * among the learner's (none, a start, a start and a pause, a start and a submission, an abandonment), every third
 * invalidated and every sixth reinstated, each sitting's `attempts` attempts with `items` responses each, each learner's
 * person granted teaching and every fourth a super admin; then
 * `more` learners stored beside them alike; and the read explained.
 */
export interface ReadyCase {
	readonly read: Read
	readonly learners: number
	readonly assignments: number
	readonly tests: number
	readonly more: number
	readonly state: PgClassState
}

export const readyGen: Gen<ReadyCase> = (s) => ({
	read: s.draw(element(["list", "guard", "one", "open", "responses"] as const)),
	learners: s.draw(int(5, 30)),
	assignments: s.draw(int(2, 12)),
	tests: s.draw(int(2, 6)),
	more: s.draw(int(100, 400)),
	state: s.draw(element<PgClassState>(pgClassStates))
})

export type ReadyFeature =
	| `${Read}, beside ${"a few" | "many"} learners`
	| `every table ${PgClassState}`

/**
 * The learners a ledger stores beside a case's before any of them, numbered past every learner a case stores, each as a
 * case's learner is: a store large beside one learner's rows, so a read of any relation whole, or at a prefix every
 * learner shares, reads past the bound of every case.
 *
 * @limitKind derived
 * @owner the ready-keys properties (ready-keys.test.ts)
 * @unit learners
 * @scope the background every case's ledger stands beside
 * @derivation The largest bound a case draws (boundOf) is a list's at twelve sittings, 2 × (3 + 13 × 12) = 318 rows,
 *   and each learner beside adds a row at least to every relation the reads bind: 319 learners pass it.
 */
const besideLearners = 319

/** The first learner stored beside a case's own: past every learner a case stores. */
const besideFirst = 1_000_000

/**
 * The scans of a plan that read rows, each with what it read and how, the most first: what a failure names, so a read
 * past its bound says which relation it read whole.
 */
const scansOf = (plan: PlanNode): string =>
	Arr.join(
		Arr.map(
			Arr.sort(
				Arr.filter([...planNodes(plan)], (n) => scannedRows(n) > 0 && Option.isSome(n.relation)),
				Order.mapInput(Order.flip(Order.Number), scannedRows)
			),
			(n) =>
				`${n.nodeType} ${Option.getOrElse(n.relation, () => "")} ${String(scannedRows(n))} rows${Option.match(n.indexCond, { onNone: () => "", onSome: (c) => ` at ${c}` })}${Option.match(n.filter, { onNone: () => "", onSome: (f) => ` filter ${f}` })}`
		),
		"; "
	)

/**
 * The rows a read of one sitting at its keys meets, each a seek: its assignment by its learner, its status arms (its
 * assignment by its number and its first event, each event arm's event of its kind and the event after it), its validity
 * (its assignment by its number, its invalidation, the reinstatement of it), its test and the test's withdrawal, 13 at
 * most where a sitting holds at most one event of each kind, as every sitting here does.
 */
const perSitting = 13

/**
 * The rows the signed-in operator's permission meets at its Clerk user's key: in each of the two rules its account by
 * the key and its person's grants (at most two, and its super admin's grant), and the person's grant of reading only.
 */
const permission = 11

/** The attempts of each sitting, and the responses of each attempt. */
const attempts = 2
const items = 3

/**
 * A case's bound, twice the rows its read meets at its keys and three more for what it reads once, the claims' Clerk
 * user among them: learner 1's list and its open sittings of a test, `perSitting` for each of its sittings; the guarded
 * review, the permission and one sitting; one sitting by its number, the learner's assignments and that sitting; a
 * sitting's responses, its attempts and their responses. A read that derives a view whole, the status, the valid sittings
 * or every Clerk user's permitted programs,
 * passes it beside many learners, reading every learner's rows.
 */
const boundOf = (c: ReadyCase): number => {
	switch (c.read) {
		case "list":
		case "open":
			return 2 * (3 + perSitting * c.assignments)
		case "guard":
			return 2 * (3 + permission + perSitting)
		case "one":
			return 2 * (3 + c.assignments + perSitting)
		case "responses":
			return 2 * (3 + attempts + attempts * items)
	}
}

/**
 * The parameters of a case's read: learner 1's first sitting, number 1, of test 2 (`1 + 1 % tests`, at least two tests),
 * started, valid and of a test no withdrawal names.
 */
const paramsOf = (read: Read): Readonly<Record<string, unknown>> => {
	switch (read) {
		case "list":
			return {}
		case "guard":
		case "one":
			return { number: 1n }
		case "responses":
			return { round: 1n }
		case "open":
			return { test: 2n }
	}
}

/**
 * The ledger of `storage` filled for a case, in the case's one transaction, which the case's end rolls back: learners 1
 * to `learners` stored (learner c the person `person c`, signed in as Clerk user `user_c`), their assignments, events,
 * invalidations, reinstatements and grants, every stored view brought up to them as a commit would (SET CONSTRAINTS ALL
 * IMMEDIATE runs the upkeep the judge defers to COMMIT), beside the learners a ledger stores first (`besideLearners`),
 * every table stood in the case's pg_class state (test/support/advice.ts standIn, a learner its unit), under claims
 * naming `user_1`; with each read as a served Db runs it, run under
 * its carried advice once the plan laws hold over it (test/support/advice.ts servedRun), and its rows, and `more`
 * learners stored beside them alike, stood in the state again.
 */
const filled = (
	storage: Storage,
	installed: Installed,
	connection: PgConnection,
	c: Omit<ReadyCase, "read">
) =>
	Effect.gen(function* () {
		const ledger = ledgers[storage]
		const {
			People,
			ClerkAccount,
			Test,
			TestWithdrawn,
			Assignment,
			SittingEvent,
			Invalidation,
			Reinstatement,
			Attempt,
			Response,
			Grant,
			EventKind,
			Capability
		} = ledger
		const names = namesOf(installed)
		const tables = Arr.map(ledger.tables, (t) => names.table(t))
		const kind = (handle: (typeof EventKind)["handles"][number]): string =>
			String(names.code(EventKind, handle))
		const capability = (handle: (typeof Capability)["handles"][number]): string =>
			String(names.code(Capability, handle))
		const n = c.assignments
		/** Learner `g.c`'s `h.j`-th assignment's number. */
		const number = `(g.c - 1) * ${String(n)} + h.j`
		const stored = (from: number, to: number) => {
			const learners = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c)`
			const sittings = `${learners}, generate_series(1, ${String(n)}) AS h(j)`
			/** The events of a sitting at place j: none, a start, a start and a pause, a start and a submission, an abandonment. */
			const events = (step: number, kinds: ReadonlyArray<readonly [number, string]>) =>
				Arr.map(
					kinds,
					([place, code]) =>
						`INSERT INTO ${names.table(SittingEvent)} SELECT 'person ' || g.c, ${number}, ${String(step)}, ${String(step + 1)}, ${code} ${sittings} WHERE h.j % 5 = ${String(place)}`
				)
			return [
				`INSERT INTO ${names.table(People)} SELECT 'person ' || g.c ${learners}`,
				`INSERT INTO ${names.table(ClerkAccount)} SELECT 'user_' || g.c, 'person ' || g.c ${learners}`,
				`INSERT INTO ${names.table(Assignment)} SELECT 'person ' || g.c, ${number}, 1 + h.j % ${String(c.tests)}, h.j ${sittings}`,
				...events(0, [
					[1, kind("start")],
					[2, kind("start")],
					[3, kind("start")],
					[4, kind("abandon")]
				]),
				...events(1, [
					[2, kind("pause")],
					[3, kind("submit")]
				]),
				`INSERT INTO ${names.table(Invalidation)} SELECT 'person ' || g.c, ${number}, 0 ${sittings} WHERE h.j % 3 = 0`,
				`INSERT INTO ${names.table(Reinstatement)} SELECT 'person ' || g.c, ${number}, 0 ${sittings} WHERE h.j % 6 = 0`,
				`INSERT INTO ${names.table(Attempt)} SELECT ${String(attempts)} * (${number}) + a.a, 'person ' || g.c, ${number}, ${number} ${sittings}, generate_series(0, ${String(attempts - 1)}) AS a(a)`,
				`INSERT INTO ${names.table(Response)} SELECT 'person ' || g.c, ${String(attempts)} * (${number}) + a.a, i.i, i.i ${sittings}, generate_series(0, ${String(attempts - 1)}) AS a(a), generate_series(1, ${String(items)}) AS i(i)`,
				`INSERT INTO ${names.table(Grant)} SELECT 'person ' || g.c, ${capability("teacher")} ${learners}`,
				`INSERT INTO ${names.table(Grant)} SELECT 'person ' || g.c, ${capability("superAdmin")} ${learners} WHERE g.c % 4 = 0`
			]
		}
		const session: BenchSession = { values: connection.queryValues }
		const run = (statements: ReadonlyArray<string>) =>
			Effect.forEach(statements, (sql) => connection.query(sql, []), { discard: true })
		const tablesIn = Arr.isReadonlyArrayNonEmpty(tables)
			? tables
			: assert.fail("a ledger of no stored table")
		yield* run([
			...names.standUps,
			`INSERT INTO ${names.table(Test)} SELECT t, 'test ' || t, t FROM generate_series(1, ${String(c.tests)}) AS t`,
			`INSERT INTO ${names.table(TestWithdrawn)} VALUES (1)`,
			...stored(besideFirst, besideFirst + besideLearners - 1)
		])
		yield* standIn(
			session,
			{
				tables: tablesIn,
				units: c.learners,
				load: (from, to) => run([...stored(from, to), "SET CONSTRAINTS ALL IMMEDIATE"])
			},
			c.state
		)
		yield* run([
			`SELECT pg_catalog.set_config('grizzle.claims', '{"Session":{"sub":"user_1"}}', true)`
		])
		/** A read's statement, with its parameters (paramsOf): its run under its advice, and its rows. */
		const reading = (read: Read) =>
			Effect.map(
				servedRead(
					installed,
					fullWorldRole(installed, ledger.Ops, [Session]),
					ledger.reads[read],
					`learner 1's ${read}`
				),
				(served) => ({
					explained: servedRun(session, served, paramsOf(read)),
					rows: connection.queryValues(served.statement.sql, served.params(paramsOf(read)))
				})
			)
		const more = standIn(
			session,
			{
				tables: tablesIn,
				units: c.more,
				load: (from, to) =>
					run([...stored(c.learners + from, c.learners + to), "SET CONSTRAINTS ALL IMMEDIATE"])
			},
			c.state
		)
		return { reading, more, tables }
	})

/**
 * One case of a read: the ledger filled (`filled`); learner 1's first sitting read (started, valid, of a test no
 * withdrawal names, which its own teaching grant permits its Clerk user to review: a read under no claims reads
 * nothing); the read run under its carried advice, its work (test/support/judge.ts readWork) at most its bound
 * (boundOf): the claims drive the list, each sitting's
 * status and validity read at its number, and the guard reads the programs the signed-in Clerk user may run at its key;
 * then `more` learners stored beside them, and the read run again, within the same bound. A read that derives a
 * view whole reads every learner's rows.
 */
export const runReady = (
	storage: Storage,
	installed: Installed,
	connection: PgConnection,
	c: ReadyCase,
	k: Case<ReadyFeature>
) =>
	Effect.gen(function* () {
		const ledger = yield* filled(storage, installed, connection, c)
		const read = yield* ledger.reading(c.read)
		const rows = yield* read.rows
		assert.ok(rows.length > 0, `${Formatter.format(c)}: learner 1's first sitting is read`)
		const bound = boundOf(c)
		const bounded = (learners: number) =>
			Effect.map(read.explained, (plan) => {
				const work = readWork(plan)
				assert.ok(
					work <= bound,
					`${Formatter.format(c)}: learner 1's ${c.read} beside ${String(learners)} learners reads ${String(work)} rows, past its bound ${String(bound)} (its ${String(c.assignments)} sittings): ${scansOf(plan)}`
				)
			})
		yield* bounded(c.learners)
		yield* ledger.more
		yield* bounded(c.learners + c.more)
		k.note(`${c.read}, beside ${c.learners < 15 ? "a few" : "many"} learners`)
		k.note(`every table ${c.state}`)
	})

/**
 * A case of the workload: every read of it over the ledger of one storage, filled as a read's case fills it, every
 * table analyzed: the indexes the workload's plans read do not hang on a state, which each read's own bound holds in
 * every one.
 */
export type WorkloadCase = Omit<ReadyCase, "read" | "state">

export const workloadGen: Gen<WorkloadCase> = (s) => ({
	learners: s.draw(int(5, 30)),
	assignments: s.draw(int(2, 12)),
	tests: s.draw(int(2, 6)),
	more: s.draw(int(100, 400))
})

export type WorkloadFeature = `beside ${"a few" | "many"} learners`

/** The reads of the workload. */
const reads = ["list", "guard", "one", "open", "responses"] as const satisfies ReadonlyArray<Read>

/**
 * The indexes the workload's access builds over each storage's stored relations, each its table and its columns as the
 * index engine groups the requests: the paths its reads' chains seek by that no declared key's prefix and no index the
 * laws build serves, no more. A learner's assignments of a test by a seek no key leads with, and live, each status arm's
 * events at a sitting's number and kind; a round's attempts, which drive their responses, at the round alone, which no
 * key and no index the laws build leads with (physical/access/extract.ts visit, a driven semi-join's driver read at
 * what its reader pushes, never probed at the pairs); a round's responses are read at their learner and their attempt,
 * their key's prefix (lower/optimize/eliminate R03.containedEquality), so none is built over them.
 */
const accessIndexes: Readonly<Record<Storage, ReadonlyArray<string>>> = {
	stored: ["assignment(test, child)", "attempt(round)"],
	live: ["assignment(test, child)", "attempt(round)", "sitting_event(number, kind)"]
}

/**
 * One case of the workload: the ledger filled (`filled`), `more` learners beside the case's, and every read of the
 * workload explained: each within its bound (boundOf), its every chain step reading through an index, every index the
 * installation built for the workload's access read by some read's plan, and those over its stored relations exactly
 * the paths its chains seek by that no key's prefix serves (`accessIndexes`): no more and no fewer.
 */
export const runWorkload = (
	storage: Storage,
	installed: Installed,
	connection: PgConnection,
	laws: { readonly installed: Installed; readonly connection: PgConnection },
	c: WorkloadCase,
	k: Case<WorkloadFeature>
) =>
	Effect.gen(function* () {
		const ledger = yield* filled(storage, installed, connection, { ...c, state: "analyzed" })
		yield* ledger.more
		const used = new Set<string>()
		for (const read of reads) {
			const plan = yield* (yield* ledger.reading(read)).explained
			const bound = boundOf({ ...c, read, state: "analyzed" })
			const work = readWork(plan)
			assert.ok(
				work <= bound,
				`${Formatter.format(c)}: learner 1's ${read} beside ${String(c.learners + c.more)} learners reads ${String(work)} rows, past its bound ${String(bound)}: ${scansOf(plan)}`
			)
			for (const index of indexesRead(plan)) {
				used.add(index)
			}
		}
		const rows = yield* plainIndexesOf(connection, ledger.tables)
		const lawNames = namesOf(laws.installed)
		const lawRows = yield* plainIndexesOf(
			laws.connection,
			Arr.map(ledgers[storage].tables, (t) => lawNames.table(t))
		)
		const lawsOwn = new Set(Arr.map(lawRows, (row) => String(row[0])))
		/** The indexes the workload's access built: every plain index but those the laws build alone. */
		const built = Arr.filter(rows, (row) => !lawsOwn.has(String(row[0])))
		const unread = Arr.filter(
			Arr.map(built, (row) => String(row[0])),
			(index) => !used.has(index)
		)
		assert.equal(
			Arr.join(unread, ", "),
			"",
			`${Formatter.format(c)}: indexes the workload's access built that no read's plan reads: ${Arr.join(unread, ", ")} (read: ${Arr.join(Arr.sort([...used], Order.String), ", ")})`
		)
		assert.equal(
			Arr.join(
				Arr.sort(
					Arr.map(built, (row) => String(row[1])),
					Order.String
				),
				"; "
			),
			Arr.join(accessIndexes[storage], "; "),
			`${Formatter.format(c)}: the indexes the workload's access built over the ${storage} ledger's stored relations`
		)
		k.note(`beside ${c.learners < 15 ? "a few" : "many"} learners`)
	})
