/** What the properties of copy-drawings.test.ts read: its space of copies a migration adds along one axis, and its
 * judge. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import {
	type AuthoredStatementDesc,
	contained,
	counted,
	f,
	field,
	fin,
	type FixtureField,
	literal,
	on,
	onWhere,
	ordered,
	relation
} from "#test/support/fixtures/ir/desc.ts"
import {
	asDrafted,
	compile,
	type DeploySubject,
	draftedAt,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import { plainPlan } from "#test/support/migrate/review.ts"

/** The axis the copies ride: a counted family's owner axis, an ordered family's, or a tree's, each member's parent. */
export const shapes = ["counted", "ordered", "tree"] as const
export type Shape = (typeof shapes)[number]

/** The caller's fields of the copies' target row. */
const targets = ["t0", "t1", "t2"] as const

/** A copy the migration adds: the member's field `up<i>`, holding its target row's caller field `t<j>`, or on a tree
 * the parent's copy `up<k>` of a copy before it. */
export interface Copy {
	readonly target:
		| { readonly kind: "field"; readonly name: string }
		| { readonly kind: "copy"; readonly of: number }
}

/** A case: the axis and the one to three copies a migration adds along it to stored rows. */
export interface DrawingsCase {
	readonly shape: Shape
	readonly copies: Arr.NonEmptyReadonlyArray<Copy>
}

/** The layers of a case's copies: those that read no copy, then those that read one of the layer before, and so on. */
const layersOf = (c: DrawingsCase): number => {
	const depth = (i: number): number => {
		const copy = c.copies[i]
		return copy === undefined || copy.target.kind === "field" ? 0 : 1 + depth(copy.target.of)
	}
	return 1 + Arr.reduce(c.copies, 0, (most, _, i) => Math.max(most, depth(i)))
}

/** A case: its axis, and one to three copies, each of a target no copy before it reads, since an axis references each
 * column of its target once: a caller field, or on a tree a copy before it. */
export const drawingsCaseGen: Gen<DrawingsCase> = (source) => {
	const shape = source.draw(element(shapes))
	const count = source.draw(int(1, targets.length))
	const copies: Array<Copy> = []
	for (let i = 0; i < count; i++) {
		const read = new Set(Arr.map(copies, (c) => targetName(c)))
		const open: ReadonlyArray<Copy> = [
			...Arr.map(
				Arr.filter(targets, (t) => !read.has(t)),
				(name): Copy => ({ target: { kind: "field", name } })
			),
			...(shape === "tree"
				? Arr.map(
						Arr.filter(
							Array.from({ length: i }, (_, of) => of),
							(of) => !read.has(copyName(of))
						),
						(of): Copy => ({ target: { kind: "copy", of } })
					)
				: [])
		]
		copies.push(source.draw(element(nonEmpty(open, "a target no copy before reads"))))
	}
	return { shape, copies: nonEmpty(copies, "one copy or more") }
}

export type DrawingsFeature = Shape | "one copy" | "several copies of one layer" | "a chain"

export const notesOf = (c: DrawingsCase): ReadonlyArray<DrawingsFeature> => [
	c.shape,
	...(c.copies.length === 1 ? (["one copy"] as const) : []),
	...(c.copies.length > layersOf(c) ? (["several copies of one layer"] as const) : []),
	...(layersOf(c) > 1 ? (["a chain"] as const) : [])
]

const integer = f.integer
const nonRoot = { kind: "compare", op: "gt", left: field("start"), right: literal(0n) } as const

/** A copy's field, `up<i>`, and the field of its target row it holds. */
const copyName = (i: number): string => `up${i}`
const targetName = (c: Copy): string =>
	c.target.kind === "field" ? c.target.name : copyName(c.target.of)

/** The case's schema, with its copies or without. */
const schemaOf = (c: DrawingsCase, withCopies: boolean): DeploySubject => {
	const copies = withCopies ? c.copies : []
	const copyFields: Record<string, FixtureField> = Rec.fromEntries(
		Arr.map(copies, (_, i) => [copyName(i), f.accumulated(integer, 0)] as const)
	)
	const callers: Record<string, FixtureField> = Rec.fromEntries(
		Arr.map(targets, (t) => [t, integer] as const)
	)
	if (c.shape === "tree") {
		const statements: Array<AuthoredStatementDesc> = [
			{
				kind: "tree",
				member: on("Node", ["parent", "at"]),
				slots: fin("Node", "n"),
				root: ["doc"]
			},
			...Arr.map(copies, (copy, i) =>
				contained(
					onWhere("Node", ["doc", "parent", copyName(i)], nonRoot),
					on("Node", ["doc", "start", targetName(copy)])
				)
			)
		]
		return {
			name: "Drawings",
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
						...callers,
						...copyFields
					},
					["doc", "start"]
				)
			],
			statements,
			extends: undefined
		}
	}
	const statements: Array<AuthoredStatementDesc> = [
		c.shape === "ordered"
			? ordered(on("Member", ["g", "at"]), fin("Owner", "n"))
			: counted(on("Member", ["g"]), fin("Owner", "n")),
		...Arr.map(copies, (copy, i) =>
			contained(on("Member", ["g", copyName(i)]), on("Owner", ["id", targetName(copy)]))
		)
	]
	return {
		name: "Drawings",
		relations: [
			relation("Owner", { id: integer, n: f.drawn, ...callers }, ["id"]),
			relation(
				"Member",
				{
					member: integer,
					g: integer,
					...(c.shape === "ordered" ? { at: f.drawn } : {}),
					...copyFields
				},
				["member"]
			)
		],
		statements,
		extends: undefined
	}
}

/** The drawings of each UPDATE a migration's backfill runs: the CTEs of its WITH that draw rows, by its table. */
const drawingsOf = (statements: ReadonlyArray<SqlStatement>): ReadonlyMap<string, number> =>
	new Map(
		Arr.flatMap(statements, (s): ReadonlyArray<readonly [string, number]> =>
			s.kind === "update"
				? [
						[
							s.table.name,
							Arr.filter(s.with?.ctes ?? [], (c) => Str.startsWith("__drawing_")(c.name)).length
						]
					]
				: []
		)
	)

/**
 * The case drafted as `grizzle generate` drafts it, the copies added to the family's populated table: its backfill
 * writes the copies' table by one UPDATE whose drawings are exactly the copies' layers, each layer one stream of the
 * axis's rows however many copies ride it.
 */
export const judge = (c: DrawingsCase): void => {
	const first = compile(schemaOf(c, false), asDrafted)
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
	const second = compile(schemaOf(c, true), asDrafted)
	const draft = succeeded(
		generate({
			installation: second,
			timestamp: draftedAt(2),
			previous: fromSnapshot(initial.snapshot),
			workload: noWorkload,
			declared: noDeclarations,
			name: "second"
		})
	)
	const statements = Arr.flatMap(plainPlan(draft), (file) =>
		Arr.flatMap(file.actions, (a): ReadonlyArray<SqlStatement> =>
			a.kind === "statement" ? [a.statement] : []
		)
	)
	const table = c.shape === "tree" ? "node" : "member"
	assert.equal(
		drawingsOf(statements).get(table),
		layersOf(c),
		`the copies' backfill draws one stream a layer, ${layersOf(c)} for ${c.copies.length} copies`
	)
}
