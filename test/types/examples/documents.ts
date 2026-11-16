import { Array as Arr, Effect, Result, String as Str } from "effect"
import { fileText, joinPath, repoRoot } from "#test/support/files.ts"

/**
 * The documentation's door: README.md's and SKILL.md's ts blocks, which test/types/examples mirrors in its fixtures,
 * and the refusals the README states, its fixture's directives, each read off the files themselves when this module
 * loads, so the boxes the examples' properties exhaust are the documentation's own, never cases a person chose.
 */

/** Each document with ts blocks, and the fixture that mirrors its blocks, line for line and in order. */
const mirrors = [
	{ doc: "README.md", fixture: "test/types/examples/fixtures/readme.ts" },
	{
		doc: "packages/grizzle/skills/grizzle/SKILL.md",
		fixture: "test/types/examples/fixtures/skill.ts"
	}
] as const

export type Mirror = (typeof mirrors)[number]

/** A ts block's text: the lines strictly between a line that is exactly "```ts" and the next line that is exactly "```". */
export type BlockText = Readonly<{
	/** The block's lines, joined. */
	text: string
	/** The document line its first line is on. */
	firstLine: number
}>

/** A document's ts blocks, in order, or why it has none to check: a block with no closing fence, or no block at all. */
export const blocksOf = (
	doc: string,
	text: string
): Result.Result<ReadonlyArray<BlockText>, string> => {
	const lines = Str.split(text, "\n")
	const blocks: Array<BlockText> = []
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== "```ts") {
			continue
		}
		const end = lines.indexOf("```", i + 1)
		if (end === -1) {
			return Result.fail(`${doc} line ${i + 1}: a ts block with no closing fence`)
		}
		blocks.push({ text: Arr.join(lines.slice(i + 1, end), "\n"), firstLine: i + 2 })
		i = end
	}
	return Arr.isReadonlyArrayNonEmpty(blocks)
		? Result.succeed(blocks)
		: Result.fail(`${doc}: no ts block`)
}

/** A documented block, by its document and its place among the document's ts blocks. */
export type DocumentedBlock = Readonly<{ mirror: Mirror; at: number }>

/** Each document's text, as it stands when this module loads. */
const documents = await Effect.runPromise(
	Effect.forEach(mirrors, (mirror) =>
		Effect.map(fileText(joinPath(repoRoot, mirror.doc)), (text) => ({ mirror, text }))
	)
)

/** A box's cells, or the defect of the documentation that leaves it none: the module refuses to load. */
const nonEmpty = <A>(cells: ReadonlyArray<A>, what: string): Arr.NonEmptyReadonlyArray<A> => {
	if (!Arr.isReadonlyArrayNonEmpty(cells)) {
		throw new Error(`the documentation holds no ${what}`)
	}
	return cells
}

/** The cells of documentedBlocks, minted as a dictionary in its door (test/types/examples/blocks.dictionary.ts). */
export const documentedBlocksItems = nonEmpty(
	Arr.flatMap(documents, ({ mirror, text }) =>
		Result.match(blocksOf(mirror.doc, text), {
			onFailure: (why) => {
				throw new Error(why)
			},
			onSuccess: (blocks) => Arr.map(blocks, (_, at): DocumentedBlock => ({ mirror, at }))
		})
	),
	"ts block"
)

/** The README's fixture, as it stands when this module loads: the program its refusals are checked in. */
export const readmeFixture = await Effect.runPromise(
	fileText(joinPath(repoRoot, "test/types/examples/fixtures/readme.ts"))
)

/** A refusal the README states: its directive's line in the fixture, and the directive. */
export type StatedRefusal = Readonly<{ line: number; directive: string }>

/** The cells of statedRefusals, minted as a dictionary in its door (test/types/examples/examples.dictionary.ts). */
export const statedRefusalsItems = nonEmpty(
	Arr.flatMap(Str.split(readmeFixture, "\n"), (text, index): ReadonlyArray<StatedRefusal> =>
		Str.startsWith("// @ts-expect-error")(Str.trim(text))
			? [{ line: index + 1, directive: Str.trim(text) }]
			: []
	),
	"stated refusal"
)
