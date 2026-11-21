/** What the property of slice.test.ts reads: its schema and role, its space of programs and databases, and its models. */

import { defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	element,
	type Gen,
	int,
	oneOf,
	subarray
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import type {
	BindingsDesc,
	ExprDesc,
	FieldDesc,
	HeadTermDesc,
	MatchDesc,
	QueryDesc,
	QueryStageDesc,
	RuleDesc,
	SchemaDesc,
	VarDesc
} from "#compiler/ir/desc.ts"
import { parseSchemaInput, type ParsedRole, type SchemaInput } from "#compiler/program/schema.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	context,
	on,
	relation,
	role,
	schema,
	scopedEntriesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"

/**
 * Condition three of scoped entries (program/slice.ts): a program over a role's base runs on a role holding relations
 * scoped only where it means, over the owner's rows, what it means over every row kept to the owner's.
 *
 * The schema is a sitting's, as metis's student holds it: Assignment(number), rooted by its `student`; SittingEvent
 * (number, step) and Note(id), each reached by its `number` through Assignment's key; TestSession(child, stage), rooted
 * by its `child`; Content, whole. The owner is the persons the session's Clerk user signs in as (Session ⋈
 * ClerkAccount). A program is one rule of positive matches, drawn over those relations with each field free, bound to
 * one of two variables of its class, to its class's parameter or to a literal, then one read: none (`plain`), a
 * negation of one more match, a count grouped by some of its variables, or a take of its first rows. A database draws
 * each relation's rows over small domains (two persons, three numbers, two steps), so groups that mix owners, negated
 * rows of another owner and takes over several owners all meet; and a session of either person or of none.
 *
 * The model is the definition of row by row (`expected`): the owner's part of the program's answer over every row,
 * each answer a derivation of the owner's rows alone shows, a negation decided over every row, a count of a group
 * whose every row is the owner's at its whole count, a take of the whole answer's first rows kept to the owner's. The
 * role's answer (`roleAnswer`) is the program over the slice, each scoped relation's rows the owner's, as PostgreSQL
 * reads them. A program the analysis admits must agree with the model over every database; one it refuses is never
 * run on the role. Programs built pinned (`pinnedGen`), whose every negation, group and take the scopes' pins fix,
 * must be admitted.
 */

const Name = str.regex("^[a-z]{1,8}$")

export const Person = relation("Person", { person: Name }, ["person"])
export const ClerkAccount = relation("ClerkAccount", { clerk: Name, person: Name }, ["clerk"])
export const Assignment = relation("Assignment", { number: pg.bigint, student: Name, test: Name }, [
	"number"
])
export const SittingEvent = relation(
	"SittingEvent",
	{ number: pg.bigint, step: pg.bigint, kind: Name },
	["number", "step"]
)
export const Note = relation("Note", { id: pg.bigint, number: pg.bigint, text: Name }, ["id"])
export const TestSession = relation("TestSession", { child: Name, stage: pg.bigint, pkg: Name }, [
	"child",
	"stage"
])
export const Content = relation("Content", { pkg: Name, title: Name }, ["pkg"])

export const Slices = schema(
	"Slices",
	[Person, ClerkAccount, Assignment, SittingEvent, Note, TestSession, Content],
	[
		contained(on(ClerkAccount, "person"), on(Person, "person")),
		contained(on(Assignment, "student"), on(Person, "person")),
		contained(on(SittingEvent, "number"), on(Assignment, "number")),
		contained(on(Note, "number"), on(Assignment, "number"))
	]
)

export const Session = context("Session", { sub: Name })

/** The persons the session's Clerk user signs in as: the owner. */
export const persons = query(Slices).rule((r) => {
	const { sub } = v(Session, "session")
	const { person } = v(ClerkAccount, "account")
	return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, person }).find({ person })
})

export const Student = role(
	Slices,
	"student",
	scopedEntriesOf(Slices, {
		owner: persons,
		roots: { Assignment: "student", TestSession: "child" }
	}),
	{ contexts: [Session] }
)

const parsed = (value: unknown): SchemaInput => {
	const input = parseSchemaInput(value)
	if (!input.ok) {
		throw input.error
	}
	return input.value
}

/** The schema and the role as the compiler parses them, once. */
export const slicesInput: SchemaInput = parsed(Slices)
const studentInput = parsed(Student)
const roleOf = (input: SchemaInput): ParsedRole | undefined =>
	input.kind === "role" ? input : undefined
