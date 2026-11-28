/**
 * What config-reads.test.ts reads: a consumer-shaped project, written into a workspace of its own as text, as den's and
 * metis's are built (a contract, the key holder's checked mint of it, a schema holding it, a flow's module that decodes
 * through the mint where it is declared, the logins over it and the configuration over those); and the runs of `grizzle
 * generate` over it, its configuration imported by the bin's own import (cli/main.ts configAt), each in a copy of its
 * own, so no module the process imported before is read again.
 */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Record as Rec,
	String as Str
} from "effect"
import { configAt } from "#cli/main.ts"
import type { CliReport } from "#cli/run.ts"
import { formatOf } from "#compiler/core/format.ts"
import { cliLoading, configName, workspace } from "#test/support/pg/cli/support.ts"

/** How every file `grizzle generate` wrote is left before the next generate: garbled, of another format, or removed. */
export type Corruption = "garbled" | "another format" | "removed"

/**
 * A case: the project as den builds it, every file generate wrote then corrupted; or the project whose flow's module
 * imports a file generate wrote, as a consumer's module that read its contract's checker file did.
 */
export type Shape =
	| { readonly kind: "builds its checked mint"; readonly corruption: Corruption }
	| { readonly kind: "imports a generated file" }

export const shapes: Gen<Shape> = (source) =>
	source.draw(
		oneOf<Shape>([
			(s) => ({
				kind: "builds its checked mint",
				corruption: s.draw(element(["garbled", "another format", "removed"] as const))
			}),
			() => ({ kind: "imports a generated file" })
		])
	)

/** The project's flow module, which decodes a step's input through the key holder's checked mint where it is declared. */
const flowsText = (imports: string): string => `${imports}import { centsParser } from "./parsers.ts"

/** A step's input decoded through the checked mint where the flow is declared, as den's domainInput decodes it. */
export const fee = centsParser.parse(5n)
`

/** The project's modules, each by its file name within the project, its flow's module importing `imports` first. */
const projectFiles = (imports: string): Readonly<Record<string, string>> => ({
	"contracts.ts": `import * as g from "@bjornpagen/grizzle"

export const centsKey = Symbol("Cents")

/** An amount: any int8 from 0 to 2^62. */
export const Cents = g.domain<typeof centsKey>()("Cents", g.int8, (c) => g.Num.within(c, 0n, 2n ** 62n))
`,
	"parsers.ts": `import * as gDomain from "@bjornpagen/grizzle/domain"
import { Cents, centsKey } from "./contracts.ts"

/** The key holder's checked mint of Cents. */
export const centsParser = gDomain.domainParser(Cents, centsKey)
`,
	"schema.ts": `import * as g from "@bjornpagen/grizzle"
import { Cents } from "./contracts.ts"

export const Entry = g.relation("Entry", { name: g.str.bytes(64, g.str.regex("^[a-z]+$")), amount: Cents }, ["name"])
export const Book = g.schema("Book", [Entry], [])
`,
	"flows.ts": flowsText(imports),
	"logins.ts": `import * as g from "@bjornpagen/grizzle"
import { fee } from "./flows.ts"
import { Book, Entry } from "./schema.ts"

const Writer = g.role(Book, "writer", g.wholeEntriesOf(Book), { insert: ["Entry"] })

export const App = g.login(Book, "app", [Writer], {
	workload: [g.workload(Writer, { add: g.ChangeSet.empty(Writer).insert(Entry, []) })]
})

export const declaredFee = fee
`,
	[configName]: `import * as g from "@bjornpagen/grizzle"
import { App } from "./logins.ts"
import { Book } from "./schema.ts"

export default g.defineConfig({
	schemas: [Book],
	logins: [App],
	migrations: "migrations",
	rolePrefixBytes: 0,
	connection: () => {
		throw new Error("grizzle generate connects to nothing")
	}
})
`
})

/** The project's flow module importing the generated file at `generated`, relative to the project, under `served`. */
export const importing = (generated: string): string =>
	`import served from "./${generated}" with { type: "json" }\nexport const servedLogin = served\n`

/** Writes the project, its flow's module importing `imports` first, into `dir`. */
export const writeProject = (dir: string, imports: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* Effect.forEach(Rec.toEntries(projectFiles(imports)), ([name, text]) =>
			fs.writeFileString(path.join(dir, name), text)
		)
	})

/**
 * `grizzle generate` over a copy of the project at `project`, in a workspace of its own, so every module of the project
 * is imported anew: its report, and the copy.
 */
export const generatedFrom = (project: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const space = yield* workspace("config-reads")
		const copy = path.join(space, "project")
		yield* fs.copy(project, copy)
		const run = yield* cliLoading(copy, configAt, ["generate", configName, "--name", "init"])
		return { report: run.report, copy }
	})

/** Every file of the migrations directory of the project at `project`, by its path within the project, as its text. */
export const generatedTree = (project: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const migrations = path.join(project, "migrations")
		const entries = yield* fs.readDirectory(migrations, { recursive: true })
		const files = yield* Effect.filter(entries, (entry) =>
			Effect.map(fs.stat(path.join(migrations, entry)), (info) => info.type === "File")
		)
		const read = yield* Effect.forEach(Arr.sort(files, Str.Order), (file) =>
			Effect.map(
				fs.readFileString(path.join(migrations, file)),
				(text) => [path.join("migrations", file), text] as const
			)
		)
		return Rec.fromEntries(read)
	})

/** A format no grizzle writes, which a file of another grizzle's format records. */
const anotherFormat = `8:${Str.repeat(64)("0")}`

/** A file's text with every format this grizzle records (core/format.ts formatOf) replaced by another. */
const ofAnotherFormat = (text: string): string =>
	Str.replaceAll(
		formatOf.served,
		anotherFormat
	)(Str.replaceAll(formatOf.snapshot, anotherFormat)(text))

/** Leaves every file of `tree`, in the project at `project`, as `corruption` states. */
export const corrupt = (
	project: string,
	tree: Readonly<Record<string, string>>,
	corruption: Corruption
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* Effect.forEach(Rec.toEntries(tree), ([file, text]) => {
			const at = path.join(project, file)
			switch (corruption) {
				case "garbled":
					return fs.writeFileString(at, "\u0000 garbled\n")
				case "another format":
					return fs.writeFileString(at, ofAnotherFormat(text))
				case "removed":
					return fs.remove(at)
			}
		})
	})

/** Removes the migrations directory of the project at `project`: an artifact's one remedy, purge and regenerate. */
export const purged = (project: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.flatMap(Path.Path, (path) =>
			fs.remove(path.join(project, "migrations"), { recursive: true })
		)
	)

/** The generated file of `tree` a login's served file is, by its path within the project. */
export const servedFileOf = (tree: Readonly<Record<string, string>>): string =>
	defined(
		Option.getOrUndefined(Arr.findFirst(Rec.keys(tree), Str.endsWith("/served/app.json"))),
		"the app login's served file among the files generate wrote"
	)

/** Whether a report is a refusal at the configuration's stage: the configuration did not load. */
export const refusedAtConfig = (report: CliReport): boolean =>
	report.outcome === "refused" &&
	report.refusal._tag === "CliError" &&
	report.refusal.stage === "config"
