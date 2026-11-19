/** What the properties of copy-diff.test.ts read: its space of one change to a family's or a tree's copies and
 * generated fields, and its judge. */

import { aimed, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec, Result, String as Str } from "effect"
import {
	alterationStatement,
	type Declarations,
	type SetAside
} from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { AlterTableAction, Expr, ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import {
	and,
	type AuthoredStatementDesc,
	contained,
	counted,
	f,
	field,
	fin,
	type FixtureField,
	fold,
	literal,
	on,
	onWhere,
	ordered,
	relation
} from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { catalogOf, installState, interpret, type State } from "#test/support/migrate/interpret.ts"
import {
	asDrafted,
	compile,
	type DeploySubject,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	installedStatements,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { plainPlan } from "#test/support/migrate/review.ts"

/** The shapes a copy rides: a counted family's owner axis, an ordered family's, or a tree's, each member's parent. */
export const shapes = ["counted", "ordered", "tree"] as const
export type Shape = (typeof shapes)[number]

/** The target fields every target row holds, which the caller writes. */
const targets = ["t0", "t1", "t2"] as const

/**
 * A copy along the owner axis: the member's field `name`, which holds its target row's field `target`, a caller's
 * field of the owner, or on a tree a copy of the parent's another copy names before it, carried by the riding
 * containment `carrier`.
 */
export interface Copy {
	readonly name: string
	readonly target: string
	readonly carrier: 0 | 1
}

/**
 * A version of the schema: its shape; its copies, carried by up to two riding containments; whether the member has a
 * field `gx` PostgreSQL generates from its caller's `x`; whether a sum fold over each member's `x` accumulates into the
 * owner's `total`, its running values hidden law columns of the member (a tree's into each node's from its children);
 * and whether a containment from a selection of the members, `x > 0`, which rides no axis, keeps law columns of its own
 * over the member.
 */
export interface Version {
	readonly shape: Shape
	readonly copies: ReadonlyArray<Copy>
	readonly generated: boolean
	readonly folded: boolean
	readonly selected: boolean
}

/**
 * One change from a version to the next, each the one a reviewer makes to a schema in production:
 * - `remove copy`: a copy no other copy reads taken from its carrier, its field dropped, declared;
 * - `add copy`: a copy added to a carrier, its field new;
 * - `add generated` and `remove generated`: the member's generated field `gx` added or removed;
 * - `retarget`: a copy's pair moved to another target field, so it holds other values, and so does every copy that
 *   reads it, transitively.
 */
export type Change =
	| { readonly kind: "remove copy"; readonly copy: string }
	| { readonly kind: "add copy"; readonly copy: Copy }
	| { readonly kind: "add generated" | "remove generated" }
	| { readonly kind: "retarget"; readonly copy: string; readonly target: string }

export const changeKinds = [
	"remove copy",
	"add copy",
	"add generated",
	"remove generated",
	"retarget"
] as const satisfies ReadonlyArray<Change["kind"]>

/** A case: a version and the one change the next version makes of it. */
export interface CopyCase {
	readonly before: Version
	readonly change: Change
}

/** The relation a version's copies and generated field are on: the member, or the tree's node. */
const memberOf = (shape: Shape): string => (shape === "tree" ? "Node" : "Member")

/** The copies of `version` that read `name` along the axis: those whose target it is. */
const readersOf = (copies: ReadonlyArray<Copy>, name: string): ReadonlyArray<Copy> =>
	Arr.filter(copies, (c) => c.target === name)

/** The fields a change gives other values: a retargeted copy and every copy that reads one of them, transitively; for
 * any other change, none, its field dropped or added whole. */
const revalued = (c: CopyCase): ReadonlySet<string> => {
	if (c.change.kind !== "retarget") {
		return new Set()
	}
	const out = new Set<string>()
	const pending = [c.change.copy]
	for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
		if (!out.has(name)) {
			out.add(name)
			for (const r of readersOf(c.before.copies, name)) {
				pending.push(r.name)
			}
		}
	}
	return out
}

/** The version a case's change makes of its version. */
const after = (c: CopyCase): Version => {
	const v = c.before
	const change = c.change
	switch (change.kind) {
		case "remove copy":
			return { ...v, copies: Arr.filter(v.copies, (x) => x.name !== change.copy) }
		case "add copy":
			return { ...v, copies: [...v.copies, change.copy] }
		case "add generated":
			return { ...v, generated: true }
		case "remove generated":
			return { ...v, generated: false }
		case "retarget":
			return {
				...v,
				copies: Arr.map(v.copies, (x) =>
					x.name === change.copy ? { ...x, target: change.target } : x
				)
			}
	}
}

/** The fields a change adds or drops whole: the copy's or the generated field's; none for a retarget. */
const replaced = (c: CopyCase): ReadonlySet<string> => {
	switch (c.change.kind) {
		case "remove copy":
			return new Set([c.change.copy])
		case "add copy":
			return new Set([c.change.copy.name])
		case "add generated":
		case "remove generated":
			return new Set(["gx"])
		case "retarget":
			return new Set()
	}
}

/** What the change declares: a removed copy's drop, its field the caller's to see go. */
const declaredOf = (c: CopyCase): Declarations =>
	c.change.kind === "remove copy"
		? {
				renames: [],
				drops: [
					{
						kind: "field",
						relation: parsedName(memberOf(c.before.shape)),
						field: parsedName(c.change.copy)
					}
				]
			}
		: noDeclarations

const integer = f.integer
const positive = (name: string): ExprDesc => ({
	kind: "compare",
	op: "gt",
	left: field(name),
	right: literal(0)
})
/** The tree's members: every row but its roots, whose start is 0. */
const nonRoot: ExprDesc = { kind: "compare", op: "gt", left: field("start"), right: literal(0n) }

/** The fields of a version's member or node beside its shape's own: its caller's `x`, its copies and `gx`. */
const memberFields = (v: Version): Record<string, FixtureField> => ({
	x: integer,
	...Rec.fromEntries(Arr.map(v.copies, (c) => [c.name, f.accumulated(integer, 0)] as const)),
	...(v.generated ? { gx: f.generated(integer, field("x")) } : {})
})

/** Each carrier's copies, in the order the version lists them, the carriers that carry none left out. */
const carriers = (v: Version): ReadonlyArray<ReadonlyArray<Copy>> =>
	Arr.filter(
		Arr.map([0, 1], (k) => Arr.filter(v.copies, (c) => c.carrier === k)),
		Arr.isReadonlyArrayNonEmpty
	)

/** A version's schema. */
const schemaOf = (v: Version): DeploySubject => {
	if (v.shape === "tree") {
		const statements: Array<AuthoredStatementDesc> = [
			{
				kind: "tree",
				member: on("Node", ["parent", "at"]),
				slots: fin("Node", "n"),
				root: ["doc"]
			},
			...Arr.map(carriers(v), (cs) =>
				contained(
					onWhere("Node", ["doc", "parent", ...Arr.map(cs, (c) => c.name)], nonRoot),
					on("Node", ["doc", "start", ...Arr.map(cs, (c) => c.target)])
				)
			),
			...(v.folded
				? [
						fold(
							fin("Node", "n"),
							"sum",
							on("Node", ["doc", "parent", "x"]),
							on("Node", ["doc", "start", "total"])
						)
					]
				: []),
			...(v.selected
				? [
						contained(
							onWhere("Node", ["doc", "parent"], and(nonRoot, positive("x"))),
							on("Node", ["doc", "start"])
						)
					]
				: [])
		]
		return {
			name: "Copies",
			relations: [
				relation(
					"Node",
					{
						doc: integer,
						parent: f.drawn,
						at: f.drawn,
						n: f.drawn,
						start: f.drawn,
						end: f.drawn,
						...Rec.fromEntries(Arr.map(targets, (t) => [t, integer] as const)),
						...memberFields(v),
						...(v.folded ? { total: f.accumulated(integer, 0) } : {})
					},
					["doc", "start"]
				)
			],
			statements,
			extends: undefined
		}
	}
	const statements: Array<AuthoredStatementDesc> = [
		v.shape === "ordered"
			? ordered(on("Member", ["g", "at"]), fin("Owner", "n"))
			: counted(on("Member", ["g"]), fin("Owner", "n")),
		...Arr.map(carriers(v), (cs) =>
			contained(
				on("Member", ["g", ...Arr.map(cs, (c) => c.name)]),
				on("Owner", ["id", ...Arr.map(cs, (c) => c.target)])
			)
		),
		...(v.folded
			? [fold(fin("Owner", "n"), "sum", on("Member", ["g", "x"]), on("Owner", ["id", "total"]))]
			: []),
		...(v.selected ? [contained(onWhere("Member", ["g"], positive("x")), on("Owner", ["id"]))] : [])
	]
	return {
		name: "Copies",
		relations: [
			relation(
				"Owner",
				{
					id: integer,
					...Rec.fromEntries(Arr.map(targets, (t) => [t, integer] as const)),
					n: f.drawn,
					...(v.folded ? { total: f.accumulated(integer, 0) } : {})
				},
				["id"]
			),
			relation(
				"Member",
				{
					member: integer,
					g: integer,
					...(v.shape === "ordered" ? { at: f.drawn } : {}),
					...memberFields(v)
				},
				["member"]
			)
		],
		statements,
		extends: undefined
	}
}

/** A copy's name: `c<i>`, or a tree's `up<i>`. */
const copyName = (shape: Shape, i: number): string => (shape === "tree" ? `up${i}` : `c${i}`)

/**
 * The targets a copy after `before` may read: a caller's target field, or on a tree a copy of `before`, each but one
 * another copy of `copies` reads already, since an axis references each of its target's columns once.
 */
const targetsOf = (
	shape: Shape,
	before: ReadonlyArray<Copy>,
	copies: ReadonlyArray<Copy>
): ReadonlyArray<string> =>
	Arr.filter(
		[...targets, ...(shape === "tree" ? Arr.map(before, (c) => c.name) : [])],
		(t) => !Arr.some(copies, (c) => c.target === t)
	)

/** A copy drawn at `i`, of a target of `left`, those no copy before it reads: its carrier and its target. */
const copyGen =
	(shape: Shape, i: number, left: Arr.NonEmptyReadonlyArray<string>): Gen<Copy> =>
	(source) => ({
		name: copyName(shape, i),
		target: source.draw(element(left)),
		carrier: source.draw(boolean) ? 1 : 0
	})

/** The changes a version admits, each drawn whole: a removable copy is one no other copy reads; a retarget moves a
 * copy to another target its carrier leaves it and its copies before it allow, so no copy reads itself. */
const changesOf = (v: Version): ReadonlyArray<Gen<Change>> => {
	const removable = Arr.filter(v.copies, (c) => readersOf(v.copies, c.name).length === 0)
	const retargets = Arr.flatMap(v.copies, (c, i) => {
		const others = targetsOf(v.shape, Arr.take(v.copies, i), v.copies)
		return Arr.isReadonlyArrayNonEmpty(others) ? [{ copy: c.name, others }] : []
	})
	const open = targetsOf(v.shape, v.copies, v.copies)
	return [
		...(Arr.isReadonlyArrayNonEmpty(removable)
			? [
					(source: Parameters<Gen<Change>>[0]): Change => ({
						kind: "remove copy",
						copy: source.draw(element(removable)).name
					})
				]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(open)
			? [
					(source: Parameters<Gen<Change>>[0]): Change => ({
						kind: "add copy",
						copy: source.draw(copyGen(v.shape, v.copies.length, open))
					})
				]
			: []),
		...(v.generated
			? [(): Change => ({ kind: "remove generated" })]
			: [(): Change => ({ kind: "add generated" })]),
		...(Arr.isReadonlyArrayNonEmpty(retargets)
			? [
					(source: Parameters<Gen<Change>>[0]): Change => {
						const r = source.draw(element(retargets))
						return { kind: "retarget", copy: r.copy, target: source.draw(element(r.others)) }
					}
				]
			: [])
	]
}

/** A case: a version of one to three copies, each a draw, and one change it admits. */
const copyCaseGen: Gen<CopyCase> = (source) => {
	const shape = source.draw(element(shapes))
	const count = source.draw(int(1, targets.length))
	const copies: Array<Copy> = []
	for (let i = 0; i < count; i++) {
		const left = targetsOf(shape, copies, copies)
		if (!Arr.isReadonlyArrayNonEmpty(left)) {
			throw new Error("a version's copies each read a target of their own")
		}
		copies.push(source.draw(copyGen(shape, i, left)))
	}
	const before: Version = {
		shape,
		copies,
		generated: source.draw(boolean),
		folded: source.draw(boolean),
		selected: source.draw(boolean)
	}
	const changes = changesOf(before)
	const [first, ...rest] = changes
	if (first === undefined) {
		throw new Error("every version admits a change: its generated field's addition or removal")
	}
	return { before, change: source.draw(source.draw(element([first, ...rest]))) }
}

/**
 * A case of a chain of copies down a tree, `up0` a target's and each copy after it its predecessor's, whose change moves
 * `up0` to another target: every copy of the chain holds other values then.
 */
const chainGen: Gen<CopyCase> = (source) => {
	const length = source.draw(int(2, targets.length))
	const [first, ...others] = targets
	const moved = source.draw(element(others))
	const copies = Array.from({ length }, (_, i): Copy => ({
		name: copyName("tree", i),
		target: i === 0 ? first : copyName("tree", i - 1),
		carrier: source.draw(boolean) ? 1 : 0
	}))
	return {
		before: {
			shape: "tree",
			copies,
			generated: source.draw(boolean),
			folded: source.draw(boolean),
			selected: source.draw(boolean)
		},
		change: { kind: "retarget", copy: copyName("tree", 0), target: moved }
	}
}

/** The space of cases, aimed at a retarget a copy reads, which a uniform draw reaches rarely. */
export const copyCases = aimed(copyCaseGen, [
	["a retarget another copy reads", chainGen],
	["a copy of a copy", chainGen]
])

/** What a case reaches, for its situations. */
export type CopyFeature =
	| Shape
	| Change["kind"]
	| "two carriers"
	| "a copy of a copy"
	| "a retarget another copy reads"
	| "folded"
	| "selected"

export const notesOf = (c: CopyCase): ReadonlyArray<CopyFeature> => [
	c.before.shape,
	c.change.kind,
	...(carriers(c.before).length === 2 ? ["two carriers" as const] : []),
	...(Arr.some(c.before.copies, (x) => Arr.some(c.before.copies, (y) => y.name === x.target))
		? ["a copy of a copy" as const]
		: []),
	...(revalued(c).size > 1 ? ["a retarget another copy reads" as const] : []),
	...(c.before.folded ? ["folded" as const] : []),
	...(c.before.selected ? ["selected" as const] : [])
]

/** A case's two installations and the migration between them, drafted as `grizzle generate` drafts each. */
interface Drafted {
	readonly first: Installation
	readonly second: Installation
	readonly draft: GenerateResult
}

const drafted = (c: CopyCase): Drafted => {
	const first = compile(schemaOf(c.before), asDrafted)
	const initial = succeeded(
		generate({
			installation: first,
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations,
			name: "first"
		})
	)
	const second = compile(schemaOf(after(c)), asDrafted)
	return {
		first,
		second,
		draft: succeeded(
			generate({
				installation: second,
				timestamp: draftedAt(2),
				previous: fromSnapshot(initial.snapshot),
				workload: noWorkload,
				declared: declaredOf(c),
				name: "second"
			})
		)
	}
}

/** The model state of an installation installed from nothing. */
const freshState = (installation: Installation): State => {
	const state = installState(installation.names.schema, installedStatements(installation))
	assert.ok(Result.isSuccess(state), "the installation installs on the model")
	return state.success
}

/** The migration's statements, each alteration as the one ALTER TABLE it prints as. */
const statementsOf = (draft: GenerateResult): ReadonlyArray<SqlStatement> =>
	Arr.flatMap(plainPlan(draft), (file) =>
		Arr.flatMap(file.actions, (a): ReadonlyArray<SqlStatement> => {
			switch (a.kind) {
				case "statement":
					return [a.statement]
				case "alteration":
					return [alterationStatement(a.table, a.actions)]
				case "fill":
					return [fillStatement(a.table, a.fields)]
				case "violation":
				case "analyze":
				case "dropStatistics":
					return []
			}
		})
	)

/** A fill of set-aside fields (deploy/diff/plan.ts SetAside), as the columns it touches: each field's column, which it
 * drops, and its aside, which it renames into the field's name. */
const fillStatement = (
	table: ObjectName,
	fields: Arr.NonEmptyReadonlyArray<SetAside>
): SqlStatement => ({
	kind: "alterTable",
	table,
	actions: Arr.flatMap(fields, (x) => [
		{ kind: "dropColumn" as const, column: x.column.name },
		{ kind: "dropColumn" as const, column: x.aside }
	])
})

/** The columns of its own row an expression reads, by name. */
const ownColumns = (e: Expr): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column" && x.table === undefined) {
				out.push(x.column)
			}
			return x
		}
	})
	return out
}