export const studentRole: ParsedRole = defined(
	roleOf(studentInput),
	"the student role parses as a role"
)
export const slicesDesc: SchemaDesc = defined(
	schemaDescOf(Slices),
	"the Slices schema's Description"
)

/** A field's class: the values it holds, and the variables, parameter and literal a program binds it to. */
type Class = "num" | "step" | "person" | "text"

/** The relations a program reads, each field with its class, and which the role holds scoped. */
const relations = {
	Assignment: { fields: { number: "num", student: "person", test: "text" }, scoped: true },
	SittingEvent: { fields: { number: "num", step: "step", kind: "text" }, scoped: true },
	Note: { fields: { id: "step", number: "num", text: "text" }, scoped: true },
	TestSession: { fields: { child: "person", stage: "step", pkg: "text" }, scoped: true },
	Content: { fields: { pkg: "text", title: "text" }, scoped: false }
} as const satisfies Readonly<
	Record<string, { readonly fields: Readonly<Record<string, Class>>; readonly scoped: boolean }>
>

export type Rel = keyof typeof relations
const relNames: readonly [Rel, ...Array<Rel>] = [
	"Assignment",
	"SittingEvent",
	"Note",
	"TestSession",
	"Content"
]

const fieldsOf = (r: Rel): ReadonlyArray<readonly [string, Class]> => {
	const fields: Readonly<Record<string, Class>> = relations[r].fields
	return Rec.toEntries(fields)
}

/** A term a field of a match is bound to: a variable of its class (`v`, one of two), its class's parameter, or its
 * class's literal. */
export type Term =
	| { readonly kind: "var"; readonly cls: Class; readonly n: 0 | 1 }
	| { readonly kind: "param"; readonly cls: Class }
	| { readonly kind: "literal"; readonly cls: Class }

/** A match: a relation, and the fields it binds, each to its term; every other field free. */
export interface Atom {
	readonly relation: Rel
	readonly bind: ReadonlyArray<readonly [string, Term]>
}

/** The one read a program makes beside its positive matches. */
export type Read =
	| { readonly kind: "plain" }
	| { readonly kind: "negation"; readonly atom: Atom }
	| { readonly kind: "count"; readonly group: ReadonlyArray<Term> }
	| { readonly kind: "take"; readonly k: 1 | 2 }

/** A program: its positive matches and its read; pinned where it was built so (`pinnedGen`). */
export interface Program {
	readonly atoms: readonly [Atom, ...Array<Atom>]
	readonly read: Read
	readonly pinned: boolean
}

const varName = (t: Extract<Term, { readonly kind: "var" }>): string => `${t.cls}${t.n}`

const termGen =
	(cls: Class): Gen<Term | undefined> =>
	(s) =>
		s.draw(
			element([
				undefined,
				{ kind: "var", cls, n: 0 },
				{ kind: "var", cls, n: 1 },
				{ kind: "param", cls },
				{ kind: "literal", cls }
			] as const)
		)

const atomGen =
	(among: ReadonlyArray<Rel> & Readonly<{ 0: Rel }>): Gen<Atom> =>
	(s) => {
		const r = s.draw(element(among))
		const bind = Arr.flatMap(
			fieldsOf(r),
			([field, cls]): ReadonlyArray<readonly [string, Term]> => {
				const t = s.draw(termGen(cls))
				return t === undefined ? [] : [[field, t]]
			}
		)
		return { relation: r, bind }
	}

/** The variables a program's positive matches bind, each once, in their order. */
export const boundVars = (
	atoms: ReadonlyArray<Atom>
): ReadonlyArray<Extract<Term, { readonly kind: "var" }>> => {
	const seen = new Map<string, Extract<Term, { readonly kind: "var" }>>()
	for (const a of atoms) {
		for (const [, t] of a.bind) {
			if (t.kind === "var" && !seen.has(varName(t))) {
				seen.set(varName(t), t)
			}
		}
	}
	return [...seen.values()]
}

