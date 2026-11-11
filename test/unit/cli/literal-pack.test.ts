/**
 * A closed relation's constants through the command line, over drawn grids: `grizzle generate` drafts each constant as
 * its one hex literal, the installation's own, and `grizzle check` holds every literal to its content
 * (physical/ddl/literal.ts literalPackFault).
 *
 * - **A drafted folder passes:** check finds nothing in what generate drafted.
 * - **A changed digit is one finding at its file, by its fault:** one hex digit of either constant, its cells' or its
 *   key set's, changed to another is check's one finding, a literal pack at the file that holds it, at the statement
 *   that states it, counted from 1, with its fault (cli/check.ts CheckFinding): the content the oracle reads off the
 *   two literals, the closed relation, the first cell where the literal parts from the declared rows and that cell's
 *   key, or, where the change sets a bit past the last cell, a layout fault at that padding bit.
 *
 * The grid: Row (3 codes) by Col (2), row-major, each cell holding no row or a row of a Mark (3 codes), so its cells
 * take 2 bits, 12 in all, three whole digits, and its key set 6 bits, padded with 2 to two digits.
 *
 * Oracle: a second implementation of the fault, the grid's cells row-major read off the test oracle's bits of each
 * literal (test/support/closed/bit-text.ts), sharing no code with the engine's decoder.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): literal-pack-statement-from-zero.patch (a finding counts its file's
 * statements from 0), literal-pack-later-cell.patch (where two literals hold different cells
 * first, the later is named), literal-pack-unchecked.patch (check finds only a literal pack off its printed form).
 *
 * Features: either constant changed; a cell changed or a padding bit set.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { type CheckFinding, check } from "#cli/check.ts"
import { headNonEmpty } from "#compiler/core/nonempty.ts"
import { metaFileName } from "#compiler/deploy/render/folder.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import type { PackFault } from "#compiler/physical/ddl/literal.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { servedDirectory } from "#compiler/served/forms.ts"
import type { PackConstant } from "#compiler/sql/ast.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import {
	cliOver,
	configName,
	offlineOwner,
	resolvedConfig,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { textOfHex } from "#test/support/closed/bit-text.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

const Row = closed("Row", ["r0", "r1", "r2"])
const Col = closed("Col", ["c0", "c1"])
const Mark = closed("Mark", ["low", "high", "top"])

const rowAt = (code: number): "r0" | "r1" | "r2" => defined((["r0", "r1", "r2"] as const)[code])
const colAt = (code: number): "c0" | "c1" => defined((["c0", "c1"] as const)[code])
const markAt = (code: number): "low" | "high" | "top" =>
	defined((["low", "high", "top"] as const)[code])

/** Which of the grid's two constants a change is made to. */
type Constant = "cells" | "keys"

type Feature =
	| "the cells' literal changed"
	| "the key set's literal changed"
	| "a cell changed"
	| "a padding bit set"

/** A drawn grid, each of its six cells holding no row or a mark's code, and the change made to each constant. */
interface Drawn {
	readonly marks: ReadonlyArray<number | undefined>
	readonly changes: Readonly<Record<Constant, { readonly digit: number; readonly offset: number }>>
}

const grids: Gen<Drawn> = (s) => ({
	marks: Array.from({ length: 6 }, () => s.draw(element([undefined, 0, 1, 2]))),
	changes: {
		cells: { digit: s.draw(int(0, 2)), offset: s.draw(int(1, 15)) },
		keys: { digit: s.draw(int(0, 1)), offset: s.draw(int(1, 15)) }
	}
})

/** The schema of a drawn grid. */
const schemaOf = (d: Drawn) =>
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

const now = (s: number) =>
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

const foundOf = (f: CheckFinding): Found =>
	f.kind === "literalPack"
		? { kind: f.kind, where: f.where, statement: f.statement, fault: f.fault }
		: { kind: f.kind, where: f.where }

/** `hex` with its digit at `at` moved `offset` values on, modulo sixteen: another digit. */
const changedDigit = (hex: string, at: number, offset: number): string =>
	`${Str.slice(0, at)(hex)}${Str.toUpperCase(((Number.parseInt(defined(hex[at]), 16) + offset) % 16).toString(16))}${Str.slice(at + 1)(hex)}`

/**
 * The fault of a literal of `fn` changed from `before` to `after`, `cells` cells of `width` bits: the first bit past the
 * last cell it sets, or the first cell whose bits it changes, with that cell's key.
 */
