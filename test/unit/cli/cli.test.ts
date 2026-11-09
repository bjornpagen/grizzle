import { inspect } from "node:util"
import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	characterOf,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	option,
	shuffled,
	string,
	type Weighted,
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
	String as Str
} from "effect"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import { type CommandLine, type GenerateMode, parseArgs } from "#cli/args.ts"
import { formatTimestamp, nextTimestamp, parseTimestamp } from "#cli/clock.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import {
	type ArgumentsRefused,
	type CliError,
	configSettings,
	generateFlags,
	type MigrationNameRefused
} from "#cli/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import {
	type FolderNaming,
	type MigrationName,
	maxMigrationNameLength
} from "#compiler/deploy/render/folder.ts"
import { login, role } from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { shop, type ShopWorkload } from "#test/pg/cli/fixture.ts"
import {
	bin,
	configName,
	offlineOwner,
	offlinePassword,
	resolvedConfig,
	workspace,
	writeConfigText
} from "#test/pg/cli/support.ts"
import { assert, defined, lacksText, nonEmpty, refusedAt, succeeded } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations, parsedMigrationName } from "#test/support/migrate/kit.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The `grizzle` command line without a database: argument parsing, folder timestamps and the lean configuration file.
 * What its commands write is the project suite's (project.test.ts).
 *
 * - The grammar, generated: every line of it (the commands generate, check, migrate, drift and names, each over the
 *   configuration file its one argument names, and generate's flags --name, a folder's name, --custom, which needs
 *   --name, and --schema, in any order and as `--flag value` or `--flag=value`) is read as exactly what it says; one
 *   fault injected into a line, a --name of no folder name's shape among them, is a usage error naming that fault;
 *   --help or -h anywhere prints the usage.
 * - Folder timestamps, generated against day arithmetic of the proleptic Gregorian calendar: a timestamp is the UTC second as fourteen digits,
 *   read back as the second it names and as nothing when its digits name none; a new folder's is the current second or
 *   one second after the schema's newest folder, whichever is later, its digits counted on as a number when they name
 *   no second.
 * - The configuration, generated: defineConfig({ schemas, logins, migrations, connection }) over one to three
 *   schemas and any of their logins resolves to exactly its schemas, each with its PostgreSQL schema, its directory and
 *   its logins, the migrations directory against the configuration file's, and the connection kept unread; one fault
 *   planted into it is refused at stage config by its own reason, and no refusal names the password.
 * - The bin's loading of the configuration file, generated: a command naming no file is a usage error; a file that is
 *   missing, whose import throws, fails to parse, imports what does not exist or awaits a rejection, that exports no
 *   default, or whose default is any value but a configuration grizzle runs, built by defineConfig or not, is refused,
 *   writing nothing.
 */
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
	upTo(maxMigrationNameLength.value, () => "a"),
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
 * A name of no folder name's shape, none starting with `-`: a drawn name broken once, by a character outside lowercase
 * ASCII, digits and the separators set into it, a separator leading or trailing it or doubled inside it, or a byte
 * more than the longest.
 */
const malformedGen: Gen<string> = (source) => {
	const name: string = source.draw(nameGen)
	const at = source.draw(int(0, name.length))
	const before = Str.slice(0, at)(name)
	const after = Str.slice(at)(name)
	return source.draw(
		oneOf<string>([
			map(characterOf(["A", "Z", " ", "é", "=", ".", "/"]), (ch) => `${before}${ch}${after}`),
			constant(`_${name}`),
			map(characterOf(["_", "-"]), (separator) => `${name}${separator}`),
			map(characterOf(["_", "-"]), (separator) => `${before}_${separator}${after}`),
			constant(`${longestName}a`)
		])
	)
}

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

/** The commands, generate's and the plain ones. */
const commands: ReadonlyArray<string> = ["generate", ...plainCommands]

/** The flags a command takes, by name: generate's switches, valued flags and repeated flags. */
const flagNames: Arr.NonEmptyReadonlyArray<string> = [
	...generateFlags.switches,
	...generateFlags.valued,
	...generateFlags.repeated
]

/** Whether `token` is an option some command takes: a flag, a valued or repeated flag with its value, or the help. */
const knownOption = (token: string): boolean =>
	token === "--help" ||
	token === "-h" ||
	Arr.some(
		flagNames,
		(f) =>
			token === `--${f}` ||
			(!Arr.contains(generateFlags.switches, f) && Str.startsWith(`--${f}=`)(token))
	)

/** A few letters, the ones the commands and flags are spelled in among them. */
const lettersGen: Gen<string> = string(characterOf(["a", "e", "m", "n", "r", "s", "x", "y"]), {
	min: 1,
	max: 6
})

/**
 * An option no command takes: a flag broken once (capitalized, a letter more or less, a dash more or less, a switch
 * given a value), a word after two dashes, a letter after one but the help's, or a lone dash.
 */
