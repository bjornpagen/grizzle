import type { Vitest } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required, type Situations } from "@grizzle/testing/features"
import { constant } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record, String as Str } from "effect"
import type { ReadonlyTupleSet } from "#compiler/core/tuple-map.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import {
	educationInstall,
	importAccount,
	personName
} from "#test/support/fixtures/education/index.ts"
import type { ValueIdentity } from "#test/support/kernel/identity.ts"
import { sameValue } from "#test/support/laws/model.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"
import {
	reachingPastRefused,
	sessionOf,
	witnessesShowTheirOwn
} from "#test/support/worlds/drive/acting.ts"

import { caseHang } from "#test/support/limits.ts"
import {
	aimScope,
	drawnRealities,
	driveProgram,
	everyWriterWrites,
	type Focus,
	type Lead,
	noteNaming,
	type ProgramCase,
	programCaseGen,
	type Seen,
	type StepCheck,
	stage,
	whilePending
} from "#test/support/worlds/drive/suite.ts"
import { type RealWorld, realize } from "#test/support/worlds/execute/index.ts"
import { withOpener } from "#test/support/worlds/generate/action.ts"
import {
	noAims,
	type RoleFocus,
	type Weights,
	zeroWeights
} from "#test/support/worlds/generate/weights.ts"
import { entryRows, factKey, factKeySet, sameFact } from "#test/support/worlds/model/host.ts"
import { payloadFacts } from "#test/support/worlds/model/session/claims.ts"
import { factsIn, noFacts } from "#test/support/worlds/model/session/state.ts"
import type {
	Action,
	ActionKind,
	ActionOutcome,
	ContextFacts,
	DirectStatement,
	EntryOp,
	HostFact,
	HostState,
	ModelState,
	Observation,
	PreparedRead,
	RoleRef,
	ModelSession,
	HostValue,
	InstallSpec,
	WorldFeature
} from "#test/support/worlds/model/types.ts"

import { regex } from "arkregex"
/** The roles of the education installation, as its fixture names them. */
const educationRoles = [
	"student",
	"guardian",
	"teacher",
	"school_admin",
	"district_analyst",
	"importer"
] as const

type EducationRole = (typeof educationRoles)[number]

const isEducationRole = (name: string): name is EducationRole =>
	Arr.some(educationRoles, (role) => role === name)

/**
 * What an education suite notes of a case beside the worlds features: each action an education role performed with
 * its outcome, an apply of the role's the database accepted (a write that changed its world), and the situations its
 * properties are about.
 */
type EducationFeature =
	| `${EducationRole} ${ActionKind} ${Observation["kind"]}`
	| `${EducationRole} write accepted`
	| `${EducationRole} saw rows of its world`
	| "a guardian read with a restricted child"
	| "the importer wrote under hand-set claims"
	| "the importer wrote under malformed claims"
	| "a refresh dropped a grade"
	| "a refresh dropped a deleted grade"
	| "a witness was shown"

type Feature = WorldFeature | EducationFeature

/**
 * Who performs an action: a Db's role under the claims it was opened with; a direct writer under its current role (an
 * education role, its bare login, or one that bypasses every world) and the claims it set, in the state its
 * transaction sees; or no session of the installation.
 */
type Actor =
	| {
			readonly kind: "db"
			readonly role: EducationRole
			readonly facts: ContextFacts
			readonly view: HostState
	  }
	| {
			readonly kind: "direct"
			readonly login: string
			readonly current: EducationRole | "login" | "unrestricted"
			readonly claims: "none" | "facts" | "malformed"
			readonly facts: ContextFacts
			readonly view: HostState
	  }
	| { readonly kind: "none" }

const actorOfSession = (state: ModelState, held: ModelSession | undefined): Actor => {
	if (held === undefined) {
		return { kind: "none" }
	}
	switch (held.kind) {
		case "db":
			return isEducationRole(held.role)
				? { kind: "db", role: held.role, facts: held.facts, view: state.reality }
				: { kind: "none" }
		case "direct": {
			const claims = held.claims.kind === "none" ? "none" : held.claims.setting.kind
			return {
				kind: "direct",
				login: held.login,
				current:
					held.current.kind === "login"
						? "login"
						: isEducationRole(held.current.role)
							? held.current.role
							: "unrestricted",
				claims,
				facts:
					held.claims.kind === "set" && held.claims.setting.kind === "facts"
						? held.claims.setting.facts
						: noFacts,
				view: held.view
			}
		}
		case "closed":
			return { kind: "none" }
	}
}

const actorAt = (state: ModelState, session: number): Actor =>
	actorOfSession(state, state.sessions[session])

/** Who performs an action in a state: the actor of the session it names, none for an action naming none. */
const actorIn = (state: ModelState, action: Action): Actor =>
	Option.match(sessionOf(action), {
		onNone: (): Actor => ({ kind: "none" }),
		onSome: (session) => actorAt(state, session)
	})

const actorOf = (seen: Seen): Actor => actorIn(seen.before, seen.action)

/** The education role a role reference names, when it names one. */
const roleOfRef = (ref: RoleRef): Option.Option<EducationRole> => {
	switch (ref.kind) {
		case "own":
		case "other-login":
		case "dropped":
			return isEducationRole(ref.role) ? Option.some(ref.role) : Option.none()
		case "nonexistent":
		case "owner":
			return Option.none()
	}
}

/** The education role an action is performed as in a state, when it is one: the role a Db opens or holds, a direct writer's. */
const actingRole = (state: ModelState, action: Action): Option.Option<EducationRole> => {
	if (action.kind === "open-db") {
		return roleOfRef(action.role)
	}
	const actor = actorIn(state, action)
	switch (actor.kind) {
		case "db":
			return Option.some(actor.role)
		case "direct":
			return isEducationRole(actor.current) ? Option.some(actor.current) : Option.none()
		case "none":
			return Option.none()
	}
}

/** The outcome of an action an education role performs, as `<role> <kind> <outcome>`; none for any other action. */
const roleOutcome = (
	state: ModelState,
	action: Action,
	observation: Observation
): ReadonlyArray<EducationFeature> =>
	Option.match(actingRole(state, action), {
		onNone: () => [],
		onSome: (role): ReadonlyArray<EducationFeature> => [
			`${role} ${action.kind} ${observation.kind}`
		]
	})

