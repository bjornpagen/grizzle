import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
/**
 * A table's CHECK or stored generation whose expression reads what PostgreSQL would otherwise plan into every statement
 * that writes the table is installed as a row function: a PL/pgSQL constant of the columns it reads (sql/ast.ts
 * ConstantLanguage `plpgsql`), named by its definition's digest (core/identity.ts rowFunction), its body the expression
 * with each column its parameter, and the CHECK or the generation is the call of it on the row's columns.
 *
 * PostgreSQL plans a table's CHECKs and stored generations again for every statement that writes the table (REL_19_0
 * execMain.c ExecRelCheck and nodeModifyTable.c ExecInitGenerated, each a stringToNode of the stored expression and an
 * expression_planner of it per result relation): a constant the expression calls is evaluated by that planning, its
 * value copied, and a literal it holds is read back from the stored expression's text, a byte at a time. A row function
 * is planned once per backend, at its first call, with the constants its body calls folded into that plan and its
 * literals read with it, so a statement pays one call per row and nothing per constant or literal. On cassowary under PostgreSQL
 * 19.0, counted in user-mode instructions of the writing backend (perf stat), a call of an installed constant costs a
 * statement 7,800 instructions beyond the literal it returns and 0.83 more per byte of its value; a literal costs 207
 * per byte; the call of a row function costs 4,405 per row (inlineLiteralMaxBytes's evidence). So an expression is
 * hoisted when it calls an installed constant, which costs a one-row statement more than the call, when it matches a
 * pattern, data of its language, or when its literals hold more than inlineLiteralMaxBytes together; every other
 * expression stays inline, where a statement of many rows pays nothing per row for it.
 *
 * The body is PL/pgSQL, never SQL: an SQL body PostgreSQL may inline is planned into every statement again, and one it
 * never inlines (STRICT, SECURITY DEFINER or a SET clause) runs its plan through the executor on every call, ten times
 * a PL/pgSQL call's cost on the same evaluation. PL/pgSQL resolves the body's operators under its SET clause's closed
 * path, so no writer's path changes what the CHECK or the generation computes.
 */
import { everyProperty } from "#compiler/core/canonical.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import type {
	ColumnGeneration,
	CreateConstant,
	Expr,
	FunctionParam,
	LiteralValue,
	QualifiedFunctionRef,
	TypeRef
} from "#compiler/sql/ast.ts"
import { param, qualifiedCall, types } from "#compiler/sql/build.ts"
import { identityHooks, ownColumns, transformExpr } from "#compiler/sql/transform.ts"