/** A column of a table, by its table's name and its own. */
const at = (table: string, column: string): string => `${table}.${column}`

/** What a migration touches: the columns it drops, adds, converts, re-expresses, renames or updates, and the
 * constraints and indexes it drops or creates, each by its table's name and its own, a swap's temporary index by the
 * constraint it becomes or the name it is renamed to. */
interface Touched {
	readonly columns: ReadonlySet<string>
	readonly objects: ReadonlySet<string>
}

/** The columns and objects one ALTER TABLE touches, into `columns` and `objects`. */
const alterationTouches = (
	table: string,
	actions: ReadonlyArray<AlterTableAction>,
	columns: Set<string>,
	objects: Set<string>
): void => {
	for (const a of actions) {
		switch (a.kind) {
			case "addColumn":
			case "addColumnPlaceholder":
			case "addColumnDefault":
			case "addColumnUnchecked":
				columns.add(at(table, a.column.name))
				break
			case "dropColumn":
			case "alterColumnType":
			case "setExpression":
				columns.add(at(table, a.column))
				break
			case "addConstraint":
				objects.add(at(table, a.constraint.name))
				break
			case "addConstraintUsingIndex":
				objects.delete(`index ${a.index}`)
				objects.add(at(table, a.name))
				break
			case "dropConstraint":
				objects.add(at(table, a.name))
				break
			case "setNotNull":
			case "dropDefault":
			case "setUuidv7Default":
			case "setRetirementDefault":
			case "addIdentity":
			case "dropIdentity":
			case "validateConstraint":
			case "alterConstraintDeferral":
			case "enableRowSecurity":
			case "disableRowSecurity":
			case "replicaIdentity":
				break
		}
	}
}

