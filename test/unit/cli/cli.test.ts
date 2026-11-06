import { inspect } from "node:util"
import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { assertNone } from "@effect/vitest/utils"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
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
	pipe,
	String as Str
} from "effect"
import { readMeta } from "#adapter/boundary/meta.ts"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { type CommandLine, type GenerateMode, parseArgs } from "#cli/args.ts"
import { formatTimestamp, nextTimestamp, parseTimestamp } from "#cli/clock.ts"
import type { ArgumentsRefused, MigrationNameRefused } from "#cli/errors.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import {
	type FolderNaming,
	fileNameMaxBytes,
	isFolderName,
	type MigrationName,
	maxMigrationNameLength,
	metaFileName
} from "#compiler/deploy/render/folder.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { closedId, uuid } from "#compiler/public/fields.ts"
import { closed, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { defineConfig } from "#index.ts"
import { ledger, shop } from "#test/pg/cli/fixture.ts"
import {
	bin,
	cli,
	cliClock,
	cliOver,
	configName,
	offlineOwner,
	offlinePassword,
	resolvedConfig,
	unconnected,
	workspace,
	writeConfig,
	writeConfigText
} from "#test/pg/cli/support.ts"
import {
	assert,
	contains,
	containsText,
	defined,
	lacksText,
	refusedAt,
	succeeded
} from "#test/support/assert.ts"
import { compileTestWorkload, firstCodes, testCompile } from "#test/support/compile.ts"
import { repoRoot } from "#test/support/files.ts"
import { atDeclaredName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	compile,
	fromEmpty,
	generate,
	noDeclarations,
	parsedMigrationName,
	unowned
} from "#test/support/migrate/kit.ts"
import { validationFile } from "#test/support/migrate/review.ts"
import { owning } from "#test/support/policy.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * The `grizzle` command line without a database: argument parsing, folder timestamps, the lean configuration file, and
 * `generate` writing the migrations directory.
 *
 * - The grammar, generated: every line of it (the commands generate, check, migrate, drift and names, each over the
 *   configuration file its one argument names, and generate's flags --name, a folder's name, --custom, which needs
 *   --name, and --schema, in any order and as `--flag value` or `--flag=value`) is read as exactly what it says; one
 *   fault injected into a line, a --name of no folder name's shape among them, is a usage error naming that fault;
 *   --help or -h anywhere prints the usage.
 * - Folder names are `<YYYYMMDDHHMMSS>_<name>` in UTC and always sort after the schema's existing folders.
 * - The configuration is always defineConfig({ schemas, logins, migrations, connection }), every setting required; a
 *   plain object is refused with the fix, and anything malformed before any command runs: among them a login over a
 *   schema it does not list and a login named as a role of its schema. Its connection is checked only by migrate and
 *   drift; connection.test.ts generates its refusals.
 * - generate writes exactly what the pure generator drafts, byte for byte, in `migrations/<schema>/`, named by --name
 *   or after its change; a schema that did not change drafts nothing and prints `no changes`; a folder drafted in the
 *   same second sorts after the last; --custom writes an empty folder of the committed snapshot.
 * - A draft continues the committed chain, and nothing is written for any schema when one schema fails; every
 *   tampering with the committed directory is generated in tamper.test.ts. Hidden entries are ignored.
 */
const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
	DateTime.makeUnsafe({
		year: y,
		month: mo,
		day: d,
		hour: h,
		minute: mi,
		second: s,
		millisecond: 0
	})

/** The entries of `dir` in name order, none when it does not exist. */
const ls = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return (yield* fs.exists(dir))
			? yield* Effect.map(fs.readDirectory(dir), (entries) => Arr.sort(entries, Order.String))
			: []
	})

/** The text of the file at `path`. */
const read = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(path)
	})

/** Writes `text` to the file at `path`. */
const write = (path: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(path, text)
	})

/** The path of `parts` joined by slashes. */
const join = (...parts: Array<string>): string => Arr.join(parts, "/")

/** The installation identifier of the shop fixture's schema declared `name`, as the naming door spells it. */
const shopIdent = (name: string): string =>
	owning(shop(name, 1, "none").schema).installation.identifier

/** The migrations directory of the shop fixture's schema declared `name`, below a workspace. */
const shopDirectory = (name: string): string => join("migrations", shopIdent(name))

/** The commands that take no flag. */
type PlainCommand = "check" | "migrate" | "drift" | "names"

/** What generate makes, as the grammar spells it: a draft, named or not, or a custom folder, always named. */
type GrammarMode =
	| { readonly kind: "draft"; readonly name: Option.Option<MigrationName> }
	| { readonly kind: "custom"; readonly name: MigrationName }

/** A command line of the grammar: a plain command, or generate with its mode and schema, over a configuration file. */
type GrammarLine =
	| { readonly command: PlainCommand; readonly config: string }
	| {
			readonly command: "generate"
			readonly config: string
			readonly mode: GrammarMode
			readonly schema: Option.Option<string>
	  }

/** One argument of a line, or one flag with its value: what a shuffle moves whole and a fault is injected between. */
interface Unit {
	readonly role: "config" | "custom" | "name" | "schema"
	readonly tokens: ReadonlyArray<string>
}

/** A line, and its units in the order drawn after the command. */
interface Spelled {
	readonly line: GrammarLine
	readonly units: ReadonlyArray<Unit>
}

const plainCommands = ["check", "migrate", "drift", "names"] as const

/** The parts of a drawn path: relative or absolute, with spaces, `=` and letters outside ASCII. */
const configParts = [
	"grizzle.config.ts",
	"db/",
	"./",
	"/srv/",
	"app",
	"a b",
	"é",
	"x=y",
	"config.mts"
] as const

