/** What the properties of cli.test.ts read: its spaces, models and helpers. */

import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	shuffled,
	string,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import type { CommandLine, GenerateMode } from "#cli/args.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import {
	type ArgumentsRefused,
	type CliError,
	type CommandName,
	configSettings,
	generateFlags,
	type MigrationNameRefused
} from "#cli/errors.ts"
import {
	identifierOf,
	identity,
	maxIdentifierBytes,
	maxRolePrefixBytes
} from "#compiler/core/identity.ts"
import { type FolderNaming, type MigrationName } from "#compiler/deploy/render/folder.ts"
import { maxMigrationNameLength } from "#compiler/deploy/render/layout.ts"
import { login, role } from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { shop, type ShopWorkload } from "#test/pg/cli/fixture.ts"
import { offlineOwner, writeConfigText } from "#test/pg/cli/support.ts"
import {
	daysIn,
	digitsOf,
	edged,
	millisOf,
	type Second,
	secondAt,
	secondGen
} from "#test/support/calendar.ts"
import { repoRoot } from "#test/support/files.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations, parsedMigrationName } from "#test/support/migrate/kit.ts"
import { upTo } from "#test/support/up-to.ts"
/** The commands that draft, by generate's flags: generate, and draft-key, which digests its draft's inputs. */
type DraftingCommand = Extract<CommandName, "generate" | "draft-key">

/** The commands that take no flag: every command of the command line but the drafting ones (cli/errors.ts CommandName). */
type PlainCommand = Exclude<CommandName, DraftingCommand>

/** The drafting commands, which the grammar draws alike. */
const draftingCommands: Arr.NonEmptyReadonlyArray<DraftingCommand> = ["generate", "draft-key"]

/** Whether a command is a drafting one. */
const isDrafting = (command: CommandName): command is DraftingCommand =>
	Arr.contains(draftingCommands, command)

/** What generate makes, as the grammar spells it: a draft, named or not, or a custom folder, always named. */
type GrammarMode =
	| { readonly kind: "draft"; readonly name: Option.Option<MigrationName> }
	| { readonly kind: "custom"; readonly name: MigrationName }

/**
 * A command line of the grammar: a plain command, or a drafting command with generate's mode and schema, over a
 * configuration file.
 */
type GrammarLine =
	| { readonly command: PlainCommand; readonly config: string }
	| {
			readonly command: DraftingCommand
			readonly config: string
			readonly mode: GrammarMode
			readonly schema: Option.Option<string>
	  }

/** Whether a line is a drafting command's, with generate's mode and schema. */
const isDraftingLine = (
	line: GrammarLine
): line is Extract<GrammarLine, { readonly mode: GrammarMode }> => isDrafting(line.command)

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

/** Each plain command, keyed by the union itself, so a command the command line adds is a compile error here. */
const plainCommandSet: { readonly [C in PlainCommand]: null } = {
	check: null,
	migrate: null,
	drift: null,
	names: null,
	roles: null,
	uninstall: null
}

