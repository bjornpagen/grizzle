import {
	appendNonEmpty,
	isNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
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
 * expression stays inline, where a statement of many rows pays nothing per row for it. Of a hoisted AND or OR, the
 * operands that stay inline together stand first, before the call of the rest, so a row they decide calls nothing: a
 * selection's `<pattern> AND kind IN (…)` calls its function only on the rows of its kinds.
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
	CreateConstant,
	Expr,
	FunctionParam,
	LiteralValue,
	QualifiedFunctionRef,
	TypeRef,
	StoredGeneration
} from "#compiler/sql/ast.ts"
import { and, or, param, qualifiedCall, types } from "#compiler/sql/build.ts"
import { identityHooks, ownColumns, Transform, transformExpr } from "#compiler/sql/transform.ts"
import { digestedHooks } from "#compiler/sql/type-schemas.ts"

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
	/** The installation's schemas (ir/physical.ts PhysicalNames installed), which the row function's identity reads its
	 * definition apart from (type-schemas.ts digestedHooks). */
	readonly installed: ReadonlySet<string>
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
const matchedLanguage = (scope: Pick<RowScope, "languageOf">, e: Expr): string | undefined =>
	e.kind === "binary" && e.op === "~" && e.right.kind === "literal" && e.right.value.kind === "text"
		? scope.languageOf(e.right.value.value)
		: undefined

/**
 * One node of an expression as an identity reads it: a match of a text by the ARE of an installed spelling
 * (`languageOf`) matches its pattern's language instead, a key of 64 hex digits (ir/scalar.ts languageKey) in a call of
 * no schema, which no call an installation makes is, and every other node as it is. So an object named by an
 * expression's text, a row function (`identified`) or a session delta's reader (physical/ddl/deltas.ts DeltaReads), is
 * named by the language a pattern spells, never by its spelling, as its law is (ir/pattern.ts PatternValue).
 */
export const byLanguage = (languageOf: RowScope["languageOf"], e: Expr): Expr => {
	const language = matchedLanguage({ languageOf }, e)
	return language === undefined || e.kind !== "binary"
		? e
		: {
				...e,
				right: qualifiedCall(
					{ kind: "qualified", schema: "", name: language, volatility: "IMMUTABLE" },
					[]
				)
			}
}

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

/** A row function's definition: its parameters, the columns it reads, its result type and its body. */
export interface RowDefinition {
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
	readonly body: Expr
}

/**
 * A row function's definition as its identity digests it: read in no schema (type-schemas.ts digestedHooks), so one
 * expression names one function in every installation, whatever its schemas are named, its constants' calls and its
 * domains' casts among it; and each pattern it matches, the ARE of the spelling the installation holds of the pattern's
 * language, as that language, so a pattern spelled otherwise in one language names the same function, as it is the same
 * law (ir/pattern.ts PatternValue); every other node as it is. The language, a key of 64 hex digits (ir/scalar.ts
 * languageKey), stands in a call of no schema, which no call of the body is: a function the installation installs is
 * named by an identifier of at most 63 bytes, so no text the body compares by `~` reads as it.
 */
const identified = (
	scope: Pick<RowScope, "installed" | "languageOf">,
	definition: RowDefinition
): RowDefinition => {
	const t = new Transform({
		...digestedHooks(scope.installed),
		expr: (e) => byLanguage(scope.languageOf, e)
	})
	return {
		params: definition.params.map((p) => t.functionParam(p)),
		returns: t.type(definition.returns),
		body: t.expr(definition.body)
	}
}

/**
 * `expr`, an expression of a table's row returning `returns`, as the CHECK or the generation states it: `expr` itself
 * where it stays inline (`hoists`); else, a conjunction or a disjunction some of whose operands stay inline together,
 * those operands first, in their order, then the call of its row function on the rest (`called`), so a row they decide,
 * a row outside a selection's IN-list or one whose first condition already holds, calls no function: PostgreSQL
 * evaluates an AND's and an OR's operands in the order it holds them and stops at the first that decides it
 * (execExprInterp.c EEOP_BOOL_AND_STEP, EEOP_BOOL_OR_STEP); else the call of its row function on the whole expression.
 * Moving the inline operands ahead of the rest changes no value: an AND or an OR over three-valued booleans is the same
 * in any order, and PostgreSQL defines no order of evaluating them, so no SQL of grizzle's relies on one to keep an
 * operand from being evaluated (a CASE arm does that).
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
	if (expr.kind !== "and" && expr.kind !== "or") {
		return called(scope, expr, returns, install)
	}
	const join = expr.kind === "and" ? and : or
	const { inline, rest } = inlineOperands(scope, expr.args, join)
	return isNonEmpty(inline) && isNonEmpty(rest)
		? join(appendNonEmpty(inline, called(scope, join(rest), types.boolean, install)))
		: called(scope, expr, returns, install)
}

/**
 * The operands of one AND or OR (`join`) that stand inline (`selects`), each taken in order while the ones taken with it
 * still stay inline together (`hoists`), and the rest, each in order.
 */