const faultOf = (
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

layer(NodeServices.layer, { excludeTestServices: true })(
	"grizzle check over a closed relation's hex literals",
	(it) => {
		it.effect(
			"passes a drafted literal, and refuses any changed digit at its file and statement, naming what it changes",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "unit/cli/literal-pack",
							oracle: {
								kind: "second-implementation",
								name: "the grid's cells row-major, read off the oracle's bits of each literal"
							},
							draw: drawn(grids),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"the cells' literal changed",
									"the key set's literal changed",
									"a cell changed",
									"a padding bit set"
								],
								{ cases: 12, sense: notesOnly }
							),
							kept: [],
							runs: 2,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(d: Drawn, c: Case<Feature>) =>
							Effect.scoped(
								Effect.gen(function* () {
									const fs = yield* FileSystem.FileSystem
									const gridSchema = schemaOf(d)
									const config = defineConfig({
										schemas: [gridSchema],
										logins: [],
										migrations: "migrations",
										connection: () => offlineOwner
									})
									const owned = owning(gridSchema)
									const installation = succeeded(
										compileInstallation(owned, installOptions(owned, undefined))
									)
									const grid = installation.names.closed("Grid")
									const packOf = (name: string): PackConstant =>
										defined(
											Arr.flatMap(installation.statements, (s) =>
												s.kind === "packConstant" && s.function.name === name ? [s] : []
											)[0],
											`the pack of ${name}`
										)
									const packs: Readonly<Record<Constant, PackConstant>> = {
										cells: packOf(grid.function.name),
										keys: packOf(grid.keys.name)
									}
									const ws = yield* workspace("literal-pack")
									const drafted = yield* cliOver(
										ws,
										config,
										["generate", configName, "--name", "init"],
										now(0)
									)
									assert.equal(drafted.code, 0, drafted.stderr)
									const schemaDir = `migrations/${headNonEmpty(owned.levels).installation.identifier}`
									const entries = yield* fs.readDirectory(`${ws}/${schemaDir}`)
									const folder = `${schemaDir}/${defined(
										Arr.filter(
											entries,
											(n) =>
												n !== snapshotFileName && n !== manifestFileName && n !== servedDirectory
										)[0],
										"the drafted folder"
									)}`
									const named = yield* fs.readDirectory(`${ws}/${folder}`)
									const files = Arr.sort(
										Arr.filter(named, (n) => n !== metaFileName),
										Order.String
									)
									const texts = yield* Effect.forEach(files, (name) =>
										Effect.map(fs.readFileString(`${ws}/${folder}/${name}`), (text) => ({
											name,
											text
										}))
									)
									const read = yield* resolvedConfig(config, `${ws}/${configName}`)
									const resolved = succeeded(read)
									const findings = Effect.map(Effect.orDie(check(resolved, ws)), (checks) =>
										Arr.flatMap(checks, (x) => Arr.map(x.findings, foundOf))
									)
									const held = yield* cliOver(ws, config, ["check", configName], now(1))
									assert.equal(held.code, 0, held.stderr)
									const drafts = yield* findings
									assert.deepEqual(drafts, [], "the drafted folder holds every literal")
									for (const constant of ["cells", "keys"] as const) {
										const p = packs[constant]
										const literalText = printStatement(p)
										const file = defined(
											Option.getOrUndefined(
												Arr.findFirst(texts, (t) => Str.includes(literalText)(t.text))
											),
											`the file generate drafted the ${constant} literal into`
										)
										const statement =
											defined(
												Option.getOrUndefined(
													Arr.findFirstIndex(splitStatements(file.text), (s) =>
														Str.includes(`X'${p.hex}'`)(s)
													)
												),
												"the literal is one of the file's statements"
											) + 1
										const change = d.changes[constant]
										const after = changedDigit(p.hex, change.digit, change.offset)
										const path = `${ws}/${folder}/${file.name}`
										const tamper = Str.replace(`X'${p.hex}'`, `X'${after}'`)
										yield* fs.writeFileString(path, tamper(file.text))
										const tampered = yield* cliOver(ws, config, ["check", configName], now(2))
										const found = yield* findings
										yield* fs.writeFileString(path, file.text)
										assert.equal(tampered.code, 1, `X'${after}' for X'${p.hex}' is refused`)
										const fault = faultOf(
											printObjectName(p.function),
											p.hex,
											after,
											Number(p.cells),
											p.width
										)
										assert.deepEqual(found, [
											{ kind: "literalPack", where: `${folder}/${file.name}`, statement, fault }
										])
										c.note(
											constant === "cells"
												? "the cells' literal changed"
												: "the key set's literal changed"
										)
										c.note(fault.kind === "layout" ? "a padding bit set" : "a cell changed")
									}
								})
							)
					)
				)
		)
	}
)