/** A field's value as a list: the value, or nothing when the fact lacks the field. */
const present = (value: HostValue | undefined): ReadonlyArray<HostValue> =>
	value === undefined ? [] : [value]

/** The values of field `out` of the facts of `relation` whose field `field` holds `value`; none for an absent value. */
const lookup = (
	view: HostState,
	relation: string,
	field: string,
	value: HostValue | undefined,
	out: string
): ReadonlyArray<HostValue> =>
	value === undefined
		? []
		: Arr.flatMap(factsIn(view, relation), (f) =>
				sameValue(f[field], value) ? present(f[out]) : []
			)

/** Whether some value of `values` is among `allowed`. */
const among = (
	values: ReadonlyArray<HostValue>,
	allowed: ReadonlyArray<HostValue | undefined>
): boolean => Arr.some(values, (v) => Arr.some(allowed, (a) => a !== undefined && sameValue(v, a)))

const claim = (facts: ContextFacts, context: string, field: string): HostValue | undefined =>
	facts[context]?.[field]

const subOf = (facts: ContextFacts): HostValue | undefined => claim(facts, "Session", "sub")

/** The students whose account signed in. */
const ownStudents = (view: HostState, facts: ContextFacts): ReadonlyArray<HostValue> =>
	lookup(view, "Student", "account", subOf(facts), "id")

/** The students the signed-in guardian holds a guardianship of that no restriction withdraws. */
const children = (view: HostState, facts: ContextFacts): ReadonlyArray<HostValue> =>
	Arr.flatMap(lookup(view, "Guardian", "account", subOf(facts), "id"), (guardian) =>
		Arr.filter(
			lookup(view, "Guardianship", "guardian", guardian, "student"),
			(student) => !among(lookup(view, "Restriction", "guardian", guardian, "student"), [student])
		)
	)

/** Whether the signed-in guardian holds a guardianship a restriction withdraws. */
const restrictedChild = (view: HostState, facts: ContextFacts): boolean =>
	Arr.some(
		lookup(view, "Guardian", "account", subOf(facts), "id"),
		(guardian) => lookup(view, "Restriction", "guardian", guardian, "student").length > 0
	)

/** The sections the signed-in teacher's assignments name. */
const ownSections = (view: HostState, facts: ContextFacts): ReadonlyArray<HostValue> =>
	Arr.flatMap(lookup(view, "Teacher", "account", subOf(facts), "id"), (teacher) =>
		lookup(view, "Assignment", "teacher", teacher, "section")
	)

const enrollmentStudents = (
	view: HostState,
	enrollment: HostValue | undefined
): ReadonlyArray<HostValue> => lookup(view, "Enrollment", "id", enrollment, "student")

const enrollmentSections = (
	view: HostState,
	enrollment: HostValue | undefined
): ReadonlyArray<HostValue> => lookup(view, "Enrollment", "id", enrollment, "section")

const attendanceEnrollments = (
	view: HostState,
	attendance: HostValue | undefined
): ReadonlyArray<HostValue> => lookup(view, "Attendance", "id", attendance, "enrollment")

const attendanceStudents = (
	view: HostState,
	attendance: HostValue | undefined
): ReadonlyArray<HostValue> =>
	Arr.flatMap(attendanceEnrollments(view, attendance), (e) => enrollmentStudents(view, e))

const attendanceSections = (
	view: HostState,
	attendance: HostValue | undefined
): ReadonlyArray<HostValue> =>
	Arr.flatMap(attendanceEnrollments(view, attendance), (e) => enrollmentSections(view, e))

/**
 * Whether a fact or a row belongs to a world, judged in the state it was read or written in under the claims it was
 * read or written with. A judge restates its world's intent by following keys through the state, never by evaluating
 * the world's rules: a student's world is their own records, a guardian's their unrestricted children's, a teacher's
 * their assigned sections', a school administrator's their school's, the analyst's the de-identified rollup and their
 * district's sections, the import's what it recorded.
 */
type Judge = (at: {
	readonly view: HostState
	readonly facts: ContextFacts
	readonly row: HostFact
}) => boolean

const recordedBy = (
	view: HostState,
	relation: string,
	field: string,
	value: HostValue | undefined,
	recorder: HostValue | undefined
) => among(lookup(view, relation, field, value, "recorder"), [recorder])

const schoolOf = (
	view: HostState,
	relation: string,
	id: HostValue | undefined
): ReadonlyArray<HostValue> => lookup(view, relation, "id", id, "school")

/** The school the token's `school` claim names, when the signed-in account administers it. */
const administered = (view: HostState, facts: ContextFacts): ReadonlyArray<HostValue> =>
	Arr.filter(lookup(view, "Administrator", "account", subOf(facts), "school"), (school) =>
		sameValue(school, claim(facts, "School", "id"))
	)