const unknownOptionGen: Gen<string> = filter(
	oneOf<string>([
		(source) => {
			const f = source.draw(element(flagNames))
			return source.draw(
				oneOf<string>([
					constant(`--${Str.capitalize(f)}`),
					map(characterOf(["s", "x"]), (ch) => `--${f}${ch}`),
					constant(`--${Str.slice(0, -1)(f)}`),
					constant(`---${f}`),
					constant(`-${f}`),
					map(lettersGen, (value) => `--${f}=${value}`)
				])
			)
		},
		map(lettersGen, (word) => `--${word}`),
		map(characterOf(["x", "n", "s", "c"]), (letter) => `-${letter}`),
		constant("-")
	]),
	(token) => !knownOption(token),
	8
)

/**
 * A word that is no command: a command broken once (capitalized, a letter more or less, two dashes before it), a word
 * of letters, or the empty word.
 */
const unknownCommandGen: Gen<string> = filter(
	oneOf<string>([
		(source) => {
			const command = source.draw(element(nonEmpty(commands, "a command")))
			return source.draw(
				oneOf<string>([
					constant(Str.capitalize(command)),
					map(characterOf(["s", "x"]), (ch) => `${command}${ch}`),
					constant(Str.slice(0, -1)(command)),
					constant(`--${command}`)
				])
			)
		},
		lettersGen,
		constant("")
	]),
	(word) => !Arr.contains(commands, word),
	8
)