const touchedBy = (statements: ReadonlyArray<SqlStatement>): Touched => {
	const columns = new Set<string>()
	const objects = new Set<string>()
	for (const s of statements) {
		if (s.kind === "alterTable") {
			alterationTouches(s.table.name, s.actions, columns, objects)
		} else if (s.kind === "renameColumn") {
			columns.add(at(s.table.name, s.from))
			columns.add(at(s.table.name, s.to))
		} else if (s.kind === "update") {
			for (const a of s.set) {
				columns.add(at(s.table.name, a.column))
			}
		} else if (s.kind === "createIndex") {
			objects.add(`index ${s.name}`)
		} else if (s.kind === "dropIndex") {
			objects.add(`index ${s.name.name}`)
		} else if (s.kind === "rename" && s.object === "INDEX") {
			objects.delete(`index ${s.name.name}`)
			objects.add(`index ${s.to}`)
		}
	}
	return { columns, objects }
}

/** What an installation's catalog holds, by what touchedBy names it: each column's, constraint's and index's line of
 * the model's catalog (catalogOf), and the columns each constraint and index reads, a foreign key's referenced ones
 * among them, and each generated column's. */
interface Catalog {
	readonly lines: ReadonlyMap<string, string>
	readonly reads: ReadonlyMap<string, ReadonlySet<string>>
}