/** A drawn program: one or two positive matches, then any read over them. */
const drawnGen: Gen<Program> = (s) => {
	const atoms = s.draw(array(atomGen(relNames), { min: 1, max: 2 }))
	const [first, ...rest] = atoms
	const head = first ?? s.draw(atomGen(relNames))
	const all: readonly [Atom, ...Array<Atom>] = [head, ...rest]
	const vars = boundVars(all)
	const read = s.draw(
		oneOf<Read>([
			() => ({ kind: "plain" }),
			(d) => ({ kind: "negation", atom: d.draw(atomGen(relNames)) }),
			(d) => ({ kind: "count", group: d.draw(subarray(vars)) }),
			(d) =>
				vars.length === 0
					? { kind: "plain" }
					: { kind: "take", k: d.draw(element([1, 2] as const)) }
		])
	)
	return { atoms: all, read, pinned: false }
}

const n0: Term = { kind: "var", cls: "num", n: 0 }
const n1: Term = { kind: "var", cls: "num", n: 1 }
const s0: Term = { kind: "var", cls: "person", n: 0 }
const k0: Term = { kind: "var", cls: "step", n: 0 }
const k1: Term = { kind: "var", cls: "step", n: 1 }
const pnum: Term = { kind: "param", cls: "num" }
const pperson: Term = { kind: "param", cls: "person" }
const lperson: Term = { kind: "literal", cls: "person" }

/**
 * A program built across owners, which no pin fixes: a negation of TestSession at bob, the person literal, or at the
 * person a parameter names, beside an assignment; a negation of SittingEvent at any number beside a note; a count of SittingEvent grouped by its step,
 * whose groups hold several assignments' events; or a take of SittingEvent's first rows over every number. The drawn
 * programs reach these too, but a database meets their difference only where another owner's rows stand where they
 * read, so a share of the cases builds them, and the databases hold both persons' rows.
 */
const crossPrograms: readonly [Program, ...Array<Program>] = [
	{
		atoms: [{ relation: "Assignment", bind: [["number", n0]] }],
		read: { kind: "negation", atom: { relation: "TestSession", bind: [["child", lperson]] } },
		pinned: false
	},
	{
		atoms: [{ relation: "Assignment", bind: [["number", n0]] }],
		read: { kind: "negation", atom: { relation: "TestSession", bind: [["child", pperson]] } },
		pinned: false
	},
	{
		atoms: [
			{
				relation: "Note",
				bind: [
					["id", k0],
					["number", n0]
				]
			}
		],
		read: { kind: "negation", atom: { relation: "SittingEvent", bind: [["number", n1]] } },
		pinned: false
	},
	{
		atoms: [
			{
				relation: "SittingEvent",
				bind: [
					["number", n0],
					["step", k0]
				]
			}
		],
		read: { kind: "count", group: [k0] },
		pinned: false
	},
	{
		atoms: [
			{
				relation: "SittingEvent",
				bind: [
					["number", n0],
					["step", k0]
				]
			}
		],
		read: { kind: "take", k: 1 },
		pinned: false
	}
]

const crossGen: Gen<Program> = element(crossPrograms)

/**
 * A program built pinned: a negation of SittingEvent or Note at a number a positive match of Assignment, SittingEvent
 * or Note binds, all reached through Assignment's key; of TestSession at a child a match of Assignment or TestSession
 * binds, both rooted by the owner's person; a count over SittingEvent grouped by its number; or a take of SittingEvent
 * at a number a parameter fixes.
 */
const pinnedGen: Gen<Program> = (s) =>
	s.draw(
		element<Program>([
			{
				atoms: [{ relation: "Assignment", bind: [["number", n0]] }],
				read: { kind: "negation", atom: { relation: "SittingEvent", bind: [["number", n0]] } },
				pinned: true
			},
			{
				atoms: [
					{
						relation: "SittingEvent",
						bind: [
							["number", n0],
							["step", k0]
						]
					}
				],
				read: {
					kind: "negation",
					atom: {
						relation: "SittingEvent",
						bind: [
							["number", n0],
							["step", k1]
						]
					}
				},
				pinned: true
			},
			{
				atoms: [
					{
						relation: "Note",
						bind: [
							["number", n0],
							["id", k0]
						]
					}
				],
				read: { kind: "negation", atom: { relation: "SittingEvent", bind: [["number", n0]] } },
				pinned: true
			},
			{
				atoms: [{ relation: "Assignment", bind: [["student", s0]] }],
				read: { kind: "negation", atom: { relation: "TestSession", bind: [["child", s0]] } },
				pinned: true
			},
			{
				atoms: [
					{
						relation: "TestSession",
						bind: [
							["child", s0],
							["stage", k0]
						]
					}
				],
				read: {
					kind: "negation",
					atom: {
						relation: "TestSession",
						bind: [
							["child", s0],
							["stage", k1]
						]
					}
				},
				pinned: true
			},
			{
				atoms: [
					{
						relation: "SittingEvent",
						bind: [
							["number", n0],
							["step", k0]
						]
					}
				],
				read: { kind: "count", group: [n0] },
				pinned: true
			},
			{
				atoms: [
					{
						relation: "SittingEvent",
						bind: [
							["number", pnum],
							["step", k0]
						]
					}
				],
				read: { kind: "take", k: 1 },
				pinned: true
			}
		])
	)

