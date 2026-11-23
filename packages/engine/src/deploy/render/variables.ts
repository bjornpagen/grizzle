import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	roleInSpace,
	roleNameForm,
	type RoleNameForm,
	type RoleSpace
} from "#compiler/core/identity.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { type Lexeme, lexemesOf } from "#compiler/sql/lexer.ts"
import { databaseVariable } from "#compiler/sql/print.ts"

/**
 * The variables of a drafted statement, and their filling.
 *
 * A statement names what an installation decides, never what it is called there, by psql's variables: each role of the
 * installation by the name the naming door mints it under (sql/print.ts printRole), its stem, the name a migration sets
 * it aside under while it renames logins, or its live source's decoder login's (core/identity.ts RoleNameForm), which
 * `grizzle generate` commits, and the current database by `DBNAME` (printDatabase). A variable is spelled as an
 * identifier, `:"<name>"`, where the statement names the object, or as a literal, `:'<name>'`, where it reads the
 * object's name as a value (sql/print.ts printRoleName). `grizzle migrate` fills each with what its installation names
 * it (resolveVariables), quoted as its spelling quotes it, before it sends the statement, so one drafted file installs
 * into every database under every role space, and a statement sent unfilled is a syntax error, never another role.
 *
 * A variable is read as psql reads one, among the statement's lexemes (sql/lexer.ts lexemesOf): a `:` the next lexeme,
 * a quoted identifier or a string constant of no prefix, starts right after. `::` and `:=` are lexemes of their own,
 * and a quote, a dollar-quoted body and a comment are each one lexeme, so a variable is never read inside one.
 */

/** What a variable stands for: the current database, or a role of the installation by its name in one of its forms. */
export type Variable =
	| { readonly kind: "database" }
	| { readonly kind: "role"; readonly name: string; readonly form: RoleNameForm }

/** What an installation fills a statement's variables with: its database, its connection's, and its role space. */
export interface InstallationNames {
	readonly database: string
	readonly roles: RoleSpace
}

/**
 * A variable no installation fills: one whose name is neither DBNAME nor a role's name in a form of RoleNameForm, or a
 * role its installation's role space would name past PostgreSQL's longest identifier, which it would truncate into
 * another role's name.
 */
export type VariableFault =
	| { readonly kind: "unknownVariable"; readonly name: string }
	| {
			readonly kind: "roleTooLong"
			readonly name: string
			readonly role: string
			readonly bytes: number
			readonly limit: number
	  }

/**
 * What a variable's name stands for: DBNAME the database; a role's name in one of its forms (core/identity.ts
 * roleNameForm), a role; any other name nothing.
 */
export const variableOf = (name: string): Variable | undefined => {
	if (name === databaseVariable) {
		return { kind: "database" }
	}
	const form = roleNameForm(name)
	return form === undefined ? undefined : { kind: "role", name, form }
}

/** How a statement spells a variable: `:"<name>"`, filled as a quoted identifier, or `:'<name>'`, as a quoted literal. */
type Spelling = "identifier" | "literal"

const quotedAs: { readonly [S in Spelling]: (value: string) => string } = {
	identifier: quoteIdent,
	literal: quoteString
}

/** What the variable `name` spelled as `spelling` is filled with under `names`, quoted, or why nothing is. */
const filled = (
	name: string,
	spelling: Spelling,
	names: InstallationNames
): Result.Result<string, VariableFault> => {
	const variable = variableOf(name)
	if (variable === undefined) {
		return Result.err({ kind: "unknownVariable", name })
	}
	const quote = quotedAs[spelling]
	if (variable.kind === "database") {
		return Result.ok(quote(names.database))
	}
	return Result.mapError(
		Result.map(roleInSpace(names.roles, variable.name), quote),
		(tooLong): VariableFault => ({ kind: "roleTooLong", name: variable.name, ...tooLong })
	)
}

/** The end of a quoted identifier lexeme starting at `start` whose name is `name`: its two quotes, and each quote of
 * the name doubled. */
const quotedEnd = (start: number, name: string): number =>
	start + 2 + name.length + name.split('"').length - 1

/** A variable among `lexemes`: the `:` at `i` and the quoted identifier or plain string constant right after it. */
const variableAt = (
	lexemes: ReadonlyArray<Lexeme>,
	i: number
):
	| {
			readonly start: number
			readonly end: number
			readonly name: string
			readonly spelling: Spelling
	  }
	| undefined => {
	const colon = lexemes[i]
	const name = lexemes[i + 1]
	if (colon?.kind !== "punct" || colon.text !== ":" || name?.start !== colon.start + 1) {
		return undefined
	}
	if (name.kind === "quotedIdent") {
		return {
			start: colon.start,
			end: quotedEnd(name.start, name.text),
			name: name.text,
			spelling: "identifier"
		}
	}
	return name.kind === "string" && name.prefix === undefined
		? { start: colon.start, end: name.end, name: name.text, spelling: "literal" }
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
		const value = filled(found.name, found.spelling, names)
		if (!value.ok) {
			return value
		}
		out += statement.slice(from, found.start) + value.value
		from = found.end
		i += 1
	}
	return Result.ok(out + statement.slice(from))
}