const catalogFor = (installation: Installation): Catalog => {
	const state = freshState(installation)
	const lines = new Map<string, string>()
	const reads = new Map<string, Set<string>>()
	const read = (object: string, column: string): void => {
		reads.set(object, (reads.get(object) ?? new Set()).add(column))
	}
	for (const [table, of] of state.constraints) {
		for (const [name, c] of of) {
			const object = at(table, name)
			for (const column of c.columns) {
				read(object, at(table, column))
			}
			if (c.kind === "foreignKey") {
				for (const column of c.referenced) {
					read(object, at(c.references, column))
				}
			}
		}
	}
	for (const [name, x] of state.indexes) {
		for (const column of x.reads) {
			read(`index ${name}`, at(x.on, column))
		}
	}
	for (const line of catalogOf(state)) {
		const [kind, name] = Str.split(line, " ")
		if (kind === "column" || kind === "constraint") {
			lines.set(name ?? line, line)
		} else if (kind === "index") {
			lines.set(`index ${name ?? line}`, line)
		}
	}
	for (const s of installedStatements(installation)) {
		if (s.kind === "createTable") {
			for (const c of s.columns) {
				if (c.generated?.kind === "stored" || c.generated?.kind === "partial") {
					const exprs =
						c.generated.kind === "stored"
							? [c.generated.expr]
							: [c.generated.when, c.generated.expr]
					for (const column of Arr.flatMap(exprs, ownColumns)) {
						read(at(s.table.name, c.name), at(s.table.name, column))
					}
				}
			}
		}
	}
	return { lines, reads }
}

