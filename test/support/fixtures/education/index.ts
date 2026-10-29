import type { Array as Arr } from "effect"
import { type TextDomain, textDomain } from "#test/support/worlds/model/text.ts"
import type {
	BaseSpec,
	ClosedSpec,
	ContextSpec,
	DerivedSpec,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	InstallSpec,
	LawSpec,
	LoginSpec,
	Occurrence,
	RelationSpec,
	RoleSpec,
	Rule,
	SideSpec,
	Term,
	HostValue
} from "#test/support/worlds/model/types.ts"

const uuid: FieldDomain = { kind: "uuid" }

/** An authentication subject: a person's account, and the token's `sub`. The import service's account is one too. */
const account: FieldDomain = textDomain("^(acct|sis)_[0-9]{1,6}$", "u")

/**
 * A person's name, given and family. No account, note, uuid or attendance status matches its pattern, so a value that
 * does is a name.
 */
export const personName: TextDomain = textDomain("^[A-Z][a-z]{1,15} [A-Z][a-z]{1,15}$", "u")

/** An excuse note's text. */
const noteText: FieldDomain = textDomain("^note [a-z]{1,24}$", "u")

const int32: FieldDomain = { kind: "integer", bits: 32 }

/** A grade's points: a contract over a 32-bit integer whose domain holds 0 to 100. */
const points: FieldDomain = { kind: "contract", name: "Points", bits: 32, min: 0, max: 100 }

/** School days, half-open: a term's calendar and an enrollment's stay in a section. */
const days: FieldDomain = { kind: "span", bits: 32 }

/** How a student attended a section on a day. */
const attendanceStatus: ClosedSpec = {
	name: "AttendanceStatus",
	members: ["Present", "Absent", "Excused"]
}

const status: FieldDomain = {
	kind: "handle",
	closed: attendanceStatus.name,
	members: attendanceStatus.members
}

/** The account the import service records its grades, attendance and notes under: a literal its world fills. */
export const importAccount = "sis_0"

const field = (name: string, domain: FieldDomain): FieldSpec => ({ name, domain })

const relation = (
	name: string,
	fields: Arr.NonEmptyReadonlyArray<FieldSpec>,
	key: Arr.NonEmptyReadonlyArray<string>,
	mutability: RelationSpec["mutability"]
): RelationSpec => ({ name, fields, key, mutability })

const side = (relationName: string, fields: Arr.NonEmptyReadonlyArray<string>): SideSpec => ({
	relation: relationName,
	fields,
	where: {}
})

const contained = (source: SideSpec, target: SideSpec): LawSpec => ({
	kind: "contained",
	source,
	target
})

/**
 * The relations of a multi-tenant school system. Districts hold schools; a school runs terms over its calendar and
 * sections within them, employs teachers, and enrolls students; a teacher teaches a section through an assignment; a
 * guardian has guardianships of students, and a court restriction withdraws a guardianship's access without ending it;
 * a student is enrolled in a section over a span of days, graded once per enrollment and marked present, absent or
 * excused once per enrollment and day, an excused mark carrying its excuse note. Each student has exactly one profile,
 * which holds the name. A grade, a mark and a note name the account that recorded them. An account administers the
 * schools its administrator facts name.
 *
 * Grades and profiles are mutable: a grade is corrected and a name changes in place. Every other fact is added and
 * deleted.
 */
const relations: Arr.NonEmptyReadonlyArray<RelationSpec> = [
	relation("District", [field("id", uuid)], ["id"], "immutable"),
	relation("School", [field("id", uuid), field("district", uuid)], ["id"], "immutable"),
	relation(
		"Term",
		[field("id", uuid), field("school", uuid), field("during", days)],
		["id"],
		"immutable"
	),
	relation(
		"Section",
		[field("id", uuid), field("school", uuid), field("term", uuid), field("capacity", int32)],
		["id"],
		"immutable"
	),
	relation(
		"Teacher",
		[
			field("id", uuid),
			field("school", uuid),
			field("account", account),
			field("name", personName)
		],
		["id"],
		"immutable"
	),
	relation(
		"Assignment",
		[field("teacher", uuid), field("section", uuid)],
		["teacher", "section"],
		"immutable"
	),
	relation(
		"Student",
		[field("id", uuid), field("school", uuid), field("account", account)],
		["id"],
		"immutable"
	),
	relation(
		"StudentProfile",
		[field("student", uuid), field("name", personName)],
		["student"],
		"mutable"
	),
	relation(
		"Guardian",
		[field("id", uuid), field("account", account), field("name", personName)],
		["id"],
		"immutable"
	),
	relation(
		"Guardianship",
		[field("guardian", uuid), field("student", uuid)],
		["guardian", "student"],
		"immutable"
	),
	relation(
		"Restriction",
		[field("guardian", uuid), field("student", uuid)],
		["guardian", "student"],
		"immutable"
	),
	relation(
		"Enrollment",
		[field("id", uuid), field("student", uuid), field("section", uuid), field("during", days)],
		["id"],
		"immutable"
	),
	relation(
		"Grade",
		[field("enrollment", uuid), field("points", points), field("recorder", account)],
		["enrollment"],
		"mutable"
	),
	relation(
		"Attendance",
		[
			field("id", uuid),
			field("enrollment", uuid),
			field("day", int32),
			field("status", status),
			field("recorder", account)
		],
		["id"],
		"immutable"
	),
	relation(
		"ExcuseNote",
		[field("attendance", uuid), field("note", noteText), field("recorder", account)],
		["attendance"],
		"immutable"
	),
	relation(
		"Administrator",
		[field("account", account), field("school", uuid)],
		["account", "school"],
		"immutable"
	)
]