/** The rows each role relation may show its role, by role and relation. */
const readJudges: { readonly [R in EducationRole]: Readonly<Record<string, Judge>> } = {
	student: {
		MyEnrollment: ({ view, facts, row }) =>
			among(enrollmentStudents(view, row["id"]), ownStudents(view, facts)),
		MyGrade: ({ view, facts, row }) =>
			among(enrollmentStudents(view, row["enrollment"]), ownStudents(view, facts)),
		MyAttendance: ({ view, facts, row }) =>
			among(attendanceStudents(view, row["id"]), ownStudents(view, facts)),
		MyProfile: ({ view, facts, row }) => among(present(row["student"]), ownStudents(view, facts))
	},
	guardian: {
		Child: ({ view, facts, row }) => among(present(row["id"]), children(view, facts)),
		ChildProfile: ({ view, facts, row }) => among(present(row["student"]), children(view, facts)),
		ChildEnrollment: ({ view, facts, row }) =>
			among(enrollmentStudents(view, row["id"]), children(view, facts)),
		ChildGrade: ({ view, facts, row }) =>
			among(enrollmentStudents(view, row["enrollment"]), children(view, facts)),
		ChildAttendance: ({ view, facts, row }) =>
			among(attendanceStudents(view, row["id"]), children(view, facts)),
		ChildExcuse: ({ view, facts, row }) =>
			among(attendanceStudents(view, row["attendance"]), children(view, facts))
	},
	teacher: {
		MySection: ({ view, facts, row }) => among(present(row["id"]), ownSections(view, facts)),
		SectionEnrollment: ({ view, facts, row }) =>
			among(enrollmentSections(view, row["id"]), ownSections(view, facts)),
		SectionRoster: ({ view, facts, row }) =>
			among(
				lookup(view, "Enrollment", "student", row["student"], "section"),
				ownSections(view, facts)
			),
		SectionGrade: ({ view, facts, row }) =>
			among(enrollmentSections(view, row["enrollment"]), ownSections(view, facts)),
		GradeBook: ({ view, facts, row }) =>
			among(enrollmentSections(view, row["enrollment"]), ownSections(view, facts)) &&
			recordedBy(view, "Grade", "enrollment", row["enrollment"], subOf(facts)),
		SectionAttendance: ({ view, facts, row }) =>
			among(attendanceSections(view, row["id"]), ownSections(view, facts)),
		AttendanceBook: ({ view, facts, row }) =>
			among(attendanceSections(view, row["id"]), ownSections(view, facts)) &&
			recordedBy(view, "Attendance", "id", row["id"], subOf(facts)),
		ExcuseBook: ({ view, facts, row }) =>
			recordedBy(view, "ExcuseNote", "attendance", row["attendance"], subOf(facts))
	},
	school_admin: {
		SchoolStudent: ({ view, facts, row }) =>
			among(schoolOf(view, "Student", row["id"]), administered(view, facts)),
		SchoolProfile: ({ view, facts, row }) =>
			among(schoolOf(view, "Student", row["student"]), administered(view, facts)),
		SchoolTerm: ({ view, facts, row }) =>
			among(schoolOf(view, "Term", row["id"]), administered(view, facts)),
		SchoolSection: ({ view, facts, row }) =>
			among(schoolOf(view, "Section", row["id"]), administered(view, facts)),
		SchoolEnrollment: ({ view, facts, row }) =>
			among(schoolOf(view, "Student", row["student"]), administered(view, facts)) &&
			among(schoolOf(view, "Section", row["section"]), administered(view, facts))
	},
	district_analyst: {
		SectionPoints: ({ row }) =>
			Arr.every(Record.keys(row), (field) => field === "section" || field === "points"),
		DistrictSection: ({ view, facts, row }) =>
			among(
				Arr.flatMap(schoolOf(view, "Section", row["id"]), (school) =>
					lookup(view, "School", "id", school, "district")
				),
				[claim(facts, "District", "id")]
			)
	},
	importer: {
		EnrollmentId: ({ view, row }) =>
			among(lookup(view, "Enrollment", "id", row["id"], "id"), [row["id"]]),
		ImportGrade: ({ view, row }) =>
			recordedBy(view, "Grade", "enrollment", row["enrollment"], importAccount),
		ImportAttendance: ({ view, row }) =>
			recordedBy(view, "Attendance", "id", row["id"], importAccount),
		ImportExcuse: ({ view, row }) =>
			recordedBy(view, "ExcuseNote", "attendance", row["attendance"], importAccount)
	}
}

/** The facts each role may add or remove, by role and base relation: a relation no judge names is never written. */
const writeJudges: { readonly [R in EducationRole]: Readonly<Record<string, Judge>> } = {
	student: {
		StudentProfile: ({ view, facts, row: fact }) =>
			among(present(fact["student"]), ownStudents(view, facts))
	},
	guardian: {},
	teacher: {
		Grade: ({ view, facts, row: fact }) =>
			among(enrollmentSections(view, fact["enrollment"]), ownSections(view, facts)) &&
			sameValue(fact["recorder"], subOf(facts)),
		Attendance: ({ view, facts, row: fact }) =>
			among(enrollmentSections(view, fact["enrollment"]), ownSections(view, facts)) &&
			sameValue(fact["recorder"], subOf(facts)),
		ExcuseNote: ({ view, facts, row: fact }) =>
			sameValue(fact["recorder"], subOf(facts)) &&
			lookup(view, "Teacher", "account", subOf(facts), "id").length > 0
	},
	school_admin: {
		Enrollment: ({ view, facts, row: fact }) =>
			among(schoolOf(view, "Student", fact["student"]), administered(view, facts)) &&
			among(schoolOf(view, "Section", fact["section"]), administered(view, facts))
	},
	district_analyst: {},
	importer: {
		Grade: ({ row: fact }) => sameValue(fact["recorder"], importAccount),
		Attendance: ({ row: fact }) => sameValue(fact["recorder"], importAccount),
		ExcuseNote: ({ row: fact }) => sameValue(fact["recorder"], importAccount)
	}
}

/**
 * Rows a role saw: through a relation of its own (a Db's read, a direct read of its view) or a table read directly.
 * `rows` are the rows of `relation` the answer was made of, which the role's world judges; `shown` is what the answer
 * delivered of them: the rows themselves, or a recursive read's pairs of their values.
 */
interface Read {
	readonly role: EducationRole
	readonly through: "entry" | "table"
	readonly relation: string
	readonly rows: ReadonlyArray<HostFact>
	readonly shown: ReadonlyArray<HostFact>
	readonly view: HostState
	readonly facts: ContextFacts
}

/** A flattened attachment row's parent: its fields, every one a declared name, which holds no dot. */
const parentOf = (row: HostFact): HostFact =>
	Record.filter(row, (_, field) => !Str.includes(".")(field))

/**
 * A flattened attachment row's child as a row of the attached relation (model/reads.ts flattened): its nested fields
 * under their own names, and the join field the attachment matched on, which holds the parent's value; none for a
 * parent the attachment gave no child.
 */
const childOf = (
	row: HostFact,
	on: { readonly parent: string; readonly child: string }
): ReadonlyArray<HostFact> => {
	const nested = Arr.flatMap(
		Record.toEntries(row),
		([field, value]): ReadonlyArray<readonly [string, HostValue]> =>
			Option.match(Str.indexOf(".")(field), {
				onNone: () => [],
				onSome: (dot) => [[Str.slice(dot + 1)(field), value] as const]
			})
	)
	const joined = row[on.parent]
	return nested.length === 0 || joined === undefined
		? []
		: [{ ...Record.fromEntries(nested), [on.child]: joined }]
}

/**
 * The reads a Db's read of a relation made, by the shape it was read in (model/step.ts readCall): its rows as they
 * are; an attachment's parents as rows of the relation and its children as rows of the attached relation; a recursive
 * read's pairs, made of every row of the relation the role holds in the state it read, each of which its world judges.
 */