/** Every name whose catalog line differs between the two installations: held by one alone, or held otherwise. */
const differing = (a: Catalog, b: Catalog): ReadonlySet<string> =>
	new Set(
		Arr.filter(
			[...new Set([...a.lines.keys(), ...b.lines.keys()])],
			(name) => a.lines.get(name) !== b.lines.get(name)
		)
	)

/** Whether a catalog object reads a column of `columns`, in either installation. */
const readsAny = (
	object: string,
	columns: ReadonlySet<string>,
	catalogs: ReadonlyArray<Catalog>
): boolean =>
	Arr.some(catalogs, (c) => Arr.some([...(c.reads.get(object) ?? [])], (r) => columns.has(r)))

const sorted = (names: Iterable<string>): ReadonlyArray<string> =>
	Arr.sort([...names], Order.String)

/**
 * A case's judge, the schema's own read graph its model: the migration ends at the catalog the second version
 * installs from nothing; it touches exactly the member's fields the change replaces or gives other values, the copy
 * or generated field added or dropped and every copy that reads a retargeted one, and of the columns grizzle adds
 * beside the fields only those the two catalogs hold otherwise or that are generated over a touched column; and every
 * constraint and index it drops or creates is one the two catalogs hold otherwise or that reads a column it touches. So
 * a sibling copy, a law column of a selection, a fold's hidden running values and a family's drawn values are touched
 * only where what they hold changes.
 */