/**
 * The most bytes the literals of a table's CHECK or stored generation hold together and stay inline: one past it, the
 * expression is its row function's (`hoists`). It is the one-row break-even of literals against a row function's call:
 * what a statement pays to read back literals of this many bytes is what one row pays to call the function.
 *
 * @limitKind measured
 * @owner grizzle's installation (physical/ddl/row-functions.ts)
 * @unit bytes of the literals' values: a text's or a numeric's UTF-8 bytes and a bit string's whole bytes; a value
 *   PostgreSQL passes by value counts none, the expression's structure as its operators are, which the bound leaves
 *   to the expression
 * @scope the literals of each table CHECK and stored generation an installation creates, together
 * @evidence uncommitted run files in ~/.cache/grizzle-release/PGNOPATCH2-tools: micro/micro.sql, micro-lit.sql and
 *   micro-tlit.sql install the tables; micro/run.sh and the loops beside it count each run's backend with
 *   prof/count.sh (`sudo perf stat -e instructions:u -p <backend>`) from a sleep before the work to the backend's exit;
 *   counts in micro/micro1.txt, micro-lit.txt and micro-tlit.txt
 * @observed 2026-11-20 03:20 to 03:50 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GB of memory, load 180 to 800, memory
 *   pressure high; the shared test family's first member (pg.config.ts, port 5442), the official PostgreSQL 19.0
 *   unpatched, as the bootstrap superuser in a scratch database; instruction counts, which the load leaves alone
 * @workload a table of one integer column per variant, written by 20 and by 220 one-row INSERT statements (each an
 *   EXECUTE of a PL/pgSQL loop) and by one INSERT of 1,000 and of 101,000 rows, each in a new backend, the per
 *   statement and per row costs the differences over 200 statements and 100,000 rows, less a bare table's
 * @result per statement: a CHECK holding a 100,000-character text literal 20,786,615 instructions, one holding 1,000
 *   characters 273,256, so 207.2 per byte between them; a bit string literal of 131,072 bytes 215 per byte; a CHECK
 *   calling a one-digit constant 7,831 more than the same CHECK holding the digit. Per row: a stored generation calling
 *   a one-parameter PL/pgSQL row function under SET search_path 10,258, the same expression inline 5,853, so 4,405 a
 *   call; a CHECK's call 3,980; the row function without the SET clause 2,897 and 2,471, an SQL one SECURITY DEFINER
 *   or under a SET clause 8,405 and 40,912. Not measured: a row function of many parameters, a literal of another type
 * @decision 4,405 / 207.2 = 21.3, so 21: literals past 21 bytes cost a one-row statement more than the call. A
 *   statement of R rows pays the call R times, so literals of B bytes repay it only where B > 21 R; the rows a write
 *   statement holds were not measured. No headroom added
 * @revalidate a PostgreSQL repin; a change of how PostgreSQL reads a stored expression or plans a PL/pgSQL call; a row
 *   function's clauses changed; another machine
 */
export const inlineLiteralMaxBytes = 21

/** What the table a CHECK or a generation is on gives its row function: its columns' types, and which calls read an
 * installed constant. */
export interface RowScope {
	/** The schema every constant of the installation is created in, the row function's. */
	readonly schema: string
	/** Whether a call of `fn` reads an installed constant: a closed relation's, a roster's or a dictionary's. */
	readonly readsConstant: (fn: QualifiedFunctionRef) => boolean
	/** The type of the table's column `column`. */
	readonly columnType: (column: string) => TypeRef
	/** The language of the pattern whose installed spelling's ARE is `are` (ir/pattern.ts InstalledSpellings), none for
	 * a text no installed spelling's ARE is. */
	readonly languageOf: (are: string) => string | undefined
}

/** A row function: its identity, and its CREATE, a PL/pgSQL constant. */
export interface RowFunction {
	readonly named: Identity<"rowFunction">
	readonly create: CreateConstant
}

/** The bytes of a literal's value as inlineLiteralMaxBytes counts them: the data a text, a numeric or a bit string
 * holds; none for a NULL, or a boolean or a number PostgreSQL passes by value, whose fixed datum is the expression's
 * own structure, as its operators are. */
const literalBytes = (value: LiteralValue): number => {
	switch (value.kind) {
		case "text":
		case "decimal":
			return utf8Length(value.value)
		case "bits":
			return Math.ceil(value.hex.length / 2)
		case "bool":
		case "int":
		case "float":
		case "floatSpecial":
			return 0
	}
}

/** The language of the pattern `e` matches, where it is a match of a text by the ARE of an installed spelling. */
const matchedLanguage = (scope: RowScope, e: Expr): string | undefined =>
	e.kind === "binary" && e.op === "~" && e.right.kind === "literal" && e.right.value.kind === "text"
		? scope.languageOf(e.right.value.value)
		: undefined

/**
 * Whether an expression of a table's row is its row function's: it calls an installed constant, it matches a pattern,
 * or its literals hold more bytes together than inlineLiteralMaxBytes. A pattern is data of its language whatever its
 * spelling's length, so an expression matching one is a row function however the installation spells it, and two
 * spellings of one language install the same objects.
 */