const dbReads = (
	state: ModelState,
	actor: Extract<Actor, { readonly kind: "db" }>,
	action: Extract<Action, { readonly kind: "read" }>,
	rows: ReadonlyArray<HostFact>
): ReadonlyArray<Read> => {
	const read = (
		relation: string,
		made: ReadonlyArray<HostFact>,
		shown: ReadonlyArray<HostFact>
	): Read => ({
		role: actor.role,
		through: "entry",
		relation,
		rows: made,
		shown,
		view: actor.view,
		facts: actor.facts
	})
	const via = action.via
	switch (via.kind) {
		case "execute":
		case "get":
		case "page":
		case "compile":
			return [read(action.relation, rows, rows)]
		case "attach": {
			const parents = Arr.map(rows, parentOf)
			const children = Arr.flatMap(rows, (row) => childOf(row, via))
			return [read(action.relation, parents, parents), read(via.relation, children, children)]
		}
		case "reach":
			return [
				read(action.relation, entryRows(state, actor.role, action.relation, actor.facts), rows)
			]
	}
}

/** The read a prepared statement of a direct session names, as the session last prepared it before this action. */
const preparedRead = (
	earlier: ReadonlyArray<Seen>,
	session: number,
	name: string
): Option.Option<PreparedRead> =>
	Arr.last(
		Arr.flatMap(earlier, (s): ReadonlyArray<PreparedRead> =>
			s.action.kind === "direct" &&
			s.action.session === session &&
			s.action.statement.kind === "prepare" &&
			s.action.statement.name === name
				? [s.action.statement.read]
				: []
		)
	)

/**
 * Every row an action showed a role: a Db's read, by the shape it was read in (dbReads); the read-backs of an accepted
 * apply, its rows and inserted facts in the post-change state and its deleted ones in the state before; and a direct
 * writer's reads of a role's view, of a table, of a prepared read under the claims it holds when executed, and of the
 * facts ON CONFLICT DO SELECT answers.
 */
const readsOf = (seen: Seen, earlier: ReadonlyArray<Seen>): ReadonlyArray<Read> => {
	const { action, observation } = seen
	const actor = actorOf(seen)
	if (action.kind === "apply" && observation.kind === "applied" && actor.kind === "db") {
		return Arr.flatMap(observation.reads, (back): ReadonlyArray<Read> => [
			{
				role: actor.role,
				through: "entry",
				relation: back.relation,
				rows: [...back.rows, ...back.delta.inserted],
				shown: [...back.rows, ...back.delta.inserted],
				view: seen.after.reality,
				facts: actor.facts
			},
			{
				role: actor.role,
				through: "entry",
				relation: back.relation,
				rows: back.delta.deleted,
				shown: back.delta.deleted,
				view: seen.before.reality,
				facts: actor.facts
			}
		])
	}
	if (observation.kind !== "rows") {
		return []
	}
	if (action.kind === "read" && actor.kind === "db") {
		return dbReads(seen.before, actor, action, observation.rows)
	}
	if (action.kind !== "direct" || actor.kind !== "direct") {
		return []
	}
	const statement = action.statement
	const target = ((): Option.Option<PreparedRead> => {
		switch (statement.kind) {
			case "select-view":
				return Option.some({ kind: "view", role: statement.role, relation: statement.relation })
			case "select-table":
			case "insert-on-conflict":
				return Option.some({ kind: "table", relation: statement.relation })
			case "execute-prepared":
				return preparedRead(earlier, action.session, statement.name)
			case "set-role":
			case "reset-role":
			case "set-session-authorization":
			case "set-claims":
			case "insert":
			case "delete":
			case "update":
			case "truncate":
			case "call":
			case "setval":
			case "merge-delete":
			case "prepare":
				return Option.none()
		}
	})()
	if (Option.isNone(target)) {
		return []
	}
	const read = target.value
	if (read.kind === "view") {
		return isEducationRole(read.role)
			? [
					{
						role: read.role,
						through: "entry",
						relation: read.relation,
						rows: observation.rows,
						shown: observation.rows,
						view: actor.view,
						facts: actor.facts
					}
				]
			: []
	}
	return isEducationRole(actor.current)
		? [
				{
					role: actor.current,
					through: "table",
					relation: read.relation,
					rows: observation.rows,
					shown: observation.rows,
					view: actor.view,
					facts: actor.facts
				}
			]
		: []
}

/** One fact a write added or removed, with the state that holds it. */
interface Change {
	readonly relation: string
	readonly side: "added" | "removed"
	readonly fact: HostFact
	readonly view: HostState
}

/** The canonical keys of facts, for set comparison. */
const keys = (facts: ReadonlyArray<HostFact>): ReadonlyTupleSet<ValueIdentity> => factKeySet(facts)

/** The facts `after` holds that `before` lacks, as added, and the ones it lost, as removed. */
const changesOf = (before: HostState, after: HostState): ReadonlyArray<Change> =>
	Arr.flatMap(Arr.dedupe([...before.keys(), ...after.keys()]), (relation) => {
		const was = factsIn(before, relation)
		const is = factsIn(after, relation)
		const wasKeys = keys(was)
		const isKeys = keys(is)
		return [
			...Arr.map(
				Arr.filter(is, (f) => !wasKeys.has(factKey(f))),
				(fact): Change => ({ relation, side: "added", fact, view: after })
			),
			...Arr.map(
				Arr.filter(was, (f) => !isKeys.has(factKey(f))),
				(fact): Change => ({ relation, side: "removed", fact, view: before })
			)
		]
	})

/** What a write changed and who wrote it: an accepted apply of a Db, or a direct statement that went through. */
interface Write {
	readonly writer: EducationRole | "login"
	readonly facts: ContextFacts
	readonly changes: ReadonlyArray<Change>
}

const writesOf = (seen: Seen): ReadonlyArray<Write> => {
	const { action, observation } = seen
	const actor = actorOf(seen)
	if (action.kind === "apply" && observation.kind === "applied" && actor.kind === "db") {
		return [
			{
				writer: actor.role,
				facts: actor.facts,
				changes: changesOf(seen.before.reality, seen.after.reality)
			}
		]
	}
	if (
		action.kind !== "direct" ||
		observation.kind !== "ok" ||
		actor.kind !== "direct" ||
		actor.current === "unrestricted"
	) {
		return []
	}
	const after = actorAt(seen.after, action.session)
	if (after.kind !== "direct") {
		return []
	}
	return [{ writer: actor.current, facts: actor.facts, changes: changesOf(actor.view, after.view) }]
}

