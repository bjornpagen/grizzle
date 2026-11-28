import { Array as Arr, Effect, Result } from "effect"
import { windowCall } from "#adapter/page/window.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { RowKey } from "#compiler/live/index.ts"
import type { ScalarCodec } from "#compiler/plan/read.ts"
import { scalarCodec } from "#compiler/plan/runtime.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The window-anchor program: the box of anchors whose members' types decide them, each given as a paged member's
 * window anchor, one line of a program the type batch checks. A paged member's input's window holds an anchor of the
 * served program's type (live/program.ts Anchor): `{ kind: "start" }`, `{ kind: "end" }`, `{ kind: "after", key }`,
 * `{ kind: "before", key }` or `{ kind: "at", position }`.
 *
 * The oracle: the runtime's window parse (adapter/page/window.ts windowCall), which reads exactly the members each kind
 * carries, a key of one value per comparator and a position a safe integer of at least 0. Each cell's anchor is that
 * parse's admission, the same value read by it over the program's page, whose completed order compares two int4s, and
 * its line states the verdict: an admitted anchor typechecks as the window's, and a refused one is refused at it. A
 * position's range is no type's, so every cell's position is a safe integer of at least 0 or of another type, and each
 * key holds one int4 per comparator.
 */

/** The key every keyed cell carries, at run time: one int4 per comparator of the page's order (label, then id). */
const key = RowKey([1, 1])

/** Each cell: its anchor's text in the program, over the program's declared key, and the value the runtime reads. */
const anchors = {
	"the start": ['{ kind: "start" }', { kind: "start" }],
	"the end": ['{ kind: "end" }', { kind: "end" }],
	"after a key": ['{ kind: "after", key }', { kind: "after", key }],
	"before a key": ['{ kind: "before", key }', { kind: "before", key }],
	"at the first position": ['{ kind: "at", position: 0 }', { kind: "at", position: 0 }],
	"at a later position": ['{ kind: "at", position: 40 }', { kind: "at", position: 40 }],
	"at no position": ['{ kind: "at" }', { kind: "at" }],
	"at a position of text": ['{ kind: "at", position: "40" }', { kind: "at", position: "40" }],
	"at a position of a bigint": ['{ kind: "at", position: 40n }', { kind: "at", position: 40n }],
	"at a position and a key": ['{ kind: "at", position: 0, key }', { kind: "at", position: 0, key }],
	"the start at a position": ['{ kind: "start", position: 0 }', { kind: "start", position: 0 }],
	"after a position": ['{ kind: "after", position: 0 }', { kind: "after", position: 0 }],
	"a kind of no anchor": ['{ kind: "position", position: 0 }', { kind: "position", position: 0 }]
} as const satisfies Record<string, readonly [string, unknown]>

type Cell = keyof typeof anchors

/** The cells of anchorBox, minted as a dictionary in its door (test/types/api/anchor.dictionary.ts). */
export const anchorBoxItems: Arr.NonEmptyReadonlyArray<Cell> = [
	"the start",
	"the end",
	"after a key",
	"before a key",
	"at the first position",
	"at a later position",
	"at no position",
	"at a position of text",
	"at a position of a bigint",
	"at a position and a key",
	"the start at a position",
	"after a position",
	"a kind of no anchor"
]

/** The codecs of the program's page's comparators, label and id, each an int4, which write a key's boundary texts. */
const comparators: ReadonlyArray<ScalarCodec> = [
	scalarCodec(int4, emptyCodebook),
	scalarCodec(int4, emptyCodebook)
]

/** Whether the runtime's window parse admits a cell's anchor, in a window of size 2. */
const admitted = (cell: Cell): boolean =>
	Result.isSuccess(windowCall({ anchor: anchors[cell][1], size: 2 }, comparators))

/** The program's prelude (test/support/programs/anchors.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/anchors.ts"))

/** The page every cell anchors a window of, its Db, and the anchor type its window takes. */
const anchorHeader: ReadonlyArray<string> = [
	'export const Item = relation("Item", { id: int4, label: int4 }, ["id"])',
	'export const Root = schema("Root", [Item], [])',
	'export const level = role(Root, "level", wholeEntriesOf(Root))',
	"export const ranked = paged(",
	"\tquery(Root)",
	"\t\t.rule((r) => {",
	'\t\t\tconst { id, label } = v(Item, "item")',
	"\t\t\treturn r.match(Item, { id, label }).find({ id, label })",
	"\t\t})",
	'\t\t.orderBy(["label", "asc"])',
	")",
	"export const served = workload(Root, { ranked })",
	"export declare const db: Db<typeof level, typeof served.programs>",
	"/** The anchor a window of the paged member takes. */",
	'export type AnchorOf = Parameters<typeof db.workload.ranked.once>[0]["window"]["anchor"]',
	"/** A key of the page's order, as an entry of one of its windows carries it. */",
	"export declare const key: RowKey",
	""
]

/** A cell's lines: its anchor as the window's, refused at it where the runtime refuses it. */
const cellLines = (cell: Cell, at: number): ReadonlyArray<string> => [
	`// ${cell}`,
	...(admitted(cell)
		? []
		: ["// @ts-expect-error -- refused: the runtime's window parse refuses it"]),
	`export const a${at}: AnchorOf = ${anchors[cell][0]}`
]

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const anchorProgram = (cells: Arr.NonEmptyReadonlyArray<Cell>, entry: Entry): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/anchor.ts: a paged member's window anchors against the runtime's parse.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: anchorHeader },
			...Arr.map(cells, (cell, at) => ({ owner: caseOwned(at), lines: cellLines(cell, at) }))
		]
	)
]
