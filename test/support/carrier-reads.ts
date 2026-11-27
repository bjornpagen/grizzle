import { String as Str } from "effect"
import type { Expr, SqlStatement } from "#compiler/sql/ast.ts"
import { settingCarrier } from "#compiler/sql/carriers.ts"
import { lexemesOf } from "#compiler/sql/lexer.ts"
import type { CarrierName } from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

/**
 * The carriers a statement names through the calls of `fn`, by name: each call's first argument a literal text, a
 * carrier's setting (write/carriers/carriers.ts carrierSetting).
 */
const namedThrough = (
	statement: SqlStatement,
	fn: "current_setting" | "set_config"
): ReadonlySet<CarrierName> => {
	const named = new Set<CarrierName>()
	const note = (e: Expr): Expr => {
		if (e.kind === "call" && e.fn.kind === "builtin" && e.fn.name === fn) {
			const [setting] = e.args
			const carrier =
				setting?.kind === "literal" && setting.value.kind === "text"
					? settingCarrier(setting.value.value)
					: undefined
			if (carrier !== undefined) {
				named.add(carrier)
			}
		}
		return e
	}
	transformStatement(statement, { ...identityHooks, expr: note })
	return named
}

/**
 * The carriers a write statement reads, by name: every carrier whose setting it reads (write/carriers/carriers.ts
 * carrierRead), the one way a statement reads a carrier.
 */
export const carrierReads = (statement: SqlStatement): ReadonlySet<CarrierName> =>
	namedThrough(statement, "current_setting")

/**
 * The carriers a write statement fills, by name: every carrier whose setting it writes (write/carriers/carriers.ts
 * carrierStash), a statement of its own or a part of no row of the statement that makes a carried side.
 */
export const carrierFills = (statement: SqlStatement): ReadonlySet<CarrierName> =>
	namedThrough(statement, "set_config")

/**
 * The carrier settings a statement's printed text reads outside a ROWS FROM list, by name, in the order it reads them:
 * every current_setting call of a carrier's setting (write/carriers/carriers.ts carrierSetting) no ROWS FROM ( ... )
 * holds. A served statement reads every carrier through one function scan (sql/print.ts printSettingRows), so none.
 */
export const carrierReadsOutsideRowsFrom = (text: string): ReadonlyArray<string> => {
	const lexemes = lexemesOf(text).lexemes
	const groups: Array<"rows from" | "plain"> = []
	const outside: Array<string> = []
	for (const [at, l] of lexemes.entries()) {
		const before = (back: number) => lexemes[at - back]
		if (l.kind === "punct" && l.text === "(") {
			const one = before(1)
			const two = before(2)
			groups.push(
				one?.kind === "word" && one.upper === "FROM" && two?.kind === "word" && two.upper === "ROWS"
					? "rows from"
					: "plain"
			)
		} else if (l.kind === "punct" && l.text === ")") {
			groups.pop()
		} else if (l.kind === "string") {
			const setting = Str.startsWith("'")(l.text) ? Str.slice(1, -1)(l.text) : l.text
			const call = before(2)
			if (
				settingCarrier(setting) !== undefined &&
				call?.kind === "word" &&
				call.upper === "CURRENT_SETTING" &&
				!groups.includes("rows from")
			) {
				outside.push(setting)
			}
		}
	}
	return outside
}