/** A database: each relation's rows, and the session's Clerk user, if any. */
export interface Database {
	readonly rows: Readonly<Record<Rel, ReadonlyArray<Readonly<Record<string, Value>>>>>
	readonly clerk: string | undefined
}

export type Value = bigint | string

const people = ["ann", "bob"] as const
/** Each person's one Clerk user. */
const clerkOf: Readonly<Record<(typeof people)[number], string>> = { ann: "cann", bob: "cbob" }

const valueGen =
	(cls: Class): Gen<Value> =>
	(s) => {
		switch (cls) {
			case "num":
				return BigInt(s.draw(int(1, 3)))
			case "step":
				return BigInt(s.draw(int(1, 2)))
			case "person":
				return s.draw(element(people))
			case "text":
				return s.draw(element(["a", "b"] as const))
		}
	}

/** A relation's rows over its classes' domains, each its key's once (the first drawn kept). */
const rowsGen =
	(r: Rel, key: ReadonlyArray<string>): Gen<ReadonlyArray<Readonly<Record<string, Value>>>> =>
	(s) => {
		const drawn = s.draw(
			array(
				(d): Readonly<Record<string, Value>> =>
					Rec.fromEntries(
						Arr.map(fieldsOf(r), ([field, cls]) => [field, d.draw(valueGen(cls))] as const)
					),
				{ min: 0, max: 4 }
			)
		)
		const seen = new Set<string>()
		return Arr.filter(drawn, (row) => {
			const k = Arr.join(
				Arr.map(key, (f) => String(row[f])),
				" "
			)
			if (seen.has(k)) {
				return false
			}
			seen.add(k)
			return true
		})
	}

/** `rows` after `first`, each key's once, `first`'s kept. */
const after = (
	first: ReadonlyArray<Readonly<Record<string, Value>>>,
	rows: ReadonlyArray<Readonly<Record<string, Value>>>,
	key: ReadonlyArray<string>
): ReadonlyArray<Readonly<Record<string, Value>>> => {
	const keyOf = (row: Readonly<Record<string, Value>>): string =>
		Arr.join(
			Arr.map(key, (f) => String(row[f])),
			" "
		)
	const taken = new Set(Arr.map(first, keyOf))
	return [...first, ...Arr.filter(rows, (row) => !taken.has(keyOf(row)))]
}

/**
 * A database: both persons' rows first, so every one holds rows of two owners where each cross-owner program reads
 * them (bob's assignment 1 and ann's 2, an event of each at step 1, a session of each at stage 1), then the drawn ones.
 */
const databaseOf =
	(clerk: Gen<string | undefined>): Gen<Database> =>
	(s) => {
		const assignments = [
			{ number: 1n, student: "bob", test: "a" },
			{ number: 2n, student: "ann", test: "a" },
			...Arr.filter(s.draw(rowsGen("Assignment", ["number"])), (a) => a["number"] === 3n)
		]
		const numbers = new Set(
			Arr.map(assignments, (a) => defined(a["number"], "an assignment's number"))
		)
		const reached = (rows: ReadonlyArray<Readonly<Record<string, Value>>>) =>
			Arr.filter(rows, (row) => numbers.has(defined(row["number"], "a row's number")))
		return {
			rows: {
				Assignment: assignments,
				SittingEvent: after(
					[
						{ number: 1n, step: 1n, kind: "a" },
						{ number: 2n, step: 1n, kind: "a" }
					],
					reached(s.draw(rowsGen("SittingEvent", ["number", "step"]))),
					["number", "step"]
				),
				Note: reached(s.draw(rowsGen("Note", ["id"]))),
				TestSession: after(
					[
						{ child: "ann", stage: 1n, pkg: "a" },
						{ child: "bob", stage: 1n, pkg: "a" }
					],
					s.draw(rowsGen("TestSession", ["child", "stage"])),
					["child", "stage"]
				),
				Content: s.draw(rowsGen("Content", ["pkg"]))
			},
			clerk: s.draw(clerk)
		}
	}