/**
 * The laws of the school system: every reference lands on what it names; a school's terms never overlap, and a
 * section's term is its own school's; an account is one student's, one teacher's and one guardian's at most; a student
 * and a profile come in pairs; a restriction restricts an existing guardianship; a student's stays in one section never
 * overlap, and a section never enrolls more than its capacity; a section seats 1 to 60; a mark is one per enrollment
 * and day, and an excused mark has exactly one note while no other mark has any. A grade's 0 to 100 points are its
 * field's contract, not a law.
 */
const laws: ReadonlyArray<LawSpec> = [
	contained(side("School", ["district"]), side("District", ["id"])),
	contained(side("Term", ["school"]), side("School", ["id"])),
	{ kind: "spanKey", relation: "Term", scalars: ["school"], span: "during", spanAt: "last" },
	contained(side("Section", ["school"]), side("School", ["id"])),
	contained(side("Section", ["term", "school"]), side("Term", ["id", "school"])),
	{
		kind: "check",
		name: "SectionSeats",
		relation: "Section",
		predicate: {
			kind: "and",
			parts: [
				{ kind: "compare", field: "capacity", op: ">=", value: 1 },
				{ kind: "compare", field: "capacity", op: "<=", value: 60 }
			]
		}
	},
	contained(side("Teacher", ["school"]), side("School", ["id"])),
	{ kind: "key", relation: "Teacher", fields: ["account"] },
	contained(side("Assignment", ["teacher"]), side("Teacher", ["id"])),
	contained(side("Assignment", ["section"]), side("Section", ["id"])),
	contained(side("Student", ["school"]), side("School", ["id"])),
	{ kind: "key", relation: "Student", fields: ["account"] },
	{ kind: "mirrors", left: side("Student", ["id"]), right: side("StudentProfile", ["student"]) },
	{ kind: "key", relation: "Guardian", fields: ["account"] },
	contained(side("Guardianship", ["guardian"]), side("Guardian", ["id"])),
	contained(side("Guardianship", ["student"]), side("Student", ["id"])),
	contained(
		side("Restriction", ["guardian", "student"]),
		side("Guardianship", ["guardian", "student"])
	),
	contained(side("Enrollment", ["student"]), side("Student", ["id"])),
	contained(side("Enrollment", ["section"]), side("Section", ["id"])),
	{
		kind: "spanKey",
		relation: "Enrollment",
		scalars: ["student", "section"],
		span: "during",
		spanAt: "first"
	},
	{
		kind: "capacity",
		target: side("Section", ["id"]),
		source: side("Enrollment", ["section"]),
		weight: { kind: "count" },
		low: 0n,
		high: { ref: "capacity" }
	},
	contained(side("Grade", ["enrollment"]), side("Enrollment", ["id"])),
	contained(side("Attendance", ["enrollment"]), side("Enrollment", ["id"])),
	{ kind: "key", relation: "Attendance", fields: ["enrollment", "day"] },
	{
		kind: "alternatives",
		relation: "Attendance",
		tag: "status",
		closed: attendanceStatus.name,
		arms: { Excused: "ExcuseNote" }
	},
	contained(side("Administrator", ["school"]), side("School", ["id"]))
]

/** The signed-in person: the token's top-level `sub`, an account. */
const sessionContext: ContextSpec = {
	name: "Session",
	claim: { kind: "top-level" },
	fields: [field("sub", account)]
}

