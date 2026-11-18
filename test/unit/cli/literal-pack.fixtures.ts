/** What the properties of literal-pack.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, DateTime, Option, String as Str } from "effect"
import { type CheckFinding } from "#cli/check.ts"
import type { PackFault } from "#compiler/physical/ddl/literal.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { defined } from "#test/support/assert.ts"
import { textOfHex } from "#test/support/closed/bit-text.ts"

const Row = closed.ordered("Row", ["r0", "r1", "r2"])

const Col = closed.ordered("Col", ["c0", "c1"])

const Mark = closed.ordered("Mark", ["low", "high", "top"])

const rowAt = (code: number): "r0" | "r1" | "r2" => defined((["r0", "r1", "r2"] as const)[code])

const colAt = (code: number): "c0" | "c1" => defined((["c0", "c1"] as const)[code])

const markAt = (code: number): "low" | "high" | "top" =>
	defined((["low", "high", "top"] as const)[code])

/** Which of the grid's two constants a change is made to. */
export type Constant = "cells" | "keys"

export type Feature =
	| "the cells' literal changed"
	| "the key set's literal changed"
	| "a cell changed"
	| "a padding bit set"

/** A drawn grid, each of its six cells holding no row or a mark's code, and the change made to each constant. */
export interface Drawn {
	readonly marks: ReadonlyArray<number | undefined>
	readonly changes: Readonly<Record<Constant, { readonly digit: number; readonly offset: number }>>
}

export const grids: Gen<Drawn> = (s) => ({
	marks: Array.from({ length: 6 }, () => s.draw(element([undefined, 0, 1, 2]))),
	changes: {
		cells: { digit: s.draw(int(0, 2)), offset: s.draw(int(1, 15)) },
		keys: { digit: s.draw(int(0, 1)), offset: s.draw(int(1, 15)) }
	}
})

/** The schema of a drawn grid. */
export const schemaOf = (d: Drawn) =>
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

/** `hex` with its digit at `at` moved `offset` values on, modulo sixteen: another digit. */
export const changedDigit = (hex: string, at: number, offset: number): string =>
	`${Str.slice(0, at)(hex)}${Str.toUpperCase(((Number.parseInt(defined(hex[at]), 16) + offset) % 16).toString(16))}${Str.slice(at + 1)(hex)}`

/**
 * The fault of a literal of `fn` changed from `before` to `after`, `cells` cells of `width` bits: the first bit past the
 * last cell it sets, or the first cell whose bits it changes, with that cell's key.
 */
export const faultOf = (
	fn: string,
	before: string,
	after: string,
	cells: number,
	width: number
): PackFault => {
	const was = textOfHex(before)
	const now = textOfHex(after)
	const padding = Str.indexOf("1")(Str.slice(cells * width)(now))
	if (Option.isSome(padding)) {
		return {
			kind: "layout",
			function: fn,
			fault: { kind: "padding", at: cells * width + padding.value }
		}
	}
	const cell = defined(
		Option.getOrUndefined(
			Arr.findFirstIndex(
				Array.from({ length: cells }, (_, c) => c),
				(c) =>
					Str.slice(c * width, (c + 1) * width)(was) !== Str.slice(c * width, (c + 1) * width)(now)
			)
		),
		"a changed cell"
	)
	return {
		kind: "content",
		function: fn,
		relation: "Grid",
		differs: { cell: BigInt(cell), key: [rowAt(Math.floor(cell / 2)), colAt(cell % 2)] }
	}
}