const databaseGen: Gen<Database> = databaseOf(
	element([clerkOf.ann, clerkOf.bob, undefined] as const)
)

/** A case: a program, drawn or built pinned, a database and the values of its parameters. */
export interface SliceCase {
	readonly program: Program
	readonly database: Database
	readonly params: Readonly<Record<Class, Value>>
}

const paramsGen: Gen<SliceCase["params"]> = (s) => ({
	num: s.draw(valueGen("num")),
	step: s.draw(valueGen("step")),
	person: s.draw(valueGen("person")),
	text: s.draw(valueGen("text"))
})

const sliceCaseGen: Gen<SliceCase> = (s) => ({
	program: s.draw(oneOf([crossGen, pinnedGen, drawnGen])),
	database: s.draw(databaseGen),
	params: s.draw(paramsGen)
})

/**
 * A case of `program` on a database ann's session reads: bob holds assignment 1, the first row every take orders, an
 * event at the step ann's event shares, and a session, so each cross-owner read of `program` meets his rows.
 */
const annCase =
	(program: Program): Gen<SliceCase> =>
	(s) => ({
		program,
		database: s.draw(databaseOf(() => clerkOf.ann)),
		params: s.draw(paramsGen)
	})

const crossOf = (read: Read["kind"]): Program =>
	defined(
		Option.getOrUndefined(Arr.findFirst(crossPrograms, (p) => p.read.kind === read)),
		`a cross-owner ${read}`
	)

/**
 * The cases: drawn ones, and, aimed at each cross-owner read still pending, one built to meet another owner's rows,
 * which the role refuses and row by row tells apart from what the slice reads (the floor and steered phases' cases,
 * which a kill turns red).
 */
export const sliceSpace: Aimed<SliceCase, SliceFeature> = aimed(sliceCaseGen, [
	["a cross-owner negation refused", annCase(crossOf("negation"))],
	["a cross-owner count refused", annCase(crossOf("count"))],
	["a cross-owner take refused", annCase(crossOf("take"))]
])

const loc = SourceLoc("slice case", [])

/** A field's declared type, as a parameter of it states it. */
const fieldDesc = (r: Rel, field: string): FieldDesc => {
	const desc = Option.getOrUndefined(Arr.findFirst(slicesDesc.relations, (x) => x.name === r))
	return defined(
		desc?.kind === "relation" ? desc.fields[field]?.type : undefined,
		`the field ${r}.${field}`
	)
}

/** A class's literal: a value of its domain no drawn row need hold. */
const literalOf: Readonly<Record<Class, Value>> = { num: 1n, step: 1n, person: "bob", text: "a" }

const termDesc = (t: Term, r: Rel, field: string): ExprDesc => {
	switch (t.kind) {
		case "var":
			return { kind: "var", var: varName(t) }
		case "param":
			return { kind: "param", name: `p${t.cls}`, type: fieldDesc(r, field) }
		case "literal":
			return { kind: "literal", value: literalOf[t.cls] }
	}
}

const bindingsOf = (a: Atom): BindingsDesc =>
	Rec.fromEntries(Arr.map(a.bind, ([field, t]) => [field, termDesc(t, a.relation, field)] as const))

const matchOf = (a: Atom): MatchDesc => ({
	loc,
	source: { kind: "relation", name: a.relation },
	bindings: bindingsOf(a)
})