/** The school a staff session acts for: the claim object `school`. */
const schoolContext: ContextSpec = {
	name: "School",
	claim: { kind: "object", key: "school" },
	fields: [field("id", uuid)]
}

/** The district an analyst's session reports on: the claim object `district`. */
const districtContext: ContextSpec = {
	name: "District",
	claim: { kind: "object", key: "district" },
	fields: [field("id", uuid)]
}

const v = (name: string): Term => ({ kind: "var", name })
const literal = (value: HostValue): Term => ({ kind: "literal", value })
const sub: Term = { kind: "context", context: sessionContext.name, field: "sub" }
const ownSchool: Term = { kind: "context", context: schoolContext.name, field: "id" }
const ownDistrict: Term = { kind: "context", context: districtContext.name, field: "id" }

const at = (name: string, fields: Readonly<Record<string, Term>>): Occurrence => ({
	source: { kind: "ordinary", name },
	fields
})

const rule = (
	matches: Arr.NonEmptyReadonlyArray<Occurrence>,
	negations: ReadonlyArray<Arr.NonEmptyReadonlyArray<Occurrence>>,
	head: Readonly<Record<string, Term>>
): Rule => ({ matches, negations, comparisons: [], head })

const query = (one: Rule): EntrySpec => ({ kind: "query", rules: [one] })

/**
 * Each section's grades, de-identified: the section and the points, never the enrollment or the student. Under set
 * semantics two equal grades of one section are one fact, so a grade drops out only when no other grade of its section
 * holds its points.
 */
const sectionPoints: DerivedSpec = {
	name: "SectionPoints",
	rules: [
		rule(
			[
				at("Grade", { enrollment: v("e"), points: v("p") }),
				at("Enrollment", { id: v("e"), section: v("c") })
			],
			[],
			{ section: v("c"), points: v("p") }
		)
	]
}

/** The school system's base: its relations and laws, the three claims a token carries, and the analysts' rollup. */
export const educationBase: BaseSpec = {
	name: "Education",
	closed: [attendanceStatus],
	relations,
	laws,
	contexts: [sessionContext, schoolContext, districtContext],
	derived: [sectionPoints]
}

/** The student whose account signed in. */
const meAsStudent = at("Student", { id: v("s"), account: sub })

/** The enrollment `e` of student `s`. */
const enrollmentOf = at("Enrollment", { id: v("e"), student: v("s") })

/**
 * A student reads their own enrollments, grades and marks, and their own profile, which they write: a preferred name
 * replaces the old one in place.
 */
const studentRole: RoleSpec = {
	name: "student",
	entries: {
		MyEnrollment: query(
			rule(
				[
					at("Enrollment", { id: v("e"), student: v("s"), section: v("c"), during: v("d") }),
					meAsStudent
				],
				[],
				{ id: v("e"), section: v("c"), during: v("d") }
			)
		),
		MyGrade: query(
			rule([at("Grade", { enrollment: v("e"), points: v("p") }), enrollmentOf, meAsStudent], [], {
				enrollment: v("e"),
				points: v("p")
			})
		),
		MyAttendance: query(
			rule(
				[
					at("Attendance", { id: v("a"), enrollment: v("e"), day: v("y"), status: v("status") }),
					enrollmentOf,
					meAsStudent
				],
				[],
				{ id: v("a"), enrollment: v("e"), day: v("y"), status: v("status") }
			)
		),
		MyProfile: query(
			rule([at("StudentProfile", { student: v("s"), name: v("n") }), meAsStudent], [], {
				student: v("s"),
				name: v("n")
			})
		)
	},
	write: ["MyProfile"],
	refresh: []
}

/** The guardian whose account signed in holds a guardianship of student `s` that no restriction withdraws. */
const myChild: Arr.NonEmptyReadonlyArray<Occurrence> = [
	at("Guardianship", { guardian: v("g"), student: v("s") }),
	at("Guardian", { id: v("g"), account: sub })
]

const restricted: ReadonlyArray<Arr.NonEmptyReadonlyArray<Occurrence>> = [
	[at("Restriction", { guardian: v("g"), student: v("s") })]
]