const hoists = (scope: RowScope, expr: Expr): boolean => {
	const nodes: Array<Expr> = []
	const called: Array<QualifiedFunctionRef> = []
	transformExpr(expr, {
		...identityHooks,
		expr: (e) => {
			nodes.push(e)
			return e
		},
		functionRef: (fn) => {
			called.push(fn)
			return fn
		}
	})
	const bytes = nodes.reduce(
		(sum, e) => sum + (e.kind === "literal" ? literalBytes(e.value) : 0),
		0
	)
	return (
		called.some(scope.readsConstant) ||
		nodes.some((e) => matchedLanguage(scope, e) !== undefined) ||
		bytes > inlineLiteralMaxBytes
	)
}

/**
 * A row function's body as its identity digests it: each pattern it matches, the ARE of the spelling the installation
 * holds of the pattern's language, as that language, so a pattern spelled otherwise in one language names the same
 * function, as it is the same law (ir/pattern.ts PatternValue); every other node as it is. The language stands in a
 * call of no schema, a node no body holds, so no text the body compares by `~` reads as it.
 */
const identified = (scope: RowScope, body: Expr): Expr =>
	transformExpr(body, {
		...identityHooks,
		expr: (e) => {
			const language = matchedLanguage(scope, e)
			return language === undefined || e.kind !== "binary"
				? e
				: { ...e, right: qualifiedCall("", language, []) }
		}
	})

/**
 * `expr`, an expression of a table's row returning `returns`, as the CHECK or the generation states it: the call of its
 * row function on the columns it reads, in the order it first reads them, each the function's parameter by its position
 * and named by its column, which `install` installs, named by its definition's digest (`identified`); or `expr` itself
 * where it stays inline (`hoists`).
 */
const rowExpression = (
	scope: RowScope,
	expr: Expr,
	returns: TypeRef,
	install: (fn: RowFunction) => void
): Expr => {
	if (!hoists(scope, expr)) {
		return expr
	}
	const columns = ownColumns(expr)
	const params: ReadonlyArray<FunctionParam> = columns.map((column) => ({
		name: column,
		type: scope.columnType(column)
	}))
	const position = new Map(columns.map((column, i) => [column, i + 1]))
	const body = transformExpr(expr, {
		...identityHooks,
		expr: (e) => {
			const at = e.kind === "column" && e.table === undefined ? position.get(e.column) : undefined
			return at === undefined || e.kind !== "column" ? e : param(at, scope.columnType(e.column))
		}
	})
	const definition = { params, returns, body }
	const named = identity.rowFunction(
		constantDigest("row-function", { ...definition, body: identified(scope, body) }, everyProperty)
	)
	install({
		named,
		create: {
			kind: "createConstant",
			language: "plpgsql",
			name: { schema: scope.schema, name: named.identifier },
			...definition
		}
	})
	return qualifiedCall(
		scope.schema,
		named.identifier,
		columns.map((column) => ({ kind: "column", table: undefined, column }))
	)
}

/** A column's generation with each expression its row function's call where it hoists (`rowExpression`): a stored one's
 * expression, of the column's type, and a partial one's selection, a boolean, and expression apart. */
export const rowGeneration = (
	scope: RowScope,
	generated: ColumnGeneration | undefined,
	type: TypeRef,
	install: (fn: RowFunction) => void
): ColumnGeneration | undefined => {
	switch (generated?.kind) {
		case "stored":
			return { kind: "stored", expr: rowExpression(scope, generated.expr, type, install) }
		case "partial":
			return {
				kind: "partial",
				when: rowExpression(scope, generated.when, types.boolean, install),
				expr: rowExpression(scope, generated.expr, type, install)
			}
		case "retirement":
		case undefined:
			return generated
	}
}

/** A CHECK's predicate as its row function's call where it hoists (`rowExpression`). */
export const rowCheck = (
	scope: RowScope,
	predicate: Expr,
	install: (fn: RowFunction) => void
): Expr => rowExpression(scope, predicate, types.boolean, install)
