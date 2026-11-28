/** What the properties of draft-key.test.ts read: their projects, runs, traces and the README's section. */

import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, element, type Gen, int, map } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import {
	type DraftContext,
	type DraftInput,
	draftInputOrder,
	draftKey,
	grizzlePackages,
	isGrizzleFile,
	isPackageFile,
	isVisibleUnder,
	lockfileName,
	nodeVariables
} from "#cli/draft-inputs.ts"
import { scratchName } from "#cli/files.ts"
import { sha256Octets } from "#compiler/core/digest.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { parseMigrationName } from "#compiler/plan/migration.ts"
import { noDeclarations } from "#compiler/plan/migration.ts"
import {
	binIn,
	configFileOf,
	firstFrom,
	otherConfigName,
	type Project,
	projectOf,
	type RunEnv,
	type RunFeature,
	runNotes,
	runPairGen
} from "#test/support/bin-runs.ts"
import { repoRoot } from "#test/support/files.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { workspace } from "#test/support/pg/cli/support.ts"
import { type ReadTrace, traceVariable } from "#test/support/read-trace.ts"

/** The declared schema every project drafts. */
const schemaName = "DraftKey"

/** The schema's directory under a project, `migrations/<its PostgreSQL schema>`. */
const schemaDir = `migrations/${identifierOf(identity.schema(parsedSchemaName(schemaName)))}`

/** The module beside the configuration file that declares the schema and its login. */
const schemaModule = "schema.ts"

/**
 * The schema module at `version`: a shop of customers and orders, its login serving a customer by key, by name and an
 * insert, version 2 adding Customer.tier. It imports grizzle's authoring entry alone, so the configuration's closure is
 * its own two files, grizzle's packages and the packages they load.
 */
const schemaText = (version: 1 | 2): string => `import {
	ChangeSet,
	contained,
	contract,
	login,
	on,
	query,
	relation,
	role,
	schema,
	str,
	uuid,
	v,
	wholeEntriesOf,
	wholeWritesOf,
	workload,
	int4,
	int8
} from "@bjornpagen/grizzle"

const idKey = Symbol("Id")
const Id = contract<typeof idKey>()("Id", uuid)
const Customer = relation(
	"Customer",
	{ id: Id, name: str.regex("^[a-z]{1,40}$")${version === 2 ? ", tier: int4" : ""} },
	["id"]
)
const Order = relation("Order", { id: Id, customer: Id, cents: int8 }, ["id"])
const shop = schema(${jsonText(schemaName)}, [Customer, Order], [contained(on(Order, "customer"), on(Customer, "id"))])
const reader = role(shop, "reader", wholeEntriesOf(shop))
const writer = role(shop, "writer", wholeEntriesOf(shop), wholeWritesOf(shop))
const customersByName = query(shop).rule((r) => {
	const c = v(Customer, "customer")
	return r
		.match(Customer, { id: c.id, name: c.name })
		.where(r.eq(c.name, r.param("name", Customer.fields.name)))
		.find({ id: c.id, name: c.name })
})

export const server = login(shop, "server", [reader, writer], {
	workload: [
		workload(shop, { customer: Customer, customersByName }),
		workload(writer, { addCustomer: ChangeSet.empty(writer).insert(Customer, []) })
	]
})

export { shop }
`

/** The configuration file every project holds: the schema module's shop and login, never connecting. */
const configText = `import { defineConfig } from "@bjornpagen/grizzle"
import { server, shop } from "./${schemaModule}"

export default defineConfig({
	schemas: [shop],
	logins: [server],
	migrations: "migrations",
	rolePrefixBytes: 0,
	connection: () => {
		throw new Error("generate never connects")
	}
})
`

/** `dir` holding the configuration file `config` and the schema module at `version`. */
const writeProject = (dir: string, config: string, version: 1 | 2) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(`${dir}/${schemaModule}`, schemaText(version))
		yield* fs.writeFileString(`${dir}/${config}`, configText)
	})

/** A case of the twin runs: two projects' processes, apart in every way a run can be. */
export interface Twins {
	readonly runs: readonly [RunEnv, RunEnv]
}

const twinsGen: Gen<Twins> = map(runPairGen, (runs) => ({ runs }))