/** A path, never starting with `-`. */
const configGen: Gen<string> = map(array(element(configParts), { min: 1, max: 3 }), (parts) =>
	Arr.join(parts, "")
)

/**
 * The parts of a drawn flag value: a --schema, which the parser hands on as given for generate to check against the
 * configuration, or the value of a flag a fault adds, whose line the parser refuses before checking any name.
 */
const valueParts = ["init", "add", "_", "note", "2", "Add Tier", "a=b", "é"] as const

/** A flag's value, never starting with `-`. */
const valueGen: Gen<string> = map(array(element(valueParts), { min: 1, max: 3 }), (parts) =>
	Arr.join(parts, "")
)

/** The longest migration name, at the file name limit once its timestamp prefixes it. */
const longestName = Arr.join(
	Arr.makeBy(maxMigrationNameLength.value, () => "a"),
	""
)

/** The words of a drawn migration name, each of a folder name's shape. */
const nameWords = ["init", "add_tier", "note-2", "v2"] as const

/** A --name the parser admits, of a folder name's shape: words joined by `_`, or the longest name. */
const nameGen: Gen<MigrationName> = map(
	weighted([
		[8, map(array(element(nameWords), { min: 1, max: 3 }), (words) => Arr.join(words, "_"))],
		[1, constant(longestName)]
	]),
	parsedMigrationName
)

/**
 * Names of no folder name's shape, none starting with `-`: outside lowercase ASCII, a separator at an end or doubled,
 * or one byte past the longest.
 */
const malformedNames = [
	"Add Tier",
	"é",
	"a=b",
	"_init",
	"init_",
	"add__tier",
	"a.b",
	`${longestName}a`
] as const

const lineGen: Gen<GrammarLine> = oneOf<GrammarLine>([
	(source) => ({ command: source.draw(element(plainCommands)), config: source.draw(configGen) }),
	(source) => ({
		command: "generate",
		config: source.draw(configGen),
		mode: source.draw(
			oneOf<GrammarMode>([
				map(option(nameGen), (name) => ({ kind: "draft", name })),
				map(nameGen, (name) => ({ kind: "custom", name }))
			])
		),
		schema: source.draw(option(valueGen))
	})
])

/** A valued flag's unit, spelled `--flag value` or `--flag=value`. */
const valuedGen =
	(role: "name" | "schema", value: string): Gen<Unit> =>
	(source) => ({
		role,
		tokens: source.draw(boolean) ? [`--${role}=${value}`] : [`--${role}`, value]
	})

/** The unit of a valued flag a line gives, none when it gives none. */
const flagOf =
	(role: "name" | "schema", value: Option.Option<string>): Gen<ReadonlyArray<Unit>> =>
	(source) =>
		Option.match(value, {
			onNone: () => [],
			onSome: (given) => [source.draw(valuedGen(role, given))]
		})

/** The units of a line, each flag spelled either way. */
const unitsOf =
	(line: GrammarLine): Gen<ReadonlyArray<Unit>> =>
	(source) => {
		const config: Unit = { role: "config", tokens: [line.config] }
		if (line.command !== "generate") {
			return [config]
		}
		const custom: ReadonlyArray<Unit> =
			line.mode.kind === "custom" ? [{ role: "custom", tokens: ["--custom"] }] : []
		const name = line.mode.kind === "custom" ? Option.some(line.mode.name) : line.mode.name
		return [
			config,
			...custom,
			...source.draw(flagOf("name", name)),
			...source.draw(flagOf("schema", line.schema))
		]
	}

const spelledGen: Gen<Spelled> = (source) => {
	const line = source.draw(lineGen)
	const units = source.draw(unitsOf(line))
	return { line, units: source.draw(shuffled(units, { min: units.length, max: units.length })) }
}

const argvOf = (command: string, units: ReadonlyArray<Unit>): ReadonlyArray<string> => [
	command,
	...Arr.flatMap(units, (u) => u.tokens)
]

/** What the parser must read a line of the grammar as. */
const meaningOf = (line: GrammarLine): CommandLine => {
	if (line.command !== "generate") {
		return { kind: "run", config: line.config, command: { kind: line.command } }
	}
	const mode: GenerateMode =
		line.mode.kind === "custom"
			? { kind: "custom", name: line.mode.name }
			: {
					kind: "draft",
					naming: Option.match(line.mode.name, {
						onNone: (): FolderNaming => ({ kind: "derived" }),
						onSome: (name): FolderNaming => ({ kind: "named", name })
					})
				}
	return {
		kind: "run",
		config: line.config,
		command: { kind: "generate", mode, schema: line.schema, declared: noDeclarations }
	}
}

/** What an accepted line reaches. */
type GrammarFeature =
	| PlainCommand
	| "a draft named after its change"
	| "a draft named by --name"
	| "a custom migration"
	| "--schema"
	| "a flag spelled --flag=value"
	| "a flag spelled --flag value"
	| "the configuration file after a flag"

const grammarFeatures = [
	...plainCommands,
	"a draft named after its change",
	"a draft named by --name",
	"a custom migration",
	"--schema",
	"a flag spelled --flag=value",
	"a flag spelled --flag value",
	"the configuration file after a flag"
] as const satisfies ReadonlyArray<GrammarFeature>

