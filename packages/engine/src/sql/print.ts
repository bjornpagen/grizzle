import {
	type AlterDomainAction,
	type AlterRoleAction,
	type AlterTableAction,
	type ColumnDef,
	type CommentTarget,
	type ContextColumn,
	type ContextSource,
	type CreateFunction,
	type Cte,
	type CteBody,
	type Delete,
	type Expr,
	type ForeignKeyColumn,
	type FrameBound,
	type FromItem,
	type FunctionCall,
	type FunctionName,
	type FunctionRef,
	type Grantee,
	type GrantObjects,
	type IndexKey,
	type Insert,
	type KeyColumn,
	type LiteralValue,
	type Merge,
	type MergeWhen,
	type ObjectName,
	type OnConflict,
	type OrderItem,
	type PlBlock,
	type PlStatement,
	type QualifiedFunctionRef,
	type Select,
	type SelectBody,
	type SelectCore,
	type SqlStatement,
	type TableConstraint,
	type TableName,
	type Target,
	type TriggerEvent,
	type TypeRef,
	tableConstraints,
	type Update,
	type WindowSpec,
	type With
} from "#compiler/sql/ast.ts"

/**
 * The advisory lock key every installation's database-default block takes, so concurrent installations into one
 * database set the default one at a time (the alterDatabaseDefault case below). Any fixed key no other code takes.
 */
const databaseDefaultLock = "7385900293"

const indentUnit = "  "

/**
 * The deterministic SQL printer.
 *
 * One AST prints to one text, byte for byte, in every process: the printer reads nothing but its input and uses no
 * locale-sensitive formatting. It quotes every identifier, prints every parameter as `$n::type` and
 * every literal typed, wraps every CHECK as `CHECK ((<predicate>) IS TRUE)`, and parenthesizes by
 * PostgreSQL's operator precedence so the printed text parses back to the tree it came from.
 *
 * Layout. The insert protocol (write/insert/protocol.ts) is the reference, and the printer reproduces its layout:
 * - a statement's own clauses go on separate lines: the outermost SELECT's FROM, WHERE, GROUP BY, HAVING, ORDER BY,
 *   LIMIT and OFFSET, and each clause of a DML statement;
 * - each CTE of the statement's WITH is a block, `name(cols) AS (` ... `)`, its body indented two spaces;
 * - a query nested anywhere else, a CTE body included, prints on one line;
 * - PL/pgSQL nests by two spaces.
 * Builtin type, function and configuration names are PostgreSQL's own spellings, printed unquoted; every name grizzle
 * derives is quoted.
 *
 * Every identifier is quoted, so case and reserved words never matter.
 */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

export const printObjectName = (name: ObjectName): string =>
	`${quoteIdent(name.schema)}.${quoteIdent(name.name)}`

/** A carrier prints bare, resolving to the session's temporary schema; a stored relation prints qualified. */
export const printTableName = (table: TableName): string =>
	typeof table === "string" ? quoteIdent(table) : printObjectName(table)