const faultsOf = (s: Spelled): Gen<Fault> => {
	const { line, units } = s
	const command = line.command
	const fault =
		(kind: FaultKind) =>
		(edited: ReadonlyArray<Unit>): Fault => ({ argv: argvOf(command, edited), kind })
	const without = (role: Unit["role"]): ReadonlyArray<Unit> =>
		Arr.filter(units, (u) => u.role !== role)
	const common: Arr.NonEmptyReadonlyArray<Gen<Fault>> = [
		map(unknownCommandGen, (word): Fault => ({
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
			const unknown: Unit = { role: "custom", tokens: [source.draw(unknownOptionGen)] }
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
			const misnamed = source.draw(valuedGen("name", source.draw(malformedGen)))
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
						oracle: { kind: "unstated" },
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
						oracle: { kind: "unstated" },
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
					oracle: { kind: "unstated" },
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

/** A UTC second by its fields, as the calendar writes it. */
interface Second {
	readonly year: number
	readonly month: number
	readonly day: number
	readonly hour: number
	readonly minute: number
	readonly second: number
}

/** Whether `year` is a leap year of the Gregorian calendar. */
const leap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/** The days of each month of a common year. */
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** The days of `month` in `year`. */
const daysIn = (year: number, month: number): number =>
	month === 2 && leap(year) ? 29 : defined(monthDays[month - 1], "a month of the year")

const secondsPerDay = 86_400

/** The days from 1970-01-01 to a date, by day arithmetic over the Gregorian calendar's 400-year eras. */
const daysOf = (year: number, month: number, day: number): number => {
	const y = month <= 2 ? year - 1 : year
	const era = Math.floor(y / 400)
	const yearOfEra = y - era * 400
	const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1
	const dayOfEra =
		yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
	return era * 146_097 + dayOfEra - 719_468
}

/** A field drawn among its edges more often than its middle. */
const edged = (lo: number, hi: number, edges: Arr.NonEmptyReadonlyArray<number>): Gen<number> =>
	weighted([
		[1, element(edges)],
		[2, int(lo, hi)]
	])

/** A UTC second, its calendar's edges drawn often: year ends, month ends, leap days, centuries, 1970 and 9999. */
const secondGen: Gen<Second> = (source) => {
	const year = source.draw(edged(1970, 9999, [1970, 2000, 2024, 2026, 2100, 9999]))
	const month = source.draw(edged(1, 12, [1, 2, 12]))
	const last = daysIn(year, month)
	return {
		year,
		month,
		day: source.draw(edged(1, last, [1, last])),
		hour: source.draw(edged(0, 23, [0, 23])),
		minute: source.draw(edged(0, 59, [0, 59])),
		second: source.draw(edged(0, 59, [0, 59]))
	}
}

/** The epoch milliseconds of a second. */
const millisOf = (s: Second): number =>
	(daysOf(s.year, s.month, s.day) * secondsPerDay + s.hour * 3600 + s.minute * 60 + s.second) * 1000

/** The fields of the second at `millis`, by day arithmetic over the Gregorian calendar's 400-year eras. */
const secondAt = (millis: number): Second => {
	const seconds = Math.floor(millis / 1000)
	const days = Math.floor(seconds / secondsPerDay)
	const time = seconds - days * secondsPerDay
	const shifted = days + 719_468
	const era = Math.floor(shifted / 146_097)
	const dayOfEra = shifted - era * 146_097
	const yearOfEra = Math.floor(
		(dayOfEra -
			Math.floor(dayOfEra / 1460) +
			Math.floor(dayOfEra / 36_524) -
			Math.floor(dayOfEra / 146_096)) /
			365
	)
	const dayOfYear =
		dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
	const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153)
	const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9
	return {
		year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
		month,
		day: dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1,
		hour: Math.floor(time / 3600),
		minute: Math.floor((time % 3600) / 60),
		second: time % 60
	}
}

const padded = (n: number, width: number): string => Str.padStart(width, "0")(String(n))

/** The oracle's timestamp of a second: its fields' digits, the year in four or more. */
const digitsOf = (s: Second): string =>
	`${padded(s.year, 4)}${padded(s.month, 2)}${padded(s.day, 2)}${padded(s.hour, 2)}${padded(s.minute, 2)}${padded(s.second, 2)}`

/** The oracle's reading of fourteen digits: the second they name, with a year of four digits, or none. */
const secondOfDigits = (text: string): Option.Option<number> => {
	const digits = Arr.every(Str.split(text, ""), (c) => c >= "0" && c <= "9")
	if (text.length !== 14 || !digits || Str.startsWith("0")(text)) {
		return Option.none()
	}
	const field = (from: number, width: number) => Number(Str.slice(from, from + width)(text))
	const s: Second = {
		year: field(0, 4),
		month: field(4, 2),
		day: field(6, 2),
		hour: field(8, 2),
		minute: field(10, 2),
		second: field(12, 2)
	}
	const millis = millisOf(s)
	return digitsOf(secondAt(millis)) === text ? Option.some(millis) : Option.none()
}

/**
 * Fourteen digits that name no second: a drawn second with one field pushed out of its range, a month or a day of 0, a
 * month past 12, a day past its month's last, an hour past 23, a minute or a second past 59, or a year below 1000,
 * whose digits lead with a zero. The oracle reads every one (secondOfDigits).
 */
const nonsenseGen: Gen<string> = (source) => {
	const s = source.draw(secondGen)
	const broken = source.draw(
		oneOf<Second>([
			map(oneOf([constant(0), int(13, 99)]), (month) => ({ ...s, month })),
			map(oneOf([constant(0), int(daysIn(s.year, s.month) + 1, 99)]), (day) => ({ ...s, day })),
			map(int(24, 99), (hour) => ({ ...s, hour })),
			map(int(60, 99), (minute) => ({ ...s, minute })),
			map(int(60, 99), (second) => ({ ...s, second })),
			map(int(0, 999), (year) => ({ ...s, year }))
		])
	)
	return digitsOf(broken)
}

/** The digits of the second at `millis`, or of `fallback` past year 9999, which no folder's fourteen digits name. */
const fourteenAt = (millis: number, fallback: number): string => {
	const s = secondAt(millis)
	return digitsOf(s.year > 9999 ? secondAt(fallback) : s)
}

/** A folder's timestamp around the clock's: before it, at it, after it, a year's last second after it, or nonsense. */
const existingGen = (now: number): Gen<string> =>
	weighted([
		[3, map(int(-3, 3), (offset) => fourteenAt(now + offset * 1000, now))],
		[
			1,
			map(int(0, 2), (ahead) =>
				digitsOf({
					year: Math.min(secondAt(now).year + ahead, 9999),
					month: 12,
					day: 31,
					hour: 23,
					minute: 59,
					second: 59
				})
			)
		],
		[1, nonsenseGen]
	])

interface Stamping {
	readonly now: Second
	readonly existing: ReadonlyArray<string>
}

const stampingGen: Gen<Stamping> = (source) => {
	const now = source.draw(secondGen)
	return { now, existing: source.draw(array(existingGen(millisOf(now)), { min: 0, max: 3 })) }
}

type StampFeature =
	| "no folder"
	| "the clock past the newest folder"
	| "the clock at the newest folder's second"
	| "the clock behind the newest folder"
	| "a newest folder naming no second"
	| "a day rolled over"
	| "a year rolled over"
	| "a timestamp past year 9999"
	| "February 29"

/** What a new folder's timestamp is by the oracle: the current second, or the second after the newest folder's. */
const nextOf = (s: Stamping, c: Case<StampFeature>): string => {
	const current = digitsOf(s.now)
	const newest = Arr.reduce(s.existing, Option.none<string>(), (best, e) =>
		Option.isSome(best) && best.value >= e ? best : Option.some(e)
	)
	if (Option.isNone(newest)) {
		c.note("no folder")
		return current
	}
	if (current > newest.value) {
		c.note("the clock past the newest folder")
		return current
	}
	c.note(
		current === newest.value
			? "the clock at the newest folder's second"
			: "the clock behind the newest folder"
	)
	return Option.match(secondOfDigits(newest.value), {
		onNone: () => {
			c.note("a newest folder naming no second")
			return Str.padStart(14, "0")(String(BigInt(newest.value) + 1n))
		},
		onSome: (millis) => {
			const next = secondAt(millis + 1000)
			const was = secondAt(millis)
			if (next.day !== was.day) {
				c.note("a day rolled over")
			}
			if (next.year !== was.year) {
				c.note("a year rolled over")
			}
			if (next.year > 9999) {
				c.note("a timestamp past year 9999")
			}
			return digitsOf(next)
		}
	})
}

describe("folder timestamps, generated", () => {
	it.effect(
		"are the UTC second as fourteen digits, read back as the second they name, and a new folder's sorts after every folder of its schema",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/timestamps",
						draw: drawn(stampingGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "day arithmetic of the Gregorian calendar, and the documented rule: the current second or one past the newest folder's"
						},
						coverage: required<StampFeature>(
							[
								"no folder",
								"the clock past the newest folder",
								"the clock at the newest folder's second",
								"the clock behind the newest folder",
								"a newest folder naming no second",
								"a day rolled over",
								"a year rolled over",
								"a timestamp past year 9999",
								"February 29"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const millis = millisOf(s.now)
							const now = DateTime.makeUnsafe(millis)
							if (s.now.month === 2 && s.now.day === 29) {
								c.note("February 29")
							}
							const digits = digitsOf(s.now)
							assert.equal(formatTimestamp(now), digits, "the UTC second's digits")
							for (const text of [digits, ...s.existing]) {
								assert.deepEqual(
									Option.map(parseTimestamp(text), DateTime.toEpochMillis),
									secondOfDigits(text),
									`${text} reads as the second it names, or none`
								)
							}
							assert.equal(nextTimestamp(now, s.existing), nextOf(s, c), Formatter.format(s))
						})
				)
			)
	)
})

/** The declared schemas a configuration draws from, each the shop fixture under its own name. */
const schemaNames = ["CfgA", "CfgB", "CfgC"] as const
type SchemaName = (typeof schemaNames)[number]

/** One configured schema: the shop under a name, at a version, its login owning a workload. */
interface SchemaEntry {
	readonly name: SchemaName
	readonly version: 1 | 2
	readonly workload: ShopWorkload
}

/** How the migrations directory is given: relative to the configuration file's directory, or absolute. */
type MigrationsForm = "db" | "./db/mig" | "nested/dir/" | "../up" | "absolute"

/** What a configuration's value is that no configuration is. */
type Nonobject = "undefined" | "a list" | "a text" | "a number"

/** One fault planted into a configuration, by where it stands. */
type ConfigFault =
	| { readonly kind: "none" }
	| { readonly kind: "not an object"; readonly value: Nonobject }
	| { readonly kind: "a plain object" }
	| { readonly kind: "an unknown setting"; readonly setting: "poolSize" | "migration" | "schema" }
	| {
			readonly kind: "a setting left out"
			readonly setting: "schemas" | "logins" | "migrations" | "connection"
	  }
	| { readonly kind: "an empty migrations path" }
	| { readonly kind: "no schema" }
	| {
			readonly kind: "a schema entry no schema value"
			readonly at: number
			readonly entry: "a relation" | "an object" | "a login"
	  }
	| { readonly kind: "a schema at a second version"; readonly of: number }
	| { readonly kind: "a login over an unlisted schema"; readonly at: number }
	| { readonly kind: "a login over another version"; readonly of: number; readonly at: number }
	| { readonly kind: "a login named as a role"; readonly of: number }
	| { readonly kind: "a login listed twice"; readonly of: number }
	| { readonly kind: "a login entry no login value"; readonly at: number }

type ConfigFaultKind = ConfigFault["kind"]

interface ConfigSketch {
	readonly schemas: ReadonlyArray<SchemaEntry>
	/** The schemas whose login is listed, by index, in the order listed. */
	readonly logins: ReadonlyArray<number>
	readonly migrations: MigrationsForm
	/** Whether the connection's port is out of range, which only migrate and drift read. */
	readonly broken: boolean
	readonly fault: ConfigFault
}

const entryGen: Gen<Omit<SchemaEntry, "name">> = (source) => ({
	version: source.draw(element<1 | 2>([1, 2])),
	workload: source.draw(element<ShopWorkload>(["full", "withoutByName", "none"]))
})

/** The faults that apply to a configuration of `schemas` schemas whose listed logins are `logins`. */
const configFaultGen = (schemas: number, logins: ReadonlyArray<number>): Gen<ConfigFault> => {
	const schemaAt = int(0, schemas - 1)
	const loginAt = int(0, logins.length)
	return weighted<ConfigFault>([
		[6, constant({ kind: "none" })],
		[
			1,
			map(element<Nonobject>(["undefined", "a list", "a text", "a number"]), (value) => ({
				kind: "not an object",
				value
			}))
		],
		[1, constant({ kind: "a plain object" })],
		[
			1,
			map(element(["poolSize", "migration", "schema"] as const), (setting) => ({
				kind: "an unknown setting",
				setting
			}))
		],
		[
			1,
			map(element(["schemas", "logins", "migrations", "connection"] as const), (setting) => ({
				kind: "a setting left out",
				setting
			}))
		],
		[1, constant({ kind: "an empty migrations path" })],
		[1, constant({ kind: "no schema" })],
		[
			1,
			(source) => ({
				kind: "a schema entry no schema value",
				at: source.draw(int(0, schemas)),
				entry: source.draw(element(["a relation", "an object", "a login"] as const))
			})
		],
		[1, map(schemaAt, (of) => ({ kind: "a schema at a second version", of }))],
		[1, map(loginAt, (at) => ({ kind: "a login over an unlisted schema", at }))],
		[
			1,
			(source) => ({
				kind: "a login over another version",
				of: source.draw(schemaAt),
				at: source.draw(loginAt)
			})
		],
		[1, map(schemaAt, (of) => ({ kind: "a login named as a role", of }))],
		[1, map(schemaAt, (of) => ({ kind: "a login listed twice", of }))],
		[1, map(loginAt, (at) => ({ kind: "a login entry no login value", at }))]
	])
}

const sketchGen: Gen<ConfigSketch> = (source) => {
	const names = source.draw(shuffled(schemaNames, { min: 1, max: schemaNames.length }))
	const schemas = Arr.map(names, (name) => ({ name, ...source.draw(entryGen) }))
	const logins = source.draw(
		shuffled(Arr.range(0, schemas.length - 1), { min: 0, max: schemas.length })
	)
	return {
		schemas,
		logins,
		migrations: source.draw(
			element<MigrationsForm>(["db", "./db/mig", "nested/dir/", "../up", "absolute"])
		),
		broken: source.draw(boolean),
		fault: source.draw(configFaultGen(schemas.length, logins))
	}
}

/** The configuration file every case names, in a directory of the repository. */
const configFile = `${repoRoot}app/grizzle.config.ts`

/** The migrations directory a form names, from the configuration file's directory. */
const migrationsOf = (
	form: MigrationsForm
): { readonly given: string; readonly resolved: string } => {
	switch (form) {
		case "db":
			return { given: "db", resolved: `${repoRoot}app/db` }
		case "./db/mig":
			return { given: "./db/mig", resolved: `${repoRoot}app/db/mig` }
		case "nested/dir/":
			return { given: "nested/dir/", resolved: `${repoRoot}app/nested/dir` }
		case "../up":
			return { given: "../up", resolved: `${repoRoot}up` }
		case "absolute":
			return { given: `${repoRoot}elsewhere/db`, resolved: `${repoRoot}elsewhere/db` }
	}
}

/** The schema and login values of a configured schema. */
const built = (e: SchemaEntry) => shop(e.name, e.version, e.workload)

/** `entry` inserted into `entries` at `at`, as a list a configuration file could hold. */
const inserted = (
	entries: ReadonlyArray<unknown>,
	at: number,
	entry: unknown
): ReadonlyArray<unknown> => [...Arr.take(entries, at), entry, ...Arr.drop(entries, at)]

/**
 * A configuration's value as a sketch builds it, through defineConfig, its fault planted as JavaScript would plant it
 * past defineConfig's type: a key set, deleted or replaced on the value it typed, or a value it never typed.
 */
const valueOf = (
	s: ConfigSketch
): { readonly value: unknown; readonly connection: () => MigrationConnectionConfig } => {
	const values = Arr.map(s.schemas, built)
	const at = (i: number) => defined(values[i], "a configured schema")
	const connection = (): MigrationConnectionConfig =>
		s.broken ? { ...offlineOwner, transport: { ...offlineOwner.transport, port: 70000 } } : offlineOwner
	const schemas = Arr.map(values, (v) => v.schema)
	const logins = Arr.map(s.logins, (i) => at(i).server)
	const config = defineConfig({
		schemas: [at(0).schema, ...Arr.drop(schemas, 1)],
		logins,
		migrations: migrationsOf(s.migrations).given,
		connection
	})
	const listed = (of: number): ReadonlyArray<unknown> =>
		Arr.contains(s.logins, of) ? logins : [...logins, at(of).server]
	const f = s.fault
	switch (f.kind) {
		case "none":
			return { value: config, connection }
		case "not an object":
			return {
				value: { undefined, "a list": [], "a text": "grizzle", "a number": 3 }[f.value],
				connection
			}
		case "a plain object":
			return { value: { ...config }, connection }
		case "an unknown setting":
			Reflect.set(config, f.setting, "db")
			return { value: config, connection }
		case "a setting left out":
			Reflect.deleteProperty(config, f.setting)
			return { value: config, connection }
		case "an empty migrations path":
			Reflect.set(config, "migrations", "")
			return { value: config, connection }
		case "no schema":
			Reflect.set(config, "schemas", [])
			return { value: config, connection }
		case "a schema entry no schema value": {
			const entry = { "a relation": at(0).Customer, "an object": {}, "a login": at(0).server }[
				f.entry
			]
			Reflect.set(config, "schemas", inserted(schemas, f.at, entry))
			return { value: config, connection }
		}
		case "a schema at a second version": {
			const e = defined(s.schemas[f.of], "the schema at two versions")
			Reflect.set(config, "schemas", [
				...schemas,
				built({ ...e, version: e.version === 1 ? 2 : 1 }).schema
			])
			return { value: config, connection }
		}
		case "a login over an unlisted schema":
			Reflect.set(config, "logins", inserted(logins, f.at, shop("CfgZ", 1, "none").server))
			return { value: config, connection }
		case "a login over another version": {
			const e = defined(s.schemas[f.of], "the schema of another version")
			const other = built({ ...e, version: e.version === 1 ? 2 : 1 }).server
			Reflect.set(config, "logins", inserted(logins, f.at, other))
			return { value: config, connection }
		}
		case "a login named as a role": {
			const v = at(f.of)
			const named = login(v.schema, "Reader", [role(v.schema, "auditor", v.schema.relations)])
			Reflect.set(config, "logins", [...listed(f.of), named])
			return { value: config, connection }
		}
		case "a login listed twice":
			Reflect.set(config, "logins", [...listed(f.of), at(f.of).server])
			return { value: config, connection }
		case "a login entry no login value":
			Reflect.set(config, "logins", inserted(logins, f.at, at(0).reader))
			return { value: config, connection }
	}
}

/** Where a planted fault's login stands in the configuration's logins: the last, after its own schema's login. */
const appendedAt = (s: ConfigSketch, of: number): number =>
	s.logins.length + (Arr.contains(s.logins, of) ? 0 : 1)

/** The refusal a planted fault must meet: its reason's tag, and the fault and index the reason names. */
interface Expected {
	readonly tag: CliError["reason"]["_tag"]
	readonly fault: string
	readonly index: number | undefined
}

const expectedOf = (
	s: ConfigSketch,
	f: Exclude<ConfigFault, { readonly kind: "none" }>
): Expected => {
	switch (f.kind) {
		case "not an object":
			return { tag: "ExportRefused", fault: "notAnObject", index: undefined }
		case "a plain object":
			return { tag: "ExportRefused", fault: "notDefined", index: undefined }
		case "an unknown setting":
			return { tag: "SettingRefused", fault: "unknown", index: undefined }
		case "a setting left out":
			return {
				tag: "SettingRefused",
				fault: f.setting === "connection" ? "unconnected" : "malformed",
				index: undefined
			}
		case "an empty migrations path":
		case "no schema":
			return { tag: "SettingRefused", fault: "malformed", index: undefined }
		case "a schema entry no schema value":
			return { tag: "SchemaEntryRefused", fault: "notBuilt", index: f.at }
		case "a schema at a second version":
			return { tag: "SchemaEntryRefused", fault: "shared", index: s.schemas.length }
		case "a login over an unlisted schema":
			return { tag: "LoginEntryRefused", fault: "unlisted", index: f.at }
		case "a login over another version":
			return { tag: "LoginEntryRefused", fault: "otherVersion", index: f.at }
		case "a login named as a role":
		case "a login listed twice":
			return { tag: "LoginEntryRefused", fault: "nameTaken", index: appendedAt(s, f.of) }
		case "a login entry no login value":
			return { tag: "LoginEntryRefused", fault: "notBuilt", index: f.at }
	}
}

/** What a refusal's reason names: its tag, its fault's kind and the entry's index, where it names them. */
const namedBy = (e: CliError): Expected => {
	const reason = e.reason
	if (reason._tag === "ExportRefused") {
		return { tag: reason._tag, fault: reason.fault, index: undefined }
	}
	if (reason._tag === "SettingRefused") {
		return { tag: reason._tag, fault: reason.fault.kind, index: undefined }
	}
	if (reason._tag === "SchemaEntryRefused" || reason._tag === "LoginEntryRefused") {
		return { tag: reason._tag, fault: reason.fault.kind, index: reason.index }
	}
	return { tag: reason._tag, fault: "", index: undefined }
}

/** A resolved schema as the model states it: its declared name, PostgreSQL schema, directory and logins' indices. */
const resolvedSchemas = (c: ResolvedConfig) =>
	Arr.map(c.schemas, (x) => ({
		index: x.index,
		declared: x.declared,
		ident: x.ident,
		directory: x.directory,
		logins: Arr.map(x.logins, (l) => l.index)
	}))

const modelSchemas = (s: ConfigSketch) => {
	const migrations = migrationsOf(s.migrations).resolved
	return Arr.map(s.schemas, (e, index) => {
		const ident = identifierOf(identity.schema(parsedSchemaName(e.name)))
		return {
			index,
			declared: e.name,
			ident,
			directory: `${migrations}/${ident}`,
			logins: Arr.flatMap(s.logins, (listed, j) => (listed === index ? [j] : []))
		}
	})
}

type ConfigFeature =
	| ConfigFaultKind
	| "three schemas"
	| "a schema with no login listed"
	| "a broken connection kept"

const configFaultKinds = [
	"not an object",
	"a plain object",
	"an unknown setting",
	"a setting left out",
	"an empty migrations path",
	"no schema",
	"a schema entry no schema value",
	"a schema at a second version",
	"a login over an unlisted schema",
	"a login over another version",
	"a login named as a role",
	"a login listed twice",
	"a login entry no login value"
] as const satisfies ReadonlyArray<ConfigFaultKind>

layer(NodeServices.layer, { excludeTestServices: true })(
	"the configuration file, generated",
	(it) => {
		it.effect(
			"resolves to exactly its schemas, logins and migrations directory, its connection unread, and refuses one planted fault by its own reason, never naming the password",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "unit/cli/configuration",
							draw: drawn(sketchGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the configuration's documented settings, resolved by hand, and the refusal each planted fault names"
							},
							coverage: required<ConfigFeature>(
								[
									...configFaultKinds,
									"three schemas",
									"a schema with no login listed",
									"a broken connection kept"
								],
								{ cases: 400, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(s, c) =>
							Effect.gen(function* () {
								const { value, connection } = valueOf(s)
								const resolved = yield* resolvedConfig(value, configFile)
								const f = s.fault
								if (f.kind === "none") {
									const config = succeeded(resolved)
									assert.equal(config.migrations, migrationsOf(s.migrations).resolved)
									assert.deepEqual(resolvedSchemas(config), modelSchemas(s))
									assert.ok(config.connection === connection, "the connection kept as given")
									c.noteAll([
										...(s.schemas.length === 3 ? (["three schemas"] as const) : []),
										...(s.logins.length < s.schemas.length
											? (["a schema with no login listed"] as const)
											: []),
										...(s.broken ? (["a broken connection kept"] as const) : [])
									])
									return
								}
								c.note(f.kind)
								const refusal = refusedAt(resolved, "stage", "config")
								assert.deepEqual(namedBy(refusal), expectedOf(s, f))
								lacksText(
									`${refusal.message}\n${inspect(refusal, { depth: 12 })}`,
									offlinePassword,
									"no refusal names the password"
								)
							})
					)
				)
		)
	}
)

/** How importing a configuration file fails: a throw at its top, a syntax error, an import of a module that does
 * not exist, or a rejected top-level await. */
type ImportFailure = "a throw" | "a syntax error" | "a missing import" | "a rejected await"

/** What a configuration module exports: values under names of their own, and a default value, if any. */
interface Exports {
	readonly named: ReadonlyArray<string>
	readonly default: Option.Option<string>
}

/**
 * A configuration file as the bin's loading meets it: none named by the command line, named but absent, one whose
 * import fails before its exports, or one that loads. No drawn file is a configuration grizzle runs: none lists a
 * schema value, so every one that loads is refused by its configuration; a valid file's run through the bin is the
 * network tier's (test/pg/cli/cli.test.ts).
 */
type Loading =
	| { readonly kind: "no file named" }
	| { readonly kind: "a file that does not exist" }
	| {
			readonly kind: "a file whose import fails"
			readonly failure: ImportFailure
			readonly exports: Exports
	  }
	| { readonly kind: "a file that loads"; readonly exports: Exports }

/** A value's text as a module writes it: a number, a text, null, undefined, a boolean, a function, or, `depth` deep, a
 * list, an object of the configuration's settings and an unknown one, or defineConfig's call on one. */
const valueTextGen = (depth: number): Gen<string> => {
	const scalars: Arr.NonEmptyReadonlyArray<Weighted<string>> = [
		[2, map(int(-2, 2), String)],
		[1, map(string(characterOf(["a", "b"]), { min: 0, max: 2 }), (text) => `"${text}"`)],
		[1, constant("null")],
		[1, constant("undefined")],
		[1, map(boolean, String)],
		[1, constant("() => 0")]
	]
	if (depth === 0) {
		return weighted(scalars)
	}
	const inner = valueTextGen(depth - 1)
	const setting = weighted<string>([
		[4, element(configSettings)],
		[1, constant("poolSize")]
	])
	const entry: Gen<string> = (source) => `${source.draw(setting)}: ${source.draw(inner)}`
	const objectText: Gen<string> = map(
		array(entry, { min: 0, max: 3 }),
		(entries) => `{ ${Arr.join(entries, ", ")} }`
	)
	return weighted([
		...scalars,
		[2, map(array(inner, { min: 0, max: 2 }), (items) => `[${Arr.join(items, ", ")}]`)],
		[3, objectText],
		[3, map(objectText, (o) => `defineConfig(${o})`)]
	])
}

/** A module's exports: up to two named values, and a default one or none. */
const exportsGen: Gen<Exports> = (source) => ({
	named: source.draw(array(valueTextGen(2), { min: 0, max: 2 })),
	default: source.draw(option(valueTextGen(2)))
})

const loadingGen: Gen<Loading> = weighted<Loading>([
	[1, constant({ kind: "no file named" })],
	[1, constant({ kind: "a file that does not exist" })],
	[
		2,
		(source) => ({
			kind: "a file whose import fails",
			failure: source.draw(
				weighted<ImportFailure>([
					[1, constant("a throw")],
					[1, constant("a syntax error")],
					[1, constant("a missing import")],
					[1, constant("a rejected await")]
				])
			),
			exports: source.draw(exportsGen)
		})
	],
	[4, (source) => ({ kind: "a file that loads", exports: source.draw(exportsGen) })]
])

const defineImport = `import { defineConfig } from "@bjornpagen/grizzle"\n`

/** The statement that makes a module's import fail. */
const failureText = (failure: ImportFailure): string => {
	switch (failure) {
		case "a throw":
			return `throw new Error("broken config")\n`
		case "a syntax error":
			return "export const = 1\n"
		case "a missing import":
			return `import "./nowhere.ts"\n`
		case "a rejected await":
			return `await Promise.reject(new Error("broken config"))\n`
	}
}

/** A module's text: its import of defineConfig, its exports, and the statement its import fails at, first. */
const moduleText = (exports: Exports, failure: Option.Option<ImportFailure>): string =>
	Arr.join(
		[
			defineImport,
			...Option.match(failure, { onNone: () => [], onSome: (f) => [failureText(f)] }),
			...Arr.map(exports.named, (value, at) => `export const named${at} = ${value}\n`),
			...Option.match(exports.default, {
				onNone: () => [],
				onSome: (v) => [`export default ${v}\n`]
			})
		],
		""
	)

/** Writes the configuration file a loading names into `ws`, none where the file does not exist. */
const loadingFile = (ws: string, loading: Loading) => {
	switch (loading.kind) {
		case "no file named":
		case "a file that does not exist":
			return Effect.void
		case "a file whose import fails":
			return writeConfigText(ws, moduleText(loading.exports, Option.some(loading.failure)))
		case "a file that loads":
			return writeConfigText(ws, moduleText(loading.exports, Option.none()))
	}
}

/** The exit status run.ts documents for a loading: 2 for a usage error, a command line naming no file; 1 for a refusal. */
const statusOf = (loading: Loading): 1 | 2 => (loading.kind === "no file named" ? 2 : 1)

type LoadingFeature =
	| Loading["kind"]
	| ImportFailure
	| "no default export"
	| "a default built by defineConfig"
	| "a default defineConfig did not build"

/** What a loading reached. */
const loadingNotes = (loading: Loading): ReadonlyArray<LoadingFeature> => {
	switch (loading.kind) {
		case "no file named":
		case "a file that does not exist":
			return [loading.kind]
		case "a file whose import fails":
			return [loading.kind, loading.failure]
		case "a file that loads":
			return [
				loading.kind,
				Option.match(loading.exports.default, {
					onNone: (): LoadingFeature => "no default export",
					onSome: (v): LoadingFeature =>
						Str.startsWith("defineConfig(")(v)
							? "a default built by defineConfig"
							: "a default defineConfig did not build"
				})
			]
	}
}

/** How many candidates a steered case draws for a loading that reaches a pending situation. */
const aimCandidates = 32

/**
 * The loading a case runs: the drawn one, or, where steering names situations no case has reached, the first of up to
 * `aimCandidates` further draws that reaches one, else the drawn one.
 */
const aimedLoading = (drawnLoading: Loading, c: Case<LoadingFeature>): Loading =>
	Option.match(c.steering, {
		onNone: () => drawnLoading,
		onSome: (pending) => {
			const reaches = (loading: Loading) => Arr.some(loadingNotes(loading), (f) => pending.has(f))
			return reaches(drawnLoading)
				? drawnLoading
				: Option.getOrElse(
						Arr.findFirst(
							c.draw(array(loadingGen, { min: aimCandidates, max: aimCandidates })),
							reaches
						),
						() => drawnLoading
					)
		}
	})

layer(NodeServices.layer, { excludeTestServices: true })("the bin's configuration file", (it) => {
	it.effect(
		"is named by the command line, loaded and checked before any command runs: every way loading fails is refused, writing nothing",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/bin-loading",
						draw: drawn(loadingGen),
						literal: Formatter.format,
						coverage: required<LoadingFeature>(
							[
								"no file named",
								"a file that does not exist",
								"a file whose import fails",
								"a file that loads",
								"a throw",
								"a syntax error",
								"a missing import",
								"a rejected await",
								"no default export",
								"a default built by defineConfig",
								"a default defineConfig did not build"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 8,
						shrink: { kind: "bounded", candidates: 16 },
						concurrency: 3,
						steerEvery: 6,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the exit statuses run.ts documents: 1 for a refusal, 2 for a usage error; and a refusal writes nothing"
						}
					},
					(drawnLoading, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const loading = aimedLoading(drawnLoading, c)
								c.noteAll(loadingNotes(loading))
								const ws = yield* workspace("loading")
								yield* loadingFile(ws, loading)
								const argv =
									loading.kind === "no file named" ? ["generate"] : ["generate", configName]
								const ran = yield* bin(ws, argv, {})
								assert.equal(ran.status, statusOf(loading), `${loading.kind}: ${ran.stderr}`)
								const fs = yield* FileSystem.FileSystem
								const left = yield* fs.readDirectory(ws)
								assert.deepEqual(
									Arr.filter(left, (entry) => entry !== configName),
									[],
									"a refusal writes nothing"
								)
							})
						)
				)
			)
	)
})
