/** What the properties of literal-pack.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, DateTime } from "effect"
import { type CheckFinding } from "#cli/check.ts"
import type { PackFault } from "#compiler/physical/ddl/literal.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import type { PackLayout } from "#compiler/sql/ast.ts"
import {
	type Edit,
	editsOf,
	firstCellApart,
	firstPlaceApart,
	oracleRead
} from "#test/unit/physical/literal.fixtures.ts"

const Row = closed.ordered("Row", ["r0", "r1", "r2"])

const Col = closed.ordered("Col", ["c0", "c1"])

const Mark = closed.ordered("Mark", ["low", "high", "top"])

const rowAt = (code: number): "r0" | "r1" | "r2" => defined((["r0", "r1", "r2"] as const)[code])

const colAt = (code: number): "c0" | "c1" => defined((["c0", "c1"] as const)[code])

const markAt = (code: number): "low" | "high" | "top" =>
	defined((["low", "high", "top"] as const)[code])

/** Which of the grid's two arrays an edit is made to. */
export type GridArray = "cells" | "payloads"

export type Feature =
	| "the cells' literal edited"
	| "the payloads' literal edited"
	| "an edit out of order or range"
	| "an edit of another constant"

/** A drawn grid, each of its six cells holding no row or a mark's code, and which edit of each array is made. */
export interface Drawn {
	readonly marks: ReadonlyArray<number | undefined>
	/** The edit made to each array, by its place among the literal's edits (literal.fixtures.ts editsOf), modulo their count. */
	readonly edits: Readonly<Record<GridArray, number>>
}

export const grids: Gen<Drawn> = (s) => ({
	marks: Array.from({ length: 6 }, () => s.draw(element([undefined, 0, 1, 2]))),
	edits: { cells: s.draw(int(0, 999)), payloads: s.draw(int(0, 999)) }
})

/** The edit of a literal over `layout` a draw makes to `array`: its edit at the draw's place modulo the literal's edits. */
export const editOf = (d: Drawn, array: GridArray, text: string, layout: PackLayout): Edit => {
	const edits = editsOf(text, layout)
	return defined(edits[d.edits[array] % edits.length], "a literal has edits")
}

/** The schema of a drawn grid. */
export const gridSchemaOf = (d: Drawn) =>
	schema(
		"LitGrid",
		[
			Row,
			Col,
			Mark,
			closed.relation(
				"Grid",
				{ row: closedId(Row), col: closedId(Col), mark: closedId(Mark) },
				["row", "col"],
				Arr.flatMap(d.marks, (mark, cell) =>
					mark === undefined
						? []
						: [{ row: rowAt(Math.floor(cell / 2)), col: colAt(cell % 2), mark: markAt(mark) }]
				)
			)
		],
		[]
	)

export const now = (s: number) =>
	DateTime.makeUnsafe({
		year: 2026,
		month: 11,
		day: 5,
		hour: 12,
		minute: 0,
		second: s,
		millisecond: 0
	})

/** A finding as this file reads it: where it lies and what it is, a literal pack's statement and fault included. */
type Found =
	| { readonly kind: CheckFinding["kind"]; readonly where: string }
	| {
			readonly kind: "literalPack"
			readonly where: string
			readonly statement: number
			readonly fault: PackFault
	  }

export const foundOf = (f: CheckFinding): Found =>
	f.kind === "literalPack"
		? { kind: f.kind, where: f.where, statement: f.statement, fault: f.fault }
		: { kind: f.kind, where: f.where }

/**
 * The fault of the grid's array of `fn` over `layout` edited from `before` to `after`, read by the oracle: the layout
 * fault it makes, or the first cell whose entry it changes, with that cell's key, a payloads literal's cell the one the
 * grid's cells `cells` hold at the place it changes, and none where that place lies past every cell, a payload the edit
 * added after the last, which pairs with no cell (the last entry written twice, or an element past every other added).
 */
export const faultOf = (
	fn: string,
	layout: PackLayout,
	before: string,
	after: string,
	cells: ReadonlyArray<bigint>
): PackFault => {
	const was = oracleRead(before, layout)
	const now = oracleRead(after, layout)
	if (now.kind === "fault") {
		return { kind: "layout", function: fn, fault: now.fault }
	}
	if (was.kind === "fault") {
		throw new Error(`the drafted literal ${before} is one the oracle reads`)
	}
	const cell =
		layout.kind === "cells"
			? defined(firstCellApart(was.elements, now.elements), "an edit changes a cell")
			: cells[defined(firstPlaceApart(was.elements, now.elements), "an edit changes a payload")]
	return {
		kind: "content",
		function: fn,
		relation: "Grid",
		differs:
			cell === undefined
				? undefined
				: {
						cell,
						key: [rowAt(Math.floor(Number(cell) / 2)), colAt(Number(cell) % 2)]
					}
	}
}
