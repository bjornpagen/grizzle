import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Cause,
	Effect,
	FileSystem,
	Path,
	Record,
	Result,
	String as Str
} from "effect"
import { levelChain } from "#compiler/ir/desc.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/query.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import { isChangeSetValue } from "#compiler/write/changeset/value.ts"
import { defineConfig } from "#index.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { cliOver, configName, workspace } from "#test/support/pg/cli/support.ts"
import { type BlockText, blocksOf } from "#test/types/examples/documents.ts"
import * as readme from "#test/types/examples/fixtures/readme.ts"

/**
 * What generates.test.ts reads: the README's program (fixtures/readme.ts) as grizzle compiles it. Its logins are every
 * login the module exports, its installations the top level each of their bases stands in, and the programs it documents
 * every query, ordered query and ChangeSet it exports; the configuration that generates them all is the README's own
 * (the module's default export) with those installations and logins, so no list a person keeps decides what is
 * generated.
 */

/** Every value the README's program exports, by its name. */
const exported: ReadonlyArray<readonly [string, unknown]> = Record.toEntries(readme)

const isLogin = (value: unknown): value is AnyLogin => loginDescOf(value) !== undefined

/** Every login the README's program exports. */
const logins: ReadonlyArray<AnyLogin> = Arr.filter(
	Arr.map(exported, ([, value]) => value),
	isLogin
)

/** The names of every level of the installation `schema` stands in, its root first and itself last. */
const levelsOf = (schema: AnySchema): ReadonlyArray<string> => {
	const desc = schemaDescOf(schema)
	if (desc === undefined) {
		throw new Error("a login's base is a schema built by schema(...) or schema.extend(...)")
	}
	return Arr.map(levelChain(desc), (level) => level.name)
}

/**
 * Each installation the logins stand in, by its top level: a login's base no other login's base stands above, once
 * each, as a configuration lists it.
 */
const installations: ReadonlyArray<AnySchema> = Arr.dedupeWith(
	Arr.filter(
		Arr.map(logins, (login) => login.base),
		(base) =>
			!Arr.some(
				logins,
				(other) => other.base.name !== base.name && Arr.contains(levelsOf(other.base), base.name)
			)
	),
	(a, b) => a.name === b.name
)

/** The README's configuration, every installation and login of its program in it. */
export const readmeConfig = defineConfig({
	...readme.default,
	schemas: nonEmpty(installations, "the README's program exports a login"),
	logins
})

/** A program the README documents: its exported name and the value. */
export type DocumentedProgram = Readonly<{ name: string; program: unknown }>

/** The cells of readmePrograms, minted as a dictionary in its door (test/types/examples/generates.dictionary.ts). */
export const readmeProgramsItems: ReadonlyArray<DocumentedProgram> = Arr.flatMap(
	exported,
	([name, program]) =>
		isQueryValue(program) || isOrderedValue(program) || isChangeSetValue(program)
			? [{ name, program }]
			: []
)

/** The program a workload member serves: the member itself, or the program answered(...), paged(...) or clocked(...) wraps. */
const servedProgram = (member: unknown): unknown => {
	if (typeof member !== "object" || member === null) {
		return member
	}
	for (const wrapper of ["answered", "paged", "clocked"] as const) {
		if (Reflect.has(member, wrapper)) {
			return servedProgram(Reflect.get(member, wrapper))
		}
	}
	return member
}

/** The logins whose workloads serve `program`, each with the member's name. */
export const servingLogins = (
	program: unknown
): ReadonlyArray<Readonly<{ login: string; member: string }>> =>
	Arr.flatMap(logins, (login) =>
		Arr.flatMap(login.workload, (served) =>
			Arr.flatMap(Record.toEntries(served.programs), ([member, value]) =>
				servedProgram(value) === program ? [{ login: login.name, member }] : []
			)
		)
	)

/** A file `grizzle generate` drafted: its path under the workspace and its lines. */
export type DraftedFile = Readonly<{ file: string; lines: ReadonlyArray<string> }>

/** Every .sql file under `dir`, at any depth, with its lines. */
const sqlFiles = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const entries = yield* fs.readDirectory(dir, { recursive: true })
		return yield* Effect.forEach(
			Arr.filter(entries, (entry) => Str.endsWith(".sql")(entry)),
			(entry) =>
				Effect.map(fs.readFileString(path.join(dir, entry)), (text): DraftedFile => ({
					file: entry,
					lines: Str.split(text, "\n")
				}))
		)
	})

/**
 * The README's program generated: `grizzle generate` over readmeConfig in a scratch workspace, which must exit 0, every
 * login's workload compiled, and every SQL file it drafted.
 */
export const readmeGenerated = {
	key: "test/types/examples/generates.fixtures.ts readmeGenerated",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const ws = yield* workspace("readme")
		const generated = yield* cliOver(ws, readmeConfig, ["generate", configName])
		assert.equal(
			generated.code,
			0,
			`grizzle generate refuses the README's program:\n${generated.stdout}${generated.stderr}`
		)
		return { sql: yield* sqlFiles(`${ws}/migrations`) }
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/types/examples/generates.fixtures.ts readmeGenerated",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>

/**
 * The drafted file that holds every non-blank line of `block`, each a whole line, in order, or the block's lines the
 * file that holds most of them misses.
 */
export const draftedIn = (
	block: BlockText,
	files: ReadonlyArray<DraftedFile>
): Readonly<{ file: string; missing: ReadonlyArray<string> }> => {
	const wanted = Arr.filter(Str.split(block.text, "\n"), (line) => Str.trim(line) !== "")
	const tried = Arr.map(files, ({ file, lines }) => {
		let at = -1
		const missing = Arr.filter(wanted, (line) => {
			const found = lines.indexOf(line, at + 1)
			if (found === -1) {
				return true
			}
			at = found
			return false
		})
		return { file, missing }
	})
	return Arr.reduce(tried, { file: "no file", missing: wanted }, (best, next) =>
		next.missing.length < best.missing.length ? next : best
	)
}

/** README.md's sql block `at`, read from the checkout at `checkout`. */
export const readmeSqlBlock = (checkout: string, at: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const readme = yield* fs.readFileString(path.join(checkout, "README.md"))
		const blocks = blocksOf("README.md", readme, "sql")
		if (Result.isFailure(blocks)) {
			return yield* Effect.die(blocks.failure)
		}
		const block = blocks.success[at]
		if (block === undefined) {
			return yield* Effect.die(`README.md holds no sql block ${at + 1}`)
		}
		return block
	})