/** Twins, or, for a witness while a situation is pending, twins aimed at it. */
export const twinsSpace = aimed(twinsGen, [
	["run from the project", map(twinsGen, (t) => ({ runs: firstFrom(t.runs, "the project") }))],
	["run from the workspace", map(twinsGen, (t) => ({ runs: firstFrom(t.runs, "the workspace") }))],
	["run from the checkout", map(twinsGen, (t) => ({ runs: firstFrom(t.runs, "the checkout") }))],
	[
		"a project nested in a path with a space",
		map(twinsGen, (t) => ({
			runs: [{ ...t.runs[0], nesting: ["with space"] }, t.runs[1]] as const
		}))
	],
	[
		"a configuration file of another name",
		map(twinsGen, (t) => ({
			runs: [{ ...t.runs[0], config: otherConfigName }, t.runs[1]] as const
		}))
	]
])

/** The trace test/support/read-trace-probe.ts wrote to `file`. */
const traceAt = (file: string) =>
	Effect.map(FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(file))), (text) =>
		trustedJson<ReadTrace>(text)
	)

/** An absolute path from a module's file: URL. */
const pathOfUrl = (url: string): string => decodeURIComponent(Str.slice("file://".length)(url))

/**
 * What a traced generate in project `p` read outside the roster (draft-inputs.ts), each as a line: a module that is no
 * file of grizzle's packages, of a package (the lockfile's) or of the configuration's own two; a read of the file system
 * that is no configuration file, no visible entry of the migrations directory and nothing at or under the process's own
 * staging entry (files.ts scratchName) of one, which holds what the process wrote; a variable read but by Node's own
 * code, of the variables it reads of its own; and
 * every reading of the clock.
 */
const outsideRoster = (trace: ReadTrace, p: Project, checkout: string): ReadonlyArray<string> => {
	const config = configFileOf(p)
	const own = [config, `${p.dir}/${schemaModule}`]
	const migrations = `${p.dir}/migrations`
	const scratch = scratchName(trace.pid)
	const modules = Arr.flatMap(trace.loads, (url) => {
		if (Str.startsWith("node:")(url)) {
			return []
		}
		const path = pathOfUrl(url)
		return isGrizzleFile(checkout, path) || isPackageFile(path) || Arr.contains(own, path)
			? []
			: [`a module outside the roster: ${path}`]
	})
	const reads = Arr.flatMap(trace.reads, (r) => {
		const ownScratch = Option.match(Str.indexOf(`/${scratch}`)(r.path), {
			onNone: () => false,
			onSome: (at) => {
				const rest = Str.slice(at + 1 + scratch.length)(r.path)
				return (
					(rest === "" || Str.startsWith("/")(rest)) &&
					isVisibleUnder(migrations, Str.slice(0, at)(r.path))
				)
			}
		})
		return r.path === config || isVisibleUnder(migrations, r.path) || ownScratch
			? []
			: [`a read outside the roster: ${r.call} ${r.path} by ${r.by}`]
	})
	const env = Arr.flatMap(trace.env, (e) =>
		e.node && Arr.contains(nodeVariables, e.name) ? [] : [`a variable read: ${e.name} by ${e.by}`]
	)
	const clock = Arr.map(trace.clock, (c) => `a reading of the clock: ${c.name} by ${c.by}`)
	return Arr.dedupe([...modules, ...reads, ...env, ...clock])
}

/**
 * Two projects of one source at two paths, one key: `grizzle draft-key` in each, its own process in its own time zone
 * and locale from its own directory, prints one key; and `grizzle generate` in the first, under the read trace, reads
 * nothing outside the roster.
 */
