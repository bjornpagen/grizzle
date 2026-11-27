/**
 * PL/pgSQL compiles every block grizzle prints in time linear in its source (sql/print.ts proceduralBlock): each
 * statement of a block is one line, so PL/pgSQL's location-to-line resolution, which restarts from the source's first
 * byte at every location before the line it last resolved (PostgreSQL 19.0, src/pl/plpgsql/src/pl_scanner.c
 * plpgsql_location_to_lineno), never goes back but at the block's own BEGIN, resolved last.
 *
 * - **Property:** over generated schemas, every PL/pgSQL function and DO block an installation's statements print, its
 *   source as PostgreSQL stores it, resolves its locations with at most one rescan, the BEGIN's, and walks at most its
 *   source once and the lines up to its BEGIN once more. An installation prints no DO block (it sets no database
 *   default, physical/ddl/isolation.ts), so the blocks' property reaches one.
 * - **Oracle:** specification: PL/pgSQL's grammar's order of resolution (pl_gram.y: a simple statement as it is read, a
 *   compound statement, each ELSIF and each WHEN arm after its body, the block's BEGIN after its END) and the
 *   resolver's walk, line by line, transcribed apart from the printer (plpgsql-lines.fixtures.ts), read off the
 *   printed text's lexemes, never off the block's tree.
 * - **Space:** generated schemas (install.fixtures.ts generatedGen), each installed with the oracle's login; and every
 *   block of one to three IFs or CASE arms, each holding a RAISE or another IF, a text constant in its condition or a
 *   RAISE's message holding a line feed or not, as a function's source and as a DO statement.
 * - **Features:** a function's body and a compound statement over generated schemas; over the blocks, a DO block, one
 *   nested in another and a constant holding a line feed too.
 */

