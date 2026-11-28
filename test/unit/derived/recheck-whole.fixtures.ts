/**
 * What recheck-whole.test.ts reads: a box of a stored relation over a closed relation it reads at a literal of a column
 * no index entry holds, and its installation.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type FiniteSpace, finite } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { dataStepRecheckName } from "#compiler/core/identity.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { bool, int8, numeric, variant } from "#compiler/public/fields.ts"
import { closed, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder } from "#compiler/schema/relation.ts"
import { scannedItems } from "#compiler/sql/plan.ts"
import { ownedInput } from "#test/support/policy.ts"

/**
 * The cell the snapshots hold, as qti-pie's QtiValue holds a response: a boolean arm beside an arm no B-tree entry
 * holds, a text of no byte bound (metis's arms) or an exact integer of 825 digits beside a text of at most 64 KiB, a
 * cell of 66 KiB (qti-pie's LEDGER-VALUECELL probe, its texts bounded, 131,152 bytes).
 */
export type Cell = "unbounded text" | "wide bounded"

/** A case: the cell, and whether the stored relation's definition reads the cell at its literal alone or beside a
 * partner that binds the snapshot's sitting, as qti-pie's uncounted attempts read it beside its response. */
export interface Shape {
	readonly cell: Cell
	readonly partnered: boolean
}

export const shapeGen: FiniteSpace<Shape> = finite((source) => ({
	cell: source.draw(element<Cell>(["unbounded text", "wide bounded"])),
	partnered: source.draw(element([false, true]))
}))

/** The roster of the cell's arms. */
const Kind = closed.unordered("Kind", ["flag", "other"])

/** A variant over Kind as a snapshot holds it: its descriptor, and its flag `true`, a literal of it. */
const cellParts = <
	V extends { readonly make: (handle: "flag", fields: { readonly value: boolean }) => unknown }
>(
	cell: V
) => ({ cell, flag: cell.make("flag", { value: true }) })

/** The variant of the case's cell: a flag, and an arm no B-tree entry holds. */
const cellOf = (cell: Cell) =>
	cell === "unbounded text"
		? cellParts(
				variant("Cell", Kind, { flag: { value: bool }, other: { text: str.regex("^.+$", "su") } })
			)
		: cellParts(
				variant("Cell", Kind, {
					flag: { value: bool },
					other: { n: numeric(825, 0), text: str.bytes(65536, str.regex("^.+$", "su")) }
				})
			)

/**
 * The installation of the case's schema: Snap, each sitting's cell of a variable, keyed by the sitting (`child`,
 * `at`) and the variable; Attempt, each sitting's attempt; and above them Flagged, each sitting whose cell of some
 * variable is the flag `true`, stored at its unit `child` (analysis/derived/storage.ts), every relation closed, so the
 * data step's re-check refills Flagged from its definition (physical/ddl/recheck.ts).
 */
export const installationOf = (shape: Shape): Result.Result<Installation, CompileError> => {
	const { cell, flag } = cellOf(shape.cell)
	const Snap = relation(
		"Snap",
		{ child: int8, at: int8, variable: str.bytes(40, str.regex("^.+$", "su")), value: cell },
		["child", "at", "variable"]
	)
	const Attempt = relation("Attempt", { child: int8, at: int8 }, ["child", "at"])
	const Kid = unit("Kid", { child: int8 })
	const base = schema("Base", [Kind, Snap, Attempt], [Kid])
	const flagged = queryOver(base).rule((r: RuleValue) => {
		const { child, at, variable } = varsOver(Snap, "s")
		const read = r.match(Snap, { child, at, variable, value: flag })
		return (shape.partnered ? read.match(Attempt, { child, at }) : read).find({ child, at })
	})
	const top = schema.extend([base], "Top", [derivedBuilder("Flagged", flagged, [])], [])
	return Result.flatMap(ownedInput(top), (owned) =>
		compileInstallation(owned, installOptions(owned))
	)
}

/** Every index of Snap the installation plans, by its keys' columns. */
export const snapIndexes = (installation: Installation): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(
		Arr.filter(installation.indexes, (i) => i.relation === "Snap"),
		(i) => Arr.map(i.keys, (k) => (k.column.kind === "field" ? k.column.field : k.column.kind))
	)

/** How the data step's re-check reads Snap: each read's scan, by kind. */
export const recheckReadsOfSnap = (installation: Installation): ReadonlyArray<string> => {
	const rechecks: ReadonlyArray<Installation["routines"][number]> = Arr.filter(
		installation.routines,
		(r) => Str.endsWith(dataStepRecheckName)(r.fn.name)
	)
	return Arr.flatMap(rechecks, (r) =>
		Arr.flatMap(r.plan.levels, (level) =>
			Arr.flatMap(scannedItems(level), (item) =>
				(item.scan.kind === "index" || item.scan.kind === "bitmap") &&
				Str.includes("snap")(item.scan.index.name.name)
					? [`${item.scan.kind} ${item.scan.index.name.name}`]
					: []
			)
		)
	)
}
