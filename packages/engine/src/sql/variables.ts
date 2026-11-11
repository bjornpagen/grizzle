import { installedRole, isConversion, type RoleSpace } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import { type Lexeme, lexemesOf } from "#compiler/sql/lexer.ts"
import { databaseVariable, quoteIdent } from "#compiler/sql/print.ts"

/**
 * The variables of a drafted statement, and their filling.
 *
 * A statement names what an installation decides, never what it is called there, by psql's identifier variables,
 * `:"<name>"`: each role of the installation by its stem (sql/print.ts printRole), which `grizzle generate` commits, and
 * the current database by `:"DBNAME"` (printDatabase). `grizzle migrate` fills each with what its installation names it
 * (resolveVariables) before it sends the statement, so one drafted file installs into every database under every role
 * space, and a statement sent unfilled is a syntax error, never another role.
 *
 * A variable is read as psql reads one, among the statement's lexemes (sql/lexer.ts lexemesOf): a `:` the next lexeme,
 * a quoted identifier, starts right after. `::` and `:=` are lexemes of their own, and a quote, a dollar-quoted body
 * and a comment are each one lexeme, so a variable is never read inside one.
 */

/** What a variable stands for: the current database, or a role of the installation by its stem. */
export type Variable =
	| { readonly kind: "database" }
	| { readonly kind: "role"; readonly stem: string }

/** What an installation fills a statement's variables with: its database, its connection's, and its role space. */
export interface InstallationNames {
	readonly database: string
	readonly roles: RoleSpace
}

/**
 * A variable no installation fills: one whose name is neither DBNAME nor a role stem, or a role its installation's
 * role space would name past PostgreSQL's longest identifier, which it would truncate into another role's name.
 */
export type VariableFault =
	| { readonly kind: "unknownVariable"; readonly name: string }
	| {
			readonly kind: "roleTooLong"
			readonly stem: string
			readonly role: string
			readonly limit: number
	  }

/**
 * What a variable's name stands for: DBNAME the database; a role stem, `<schema>__<name>`, two conversions joined by
 * `__` (core/identity.ts identity.login and identity.role), a role; any other name nothing.
 */
export const variableOf = (name: string): Variable | undefined => {
	if (name === databaseVariable) {
		return { kind: "database" }
	}
	const at = name.indexOf("__")
	return at > 0 && isConversion(name.slice(0, at)) && isConversion(name.slice(at + 2))
		? { kind: "role", stem: name }
		: undefined
}

/** The identifier `variable` is filled with under `names`, quoted, or why none is. */
const filled = (name: string, names: InstallationNames): Result.Result<string, VariableFault> => {
	const variable = variableOf(name)
	if (variable === undefined) {
		return Result.err({ kind: "unknownVariable", name })
	}
	if (variable.kind === "database") {
		return Result.ok(quoteIdent(names.database))
	}
	return Result.mapError(
		Result.map(installedRole(names.roles, variable.stem), quoteIdent),
		(tooLong): VariableFault => ({ kind: "roleTooLong", stem: variable.stem, ...tooLong })
	)
}

/** The end of a quoted identifier lexeme starting at `start` whose name is `name`: its two quotes, and each quote of
 * the name doubled. */
const quotedEnd = (start: number, name: string): number =>
	start + 2 + name.length + name.split('"').length - 1

/** A variable among `lexemes`: the `:` at `i` and the quoted identifier right after it. */
const variableAt = (
	lexemes: ReadonlyArray<Lexeme>,
	i: number
): { readonly start: number; readonly end: number; readonly name: string } | undefined => {
	const colon = lexemes[i]
	const name = lexemes[i + 1]
	return colon?.kind === "punct" &&
		colon.text === ":" &&
		name?.kind === "quotedIdent" &&
		name.start === colon.start + 1
		? { start: colon.start, end: quotedEnd(name.start, name.text), name: name.text }
		: undefined
}

/**
 * `statement` with each variable filled under `names`, every other character as written, or the first variable none
 * fills. Under the stems role space each role variable is its stem quoted, the statement as the printer spelled it
 * before roles were variables.
 */
export const resolveVariables = (
	statement: string,
	names: InstallationNames
): Result.Result<string, VariableFault> => {
	const { lexemes } = lexemesOf(statement)
	let out = ""
	let from = 0
	for (let i = 0; i < lexemes.length; i++) {
		const found = variableAt(lexemes, i)
		if (found === undefined) {
			continue
		}
		const value = filled(found.name, names)
		if (!value.ok) {
			return value
		}
		out += statement.slice(from, found.start) + value.value
		from = found.end
		i += 1
	}
	return Result.ok(out + statement.slice(from))
}