import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { PlBlock, PlFunction, PlStatement } from "#compiler/sql/ast.ts"
import { eq, lit, types } from "#compiler/sql/build.ts"
import { lexemesOf } from "#compiler/sql/lexer.ts"
import { functionSource, printCommands, sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import { generatedGen, installed } from "#test/unit/physical/install.fixtures.ts"
import { lineResolution } from "#test/unit/sql/plpgsql-lines.fixtures.ts"

type LinesFeature =
	| "a function's body"
	| "a DO block"
	| "a compound statement"
	| "a nested compound statement"

/** The PL/pgSQL blocks a printed command holds: a DO statement's body, or a LANGUAGE plpgsql function's. */
const blocksOf = (
	command: string
): ReadonlyArray<{
	readonly source: string
	readonly kind: "a function's body" | "a DO block"
}> => {
	const lexemes = lexemesOf(command).lexemes
	const word = (i: number): string | undefined => {
		const l = lexemes[i]
		return l?.kind === "word" ? l.upper : undefined
	}
	const plpgsql = Arr.some(lexemes, (_, i) => word(i) === "LANGUAGE" && word(i + 1) === "PLPGSQL")
	const kind = word(0) === "DO" ? ("a DO block" as const) : ("a function's body" as const)
	return Arr.flatMap(lexemes, (l) =>
		l.kind === "dollar" && (plpgsql || kind === "a DO block") ? [{ source: l.body, kind }] : []
	)
}

/** Every PL/pgSQL block an installation prints resolves its lines in one pass and one rescan of its declarations. */
export const everyPlpgsqlBlockResolvesItsLinesInOnePassAndOneRescanOfItsDeclarations =
	property.explore(generatedGen, {
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: ["a function's body", "a compound statement"] satisfies ReadonlyArray<
			Reached<LinesFeature>
		>,
		check: (_, c: Case<LinesFeature>) => (desc) =>
			Effect.sync(() => {
				for (const statement of installed(desc).statements) {
					for (const command of printCommands(statement)) {
						for (const { source, kind } of blocksOf(command)) {
							c.note(kind)
							const resolved = lineResolution(source)
							if (resolved.compound > 0) {
								c.note("a compound statement")
							}
							assert.ok(
								resolved.rescans <= 1,
								`${resolved.rescans} rescans resolving ${resolved.requests} locations, only the BEGIN's allowed`
							)
							assert.ok(
								resolved.scanned <= resolved.bound,
								`${resolved.scanned} bytes walked over a source of ${source.length}`
							)
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "PL/pgSQL's order of line resolution and plpgsql_location_to_lineno's walk, read off each printed block's lexemes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\t\tstatements.line(lineFeedsEscaped(inlineText((row) => statement(row, s))))\n",
				replacement: "\t\tstatement(statements, s)\n",
				why: "Each statement of a block is printed over lines, its body's below its own, so every compound statement whose body begins a later line sends PL/pgSQL's line resolution back to the source's first byte, and a block of N of them compiles in O(N x length) at CREATE FUNCTION and at every backend's first call."
			}
		]
	})

/** A block's shape: its compound statement, how many branches or arms, what each holds, and whether a constant of it
 * holds a line feed. */
interface BlockShape {
	readonly compound: "if" | "case"
	readonly arms: 1 | 2 | 3
	readonly nested: boolean
	readonly lineFeed: boolean
}

const blockShapeGen: Gen<BlockShape> = (s) => ({
	compound: s.draw(element<BlockShape["compound"]>(["if", "case"])),
	arms: s.draw(element<BlockShape["arms"]>([1, 2, 3])),
	nested: s.draw(boolean),
	lineFeed: s.draw(boolean)
})

/** The block of a shape: its compound statement over `x`, each branch's or arm's body a RAISE, or an IF holding one. */
const blockOf = (shape: BlockShape): PlBlock => {
	const text = (n: number): string => (shape.lineFeed ? `arm ${n}\nof the block` : `arm ${n}`)
	const raise = (n: number): PlStatement => ({ kind: "raise", message: text(n), using: [] })
	const body = (n: number): PlStatement =>
		shape.nested
			? {
					kind: "if",
					branches: [
						{
							condition: eq(lit.text(text(n), types.text), lit.text("y", types.text)),
							body: [raise(n)]
						}
					],
					else: []
				}
			: raise(n)
	const arms: NonEmptyReadonlyArray<number> = [
		1,
		...Array.from({ length: shape.arms - 1 }, (_, i) => i + 2)
	]
	const compound: PlStatement =
		shape.compound === "if"
			? {
					kind: "if",
					branches: mapNonEmpty(arms, (n) => ({
						condition: eq(lit.text(text(n), types.text), lit.text("x", types.text)),
						body: [body(n), raise(n)]
					})),
					else: [raise(0)]
				}
			: {
					kind: "case",
					operand: lit.text("x", types.text),
					whens: mapNonEmpty(arms, (n) => ({
						values: [lit.text(text(n), types.text)],
						body: [body(n), raise(n)]
					}))
				}
	return { declare: [], body: [compound, raise(9)] }
}

/** A function of `block`, whose source functionSource reads. */
const functionOf = (block: PlBlock): PlFunction => ({
	kind: "createFunction",
	advice: undefined,
	language: "plpgsql",
	name: { schema: "lines", name: "block" },
	volatility: "VOLATILE",
	parallel: "UNSAFE",
	security: "DEFINER",
	returns: "void",
	params: [],
	body: block
})

/** Every block of the space resolves its lines in one pass and one rescan of its declarations, in either form. */
export const everyBlockOfCompoundStatementsResolvesItsLinesInOnePass = property.exhaust(
	finite(blockShapeGen),
	{
		needs: {},
		situations: [
			"a function's body",
			"a DO block",
			"a compound statement",
			"a nested compound statement",
			"a constant holding a line feed"
		] satisfies ReadonlyArray<Reached<LinesFeature | "a constant holding a line feed">>,
		check: (_, c: Case<LinesFeature | "a constant holding a line feed">) => (shape) =>
			Effect.sync(() => {
				const block = blockOf(shape)
				const command = sqlText(SourceLoc("plpgsql-lines", []), (out) => writeDoBlock(out, block))
				const sources = [
					{ kind: "a function's body" as const, source: functionSource(functionOf(block)) },
					...blocksOf(command)
				]
				if (shape.lineFeed) {
					c.note("a constant holding a line feed")
				}
				for (const { kind, source } of sources) {
					c.note(kind)
					const resolved = lineResolution(source)
					c.note("a compound statement")
					if (resolved.nested) {
						c.note("a nested compound statement")
					}
					assert.ok(resolved.rescans <= 1, `${resolved.rescans} rescans, only the BEGIN's allowed`)
					assert.ok(
						resolved.scanned <= resolved.bound,
						`${resolved.scanned} bytes walked over ${source.length}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "PL/pgSQL's order of line resolution and plpgsql_location_to_lineno's walk, read off each printed block's lexemes"
		},
		box: "every block of an IF or a CASE of one to three branches, each holding a RAISE or an IF of one, with and without a line feed in its constants",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\t\tstatements.line(lineFeedsEscaped(inlineText((row) => statement(row, s))))\n",
				replacement: "\t\tstatements.line(inlineText((row) => statement(row, s)))\n",
				why: "A string constant holding a line feed is spelled raw, so its statement's line ends inside it, the statements after it in the compound statement's body begin later lines, and the compound statement's own resolution goes back to the source's first byte."
			}
		]
	}
)
