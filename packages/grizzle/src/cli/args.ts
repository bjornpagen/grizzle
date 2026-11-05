import { Array as Arr, Option, Result, String as Str } from "effect"
import {
	ArgumentsRefused,
	type CliError,
	type CommandName,
	cliError,
	generateFlags,
	MigrationNameRefused,
	type SwitchFlag,
	type ValuedFlag
} from "#cli/errors.ts"
import {
	type FolderNaming,
	type MigrationName,
	maxMigrationNameLength,
	parseMigrationName
} from "#compiler/deploy/render/folder.ts"

/**
 * The command line of the `grizzle` bin.
 *
 * Exactly these commands exist, each over the configuration file its one argument names:
 *
 *     grizzle generate <config> [--name <name>] [--schema <schema>]
 *     grizzle generate <config> --custom --name <name> [--schema <schema>]
 *     grizzle check <config>
 *     grizzle migrate <config>
 *     grizzle drift <config>
 *     grizzle names <config>
 *
 * `<config>` is the configuration file, absolute or relative to the directory grizzle runs in; no command reads one it
 * does not name. `--name` names the migration folder, parsed here into a MigrationName, so a name of no folder name's
 * shape is refused here and never reaches the compiler (folder.ts parseMigrationName): without it a drafted folder is
 * named after its change, and a custom one needs it.
 * `--schema` chooses one configured schema, by its declared name or its PostgreSQL schema identifier; it is accepted
 * only when the configuration declares several, and `--custom` needs it there (generate.ts). Flags follow drizzle's
 * spelling, as `--flag value` or `--flag=value`, anywhere after the command, and only generate takes any. `--help` (or
 * `-h`, anywhere, or no argument) prints the usage. Anything else is a usage error.
 *
 * What generate makes: the next migration drafted from the schemas' change, named `--name` or after the change; or an
 * empty custom folder for data steps, named `--name`.
 */
export type GenerateMode =
	| { readonly kind: "draft"; readonly naming: FolderNaming }
	| { readonly kind: "custom"; readonly name: MigrationName }

/** What a command does with the configuration it reads. */
type Command =
	| {
			readonly kind: "generate"
			readonly mode: GenerateMode
			/**
			 * `--schema`: a declared schema name or PostgreSQL schema identifier, or none for every configured one.
			 */
			readonly schema: Option.Option<string>
	  }
	| { readonly kind: "check" }
	| { readonly kind: "migrate" }
	| { readonly kind: "drift" }
	| { readonly kind: "names" }

/** A command line: the usage, or a command over the configuration file it names, as given. */
export type CommandLine =
	| { readonly kind: "help" }
	| { readonly kind: "run"; readonly config: string; readonly command: Command }

export const usageText = `Usage:
  grizzle generate <config> [--name <name>] [--schema <schema>]
      draft the next migration from the schemas' changes
  grizzle generate <config> --custom --name <name> [--schema <schema>]
      an empty migration for data steps
  grizzle check <config>
      generated, resolved and untampered? (offline)
  grizzle migrate <config>
      apply pending migrations
  grizzle drift <config>
      does the database match the snapshot? (applies nothing)
  grizzle names <config>
      each hashed object's PostgreSQL name and what it is

<config> is the configuration file, whose default export is defineConfig({ ... }): an absolute path, or
one relative to the directory grizzle runs in. migrate and drift connect with the configuration's
connection only.

Options of generate, as --flag value or --flag=value, anywhere after the command:
  --custom          an empty folder for data steps, named by --name
  --name <name>     the folder's name: lowercase words joined by _ or -, at most ${maxMigrationNameLength.value} characters;
                    without it a drafted folder is named after its change
  --schema <name>   only this configured schema (its declared name or PostgreSQL schema);
                    accepted only when the configuration declares several schemas, and required
                    there with --custom
`

const isHelp = (arg: string): boolean => arg === "--help" || arg === "-h"

/** The refusal of a command line that does not parse, for `fault`. */
const malformed = (fault: ArgumentsRefused["fault"]): Result.Result<never, CliError> =>
	Result.fail(cliError(new ArgumentsRefused({ fault })))

/** The flags a command takes: switches, and flags that take a value. */
interface Flags {
	readonly switches: ReadonlyArray<SwitchFlag>
	readonly valued: ReadonlyArray<ValuedFlag>
}

