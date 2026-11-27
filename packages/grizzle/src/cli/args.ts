import { Array as Arr, Option, Result, String as Str } from "effect"
import {
	ArgumentsRefused,
	type CliError,
	type CommandName,
	cliError,
	generateFlags,
	MigrationNameRefused,
	type RepeatedFlag,
	type SwitchFlag,
	type ValuedFlag
} from "#cli/errors.ts"
import { DeclarationRefused, parseDeclarations } from "#cli/renames.ts"
import { helpAsked } from "#cli/usage.ts"
import {
	type Declarations,
	type FolderNaming,
	type MigrationName,
	noDeclarations,
	parseMigrationName
} from "#compiler/plan/migration.ts"

/**
 * The command line of the `grizzle` bin.
 *
 * Exactly these commands exist, each over the configuration file its one argument names:
 *
 *     grizzle generate <config> [--name <name>] [--schema <schema>] [--rename <old>=<new>]… [--drop <old>]… [--phases]
 *     grizzle generate <config> --custom --name <name> [--schema <schema>] [--phases]
 *     grizzle draft-key <config> [generate's flags]
 *     grizzle check <config> [--phases]
 *     grizzle migrate <config>
 *     grizzle drift <config>
 *     grizzle names <config>
 *     grizzle roles <config>
 *     grizzle uninstall <config>
 *
 * `<config>` is the configuration file, absolute or relative to the directory grizzle runs in; no command reads one it
 * does not name. `--name` names the migration folder, parsed here into a MigrationName, so a name of no folder name's
 * shape is refused here and never reaches the compiler (folder.ts parseMigrationName): without it a drafted folder is
 * named after its change, and a custom one needs it.
 * `--schema` chooses one configured schema, by its declared name or its PostgreSQL schema identifier; it is accepted
 * only when the configuration declares several, and `--custom` and a declaration need it there (generate.ts).
 * `--rename <old>=<new>` and `--drop <old>`, each given once per name, declare the draft's renames and drops, read here
 * (renames.ts), so a declaration its text shows wrong never reaches the compiler; a custom migration drafts nothing
 * and takes none. `--phases` reports each phase of the run on stderr as it starts and ends, with the process's
 * readings (phases.ts), and changes nothing else the command writes or prints. Flags follow drizzle's spelling, as
 * `--flag value` or `--flag=value`, anywhere after the command, and only generate and draft-key, which takes exactly
 * generate's, take any but `--phases`, which check takes too. `--help` (or `-h`, anywhere, or no argument) prints the
 * usage. Anything else is a usage error.
 *
 * What generate makes: the next migration drafted from the schemas' change, named `--name` or after the change; or an
 * empty custom folder for data steps, named `--name`.
 */
export type GenerateMode =
	| { readonly kind: "draft"; readonly naming: FolderNaming }
	| { readonly kind: "custom"; readonly name: MigrationName }

/**
 * What generate's flags ask it to draft, but `--phases`: what it makes, the schema it drafts, and the declared renames
 * and drops; `grizzle draft-key` takes the same flags, and digests the inputs of the draft they ask for
 * (draft-inputs.ts).
 */
export interface DraftRequest {
	readonly mode: GenerateMode
	/** `--schema`: a declared schema name or PostgreSQL schema identifier, or none for every configured one. */
	readonly schema: Option.Option<string>
	/** `--rename` and `--drop`: the draft's declared renames and drops, none for a custom migration. */
	readonly declared: Declarations
}

/** What a command does with the configuration it reads. */
type Command =
	| ({ readonly kind: "generate" } & DraftRequest)
	| ({ readonly kind: "draftKey" } & DraftRequest)
	| { readonly kind: "check" }
	| { readonly kind: "migrate" }
	| { readonly kind: "drift" }
	| { readonly kind: "names" }
	| { readonly kind: "roles" }
	| { readonly kind: "uninstall" }

/**
 * A command line: the usage, or a command over the configuration file it names, as given, and whether its phases are
 * reported (`--phases`, which only generate and check take).
 */
export type CommandLine =
	| { readonly kind: "help" }
	| {
			readonly kind: "run"
			readonly config: string
			readonly command: Command
			readonly phases: boolean
	  }

/** The refusal of a command line that does not parse, for `fault`. */
const malformed = (fault: ArgumentsRefused["fault"]): Result.Result<never, CliError> =>
	Result.fail(cliError(new ArgumentsRefused({ fault })))