export const twinKeysAndTrace = (checkout: string, t: Twins, c: Case<RunFeature>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.noteAll(runNotes(t.runs))
			const [envA, envB] = t.runs
			const a = yield* projectOf(envA)
			const b = yield* projectOf(envB)
			yield* writeProject(a.dir, a.env.config, 1)
			yield* writeProject(b.dir, b.env.config, 1)
			const keyA = yield* binIn(checkout, a, "draft-key", [], [], {})
			const keyB = yield* binIn(checkout, b, "draft-key", [], [], {})
			assert.equal(keyB.stdout, keyA.stdout, "twin projects' keys")
			assert.ok(
				regex("^[0-9a-f]+\n$").test(keyA.stdout) && keyA.stdout.length === 2 * sha256Octets + 1,
				`a key on one line: ${keyA.stdout}`
			)
			const file = `${a.workspace}/.trace.json`
			yield* binIn(checkout, a, "generate", [], [`${checkout}/test/support/read-trace-probe.ts`], {
				[traceVariable]: file
			})
			const trace = yield* traceAt(file)
			assert.deepEqual(outsideRoster(trace, a, checkout), [], "what generate read")
		})
	)

/** What a case changes of a project's inputs: one roster member, or something no member names. */
export type Change =
	| DraftInput
	| "a hidden entry"
	| "a file beside the configuration"
	| "a file beside grizzle's sources"

/** The changes that leave the inputs as they were, which no member names. */
const noOps = [
	"a hidden entry",
	"a file beside the configuration",
	"a file beside grizzle's sources"
] as const

export const changes: Arr.NonEmptyReadonlyArray<Change> = [...draftInputOrder, ...noOps]

/** One change: what it changes, the text it writes, and which of a member's files it writes it into. */
export interface Changed {
	readonly change: Change
	readonly text: string
	readonly which: number
}

/** A change's text: a line a file gains, drawn. */
const lineGen: Gen<string> = map(int(0, 9999), (n) => `// changed ${n}\n`)

const changedGen: Gen<Changed> = (source) => ({
	change: source.draw(element(changes)),
	text: source.draw(lineGen),
	which: source.draw(int(0, 3))
})

/** A change of any kind, or, for a witness while a kind is pending, one of that kind. */
export const changedSpace = aimed(
	changedGen,
	Arr.map(changes, (change) => [change, map(changedGen, (d) => ({ ...d, change }))] as const)
)

/**
 * A copy of a project's whole tree under `base`: the project, its configuration file, schema module, lockfile and
 * committed migrations directory, and a checkout of grizzle's packages, each a package.json and a source file.
 */
const treeAt = (base: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const project = `${base}/project`
		const grizzle = `${base}/grizzle`
		yield* fs.makeDirectory(`${project}/${schemaDir}/19700101000000_init`, { recursive: true })
		yield* writeProject(project, "grizzle.config.ts", 1)
		yield* fs.writeFileString(`${project}/${lockfileName}`, "lockfileVersion: '9.0'\n")
		yield* fs.writeFileString(`${project}/${schemaDir}/snapshot.json`, "{}\n")
		yield* fs.writeFileString(`${project}/${schemaDir}/19700101000000_init/meta.json`, "{}\n")
		for (const p of grizzlePackages) {
			yield* fs.makeDirectory(`${grizzle}/packages/${p}/src`, { recursive: true })
			yield* fs.writeFileString(`${grizzle}/packages/${p}/package.json`, `{ "name": "${p}" }\n`)
			yield* fs.writeFileString(`${grizzle}/packages/${p}/src/index.ts`, `export const ${p} = 1\n`)
		}
		const context: DraftContext = {
			request: {
				mode: { kind: "draft", naming: { kind: "derived" } },
				schema: Option.none(),
				declared: noDeclarations
			},
			config: `${project}/grizzle.config.ts`,
			closure: [`${project}/grizzle.config.ts`, `${project}/${schemaModule}`],
			migrations: `${project}/migrations`,
			grizzle,
			node: "v26.13.1"
		}
		return context
	})