const noFlags: Flags = { switches: [], valued: [] }

/** A command's arguments as they read: its configuration file, and the flags it was given. */
interface Scanned {
	readonly config: string
	readonly switches: ReadonlySet<SwitchFlag>
	readonly values: ReadonlyMap<ValuedFlag, string>
}

/** The arguments after `command`, which takes `flags`: exactly one configuration file, and each flag at most once. */
const scan = (
	command: CommandName,
	rest: ReadonlyArray<string>,
	flags: Flags
): Result.Result<Scanned, CliError> => {
	let config = Option.none<string>()
	const switches = new Set<SwitchFlag>()
	const values = new Map<ValuedFlag, string>()
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		if (arg === undefined) {
			break
		}
		if (!Str.startsWith("-")(arg)) {
			if (Option.isSome(config)) {
				return malformed({ kind: "unexpectedArgument", command, argument: arg })
			}
			if (arg.length === 0) {
				return malformed({ kind: "noConfig", command })
			}
			config = Option.some(arg)
			continue
		}
		const switched = Arr.findFirst(flags.switches, (f) => arg === `--${f}`)
		if (Option.isSome(switched)) {
			if (switches.has(switched.value)) {
				return malformed({ kind: "repeatedFlag", flag: switched.value })
			}
			switches.add(switched.value)
			continue
		}
		const valued = Arr.findFirst(
			flags.valued,
			(f) => arg === `--${f}` || Str.startsWith(`--${f}=`)(arg)
		)
		if (Option.isNone(valued)) {
			return malformed({ kind: "unknownOption", command, option: arg })
		}
		const flag = valued.value
		if (values.has(flag)) {
			return malformed({ kind: "repeatedFlag", flag })
		}
		const value = arg === `--${flag}` ? rest[++i] : Str.slice(`--${flag}=`.length)(arg)
		if (value === undefined || value.length === 0 || Str.startsWith("-")(value)) {
			return malformed({ kind: "flagWithoutValue", flag })
		}
		values.set(flag, value)
	}
	return Option.match(config, {
		onNone: () => malformed({ kind: "noConfig", command }),
		onSome: (file) => Result.succeed({ config: file, switches, values })
	})
}

/**
 * What generate makes, by `--custom` and `--name`: a draft named after its change, a draft or custom folder named by a
 * name of a folder name's shape, or the refusal of a custom folder without a name or of a name of no folder's shape.
 */
const modeOf = (scanned: Scanned): Result.Result<GenerateMode, CliError> => {
	const custom = scanned.switches.has("custom")
	const name = scanned.values.get("name")
	if (name === undefined) {
		return custom
			? malformed({ kind: "unnamedCustom" })
			: Result.succeed({ kind: "draft", naming: { kind: "derived" } })
	}
	const parsed = parseMigrationName(name)
	if (parsed === undefined) {
		return Result.fail(cliError(new MigrationNameRefused({ migration: name })))
	}
	return Result.succeed(
		custom
			? { kind: "custom", name: parsed }
			: { kind: "draft", naming: { kind: "named", name: parsed } }
	)
}

const parseGenerate = (rest: ReadonlyArray<string>): Result.Result<CommandLine, CliError> =>
	Result.flatMap(scan("generate", rest, generateFlags), (scanned) =>
		Result.map(modeOf(scanned), (mode): CommandLine => ({
			kind: "run",
			config: scanned.config,
			command: {
				kind: "generate",
				mode,
				schema: Option.fromUndefinedOr(scanned.values.get("schema"))
			}
		}))
	)

const parsePlain = (
	command: Exclude<CommandName, "generate">,
	rest: ReadonlyArray<string>
): Result.Result<CommandLine, CliError> =>
	Result.map(scan(command, rest, noFlags), (scanned): CommandLine => ({
		kind: "run",
		config: scanned.config,
		command: { kind: command }
	}))

export const parseArgs = (argv: ReadonlyArray<string>): Result.Result<CommandLine, CliError> => {
	const [command, ...rest] = argv
	if (command === undefined || Arr.some(argv, isHelp)) {
		return Result.succeed({ kind: "help" })
	}
	switch (command) {
		case "check":
		case "migrate":
		case "drift":
		case "names":
			return parsePlain(command, rest)
		case "generate":
			return parseGenerate(rest)
		default:
			return malformed({ kind: "unknownCommand", command })
	}
}