/** The flags a command takes: switches, flags that take a value once, and flags that take one each time. */
interface Flags {
	readonly switches: ReadonlyArray<SwitchFlag>
	readonly valued: ReadonlyArray<ValuedFlag>
	readonly repeated: ReadonlyArray<RepeatedFlag>
}

const noFlags: Flags = { switches: [], valued: [], repeated: [] }

/** The flags of `grizzle check`: `--phases` alone. */
const checkFlags: Flags = { switches: ["phases"], valued: [], repeated: [] }

/**
 * A command's arguments as they read: its configuration file, and the flags it was given, a repeated flag's values in
 * the order given.
 */
interface Scanned {
	readonly config: string
	readonly switches: ReadonlySet<SwitchFlag>
	readonly values: ReadonlyMap<ValuedFlag, string>
	readonly repeated: ReadonlyMap<RepeatedFlag, ReadonlyArray<string>>
}

/**
 * The arguments after `command`, which takes `flags`: exactly one configuration file, each switch and valued flag at
 * most once, and a repeated flag as often as it is given.
 */
const scan = (
	command: CommandName,
	rest: ReadonlyArray<string>,
	flags: Flags
): Result.Result<Scanned, CliError> => {
	let config = Option.none<string>()
	const switches = new Set<SwitchFlag>()
	const values = new Map<ValuedFlag, string>()
	const repeated = new Map<RepeatedFlag, Array<string>>()
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
		const again = Arr.findFirst(
			flags.repeated,
			(f) => arg === `--${f}` || Str.startsWith(`--${f}=`)(arg)
		)
		if (Option.isSome(again)) {
			const flag = again.value
			const value = arg === `--${flag}` ? rest[++i] : Str.slice(`--${flag}=`.length)(arg)
			if (value === undefined || value.length === 0 || Str.startsWith("-")(value)) {
				return malformed({ kind: "flagWithoutValue", flag })
			}
			const given = repeated.getOrInsertComputed(flag, () => [])
			given.push(value)
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
		onSome: (file) => Result.succeed({ config: file, switches, values, repeated })
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

/**
 * The declarations `--rename` and `--drop` give, read (renames.ts parseDeclarations): none when neither is given, and
 * the refusal of either beside `--custom`, whose folder drafts nothing.
 */
const declaredOf = (
	scanned: Scanned,
	mode: GenerateMode
): Result.Result<Declarations, CliError> => {
	const renames = scanned.repeated.get("rename") ?? []
	const drops = scanned.repeated.get("drop") ?? []
	if (renames.length === 0 && drops.length === 0) {
		return Result.succeed(noDeclarations)
	}
	if (mode.kind === "custom") {
		return Result.fail(cliError(new DeclarationRefused({ fault: { kind: "custom" } })))
	}
	return Result.mapError(parseDeclarations(renames, drops), cliError)
}

/** A command that drafts, generate or draft-key, over the request generate's flags make (DraftRequest). */
const parseDrafting = (
	command: "generate" | "draft-key",
	rest: ReadonlyArray<string>
): Result.Result<CommandLine, CliError> =>
	Result.flatMap(scan(command, rest, generateFlags), (scanned) =>
		Result.flatMap(modeOf(scanned), (mode) =>
			Result.map(declaredOf(scanned, mode), (declared): CommandLine => ({
				kind: "run",
				config: scanned.config,
				command: {
					kind: command === "generate" ? "generate" : "draftKey",
					mode,
					schema: Option.fromUndefinedOr(scanned.values.get("schema")),
					declared
				},
				phases: scanned.switches.has("phases")
			}))
		)
	)

const parsePlain = (
	command: Exclude<CommandName, "generate" | "draft-key">,
	rest: ReadonlyArray<string>
): Result.Result<CommandLine, CliError> =>
	Result.map(
		scan(command, rest, command === "check" ? checkFlags : noFlags),
		(scanned): CommandLine => ({
			kind: "run",
			config: scanned.config,
			command: { kind: command },
			phases: scanned.switches.has("phases")
		})
	)

export const parseArgs = (argv: ReadonlyArray<string>): Result.Result<CommandLine, CliError> => {
	const [command, ...rest] = argv
	if (command === undefined || helpAsked(argv)) {
		return Result.succeed({ kind: "help" })
	}
	switch (command) {
		case "check":
		case "migrate":
		case "drift":
		case "names":
		case "roles":
		case "uninstall":
			return parsePlain(command, rest)
		case "generate":
		case "draft-key":
			return parseDrafting(command, rest)
		default:
			return malformed({ kind: "unknownCommand", command })
	}
}
