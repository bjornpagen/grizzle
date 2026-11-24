import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The scoped entries program: every way a caller states scopedEntriesOf's options and holds its entries in a role, each
 * a statement over Sitting (Assignment rooted by its student, SittingEvent reached through Assignment's number, Content
 * whole), under the directive the type-test batch disarms exactly where the rule refuses it. The rule, the oracle: the
 * entries are wholeEntriesOf's, each ordinary or stored derived relation whole or scoped, so a role holding them
 * holds every relation of its base under its own name, its role relation the base relation itself, and runs the base's
 * programs; its write list names the ordinary ones; a root names a relation of the base by one of its fields; and a role
 * holding a relation through a query entry of its own, scoped or not by its shape, holds no level of the base. Each
 * statement is a cell of the box.
 */

/** A cell: what it states, its statement, and the rule's verdict, admitted or refused by the types. */
interface ScopedCase {
	readonly what: string
	readonly statement: string
	readonly verdict:
		| { readonly kind: "admitted" }
		| { readonly kind: "refused"; readonly why: string }
}

const admitted = { kind: "admitted" } as const

const boxCases: ReadonlyArray<ScopedCase> = [
	{
		what: "a role holding the scoped entries",
		statement:
			'role(Sitting, "student", scopedEntriesOf(Sitting, { owner: persons, roots: { Assignment: "student" } }), { contexts: [Session] })',
		verdict: admitted
	},
	{
		what: "a workload over the role of a program over its base",
		statement: "workload(Student, { mine })",
		verdict: admitted
	},
	{
		what: "the role's relation under a scoped relation's name, the base relation itself",
		statement: "Student.relations.Assignment satisfies typeof Assignment",
		verdict: admitted
	},
	{
		what: "an insert list naming a scoped closed relation and a whole one",
		statement:
			'role(Sitting, "writer", scopedEntriesOf(Sitting, { owner: persons, roots: { Assignment: "student" } }), { insert: ["SittingEvent", "Content"], contexts: [Session] })',
		verdict: admitted
	},
	{
		what: "a root naming no relation of the base",
		statement: 'scopedEntriesOf(Sitting, { owner: persons, roots: { Nowhere: "student" } })',
		verdict: { kind: "refused", why: "a root names a relation of the base" }
	},
	{
		what: "a root naming no field of its relation",
		statement: 'scopedEntriesOf(Sitting, { owner: persons, roots: { Assignment: "nobody" } })',
		verdict: { kind: "refused", why: "a root names a field of its relation" }
	},
	{
		what: "a workload over a role holding Assignment through a query entry of its own",
		statement: "workload(Partial, { mine })",
		verdict: {
			kind: "refused",
			why: "a role holding a relation through a query entry holds no level of its base"
		}
	}
]

/** The cells of scopedEntriesBox, minted as a dictionary in its door (test/types/schema/scoped-entries.dictionary.ts). */
export const scopedEntriesBoxItems: Arr.NonEmptyReadonlyArray<ScopedCase> = [
	defined(boxCases[0], "a case of the scoped entries box"),
	...Arr.drop(boxCases, 1)
]

const directiveOf = (c: ScopedCase): ReadonlyArray<string> =>
	c.verdict.kind === "admitted" ? [] : [`// @ts-expect-error -- refused: ${c.verdict.why}`]

const caseBlock = (c: ScopedCase, index: number): ReadonlyArray<string> => [
	`// ${c.what}`,
	...directiveOf(c),
	`export const c${index} = ${c.statement}`,
	""
]

/** The program's prelude (test/support/programs/scoped-entries.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/scoped-entries.ts"))

/** Sitting: Person, ClerkAccount, Assignment rooted by its student, SittingEvent reached by its number, Content whole;
 * the owner, the persons a session signs in as; Student holding the scoped entries; Partial holding Assignment through
 * a query entry of its own; and a program over the base. */
const scopedHeader = `const Name = str.regex("^[a-z]{1,8}$")
export const Person = relation("Person", { person: Name }, ["person"])
export const ClerkAccount = relation("ClerkAccount", { clerk: Name, person: Name }, ["clerk"])
export const Assignment = relation("Assignment", { number: pg.bigint, student: Name }, ["number"])
export const SittingEvent = relation("SittingEvent", { number: pg.bigint, step: pg.bigint }, ["number", "step"])
export const Content = relation("Content", { pkg: Name }, ["pkg"])
export const Sitting = schema("Sitting", [Person, ClerkAccount, Assignment, SittingEvent, Content], [contained(on(Assignment, "student"), on(Person, "person")), contained(on(SittingEvent, "number"), on(Assignment, "number"))])
export const Session = context("Session", { sub: Name })
export const persons = query(Sitting).rule((r) => { const { sub } = v(Session, "session"); const { person } = v(ClerkAccount, "account"); return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, person }).find({ person }) })
export const Student = role(Sitting, "student", scopedEntriesOf(Sitting, { owner: persons, roots: { Assignment: "student" } }), { contexts: [Session] })
export const own = query(Sitting).rule((r) => { const { number, student } = v(Assignment, "a"); return r.match(Assignment, { number, student }).match(persons, { person: student }).find({ number, student }) })
export const Partial = role(Sitting, "partial", { Person, ClerkAccount, Assignment: own, SittingEvent, Content }, { contexts: [Session] })
export const mine = query(Sitting).rule((r) => { const { number } = v(Assignment, "a"); return r.match(Assignment, { number }).find({ number }) })
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const scopedEntriesProgram = (
	cells: Arr.NonEmptyReadonlyArray<ScopedCase>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/scoped-entries.ts: every way a caller states scoped entries and holds them in a role.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(scopedHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