const plainCommands: Arr.NonEmptyReadonlyArray<PlainCommand> = nonEmpty(
	Rec.keys(plainCommandSet),
	"the plain commands"
)

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
	upTo(maxMigrationNameLength, () => "a"),
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
		command: source.draw(element(draftingCommands)),
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
		if (!isDraftingLine(line)) {
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

/** A line `lines` draws, its units in any order. */
const spelledOf =
	(lines: Gen<GrammarLine>): Gen<Spelled> =>
	(source) => {
		const line = source.draw(lines)
		const units = source.draw(unitsOf(line))
		return { line, units: source.draw(shuffled(units, { min: units.length, max: units.length })) }
	}

const spelledGen: Gen<Spelled> = spelledOf(lineGen)

/**
 * The grammar's lines, and for a witness while a plain command is pending, a line of that command: half the lines are
 * generate's, so each plain command is a fourteenth of the rest, which a floor of fifty cases misses one time in forty.
 */
export const spelledSpace: Aimed<Spelled, GrammarFeature> = aimed(
	spelledGen,
	Arr.map(
		plainCommands,
		(command) =>
			[
				command,
				spelledOf((source): GrammarLine => ({ command, config: source.draw(configGen) }))
			] as const
	)
)

export const argvOf = (command: string, units: ReadonlyArray<Unit>): ReadonlyArray<string> => [
	command,
	...Arr.flatMap(units, (u) => u.tokens)
]

/** What the parser must read a line of the grammar as. */
export const meaningOf = (line: GrammarLine): CommandLine => {
	if (!isDraftingLine(line)) {
		return { kind: "run", config: line.config, command: { kind: line.command }, phases: false }
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
		command: {
			kind: line.command === "generate" ? "generate" : "draftKey",
			mode,
			schema: line.schema,
			declared: noDeclarations
		},
		phases: false
	}
}

/** What an accepted line reaches. */
export type GrammarFeature =
	| PlainCommand
	| "draft-key"
	| "a draft named after its change"
	| "a draft named by --name"
	| "a custom migration"
	| "--schema"
	| "a flag spelled --flag=value"
	| "a flag spelled --flag value"
	| "the configuration file after a flag"

export const grammarFeatures = [
	...plainCommands,
	"draft-key",
	"a draft named after its change",
	"a draft named by --name",
	"a custom migration",
	"--schema",
	"a flag spelled --flag=value",
	"a flag spelled --flag value",
	"the configuration file after a flag"
] as const satisfies ReadonlyArray<GrammarFeature>

export const grammarNotes = (s: Spelled): ReadonlyArray<GrammarFeature> => {
	const line = s.line
	const flags = Arr.filter(s.units, (u) => u.role === "name" || u.role === "schema")
	return Arr.flatMap(
		[
			...Arr.map(plainCommands, (c) => [c, line.command === c] as const),
			["draft-key", line.command === "draft-key"],
			[
				"a draft named after its change",
				isDraftingLine(line) && line.mode.kind === "draft" && Option.isNone(line.mode.name)
			],
			[
				"a draft named by --name",
				isDraftingLine(line) && line.mode.kind === "draft" && Option.isSome(line.mode.name)
			],
			["a custom migration", isDraftingLine(line) && line.mode.kind === "custom"],
			["--schema", isDraftingLine(line) && Option.isSome(line.schema)],
			["a flag spelled --flag=value", Arr.some(flags, (u) => u.tokens.length === 1)],
			["a flag spelled --flag value", Arr.some(flags, (u) => u.tokens.length === 2)],
			["the configuration file after a flag", s.units[0]?.role !== "config"]
		] satisfies ReadonlyArray<readonly [GrammarFeature, boolean]>,
		([feature, holds]) => (holds ? [feature] : [])
	)
}

/** How a command line fails to parse: as ArgumentsRefused says, or by a --name of no folder name's shape. */
export type FaultKind = ArgumentsRefused["fault"]["kind"] | MigrationNameRefused["_tag"]

export const faultKinds = [
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

/** The commands, the drafting ones and the plain ones. */
const commands: ReadonlyArray<string> = [...draftingCommands, ...plainCommands]

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

/** A token broken by a capital after its leading dashes, a letter no flag is spelled with. */
const brokenOption = (token: string): string => {
	const at = Option.getOrElse(
		Arr.findFirstIndex(Str.split(token, ""), (ch) => ch !== "-"),
		() => token.length
	)
	return `${Str.slice(0, at)(token)}X${Str.slice(at)(token)}`
}

/**
 * An option no command takes: a flag broken once (capitalized, a letter more or less, a dash more or less, a switch
 * given a value), a word after two dashes, a letter after one but the help's, or a lone dash. A drawn token a command
 * does take (a letter more that spells another flag, a word that is one) is broken again by a capital after its dashes,
 * which no flag holds, so every draw is unknown by construction.
 */
const unknownOptionGen: Gen<string> = map(
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
	(token) => (knownOption(token) ? brokenOption(token) : token)
)

/**
 * A word that is no command: a command broken once (capitalized, a letter more or less, two dashes before it), a word
 * of letters, or the empty word. A drawn word that is a command is capitalized, which no command is, so every draw is
 * unknown by construction.
 */
const unknownCommandGen: Gen<string> = map(
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
	(word) => (Arr.contains(commands, word) ? Str.capitalize(word) : word)
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
	if (!isDrafting(command)) {
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

/** How a line asks for the usage: no argument at all, or a line of the grammar or a fault with a help flag anywhere. */
export type HelpFeature = "--help" | "-h" | "no argument"

type Help =
	| { readonly kind: "no argument" }
	| { readonly kind: "--help" | "-h"; readonly argv: ReadonlyArray<string> }

export const helpGen: Gen<Help> = weighted<Help>([
	[1, constant({ kind: "no argument" })],
	[
		8,
		(source) => {
			const argv = source.draw(
				oneOf<ReadonlyArray<string>>([
					map(spelledGen, (s) => argvOf(s.line.command, s.units)),
					(inner) => inner.draw(faultsOf(inner.draw(spelledGen))).argv
				])
			)
			const at = source.draw(int(0, argv.length))
			const flag = source.draw(element(["--help", "-h"] as const))
			return { kind: flag, argv: [...argv.slice(0, at), flag, ...argv.slice(at)] }
		}
	]
])

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

/** The seconds of a chain drafted from nothing, from the epoch, as many as its folders: the command line's own chains. */
const draftedChainGen: Gen<ReadonlyArray<Second>> = map(int(1, 3), (folders) =>
	upTo(folders, (i) => secondAt(i * 1000))
)

/**
 * A committed chain whose last folder is at a second `lastGen` draws, and up to two folders before it, each a second or
 * up to a year before the next, as a chain whose folders the command line once named by its clock holds them.
 */
const chainEndingGen =
	(lastGen: Gen<Second>): Gen<ReadonlyArray<Second>> =>
	(source) => {
		const last = millisOf(source.draw(lastGen))
		const gaps = source.draw(array(oneOf([constant(1), int(2, 366 * 86_400)]), { min: 0, max: 2 }))
		const [, earlier] = Arr.mapAccum(gaps, last, (at, gap) => [at - gap * 1000, at - gap * 1000])
		return [...Arr.map(Arr.reverse(earlier), secondAt), secondAt(last)]
	}

/** A year's last second: the next one rolls the year over, and 9999's names no second of four digits. */
const yearEndGen: Gen<Second> = map(edged(1970, 9999, [9999]), (year) => ({
	year,
	month: 12,
	day: 31,
	hour: 23,
	minute: 59,
	second: 59
}))

interface Stamping {
	/** A second, whose fourteen digits the command line writes and reads back. */
	readonly at: Second
	/** The committed chain's folders' seconds, in chain order, strictly increasing. */
	readonly chain: ReadonlyArray<Second>
	/** Fourteen digits naming no second, which no folder's name holds: read as no timestamp. */
	readonly nonsense: ReadonlyArray<string>
}

/**
 * A second `atGen` draws, beside a committed chain, of no folder, drafted from nothing or ending at any second or at a
 * year's last, a February 29 when `atGen` draws one, and up to two texts naming no second.
 */
const stampingOf =
	(atGen: Gen<Second>): Gen<Stamping> =>
	(source) => {
		const at = source.draw(atGen)
		return {
			at,
			chain: source.draw(
				weighted<ReadonlyArray<Second>>([
					[1, constant([])],
					[1, draftedChainGen],
					[2, chainEndingGen(oneOf([constant(at), secondGen]))],
					[1, chainEndingGen(yearEndGen)]
				])
			),
			nonsense: source.draw(array(nonsenseGen, { min: 0, max: 2 }))
		}
	}

/** A leap year from 1972 to 9996: a year of four, a century's only where it is the fourth, moved back four otherwise. */
const leapYearGen: Gen<number> = map(int(1972 / 4, 9996 / 4), (quarter) =>
	quarter % 25 === 0 && quarter % 100 !== 0 ? 4 * quarter - 4 : 4 * quarter
)

/** A second of a leap day, its time's edges drawn often. */
const leapDayGen: Gen<Second> = (source) => ({
	year: source.draw(leapYearGen),
	month: 2,
	day: 29,
	hour: source.draw(edged(0, 23, [0, 23])),
	minute: source.draw(edged(0, 59, [0, 59])),
	second: source.draw(edged(0, 59, [0, 59]))
})

/** Any second, or, for a witness while February 29 is pending, a second of a leap day. */
export const stampingSpace = aimed(stampingOf(secondGen), [["February 29", stampingOf(leapDayGen)]])

export type StampFeature =
	| "no folder"
	| "a chain drafted from nothing"
	| "a text naming no second"
	| "a day rolled over"
	| "a year rolled over"
	| "a timestamp past year 9999"
	| "February 29"

/**
 * What a new folder's timestamp is by the oracle: the second after the chain's last folder's, by day arithmetic, or the
 * epoch's for a chain of none.
 */
export const nextOf = (s: Stamping, c: Case<StampFeature>): string => {
	const last = Arr.last(s.chain)
	if (Option.isNone(last)) {
		c.note("no folder")
		return digitsOf(secondAt(0))
	}
	if (Arr.every(s.chain, (f, i) => millisOf(f) === i * 1000)) {
		c.note("a chain drafted from nothing")
	}
	const millis = millisOf(last.value)
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

/** A rolePrefixBytes that is no integer from 0 to maxRolePrefixBytes: below it, past it, a fraction, or a text. */
type MalformedBound = "-1" | "past the most" | "a fraction" | "a text"

/** A malformed bound's value, as JavaScript would set it past defineConfig's type. */
const malformedBound: { readonly [M in MalformedBound]: unknown } = {
	"-1": -1,
	"past the most": maxRolePrefixBytes + 1,
	"a fraction": 1.5,
	"a text": "13"
}

/**
 * The role prefix of the connection a configuration without a planted fault gives: none; one exactly as long as its
 * rolePrefixBytes; or one byte longer, which every command that connects refuses.
 */
type ConnectionPrefix = "none" | "at the bound" | "past the bound"

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
			readonly setting:
				| "schemas"
				| "logins"
				| "contracts"
				| "migrations"
				| "rolePrefixBytes"
				| "connection"
	  }
	| { readonly kind: "an empty migrations path" }
	| { readonly kind: "a rolePrefixBytes no bound"; readonly value: MalformedBound }
	| { readonly kind: "a role past the limit under the prefix"; readonly of: number }
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
	/** The bytes of the longest role prefix its installations are under (rolePrefixBytes). */
	readonly rolePrefixBytes: number
	/** The role prefix its connection gives, against rolePrefixBytes. */
	readonly connectionPrefix: ConnectionPrefix
	/** A login planted beside the listed ones whose PostgreSQL role fills 63 bytes exactly under the prefix, over the
	 * schema at this index; none where none is planted. */
	readonly atLimit: Option.Option<number>
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
			map(
				element([
					"schemas",
					"logins",
					"contracts",
					"migrations",
					"rolePrefixBytes",
					"connection"
				] as const),
				(setting) => ({ kind: "a setting left out", setting })
			)
		],
		[1, constant({ kind: "an empty migrations path" })],
		[
			1,
			map(element<MalformedBound>(["-1", "past the most", "a fraction", "a text"]), (value) => ({
				kind: "a rolePrefixBytes no bound",
				value
			}))
		],
		[1, map(schemaAt, (of) => ({ kind: "a role past the limit under the prefix", of }))],
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

/**
 * What a sketch is drawn toward, each left to its draw where absent: its planted fault, drawn from `fault`; and a
 * configuration with no fault whose connection is whole and gives a prefix against the declared one, and maybe plants
 * a login at the limit under it (`connection`).
 */
interface SketchAim {
	readonly fault?: (schemas: number, logins: ReadonlyArray<number>) => Gen<ConfigFault>
	readonly connection?: { readonly prefix: ConnectionPrefix; readonly atLimit: boolean }
}

/** A sketch drawn toward `aim` (SketchAim). */
const sketchOf =
	(aim: SketchAim): Gen<ConfigSketch> =>
	(source) => {
		const names = source.draw(shuffled(schemaNames, { min: 1, max: schemaNames.length }))
		const schemas = Arr.map(names, (name) => ({ name, ...source.draw(entryGen) }))
		const logins = source.draw(
			shuffled(
				upTo(schemas.length, (i) => i),
				{ min: 0, max: schemas.length }
			)
		)
		const connection = aim.connection
		const fault: ConfigFault =
			connection === undefined
				? source.draw((aim.fault ?? configFaultGen)(schemas.length, logins))
				: { kind: "none" }
		/** A role under the prefix exists only where there is one: a planted role's case declares a prefix of a byte at
		 * least, as does one aimed at a connection's prefix. */
		const prefixed =
			fault.kind === "a role past the limit under the prefix" ||
			connection !== undefined ||
			source.draw(boolean)
		const atLimit =
			connection === undefined
				? option(int(0, schemas.length - 1))
				: connection.atLimit
					? map(int(0, schemas.length - 1), Option.some)
					: constant(Option.none<number>())
		return {
			schemas,
			logins,
			migrations: source.draw(
				element<MigrationsForm>(["db", "./db/mig", "nested/dir/", "../up", "absolute"])
			),
			broken: connection === undefined && source.draw(boolean),
			rolePrefixBytes: prefixed ? source.draw(int(1, maxRolePrefixBytes)) : 0,
			connectionPrefix:
				connection?.prefix ??
				source.draw(element<ConnectionPrefix>(["none", "at the bound", "past the bound"])),
			atLimit: prefixed ? source.draw(atLimit) : Option.none(),
			fault
		}
	}

/**
 * The configurations a case draws: any sketch, and one aimed at each situation of the declared role prefix, so the
 * cases that reach them are constructed, never left to a draw.
 */
export const sketchSpace: Aimed<ConfigSketch, ConfigFeature> = aimed(sketchOf({}), [
	[
		"a rolePrefixBytes no bound",
		sketchOf({
			fault: () =>
				map(element<MalformedBound>(["-1", "past the most", "a fraction", "a text"]), (value) => ({
					kind: "a rolePrefixBytes no bound",
					value
				}))
		})
	],
	[
		"a role past the limit under the prefix",
		sketchOf({
			fault: (schemas) =>
				map(int(0, schemas - 1), (of) => ({ kind: "a role past the limit under the prefix", of }))
		})
	],
	[
		"a role at the limit under the prefix",
		sketchOf({ connection: { prefix: "none", atLimit: true } })
	],
	[
		"a connection prefix at the bound",
		sketchOf({ connection: { prefix: "at the bound", atLimit: false } })
	],
	[
		"a connection prefix past the bound",
		sketchOf({ connection: { prefix: "past the bound", atLimit: false } })
	]
])

/** The configuration file every case names, in a directory of the repository. */
export const configFile = `${repoRoot}app/grizzle.config.ts`

/** The migrations directory a form names, from the configuration file's directory. */
export const migrationsOf = (
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

/** The PostgreSQL schema of a configured schema's root, which its logins' stems lead with. */
const identOf = (e: SchemaEntry): string => identifierOf(identity.schema(parsedSchemaName(e.name)))

/**
 * The name of a login over `e` whose PostgreSQL role, `<prefix>__<schema>__<name>`, takes 63 bytes under a prefix of
 * `prefixBytes` bytes, and `past` more: `q`s, its own conversion, so its stem's bytes are the arithmetic's.
 */
const nameUnderPrefix = (e: SchemaEntry, prefixBytes: number, past: number): string =>
	Str.repeat(maxIdentifierBytes - prefixBytes - 2 - utf8Length(identOf(e)) - 2 + past)("q")

/**
 * A login over `e`, with one role of its own name, `role`, named to fill 63 bytes under the prefix, and `past` more
 * (nameUnderPrefix): the login's role is the longest of the two.
 */
const loginUnderPrefix = (e: SchemaEntry, prefixBytes: number, past: number, roleName: string) => {
	const v = built(e)
	return login(v.schema, nameUnderPrefix(e, prefixBytes, past), [
		role(v.schema, roleName, v.schema.relations)
	])
}

/** The stem of the login a sketch plants over `e` under its prefix, `past` bytes past the limit: what a refusal names. */
export const stemUnderPrefix = (s: ConfigSketch, of: number, past: number): string => {
	const e = defined(s.schemas[of], "the planted login's schema")
	return `${identOf(e)}__${nameUnderPrefix(e, s.rolePrefixBytes, past)}`
}

/** The role prefix of the connection a sketch gives, its connection's `rolePrefix`; none for none. */
export const prefixOf = (s: ConfigSketch): Option.Option<string> => {
	switch (s.connectionPrefix) {
		case "none":
			return Option.none()
		case "at the bound":
			return s.rolePrefixBytes === 0
				? Option.none()
				: Option.some(Str.repeat(s.rolePrefixBytes)("p"))
		case "past the bound":
			return Option.some(Str.repeat(s.rolePrefixBytes + 1)("p"))
	}
}

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
export const valueOf = (
	s: ConfigSketch
): { readonly value: unknown; readonly connection: () => MigrationConnectionConfig } => {
	const values = Arr.map(s.schemas, built)
	const at = (i: number) => defined(values[i], "a configured schema")
	const prefixed = Option.match(prefixOf(s), {
		onNone: () => offlineOwner,
		onSome: (rolePrefix) => ({ ...offlineOwner, rolePrefix })
	})
	const connection = (): MigrationConnectionConfig =>
		s.broken ? { ...prefixed, transport: { ...prefixed.transport, port: 70000 } } : prefixed
	const schemas = Arr.map(values, (v) => v.schema)
	const logins = [
		...Arr.map(s.logins, (i) => at(i).server),
		...Arr.map(Option.toArray(s.atLimit), (i) =>
			loginUnderPrefix(
				defined(s.schemas[i], "the planted login's schema"),
				s.rolePrefixBytes,
				0,
				"steward"
			)
		)
	]
	const config = defineConfig({
		contracts: [],
		schemas: [at(0).schema, ...Arr.drop(schemas, 1)],
		logins,
		migrations: migrationsOf(s.migrations).given,
		rolePrefixBytes: s.rolePrefixBytes,
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
		case "a rolePrefixBytes no bound":
			Reflect.set(config, "rolePrefixBytes", malformedBound[f.value])
			return { value: config, connection }
		case "a role past the limit under the prefix": {
			const e = defined(s.schemas[f.of], "the schema of the planted login")
			Reflect.set(config, "logins", [
				...listed(f.of),
				loginUnderPrefix(e, s.rolePrefixBytes, 1, "examiner")
			])
			return { value: config, connection }
		}
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

/** Where a planted fault's login stands in the configuration's logins: the last, after its own schema's login and the
 * login planted at the limit. */
const appendedAt = (s: ConfigSketch, of: number): number =>
	s.logins.length + Option.toArray(s.atLimit).length + (Arr.contains(s.logins, of) ? 0 : 1)

/** The refusal a planted fault must meet: its reason's tag, and the fault and index the reason names. */
interface Expected {
	readonly tag: CliError["reason"]["_tag"]
	readonly fault: string
	readonly index: number | undefined
}

export const expectedOf = (
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
		case "a rolePrefixBytes no bound":
		case "no schema":
			return { tag: "SettingRefused", fault: "malformed", index: undefined }
		case "a role past the limit under the prefix":
			return { tag: "LoginEntryRefused", fault: "roleTooLong", index: appendedAt(s, f.of) }
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
export const namedBy = (e: CliError): Expected => {
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
export const resolvedSchemas = (c: ResolvedConfig) =>
	Arr.map(c.schemas, (x) => ({
		index: x.index,
		declared: x.declared,
		ident: x.ident,
		directory: x.directory,
		logins: Arr.map(x.logins, (l) => l.index)
	}))

export const modelSchemas = (s: ConfigSketch) => {
	const migrations = migrationsOf(s.migrations).resolved
	return Arr.map(s.schemas, (e, index) => {
		const ident = identOf(e)
		return {
			index,
			declared: e.name,
			ident,
			directory: `${migrations}/${ident}`,
			logins: [
				...Arr.flatMap(s.logins, (listed, j) => (listed === index ? [j] : [])),
				...Arr.flatMap(Option.toArray(s.atLimit), (planted) =>
					planted === index ? [s.logins.length] : []
				)
			]
		}
	})
}

export type ConfigFeature =
	| ConfigFaultKind
	| "three schemas"
	| "a schema with no login listed"
	| "a broken connection kept"
	| "a role at the limit under the prefix"
	| "a connection prefix at the bound"
	| "a connection prefix past the bound"

export const configFaultKinds = [
	"not an object",
	"a plain object",
	"an unknown setting",
	"a setting left out",
	"an empty migrations path",
	"a rolePrefixBytes no bound",
	"a role past the limit under the prefix",
	"no schema",
	"a schema entry no schema value",
	"a schema at a second version",
	"a login over an unlisted schema",
	"a login over another version",
	"a login named as a role",
	"a login listed twice",
	"a login entry no login value"
] as const satisfies ReadonlyArray<ConfigFaultKind>

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

/** An object's text of up to three entries, each a configuration's setting or an unknown one, its value `inner`'s. */
const objectTextGen = (inner: Gen<string>): Gen<string> => {
	const setting = weighted<string>([
		[4, element(configSettings)],
		[1, constant("poolSize")]
	])
	const entry: Gen<string> = (source) => `${source.draw(setting)}: ${source.draw(inner)}`
	return map(array(entry, { min: 0, max: 3 }), (entries) => `{ ${Arr.join(entries, ", ")} }`)
}

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
	const objectText = objectTextGen(inner)
	return weighted([
		...scalars,
		[2, map(array(inner, { min: 0, max: 2 }), (items) => `[${Arr.join(items, ", ")}]`)],
		[3, objectText],
		[3, map(objectText, (o) => `defineConfig(${o})`)]
	])
}

/** A module's exports: up to two named values, and the default `defaults` draws. */
const exportsOf =
	(defaults: Gen<Option.Option<string>>): Gen<Exports> =>
	(source) => ({
		named: source.draw(array(valueTextGen(2), { min: 0, max: 2 })),
		default: source.draw(defaults)
	})

/** A module's exports: up to two named values, and a default one or none. */
const exportsGen: Gen<Exports> = exportsOf(option(valueTextGen(2)))

/** A file whose import fails by the failure `failure` draws. */
const importFailsGen =
	(failure: Gen<ImportFailure>): Gen<Loading> =>
	(source) => ({
		kind: "a file whose import fails",
		failure: source.draw(failure),
		exports: source.draw(exportsGen)
	})

/** A file that loads, its exports `exports` draws. */
const loadsGen =
	(exports: Gen<Exports>): Gen<Loading> =>
	(source) => ({ kind: "a file that loads", exports: source.draw(exports) })

const noFileGen = constant<Loading>({ kind: "no file named" })

const absentGen = constant<Loading>({ kind: "a file that does not exist" })

const failureGen = weighted<ImportFailure>([
	[1, constant("a throw")],
	[1, constant("a syntax error")],
	[1, constant("a missing import")],
	[1, constant("a rejected await")]
])

const loadingGen: Gen<Loading> = weighted<Loading>([
	[1, noFileGen],
	[1, absentGen],
	[2, importFailsGen(failureGen)],
	[4, loadsGen(exportsGen)]
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
export const loadingFile = (ws: string, loading: Loading) => {
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
export const statusOf = (loading: Loading): 1 | 2 => (loading.kind === "no file named" ? 2 : 1)

export type LoadingFeature =
	| Loading["kind"]
	| ImportFailure
	| "no default export"
	| "a default built by defineConfig"
	| "a default defineConfig did not build"

/** What a loading reached. */
export const loadingNotes = (loading: Loading): ReadonlyArray<LoadingFeature> => {
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

/**
 * The loadings a case runs: a drawn one, or, for a witness while a situation is pending, one constructed to reach it:
 * each kind of loading, each way an import fails, and a loaded module with no default, a default defineConfig built,
 * and one it did not.
 */
export const loadingSpace = aimed(loadingGen, [
	["no file named", noFileGen],
	["a file that does not exist", absentGen],
	["a file whose import fails", importFailsGen(failureGen)],
	["a file that loads", loadsGen(exportsGen)],
	["a throw", importFailsGen(constant("a throw"))],
	["a syntax error", importFailsGen(constant("a syntax error"))],
	["a missing import", importFailsGen(constant("a missing import"))],
	["a rejected await", importFailsGen(constant("a rejected await"))],
	["no default export", loadsGen(exportsOf(constant(Option.none())))],
	[
		"a default built by defineConfig",
		loadsGen(
			exportsOf(map(objectTextGen(valueTextGen(1)), (o) => Option.some(`defineConfig(${o})`)))
		)
	],
	[
		"a default defineConfig did not build",
		loadsGen(exportsOf(map(objectTextGen(valueTextGen(1)), Option.some)))
	]
])

/** A fault injected into a drawn line of the grammar. */
export const faultGen: Gen<Fault> = (source) => source.draw(faultsOf(source.draw(spelledGen)))