/** A program's Description: its one rule over its matches, its read in its filters, its head or its stages. */
export const programDesc = (p: Program): QueryDesc => {
	const vars = boundVars(p.atoms)
	const varDescs = Arr.map(vars, (t): VarDesc => ({ id: varName(t), origin: undefined, loc }))
	const plainHead: Readonly<Record<string, HeadTermDesc>> = Rec.fromEntries(
		Arr.map(vars, (t) => [varName(t), { kind: "var", var: varName(t) }] as const)
	)
	const head: Readonly<Record<string, HeadTermDesc>> =
		p.read.kind === "count"
			? {
					...Rec.fromEntries(
						Arr.flatMap(p.read.group, (t, i): ReadonlyArray<readonly [string, HeadTermDesc]> =>
							t.kind === "var" ? [[`g${i}`, { kind: "var", var: varName(t) }]] : []
						)
					),
					n: { kind: "aggregate", fn: "count" }
				}
			: plainHead
	const rule: RuleDesc = {
		loc,
		vars: varDescs,
		matches: Arr.map(p.atoms, matchOf),
		where:
			p.read.kind === "negation"
				? [
						{
							kind: "absent",
							source: { kind: "relation", name: p.read.atom.relation },
							bindings: bindingsOf(p.read.atom)
						}
					]
				: [],
		head,
		interiors: [],
		attach: []
	}
	const rules: QueryStageDesc = { kind: "rules", loc, arms: [rule] }
	const [first] = vars
	return {
		stage:
			p.read.kind === "take" && first !== undefined
				? {
						kind: "take",
						loc,
						input: {
							kind: "order",
							loc,
							input: rules,
							order: Arr.map(vars, (t) => ({ column: varName(t), dir: "asc" }))
						},
						take: { kind: "literal", k: p.read.k }
					}
				: rules
	}
}

/** One derivation of the rule over some rows: its variables' values, and the rows of the scoped relations it matched. */
interface Derivation {
	readonly env: ReadonlyMap<string, Value>
	readonly scopedRows: ReadonlyArray<readonly [Rel, Readonly<Record<string, Value>>]>
}

/** The persons the session's Clerk user signs in as. */
const ownersOf = (db: Database): ReadonlySet<string> =>
	new Set(
		db.clerk === undefined ? [] : Arr.filter(people, (person) => clerkOf[person] === db.clerk)
	)

/** Whether a row of a scoped relation is the owner's, by its scope: its root field the owner's, or its number an
 * assignment's of the owner's. */
const ownersRow = (db: Database, r: Rel, row: Readonly<Record<string, Value>>): boolean => {
	const owners = ownersOf(db)
	switch (r) {
		case "Assignment":
			return owners.has(String(row["student"]))
		case "TestSession":
			return owners.has(String(row["child"]))
		case "SittingEvent":
		case "Note":
			return Arr.some(
				db.rows.Assignment,
				(a) => a["number"] === row["number"] && owners.has(String(a["student"]))
			)
		case "Content":
			return true
	}
}

/** The database as the role reads it: each scoped relation's rows the owner's. */
const sliceOf = (db: Database): Database => ({
	clerk: db.clerk,
	rows: {
		Assignment: Arr.filter(db.rows.Assignment, (row) => ownersRow(db, "Assignment", row)),
		SittingEvent: Arr.filter(db.rows.SittingEvent, (row) => ownersRow(db, "SittingEvent", row)),
		Note: Arr.filter(db.rows.Note, (row) => ownersRow(db, "Note", row)),
		TestSession: Arr.filter(db.rows.TestSession, (row) => ownersRow(db, "TestSession", row)),
		Content: db.rows.Content
	}
})

/** The value a term holds under `env`, or none for a variable it leaves unbound. */
const valueOf = (
	t: Term,
	env: ReadonlyMap<string, Value>,
	params: SliceCase["params"]
): Value | undefined => {
	switch (t.kind) {
		case "var":
			return env.get(varName(t))
		case "param":
			return params[t.cls]
		case "literal":
			return literalOf[t.cls]
	}
}

/** Every derivation of the program's positive matches over `db`. */
const derivations = (
	p: Program,
	db: Database,
	params: SliceCase["params"]
): ReadonlyArray<Derivation> => {
	let out: ReadonlyArray<Derivation> = [{ env: new Map(), scopedRows: [] }]
	for (const a of p.atoms) {
		out = Arr.flatMap(out, (d) =>
			Arr.flatMap(db.rows[a.relation], (row): ReadonlyArray<Derivation> => {
				const env = new Map(d.env)
				for (const [field, t] of a.bind) {
					const held = row[field]
					const given = valueOf(t, env, params)
					if (given === undefined && t.kind === "var") {
						env.set(varName(t), defined(held, `${a.relation}.${field}`))
					} else if (given !== held) {
						return []
					}
				}
				return [
					{
						env,
						scopedRows: relations[a.relation].scoped
							? [...d.scopedRows, [a.relation, row] as const]
							: d.scopedRows
					}
				]
			})
		)
	}
	return out
}