const shown = (fact: HostFact): string => Formatter.format(fact)

/** Every row a role saw belongs to its world, and every fact it wrote too: the property of the role's suite. */
const worldCheck =
	(role: EducationRole): StepCheck =>
	({ seen, earlier }) => {
		for (const read of readsOf(seen, earlier)) {
			if (read.role !== role) {
				continue
			}
			const judge =
				read.through === "entry"
					? readJudges[role][read.relation]
					: writeJudges[role][read.relation]
			if (judge === undefined) {
				assert.fail(
					`action ${seen.index}: the ${role} read ${read.relation}, which it neither holds nor writes`
				)
			}
			for (const row of read.rows) {
				assert.ok(
					judge({ view: read.view, facts: read.facts, row }),
					`action ${seen.index}: the ${role} read ${shown(row)} of ${read.relation}, outside its world under ${Formatter.format(read.facts)}`
				)
			}
		}
		const writes = writesOf(seen)
		for (const write of writes) {
			if (write.writer !== role) {
				continue
			}
			for (const change of write.changes) {
				const judge = writeJudges[role][change.relation]
				assert.ok(
					judge?.({ view: change.view, facts: write.facts, row: change.fact }) === true,
					`action ${seen.index}: the ${role} ${change.side === "added" ? "added" : "removed"} ${shown(change.fact)} of ${change.relation}, outside its world under ${Formatter.format(write.facts)}`
				)
			}
		}
		for (const write of writes) {
			assert.ok(
				write.writer !== "login" || write.changes.length === 0,
				`action ${seen.index}: a login that took on no role changed ${Formatter.format(write.changes)}`
			)
		}
	}

/** A person's name, as the fixture's pattern admits it. */
const namePattern = regex.as(personName.pattern, personName.flags)

/**
 * The import never reads a name: no value of a row the import's role saw, through any relation, matches a person's
 * name, a pattern no other field's value matches.
 */
const noNameCheck: StepCheck = ({ seen, earlier }) => {
	for (const read of readsOf(seen, earlier)) {
		if (read.role !== "importer") {
			continue
		}
		for (const row of read.shown) {
			const name = Arr.findFirst(
				Record.values(row),
				(value) => typeof value === "string" && namePattern.test(value)
			)
			assert.ok(
				Option.isNone(name),
				`action ${seen.index}: the importer read a name in ${shown(row)} of ${read.relation}`
			)
		}
	}
}

/** Each derived fact of SectionPoints is a grade of reality in its section: no deleted grade outlives a refresh. */
const rollupCheck: StepCheck = ({ seen }) => {
	if (seen.action.kind !== "refresh" || seen.observation.kind !== "ok") {
		return
	}
	const reality = seen.after.reality
	for (const fact of seen.after.derived["SectionPoints"] ?? []) {
		const supported = Arr.some(
			factsIn(reality, "Grade"),
			(grade) =>
				sameValue(grade["points"], fact["points"]) &&
				among(enrollmentSections(reality, grade["enrollment"]), [fact["section"]])
		)
		assert.ok(
			supported,
			`action ${seen.index}: the refreshed rollup holds ${shown(fact)}, which no grade supports`
		)
	}
}

/** The grades of every state of the program before this action, as their section and points. */
const gradesSeen = (earlier: ReadonlyArray<Seen>): ReadonlyArray<HostFact> =>
	Arr.flatMap(earlier, (s) =>
		Arr.flatMap(factsIn(s.before.reality, "Grade"), (grade) =>
			Arr.flatMap(present(grade["points"]), (points) =>
				Arr.map(enrollmentSections(s.before.reality, grade["enrollment"]), (section): HostFact => ({
					section,
					points
				}))
			)
		)
	)

/** Notes what a case reached that the education suites are about, beside the driver's worlds features. */
const noteSeen = (c: Case<Feature>, seen: Seen, earlier: ReadonlyArray<Seen>): void => {
	const { action, observation } = seen
	c.noteAll(roleOutcome(seen.before, action, observation))
	if (
		action.kind === "apply" &&
		observation.kind === "applied" &&
		observation.outcome === "accepted"
	) {
		for (const role of Option.toArray(actingRole(seen.before, action))) {
			c.note(`${role} write accepted`)
		}
	}
	if (
		(observation.kind === "invariant-rejected" || observation.kind === "law-refused") &&
		observation.witness.kind === "shown"
	) {
		c.note("a witness was shown")
	}
	for (const read of readsOf(seen, earlier)) {
		if (read.shown.length > 0) {
			c.note(`${read.role} saw rows of its world`)
		}
		if (read.role === "guardian" && restrictedChild(read.view, read.facts)) {
			c.note("a guardian read with a restricted child")
		}
	}
	const actor = actorOf(seen)
	if (
		action.kind === "direct" &&
		actor.kind === "direct" &&
		actor.current === "importer" &&
		Arr.contains(
			["insert", "update", "delete", "insert-on-conflict", "merge-delete"],
			action.statement.kind
		)
	) {
		if (actor.claims === "facts") {
			c.note("the importer wrote under hand-set claims")
		}
		if (actor.claims === "malformed") {
			c.note("the importer wrote under malformed claims")
		}
	}
	if (action.kind === "refresh" && observation.kind === "ok") {
		const now = seen.after.derived["SectionPoints"] ?? []
		const dropped = Arr.filter(
			seen.before.derived["SectionPoints"] ?? [],
			(fact) => !Arr.some(now, (f) => sameFact(f, fact))
		)
		if (dropped.length > 0) {
			c.note("a refresh dropped a grade")
		}
		const deleted = Arr.filter(gradesSeen(earlier), (grade) =>
			Arr.some(dropped, (f) => sameFact(f, grade))
		)
		if (deleted.length > 0) {
			c.note("a refresh dropped a deleted grade")
		}
	}
}

/**
 * The moves an education lead constructs, each read of one outcome in the state its action ran in (leadRead): a role's
 * Db opening onto rows of its world, reading some, and changing its world through an accepted apply; the import adding a
 * grade at points its section's rollup lacks, the analyst refreshing the rollup, and the import deleting a grade no
 * other grade of its section holds the points of; and the importer, as a direct writer, beginning under hand-set claims,
 * beginning at all, setting malformed claims, and writing under either.
 */