/** A guardian reads their unrestricted children's records, and nothing else. */
const guardianRole: RoleSpec = {
	name: "guardian",
	entries: {
		Child: query(
			rule([at("Student", { id: v("s"), school: v("h") }), ...myChild], restricted, {
				id: v("s"),
				school: v("h")
			})
		),
		ChildProfile: query(
			rule([at("StudentProfile", { student: v("s"), name: v("n") }), ...myChild], restricted, {
				student: v("s"),
				name: v("n")
			})
		),
		ChildEnrollment: query(
			rule(
				[
					at("Enrollment", { id: v("e"), student: v("s"), section: v("c"), during: v("d") }),
					...myChild
				],
				restricted,
				{ id: v("e"), student: v("s"), section: v("c"), during: v("d") }
			)
		),
		ChildGrade: query(
			rule(
				[at("Grade", { enrollment: v("e"), points: v("p") }), enrollmentOf, ...myChild],
				restricted,
				{
					enrollment: v("e"),
					points: v("p")
				}
			)
		),
		ChildAttendance: query(
			rule(
				[
					at("Attendance", { id: v("a"), enrollment: v("e"), day: v("y"), status: v("status") }),
					enrollmentOf,
					...myChild
				],
				restricted,
				{ id: v("a"), enrollment: v("e"), day: v("y"), status: v("status") }
			)
		),
		ChildExcuse: query(
			rule(
				[
					at("ExcuseNote", { attendance: v("a"), note: v("n") }),
					at("Attendance", { id: v("a"), enrollment: v("e") }),
					enrollmentOf,
					...myChild
				],
				restricted,
				{ attendance: v("a"), note: v("n") }
			)
		)
	},
	write: [],
	refresh: []
}

/** The teacher whose account signed in teaches section `c`. */
const mySection: Arr.NonEmptyReadonlyArray<Occurrence> = [
	at("Assignment", { teacher: v("t"), section: v("c") }),
	at("Teacher", { id: v("t"), account: sub })
]

/** The enrollment `e` in section `c`. */
const enrolledIn = at("Enrollment", { id: v("e"), section: v("c") })

/**
 * A teacher reads their own sections, the enrollments, names, grades and marks in them, and the notes they recorded.
 * They grade and mark through entries that fill the recorder from the token's `sub`, so a grade or a mark is written
 * only in a section the teacher's assignment names and only as recorded by them; an excused mark and its note are one
 * write, since the note's entry reads no relation the marks' entry writes.
 */
const teacherRole: RoleSpec = {
	name: "teacher",
	entries: {
		MySection: query(
			rule(
				[
					at("Section", { id: v("c"), school: v("h"), term: v("m"), capacity: v("k") }),
					...mySection
				],
				[],
				{
					id: v("c"),
					school: v("h"),
					term: v("m"),
					capacity: v("k")
				}
			)
		),
		SectionEnrollment: query(
			rule(
				[
					at("Enrollment", { id: v("e"), student: v("s"), section: v("c"), during: v("d") }),
					...mySection
				],
				[],
				{ id: v("e"), student: v("s"), section: v("c"), during: v("d") }
			)
		),
		SectionRoster: query(
			rule(
				[
					at("StudentProfile", { student: v("s"), name: v("n") }),
					at("Enrollment", { student: v("s"), section: v("c") }),
					...mySection
				],
				[],
				{ student: v("s"), name: v("n") }
			)
		),
		SectionGrade: query(
			rule(
				[
					at("Grade", { enrollment: v("e"), points: v("p"), recorder: v("r") }),
					enrolledIn,
					...mySection
				],
				[],
				{ enrollment: v("e"), points: v("p"), recorder: v("r") }
			)
		),
		GradeBook: query(
			rule(
				[
					at("Grade", { enrollment: v("e"), points: v("p"), recorder: sub }),
					enrolledIn,
					...mySection
				],
				[],
				{
					enrollment: v("e"),
					points: v("p")
				}
			)
		),
		SectionAttendance: query(
			rule(
				[
					at("Attendance", {
						id: v("a"),
						enrollment: v("e"),
						day: v("y"),
						status: v("status"),
						recorder: v("r")
					}),
					enrolledIn,
					...mySection
				],
				[],
				{ id: v("a"), enrollment: v("e"), day: v("y"), status: v("status"), recorder: v("r") }
			)
		),
		AttendanceBook: query(
			rule(
				[
					at("Attendance", {
						id: v("a"),
						enrollment: v("e"),
						day: v("y"),
						status: v("status"),
						recorder: sub
					}),
					enrolledIn,
					...mySection
				],
				[],
				{ id: v("a"), enrollment: v("e"), day: v("y"), status: v("status") }
			)
		),
		ExcuseBook: query(
			rule(
				[
					at("ExcuseNote", { attendance: v("a"), note: v("n"), recorder: sub }),
					at("Teacher", { account: sub })
				],
				[],
				{ attendance: v("a"), note: v("n") }
			)
		)
	},
	write: ["GradeBook", "AttendanceBook", "ExcuseBook"],
	refresh: []
}

