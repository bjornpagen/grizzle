/**
 * The README's programs are programs grizzle generates. test/types/examples/fixtures/readme.ts is the README's program:
 * every block that declares a schema, a role, a login, a workload, a program or the configuration, each example's login
 * beside it. Typechecking it proves its types, not that grizzle compiles it: a program can typecheck and be refused by
 * `grizzle generate`, and then the README documents a program no application can serve. Here the module is imported and
 * generated, whole: `grizzle generate` runs over the README's own configuration with every login the module exports and
 * the installations they stand in (generates.fixtures.ts readmeConfig), and must exit 0, every login's workload compiled
 * (the need, readmeGenerated). Then:
 * - every query, ordered query and ChangeSet the module exports is served by a workload of a login it exports, so no
 *   program the README shows escapes the generate run;
 * - every ```sql block of README.md is SQL that run drafts: its lines, in order, lines of one drafted file, so the SQL
 *   the README shows is the compiler's output, never written by hand.
 *
 * Oracle: `grizzle generate` itself, the CLI in process over the README's configuration.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { readmePrograms, readmeSqlBlocks } from "#test/types/examples/generates.dictionary.ts"
import {
	draftedIn,
	readmeGenerated,
	readmeSqlBlock,
	servingLogins
} from "#test/types/examples/generates.fixtures.ts"

/** Every program the README's program exports is served by a login `grizzle generate` compiles it for. */
export const everyProgramTheReadmeShowsIsServedByALoginGrizzleGenerates = property.exhaust(
	readmePrograms,
	{
		box: "every query, ordered query and ChangeSet fixtures/readme.ts exports",
		needs: { readmeGenerated },
		situations: [],
		check:
			({ readmeGenerated: generated }) =>
			({ name, program }) =>
				Effect.gen(function* () {
					yield* generated
					assert.notDeepEqual(
						servingLogins(program),
						[],
						`${name} is served by no workload of a login fixtures/readme.ts exports, so grizzle generate never compiles it`
					)
				}),
		oracle: {
			kind: "specification",
			name: "grizzle generate, over the README's configuration with every login of its program"
		},
		show: ({ name }) => name,
		kept: [],
		kills: [
			{
				file: "test/types/examples/fixtures/readme.ts",
				original: "\tworkload: [workload(DriveReader, { folderSizes: answered(folderSizes) })]",
				replacement: "\tworkload: []",
				why: "The README's folderSizes is served by no login, so no generate run compiles the program its tree recipe shows."
			},
			{
				file: "test/types/examples/fixtures/readme.ts",
				original: 'export const FrontDesk = role(Rooms, "front_desk", ',
				replacement: 'export const FrontDesk = role(Rooms, "rooms", ',
				why: "The booking recipe's role takes its login's name, which grizzle generate refuses (a role named apart from its login): the README's program does not generate."
			}
		]
	}
)

/** Every sql block of the README is SQL `grizzle generate` drafts for the README's program. */
export const everySqlBlockOfTheReadmeIsSqlGrizzleDrafts = property.exhaust(readmeSqlBlocks, {
	box: "every sql block of README.md",
	needs: { readmeGenerated, checkout: Checkout.dir },
	situations: [],
	check:
		({ readmeGenerated: generated, checkout }) =>
		({ at }) =>
			Effect.gen(function* () {
				const { sql } = yield* generated
				const dir = yield* checkout
				const block = yield* readmeSqlBlock(dir, at)
				const drafted = draftedIn(block, sql)
				assert.deepEqual(
					drafted.missing,
					[],
					`README.md's sql block at line ${block.firstLine}, nearest ${drafted.file}`
				)
			}),
	oracle: {
		kind: "specification",
		name: "the SQL grizzle generate drafts for the README's program"
	},
	show: (block) => `README.md sql block at line ${block.firstLine}`,
	kept: [],
	kills: [
		{
			file: "README.md",
			original: '  CONSTRAINT "balanced" CHECK (("total" = 0::bigint) IS TRUE),',
			replacement: '  CONSTRAINT "balanced" CHECK ("total" = 0),',
			why: "The books recipe's CHECK written by hand, as grizzle never drafts it: the README shows SQL no generate run writes."
		}
	]
})