type LeadFeature =
	| "the import added a grade its section's rollup lacks"
	| "the analyst refreshed the rollup"
	| "the import deleted the only grade at its section's points"
	| "the importer began under hand-set claims"
	| "the importer began"
	| "the importer set malformed claims"
	| "the importer wrote under hand-set claims"
	| "the importer wrote under malformed claims"
	| `${EducationRole} opened onto rows of its world`
	| `${EducationRole} read rows of its world`
	| `${EducationRole} changed its world`

/** Whether a role's world shows rows in a state under some claims: an entry of it holds a row. */
const worldShows = (state: ModelState, role: EducationRole, facts: ContextFacts): boolean =>
	Option.exists(
		Arr.findFirst(state.install.roles, (r) => r.name === role),
		(spec) =>
			Arr.some(
				Record.keys(spec.entries),
				(entry) => entryRows(state, role, entry, facts).length > 0
			)
	)

/** The facts a live open's token gives its role's contexts: none for no token, its payload's when they decode. */
const openedFacts = (
	state: ModelState,
	action: Extract<Action, { readonly kind: "open-db" }>
): Option.Option<ContextFacts> => {
	const role = Arr.findFirst(
		state.install.roles,
		(r) => action.role.kind === "own" && r.name === action.role.role
	)
	if (Option.isNone(role)) {
		return Option.none()
	}
	switch (action.token.kind) {
		case "none":
			return Option.some(noFacts)
		case "live": {
			const verdict = payloadFacts(state.install.base, role.value, action.token.payload)
			return verdict.kind === "decoded" ? Option.some(verdict.facts) : Option.none()
		}
		case "stale":
		case "wild":
			return Option.none()
	}
}

/** Whether a state's rollup holds a section at some points. */
const rolledUp = (state: ModelState, section: HostValue, points: HostValue): boolean =>
	Arr.some(
		state.derived["SectionPoints"] ?? [],
		(f) => sameValue(f["section"], section) && sameValue(f["points"], points)
	)

/** The sections a grade is in, through its enrollment, with its points: none for a grade without points. */
const gradeAt = (
	view: HostState,
	grade: HostFact
): ReadonlyArray<{ readonly section: HostValue; readonly points: HostValue }> =>
	Arr.flatMap(present(grade["points"]), (points) =>
		Arr.map(enrollmentSections(view, grade["enrollment"]), (section) => ({ section, points }))
	)

/**
 * Whether a grade is the import's in a state and the only grade of its section at its points, which the rollup holds:
 * deleting it and refreshing drops a fact of the rollup.
 */
const onlyAtItsPoints = (state: ModelState, grade: HostFact): boolean => {
	const reality = state.reality
	const stored = Arr.filter(factsIn(reality, "Grade"), (g) =>
		sameValue(g["enrollment"], grade["enrollment"])
	)
	return Arr.some(
		stored,
		(own) =>
			sameValue(own["recorder"], importAccount) &&
			sameValue(own["points"], grade["points"]) &&
			Arr.some(
				gradeAt(reality, own),
				({ section, points }) =>
					rolledUp(state, section, points) &&
					!Arr.some(
						factsIn(reality, "Grade"),
						(other) =>
							!sameValue(other["enrollment"], own["enrollment"]) &&
							Arr.some(
								gradeAt(reality, other),
								(at) => sameValue(at.section, section) && sameValue(at.points, points)
							)
					)
			)
	)
}

/** The grades of the import's accepted apply that ops of some kinds carry through its entry over grades. */
const importedGrades = (
	state: ModelState,
	action: Extract<Action, { readonly kind: "apply" }>,
	observation: ActionOutcome,
	kinds: ReadonlyArray<EntryOp["kind"]>
): ReadonlyArray<HostFact> => {
	const actor = actorIn(state, action)
	return actor.kind === "db" &&
		actor.role === "importer" &&
		observation.kind === "applied" &&
		observation.outcome === "accepted"
		? Arr.flatMap(Arr.flatten(action.strata), (op) =>
				op.relation === "ImportGrade" && Arr.contains(kinds, op.kind) ? op.facts : []
			)
		: []
}

/** The statement kinds that write a table. */
const writing: ReadonlyArray<DirectStatement["kind"]> = [
	"insert",
	"update",
	"delete",
	"insert-on-conflict",
	"merge-delete"
]

/** The lead moves an outcome makes, in the state its action ran in. */
const leadRead = (
	state: ModelState,
	action: Action,
	observation: ActionOutcome
): ReadonlyArray<LeadFeature> => {
	if (action.kind === "open-db") {
		const role = roleOfRef(action.role)
		return Option.isSome(role) &&
			observation.kind === "opened" &&
			Option.exists(openedFacts(state, action), (facts) => worldShows(state, role.value, facts))
			? [`${role.value} opened onto rows of its world`]
			: []
	}
	if (action.kind === "read") {
		const actor = actorIn(state, action)
		return actor.kind === "db" && observation.kind === "rows" && observation.rows.length > 0
			? [`${actor.role} read rows of its world`]
			: []
	}
	if (action.kind === "apply") {
		const actor = actorIn(state, action)
		const changed =
			actor.kind === "db" && observation.kind === "applied" && observation.outcome === "accepted"
				? [`${actor.role} changed its world` as const]
				: []
		const added = Arr.some(importedGrades(state, action, observation, ["insert", "put"]), (grade) =>
			Arr.some(
				gradeAt(state.reality, grade),
				({ section, points }) => !rolledUp(state, section, points)
			)
		)
		const deleted = Arr.some(importedGrades(state, action, observation, ["delete"]), (grade) =>
			onlyAtItsPoints(state, grade)
		)
		return [
			...changed,
			...(added ? ["the import added a grade its section's rollup lacks" as const] : []),
			...(deleted ? ["the import deleted the only grade at its section's points" as const] : [])
		]
	}
	if (action.kind === "refresh") {
		const actor = actorIn(state, action)
		return actor.kind === "db" &&
			actor.role === "district_analyst" &&
			action.relation === "SectionPoints" &&
			observation.kind === "ok"
			? ["the analyst refreshed the rollup"]
			: []
	}
	if (action.kind === "direct-begin") {
		const { current, claims } = action.start
		if (current.kind !== "role" || current.role !== "importer" || observation.kind !== "opened") {
			return []
		}
		return claims.kind === "set" && claims.setting.kind === "facts"
			? ["the importer began", "the importer began under hand-set claims"]
			: ["the importer began"]
	}
	if (action.kind !== "direct") {
		return []
	}
	const actor = actorIn(state, action)
	if (actor.kind !== "direct" || actor.current !== "importer") {
		return []
	}
	const statement = action.statement
	if (statement.kind === "set-claims") {
		return statement.setting.kind === "malformed" && observation.kind === "ok"
			? ["the importer set malformed claims"]
			: []
	}
	if (!Arr.contains(writing, statement.kind)) {
		return []
	}
	switch (actor.claims) {
		case "facts":
			return ["the importer wrote under hand-set claims"]
		case "malformed":
			return ["the importer wrote under malformed claims"]
		case "none":
			return []
	}
}