const grammarNotes = (s: Spelled): ReadonlyArray<GrammarFeature> => {
	const line = s.line
	const flags = Arr.filter(s.units, (u) => u.role === "name" || u.role === "schema")
	return Arr.flatMap(
		[
			...Arr.map(plainCommands, (c) => [c, line.command === c] as const),
			[
				"a draft named after its change",
				line.command === "generate" && line.mode.kind === "draft" && Option.isNone(line.mode.name)
			],
			[
				"a draft named by --name",
				line.command === "generate" && line.mode.kind === "draft" && Option.isSome(line.mode.name)
			],
			["a custom migration", line.command === "generate" && line.mode.kind === "custom"],
			["--schema", line.command === "generate" && Option.isSome(line.schema)],
			["a flag spelled --flag=value", Arr.some(flags, (u) => u.tokens.length === 1)],
			["a flag spelled --flag value", Arr.some(flags, (u) => u.tokens.length === 2)],
			["the configuration file after a flag", s.units[0]?.role !== "config"]
		] satisfies ReadonlyArray<readonly [GrammarFeature, boolean]>,
		([feature, holds]) => (holds ? [feature] : [])
	)
}

/** How a command line fails to parse: as ArgumentsRefused says, or by a --name of no folder name's shape. */
type FaultKind = ArgumentsRefused["fault"]["kind"] | MigrationNameRefused["_tag"]

const faultKinds = [
	"unknownCommand",
	"noConfig",
	"unexpectedArgument",
	"unknownOption",
	"repeatedFlag",
	"flagWithoutValue",
	"unnamedCustom",
	"MigrationNameRefused"
] as const satisfies ReadonlyArray<FaultKind>

/** One fault injected into a line of the grammar: the command line it makes, and how the parser must refuse it. */
interface Fault {
	readonly argv: ReadonlyArray<string>
	readonly kind: FaultKind
}

/** `unit` inserted among `units` at a drawn boundary, never inside one. */
const insertedGen =
	(units: ReadonlyArray<Unit>, unit: Unit): Gen<ReadonlyArray<Unit>> =>
	(source) => {
		const at = source.draw(int(0, units.length))
		return [...units.slice(0, at), unit, ...units.slice(at)]
	}

/** Options no command takes. */
const unknownOptions = [
	"--force",
	"-x",
	"-",
	"--names",
	"--custom=yes",
	"--Name",
	"--config",
	"---name"
] as const

const faultsOf = (s: Spelled): Gen<Fault> => {
	const { line, units } = s
	const command = line.command
	const fault =
		(kind: FaultKind) =>
		(edited: ReadonlyArray<Unit>): Fault => ({ argv: argvOf(command, edited), kind })
	const without = (role: Unit["role"]): ReadonlyArray<Unit> =>
		Arr.filter(units, (u) => u.role !== role)
	const common: Arr.NonEmptyReadonlyArray<Gen<Fault>> = [
		map(element(["skill", "push", "Generate", "init", "--version", ""]), (word): Fault => ({
			argv: argvOf(word, units),
			kind: "unknownCommand"
		})),
		constant(fault("noConfig")(without("config"))),
		map(insertedGen(without("config"), { role: "config", tokens: [""] }), fault("noConfig")),
		(source) => {
			const second: Unit = { role: "config", tokens: [source.draw(configGen)] }
			return fault("unexpectedArgument")(source.draw(insertedGen(units, second)))
		},
		(source) => {
			const unknown: Unit = { role: "custom", tokens: [source.draw(element(unknownOptions))] }
			return fault("unknownOption")(source.draw(insertedGen(units, unknown)))
		}
	]
	if (command !== "generate") {
		return oneOf<Fault>([
			...common,
			(source) => {
				const flag = source.draw(
					oneOf<Unit>([
						constant({ role: "custom", tokens: ["--custom"] }),
						(inner) => inner.draw(valuedGen("name", inner.draw(valueGen))),
						(inner) => inner.draw(valuedGen("schema", inner.draw(valueGen)))
					])
				)
				return fault("unknownOption")(source.draw(insertedGen(units, flag)))
			}
		])
	}
	const flagUnit = (role: "custom" | "name" | "schema"): Gen<Unit> =>
		role === "custom"
			? constant({ role, tokens: ["--custom"] })
			: (source) => source.draw(valuedGen(role, source.draw(valueGen)))
	return oneOf<Fault>([
		...common,
		(source) => {
			const role = source.draw(element(["custom", "name", "schema"] as const))
			const present = Arr.some(units, (u) => u.role === role)
			const once = source.draw(insertedGen(units, source.draw(flagUnit(role))))
			return fault("repeatedFlag")(
				present ? once : source.draw(insertedGen(once, source.draw(flagUnit(role))))
			)
		},
		(source) => {
			const role = source.draw(element(["name", "schema"] as const))
			const rest = without(role)
			const spelled = source.draw(element(["empty", "last", "a flag after it"] as const))
			switch (spelled) {
				case "empty":
					return fault("flagWithoutValue")(
						source.draw(insertedGen(rest, { role, tokens: [`--${role}=`] }))
					)
				case "last":
					return fault("flagWithoutValue")([...rest, { role, tokens: [`--${role}`] }])
				case "a flag after it":
					return fault("flagWithoutValue")(
						source.draw(
							insertedGen(rest, {
								role,
								tokens: [`--${role}`, source.draw(element(["-x", "--custom", "--schema=s"]))]
							})
						)
					)
			}
		},
		(source) => {
			const unnamed = without("name")
			return fault("unnamedCustom")(
				Arr.some(unnamed, (u) => u.role === "custom")
					? unnamed
					: source.draw(insertedGen(unnamed, { role: "custom", tokens: ["--custom"] }))
			)
		},
		(source) => {
			const misnamed = source.draw(valuedGen("name", source.draw(element(malformedNames))))
			return fault("MigrationNameRefused")(source.draw(insertedGen(without("name"), misnamed)))
		}
	])
}