const inlineOperands = (
	scope: RowScope,
	args: NonEmptyReadonlyArray<Expr>,
	join: (args: NonEmptyReadonlyArray<Expr>) => Expr
): { readonly inline: ReadonlyArray<Expr>; readonly rest: ReadonlyArray<Expr> } => {
	const inline: Array<Expr> = []
	const rest: Array<Expr> = []
	for (const arg of args) {
		if (selects(arg) && !hoists(scope, join(appendNonEmpty(inline, arg)))) {
			inline.push(arg)
		} else {
			rest.push(arg)
		}
	}
	return { inline, rest }
}

/** A column, cast or not, as a selector compares it. */
const columnRead = (e: Expr): boolean =>
	e.kind === "column" || (e.kind === "cast" && columnRead(e.expr))

/** A literal, cast or not, as a selector compares a column with it. */
const literalRead = (e: Expr): boolean =>
	e.kind === "literal" || (e.kind === "cast" && literalRead(e.expr))

const comparisons: ReadonlySet<string> = new Set(["=", "<>", "<", "<=", ">", ">="])

/**
 * Whether an operand is a selector: a column compared with a literal, or a member of a list of literals, or a NOT, an
 * AND or an OR of selectors. A selector is the cheapest test a statement can plan, its column and its literals alone,
 * so one stands inline before the call of its expression's row function, deciding the rows outside a selection's
 * kinds; any other operand a row function plans, every function it calls among them, stays in it, so the statement
 * plans no more of the expression than its selectors.
 */
const selects = (e: Expr): boolean =>
	(e.kind === "binary" &&
		comparisons.has(e.op) &&
		((columnRead(e.left) && literalRead(e.right)) ||
			(literalRead(e.left) && columnRead(e.right)))) ||
	(e.kind === "inList" && columnRead(e.expr) && e.list.every(literalRead)) ||
	(e.kind === "not" && selects(e.expr)) ||
	((e.kind === "and" || e.kind === "or") && e.args.every(selects))

/**
 * A row function's identity: the digest of its definition read apart from the installation's schemas, each pattern it
 * matches by its language (`identified`). What a declared rename restates a row function by to find it in the previous
 * snapshot (deploy/diff/declared.ts pairedConstants).
 */
export const rowFunctionIdentity = (
	scope: Pick<RowScope, "installed" | "languageOf">,
	definition: RowDefinition
): Identity<"rowFunction"> =>
	identity.rowFunction(constantDigest("row-function", identified(scope, definition), everyProperty))

/**
 * The call of `expr`'s row function on the columns it reads, in the order it first reads them, each the function's
 * parameter by its position and named by it (`p1` … `pn`), which `install` installs, named by its definition's digest
 * (`identified`). The function is what its body computes over its parameters' types, whatever the columns it is called
 * on are named: a declared rename of a column it reads renames the column in its call, the CHECK or the generation
 * standing as it is, and leaves the function and its name as they are.
 */
const called = (
	scope: RowScope,
	expr: Expr,
	returns: TypeRef,
	install: (fn: RowFunction) => void
): Expr => {
	const columns = ownColumns(expr)
	const params: ReadonlyArray<FunctionParam> = columns.map((column, i) => ({
		name: `p${i + 1}`,
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
	const definition: RowDefinition = { params, returns, body }
	const named = rowFunctionIdentity(scope, definition)
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
		{ kind: "qualified", schema: scope.schema, name: named.identifier, volatility: "IMMUTABLE" },
		columns.map((column) => ({ kind: "column", table: undefined, column }))
	)
}

/** A column's generation with each expression its row function's call where it hoists (`rowExpression`): a stored one's
 * expression, of the column's type, and a partial one's selection, a boolean, and expression apart. */
export const rowGeneration = (
	scope: RowScope,
	generated: StoredGeneration | undefined,
	type: TypeRef,
	install: (fn: RowFunction) => void
): StoredGeneration | undefined => {
	switch (generated?.kind) {
		case "stored":
			return { kind: "stored", expr: rowExpression(scope, generated.expr, type, install) }
		case "partial":
			return {
				kind: "partial",
				when: rowExpression(scope, generated.when, types.boolean, install),
				expr: rowExpression(scope, generated.expr, type, install)
			}
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