/**
 * Whether an action could make a lead move at all, read of the action alone, so an aimed draw steps the model only on
 * those: an open of an education role, a read through a Db, the import's apply of a grade, a refresh of the rollup, an
 * importer's BEGIN, and an importer's SET of claims or write.
 */
const leadWorth = (action: Action, state: ModelState): boolean => {
	switch (action.kind) {
		case "open-db":
			return Option.isSome(roleOfRef(action.role))
		case "read":
			return actorIn(state, action).kind === "db"
		case "apply": {
			const actor = actorIn(state, action)
			return (
				actor.kind === "db" &&
				actor.role === "importer" &&
				Arr.some(Arr.flatten(action.strata), (op) => op.relation === "ImportGrade")
			)
		}
		case "refresh":
			return action.relation === "SectionPoints"
		case "direct-begin":
			return action.start.current.kind === "role" && action.start.current.role === "importer"
		case "direct": {
			const actor = actorIn(state, action)
			const kind = action.statement.kind
			return (
				actor.kind === "direct" &&
				actor.current === "importer" &&
				(kind === "set-claims" || Arr.contains(writing, kind))
			)
		}
		case "close":
		case "direct-end":
		case "interrupt":
		case "migrate":
		case "tamper":
		case "drift":
		case "wild":
			return false
	}
}

/** The validity weights of a live draw only. */
const liveOnly: Weights["validity"] = { live: 1, stale: 0, wild: 0 }

/**
 * A lead's move: a live draw of one action kind, on every draw an action the model says makes the move where the box
 * offers one, its tokens claiming two contexts at once (drive/suite.ts aimScope), so a school administrator's can name a
 * school beside its account; where its session is missing (an open the real system refused), the open of one
 * (withOpener).
 */
const move = (weights: Weights, kind: ActionKind, feature: LeadFeature): Weights => ({
	...weights,
	kinds: withOpener(kind),
	actions: { ...zeroWeights.actions, [kind]: 1 },
	validity: liveOnly,
	aims: {
		kind: "every",
		features: [feature],
		read: leadRead,
		worth: leadWorth,
		scope: aimScope
	}
})

/**
 * A lead's live apply through a Db of one role, on every draw one the model accepts where the box offers one: a write
 * inside the role's world that breaks no law and changes it.
 */
const changing = (weights: Weights, role: EducationRole): Weights => ({
	...weights,
	kinds: withOpener("apply"),
	actions: { ...zeroWeights.actions, apply: 1 },
	validity: liveOnly,
	aims: {
		kind: "every",
		features: [`${role} changed its world`],
		read: leadRead,
		worth: (action, state) =>
			action.kind === "apply" && Option.exists(actingRole(state, action), (r) => r === role),
		scope: aimScope
	}
})

/** A lead's live end of the direct writer's transaction, COMMIT or ROLLBACK. */
const end = (weights: Weights): Weights => ({
	...weights,
	kinds: withOpener("direct-end"),
	actions: { ...zeroWeights.actions, "direct-end": 1 },
	validity: liveOnly
})

/** A lead's live open of a Db of one role: its live token, the current snapshot. */
const liveOpen = (weights: Weights, role: EducationRole): Weights => ({
	...weights,
	kinds: ["open-db"],
	roles: { kind: "only", roles: [role] },
	actions: { ...zeroWeights.actions, "open-db": 1 },
	validity: liveOnly
})

/**
 * The laws suite's lead (drive/suite.ts everyWriterWrites): every role that writes opens its Db, applies once and
 * closes, the open and the apply aimed, while one is pending, at the outcomes of that role's applies `required` names
 * (`<role> apply <outcome>`), as roleOutcome reads an outcome.
 */
export const everyWriterApplies = (requiredSituations: ReadonlyArray<string>): Lead =>
	everyWriterWrites(
		(role) => Arr.filter(requiredSituations, Str.startsWith(`${role.name} apply `)),
		roleOutcome
	)

/**
 * The analyst's lead: the import adds a grade at points its section's rollup lacks and commits, the analyst refreshes
 * the rollup, which takes it in, the import deletes it and commits, and the analyst refreshes again, which drops it: a
 * refresh drops a grade, and a deleted one. Each move is the model's (aims every draw), so a reality holding an
 * enrollment without a grade reaches both by construction.
 */
export const gradeDeletedThenRefreshed: (
	weights: Weights,
	install: InstallSpec
) => ReadonlyArray<Weights> = (weights: Weights): ReadonlyArray<Weights> => [
	liveOpen(weights, "importer"),
	move(weights, "apply", "the import added a grade its section's rollup lacks"),
	liveOpen(weights, "district_analyst"),
	move(weights, "refresh", "the analyst refreshed the rollup"),
	move(weights, "apply", "the import deleted the only grade at its section's points"),
	move(weights, "refresh", "the analyst refreshed the rollup")
]

/**
 * The importer's lead, as a direct writer of its login: it begins under hand-set claims and writes, and ends; then
 * begins, sets malformed claims and writes, and ends. Each move is the model's (aims every draw), so both writes are
 * reached by construction.
 */
export const importerUnderClaims: (
	weights: Weights,
	install: InstallSpec
) => ReadonlyArray<Weights> = (weights: Weights): ReadonlyArray<Weights> => [
	move(weights, "direct-begin", "the importer began under hand-set claims"),
	move(weights, "direct", "the importer wrote under hand-set claims"),
	end(weights),
	move(weights, "direct-begin", "the importer began"),
	move(weights, "direct", "the importer set malformed claims"),
	move(weights, "direct", "the importer wrote under malformed claims"),
	end(weights)
]