/** `context`'s tree with `d` made: the file of its member it names written, or the context itself changed. */
const changedTree = (context: DraftContext, d: Changed) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const project = Str.slice(0, -"/grizzle.config.ts".length)(context.config)
		const append = (file: string) =>
			Effect.flatMap(fs.readFileString(file), (was) => fs.writeFileString(file, `${was}${d.text}`))
		switch (d.change) {
			case "flags":
				return {
					...context,
					request: {
						...context.request,
						mode: {
							kind: "draft",
							naming: { kind: "named", name: defined(parseMigrationName(`v${d.which}`), "a name") }
						}
					}
				} satisfies DraftContext
			case "configuration":
				yield* append(
					defined(context.closure[d.which % context.closure.length], "a closure module")
				)
				return context
			case "lockfile":
				yield* append(`${project}/${lockfileName}`)
				return context
			case "migrations":
				yield* d.which % 2 === 0
					? append(`${project}/${schemaDir}/snapshot.json`)
					: fs.writeFileString(`${project}/${schemaDir}/19700101000000_init/01-setup.sql`, d.text)
				return context
			case "grizzle": {
				const p = defined(grizzlePackages[d.which % grizzlePackages.length], "a package")
				yield* append(`${context.grizzle}/packages/${p}/src/index.ts`)
				return context
			}
			case "node":
				return { ...context, node: `v26.13.${d.which + 2}` } satisfies DraftContext
			case "a hidden entry":
				yield* fs.makeDirectory(`${project}/${schemaDir}/.stash`)
				yield* fs.writeFileString(`${project}/${schemaDir}/.stash/notes`, d.text)
				return context
			case "a file beside the configuration":
				yield* fs.writeFileString(`${project}/README.md`, d.text)
				return context
			case "a file beside grizzle's sources":
				yield* fs.writeFileString(`${context.grizzle}/packages/engine/README.md`, d.text)
				return context
		}
	})

/** Whether a change changes an input: a roster member's, where no no-op's does. */
const changesAnInput = (change: Change): change is DraftInput =>
	Arr.contains(draftInputOrder, change)

/**
 * One project's inputs keyed three times, each tree at a path of its own: as made, its twin at another path, which keys
 * alike, and a copy with one change made, which keys apart exactly when the change is a roster member's.
 */
export const keyedApart = (d: Changed, c: Case<Change>) =>
	Effect.scoped(
		Effect.gen(function* () {
			c.note(d.change)
			const originalAt = yield* workspace("draftkey")
			const twinAt = yield* workspace("draftkey")
			const copyAt = yield* workspace("draftkey")
			const original = yield* treeAt(originalAt)
			const twin = yield* treeAt(twinAt)
			const copy = yield* treeAt(copyAt)
			const key = yield* draftKey(original)
			const twinKey = yield* draftKey(twin)
			assert.equal(twinKey, key, "a twin tree at another path keys alike")
			const changed = yield* changedTree(copy, d)
			const after = yield* draftKey(changed)
			if (changesAnInput(d.change)) {
				assert.notEqual(after, key, `${d.change} changed, the key stays`)
			} else {
				assert.equal(after, key, `${d.change}: the key moved`)
			}
		})
	)

/** CONTRIBUTING.md's section on a draft's inputs: from its bullet on them up to the bullet after it. */
export const documentedSection = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const contributing = yield* fs.readFileString(`${repoRoot}CONTRIBUTING.md`)
	const start = defined(
		Option.getOrUndefined(Str.indexOf("- **A draft is a function of its inputs")(contributing)),
		"CONTRIBUTING.md's section on a draft's inputs"
	)
	const rest = Str.slice(start + 1)(contributing)
	const end = Option.getOrElse(Str.indexOf("\n- **")(rest), () => rest.length)
	return Str.slice(0, end + 1)(Str.slice(start)(contributing))
})

/** A text with every run of whitespace one space: CONTRIBUTING.md wraps a member's text across its lines. */
export const unwrapped = (text: string): string =>
	Str.trim(Str.replace(regex("\\s+", "g"), " ")(text))

/**
 * The numbered items of a section of a document, in order: each item's text, from its number to the next item or the line
 * that ends the list, unwrapped (unwrapped) and without the `;` or `.` that ends it.
 */
export const numberedItems = (section: string): ReadonlyArray<string> => {
	const items: Array<Array<string>> = []
	for (const line of Str.split(section, "\n")) {
		const opened = regex("^\\s+\\d+\\. (.*)$").exec(line)
		const last = items.at(-1)
		if (opened !== null) {
			items.push([opened[1]])
		} else if (last !== undefined && regex("^\\s{5}\\S").test(line)) {
			last.push(line)
		} else if (last !== undefined) {
			break
		}
	}
	return Arr.map(items, (lines) => Str.replace(regex("[;.]$"), "")(unwrapped(Arr.join(lines, " "))))
}