describe("the command line, generated", () => {
	it.effect(
		"reads every line of the grammar as exactly what it says, its flags in any order and either spelling",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/grammar",
						draw: drawn(spelledGen),
						literal: Formatter.format,
						coverage: required<GrammarFeature>(grammarFeatures, { cases: 200, sense: notesOnly }),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.noteAll(grammarNotes(s))
							const argv = argvOf(s.line.command, s.units)
							assert.deepEqual(succeeded(parseArgs(argv), Arr.join(argv, " ")), meaningOf(s.line))
						})
				)
			)
	)

	it.effect(
		"refuses one fault injected into a line of the grammar as a usage error naming that fault",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/grammar-faults",
						draw: drawn((source): Fault => source.draw(faultsOf(source.draw(spelledGen)))),
						literal: Formatter.format,
						coverage: required<FaultKind>(faultKinds, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(f, c) =>
						Effect.sync(() => {
							c.note(f.kind)
							const literal = Formatter.format(f.argv)
							const refusal = refusedAt(parseArgs(f.argv), "stage", "usage", literal)
							const reason = refusal.reason
							assert.ok(
								f.kind === "MigrationNameRefused"
									? reason._tag === f.kind
									: reason._tag === "ArgumentsRefused" && reason.fault.kind === f.kind,
								`${literal} is refused for ${f.kind}, not: ${refusal.message}`
							)
						})
				)
			)
	)

	it.effect("prints the usage for --help or -h anywhere, and for no argument at all", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/cli/grammar-help",
					draw: drawn((source): ReadonlyArray<string> => {
						const argv = source.draw(
							oneOf<ReadonlyArray<string>>([
								map(spelledGen, (s) => argvOf(s.line.command, s.units)),
								(inner) => inner.draw(faultsOf(inner.draw(spelledGen))).argv
							])
						)
						const at = source.draw(int(0, argv.length))
						return [...argv.slice(0, at), source.draw(element(["--help", "-h"])), ...argv.slice(at)]
					}),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(argv) =>
					Effect.sync(() => {
						assert.deepEqual(succeeded(parseArgs(argv), Arr.join(argv, " ")), { kind: "help" })
						assert.deepEqual(succeeded(parseArgs([])), { kind: "help" })
					})
			)
		)
	)
})

describe("folder timestamps", () => {
	it("are the UTC second as fourteen digits", () => {
		assert.equal(formatTimestamp(at(2026, 10, 12, 9, 5, 7)), "20261012090507")
		assert.deepEqual(
			Option.map(parseTimestamp("20261012090507"), DateTime.toEpochMillis),
			Option.some(DateTime.toEpochMillis(at(2026, 10, 12, 9, 5, 7)))
		)
		assertNone(parseTimestamp("20261332090507"))
		assertNone(parseTimestamp("2026101209050"))
	})

	it("sort after every existing folder of the schema, whatever the clock says", () => {
		const now = at(2026, 10, 12, 9, 5, 7)
		assert.equal(nextTimestamp(now, []), "20261012090507")
		assert.equal(nextTimestamp(now, ["20261012090506"]), "20261012090507")
		assert.equal(nextTimestamp(now, ["20261012090507"]), "20261012090508")
		assert.equal(nextTimestamp(now, ["20250101000000", "20261231235959"]), "20270101000000")
		assert.equal(nextTimestamp(now, ["20269999999999"]), "20270000000000")
	})
})