/**
 * A role suite's lead: a live open of a Db of the role whose world shows rows under its token's claims, and a read of
 * a relation of it that shows some. Each move is the model's (aims every draw), so wherever a real user of the role
 * sees anything, the suite's role sees rows of its world by construction.
 */
export const roleSeesItsWorld =
	(role: EducationRole): Lead =>
	(weights) => [
		{
			...move(weights, "open-db", `${role} opened onto rows of its world`),
			roles: { kind: "only", roles: [role] }
		},
		move(weights, "read", `${role} read rows of its world`)
	]

/**
 * A writing role suite's lead, in a case that takes a targeted lead while the role's accepted write, a requirement of
 * the suite, is pending (drive/suite.ts whilePending, reading the suite's own requirements): an apply through a Db of
 * the role that the model accepts (changing), so wherever the state holds a write inside the role's world that breaks
 * no law, the suite's role changes its world by construction; where it holds none, a live apply of the role's. It
 * follows roleSeesItsWorld, whose Db it writes through.
 */
export const roleChangesItsWorld =
	(role: EducationRole): Lead =>
	(weights, _install, at) => {
		const accepted: EducationFeature = `${role} write accepted`
		return whilePending([accepted], at, () => [changing(weights, role)])
	}

/** An action kind that leaves the catalog as it found it: any but a migration and a catalog change. */
type CatalogKeeping = Exclude<ActionKind, "migrate" | "tamper">

/**
 * Every action kind but a migration and a catalog change: the focus of a suite about what worlds show and take, whose
 * cases share one installation reset between them.
 */
export const worldsFocus: Arr.NonEmptyReadonlyArray<CatalogKeeping> = [
	"open-db",
	"read",
	"apply",
	"refresh",
	"close",
	"direct-begin",
	"direct",
	"direct-end",
	"interrupt",
	"drift",
	"wild"
]

/**
 * How a suite's cases reach their installation, with the action kinds they draw: one installation realized for the
 * whole test and reset per case, whose cases keep its catalog, since a reset restores facts and not the catalog; or one
 * per case, drawing any kind.
 */
type Realization =
	| { readonly realization: "once"; readonly focus: Arr.NonEmptyReadonlyArray<CatalogKeeping> }
	| { readonly realization: "per-case"; readonly focus: Focus }

/**
 * A property an education suite holds each action to, beside the driver's agreement with the model: a role's world
 * (what it reads and writes), the import's blindness to names, the rollup after a refresh, and the two rules every
 * worlds suite may hold (drive/acting.ts): a direct writer reaches nothing past its login, and a witness a law shows
 * names only what its writer submitted or holds whole.
 */
type Property =
	| { readonly kind: "world"; readonly role: EducationRole }
	| { readonly kind: "no-name" }
	| { readonly kind: "rollup" }
	| { readonly kind: "reach" }
	| { readonly kind: "witnesses" }

const checkOf = (property: Property): StepCheck => {
	switch (property.kind) {
		case "world":
			return worldCheck(property.role)
		case "no-name":
			return noNameCheck
		case "rollup":
			return rollupCheck
		case "reach":
			return reachingPastRefused
		case "witnesses":
			return witnessesShowTheirOwn
	}
}

/**
 * A suite over the education installation: its label and test name, how it realizes the installation and the action
 * kinds it draws, the longest program and the count of cases, the features its population must reach, and the
 * properties it holds each action to.
 */
type EducationSuite = Realization & {
	readonly suite: string
	readonly name: string
	/** The roles its programs open a Db as: the one its properties are about, or every role. */
	readonly roles: RoleFocus
	/** What every program draws first (drive/suite.ts Lead). */
	readonly lead: Lead
	readonly steps: number
	readonly cases: number
	readonly required: Situations<Feature>
	readonly properties: Arr.NonEmptyReadonlyArray<Property>
}

/** A case's own realization of the installation, under the ambient session it drew, which the case notes. */
const realizedUnder = (pc: ProgramCase, c: Case<Feature>) =>
	Effect.tap(realize(pc.install, pc.ambient), () =>
		Effect.sync(() => {
			noteNaming(pc, c)
		})
	)

/**
 * Registers an education suite's test. Each case stages a drawn reality on the installation, then runs its program,
 * every action drawn from the model's state, performed on the real system and the model side by side, and held to the
 * suite's properties; a failure shrinks through at most 200 candidates. The steered phase climbs toward the required
 * features for as many cases as the suite runs.
 */
const register = (it: Vitest.MethodsNonLive<Substrate>, spec: EducationSuite): void => {
	it.effect(spec.name, (ctx) =>
		Effect.gen(function* () {
			assert.deepEqual(
				Arr.map(educationInstall.roles, (r) => r.name),
				[...educationRoles],
				"the suite names the fixture's roles"
			)
			const once: Option.Option<RealWorld> =
				spec.realization === "once"
					? yield* Effect.asSome(realize(educationInstall, ordinarySession))
					: Option.none()
			return yield* searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: spec.suite,
						draw: drawn(
							programCaseGen(
								constant(educationInstall),
								{ kinds: spec.focus, roles: spec.roles, aims: noAims, lead: spec.lead },
								spec.steps
							)
						),
						literal: Formatter.format,
						coverage: required<Feature>(spec.required, { cases: spec.cases, sense: notesOnly }),
						kept: [],
						runs: spec.cases,
						shrink: { kind: "bounded", candidates: 200 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(pc, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const world = Option.isSome(once) ? once.value : yield* realizedUnder(pc, c)
								const staged = yield* stage(world, pc.install, c.draw, drawnRealities)
								const checks = Arr.map(spec.properties, checkOf)
								yield* driveProgram(staged, pc, c, spec.required, ({ seen, earlier }) => {
									noteSeen(c, seen, earlier)
									for (const check of checks) {
										check({ seen, earlier })
									}
								})
							})
						)
				)
			)
		})
	)
}

/** The registrar of a file's education suites. */
export const educationTests =
	(specs: Arr.NonEmptyReadonlyArray<EducationSuite>) =>
	(it: Vitest.MethodsNonLive<Substrate>): void => {
		for (const spec of specs) {
			register(it, spec)
		}
	}
