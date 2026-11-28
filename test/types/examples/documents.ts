import { Array as Arr, Effect, Result, String as Str } from "effect"
import { fileText, joinPath, repoRoot } from "#test/support/files.ts"
import { readmeModules } from "#test/support/readme.ts"

/**
 * The documentation's door: README.md's and SKILL.md's ts blocks, which test/types/examples mirrors in its fixtures,
 * README.md's sql blocks, which generates.test.ts holds to the SQL grizzle drafts, and the refusals the README states,
 * its fixtures' directives, each read off the files themselves when this module loads, so the boxes the examples'
 * properties exhaust are the documentation's own, never cases a person chose.
 */

/**
 * Each document with ts blocks, and the fixtures that mirror its blocks: every block found, line for line, in exactly
 * one of them, each fixture's blocks in document order. The README's program is two modules, as an application's is:
 * readme.ts, what grizzle compiles (schemas, roles, logins, workloads, programs and the configuration), which
 * generates.test.ts imports and generates; and readme.app.ts, the application, which reads the served files generate
 * writes and imports readme.ts's logins as types alone.
 */
const mirrors = [
	{ doc: "README.md", fixtures: readmeModules },
	{
		doc: "packages/grizzle/skills/grizzle/SKILL.md",
		fixtures: ["test/types/examples/fixtures/skill.ts"]
	}
] as const

export type Mirror = (typeof mirrors)[number]

/** A fenced block's text: the lines strictly between its opening fence and the next line that is exactly "```". */
export type BlockText = Readonly<{
	/** The block's lines, joined. */
	text: string
	/** The document line its first line is on. */
	firstLine: number
}>

/**
 * A document's blocks of one language, in order, each opened by a line that is exactly "```<language>", or why it has
 * none to check: a block with no closing fence, or no block at all.
 */
export const blocksOf = (
	doc: string,
	text: string,
	language: "ts" | "sql"
): Result.Result<ReadonlyArray<BlockText>, string> => {
	const fence = `\`\`\`${language}`
	const lines = Str.split(text, "\n")
	const blocks: Array<BlockText> = []
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== fence) {
			continue
		}
		const end = lines.indexOf("```", i + 1)
		if (end === -1) {
			return Result.fail(`${doc} line ${i + 1}: a ${language} block with no closing fence`)
		}
		blocks.push({ text: Arr.join(lines.slice(i + 1, end), "\n"), firstLine: i + 2 })
		i = end
	}
	return Arr.isReadonlyArrayNonEmpty(blocks)
		? Result.succeed(blocks)
		: Result.fail(`${doc}: no ${language} block`)
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
		Result.match(blocksOf(mirror.doc, text, "ts"), {
			onFailure: (why) => {
				throw new Error(why)
			},
			onSuccess: (blocks) => Arr.map(blocks, (_, at): DocumentedBlock => ({ mirror, at }))
		})
	),
	"ts block"
)

/** A sql block of README.md, by its place among the README's sql blocks and the line it starts on. */
export type ReadmeSqlBlock = Readonly<{ at: number; firstLine: number }>

/**
 * The cells of readmeSqlBlocks, minted as a dictionary in its door (test/types/examples/generates.dictionary.ts): each
 * sql block of README.md, the SQL of a file `grizzle generate` drafts for the README's program, read again from the
 * checkout a case runs against (generates.test.ts), so a mutant of the README is what its check reads.
 */
export const readmeSqlBlocksItems = Result.match(
	blocksOf("README.md", Arr.getUnsafe(documents, 0).text, "sql"),
	{
		onFailure: (why) => {
			throw new Error(why)
		},
		onSuccess: (blocks) =>
			nonEmpty(
				Arr.map(blocks, (block, at): ReadmeSqlBlock => ({ at, firstLine: block.firstLine })),
				"sql block"
			)
	}
)

/** The README's fixtures, each as it stands when this module loads: the program its refusals are checked in. */
export const readmeFixtures = await Effect.runPromise(
	Effect.forEach(readmeModules, (file) =>
		Effect.map(fileText(joinPath(repoRoot, file)), (text) => ({ file, text }))
	)
)

/** A refusal the README states: its fixture, its directive's line there, and the directive. */
export type StatedRefusal = Readonly<{ file: string; line: number; directive: string }>

/** The cells of statedRefusals, minted as a dictionary in its door (test/types/examples/examples.dictionary.ts). */
export const statedRefusalsItems = nonEmpty(
	Arr.flatMap(readmeFixtures, ({ file, text: fixture }) =>
		Arr.flatMap(Str.split(fixture, "\n"), (text, index): ReadonlyArray<StatedRefusal> =>
			Str.startsWith("// @ts-expect-error")(Str.trim(text))
				? [{ file, line: index + 1, directive: Str.trim(text) }]
				: []
		)
	),
	"stated refusal"
)