/** The signed-in account administers the school the token's `school` claim names. */
const administers = at("Administrator", { account: sub, school: ownSchool })

/**
 * A school administrator reads the students, profiles, terms and sections of the school their token's `school` claim
 * names, when their account administers it, and enrolls that school's students in that school's sections. A token
 * that names a school the account no longer administers reaches nothing.
 */
const schoolAdminRole: RoleSpec = {
	name: "school_admin",
	entries: {
		SchoolStudent: query(
			rule([at("Student", { id: v("s"), school: ownSchool, account: v("u") }), administers], [], {
				id: v("s"),
				account: v("u")
			})
		),
		SchoolProfile: query(
			rule(
				[
					at("StudentProfile", { student: v("s"), name: v("n") }),
					at("Student", { id: v("s"), school: ownSchool }),
					administers
				],
				[],
				{ student: v("s"), name: v("n") }
			)
		),
		SchoolTerm: query(
			rule([at("Term", { id: v("m"), school: ownSchool, during: v("d") }), administers], [], {
				id: v("m"),
				during: v("d")
			})
		),
		SchoolSection: query(
			rule(
				[
					at("Section", { id: v("c"), school: ownSchool, term: v("m"), capacity: v("k") }),
					administers
				],
				[],
				{
					id: v("c"),
					term: v("m"),
					capacity: v("k")
				}
			)
		),
		SchoolEnrollment: query(
			rule(
				[
					at("Enrollment", { id: v("e"), student: v("s"), section: v("c"), during: v("d") }),
					at("Student", { id: v("s"), school: ownSchool }),
					at("Section", { id: v("c"), school: ownSchool }),
					administers
				],
				[],
				{ id: v("e"), student: v("s"), section: v("c"), during: v("d") }
			)
		)
	},
	write: ["SchoolEnrollment"],
	refresh: []
}

/**
 * A district analyst reads the de-identified rollup whole and refreshes it, and reads the ids of the sections of the
 * district their token's `district` claim names: no student, enrollment, account or name.
 */
const districtAnalystRole: RoleSpec = {
	name: "district_analyst",
	entries: {
		SectionPoints: { kind: "whole", relation: sectionPoints.name },
		DistrictSection: query(
			rule(
				[
					at("Section", { id: v("c"), school: v("h") }),
					at("School", { id: v("h"), district: ownDistrict })
				],
				[],
				{ id: v("c") }
			)
		)
	},
	write: [],
	refresh: [sectionPoints.name]
}

/**
 * The student information system's import reads enrollment ids, and writes grades, marks and notes recorded under its
 * own account, which its entries fill as a literal: it reads back only what it recorded. It reads no context, so no
 * claim it sets changes what it reaches.
 */
const importerRole: RoleSpec = {
	name: "importer",
	entries: {
		EnrollmentId: query(rule([at("Enrollment", { id: v("e") })], [], { id: v("e") })),
		ImportGrade: query(
			rule(
				[at("Grade", { enrollment: v("e"), points: v("p"), recorder: literal(importAccount) })],
				[],
				{
					enrollment: v("e"),
					points: v("p")
				}
			)
		),
		ImportAttendance: query(
			rule(
				[
					at("Attendance", {
						id: v("a"),
						enrollment: v("e"),
						day: v("y"),
						status: v("status"),
						recorder: literal(importAccount)
					})
				],
				[],
				{ id: v("a"), enrollment: v("e"), day: v("y"), status: v("status") }
			)
		),
		ImportExcuse: query(
			rule(
				[at("ExcuseNote", { attendance: v("a"), note: v("n"), recorder: literal(importAccount) })],
				[],
				{
					attendance: v("a"),
					note: v("n")
				}
			)
		)
	},
	write: ["ImportGrade", "ImportAttendance", "ImportExcuse"],
	refresh: []
}

/** The web application's login holds every person's role; the analytics and import logins are trust domains of their own. */
const logins: Arr.NonEmptyReadonlyArray<LoginSpec> = [
	{
		name: "web",
		roles: [studentRole.name, guardianRole.name, teacherRole.name, schoolAdminRole.name]
	},
	{ name: "analytics", roles: [districtAnalystRole.name] },
	{ name: "sis", roles: [importerRole.name] }
]

/** The school system's worlds: each role and the login that holds it. */
export const educationInstall: InstallSpec = {
	base: educationBase,
	roles: [
		studentRole,
		guardianRole,
		teacherRole,
		schoolAdminRole,
		districtAnalystRole,
		importerRole
	],
	logins
}