layer(NodeServices.layer, { excludeTestServices: true })(
	"the configuration file, the lean config",
	(it) => {
		const s = shop("CfgShop", 1, "full")
		const other = shop("CfgOther", 1, "none")
		const file = `${repoRoot}app/grizzle.config.ts`

		it.effect(
			"resolves schemas, their logins' workloads and the migrations directory, and keeps the connection unread",
			() =>
				Effect.gen(function* () {
					const config = yield* resolvedConfig(
						defineConfig({
							schemas: [s.schema, other.schema],
							logins: [s.server, other.server],
							migrations: "db",
							connection: offlineOwner
						}),
						file
					)
					const c = succeeded(config)
					assert.equal(c.migrations, `${repoRoot}app/db`)
					const o = owning(s.schema)
					const p = owning(other.schema)
					assert.deepEqual(
						Arr.map(c.schemas, (x) => [
							x.declared,
							x.ident,
							x.directory,
							Arr.some(x.logins, (l) => l.login.workload.length > 0)
						]),
						[
							[
								o.name,
								identifierOf(o.installation),
								`${repoRoot}app/db/${identifierOf(o.installation)}`,
								true
							],
							[
								p.name,
								identifierOf(p.installation),
								`${repoRoot}app/db/${identifierOf(p.installation)}`,
								false
							]
						]
					)
					assert.ok(c.connection === offlineOwner, "the connection kept as given")
					const absolute = yield* resolvedConfig(
						defineConfig({
							schemas: [s.schema],
							logins: [],
							migrations: `${repoRoot}elsewhere/db`,
							connection: offlineOwner
						}),
						file
					)
					assert.equal(succeeded(absolute).migrations, `${repoRoot}elsewhere/db`)
					/** A connection is kept as given: only migrate and drift check it, so generate and check run with a broken one. */
					const broken = {
						...offlineOwner,
						transport: { ...offlineOwner.transport, port: 70000 }
					}
					const resolvedBroken = yield* resolvedConfig(
						defineConfig({
							schemas: [s.schema],
							logins: [],
							migrations: "db",
							connection: broken
						}),
						file
					)
					assert.ok(
						succeeded(resolvedBroken).connection === broken,
						"the broken connection kept as given"
					)
				})
		)

		it.effect(
			"refuses a plain object with the fix, a setting missing, and anything that is not a configuration, never naming a credential",
			(ctx) =>
				Effect.gen(function* () {
					const config = yield* resolvedConfig(
						{ schemas: [s.schema], logins: [], migrations: "db", connection: offlineOwner },
						file
					)
					refusedAt(config, "stage", "config")
					/** Refused at the configuration, no credential in its message or anywhere in the error. */
					const named = (value: unknown) =>
						Effect.map(resolvedConfig(value, file), (r) => {
							const refusal = refusedAt(r, "stage", "config")
							lacksText(`${refusal.message}\n${inspect(refusal, { depth: 12 })}`, offlinePassword)
						})
					const configured = (value: Parameters<typeof defineConfig>[0]) =>
						named(defineConfig(value))
					const requiredSettings = { migrations: "db", connection: offlineOwner } as const
					yield* named(undefined)
					/** A key the type does not know, given through a variable, as JavaScript would. */
					const extra = {
						schemas: [s.schema] as const,
						logins: [],
						...requiredSettings,
						poolSize: 4
					}
					yield* named(defineConfig(extra))
					/** The required settings left out, each alone, as JavaScript would: defineConfig typed the value whole. */
					const leftOut = ["migrations", "connection"] as const satisfies ReadonlyArray<
						keyof Parameters<typeof defineConfig>[0]
					>
					yield* searched(
						ctx,
						exhaust(
							{
								suite: "unit/cli/config-setting-left-out",
								generator: element(leftOut),
								literal: Formatter.format,
								limit: leftOut.length,
								coverage: noCoverage,
								caseHang
							},
							(setting) => {
								const lacking = defineConfig({
									schemas: [s.schema],
									logins: [],
									...requiredSettings
								})
								Reflect.deleteProperty(lacking, setting)
								return named(lacking)
							}
						)
					)
					yield* configured({
						schemas: [s.schema],
						logins: [],
						...requiredSettings,
						migrations: ""
					})
					yield* configured({
						schemas: [s.schema, shop("CfgShop", 2, "full").schema],
						logins: [],
						...requiredSettings
					})
					yield* configured({ schemas: [s.schema], logins: [other.server], ...requiredSettings })
					/** A login named alike to a role of its schema: logins and roles of one schema have names that convert apart. */
					const clashing = login(s.schema, "Reader", [
						role(s.schema, "auditor", s.schema.relations)
					])
					yield* configured({
						schemas: [s.schema],
						logins: [s.server, clashing],
						...requiredSettings
					})
				})
		)
	}
)

/**
 * The installation and draft the pure compiler gives for a schema and its login's workload, as generate composes them:
 * the shop's, or the ledger's, whose residual law and derived relation only the two installer extensions install. Its
 * login is the fixture's, as the configuration names it (test/pg/cli/support.ts configOf), which owns the workload.
 */
const directDraft = (name: string, timestamp: string, fixture: "shop" | "ledger") => {
	const built = fixture === "ledger" ? ledger(name) : shop(name, 1, "full")
	const value = built.schema
	const server = built.server
	const plan = succeeded(
		compileTestWorkload([{ login: server.name, workloads: server.workload }], value, testCompile)
	)
	const owned = owning(value)
	const logins = [succeeded(ownLogin(defined(loginDescOf(server), "a login value")))]
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				owned.installation,
				logins,
				[workloadExtension(plan)],
				firstCodebook(rostersOf(owned))
			)
		)
	)
	assert.deepEqual(installation.deferred, { derivedRelations: [] })
	return succeeded(
		generate({
			installation,
			name: "init",
			timestamp,
			workload: { access: plan.access, accessPaths: plan.requests },
			previous: fromEmpty,
			declared: noDeclarations
		})
	)
}

/** A schema whose closed relation carries a refined text payload: a slug. */
const tierSchema = (name: string) => {
	const Slug = str.regex("^[a-z][a-z0-9-]*$")
	const Tier = closed("Tier", ["Free", "Pro"])
	const TierLabel = closed.relation(
		"TierLabel",
		{ tier: closedId(Tier), label: Slug },
		["tier"],
		[
			{ tier: "Free", label: "free" },
			{ tier: "Pro", label: "pro-plan" }
		]
	)
	const Article = relation("Article", { id: uuid, slug: Slug }, ["id"])
	return schema(name, { Tier, TierLabel, Article }, [])
}

