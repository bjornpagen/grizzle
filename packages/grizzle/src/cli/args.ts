import { Array as Arr, Option, Result, String as Str } from "effect"
import { ArgumentsRefused, type CliError, cliError } from "#cli/errors.ts"
import type { FolderNaming } from "#compiler/deploy/render/folder.ts"

/** A drafted folder's naming, from the `--name` flag when it is given. */
const namingOf = (name: Option.Option<string>): FolderNaming =>
	Option.isSome(name) ? { kind: "named", name: name.value } : { kind: "derived" }

/**
 * The command line of the `grizzle` bin.
 *
 * Exactly these commands exist:
 *
 *     grizzle generate [--name <name>] [--schema <schema>]
 *     grizzle generate --custom [--name <name>] [--schema <schema>]
 *     grizzle check
 *     grizzle migrate
 *     grizzle drift
 *     grizzle skill
 *
 * `--name` names the migration folder; without it a drafted folder is named after its change and a custom one
 * `custom`. `--schema` chooses one configured schema, by its declared name or its PostgreSQL schema identifier; it is
 * accepted only when grizzle.config.ts declares several, and `--custom` needs it there (generate.ts). Flags follow
 * drizzle's spelling, as `--flag value` or `--flag=value`, anywhere after the command. `--help` (or `-h`, or no
 * argument) prints the usage. Anything else is a usage error.
 *
 * What generate makes: the next migration drafted from the schemas' change, named `--name` or after the change; or an
 * empty custom folder for data steps, named `--name` or `custom`.
 */
export type GenerateMode =
	| { readonly kind: "draft"; readonly naming: FolderNaming }
	| { readonly kind: "custom"; readonly name: string }

type Command =
	| { readonly kind: "help" }
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
	| { readonly kind: "skill" }

export const usageText = `Usage:
  grizzle generate [--name <name>] [--schema <schema>]            draft the next migration from the schemas' changes
  grizzle generate --custom [--name <name>] [--schema <schema>]   an empty migration for data steps
  grizzle check                                                   generated, resolved and untampered? (offline)
  grizzle migrate                                                 apply pending migrations
  grizzle drift                                                   does the database match the snapshot? (applies nothing)
  grizzle names                                                   each hashed object's PostgreSQL name and what it is
  grizzle skill                                                   install the agent skill

Options of generate:
  --name <name>     the folder's name: lowercase words joined by _ or -, at most 100 characters; by default derived
                    from the change, or custom for --custom
  --schema <name>   only this configured schema (its declared name or PostgreSQL schema); accepted only when
                    grizzle.config.ts declares several schemas, and required there with --custom

grizzle reads grizzle.config.ts in the current directory. grizzle migrate and grizzle drift connect with
DATABASE_URL unless the configuration names a connection.
`

const isHelp = (arg: string): boolean => arg === "--help" || arg === "-h"

/** The refusal of a command line that does not parse, for `fault`. */
const malformed = (fault: ArgumentsRefused["fault"]): Result.Result<Command, CliError> =>
	Result.fail(cliError(ArgumentsRefused.make({ fault })))

const plain = (
	rest: ReadonlyArray<string>,
	kind: "check" | "migrate" | "drift" | "names" | "skill"
) => {
	const [extra] = rest
	if (extra !== undefined) {
		return malformed({ kind: "unexpectedArgument", command: kind, argument: extra })
	}
	return Result.succeed({ kind })
}

export const parseArgs = (argv: ReadonlyArray<string>): Result.Result<Command, CliError> => {
	const [command, ...rest] = argv
	if (command === undefined || Arr.some(argv, isHelp)) {
		return Result.succeed({ kind: "help" })
	}
	switch (command) {
		case "check":
		case "migrate":
		case "drift":
		case "names":
		case "skill":
			return plain(rest, command)
		case "generate":
			return parseGenerate(rest)
		default:
			return malformed({ kind: "unknownCommand", command })
	}
}

const parseGenerate = (rest: ReadonlyArray<string>): Result.Result<Command, CliError> => {
	let custom = false
	const values = new Map<"name" | "schema", string>()
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		if (arg === undefined) {
			break
		}
		if (arg === "--custom") {
			if (custom) {
				return malformed({ kind: "repeatedFlag", flag: "custom" })
			}
			custom = true
			continue
		}
		const valued = Arr.findFirst(
			["name", "schema"] as const,
			(f) => arg === `--${f}` || Str.startsWith(`--${f}=`)(arg)
		)
		if (Option.isSome(valued)) {
			const flag = valued.value
			if (values.has(flag)) {
				return malformed({ kind: "repeatedFlag", flag })
			}
			const value = arg === `--${flag}` ? rest[++i] : Str.slice(`--${flag}=`.length)(arg)
			if (value === undefined || value.length === 0 || Str.startsWith("-")(value)) {
				return malformed({ kind: "flagWithoutValue", flag })
			}
			values.set(flag, value)
			continue
		}
		if (Str.startsWith("-")(arg)) {
			return malformed({ kind: "unknownOption", option: arg })
		}
		return malformed({ kind: "unexpectedArgument", command: "generate", argument: arg })
	}
	const name = Option.fromUndefinedOr(values.get("name"))
	return Result.succeed({
		kind: "generate",
		mode: custom
			? { kind: "custom", name: Option.getOrElse(name, () => "custom") }
			: { kind: "draft", naming: namingOf(name) },
		schema: Option.fromUndefinedOr(values.get("schema"))
	})
}