export const judge = (c: CopyCase): void => {
	const d = drafted(c)
	const first = catalogFor(d.first)
	const second = catalogFor(d.second)
	const run = interpret(d.second.names.schema, freshState(d.first), plainPlan(d.draft), (p) => {
		throw new Error(`the migration asks no placeholder, but drafted a ${p.kind}`)
	})
	if (Result.isFailure(run)) {
		return assert.fail(
			`the migration fails on the model: ${run.failure.file} #${run.failure.action}, ${run.failure.reason}`
		)
	}
	assert.deepEqual(
		catalogOf(run.success),
		catalogOf(freshState(d.second)),
		"the migration ends at the catalog the second version installs from nothing"
	)
	const touched = touchedBy(statementsOf(d.draft))
	const member = memberOf(c.before.shape)
	/** Each field of a stored relation either version holds, by its column, with the member's by their names. */
	const fields = new Set<string>()
	const memberColumns = new Map<string, string>()
	for (const installation of [d.first, d.second]) {
		for (const r of Rec.values(installation.laws.theory.relations)) {
			if (r.kind === "relation") {
				for (const x of r.fields) {
					fields.add(at(r.ident, x.column))
					if (r.name === member) {
						memberColumns.set(x.name, at(r.ident, x.column))
					}
				}
			}
		}
	}
	const columnOf = (name: string): string => {
		const column = memberColumns.get(name)
		if (column === undefined) {
			throw new Error(`neither version holds the member's field ${name}`)
		}
		return column
	}
	const expected = new Set(Arr.map([...replaced(c), ...revalued(c)], columnOf))
	const unexpected = (x: string): boolean =>
		!differ.has(x) && !readsAny(x, touched.columns, [first, second])
	const differ = differing(first, second)
	assert.deepEqual(
		sorted(Arr.filter([...touched.columns], (x) => fields.has(x))),
		sorted(expected),
		"the migration touches exactly the fields the change replaces or gives other values"
	)
	assert.deepEqual(
		sorted(Arr.filter([...touched.columns], (x) => !fields.has(x) && unexpected(x))),
		[],
		"every column grizzle adds beside the fields that the migration touches is held otherwise or generated over a touched column"
	)
	assert.deepEqual(
		sorted(Arr.filter([...touched.objects], unexpected)),
		[],
		"every constraint and index the migration drops or creates is held otherwise or reads a touched column"
	)
}