/** Whether `db` holds a row of the negated match under `env`, its unbound variables free. */
const negated = (
	a: Atom,
	env: ReadonlyMap<string, Value>,
	db: Database,
	params: SliceCase["params"]
): boolean =>
	Arr.some(db.rows[a.relation], (row) =>
		Arr.every(a.bind, ([field, t]) => {
			const given = valueOf(t, env, params)
			return given === undefined || given === row[field]
		})
	)

/** An answer: its head's values, in its variables' order. */
type Answer = ReadonlyArray<Value>

/** An answer's key: its values' texts apart by a character no value holds. */
const answerKey = (a: Answer): string =>
	Arr.join(
		Arr.map(a, (x) => String(x)),
		"\u0000"
	)

/** The order a take reads its answers in, ascending by each value in turn, as the program's order states it. */
const answerOrder: Order.Order<Answer> = Order.make((a, b) => {
	for (const [i, x] of a.entries()) {
		const y = b[i]
		if (y !== undefined && x !== y) {
			return x < y ? -1 : 1
		}
	}
	return 0
})

/** A program's answer over `db`, each answer a key of its head's values; and, under `owned`, whether each derivation
 * is the owner's alone, by which the model keeps the owner's part. */
const answers = (
	p: Program,
	db: Database,
	params: SliceCase["params"],
	owned: (d: Derivation) => boolean
): { readonly all: ReadonlySet<string>; readonly owner: ReadonlySet<string> } => {
	const vars = boundVars(p.atoms)
	const read = p.read
	const kept = Arr.filter(
		derivations(p, db, params),
		(d) => read.kind !== "negation" || !negated(read.atom, d.env, db, params)
	)
	if (read.kind === "count") {
		const groups = Rec.toEntries(
			Arr.groupBy(kept, (d) =>
				answerKey(Arr.map(read.group, (t) => defined(valueOf(t, d.env, params), "a group's value")))
			)
		)
		const counted = (g: string, ds: ReadonlyArray<Derivation>): string => `${g}\u0001${ds.length}`
		return {
			all: new Set(Arr.map(groups, ([g, ds]) => counted(g, ds))),
			owner: new Set(
				Arr.flatMap(groups, ([g, ds]) => (Arr.every(ds, owned) ? [counted(g, ds)] : []))
			)
		}
	}
	const answer = (d: Derivation): Answer =>
		Arr.map(vars, (t) => defined(d.env.get(varName(t)), varName(t)))
	const all = new Map(Arr.map(kept, (d) => [answerKey(answer(d)), answer(d)] as const))
	const owner = new Set(Arr.map(Arr.filter(kept, owned), (d) => answerKey(answer(d))))
	if (read.kind === "take") {
		const first = new Set(
			Arr.map(Arr.take(Arr.sort([...all.values()], answerOrder), read.k), answerKey)
		)
		return { all: first, owner: new Set(Arr.filter([...owner], (a) => first.has(a))) }
	}
	return { all: new Set(all.keys()), owner }
}

/**
 * The model: the program's answer over every row kept to the owner's, row by row. A derivation is the owner's where
 * every scoped row it matched is; a negation is decided over every row; a count keeps a group whose every derivation is
 * the owner's, at its whole count; a take keeps the owner's answers among the whole answer's first rows.
 */
export const expected = (c: SliceCase): ReadonlySet<string> =>
	answers(c.program, c.database, c.params, (d) =>
		Arr.every(d.scopedRows, ([r, row]) => ownersRow(c.database, r, row))
	).owner

/** The role's answer: the program over the slice, every scoped relation the owner's rows, as PostgreSQL reads it. */
export const roleAnswer = (c: SliceCase): ReadonlySet<string> =>
	answers(c.program, sliceOf(c.database), c.params, () => true).all

export type SliceFeature =
	| "an admitted plain read"
	| "an admitted negation"
	| "a refused negation"
	| "an admitted count"
	| "a refused count"
	| "an admitted take"
	| "a refused take"
	| "a pinned program admitted"
	| "a cross-owner negation refused"
	| "a cross-owner count refused"
	| "a cross-owner take refused"