layer(NodeServices.layer, { excludeTestServices: true })("grizzle generate", (it) => {
	it.effect(
		"writes exactly the generator's draft into migrations/<schema>/, then nothing when nothing changed",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("gen")
				yield* writeConfig(ws, {
					schemas: [{ name: "GenShop", fixture: "shop", version: 1, workload: "full" }],
					connection: unconnected
				})
				const now = at(2026, 10, 12, 12, 0, 0)
				const first = yield* cli(ws, ["generate", configName, "--name", "init"], now)
				assert.equal(first.code, 0, first.stderr)
				const expected = directDraft("GenShop", formatTimestamp(now), "shop")
				const schemaDirectory = join(
					"migrations",
					owning(shop("GenShop", 1, "full").schema).installation.identifier
				)
				const dir = join(ws, schemaDirectory)
				const dirEntries = yield* ls(dir)
				assert.deepEqual(
					dirEntries,
					Arr.sort([expected.folder.name, snapshotFileName], Order.String)
				)
				const folder = join(dir, expected.folder.name)
				const folderEntries = yield* ls(folder)
				assert.deepEqual(
					folderEntries,
					Arr.sort([metaFileName, ...Arr.map(expected.folder.files, (f) => f.name)], Order.String)
				)
				const metaText = yield* read(join(folder, metaFileName))
				assert.equal(metaText, expected.folder.metaText)
				for (const f of expected.folder.files) {
					const fileText = yield* read(join(folder, f.name))
					assert.equal(fileText, f.text)
				}
				const snapshotText = yield* read(join(dir, snapshotFileName))
				assert.equal(snapshotText, expected.snapshotText)

				const again = yield* cli(ws, ["generate", configName], now)
				assert.equal(again.code, 0, again.stderr)
				const dirEntriesAfter = yield* ls(dir)
				assert.deepEqual(
					dirEntriesAfter,
					Arr.sort([expected.folder.name, snapshotFileName], Order.String)
				)
				const snapshotTextAfter = yield* read(join(dir, snapshotFileName))
				assert.equal(snapshotTextAfter, expected.snapshotText)
			})
	)

	it.effect("names a folder after its change when no --name is given", () =>
		Effect.gen(function* () {
			const ws = yield* workspace("names")
			const times = [
				at(2026, 10, 12, 12, 0, 0),
				at(2026, 10, 12, 12, 0, 1),
				at(2026, 10, 12, 12, 0, 2),
				at(2026, 10, 12, 12, 0, 3)
			] as const
			const [t0, t1, t2, t3] = times
			yield* writeConfig(ws, {
				schemas: [{ name: "NameShop", fixture: "shop", version: 1, workload: "full" }],
				connection: unconnected
			})
			const first = yield* cli(ws, ["generate", configName], t0)
			assert.equal(first.code, 0)
			yield* writeConfig(ws, {
				schemas: [{ name: "NameShop", fixture: "shop", version: 1, workload: "withoutByName" }],
				connection: unconnected
			})
			const rewired = yield* cli(ws, ["generate", configName], t1)
			assert.equal(rewired.code, 0)
			yield* writeConfig(ws, {
				schemas: [{ name: "NameShop", fixture: "shop", version: 2, workload: "withoutByName" }],
				connection: unconnected
			})
			const widened = yield* cli(ws, ["generate", configName], t2)
			assert.equal(widened.code, 0)
			const custom = yield* cli(ws, ["generate", configName, "--custom", "--name", "backfill"], t3)
			assert.equal(custom.code, 0)
			const entries = yield* ls(join(ws, shopDirectory("NameShop")))
			const folders = Arr.filter(entries, (n) => n !== snapshotFileName)
			assert.equal(folders.length, times.length)
			for (const [i, time] of times.entries()) {
				const name = folders[i]
				assert.ok(name !== undefined && isFolderName(name), Arr.join(folders, ", "))
				assert.ok(pipe(name, Str.startsWith(formatTimestamp(time))), name)
			}
		})
	)

	it.effect("drafts a schema's residual laws and derived relations", () =>
		Effect.gen(function* () {
			const ws = yield* workspace("ledger")
			yield* writeConfig(ws, {
				schemas: [{ name: "GenLedger", fixture: "ledger" }],
				connection: unconnected
			})
			const r = yield* cli(
				ws,
				["generate", configName, "--name", "init"],
				at(2026, 10, 12, 12, 0, 0)
			)
			assert.equal(r.code, 0, r.stderr)
			const expected = directDraft(
				"GenLedger",
				formatTimestamp(at(2026, 10, 12, 12, 0, 0)),
				"ledger"
			)
			const dir = join(ws, "migrations", expected.snapshot.schema)
			const folder = join(dir, expected.folder.name)
			const folderEntries = yield* ls(folder)
			assert.deepEqual(
				folderEntries,
				Arr.sort([metaFileName, ...Arr.map(expected.folder.files, (f) => f.name)], Order.String)
			)
			for (const f of expected.folder.files) {
				const fileText = yield* read(join(folder, f.name))
				assert.equal(fileText, f.text)
			}
			const snapshotText = yield* read(join(dir, snapshotFileName))
			assert.equal(snapshotText, expected.snapshotText)
			/** The derived relation's view is drafted with the rest. */
			const kinds = Arr.map(expected.snapshot.manifest.objects, (o) => o.kind)
			contains(kinds, "materializedView")
		})
	)

	it.effect(
		"drafts the validation of a closed payload's refinement in Publish, the snapshot the schema alone determines",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("closed")
				const r = yield* cliOver(
					ws,
					defineConfig({
						schemas: [tierSchema("GenTier")],
						logins: [],
						migrations: "migrations",
						connection: offlineOwner
					}),
					["generate", configName, "--name", "init"],
					at(2026, 10, 12, 12, 0, 0)
				)
				assert.equal(r.code, 0, r.stderr)
				const owned = owning(tierSchema("GenTier"))
				const dir = join(ws, "migrations", owned.installation.identifier)
				const folder = join(dir, "20261012120000_init")
				const expected = succeeded(
					generate({
						installation: succeeded(compileInstallation(owned, installOptions(owned, undefined))),
						name: "init",
						timestamp: "20261012120000",
						previous: fromEmpty,
						workload: noWorkload,
						declared: noDeclarations
					})
				)
				const folderEntries = yield* ls(folder)
				assert.deepEqual(
					folderEntries,
					Arr.sort([metaFileName, ...Arr.map(expected.folder.files, (f) => f.name)], Order.String)
				)
				for (const f of expected.folder.files) {
					const fileText = yield* read(join(folder, f.name))
					assert.equal(fileText, f.text)
				}
				assert.equal(
					validationFile(expected).phase,
					"publish",
					"the draft validates the payload's refinement in Publish"
				)
				const snapshotText = yield* read(join(dir, "snapshot.json"))
				const snapshot = succeeded(readSnapshot(snapshotText))
				/** The first migration's target from the empty snapshot, drafted from the schema alone. */
				const derived = succeeded(
					generate({
						installation: compile(tierSchema("GenTier"), {
							schema: atDeclaredName,
							owner: unowned,
							extensions: [],
							codes: firstCodes
						}),
						name: "admission",
						timestamp: "20000101000000",
						previous: fromEmpty,
						workload: noWorkload,
						declared: noDeclarations
					})
				)
				assert.equal(derived.snapshot.fingerprint, snapshot.fingerprint)
			})
	)

	it.effect(
		"reports each marker with what to do, and a folder in the same second sorts after the last",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("marker")
				yield* writeConfig(ws, {
					schemas: [{ name: "MarkShop", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const now = at(2026, 10, 12, 12, 0, 0)
				const first = yield* cli(ws, ["generate", configName, "--name", "init"], now)
				assert.equal(first.code, 0)
				yield* writeConfig(ws, {
					schemas: [{ name: "MarkShop", fixture: "shop", version: 2, workload: "none" }],
					connection: unconnected
				})
				const tier = yield* cli(ws, ["generate", configName, "--name", "tier"], now)
				assert.equal(tier.code, 0, tier.stderr)
				const dir = join(ws, shopDirectory("MarkShop"))
				const entries = yield* ls(dir)
				const folders = Arr.filter(entries, (n) => n !== snapshotFileName)
				const [init, second] = folders
				assert.equal(folders.length, 2)
				assert.ok(init !== undefined && second !== undefined, "two drafted folders")
				assert.ok(isFolderName(init) && isFolderName(second), Arr.join(folders, ", "))
				assert.ok(second > init, "the folder drafted in the same second sorts after the last")
				const snapshotText = yield* read(join(dir, snapshotFileName))
				const snapshot = succeeded(readSnapshot(snapshotText))
				const metaText = yield* read(join(dir, second, metaFileName))
				const meta = succeeded(readMeta(metaText))
				assert.equal(meta.target, snapshot.fingerprint)
				assert.equal(meta.kind, "drafted")
			})
	)

	it.effect(
		"--custom writes an empty folder of the committed snapshot and leaves snapshot.json alone",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("custom")
				yield* writeConfig(ws, {
					schemas: [{ name: "CustShop", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const first = yield* cli(ws, ["generate", configName], at(2026, 10, 12, 12, 0, 1))
				assert.equal(first.code, 0)
				const dir = join(ws, shopDirectory("CustShop"))
				const before = yield* read(join(dir, "snapshot.json"))
				const custom = yield* cli(
					ws,
					["generate", configName, "--custom", "--name", "backfill"],
					at(2026, 10, 12, 12, 0, 2)
				)
				assert.equal(custom.code, 0, custom.stderr)
				const backfillEntries = yield* ls(join(dir, "20261012120002_backfill"))
				assert.deepEqual(backfillEntries, [metaFileName])
				const metaText = yield* read(join(dir, "20261012120002_backfill/meta.json"))
				const meta = succeeded(readMeta(metaText))
				const snapshot = succeeded(readSnapshot(before))
				assert.deepEqual(
					[meta.source, meta.target, meta.kind],
					[snapshot.fingerprint, snapshot.fingerprint, "custom"]
				)
				const snapshotText = yield* read(join(dir, "snapshot.json"))
				assert.equal(snapshotText, before)
			})
	)

	it.effect(
		"drafts every configured schema; --schema chooses one when there are several, and --custom needs it there",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("two")
				yield* writeConfig(ws, {
					schemas: [
						{ name: "TwoA", fixture: "shop", version: 1, workload: "none" },
						{ name: "TwoB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: unconnected
				})
				const both = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(both.code, 0, both.stderr)
				const draftedA = yield* ls(join(ws, shopDirectory("TwoA")))
				assert.equal(draftedA.length, 2)
				const draftedB = yield* ls(join(ws, shopDirectory("TwoB")))
				assert.equal(draftedB.length, 2)

				const custom = yield* cli(
					ws,
					["generate", configName, "--custom", "--name", "data"],
					nextNow()
				)
				assert.equal(custom.code, 2)
				const unknown = yield* cli(ws, ["generate", configName, "--schema", "Nope"], nextNow())
				assert.equal(unknown.code, 2)
				const chosen = yield* cli(
					ws,
					["generate", configName, "--custom", "--schema", shopIdent("TwoB"), "--name", "data"],
					nextNow()
				)
				assert.equal(chosen.code, 0, chosen.stderr)
				const keptA = yield* ls(join(ws, shopDirectory("TwoA")))
				assert.equal(keptA.length, 2)
				const customB = yield* ls(join(ws, shopDirectory("TwoB")))
				assert.equal(customB.length, 3)

				yield* writeConfig(ws, {
					schemas: [{ name: "TwoA", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const single = yield* cli(
					ws,
					["generate", configName, "--schema", shopIdent("TwoA")],
					nextNow()
				)
				assert.equal(single.code, 2)
			})
	)

	it.effect(
		"ignores hidden entries, an editor's or the system's, beside the migration folders",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("hidden")
				yield* writeConfig(ws, {
					schemas: [{ name: "HiddenShop", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const first = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(first.code, 0)
				const dir = join(ws, shopDirectory("HiddenShop"))
				yield* write(join(dir, ".DS_Store"), "")
				yield* writeConfig(ws, {
					schemas: [{ name: "HiddenShop", fixture: "shop", version: 2, workload: "none" }],
					connection: unconnected
				})
				const beside = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(beside.code, 0)
			})
	)

	it.effect(
		"drafts every schema before writing any: a refused schema leaves the others untouched",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("atomic")
				yield* writeConfig(ws, {
					schemas: [
						{ name: "AtomA", fixture: "shop", version: 1, workload: "none" },
						{ name: "AtomB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: unconnected
				})
				const fs = yield* FileSystem.FileSystem
				yield* fs.makeDirectory(join(ws, "migrations"))
				yield* write(join(ws, shopDirectory("AtomB")), "not a directory\n")
				const r = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(r.code, 1)
				const schemaFolders = yield* ls(join(ws, "migrations"))
				assert.deepEqual(schemaFolders, [shopIdent("AtomB")])
			})
	)

	it.effect(
		"refuses another schema's snapshot, writing nothing; a role change needs no new snapshot",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("foreign")
				yield* writeConfig(ws, {
					schemas: [
						{ name: "OwnA", fixture: "shop", version: 1, workload: "none" },
						{ name: "OwnB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: unconnected
				})
				const first = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(first.code, 0)
				const dirA = join(ws, shopDirectory("OwnA"))
				const dirB = join(ws, shopDirectory("OwnB"))
				const listing = Effect.all([ls(dirA), ls(dirB)])
				const before = yield* listing
				yield* writeConfig(ws, {
					schemas: [
						{ name: "OwnA", fixture: "shop", version: 2, workload: "none" },
						{ name: "OwnB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: unconnected
				})
				const ownSnapshot = yield* read(join(dirA, "snapshot.json"))
				const snapshotB = yield* read(join(dirB, "snapshot.json"))
				yield* write(join(dirA, "snapshot.json"), snapshotB)
				const foreign = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(foreign.code, 1)
				const after = yield* listing
				assert.deepEqual(after, before)
				yield* write(join(dirA, "snapshot.json"), ownSnapshot)
				const restored = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(restored.code, 0)
			})
	)

	it.effect(
		"refuses a malformed name or configuration with the fix, never touching a connection, a refused connection before any check, and prints the usage",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("config")
				const unnamed = yield* bin(ws, ["generate"], {})
				assert.equal(unnamed.status, 2, "a command names its configuration file")
				const missing = yield* bin(ws, ["generate", configName], {})
				assert.equal(missing.status, 1, "a configuration file that does not exist")
				const plain = yield* cliOver(ws, { schemas: [] }, ["check", configName], nextNow())
				assert.equal(plain.code, 1)
				const configured = (text: string) => writeConfigText(ws, text)
				const define = `import { defineConfig } from "@bjornpagen/grizzle"\n`
				yield* configured(`${define}export default defineConfig({ schemas: [] })\n`)
				const empty = yield* bin(ws, ["migrate", configName], {})
				assert.equal(empty.status, 1)
				yield* configured(`${define}export default defineConfig({ schemas: [{ name: "Shop" }] })\n`)
				const malformed = yield* bin(ws, ["generate", configName], {})
				assert.equal(malformed.status, 1)
				yield* configured(`throw new Error("broken config")\n`)
				const broken = yield* bin(ws, ["generate", `./${configName}`], {})
				assert.equal(broken.status, 1)

				yield* writeConfig(ws, {
					schemas: [{ name: "NameShop", fixture: "shop", version: 1, workload: "none" }],
					connection: { ...unconnected, port: 70000 }
				})
				const generated = yield* cli(ws, ["generate", configName], nextNow())
				assert.equal(generated.code, 0)
				const checked = yield* cli(ws, ["check", configName], nextNow())
				assert.equal(checked.code, 0)
				yield* write(join(ws, shopDirectory("NameShop"), "stray.txt"), "")
				const refused = yield* cli(ws, ["migrate", configName], nextNow())
				assert.equal(refused.code, 1)
				const refusal = refused.stderr
				containsText(
					refusal,
					"refused at stage config: connection.transport.port",
					"migrate refuses its connection first"
				)
				lacksText(refusal, "stray.txt", "before any check runs")

				const bad = yield* cli(ws, ["generate", configName, "--name", "Add Tier"], nextNow())
				assert.equal(bad.code, 2)
				const help = yield* cli(ws, ["--help"], nextNow())
				assert.equal(help.code, 0)
				const unknown = yield* cli(ws, ["migrate", configName, "status"], nextNow())
				assert.equal(unknown.code, 2)
			})
	)

	it.effect(
		"writes a folder whose name is the longest file name the file system takes, and refuses a name one byte longer",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("longest")
				yield* writeConfig(ws, {
					schemas: [{ name: "LongShop", fixture: "shop", version: 1, workload: "none" }],
					connection: unconnected
				})
				const past = yield* cli(
					ws,
					["generate", configName, "--name", `${longestName}a`],
					nextNow()
				)
				assert.equal(past.code, 2, past.stderr)
				const fits = yield* cli(ws, ["generate", configName, "--name", longestName], nextNow())
				assert.equal(fits.code, 0, fits.stderr)
				const entries = yield* ls(join(ws, shopDirectory("LongShop")))
				const folders = Arr.filter(entries, (n) => n !== snapshotFileName)
				assert.deepEqual(
					Arr.map(folders, (n) => [isFolderName(n), utf8Length(n)]),
					[[true, fileNameMaxBytes.value]],
					"one folder, named at the file name limit"
				)
			})
	)
})