/** A standard-conforming string literal: only the single quote is special. */
export const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`

/**
 * A text[] literal's text: each element double-quoted, its backslashes and double quotes escaped, so any name is one
 * element.
 */
const textArrayLiteral = (elements: ReadonlyArray<string>): string =>
	`{${elements.map((e) => `"${e.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`

/** The setting a Db's transactions hold their claims in, which the prologue sets (deploy/ledger/ledger.ts enter). */
export const claimsSettingName = "grizzle.claims"

/**
 * The refusal of an unreadable claims setting, through the installation's refusal function (write/refusal.ts): SQLSTATE
 * 22P02, the setting's name as the constraint name, and the DETAIL `c[]` for a setting that is no claims document or
 * `c["<Context>"]` for a context's member that holds other keys than its fields. It carries no claim value, and never
 * returns.
 */
const refuseClaims = (
	refusal: QualifiedFunctionRef,
	context: readonly [] | readonly [string]
): string =>
	`${printFunctionName(refusal)}('22P02'::text, ${quoteString(claimsSettingName)}::text, ${quoteString(`c${JSON.stringify(context)}`)}::text)`

/**
 * The jsonpath of a claims document's members that break the shape the Db path writes (adapter/db/claims.ts): a member
 * that is no object, or an object holding a value that is no string.
 */
const claimsMisshapen = `'strict $.* ? (@.type() != "object" || exists (@.* ? (@.type() != "string")))'::jsonpath`

/**
 * The session's claims document as a one-row query of one column, "j": the empty object where the setting holds no
 * claims, which is NULL before a transaction set it in the session and `''` once that transaction ended (`NULL <> ''`
 * is no match, so both take the outer ELSE); the setting as jsonb where it is a JSON object without a repeated key at
 * any depth that jsonb reads; and refused through `refusal` otherwise, invalid JSON included. Its members' shape is
 * judged where it is read (contextClaims), over the jsonb it parsed once.
 */
const claimsDocument = (refusal: QualifiedFunctionRef): string =>
	`SELECT CASE WHEN "k"."s" <> ''::text THEN CASE WHEN "k"."s" IS JSON OBJECT WITH UNIQUE KEYS AND pg_catalog.pg_input_is_valid("k"."s", 'jsonb'::text) THEN "k"."s"::jsonb ELSE pg_catalog.to_jsonb(${refuseClaims(refusal, [])}) END ELSE '{}'::jsonb END AS "j" FROM (SELECT pg_catalog.current_setting(${quoteString(claimsSettingName)}::text, true) AS "s") AS "k"`

/** A claim of a context source in the claims document `document`: its JSON string, cast to its column's type. */
const claimRead = (
	document: string,
	source: ContextSource,
	{ field, column }: ContextColumn
): string =>
	`(${document} #>> ${quoteString(textArrayLiteral([source.context, field]))}::text[])::${printType(column.type)}`

/**
 * The claims document as a context source reads it (sql/ast.ts ContextSource), a scalar subquery: refused through the
 * source's refusal function where the document is no claims document, a member that is no object of strings breaking
 * the shape the Db path writes; the document where it holds no member for the context, or a member holding exactly the
 * source's fields, each a value of its column's type, which reads every claim once here, so a claim its type refuses
 * raises that type's error wherever the context is read, whichever columns the source's readers read (a read of a
 * string is never NULL, so num_nonnulls counts every field); and refused where the member holds any other keys. It
 * reads no column of the statement, so PostgreSQL computes it once per statement as an InitPlan, reading the setting
 * once: when it is first read, or, under a parallel plan, before the workers start.
 */
const contextClaims = (source: ContextSource): string => {
	const context = `${quoteString(source.context)}::text`
	const member = `("d"."j" -> ${context})`
	const keys = `${quoteString(textArrayLiteral(source.columns.map((c) => c.field)))}::text[]`
	const reads = source.columns.map((c) => claimRead(`"d"."j"`, source, c)).join(", ")
	const readable = `${member} ?& ${keys} AND (${member} - ${keys}) = '{}'::jsonb AND pg_catalog.num_nonnulls(${reads}) = ${source.columns.length}`
	return `(SELECT CASE WHEN pg_catalog.jsonb_path_exists("d"."j", ${claimsMisshapen}) THEN pg_catalog.to_jsonb(${refuseClaims(source.refusal, [])}) WHEN NOT ("d"."j" ? ${context}) OR (${readable}) THEN "d"."j" ELSE pg_catalog.to_jsonb(${refuseClaims(source.refusal, [source.context])}) END FROM (${claimsDocument(source.refusal)}) AS "d")`
}

/**
 * A context source (sql/ast.ts ContextSource) as a derived table: the claims document as the source reads it, once, as
 * "m"."j", and each column its claim, collated as the column is, over the one row where the document holds the
 * context. The document's query calls the refusal function, which is VOLATILE, so PostgreSQL never pulls "m" up into
 * its readers, and the document stays one InitPlan however many columns are read.
 */
const printContextSource = (source: ContextSource): string => {
	const reads = source.columns.map((c) =>
		c.column.collation === undefined
			? claimRead(`"m"."j"`, source, c)
			: `${claimRead(`"m"."j"`, source, c)} COLLATE ${printObjectName(c.column.collation)}`
	)
	return `(SELECT ${reads.join(", ")} FROM (SELECT ${contextClaims(source)} AS "j") AS "m" WHERE "m"."j" ? ${quoteString(source.context)}::text) AS ${quoteIdent(source.alias)}(${printIdentList(source.columns.map((c) => c.column.name))})`
}

export const printType = (type: TypeRef): string => {
	const array = type.array ? "[]" : ""
	if (type.kind === "named") {
		const typmod = type.typmod.length === 0 ? "" : `(${type.typmod.join(", ")})`
		return `${quoteIdent(type.schema)}.${quoteIdent(type.name)}${typmod}${array}`
	}
	if (type.precision === undefined) {
		return `${type.name}${array}`
	}
	const typmod =
		type.scale === undefined ? `(${type.precision})` : `(${type.precision}, ${type.scale})`
	return `${type.name}${typmod}${array}`
}

const isInt4 = (type: TypeRef): boolean =>
	type.kind === "builtin" && type.name === "integer" && !type.array

const isSpecialDecimal = (value: string): boolean =>
	value === "NaN" || value === "Infinity" || value === "-Infinity"

/**
 * Precedence, highest binding first, after PostgreSQL's operator table: atoms, `::`, unary minus, COLLATE, `* / %`,
 * `+ -`, any other operator, BETWEEN and IN, comparisons, IS, NOT, AND, OR.
 */
const prec = {
	atom: 14,
	cast: 13,
	negate: 12,
	collate: 11,
	mul: 10,
	add: 9,
	other: 8,
	between: 7,
	compare: 6,
	is: 5,
	not: 4,
	and: 3,
	or: 2,
	top: 0
} as const

interface Printed {
	readonly text: string
	readonly prec: number
}

const printed = (text: string, level: number): Printed => ({ text, prec: level })

/**
 * How the printer spells a literal before its cast: a string, quoted, that the type's input function reads, or bare, a
 * boolean or numeric constant PostgreSQL types itself. A negative bare number is parenthesized, the unary minus of its
 * magnitude.
 */
type Spelling =
	| { readonly kind: "quoted"; readonly text: string }
	| { readonly kind: "bare"; readonly text: string }

/**
 * NaN and the infinities are words, read by numeric's input function.
 *
 * String spells a finite double other than -0 in its shortest round-trip form.
 *
 * Quoted, so NaN, the infinities and -0 reach the float input function exactly.
 */
const spellingOf = (value: LiteralValue): Spelling => {
	switch (value.kind) {
		case "bool":
			return { kind: "bare", text: value.value ? "true" : "false" }
		case "int":
			return {
				kind: "bare",
				text: value.value < 0n ? `(${value.value.toString()})` : value.value.toString()
			}
		case "decimal":
			return isSpecialDecimal(value.value)
				? { kind: "quoted", text: value.value }
				: { kind: "bare", text: value.value.startsWith("-") ? `(${value.value})` : value.value }
		case "float":
			return { kind: "quoted", text: String(value.value) }
		case "floatSpecial":
			return { kind: "quoted", text: value.value }
		case "text":
			return { kind: "quoted", text: value.value }
	}
}

/** Whether the printer spells a literal quoted (spellingOf): text, every float and a special decimal. */
export const printsQuoted = (value: LiteralValue): boolean => spellingOf(value).kind === "quoted"

/**
 * PostgreSQL's boolean constants are typed boolean; a boolean domain casts them.
 *
 * Only a nonnegative integer constant within int4 prints bare, since PostgreSQL types it integer itself (as in
 * `count(*) > 1`). A negative one prints parenthesized and typed, (-N)::integer like every other negative literal:
 * gram.y folds the minus into the constant, which make_const then types by its value (so -2147483648 is an
 * integer constant though its magnitude is not), and the cast states the type whatever the value.
 */
const printLiteral = (value: LiteralValue, type: TypeRef): Printed => {
	const spelling = spellingOf(value)
	const text = spelling.kind === "quoted" ? quoteString(spelling.text) : spelling.text
	if (value.kind === "bool" && type.kind === "builtin" && type.name === "boolean" && !type.array) {
		return printed(text, prec.atom)
	}
	if (value.kind === "int" && isInt4(type) && value.value >= 0n) {
		return printed(text, prec.atom)
	}
	return printed(`${text}::${printType(type)}`, prec.cast)
}

const comparisonOperators: ReadonlySet<string> = new Set(["=", "<>", "<", "<=", ">", ">="])
const additiveOperators: ReadonlySet<string> = new Set(["+", "-"])
const multiplicativeOperators: ReadonlySet<string> = new Set(["*", "/", "%"])

const wrap = (child: Printed, minimum: number): string =>
	child.prec < minimum ? `(${child.text})` : child.text

/** ASC, the default, prints bare. */
const printOrderItem = (item: OrderItem): string =>
	item.direction === "ASC" ? printExpr(item.expr) : `${printExpr(item.expr)} ${item.direction}`

const printOrderBy = (items: ReadonlyArray<OrderItem>): string =>
	items.map(printOrderItem).join(", ")

const printFrameBound = (bound: FrameBound): string => {
	switch (bound.kind) {
		case "unboundedPreceding":
			return "UNBOUNDED PRECEDING"
		case "currentRow":
			return "CURRENT ROW"
		case "unboundedFollowing":
			return "UNBOUNDED FOLLOWING"
		case "offset":
			return `${bound.offset.toString()} ${bound.direction}`
	}
}

const printWindow = (spec: WindowSpec): string => {
	const parts: Array<string> = []
	if (spec.partitionBy.length > 0) {
		parts.push(`PARTITION BY ${spec.partitionBy.map((e) => printExpr(e)).join(", ")}`)
	}
	if (spec.orderBy.length > 0) {
		parts.push(`ORDER BY ${printOrderBy(spec.orderBy)}`)
	}
	if (spec.frame !== undefined) {
		parts.push(
			`ROWS BETWEEN ${printFrameBound(spec.frame.start)} AND ${printFrameBound(spec.frame.end)}`
		)
	}
	return `(${parts.join(" ")})`
}

const printFunctionName = (fn: FunctionRef): string =>
	fn.kind === "builtin" ? fn.name : `${quoteIdent(fn.schema)}.${quoteIdent(fn.name)}`

/** A call up to its OVER clause. */
const callHead = (call: FunctionCall): string => {
	if (call.star) {
		return call.filter === undefined
			? "count(*)"
			: `count(*) FILTER (WHERE ${printExpr(call.filter)})`
	}
	let args = call.args.map((arg) => printExpr(arg)).join(", ")
	if (call.distinct) {
		args = `DISTINCT ${args}`
	}
	if (call.orderBy.length > 0) {
		args = `${args} ORDER BY ${printOrderBy(call.orderBy)}`
	}
	const head = `${printFunctionName(call.fn)}(${args})`
	return call.withinGroup.length === 0
		? head
		: `${head} WITHIN GROUP (ORDER BY ${printOrderBy(call.withinGroup)})`
}

/** A windowed call is parenthesized when cast, as in `(SUM(count) OVER ())::bigint`. */
const printCall = (call: FunctionCall): Printed =>
	call.over === undefined
		? printed(callHead(call), prec.atom)
		: printed(`${callHead(call)} OVER ${printWindow(call.over)}`, prec.cast)

const binaryLevels = (
	op: string,
	qualified: boolean
): { readonly self: number; readonly assoc: "left" | "none" } => {
	if (qualified) {
		return { self: prec.other, assoc: "left" }
	}
	if (comparisonOperators.has(op)) {
		return { self: prec.compare, assoc: "none" }
	}
	if (additiveOperators.has(op)) {
		return { self: prec.add, assoc: "left" }
	}
	if (multiplicativeOperators.has(op)) {
		return { self: prec.mul, assoc: "left" }
	}
	return { self: prec.other, assoc: "left" }
}

/** "--" would open a comment. */
const expr = (e: Expr): Printed => {
	switch (e.kind) {
		case "column":
			return printed(
				e.table === undefined
					? quoteIdent(e.column)
					: `${quoteIdent(e.table)}.${quoteIdent(e.column)}`,
				prec.atom
			)
		case "excluded":
			return printed(`EXCLUDED.${quoteIdent(e.column)}`, prec.atom)
		case "returning":
			return printed(`${e.side}.${quoteIdent(e.column)}`, prec.atom)
		case "param":
			return printed(`$${e.slot.number}::${printType(e.type)}`, prec.cast)
		case "literal":
			return printLiteral(e.value, e.type)
		case "cast":
			return printed(`${wrap(expr(e.expr), prec.atom)}::${printType(e.type)}`, prec.cast)
		case "collate":
			return printed(
				`${wrap(expr(e.expr), prec.collate)} COLLATE ${printObjectName(e.collation)}`,
				prec.collate
			)
		case "binary": {
			const qualified = e.schema !== undefined
			const { self, assoc } = binaryLevels(e.op, qualified)
			const op = e.schema !== undefined ? `OPERATOR(${quoteIdent(e.schema)}.${e.op})` : e.op
			const left = wrap(expr(e.left), assoc === "left" ? self : self + 1)
			const right = wrap(expr(e.right), self + 1)
			return printed(`${left} ${op} ${right}`, self)
		}
		case "negate": {
			const operand = wrap(expr(e.expr), prec.negate)
			return printed(operand.startsWith("-") ? `-(${operand})` : `-${operand}`, prec.negate)
		}
		case "and":
			return printed(e.args.map((arg) => wrap(expr(arg), prec.and + 1)).join(" AND "), prec.and)
		case "or":
			return printed(e.args.map((arg) => wrap(expr(arg), prec.or + 1)).join(" OR "), prec.or)
		case "not":
			return printed(`NOT ${wrap(expr(e.expr), prec.not)}`, prec.not)
		case "isTrue":
			return printed(`${wrap(expr(e.expr), prec.atom)} IS TRUE`, prec.is)
		case "between": {
			const keyword = e.not ? "NOT BETWEEN" : "BETWEEN"
			const operand = (x: Expr): string => wrap(expr(x), prec.other)
			/**
			 * The lower bound is PostgreSQL's b_expr, which has no COLLATE: anything binding at COLLATE or looser is
			 * parenthesized, so no bare COLLATE can stand there (an atom, a cast and a negation hold none outside
			 * parentheses).
			 */
			const low = wrap(expr(e.low), prec.negate)
			return printed(`${operand(e.expr)} ${keyword} ${low} AND ${operand(e.high)}`, prec.between)
		}
		case "inList": {
			const keyword = e.not ? "NOT IN" : "IN"
			const list = e.list.map((item) => printExpr(item)).join(", ")
			return printed(`${wrap(expr(e.expr), prec.other)} ${keyword} (${list})`, prec.between)
		}
		case "inQuery": {
			const keyword = e.not ? "NOT IN" : "IN"
			return printed(
				`${wrap(expr(e.expr), prec.other)} ${keyword} (${printSelectInline(e.query)})`,
				prec.between
			)
		}
		case "exists":
			return e.not
				? printed(`NOT EXISTS (${printSelectInline(e.query)})`, prec.not)
				: printed(`EXISTS (${printSelectInline(e.query)})`, prec.atom)
		case "subquery":
			return printed(`(${printSelectInline(e.query)})`, prec.atom)
		case "array":
			return printed(`ARRAY(${printSelectInline(e.query)})`, prec.atom)
		case "row": {
			const items = e.items.map((item) => printExpr(item)).join(", ")
			return printed(e.items.length === 1 ? `ROW(${items})` : `(${items})`, prec.atom)
		}
		case "case": {
			const parts = ["CASE"]
			if (e.operand !== undefined) {
				parts.push(printExpr(e.operand))
			}
			for (const branch of e.whens) {
				parts.push(`WHEN ${printExpr(branch.when)} THEN ${printExpr(branch.result)}`)
			}
			parts.push(`ELSE ${printExpr(e.else)}`, "END")
			return printed(parts.join(" "), prec.atom)
		}
		case "call":
			return printCall(e)
		case "greatest":
		case "least":
			return printed(
				`${e.kind === "greatest" ? "GREATEST" : "LEAST"}(${e.args.map((arg) => printExpr(arg)).join(", ")})`,
				prec.atom
			)
		case "mergeAction":
			return printed("merge_action()", prec.atom)
		case "domainValue":
			return printed("VALUE", prec.atom)
		case "user":
			return printed(e.name, prec.atom)
		case "plVar":
			return printed(quoteIdent(e.name), prec.atom)
		case "plSpecial":
			return printed(e.name, prec.atom)
		case "field":
			return printed(`${expr(e.record).text}.${quoteIdent(e.field)}`, prec.atom)
	}
}

export const printExpr = (e: Expr): string => expr(e).text

/** The CHECK wrapper every CHECK carries, domain CHECKs included. */
const printCheck = (predicate: Expr): string => `CHECK ((${printExpr(predicate)}) IS TRUE)`

const printTarget = (target: Target): string =>
	target.alias === undefined
		? printExpr(target.expr)
		: `${printExpr(target.expr)} AS ${quoteIdent(target.alias)}`

const printTargets = (targets: ReadonlyArray<Target>): string => targets.map(printTarget).join(", ")

const printIdentList = (names: ReadonlyArray<string>): string => names.map(quoteIdent).join(", ")

const printFromItem = (item: FromItem): string => {
	switch (item.kind) {
		case "table":
			return `${printTableName(item.table)} AS ${quoteIdent(item.alias)}`
		case "cte":
			return item.alias === undefined
				? quoteIdent(item.name)
				: `${quoteIdent(item.name)} AS ${quoteIdent(item.alias)}`
		case "enclosing":
			return `${quoteIdent(item.name)} AS ${quoteIdent(item.alias)}`
		case "derived": {
			const lateral = item.lateral ? "LATERAL " : ""
			return `${lateral}(${printSelectInline(item.query)}) AS ${quoteIdent(item.alias)}(${printIdentList(item.columns)})`
		}
		case "function": {
			const lateral = item.lateral ? "LATERAL " : ""
			return `${lateral}${printCall(item.call).text} AS ${quoteIdent(item.alias)}(${printIdentList(item.columns)})`
		}
		case "recordset": {
			const columns = item.columns
				.map((column) =>
					column.collation === undefined
						? `${quoteIdent(column.name)} ${printType(column.type)}`
						: `${quoteIdent(column.name)} ${printType(column.type)} COLLATE ${printObjectName(column.collation)}`
				)
				.join(", ")
			return `jsonb_to_recordset($${item.source.number}::jsonb) AS ${quoteIdent(item.alias)}(${columns})`
		}
		case "values":
			return `(${printValuesRows(item.rows)}) AS ${quoteIdent(item.alias)}(${printIdentList(item.columns)})`
		case "context":
			return printContextSource(item)
		case "join": {
			const right =
				item.right.kind === "join" || item.right.kind === "crossJoin"
					? `(${printFromItem(item.right)})`
					: printFromItem(item.right)
			return `${printFromItem(item.left)} JOIN ${right} ON ${printExpr(item.on)}`
		}
		case "crossJoin": {
			const right =
				item.right.kind === "join" || item.right.kind === "crossJoin"
					? `(${printFromItem(item.right)})`
					: printFromItem(item.right)
			return `${printFromItem(item.left)} CROSS JOIN ${right}`
		}
	}
}

const printFrom = (items: ReadonlyArray<FromItem>): string => items.map(printFromItem).join(", ")

const printValuesRows = (rows: ReadonlyArray<ReadonlyArray<Expr>>): string =>
	`VALUES ${rows.map((row) => `(${row.map((e) => printExpr(e)).join(", ")})`).join(", ")}`

const coreClauses = (core: SelectCore): Array<string> => {
	let head = "SELECT"
	if (core.distinct === true) {
		head += " DISTINCT"
	} else if (core.distinct !== false) {
		head += ` DISTINCT ON (${core.distinct.on.map((e) => printExpr(e)).join(", ")})`
	}
	const clauses = [`${head} ${printTargets(core.targets)}`]
	if (core.from.length > 0) {
		clauses.push(`FROM ${printFrom(core.from)}`)
	}
	if (core.where !== undefined) {
		clauses.push(`WHERE ${printExpr(core.where)}`)
	}
	if (core.groupBy.length > 0) {
		clauses.push(`GROUP BY ${core.groupBy.map((e) => printExpr(e)).join(", ")}`)
	}
	if (core.having !== undefined) {
		clauses.push(`HAVING ${printExpr(core.having)}`)
	}
	return clauses
}

/** The clauses that follow a query body. */
const tailClauses = (select: Select): Array<string> => {
	const clauses: Array<string> = []
	if (select.orderBy.length > 0) {
		clauses.push(`ORDER BY ${printOrderBy(select.orderBy)}`)
	}
	if (select.limit !== undefined) {
		clauses.push(`LIMIT ${printExpr(select.limit)}`)
	}
	if (select.offset !== undefined) {
		clauses.push(`OFFSET ${printExpr(select.offset)}`)
	}
	return clauses
}

/**
 * Whether a set-operation arm needs parentheses added: not a core, not a full query (which parenthesizes itself), and
 * not the left arm chaining the same operator.
 */
const armNeedsParens = (arm: SelectBody, parent: SelectBody, side: "left" | "right"): boolean => {
	if (arm.kind === "core" || arm.kind === "select") {
		return false
	}
	return !(side === "left" && parent.kind === "setOp" && arm.op === parent.op)
}

/**
 * A full query used as a body always prints parenthesized, so its own WITH and tail clauses never run into the
 * enclosing query's. PostgreSQL still merges a parenthesized query's clauses with those that follow it, so the
 * lowerings build a query body with clauses at one of the two levels only, as the kernel's structural audit checks
 * (test/support/oracle/verify/sql.ts).
 */
const nestedSelect = (select: Select): string => `(${printSelectInline(select)})`

const bodyInline = (body: SelectBody): string => {
	switch (body.kind) {
		case "core":
			return coreClauses(body).join(" ")
		case "select":
			return nestedSelect(body)
		case "setOp": {
			const arm = (child: SelectBody, side: "left" | "right"): string =>
				armNeedsParens(child, body, side) ? `(${bodyInline(child)})` : bodyInline(child)
			return `${arm(body.left, "left")} ${body.op} ${arm(body.right, "right")}`
		}
	}
}

const bodyBlock = (body: SelectBody): Array<string> => {
	switch (body.kind) {
		case "core":
			return coreClauses(body)
		case "select":
			return [nestedSelect(body)]
		case "setOp": {
			const arm = (child: SelectBody, side: "left" | "right"): Array<string> =>
				armNeedsParens(child, body, side) ? [`(${bodyInline(child)})`] : bodyBlock(child)
			return [...arm(body.left, "left"), body.op, ...arm(body.right, "right")]
		}
	}
}

const withInline = (w: With): string => {
	const ctes = w.ctes.map((cte) => `${cteHead(cte)} (${cteBodyInline(cte.query)})`).join(", ")
	return `WITH ${w.recursive ? "RECURSIVE " : ""}${ctes}`
}

const cteHead = (cte: Cte): string => {
	const columns = cte.columns.length === 0 ? "" : `(${printIdentList(cte.columns)})`
	const materialized = cte.materialized === undefined ? "" : ` ${cte.materialized}`
	return `${quoteIdent(cte.name)}${columns} AS${materialized}`
}

/** A data-modifying body keeps its own WITH, which PostgreSQL accepts inside the CTE's parentheses. */
const cteBodyInline = (query: CteBody): string =>
	query.kind === "select"
		? printSelectInline(query)
		: [
				...(query.with === undefined ? [] : [withInline(query.with)]),
				...dmlBlock(query).map((line) => line.trimStart())
			].join(" ")

/**
 * A CTE body as block lines: a query on one line, a data-modifying statement clause by clause,
 * its own WITH first.
 */
const cteBodyBlock = (query: CteBody): Array<string> =>
	query.kind === "select" ? [printSelectInline(query)] : dmlStatementBlock(query)

const indent = (lines: ReadonlyArray<string>): Array<string> =>
	lines.map((line) => `${indentUnit}${line}`)

const withBlock = (w: With): Array<string> => {
	const lines: Array<string> = []
	for (const [i, cte] of w.ctes.entries()) {
		const head = `${i === 0 ? `WITH ${w.recursive ? "RECURSIVE " : ""}` : ""}${cteHead(cte)} (`
		lines.push(head, ...indent(cteBodyBlock(cte.query)), i === w.ctes.length - 1 ? ")" : "),")
	}
	return lines
}

const printSelectInline = (select: Select): string => {
	const parts: Array<string> = []
	if (select.with !== undefined) {
		parts.push(withInline(select.with))
	}
	parts.push(bodyInline(select.body), ...tailClauses(select))
	return parts.join(" ")
}

const selectBlock = (select: Select): Array<string> => [
	...(select.with === undefined ? [] : withBlock(select.with)),
	...bodyBlock(select.body),
	...tailClauses(select)
]

const printAssignments = (
	set: ReadonlyArray<{ readonly column: string; readonly value: Expr }>
): string => set.map((a) => `${quoteIdent(a.column)} = ${printExpr(a.value)}`).join(", ")

const returningLine = (returning: ReadonlyArray<Target>): Array<string> =>
	returning.length === 0 ? [] : [`RETURNING ${printTargets(returning)}`]

const conflictLines = (conflict: OnConflict): Array<string> => {
	if (conflict.kind === "constraint") {
		return [`ON CONFLICT ON CONSTRAINT ${quoteIdent(conflict.constraint)} DO NOTHING`]
	}
	const action = conflict.action
	const head = `ON CONFLICT (${printIdentList(conflict.columns)})`
	switch (action.kind) {
		case "doNothing":
			return [`${head} DO NOTHING`]
		case "doSelect": {
			const lines = [`${head} DO SELECT`]
			if (action.where !== undefined) {
				lines.push(`${indentUnit}WHERE ${printExpr(action.where)}`)
			}
			return lines
		}
		case "doUpdate": {
			const lines = [`${head} DO UPDATE SET ${printAssignments(action.set)}`]
			if (action.where !== undefined) {
				lines.push(`${indentUnit}WHERE ${printExpr(action.where)}`)
			}
			return lines
		}
	}
}

const insertBlock = (insert: Insert): Array<string> => {
	const alias = insert.alias === undefined ? "" : ` AS ${quoteIdent(insert.alias)}`
	const overriding = insert.overriding === undefined ? "" : ` OVERRIDING ${insert.overriding}`
	const lines = [
		`INSERT INTO ${printTableName(insert.table)}${alias} (${printIdentList(insert.columns)})${overriding}`
	]
	lines.push(
		insert.source.kind === "query"
			? printSelectInline(insert.source.query)
			: printValuesRows(insert.source.rows)
	)
	if (insert.onConflict !== undefined) {
		lines.push(...conflictLines(insert.onConflict))
	}
	lines.push(...returningLine(insert.returning))
	return lines
}

const updateBlock = (update: Update): Array<string> => {
	const lines = [
		`UPDATE ${printObjectName(update.table)} AS ${quoteIdent(update.alias)}`,
		`SET ${printAssignments(update.set)}`
	]
	if (update.from.length > 0) {
		lines.push(`FROM ${printFrom(update.from)}`)
	}
	if (update.where !== undefined) {
		lines.push(`WHERE ${printExpr(update.where)}`)
	}
	lines.push(...returningLine(update.returning))
	return lines
}

const deleteBlock = (del: Delete): Array<string> => {
	const lines = [`DELETE FROM ${printTableName(del.table)} AS ${quoteIdent(del.alias)}`]
	if (del.using.length > 0) {
		lines.push(`USING ${printFrom(del.using)}`)
	}
	if (del.where !== undefined) {
		lines.push(`WHERE ${printExpr(del.where)}`)
	}
	lines.push(...returningLine(del.returning))
	return lines
}

const mergeActionText = (action: MergeWhen["action"]): string => {
	switch (action.kind) {
		case "update":
			return `UPDATE SET ${printAssignments(action.set)}`
		case "insert": {
			const overriding = action.overriding === undefined ? "" : ` OVERRIDING ${action.overriding}`
			const columns = printIdentList(action.row.map((a) => a.column))
			const values = action.row.map((a) => printExpr(a.value)).join(", ")
			return `INSERT (${columns})${overriding} VALUES (${values})`
		}
		case "delete":
			return "DELETE"
		case "doNothing":
			return "DO NOTHING"
	}
}

const mergeWhenLine = (when: MergeWhen): string => {
	const condition = when.condition === undefined ? "" : ` AND ${printExpr(when.condition)}`
	return `WHEN ${when.match}${condition} THEN ${mergeActionText(when.action)}`
}

const mergeBlock = (merge: Merge): Array<string> => [
	`MERGE INTO ${printObjectName(merge.table)} AS ${quoteIdent(merge.alias)}`,
	`USING ${printFromItem(merge.using)} ON ${printExpr(merge.on)}`,
	...merge.whens.map(mergeWhenLine),
	...returningLine(merge.returning)
]

/** A DML statement's clauses, without its WITH. */
const dmlBlock = (statement: Insert | Update | Delete | Merge): Array<string> => {
	switch (statement.kind) {
		case "insert":
			return insertBlock(statement)
		case "update":
			return updateBlock(statement)
		case "delete":
			return deleteBlock(statement)
		case "merge":
			return mergeBlock(statement)
	}
}

const dmlStatementBlock = (statement: Insert | Update | Delete | Merge): Array<string> => [
	...(statement.with === undefined ? [] : withBlock(statement.with)),
	...dmlBlock(statement)
]

const printColumnDef = (column: ColumnDef): string => {
	const parts = [quoteIdent(column.name), printType(column.type)]
	if (column.collation !== undefined) {
		parts.push(`COLLATE ${printObjectName(column.collation)}`)
	}
	if (column.generated !== undefined) {
		parts.push(
			column.generated.kind === "identity"
				? `GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME ${printObjectName(column.generated.sequence)})`
				: `GENERATED ALWAYS AS (${printExpr(column.generated.expr)}) STORED`
		)
	}
	if (column.default !== undefined) {
		parts.push(`DEFAULT ${printExpr(column.default)}`)
	}
	parts.push("NOT NULL")
	return parts.join(" ")
}

const printKeyColumns = (columns: ReadonlyArray<KeyColumn>): string =>
	columns
		.map((c) =>
			c.withoutOverlaps ? `${quoteIdent(c.column)} WITHOUT OVERLAPS` : quoteIdent(c.column)
		)
		.join(", ")

const printForeignKeyColumns = (columns: ReadonlyArray<ForeignKeyColumn>): string =>
	columns
		.map((c) => (c.period ? `PERIOD ${quoteIdent(c.column)}` : quoteIdent(c.column)))
		.join(", ")

const printConstraint = (constraint: TableConstraint): string => {
	const head = `CONSTRAINT ${quoteIdent(constraint.name)}`
	switch (constraint.kind) {
		case "primaryKey":
			return `${head} PRIMARY KEY (${printKeyColumns(constraint.columns)})`
		case "unique":
			return `${head} UNIQUE (${printKeyColumns(constraint.columns)})`
		case "foreignKey": {
			const deferrable =
				constraint.deferrable === undefined ? "" : ` DEFERRABLE ${constraint.deferrable}`
			return `${head} FOREIGN KEY (${printForeignKeyColumns(constraint.columns)}) REFERENCES ${printObjectName(constraint.references)} (${printForeignKeyColumns(constraint.referencedColumns)})${deferrable}`
		}
		case "check":
			return `${head} ${printCheck(constraint.predicate)}`
		case "exclude":
			return `${head} EXCLUDE USING ${constraint.method} (${constraint.elements.map((e) => `${quoteIdent(e.column)} WITH ${e.operator}`).join(", ")})`
	}
}

const printAlterTableAction = (action: AlterTableAction): string => {
	switch (action.kind) {
		case "addColumn":
			return `ADD COLUMN ${printColumnDef(action.column)}`
		case "dropColumn":
			return `DROP COLUMN ${quoteIdent(action.column)}`
		case "dropDefault":
			return `ALTER COLUMN ${quoteIdent(action.column)} DROP DEFAULT`
		case "alterColumnType":
			return `ALTER COLUMN ${quoteIdent(action.column)} TYPE ${printType(action.type)}${action.collation === undefined ? "" : ` COLLATE ${printObjectName(action.collation)}`} USING ${printExpr(action.using)}`
		case "addIdentity":
			return `ALTER COLUMN ${quoteIdent(action.column)} ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME ${printObjectName(action.sequence)})`
		case "dropIdentity":
			return `ALTER COLUMN ${quoteIdent(action.column)} DROP IDENTITY`
		case "addConstraint":
			return `ADD ${printConstraint(action.constraint)}${action.notValid ? " NOT VALID" : ""}`
		case "addConstraintUsingIndex":
			return `ADD CONSTRAINT ${quoteIdent(action.name)} ${action.constraint} USING INDEX ${quoteIdent(action.index)}`
		case "validateConstraint":
			return `VALIDATE CONSTRAINT ${quoteIdent(action.name)}`
		case "dropConstraint":
			return `DROP CONSTRAINT ${quoteIdent(action.name)}`
		case "enableRowSecurity":
			return "ENABLE ROW LEVEL SECURITY"
		case "disableRowSecurity":
			return "DISABLE ROW LEVEL SECURITY"
	}
}

const printAlterDomainAction = (action: AlterDomainAction): string => {
	switch (action.kind) {
		case "addConstraint":
			return `ADD CONSTRAINT ${quoteIdent(action.constraint.name)} ${printCheck(action.constraint.predicate)}${action.notValid ? " NOT VALID" : ""}`
		case "validateConstraint":
			return `VALIDATE CONSTRAINT ${quoteIdent(action.name)}`
		case "dropConstraint":
			return `DROP CONSTRAINT ${quoteIdent(action.name)}`
	}
}

/** ASC, the default, prints bare. */
const printIndexKey = (key: IndexKey): string => {
	const parts = [
		key.key.kind === "column" ? quoteIdent(key.key.column) : `(${printExpr(key.key.expr)})`
	]
	if (key.collation !== undefined) {
		parts.push(`COLLATE ${printObjectName(key.collation)}`)
	}
	if (key.opclass !== undefined) {
		parts.push(printObjectName(key.opclass))
	}
	if (key.direction === "DESC") {
		parts.push(key.direction)
	}
	return parts.join(" ")
}

/** A function by its name and argument types. */
export const printFunctionSignature = (fn: FunctionName): string =>
	`${printObjectName(fn)}(${fn.args.map((t) => printType(t)).join(", ")})`

const printGrantee = (grantee: Grantee): string =>
	grantee.kind === "PUBLIC" ? "PUBLIC" : quoteIdent(grantee.name)

const printGrantObjects = (on: GrantObjects): string => {
	switch (on.kind) {
		case "SCHEMA":
			return `SCHEMA ${printIdentList(on.names)}`
		case "FUNCTION":
			return `FUNCTION ${on.names.map(printFunctionSignature).join(", ")}`
		case "TABLE":
		case "SEQUENCE":
		case "TYPE":
		case "DOMAIN":
			return `${on.kind} ${on.names.map(printObjectName).join(", ")}`
	}
}

const printAlterRoleAction = (action: AlterRoleAction): string => {
	switch (action.kind) {
		case "set":
			return `SET ${action.parameter} = ${quoteString(action.value)}`
		case "reset":
			return `RESET ${action.parameter}`
	}
}

const printTriggerEvent = (event: TriggerEvent): string =>
	event.kind === "UPDATE" ? `UPDATE OF ${printIdentList(event.of)}` : event.kind

/**
 * PERFORM replaces the query's leading SELECT keyword.
 *
 * The USING options align under the first.
 */
const plStatementLines = (statement: PlStatement): Array<string> => {
	switch (statement.kind) {
		case "if": {
			const lines: Array<string> = []
			for (const [i, branch] of statement.branches.entries()) {
				lines.push(
					`${i === 0 ? "IF" : "ELSIF"} ${printExpr(branch.condition)} THEN`,
					...plStatementsIndented(branch.body)
				)
			}
			if (statement.else.length > 0) {
				lines.push("ELSE", ...plStatementsIndented(statement.else))
			}
			lines.push("END IF;")
			return lines
		}
		case "assign":
			return [`${quoteIdent(statement.target)} := ${printExpr(statement.value)};`]
		case "forQuery":
			return [
				`FOR ${quoteIdent(statement.variable)} IN ${printSelectInline(statement.query)} LOOP`,
				...plStatementsIndented(statement.body),
				"END LOOP;"
			]
		case "perform":
			return [`PERFORM ${printSelectInline(statement.query).slice("SELECT ".length)};`]
		case "case": {
			const lines = [`CASE ${printExpr(statement.operand)}`]
			for (const branch of statement.whens) {
				lines.push(
					`${indentUnit}WHEN ${branch.values.map((v) => printExpr(v)).join(", ")} THEN`,
					...indent(plStatementsIndented(branch.body))
				)
			}
			if (statement.else !== undefined) {
				lines.push(`${indentUnit}ELSE`, ...indent(plStatementsIndented(statement.else)))
			}
			lines.push("END CASE;")
			return lines
		}
		case "raise": {
			const head = `RAISE EXCEPTION ${quoteString(statement.message)}`
			if (statement.using.length === 0) {
				return [`${head};`]
			}
			const lead = `${indentUnit}USING `
			const continuation = " ".repeat(lead.length)
			const options = statement.using.map((option, i) => {
				const last = i === statement.using.length - 1
				return `${i === 0 ? lead : continuation}${option.option} = ${printExpr(option.value)}${last ? ";" : ","}`
			})
			return [head, ...options]
		}
		case "return":
			return [`RETURN ${printExpr(statement.value)};`]
	}
}

const plStatementsIndented = (statements: ReadonlyArray<PlStatement>): Array<string> =>
	indent(statements.flatMap(plStatementLines))

export const printPlBlock = (block: PlBlock): string => {
	const lines: Array<string> = []
	if (block.declare.length > 0) {
		lines.push(
			"DECLARE",
			...indent(block.declare.map((d) => `${quoteIdent(d.name)} ${printType(d.type)};`))
		)
	}
	lines.push("BEGIN", ...plStatementsIndented(block.body), "END")
	return lines.join("\n")
}

/**
 * The dollar-quote tag for a body: `$$` unless the body contains it, then `$gz$`, `$gz1$`, `$gz2$`, ... The body is
 * delimited by newlines on both sides, so only an occurrence inside the body can end the quote early.
 */
export const dollarQuoteTag = (body: string): string => {
	if (!body.includes("$$")) {
		return "$$"
	}
	if (!body.includes("$gz$")) {
		return "$gz$"
	}
	for (let n = 1; ; n++) {
		const tag = `$gz${n}$`
		if (!body.includes(tag)) {
			return tag
		}
	}
}

/** A function's parallel safety as its clause, after its volatility: none for UNSAFE, PostgreSQL's own default. */
const parallelClause = (parallel: CreateFunction["parallel"]): string =>
	parallel === "SAFE" ? " PARALLEL SAFE" : ""

const createFunctionLines = (fn: CreateFunction): Array<string> => {
	const head = `CREATE OR REPLACE FUNCTION ${printObjectName(fn.name)}(${fn.params.map((p) => `${quoteIdent(p.name)} ${printType(p.type)}`).join(", ")}) RETURNS ${fn.returns}`
	switch (fn.language) {
		case "plpgsql": {
			const body = printPlBlock(fn.body)
			const tag = dollarQuoteTag(body)
			return [
				head,
				`LANGUAGE plpgsql ${fn.volatility}${parallelClause(fn.parallel)} SECURITY ${fn.security} SET search_path = ${printIdentList(fn.searchPath)} SET plan_cache_mode = ${fn.planCacheMode}`,
				`AS ${tag}`,
				body,
				tag
			]
		}
		case "sql":
			return [
				head,
				`LANGUAGE sql ${fn.volatility}${parallelClause(fn.parallel)} SECURITY ${fn.security} SET search_path = ${printIdentList(fn.searchPath)} SET plan_cache_mode = ${fn.planCacheMode}`,
				`RETURN ${printExpr(fn.body)}`
			]
	}
}

/** What a COMMENT names, as it prints after COMMENT ON, and as `grizzle names` lists it. */
export const printCommentTarget = (on: CommentTarget): string => {
	switch (on.kind) {
		case "SCHEMA":
		case "ROLE":
			return `${on.kind} ${quoteIdent(on.name)}`
		case "TABLE":
		case "VIEW":
		case "MATERIALIZED VIEW":
		case "TYPE":
		case "DOMAIN":
		case "SEQUENCE":
		case "INDEX":
		case "STATISTICS":
			return `${on.kind} ${printObjectName(on.name)}`
		case "COLUMN":
			return `COLUMN ${printObjectName(on.relation)}.${quoteIdent(on.column)}`
		case "CONSTRAINT":
		case "TRIGGER":
		case "POLICY":
			return `${on.kind} ${quoteIdent(on.name)} ON ${printObjectName(on.on)}`
		case "DOMAIN CONSTRAINT":
			return `CONSTRAINT ${quoteIdent(on.name)} ON DOMAIN ${printObjectName(on.domain)}`
		case "FUNCTION":
			return `FUNCTION ${printFunctionSignature(on.name)}`
	}
}

/**
 * An installed table lists one element per line.
 *
 * A carrier is a one-line runtime statement.
 *
 * One clause per line, each after the first indented once.
 *
 * The block reads the database's name (sql/ast.ts AlterDatabaseDefault); `%I` quotes it as an identifier. Every
 * installation in the database sets the same default on the same pg_db_role_setting row, and two that update it at
 * once fail with XX000 (tuple concurrently updated), so the block first takes the database default's
 * transaction-scoped advisory lock: a second installation waits for the first to commit, then sets it again.
 *
 * Under pg_temp, the session's own temporary schema: never a stored relation of the same name.
 */
const statementLines = (statement: SqlStatement): Array<string> => {
	switch (statement.kind) {
		case "select":
			return selectBlock(statement)
		case "insert":
		case "update":
		case "delete":
		case "merge":
			return dmlStatementBlock(statement)
		case "createSchema":
			return [
				`CREATE SCHEMA ${quoteIdent(statement.name)}${statement.authorization === undefined ? "" : ` AUTHORIZATION ${quoteIdent(statement.authorization)}`}`
			]
		case "createTable": {
			const elements = [
				...statement.columns.map(printColumnDef),
				...tableConstraints(statement).map(printConstraint)
			]
			return [
				`CREATE TABLE ${printObjectName(statement.table)} (`,
				...elements.map(
					(element, i) => `${indentUnit}${element}${i === elements.length - 1 ? "" : ","}`
				),
				")"
			]
		}
		case "createCarrier":
			return [
				`CREATE TEMPORARY TABLE ${quoteIdent(statement.name)} (${statement.columns.map(printColumnDef).join(", ")}) ON COMMIT DROP`
			]
		case "alterTable": {
			const head = `ALTER TABLE ${printObjectName(statement.table)}`
			const actions = statement.actions.map(printAlterTableAction)
			if (actions.length === 1) {
				return [`${head} ${actions[0]}`]
			}
			return [
				head,
				...actions.map(
					(action, i) => `${indentUnit}${action}${i === actions.length - 1 ? "" : ","}`
				)
			]
		}
		case "rename":
			return [
				`ALTER ${statement.object} ${statement.object === "ROLE" || statement.object === "SCHEMA" ? quoteIdent(statement.name) : printObjectName(statement.name)} RENAME TO ${quoteIdent(statement.to)}`
			]
		case "renameColumn":
			return [
				`ALTER TABLE ${printObjectName(statement.table)} RENAME COLUMN ${quoteIdent(statement.from)} TO ${quoteIdent(statement.to)}`
			]
		case "renameConstraint":
			return [
				`ALTER TABLE ${printObjectName(statement.table)} RENAME CONSTRAINT ${quoteIdent(statement.from)} TO ${quoteIdent(statement.to)}`
			]
		case "createDomain": {
			const parts = [
				`CREATE DOMAIN ${printObjectName(statement.name)} AS ${printType(statement.base)}`
			]
			if (statement.collation !== undefined) {
				parts.push(`COLLATE ${printObjectName(statement.collation)}`)
			}
			for (const c of statement.constraints) {
				parts.push(`CONSTRAINT ${quoteIdent(c.name)} ${printCheck(c.predicate)}`)
			}
			return [parts.join(" ")]
		}
		case "alterDomain":
			return [
				`ALTER DOMAIN ${printObjectName(statement.name)} ${printAlterDomainAction(statement.action)}`
			]
		case "createEnum":
			return [
				`CREATE TYPE ${printObjectName(statement.name)} AS ENUM (${statement.labels.map(quoteString).join(", ")})`
			]
		case "alterEnumAddValue": {
			const position =
				statement.position === undefined
					? ""
					: ` ${statement.position.kind} ${quoteString(statement.position.label)}`
			const ifNotExists = statement.ifNotExists ? "IF NOT EXISTS " : ""
			return [
				`ALTER TYPE ${printObjectName(statement.name)} ADD VALUE ${ifNotExists}${quoteString(statement.label)}${position}`
			]
		}
		case "alterEnumRenameValue":
			return [
				`ALTER TYPE ${printObjectName(statement.name)} RENAME VALUE ${quoteString(statement.from)} TO ${quoteString(statement.to)}`
			]
		case "createIndex": {
			let text = `CREATE ${statement.unique ? "UNIQUE " : ""}INDEX ${statement.concurrently ? "CONCURRENTLY " : ""}${quoteIdent(statement.name)} ON ${printObjectName(statement.table)} USING ${statement.method} (${statement.keys.map(printIndexKey).join(", ")})`
			if (statement.include.length > 0) {
				text += ` INCLUDE (${printIdentList(statement.include)})`
			}
			if (statement.where !== undefined) {
				text += ` WHERE ${printExpr(statement.where)}`
			}
			return [text]
		}
		case "dropIndex":
			return [
				`DROP INDEX ${statement.concurrently ? "CONCURRENTLY " : ""}${statement.ifExists ? "IF EXISTS " : ""}${printObjectName(statement.name)}`
			]
		case "createMaterializedView":
			return [
				`CREATE MATERIALIZED VIEW ${printObjectName(statement.name)} (${printIdentList(statement.columns)}) AS`,
				...selectBlock(statement.query),
				"WITH NO DATA"
			]
		case "createView":
			return [
				`CREATE VIEW ${printObjectName(statement.name)} (${printIdentList(statement.columns)})${statement.barrier ? " WITH (security_barrier)" : ""} AS`,
				...selectBlock(statement.query)
			]
		case "createPolicy":
			return [
				`CREATE POLICY ${quoteIdent(statement.name)} ON ${printObjectName(statement.table)} AS PERMISSIVE FOR ALL TO ${quoteIdent(statement.role)}`,
				`${indentUnit}USING (${printExpr(statement.filter)})`,
				`${indentUnit}WITH CHECK (${printExpr(statement.filter)})`
			]
		case "dropPolicy":
			return [`DROP POLICY ${quoteIdent(statement.name)} ON ${printObjectName(statement.table)}`]
		case "drop":
			return [
				`DROP ${statement.object} ${statement.ifExists ? "IF EXISTS " : ""}${statement.object === "ROLE" || statement.object === "SCHEMA" ? quoteIdent(statement.name) : printObjectName(statement.name)}`
			]
		case "dropFunction":
			return [
				`DROP FUNCTION ${statement.ifExists ? "IF EXISTS " : ""}${printFunctionSignature(statement.name)}`
			]
		case "dropTrigger":
			return [
				`DROP TRIGGER ${statement.ifExists ? "IF EXISTS " : ""}${quoteIdent(statement.name)} ON ${printObjectName(statement.table)}`
			]
		case "createFunction":
			return createFunctionLines(statement)
		case "createConstraintTrigger":
			return [
				`CREATE CONSTRAINT TRIGGER ${quoteIdent(statement.name)}`,
				`${indentUnit}AFTER ${statement.events.map(printTriggerEvent).join(" OR ")} ON ${printObjectName(statement.table)}`,
				`${indentUnit}DEFERRABLE INITIALLY DEFERRED`,
				`${indentUnit}FOR EACH ROW EXECUTE FUNCTION ${printObjectName(statement.function)}()`
			]
		case "createGuardTrigger":
			return [
				`CREATE TRIGGER ${quoteIdent(statement.name)}`,
				`${indentUnit}BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${printObjectName(statement.table)}`,
				`${indentUnit}FOR EACH STATEMENT EXECUTE FUNCTION ${printObjectName(statement.function)}()`
			]
		case "alterDatabaseDefault":
			return [
				`DO $$BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(${databaseDefaultLock}::int8); EXECUTE format('ALTER DATABASE %I SET ${statement.parameter} = %L'::text, current_database(), '${statement.value}'::text); END$$`
			]
		case "createRole":
			return [
				`CREATE ROLE ${quoteIdent(statement.name)} ${statement.login ? "LOGIN NOINHERIT" : "NOLOGIN"}`
			]
		case "grantRole":
			return [
				`GRANT ${quoteIdent(statement.role)} TO ${quoteIdent(statement.to)} WITH INHERIT FALSE, SET TRUE`
			]
		case "revokeRole":
			return [`REVOKE ${quoteIdent(statement.role)} FROM ${quoteIdent(statement.from)}`]
		case "alterRole":
			return [`ALTER ROLE ${quoteIdent(statement.name)} ${printAlterRoleAction(statement.action)}`]
		case "grant":
			return [
				`GRANT ${statement.privileges.join(", ")} ON ${printGrantObjects(statement.on)} TO ${statement.to.map(printGrantee).join(", ")}`
			]
		case "revoke":
			return [
				`REVOKE ${statement.privileges.join(", ")} ON ${printGrantObjects(statement.on)} FROM ${statement.from.map(printGrantee).join(", ")}`
			]
		case "grantColumns":
			return [
				`GRANT ${statement.privilege} (${printIdentList(statement.columns)}) ON TABLE ${printObjectName(statement.table)} TO ${quoteIdent(statement.to)}`
			]
		case "alterDefaultPrivileges":
			return [
				`ALTER DEFAULT PRIVILEGES${statement.forRole === undefined ? "" : ` FOR ROLE ${quoteIdent(statement.forRole)}`}${statement.inSchema === undefined ? "" : ` IN SCHEMA ${quoteIdent(statement.inSchema)}`} REVOKE ${statement.privileges.join(", ")} ON ${statement.on} FROM ${statement.from.map(printGrantee).join(", ")}`
			]
		case "createExtension":
			return [
				`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(statement.name)} SCHEMA ${quoteIdent(statement.schema)}`
			]
		case "createStatistics": {
			const kinds = statement.statistics.length === 0 ? "" : ` (${statement.statistics.join(", ")})`
			return [
				`CREATE STATISTICS ${printObjectName(statement.name)}${kinds} ON ${printIdentList(statement.columns)} FROM ${printObjectName(statement.table)}`
			]
		}
		case "comment":
			return [`COMMENT ON ${printCommentTarget(statement.on)} IS ${quoteString(statement.text)}`]
		case "lockTable":
			return [
				`LOCK TABLE ${statement.tables.map(printObjectName).join(", ")} IN ${statement.mode} MODE${statement.wait === "nowait" ? " NOWAIT" : ""}`
			]
		case "begin":
			return [`BEGIN ISOLATION LEVEL SERIALIZABLE${statement.readOnly ? " READ ONLY" : ""}`]
		case "commit":
			return ["COMMIT"]
		case "rollback":
			return ["ROLLBACK"]
		case "refresh":
			return [
				`REFRESH MATERIALIZED VIEW ${statement.concurrently ? "CONCURRENTLY " : ""}${printObjectName(statement.view)}`
			]
		case "analyze":
			return [
				`ANALYZE ${statement.carriers.map((name) => printObjectName({ schema: "pg_temp", name })).join(", ")}`
			]
	}
}

/** One statement's text, without a terminator: what a driver sends. */
export const printStatement = (statement: SqlStatement): string =>
	statementLines(statement).join("\n")
