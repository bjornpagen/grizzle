import {
	appendNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { Array as Arr, Option, String as Str } from "effect"
import {
	type AlterTableAction,
	bodyPositionNames,
	type Call,
	type ColumnDef,
	type CreateTable,
	type Cte,
	type CteBody,
	type Delete,
	type Expr,
	type FromItem,
	type FromSource,
	type FunctionCall,
	type Insert,
	type Merge,
	type ObjectName,
	type OperandSelect,
	type OrderItem,
	type PlStatement,
	selectColumns,
	type Select,
	type SelectCore,
	type SetOperand,
	type SetOperation,
	type SqlStatement,
	type TableConstraint,
	type Target,
	type TypeRef,
	type Update,
	type WindowSpec
} from "#compiler/sql/ast.ts"
import { isSetQuery, functionColumnNames } from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	cUtf8Collation,
	eq,
	exists,
	lit,
	numericType,
	operandSelect,
	param,
	provedCore,
	select,
	tableCol,
	target,
	targetAs,
	types,
	withArms
} from "#compiler/sql/build.ts"
import { lex, type Token } from "#compiler/sql/lexer.ts"
import { printType, spellingOf } from "#compiler/sql/print.ts"
import type { ScopeEscape } from "#compiler/sql/scope.ts"
import { identityHooks, transformExpr, transformStatement } from "#compiler/sql/transform.ts"
import type { Holes, WildOperator } from "#test/support/kernel/sqlgen.ts"
import { noHoles } from "#test/support/kernel/sqlgen.ts"
import { type auditStatementViolations, meetsStoredRow } from "#test/support/oracle/verify/sql.ts"
import { transformOperand } from "#test/support/sql.ts"

/**
 * The Wild operators of the structural audit (test/support/oracle/verify/sql.ts), and its faithful rewrites.
 *
 * A statement break is one audit rule's Wild operator (the kernel's WildOperator, sqlgen.ts): holes whose every
 * variant breaks exactly that rule and no other, so the audit must report that rule alone. Each injects or edits the
 * smallest fragment that breaks the rule: an injected FROM item is a VALUES list no reference reads, a renamed
 * qualifier names a relation nothing defines, a retyped parameter keeps its index, a dropped list item holds no
 * parameter (a missing parameter would break the numbering too).
 *
 * A faithful rewrite changes a statement in a way PostgreSQL reads alike, or with one clause item more or fewer: the
 * audit must still admit it, and its print must differ where it declares so (every item of a list prints).
 *
 * A text break edits the printed text of an admitted statement at its tokens: the text audit must report exactly the
 * rule broken. Live spellings the text audit must leave alone (keywords inside strings and quoted names, comment and
 * dollar markers inside strings) are drawn by the statement generator itself.
 *
 * Some rules no statement break reaches, because the types make the case unrepresentable and the persisted statement
 * schema (adapter/boundary/sql.ts) admits nothing the types do not: the statement audit's "function" rule (FunctionRef
 * names only the catalogue) and a COLLATE other than pg_catalog.pg_c_utf8 (Collation is that one constant). The text
 * audit's "collation" break below reaches its printed form.
 *
 * A rule of either audit, as a violation names it.
 */
export type AuditRule = ReturnType<typeof auditStatementViolations>[number]["rule"]

/** An escape the printer's scope check refuses (sql/scope.ts), by its kind, as a statement break names the one it plants. */
export type ScopeRule = `scope ${ScopeEscape["kind"]}`

/** What a statement break breaks: a rule of the kernel audit, or the printer's scope by the escape it plants. */
export type BreakRule = AuditRule | ScopeRule

/** Whether a break breaks the printer's scope, which the printer refuses, rather than a rule of the audit. */
export const isScopeRule = (rule: BreakRule): rule is ScopeRule => Str.startsWith("scope ")(rule)

/**
 * The reason the audit's refusal of each rule carries: UnsupportedOperation for SQL the emission discipline forbids,
 * MalformedDescription for a malformed statement. A rule added to the audit does not compile here until it is placed.
 */
export const auditRuleReason: {
	readonly [R in AuditRule]: "UnsupportedOperation" | "MalformedDescription"
} = {
	function: "UnsupportedOperation",
	collation: "UnsupportedOperation",
	null: "UnsupportedOperation",
	outerJoin: "UnsupportedOperation",
	selectStar: "UnsupportedOperation",
	skipLocked: "UnsupportedOperation",
	uncastParam: "UnsupportedOperation",
	untypedLiteral: "UnsupportedOperation",
	checkWithoutIsTrue: "UnsupportedOperation",
	domainCheckRefusingNull: "UnsupportedOperation",
	caseWithoutElse: "UnsupportedOperation",
	identifier: "MalformedDescription",
	literal: "MalformedDescription",
	type: "MalformedDescription",
	param: "MalformedDescription",
	arity: "MalformedDescription",
	naming: "MalformedDescription",
	columnList: "MalformedDescription",
	context: "MalformedDescription",
	positional: "MalformedDescription",
	lex: "MalformedDescription",
	emptyList: "MalformedDescription"
}

export interface StatementBreak extends WildOperator {
	readonly name: StatementBreakName
	readonly rule: BreakRule
}

export interface FaithfulRewrite {
	readonly name: string
	/** The print of a variant against the original statement's. */
	readonly print: "different" | "any"
	readonly holes: Holes
}

export interface TextBreak {
	readonly name: string
	readonly rule: AuditRule
	readonly variants: (text: string) => ReadonlyArray<string>
}

/** Names no statement grizzle builds defines. */
const freshRelation = "r9001"
const freshRelation2 = "r9002"
const freshColumn = "c9001"

/** A column every stored table has, whatever it declares: the system column ctid (columnOfItem). */
const storedColumn = "ctid"

const values = (
	alias: string,
	columns: NonEmptyReadonlyArray<string>,
	row: ReadonlyArray<Expr>
): FromSource => ({
	kind: "values",
	rows: [row],
	alias,
	columns
})

/** A FROM item added to one query core; no reference reads it. */
const injected = (item: FromItem): Holes => ({
	...noHoles,
	core: (c) => [{ ...c, from: [...c.from, item] }]
})

/**
 * Whether `e` holds a placeholder: an expression's, or an input array's in a subquery it holds, which is no expression. A
 * break that removes `e` would remove those uses, and the statement's placeholders would no longer be dense.
 */
const hasParam = (e: Expr): boolean => {
	let found = false
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "param") {
				found = true
			}
			return x
		},
		fromSource: (item) => {
			if (item.kind === "arrays") {
				found = true
			}
			return item
		}
	})
	return found
}

const anyParam = (es: ReadonlyArray<Expr>): boolean => Arr.some(es, hasParam)

/** The value placeholders of a statement, the ones a cast can retype, by index, with how often each occurs. */
const paramCounts = (s: SqlStatement): ReadonlyMap<number, number> => {
	const counts = new Map<number, number>()
	transformStatement(s, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "param") {
				counts.set(e.slot.number, (counts.get(e.slot.number) ?? 0) + 1)
			}
			return e
		}
	})
	return counts
}

/** A set operation's arms with its last arm replaced. */
const withLastArm = (arms: SetOperation["arms"], arm: SetOperand): SetOperation["arms"] => {
	const [a, b, ...rest] = arms
	return Arr.isReadonlyArrayNonEmpty(rest) ? [a, b, ...rest.slice(0, -1).concat([arm])] : [a, arm]
}

/** The aliases a FROM item defines, in order. */
const aliasesOf = (item: FromItem): ReadonlyArray<string> => {
	switch (item.kind) {
		case "table":
		case "probe":
		case "met":
		case "metRows":
		case "enclosing":
		case "transition":
		case "derived":
		case "function":
		case "arrays":
		case "values":
		case "context":
			return [item.alias]
		case "cte":
			return [item.alias ?? item.name]
		case "joins":
			return [
				...aliasesOf(item.first),
				...Arr.flatMap(item.steps, (step) => aliasesOf(step.source))
			]
	}
}

/** The aliases of a statement's stored-table FROM items, in traversal order. */
const tableAliases = (s: SqlStatement): ReadonlyArray<string> => {
	const out: Array<string> = []
	transformStatement(s, {
		...identityHooks,
		fromSource: (item) => {
			if (item.kind === "table") {
				out.push(item.alias)
			}
			return item
		}
	})
	return out
}

/**
 * A data-modifying CTE body and how to put a replacement back. The writes a statement holds are the statement itself
 * and the bodies of its own WITH's data-modifying CTEs, the only places a write may stand.
 */
type Write = Insert | Update | Delete | Merge

interface WriteSite {
	readonly write: Write
	/** Whether it is the statement's own output, whose RETURNING may carry public names. */
	readonly top: boolean
	readonly put: (w: Write) => SqlStatement
}

const isWrite = (body: CteBody): body is Write => body.kind !== "select"

/** `xs` with the element at `at` replaced by `x`. */
const replaceNonEmpty = <A>(
	xs: NonEmptyReadonlyArray<A>,
	at: number,
	x: A
): NonEmptyReadonlyArray<A> => mapNonEmpty(xs, (y, i) => (i === at ? x : y))

const withCte = (s: Select | Write, i: number, cte: Cte) =>
	s.with === undefined
		? s
		: { ...s, with: { ...s.with, ctes: replaceNonEmpty(s.with.ctes, i, cte) } }

const writeSites = (s: SqlStatement): ReadonlyArray<WriteSite> => {
	if (
		s.kind !== "select" &&
		s.kind !== "insert" &&
		s.kind !== "update" &&
		s.kind !== "delete" &&
		s.kind !== "merge"
	) {
		return []
	}
	const own: ReadonlyArray<WriteSite> =
		s.kind === "select" ? [] : [{ write: s, top: true, put: (w) => w }]
	const ctes = Arr.flatMap(s.with?.ctes ?? [], (cte, i): ReadonlyArray<WriteSite> => {
		const body = cte.query
		return isWrite(body)
			? [{ write: body, top: false, put: (w) => withCte(s, i, { ...cte, query: w }) }]
			: []
	})
	return [...own, ...ctes]
}

/** A root hole over every write a statement holds. */
const writes =
	(f: (w: Write, top: boolean) => ReadonlyArray<Write>) =>
	(s: SqlStatement): ReadonlyArray<SqlStatement> =>
		Arr.flatMap(writeSites(s), (site) => Arr.map(f(site.write, site.top), site.put))

const withReturning = (w: Write, returning: ReadonlyArray<Target>): Write => {
	switch (w.kind) {
		case "insert":
			return { ...w, returning }
		case "update":
			return { ...w, returning }
		case "delete":
			return { ...w, returning }
		case "merge":
			return { ...w, returning }
	}
}

/** The data-modifying CTEs of a statement's own WITH, with how to put a replacement back. */
const dataModifying =
	(f: (cte: Cte, body: Write) => ReadonlyArray<Cte>) =>
	(s: SqlStatement): ReadonlyArray<SqlStatement> => {
		if (
			s.kind !== "select" &&
			s.kind !== "insert" &&
			s.kind !== "update" &&
			s.kind !== "delete" &&
			s.kind !== "merge"
		) {
			return []
		}
		return Arr.flatMap(s.with?.ctes ?? [], (cte, i) => {
			const body = cte.query
			return isWrite(body) ? Arr.map(f(cte, body), (c) => withCte(s, i, c)) : []
		})
	}

/** The DDL a statement holds at its root: a CREATE TABLE's columns and constraints, an ALTER TABLE's actions. */
const createTables =
	(f: (t: CreateTable) => ReadonlyArray<CreateTable>) =>
	(s: SqlStatement): ReadonlyArray<SqlStatement> =>
		s.kind === "createTable" ? f(s) : []

const columnDefs =
	(f: (c: ColumnDef) => ReadonlyArray<ColumnDef>) =>
	(s: SqlStatement): ReadonlyArray<SqlStatement> => {
		if (s.kind === "createTable") {
			return Arr.flatMap(s.columns, (c, i) =>
				Arr.map(f(c), (v) => ({ ...s, columns: Arr.map(s.columns, (x, j) => (j === i ? v : x)) }))
			)
		}
		if (s.kind === "alterTable") {
			return Arr.flatMap(s.actions, (a, i) =>
				a.kind === "addColumn"
					? Arr.map(f(a.column), (column): SqlStatement => ({
							...s,
							actions: Arr.map(s.actions, (x, j) => (j === i ? { ...a, column } : x))
						}))
					: []
			)
		}
		return []
	}

const constraints =
	(f: (c: TableConstraint) => ReadonlyArray<TableConstraint>) =>
	(s: SqlStatement): ReadonlyArray<SqlStatement> => {
		if (s.kind === "createTable") {
			return [
				...Arr.flatMap(f(s.primaryKey), (v) =>
					v.kind === "primaryKey" ? [{ ...s, primaryKey: v }] : []
				),
				...Arr.flatMap(s.secondary, (c, i) =>
					Arr.flatMap(f(c), (v) =>
						v.kind === "unique" || v.kind === "exclude" || v.kind === "check"
							? [{ ...s, secondary: s.secondary.with(i, v) }]
							: []
					)
				)
			]
		}
		if (s.kind === "alterTable") {
			return Arr.flatMap(s.actions, (a, i) =>
				a.kind === "addConstraint"
					? Arr.map(f(a.constraint), (constraint): SqlStatement => ({
							...s,
							actions: Arr.map(s.actions, (x, j) => (j === i ? { ...a, constraint } : x))
						}))
					: []
			)
		}
		return []
	}

/** A statement with only its first expression that `pick` rewrites rewritten, or undefined when none is. */
const firstExpr = (
	s: SqlStatement,
	pick: (e: Expr) => Expr | undefined
): SqlStatement | undefined => {
	/** The rewrite made, at most one: every expression after it is kept. */
	const made: Array<Expr> = []
	const out = transformStatement(s, {
		...identityHooks,
		expr: (e) => {
			if (made.length > 0) {
				return e
			}
			const replaced = pick(e)
			if (replaced === undefined) {
				return e
			}
			made.push(replaced)
			return replaced
		}
	})
	return made.length > 0 ? out : undefined
}

const isDdl = (s: SqlStatement): boolean =>
	s.kind === "createTable" ||
	s.kind === "alterTable" ||
	s.kind === "createDomain" ||
	s.kind === "alterDomain"

/** The first statement of a body, at any depth, that `f` rewrites: its position in the body, and the statement there
 * rebuilt around the rewrite. */
const firstPl = (
	body: ReadonlyArray<PlStatement>,
	f: (s: PlStatement) => PlStatement | undefined
): { readonly at: number; readonly statement: PlStatement } | undefined => {
	for (const [at, s] of body.entries()) {
		const replaced = f(s)
		if (replaced !== undefined) {
			return { at, statement: replaced }
		}
		const inner = innerPl(s, f)
		if (inner !== undefined) {
			return { at, statement: inner }
		}
	}
	return undefined
}

/** A body a PL/pgSQL statement holds, with the statement rebuilt around the statement at a position of it replaced. */
interface PlBody {
	readonly body: ReadonlyArray<PlStatement>
	readonly rebuild: (at: number, statement: PlStatement) => PlStatement
}

/** A nonempty list with the item at `at` replaced. */
const replacedAt = <A>(
	list: Arr.NonEmptyReadonlyArray<A>,
	at: number,
	item: A
): Arr.NonEmptyReadonlyArray<A> => Arr.map(list, (x, i) => (i === at ? item : x))

/** The bodies a PL/pgSQL statement holds, in order: an IF's branches and ELSE, a loop's body, an absent probe's
 * obligation, a CASE's WHENs. */
const bodiesOf = (s: PlStatement): ReadonlyArray<PlBody> => {
	switch (s.kind) {
		case "if":
			return [
				...Arr.map(s.branches, (branch, i): PlBody => ({
					body: branch.body,
					rebuild: (at, statement) => ({
						...s,
						branches: replacedAt(s.branches, i, {
							...branch,
							body: branch.body.with(at, statement)
						})
					})
				})),
				{ body: s.else, rebuild: (at, statement) => ({ ...s, else: s.else.with(at, statement) }) }
			]
		case "forQuery":
			return [
				{ body: s.body, rebuild: (at, statement) => ({ ...s, body: s.body.with(at, statement) }) }
			]
		case "whenFound":
		case "wholeReads":
			return [
				{
					body: s.body,
					rebuild: (at, statement) => ({ ...s, body: replacedAt(s.body, at, statement) })
				}
			]
		case "case":
			return Arr.map(s.whens, (when, i): PlBody => ({
				body: when.body,
				rebuild: (at, statement) => ({
					...s,
					whens: replacedAt(s.whens, i, { ...when, body: when.body.with(at, statement) })
				})
			}))
		case "assign":
		case "perform":
		case "modify":
		case "returnQuery":
		case "createSessionTable":
		case "createSessionIndex":
		case "truncateSessionTable":
		case "createSessionTrigger":
		case "raise":
		case "return":
			return []
	}
}

/** The first body of a statement in which `f` rewrites a statement, with the statement rebuilt around it. */
const innerPl = (
	s: PlStatement,
	f: (s: PlStatement) => PlStatement | undefined
): PlStatement | undefined => {
	for (const { body, rebuild } of bodiesOf(s)) {
		const inner = firstPl(body, f)
		if (inner !== undefined) {
			return rebuild(inner.at, inner.statement)
		}
	}
	return undefined
}

const plFunctions =
	(f: (s: PlStatement) => PlStatement | undefined) =>
	(s: SqlStatement): ReadonlyArray<SqlStatement> => {
		if (s.kind !== "createFunction" || s.language !== "plpgsql") {
			return []
		}
		const found = firstPl(s.body.body, f)
		return found === undefined
			? []
			: [{ ...s, body: { ...s.body, body: replacedAt(s.body.body, found.at, found.statement) } }]
	}

/** The NULL-on-empty aggregates the audit refuses in an ungrouped core. */
const nullOnEmpty: ReadonlySet<string> = new Set([
	"sum",
	"avg",
	"min",
	"max",
	"bool_and",
	"bool_or",
	"range_agg",
	"array_agg",
	"jsonb_agg",
	"percentile_disc",
	"percentile_cont",
	"mode"
])

const any = (list: ReadonlyArray<Expr>): boolean => Arr.some(list, holdsNullOnEmpty)

/**
 * Whether an expression holds an unwindowed NULL-on-empty aggregate outside a nested query, which is a core of its own.
 */
const holdsNullOnEmpty = (e: Expr): boolean => {
	switch (e.kind) {
		case "call":
			return (
				(e.over === undefined && e.fn.kind === "builtin" && nullOnEmpty.has(e.fn.name)) ||
				any(e.args) ||
				(e.star
					? e.filter !== undefined && holdsNullOnEmpty(e.filter)
					: any(Arr.map(e.orderBy, (o) => o.expr)))
			)
		case "cast":
		case "collate":
		case "negate":
		case "not":
		case "isTrue":
		case "inQuery":
		case "complement":
		case "lowerAscii":
			return holdsNullOnEmpty(e.expr)
		case "binary":
			return any([e.left, e.right])
		case "equalsAny":
			return any([e.expr, e.array])
		case "nullif":
			return any([e.expr, e.absent])
		case "subscript":
			return any([e.array, e.index])
		case "and":
		case "or":
		case "greatest":
		case "least":
		case "coalesce":
			return any(e.args)
		case "between":
			return any([e.expr, e.low, e.high])
		case "inList":
			return any([e.expr, ...e.list])
		case "row":
			return any(e.items)
		case "case":
			return (
				(e.operand !== undefined && holdsNullOnEmpty(e.operand)) ||
				Arr.some(e.whens, (w) => holdsNullOnEmpty(w.when) || holdsNullOnEmpty(w.result)) ||
				holdsNullOnEmpty(e.else)
			)
		case "exists":
		case "subquery":
		case "array":
		case "column":
		case "excluded":
		case "returning":
		case "param":
		case "clock":
		case "literal":
		case "mergeAction":
		case "domainValue":
		case "user":
		case "plVar":
		case "plSpecial":
		case "field":
		case "regclass":
			return false
		case "attribute":
			return holdsNullOnEmpty(e.record)
	}
}

/** A type's array, where the AST states one: bit(n) has none. */
const arrayTypes = (type: TypeRef): ReadonlyArray<TypeRef> =>
	type.kind === "builtin" && type.name === "bit" ? [] : [{ ...type, array: true }]

const aliasNearMisses = ["v1", "r01", "R1", "r1a", "r-1", "c1", "r"] as const

const refusedIdentifiers = [Str.repeat(64)("t"), "", "a\u0000b", "\ud800"] as const

/** A table of statement breaks as written, each name the literal its entry spells: what StatementBreakName unions. */
const breakTable = <const N extends string>(
	table: Arr.NonEmptyReadonlyArray<WildOperator & { readonly name: N; readonly rule: BreakRule }>
) => table

/**
 * collation
 *
 * null
 *
 * arity
 *
 * scope
 *
 * context
 *
 * param
 *
 * identifier
 *
 * type
 *
 * literal: a number or a boolean the printer spells bare, a constant PostgreSQL types itself, typed as an array is a
 * cast PostgreSQL refuses at analysis (class 42); one it spells quoted (print.ts spellingOf), a string the type's
 * input function reads, is a malformed array literal (22P02).
 *
 * columnList
 *
 * Not c<n>: a public name, and the near misses of the generated form.
 *
 * A PL/pgSQL body holds several statements, each its own scope of aliases, so its first two aliases may
 * be defined once each in two of them.
 *
 * naming
 */
const requiredBreakTable = breakTable([
	{
		name: "a relation alias that is not a generated r<n>",
		rule: "naming",
		holes: {
			...noHoles,
			core: (c) =>
				Arr.map(aliasNearMisses, (alias) => ({
					...c,
					from: [...c.from, values(alias, [freshColumn], [lit.int(1, types.integer)])]
				}))
		}
	},
	{
		name: "a relation alias defined twice",
		rule: "naming",
		holes: {
			...noHoles,
			statement: (s) => {
				if (s.kind === "createFunction") {
					return []
				}
				const [x, y] = tableAliases(s)
				if (x === undefined || y === undefined) {
					return []
				}
				return [
					transformStatement(s, {
						...identityHooks,
						fromSource: (item) =>
							item.kind === "table" && item.alias === x ? { ...item, alias: y } : item,
						expr: (e) => (e.kind === "column" && e.table === x ? { ...e, table: y } : e)
					})
				]
			}
		}
	},
	{
		name: "a nested output named with a public name",
		rule: "naming",
		holes: {
			...noHoles,
			select: (q) => {
				const body = q.body
				if (body.kind !== "core") {
					return []
				}
				return Arr.flatMap(body.from, (item) => {
					if (item.kind !== "derived" || item.query.body.kind !== "core") {
						return []
					}
					const inner = item.query.body
					if (!Arr.isReadonlyArrayNonEmpty(inner.targets)) {
						return []
					}
					const [first, ...rest] = inner.targets
					const old = first.alias
					if (old === undefined) {
						return []
					}
					return Arr.map(
						Arr.filter(
							["Total", "c07", "col1", "r1", "c", "C1"],
							(alias) => !Arr.some(rest, (t) => t.alias === alias)
						),
						(alias) => {
							const targets: NonEmptyReadonlyArray<Target> = [{ ...first, alias }, ...rest]
							const renamed = { ...item, query: { ...item.query, body: { ...inner, targets } } }
							return transformOperand(
								{
									...q,
									body: { ...body, from: Arr.map(body.from, (f) => (f === item ? renamed : f)) }
								},
								{
									...identityHooks,
									expr: (e) =>
										e.kind === "column" && e.table === item.alias && e.column === old
											? { ...e, column: alias }
											: e
								}
							)
						}
					)
				})
			}
		}
	},
	{
		name: "a set operation's arm naming a column other than the set operation's",
		rule: "naming",
		holes: {
			...noHoles,
			select: (q) => {
				if (q.body.kind !== "setOp") {
					return []
				}
				const right = Arr.lastNonEmpty(q.body.arms)
				if (right.kind !== "core" || !Arr.isReadonlyArrayNonEmpty(right.targets)) {
					return []
				}
				const [first, ...rest] = right.targets
				if (Arr.some(right.targets, (t) => t.alias === undefined)) {
					return []
				}
				return [
					{
						...q,
						body: withArms(
							q.body,
							withLastArm(q.body.arms, {
								...right,
								targets: [{ ...first, alias: freshColumn }, ...rest]
							})
						)
					}
				]
			}
		}
	},
	{
		name: "a VALUES list naming a column twice",
		rule: "columnList",
		holes: injected(
			values(freshRelation, ["c1", "c1"], [lit.int(1, types.integer), lit.int(2, types.integer)])
		)
	},
	{
		name: "a data-modifying CTE with an unnamed RETURNING expression, no column reference its column names",
		rule: "columnList",
		holes: {
			...noHoles,
			statement: dataModifying((cte, body) => {
				const returning = body.returning
				return Arr.flatMap(returning, (t, i) =>
					t.alias === undefined || t.expr.kind === "column"
						? []
						: [{ ...cte, query: withReturning(body, returning.with(i, target(t.expr))) }]
				)
			})
		}
	},
	{
		name: "a RETURNING naming one output twice",
		rule: "columnList",
		holes: {
			...noHoles,
			statement: writes((w) => {
				const [first, ...rest] = w.returning
				return first?.alias === undefined ? [] : [withReturning(w, [first, ...rest, first])]
			})
		}
	},
	{
		name: "a table column declared twice",
		rule: "columnList",
		holes: {
			...noHoles,
			statement: createTables((t) => [{ ...t, columns: [...t.columns, ...t.columns.slice(0, 1)] }])
		}
	},
	{
		name: "a scalar literal typed as an array",
		rule: "literal",
		holes: {
			...noHoles,
			expr: (e) =>
				e.kind === "literal" &&
				e.value.kind !== "text" &&
				spellingOf(e.value).kind !== "quoted" &&
				!e.type.array
					? Arr.map(arrayTypes(e.type), (type) => ({ ...e, type }))
					: []
		}
	},
	{
		name: "a quoted number typed as an array",
		rule: "literal",
		holes: {
			...noHoles,
			expr: (e) =>
				e.kind === "literal" &&
				e.value.kind !== "text" &&
				spellingOf(e.value).kind === "quoted" &&
				!e.type.array
					? Arr.map(arrayTypes(e.type), (type) => ({ ...e, type }))
					: []
		}
	},
	{
		name: "a boolean literal typed integer",
		rule: "literal",
		holes: {
			...noHoles,
			expr: (e) =>
				e.kind === "literal" && e.value.kind === "bool" ? [{ ...e, type: types.integer }] : []
		}
	},
	{
		name: "a decimal literal typed integer",
		rule: "literal",
		holes: {
			...noHoles,
			expr: (e) =>
				e.kind === "literal" &&
				e.value.kind === "decimal" &&
				e.value.value !== "NaN" &&
				!Str.endsWith("Infinity")(e.value.value)
					? [{ ...e, type: types.integer }]
					: []
		}
	},
	{
		name: "an integer literal outside its type",
		rule: "literal",
		holes: {
			...noHoles,
			expr: (e) => {
				if (e.kind !== "literal" || e.value.kind !== "int" || e.type.kind !== "builtin") {
					return []
				}
				const past = { smallint: 32768n, integer: 2147483648n, bigint: 9223372036854775808n }
				const name = e.type.name
				return name === "smallint" || name === "integer" || name === "bigint"
					? [{ ...e, value: { kind: "int", value: past[name] } }]
					: []
			}
		}
	},
	{
		name: "a text literal holding NUL or a lone surrogate",
		rule: "literal",
		holes: {
			...noHoles,
			expr: (e) =>
				e.kind === "literal" && e.value.kind === "text"
					? Arr.map(["a\u0000b", "\udc00"], (value): Expr => ({
							...e,
							value: { kind: "text", value }
						}))
					: []
		}
	},
	{
		name: "a numeric precision outside 1..1000",
		rule: "type",
		holes: {
			...noHoles,
			expr: (e) =>
				e.kind === "literal" &&
				e.value.kind === "decimal" &&
				e.type.kind === "builtin" &&
				e.type.name === "numeric" &&
				!e.type.array
					? [{ ...e, type: numericType(1001, undefined) }]
					: [],
			statement: columnDefs((c) =>
				c.type.kind === "builtin" && c.type.precision !== undefined
					? [{ ...c, type: { ...c.type, precision: 1001 } }]
					: []
			)
		}
	},
	{
		name: "a table name the identifier rules refuse",
		rule: "identifier",
		holes: {
			...noHoles,
			fromSource: (f) => {
				if (f.kind !== "table" || typeof f.table === "string") {
					return []
				}
				const stored = f.table
				return Arr.map(refusedIdentifiers, (name) => ({ ...f, table: { ...stored, name } }))
			}
		}
	},
	{
		name: "one use of a repeated parameter cast to another type",
		rule: "param",
		holes: {
			...noHoles,
			statement: (s) => {
				const counts = paramCounts(s)
				const out: Array<SqlStatement> = []
				let met = 0
				const site = (target: number) =>
					transformStatement(s, {
						...identityHooks,
						expr: (e) => {
							if (e.kind !== "param" || (counts.get(e.slot.number) ?? 0) < 2) {
								return e
							}
							return met++ === target
								? { ...e, type: printType(e.type) === "bigint" ? types.text : types.bigint }
								: e
						}
					})
				const repeated = Arr.reduce(
					Arr.filter([...counts.values()], (n) => n > 1),
					0,
					(a, n) => a + n
				)
				for (let i = 0; i < repeated; i++) {
					met = 0
					out.push(site(i))
				}
				return out
			}
		}
	},
	{
		name: "a parameter numbered past a gap",
		rule: "param",
		holes: {
			...noHoles,
			expr: (e) => (e.kind === "param" ? [{ ...e, slot: { ...e.slot, number: 9001 } }] : [])
		}
	},
	{
		name: "a parameter in DDL",
		rule: "context",
		holes: {
			...noHoles,
			statement: (s) => {
				if (!isDdl(s)) {
					return []
				}
				const out = firstExpr(s, (e) => (e.kind === "literal" ? param(1, e.type) : undefined))
				return out === undefined ? [] : [out]
			}
		}
	},
	{
		name: "a subquery in DDL",
		rule: "context",
		holes: {
			...noHoles,
			statement: (s) => {
				if (!isDdl(s)) {
					return []
				}
				const one = select(
					provedCore("oneRow", [targetAs(lit.int(1, types.integer), "c1")], [], undefined)
				)
				const out = firstExpr(s, (e) => (e.kind === "binary" ? and([e, exists(one)]) : undefined))
				return out === undefined ? [] : [out]
			}
		}
	},
	{
		name: "EXCLUDED in a query",
		rule: "context",
		holes: {
			...noHoles,
			select: (q) => {
				if (!isSetQuery(q) || Arr.some(q.with?.ctes ?? [], (c) => c.query.kind !== "select")) {
					return []
				}
				const out = firstExpr(q, (e) =>
					e.kind === "column" && e.table !== undefined
						? { kind: "excluded", column: e.column }
						: undefined
				)
				return out?.kind === "select" ? [out] : []
			}
		}
	},
	{
		name: "old. in an INSERT's RETURNING, which an inserted row lacks",
		rule: "context",
		holes: {
			...noHoles,
			statement: writes((w) => {
				if (w.kind !== "insert") {
					return []
				}
				const returning = w.returning
				return Arr.flatMap(returning, (t, k) =>
					t.expr.kind === "column"
						? [
								withReturning(
									w,
									returning.with(k, {
										...t,
										expr: { kind: "returning", side: "old", column: t.expr.column }
									})
								)
							]
						: []
				)
			})
		}
	},
	{
		name: "old. under IS TRUE in an INSERT that returns no stored row, where every old is NULL",
		rule: "context",
		holes: {
			...noHoles,
			statement: writes((w) => {
				if (w.kind !== "insert" || meetsStoredRow(w)) {
					return []
				}
				const returning = w.returning
				return Arr.flatMap(returning, (t, k) =>
					t.expr.kind === "column"
						? [
								withReturning(
									w,
									returning.with(k, {
										...t,
										expr: {
											kind: "isTrue",
											expr: {
												kind: "binary",
												op: "=",
												left: { kind: "returning", side: "old", column: t.expr.column },
												right: { kind: "returning", side: "new", column: t.expr.column },
												schema: undefined
											}
										}
									})
								)
							]
						: []
				)
			})
		}
	},
	{
		name: "new. in a DELETE's RETURNING, which a deleted row lacks",
		rule: "context",
		holes: {
			...noHoles,
			statement: writes((w) => {
				if (w.kind !== "delete") {
					return []
				}
				const returning = w.returning
				return Arr.flatMap(returning, (t, k) =>
					t.expr.kind === "column"
						? [
								withReturning(
									w,
									returning.with(k, {
										...t,
										expr: { kind: "returning", side: "new", column: t.expr.column }
									})
								)
							]
						: []
				)
			})
		}
	},
	{
		name: "a MERGE's RETURNING naming a row image some returned row lacks",
		rule: "context",
		holes: {
			...noHoles,
			statement: writes((w) => {
				if (w.kind !== "merge" || w.returning.length === 0) {
					return []
				}
				const returning = w.returning
				const sides = [
					...(Arr.some(w.whens, (x) => x.action.kind === "insert") ? (["old"] as const) : []),
					...(Arr.some(w.whens, (x) => x.action.kind === "delete") ? (["new"] as const) : [])
				]
				return Arr.map(sides, (side) => ({
					...w,
					returning: [
						...returning,
						targetAs({ kind: "returning", side, column: "id" }, freshColumn)
					]
				}))
			})
		}
	},
	{
		name: "merge_action(), VALUE or TG_TABLE_NAME where PostgreSQL does not define it",
		rule: "context",
		holes: {
			...noHoles,
			statement: (s) => {
				if (s.kind === "createFunction") {
					return []
				}
				const misplaced: ReadonlyArray<Expr> = [
					{ kind: "mergeAction" },
					{ kind: "domainValue" },
					{ kind: "plSpecial", name: "TG_TABLE_NAME" }
				]
				return Arr.flatMap(misplaced, (m) => {
					const out = firstExpr(s, (e) => (e.kind === "literal" ? m : undefined))
					return out === undefined || isDdl(s) ? [] : [out]
				})
			}
		}
	},
	{
		name: "a data-modifying CTE in a WITH that is not the statement's own",
		rule: "context",
		holes: {
			...noHoles,
			fromSource: (item) => {
				if (item.kind !== "derived") {
					return []
				}
				const table = tableOf(item.query)
				return table === undefined ? [] : [{ ...item, query: withDelete(item.query, table) }]
			},
			expr: (e) => {
				if (e.kind !== "exists" && e.kind !== "subquery" && e.kind !== "inQuery") {
					return []
				}
				const table = tableOf(e.query)
				return table === undefined ? [] : [{ ...e, query: withDelete(e.query, table) }]
			}
		}
	},
	{
		name: "a parenthesized query body whose clauses PostgreSQL would merge with the enclosing query's",
		rule: "context",
		holes: {
			...noHoles,
			select: (q) =>
				q.limit !== undefined && q.orderBy.length === 0 && q.body.kind === "core"
					? [{ ...q, body: { ...operandSelect(q.body), limit: lit.int(5, types.bigint) } }]
					: []
		}
	},
	{
		name: "a column qualified by a relation nothing defines",
		rule: "scope relation",
		holes: {
			...noHoles,
			expr: (e) => (e.kind === "column" && e.table !== undefined ? [{ ...e, table: "r9999" }] : [])
		}
	},
	{
		name: "an unqualified column in a query",
		rule: "scope unqualified",
		holes: {
			...noHoles,
			expr: (e) => (e.kind === "column" && e.table !== undefined ? [tableCol(e.column)] : [])
		}
	},
	{
		name: "a derived table that is not LATERAL naming an earlier FROM entry",
		rule: "scope relation",
		holes: { ...noHoles, core: (c) => siblingReferences(c, false) }
	},
	{
		name: "a write's FROM or USING reading the write's target",
		rule: "scope relation",
		holes: {
			...noHoles,
			statement: writes((w) => {
				const reader = (alias: string) =>
					values(
						freshRelation,
						[freshColumn],
						[{ kind: "column", table: alias, column: storedColumn }]
					)
				if (w.kind === "update" && w.from.length > 0) {
					return [{ ...w, from: [...w.from, reader(w.alias)] }]
				}
				if (w.kind === "delete" && w.using.length > 0) {
					return [{ ...w, using: [...w.using, reader(w.alias)] }]
				}
				return []
			})
		}
	},
	{
		name: "a MERGE WHEN naming the side its match lacks",
		rule: "scope relation",
		holes: {
			...noHoles,
			statement: writes((w) => {
				if (w.kind !== "merge") {
					return []
				}
				const source = aliasesOf(w.using)[0]
				if (source === undefined) {
					return []
				}
				return Arr.flatMap(w.whens, (when, i) => {
					if (when.match === "MATCHED") {
						return []
					}
					const lacking = when.match === "NOT MATCHED" ? w.alias : source
					const reference: Expr = { kind: "column", table: lacking, column: storedColumn }
					const condition =
						when.condition === undefined
							? eq(reference, reference)
							: and([when.condition, eq(reference, reference)])
					const [first, ...rest] = w.whens
					const replaced = { ...when, condition }
					return [
						{ ...w, whens: i === 0 ? [replaced, ...rest] : [first, ...rest.with(i - 1, replaced)] }
					]
				})
			})
		}
	},
	{
		name: "an ORDER BY over a set operation naming no output",
		rule: "scope unlisted",
		holes: {
			...noHoles,
			select: (q) => {
				if (
					q.body.kind === "core" ||
					q.orderBy.length === 0 ||
					Arr.some(bodyPositionNames(q.body), (n) => n === undefined)
				) {
					return []
				}
				const [first, ...rest] = q.orderBy
				return first === undefined
					? []
					: [{ ...q, orderBy: [{ ...first, expr: tableCol(freshColumn) }, ...rest] }]
			}
		}
	},
	{
		name: "a key column that is not a column of the table",
		rule: "scope unlisted",
		holes: {
			...noHoles,
			statement: createTables((t) => {
				const [first, ...rest] = t.primaryKey.columns
				return [
					{
						...t,
						primaryKey: {
							...t.primaryKey,
							columns: [{ ...first, column: "no_such_column" }, ...rest]
						}
					}
				]
			})
		}
	},
	{
		name: "a LATERAL derived table naming a later FROM entry",
		rule: "scope relation",
		holes: { ...noHoles, core: (c) => laterReferences(c) }
	},
	{
		name: "a CTE of a query's own WITH naming that query's FROM entry",
		rule: "scope relation",
		holes: { ...noHoles, select: (q) => holderReferences(q) }
	},
	{
		name: "a column its relation does not list",
		rule: "scope column",
		holes: { ...noHoles, core: (c) => unlistedReferences(c) }
	},
	{
		name: "a join's ON naming a FROM entry before its chain",
		rule: "scope relation",
		holes: { ...noHoles, core: (c) => chainReferences(c) }
	},
	{
		name: "a CTE no WITH in reach binds",
		rule: "scope cte",
		holes: {
			...noHoles,
			fromSource: (item) => (item.kind === "cte" ? [{ ...item, name: freshRelation2 }] : [])
		}
	},
	{
		name: "AND or OR of one operand",
		rule: "arity",
		holes: {
			...noHoles,
			expr: (e) => {
				if (e.kind !== "and" && e.kind !== "or") {
					return []
				}
				const [first, ...rest] = e.args
				return anyParam(rest) ? [] : [{ ...e, args: [first] }]
			}
		}
	},
	{
		name: "set operation arms of different widths",
		rule: "arity",
		holes: {
			...noHoles,
			select: (q) => {
				if (q.body.kind !== "setOp") {
					return []
				}
				const right = Arr.lastNonEmpty(q.body.arms)
				if (right.kind !== "core" || !Arr.isReadonlyArrayNonEmpty(right.targets)) {
					return []
				}
				const [first, ...rest] = right.targets
				const last = rest.at(-1)
				if (last === undefined || hasParam(last.expr)) {
					return []
				}
				const kept: NonEmptyReadonlyArray<Target> = [first, ...rest.slice(0, -1)]
				return [
					{ ...q, body: withArms(q.body, withLastArm(q.body.arms, { ...right, targets: kept })) }
				]
			}
		}
	},
	{
		name: "a VALUES row wider than its column list",
		rule: "arity",
		holes: {
			...noHoles,
			fromSource: (item) => {
				if (item.kind !== "values") {
					return []
				}
				const [first, ...rest] = item.rows
				return [{ ...item, rows: [[...first, lit.int(1, types.integer)], ...rest] }]
			}
		}
	},
	{
		name: "an INSERT whose columns and source differ in width",
		rule: "arity",
		holes: {
			...noHoles,
			statement: writes((w) => {
				if (w.kind !== "insert") {
					return []
				}
				const [first, ...rest] = w.columns
				if (!Arr.isReadonlyArrayNonEmpty(rest)) {
					return []
				}
				const narrower: NonEmptyReadonlyArray<string> = [first, ...rest.slice(0, -1)]
				return [{ ...w, columns: narrower }]
			})
		}
	},
	{
		name: "a negative frame offset",
		rule: "arity",
		holes: {
			...noHoles,
			expr: (e) => {
				if (e.kind !== "call" || e.over?.frame === undefined) {
					return []
				}
				const frame = e.over.frame
				const negated = (b: typeof frame.start): typeof frame.start =>
					b.kind === "offset" ? { ...b, offset: -1n } : b
				const over: WindowSpec = {
					...e.over,
					frame: { start: negated(frame.start), end: negated(frame.end) }
				}
				return frame.start.kind === "offset" || frame.end.kind === "offset" ? [{ ...e, over }] : []
			}
		}
	},
	{
		name: "LEAD or LAG without its default",
		rule: "null",
		holes: {
			...noHoles,
			expr: (e) =>
				e.kind === "call" &&
				!e.star &&
				e.fn.kind === "builtin" &&
				(e.fn.name === "lead" || e.fn.name === "lag") &&
				e.args.length === 3 &&
				!anyParam(e.args.slice(2))
					? [{ ...e, args: e.args.slice(0, 2) }]
					: []
		}
	},
	{
		name: "a NULL-on-empty aggregate in an ungrouped core",
		rule: "null",
		holes: {
			...noHoles,
			core: (c) => {
				if (c.groupBy.length === 0 || anyParam(c.groupBy)) {
					return []
				}
				const holds =
					Arr.some(c.targets, (t) => holdsNullOnEmpty(t.expr)) ||
					(c.having !== undefined && holdsNullOnEmpty(c.having))
				return holds ? [{ ...c, groupBy: [] }] : []
			}
		}
	},
	{
		name: "the fixed collation on a column of a named type",
		rule: "collation",
		holes: {
			...noHoles,
			statement: columnDefs((c) =>
				c.type.kind === "named" && c.collation === undefined
					? [{ ...c, collation: cUtf8Collation }]
					: []
			)
		}
	},
	{
		name: "a text column without the fixed collation",
		rule: "collation",
		holes: {
			...noHoles,
			statement: columnDefs((c) => {
				if (c.type.kind !== "builtin" || c.type.name !== "text" || c.collation === undefined) {
					return []
				}
				return [{ ...c, collation: undefined }]
			})
		}
	},
	{
		name: "an input array's text column without the fixed collation",
		rule: "collation",
		holes: {
			...noHoles,
			fromSource: (item) => {
				if (item.kind !== "arrays") {
					return []
				}
				const source = item.source
				if (source.kind !== "columns") {
					return []
				}
				return Arr.flatMap(source.columns, (c, i) => {
					if (c.definition.collation === undefined) {
						return []
					}
					const columns = Arr.map(source.columns, (other, j) =>
						j === i
							? { ...other, definition: { ...other.definition, collation: undefined } }
							: other
					)
					return [{ ...item, source: { ...source, columns } }]
				})
			}
		}
	}
])

/** The statement breaks of a form only some installations hold, which a Live population may leave unreached. */
const unrequiredBreakTable = breakTable([
	{
		name: "PERIOD on one side of a foreign key",
		rule: "columnList",
		holes: {
			...noHoles,
			statement: constraints((c) => {
				if (c.kind !== "foreignKey") {
					return []
				}
				const own = Option.isSome(Arr.findFirst(c.columns, (x) => x.period))
				const referenced = Option.isSome(Arr.findFirst(c.referencedColumns, (x) => x.period))
				if (own !== referenced) {
					return []
				}
				if (own) {
					const last = c.referencedColumns.length - 1
					return [
						{
							...c,
							referencedColumns: Arr.map(c.referencedColumns, (x, i) =>
								i === last ? { column: x.column, period: false } : x
							)
						}
					]
				}
				const last = c.columns.length - 1
				return [
					{
						...c,
						columns: Arr.map(c.columns, (x, i) =>
							i === last ? { ...x, period: true as const } : x
						)
					}
				]
			})
		}
	},
	{
		name: "a span that is not its key's last column",
		rule: "columnList",
		holes: {
			...noHoles,
			statement: constraints((c) => {
				if (c.kind !== "primaryKey" && c.kind !== "unique") {
					return []
				}
				const span = c.columns.at(-1)
				if (span?.withoutOverlaps !== true || c.columns.length < 2) {
					return []
				}
				return [{ ...c, columns: [span, ...c.columns.slice(0, -1)] }]
			})
		}
	},
	{
		name: "a RAISE message with a % placeholder",
		rule: "literal",
		holes: {
			...noHoles,
			statement: plFunctions((s) =>
				s.kind === "raise" ? { ...s, message: `${s.message} %` } : undefined
			)
		}
	},
	{
		name: "a MERGE's RETURNING naming the source past a NOT MATCHED BY SOURCE",
		rule: "scope relation",
		holes: {
			...noHoles,
			statement: writes((w) => {
				if (
					w.kind !== "merge" ||
					w.returning.length === 0 ||
					!Arr.some(w.whens, (x) => x.match === "NOT MATCHED BY SOURCE")
				) {
					return []
				}
				const source = aliasesOf(w.using)[0]
				return source === undefined
					? []
					: [
							{
								...w,
								returning: [
									...w.returning,
									targetAs({ kind: "column", table: source, column: "c1" }, freshColumn)
								]
							}
						]
			})
		}
	},
	{
		name: "a PL/pgSQL variable that is not declared",
		rule: "scope variable",
		holes: { ...noHoles, expr: (e) => (e.kind === "plVar" ? [{ ...e, name: "undeclared" }] : []) }
	},
	{
		name: "a RAISE option given twice",
		rule: "arity",
		holes: {
			...noHoles,
			statement: plFunctions((s) => {
				if (s.kind !== "raise") {
					return undefined
				}
				const [first] = s.using
				return first === undefined ? undefined : { ...s, using: [...s.using, first] }
			})
		}
	},
	{
		name: "a column converted to text without the fixed collation",
		rule: "collation",
		holes: {
			...noHoles,
			statement: (s) =>
				s.kind === "alterTable"
					? Arr.flatMap(s.actions, (a, i) => {
							if (a.kind !== "alterColumnType" || a.collation === undefined) {
								return []
							}
							const action: AlterTableAction = { ...a, collation: undefined }
							return [{ ...s, actions: Arr.map(s.actions, (x, j) => (j === i ? action : x)) }]
						})
					: []
		}
	},
	{
		name: "a text domain without the fixed collation",
		rule: "collation",
		holes: {
			...noHoles,
			statement: (s) => {
				if (s.kind !== "createDomain" || s.collation === undefined) {
					return []
				}
				return [{ ...s, collation: undefined }]
			}
		}
	}
])

/** The name of a statement break: a misspelt one is a compile error wherever a break is named. */
export type StatementBreakName =
	| (typeof requiredBreakTable)[number]["name"]
	| (typeof unrequiredBreakTable)[number]["name"]

/** The statement breaks a Live population must reach. */
export const requiredStatementBreaks: Arr.NonEmptyReadonlyArray<StatementBreak> = requiredBreakTable

/** The statement breaks a Live population may leave unreached: of a form only some installations hold. */
const unrequiredStatementBreaks: ReadonlyArray<StatementBreak> = unrequiredBreakTable

/** Every statement break: the required ones, then the ones a population may leave unreached. */
export const statementBreaks: Arr.NonEmptyReadonlyArray<StatementBreak> = Arr.appendAll(
	requiredStatementBreaks,
	unrequiredStatementBreaks
)

/** The first stored table a query reads, the target of the DELETE a break plants. */
const tableOf = (q: OperandSelect): ObjectName | undefined => {
	const tables: Array<ObjectName> = []
	transformOperand(q, {
		...identityHooks,
		fromSource: (item) => {
			if (item.kind === "table" && typeof item.table !== "string") {
				tables.push(item.table)
			}
			return item
		}
	})
	return tables[0]
}

/**
 * A query with a data-modifying CTE added to its own WITH: DELETE FROM the table, returning a typed literal, which
 * names no column the table may lack, so PostgreSQL refuses the placement itself (0A000), not a missing column first.
 */
const withDelete = (q: OperandSelect, table: ObjectName): OperandSelect => {
	const del: Delete = {
		kind: "delete",
		table,
		alias: freshRelation2,
		returning: [targetAs(lit.int(1, types.bigint), "c1")],
		with: undefined,
		using: [],
		where: undefined
	}
	const cte: Cte = { name: freshRelation, query: del, materialized: undefined }
	return {
		...q,
		with: {
			recursive: q.with?.recursive === true,
			ctes: appendNonEmpty(q.with === undefined ? [] : q.with.ctes, cte)
		}
	}
}

/**
 * A column a FROM entry defines, qualified by its alias: a stored table's system column ctid, which every table has
 * whatever columns it declares (the audit knows none of them, and PostgreSQL resolves it, so a break PostgreSQL mirrors
 * is refused for the rule it breaks, never for a missing column first); a CTE's are its definition's, which the entry
 * does not hold.
 */
const columnOfItem = (item: FromItem): Expr | undefined => {
	const at = (table: string, column: string | undefined): Expr | undefined =>
		column === undefined ? undefined : { kind: "column", table, column }
	switch (item.kind) {
		case "table":
			return at(item.alias, storedColumn)
		case "derived":
			return at(item.alias, selectColumns(item.query)[0])
		case "values":
			return at(item.alias, item.columns[0])
		case "function":
			return at(item.alias, functionColumnNames(item.columns)[0])
		case "metRows":
			return at(item.alias, item.columns[0].column)
		case "probe":
		case "met":
			return at(item.alias, item.columns[0].as)
		case "arrays":
			return at(
				item.alias,
				item.source.kind === "count" ? undefined : item.source.columns[0].definition.name
			)
		case "context":
			return at(item.alias, item.columns[0].column.name)
		case "cte":
		case "enclosing":
		case "transition":
			return undefined
		case "joins":
			return columnOfItem(item.first)
	}
}

/** A condition `where` narrowed by `reference = reference`, which reads the reference and nothing else. */
const reading = (where: Expr | undefined, reference: Expr): Expr =>
	where === undefined ? eq(reference, reference) : and([where, eq(reference, reference)])

/** The column references of FROM entries, each of an entry that has one (columnOfItem), in order. */
const entryColumns = (items: ReadonlyArray<FromItem>): ReadonlyArray<Expr> =>
	Arr.flatMap(items, (item) => {
		const column = columnOfItem(item)
		return column === undefined ? [] : [column]
	})

/**
 * A core's derived FROM entry, made LATERAL, reading an entry after it, which no FROM item reaches: a fenced step placed
 * before the step it reads.
 */
const laterReferences = (c: SelectCore): ReadonlyArray<SelectCore> => {
	const from = c.from
	return Arr.flatMap(from, (item, j) => {
		if (item.kind !== "derived" || item.query.body.kind !== "core") {
			return []
		}
		const reference = entryColumns(from.slice(j + 1))[0]
		if (reference === undefined) {
			return []
		}
		const body = item.query.body
		const rewritten: FromItem = {
			...item,
			lateral: true,
			query: { ...item.query, body: { ...body, where: reading(body.where, reference) } }
		}
		return [{ ...c, from: from.with(j, rewritten) }]
	})
}

/**
 * A query's own WITH holding a MATERIALIZED CTE that reads an entry of the query's FROM, which the WITH stands before:
 * a CTE held at a row site whose restriction reads an occurrence of the site's own query. MATERIALIZED keeps it a CTE
 * in the print (sql/print-once.ts), where printed in place its query would be correlated into the reference's.
 */
const holderReferences = (q: OperandSelect): ReadonlyArray<OperandSelect> => {
	const w = q.with
	if (w === undefined || q.body.kind !== "core") {
		return []
	}
	const reference = entryColumns(q.body.from)[0]
	if (reference === undefined) {
		return []
	}
	return Arr.flatMap(w.ctes, (cte, i) => {
		const query = cte.query
		if (query.kind !== "select" || query.body.kind !== "core") {
			return []
		}
		const body = query.body
		const held: Cte = {
			...cte,
			materialized: "MATERIALIZED",
			query: { ...query, body: { ...body, where: reading(body.where, reference) } }
		}
		return [{ ...q, with: { ...w, ctes: replaceNonEmpty(w.ctes, i, held) } }]
	})
}

/** A core reading a column of one of its FROM entries that lists its columns, by a name the entry does not list. */
const unlistedReferences = (c: SelectCore): ReadonlyArray<SelectCore> =>
	Arr.flatMap(c.from, (item) =>
		item.kind === "derived" || item.kind === "values"
			? [
					{
						...c,
						where: reading(c.where, { kind: "column", table: item.alias, column: freshColumn })
					}
				]
			: []
	)

/**
 * A core's FROM entry after another, made the first of a join chain whose ON joins one fresh VALUES row reading the
 * entry before it, which only a LATERAL entry reaches: a join's ON reaches its own chain alone. The population joins its
 * first entry only, so the break makes the chain it breaks.
 */
const chainReferences = (c: SelectCore): ReadonlyArray<SelectCore> => {
	const from = c.from
	return Arr.flatMap(from, (item, j) => {
		const reference = entryColumns(from.slice(0, j))[0]
		if (reference === undefined || item.kind === "joins") {
			return []
		}
		const chain: FromItem = {
			kind: "joins",
			first: item,
			steps: [
				{
					kind: "on",
					source: values(freshRelation, [freshColumn], [lit.int(1, types.integer)]),
					on: reading(undefined, reference)
				}
			]
		}
		return [{ ...c, from: from.with(j, chain) }]
	})
}

/** A core's later derived FROM entry reading an earlier entry: as written, or made LATERAL, which may. */
const siblingReferences = (c: SelectCore, lateral: boolean): ReadonlyArray<SelectCore> => {
	const from = c.from
	return Arr.flatMap(from, (item, j) => {
		if (item.kind !== "derived" || item.query.body.kind !== "core" || j === 0) {
			return []
		}
		const reference = Arr.flatMap(from.slice(0, j), (earlier) => {
			const column = columnOfItem(earlier)
			return column === undefined ? [] : [column]
		})[0]
		if (reference === undefined) {
			return []
		}
		const body = item.query.body
		const where =
			body.where === undefined
				? eq(reference, reference)
				: and([body.where, eq(reference, reference)])
		const rewritten: FromItem = {
			...item,
			lateral,
			query: { ...item.query, body: { ...body, where } }
		}
		return [{ ...c, from: from.with(j, rewritten) }]
	})
}

const orderWithoutParams = (items: ReadonlyArray<OrderItem>): boolean =>
	!Arr.some(items, (i) => hasParam(i.expr))

const calls = (f: (c: FunctionCall) => ReadonlyArray<FunctionCall>): Holes => ({
	...noHoles,
	expr: (e) => (e.kind === "call" ? f(e) : [])
})

/** The calls but count(*), the ones that take an aggregate's ORDER BY. */
const plainCalls = (f: (c: Call) => ReadonlyArray<Call>): Holes =>
	calls((c) => (c.star ? [] : f(c)))

/** The aggregates the audit knows as such. */
const aggregates: ReadonlySet<string> = new Set(["count", ...nullOnEmpty])

/** A list's every item removed: the print differs. */
const cleared = (name: string, holes: Holes): FaithfulRewrite => ({
	name,
	print: "different",
	holes
})

/**
 * The query a statement is when its own WITH holds query CTEs only, so parenthesizing it moves no data-modifying CTE
 * out of the statement's own WITH.
 */
const queryOnly = (s: SqlStatement): Select | undefined =>
	s.kind === "select" && Arr.every(s.with?.ctes ?? [], (c) => c.query.kind === "select")
		? s
		: undefined

const ordered = (items: ReadonlyArray<OrderItem>): boolean =>
	items.length > 0 && orderWithoutParams(items)

/** A faithful rewrite: a derived table made LATERAL may read an earlier FROM entry. */
const lateralRewrite: FaithfulRewrite = {
	name: "a later derived FROM entry made LATERAL, reading an earlier one",
	print: "different",
	holes: { ...noHoles, core: (c) => siblingReferences(c, true) }
}

/** Whether `e` is a constant as a query's clauses read one: a literal, or the unary minus of one. */
const isConstant = (e: Expr): boolean =>
	e.kind === "literal" || (e.kind === "negate" && isConstant(e.expr))

/** The constant a rewrite adds to a query's clause: an integer, which PostgreSQL would read bare as a position. */
const clauseConstant = lit.int(1, types.integer)

/** The faithful rewrites a Live population must reach. */
export const requiredFaithfulRewrites: Arr.NonEmptyReadonlyArray<FaithfulRewrite> = [
	cleared("a query ORDER BY's items removed", {
		...noHoles,
		select: (q) =>
			Arr.some(q.orderBy, (item) => !isConstant(item.expr)) && orderWithoutParams(q.orderBy)
				? [{ ...q, orderBy: [] }]
				: []
	}),
	{
		name: "a constant ORDER BY item added, which orders nothing",
		print: "any",
		holes: {
			...noHoles,
			select: (q) =>
				q.orderBy.length > 0 ? [{ ...q, orderBy: [...q.orderBy, asc(clauseConstant)] }] : [],
			statement: (s) =>
				s.kind === "select" && s.body.kind !== "select" && s.orderBy.length === 0
					? [{ ...s, orderBy: [asc(clauseConstant)] }]
					: []
		}
	},
	{
		name: "a constant GROUP BY item added, which separates no group",
		print: "different",
		holes: {
			...noHoles,
			core: (c) => (c.groupBy.length > 0 ? [{ ...c, groupBy: [...c.groupBy, clauseConstant] }] : [])
		}
	},
	{
		name: "a constant leading a DISTINCT ON and the ORDER BY that begins with its items",
		print: "different",
		holes: {
			...noHoles,
			select: (q) =>
				q.body.kind === "core" && typeof q.body.distinct === "object"
					? [
							{
								...q,
								body: { ...q.body, distinct: { on: [clauseConstant, ...q.body.distinct.on] } },
								orderBy: [asc(clauseConstant), ...q.orderBy]
							}
						]
					: []
		}
	},
	cleared(
		"a window PARTITION BY's items removed",
		calls((c) =>
			c.over !== undefined && c.over.partitionBy.length > 0 && !anyParam(c.over.partitionBy)
				? [{ ...c, over: { ...c.over, partitionBy: [] } }]
				: []
		)
	),
	cleared(
		"a window ORDER BY's items removed",
		calls((c) =>
			c.over !== undefined && ordered(c.over.orderBy)
				? [{ ...c, over: { ...c.over, orderBy: [] } }]
				: []
		)
	),
	{
		name: "an aggregate ordered by its first argument",
		print: "different",
		holes: plainCalls((c) => {
			const first = c.args[0]
			return c.fn.kind === "builtin" &&
				aggregates.has(c.fn.name) &&
				c.over === undefined &&
				c.withinGroup.length === 0 &&
				c.orderBy.length === 0 &&
				first !== undefined
				? [{ ...c, orderBy: [asc(first)] }]
				: []
		})
	},
	{
		name: "a query parenthesized as the body of a query with an empty ORDER BY",
		print: "any",
		holes: {
			...noHoles,
			statement: (s) => {
				const q = queryOnly(s)
				return q === undefined ? [] : [select(q)]
			}
		}
	},
	lateralRewrite
]

/** The faithful rewrites a Live population may leave unreached: of a form only some statements hold. */
const unrequiredFaithfulRewrites: ReadonlyArray<FaithfulRewrite> = [
	cleared(
		"an aggregate ORDER BY's items removed",
		plainCalls((c) => (ordered(c.orderBy) ? [{ ...c, orderBy: [] }] : []))
	),
	cleared("an index INCLUDE's columns removed", {
		...noHoles,
		statement: (s) =>
			s.kind === "createIndex" && s.include.length > 0 ? [{ ...s, include: [] }] : []
	})
]

/** Every faithful rewrite: the required ones, then the ones a population may leave unreached. */
export const faithfulRewrites: Arr.NonEmptyReadonlyArray<FaithfulRewrite> = Arr.appendAll(
	requiredFaithfulRewrites,
	unrequiredFaithfulRewrites
)

const tokensOf = (text: string): ReadonlyArray<Token> => lex(text).tokens

const word = (t: Token | undefined): string | undefined =>
	t?.kind === "word" ? t.upper : undefined
const isPunct = (t: Token | undefined, p: string): boolean => t?.kind === "punct" && t.text === p

/**
 * What a statement is, by its first words, as the discipline's exceptions name it: table DDL, whose column
 * definitions may say NOT NULL, and a role's or a function's settings, whose values are bare strings.
 */
type TextShape = "createTable" | "alterTable" | "settings" | "other"

const textShape = (tokens: ReadonlyArray<Token>): TextShape => {
	const [a, b, c, d] = [word(tokens[0]), word(tokens[1]), word(tokens[2]), word(tokens[3])]
	if (a === "CREATE" && (b === "TABLE" || ((b === "TEMPORARY" || b === "TEMP") && c === "TABLE"))) {
		return "createTable"
	}
	if (a === "ALTER" && b === "TABLE") {
		return "alterTable"
	}
	if (a === "ALTER" && b === "ROLE") {
		return "settings"
	}
	if (a === "CREATE" && (b === "FUNCTION" || (b === "OR" && c === "REPLACE" && d === "FUNCTION"))) {
		return "settings"
	}
	return "other"
}

/** The first two words of a text, the kind of statement a feature names. */
export const leadingWords = (text: string): string =>
	Arr.join(
		Arr.map(tokensOf(text).slice(0, 2), (t) => (t.kind === "word" ? t.upper : t.kind)),
		" "
	)

/** The paren depth after each token. */
const depthsAfter = (tokens: ReadonlyArray<Token>): ReadonlyArray<number> => {
	let depth = 0
	return Arr.map(tokens, (t) => {
		if (isPunct(t, "(")) {
			depth += 1
		}
		if (isPunct(t, ")")) {
			depth -= 1
		}
		return depth
	})
}

/**
 * `text` with `inserted` before token `i`, spaced off its neighbours, or on a line of its own past the last token, so
 * no trailing line comment swallows it.
 */
const insertBefore = (
	text: string,
	tokens: ReadonlyArray<Token>,
	i: number,
	inserted: string
): string => {
	const next = tokens[i]
	return next === undefined
		? `${text}\n${inserted}`
		: `${Str.slice(0, next.start)(text)}${inserted} ${Str.slice(next.start)(text)}`
}

const replaceWord = (text: string, t: Extract<Token, { kind: "word" }>, by: string): string =>
	`${Str.slice(0, t.start)(text)}${by}${Str.slice(t.start + t.text.length)(text)}`

/** Every text's tokens. */
const anyText = (): boolean => true

const appended =
	(suffix: string, applies: (tokens: ReadonlyArray<Token>) => boolean) =>
	(text: string): ReadonlyArray<string> =>
		applies(tokensOf(text)) ? [`${text}\n${suffix}`] : []

/** Where a part of a text lies: from its first character up to, not including, `end`. */
interface Span {
	readonly start: number
	readonly end: number
}

/** Whether the token at `at` is pg_catalog's `name`, as the printer qualifies it: `"pg_catalog"."<name>"`. */
const isCatalogName = (tokens: ReadonlyArray<Token>, at: number, name: string): boolean => {
	const t = tokens[at]
	const schema = tokens[at - 2]
	return (
		t?.kind === "quotedIdent" &&
		t.text === name &&
		isPunct(tokens[at - 1], ".") &&
		schema?.kind === "quotedIdent" &&
		schema.text === "pg_catalog"
	)
}

const replaceSpan = (text: string, span: Span, by: string): string =>
	`${Str.slice(0, span.start)(text)}${by}${Str.slice(span.end)(text)}`

/** The index of the ")" closing the "(" at `open`. */
const closing = (tokens: ReadonlyArray<Token>, open: number): number => {
	let depth = 0
	for (let i = open; i < tokens.length; i++) {
		if (isPunct(tokens[i], "(")) {
			depth += 1
		}
		if (isPunct(tokens[i], ")")) {
			depth -= 1
			if (depth === 0) {
				return i
			}
		}
	}
	return -1
}

export const textBreaks: Arr.NonEmptyReadonlyArray<TextBreak> = [
	{
		name: "a bare integer leading a query's GROUP BY, or its ORDER BY at the statement's own level",
		rule: "positional",
		variants: (text) => {
			const tokens = tokensOf(text)
			const depths = depthsAfter(tokens)
			return Arr.flatMap(tokens, (t, i) => {
				const clause = word(tokens[i - 1])
				const leads =
					word(t) === "BY" && (clause === "GROUP" || (clause === "ORDER" && depths[i] === 0))
				return leads ? [insertBefore(text, tokens, i + 1, "1,")] : []
			})
		}
	},
	{
		name: "NOT NULL after a name, outside a column definition",
		rule: "null",
		variants: (text) => {
			const tokens = tokensOf(text)
			const shape = textShape(tokens)
			const depths = depthsAfter(tokens)
			return Arr.flatMap(tokens, (t, i) => {
				if (
					t.kind !== "quotedIdent" ||
					isPunct(tokens[i + 1], ".") ||
					isPunct(tokens[i + 1], "(")
				) {
					return []
				}
				const depth = depths[i] ?? 0
				const columnLevel =
					(shape === "createTable" && depth === 1) || (shape === "alterTable" && depth === 0)
				return columnLevel ? [] : [insertBefore(text, tokens, i + 1, "NOT NULL")]
			})
		}
	},
	{
		name: "a column's NOT NULL weakened to NULL",
		rule: "null",
		variants: (text) => {
			const tokens = tokensOf(text)
			const shape = textShape(tokens)
			if (shape !== "createTable" && shape !== "alterTable") {
				return []
			}
			return Arr.flatMap(tokens, (t, i) => {
				const not = tokens[i - 1]
				return word(t) === "NULL" && not !== undefined && word(not) === "NOT"
					? [`${Str.slice(0, not.start)(text)}${Str.slice(t.start)(text)}`]
					: []
			})
		}
	},
	{
		name: "a SET of a parameter to a bare string outside a role's or a function's settings",
		rule: "untypedLiteral",
		variants: appended("SET jit = 'off'", (tokens) => textShape(tokens) !== "settings")
	},
	{
		name: "RAISE outside PL/pgSQL",
		rule: "untypedLiteral",
		variants: (text) => [`${text}\nRAISE 'x'`, `${text}\nRAISE EXCEPTION 'x'`]
	},
	{
		name: "a RAISE at a level PL/pgSQL does not have",
		rule: "untypedLiteral",
		variants: (text) => {
			const tokens = tokensOf(text)
			if (textShape(tokens) !== "settings") {
				return []
			}
			return Arr.flatMap(tokens, (t) => {
				if (t.kind !== "dollar") {
					return []
				}
				const body = tokensOf(t.body)
				return Arr.flatMap(body, (b, i) =>
					b.kind === "word" && b.upper === "EXCEPTION" && word(body[i - 1]) === "RAISE"
						? [
								`${Str.slice(0, t.bodyStart + b.start)(text)}ERROR${Str.slice(t.bodyStart + b.start + b.text.length)(text)}`
							]
						: []
				)
			})
		}
	},
	{
		name: "a role parameter's value after a word other than SET",
		rule: "untypedLiteral",
		variants: (text) => {
			const tokens = tokensOf(text)
			if (word(tokens[0]) !== "ALTER" || word(tokens[1]) !== "ROLE") {
				return []
			}
			return Arr.flatMap(tokens, (t, i) => {
				if (t.kind !== "word" || t.upper !== "SET") {
					return []
				}
				const plain = tokens[i + 2]?.kind === "operator" && tokens[i + 3]?.kind === "string"
				const qualified =
					isPunct(tokens[i + 2], ".") &&
					tokens[i + 4]?.kind === "operator" &&
					tokens[i + 5]?.kind === "string"
				return plain || qualified ? [replaceWord(text, t, "RESET")] : []
			})
		}
	},
	{
		name: "count(*) with an argument after the star",
		rule: "selectStar",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) =>
				t.kind === "operator" &&
				t.text === "*" &&
				isPunct(tokens[i - 1], "(") &&
				isCatalogName(tokens, i - 2, "count") &&
				isPunct(tokens[i + 1], ")")
					? [insertBefore(text, tokens, i + 1, ", 1")]
					: []
			)
		}
	},
	{
		name: "a star argument of an aggregate other than count",
		rule: "selectStar",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) => {
				const open = tokens[i + 1]
				const star = tokens[i + 2]
				return t.kind === "quotedIdent" &&
					isCatalogName(tokens, i, "count") &&
					open !== undefined &&
					isPunct(open, "(") &&
					star?.kind === "operator" &&
					star.text === "*"
					? [replaceSpan(text, { start: t.start, end: open.start }, '"sum"')]
					: []
			})
		}
	},
	{
		name: "a qualified star in a select list",
		rule: "selectStar",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) =>
				t.kind === "quotedIdent" &&
				isPunct(tokens[i + 1], ".") &&
				tokens[i + 2]?.kind === "quotedIdent" &&
				word(tokens[i - 1]) === "SELECT"
					? [insertBefore(text, tokens, i, '"r1".*,')]
					: []
			)
		}
	},
	{
		name: "an outer join",
		rule: "outerJoin",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) =>
				word(t) === "JOIN"
					? Arr.map(["LEFT", "RIGHT", "FULL", "LEFT OUTER"], (kind) =>
							insertBefore(text, tokens, i, kind)
						)
					: []
			)
		}
	},
	{
		name: "SKIP LOCKED",
		rule: "skipLocked",
		variants: appended("SKIP LOCKED", anyText)
	},
	{
		name: "a parameter parenthesized away from its cast",
		rule: "uncastParam",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) => {
				const cast = tokens[i + 1]
				return t.kind === "param" && cast !== undefined && isPunct(cast, "::")
					? [
							`${Str.slice(0, t.start)(text)}(${Str.slice(t.start, cast.start)(text)})${Str.slice(cast.start)(text)}`
						]
					: []
			})
		}
	},
	{
		name: "a string parenthesized away from its cast",
		rule: "untypedLiteral",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) => {
				const cast = tokens[i + 1]
				return t.kind === "string" &&
					t.prefix === undefined &&
					cast !== undefined &&
					isPunct(cast, "::")
					? [
							`${Str.slice(0, t.start)(text)}(${Str.slice(t.start, cast.start)(text)})${Str.slice(cast.start)(text)}`
						]
					: []
			})
		}
	},
	{
		name: "an alias's column list emptied",
		rule: "emptyList",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) => {
				if (
					!isPunct(t, "(") ||
					tokens[i - 1]?.kind !== "quotedIdent" ||
					word(tokens[i - 2]) !== "AS"
				) {
					return []
				}
				const first = tokens[i + 1]
				const close = tokens[closing(tokens, i)]
				return first !== undefined && close !== undefined && close.start > first.start
					? [`${Str.slice(0, first.start)(text)}${Str.slice(close.start)(text)}`]
					: []
			})
		}
	},
	{
		name: "a CHECK without its IS TRUE",
		rule: "checkWithoutIsTrue",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) => {
				if (word(t) !== "CHECK" || !isPunct(tokens[i + 1], "(") || !isPunct(tokens[i + 2], "(")) {
					return []
				}
				const innerClose = closing(tokens, i + 2)
				const is = tokens[innerClose + 1]
				const outerClose = tokens[innerClose + 3]
				return innerClose !== -1 &&
					word(is) === "IS" &&
					word(tokens[innerClose + 2]) === "TRUE" &&
					is !== undefined &&
					outerClose !== undefined &&
					closing(tokens, i + 1) === innerClose + 3
					? [`${Str.slice(0, is.start)(text)}${Str.slice(outerClose.start)(text)}`]
					: []
			})
		}
	},
	{
		name: "a domain CHECK without its NULL",
		rule: "domainCheckRefusingNull",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) => {
				const value = tokens[i + 2]
				const inner = tokens[i + 6]
				return word(t) === "CHECK" &&
					isPunct(tokens[i + 1], "(") &&
					word(value) === "VALUE" &&
					word(tokens[i + 3]) === "IS" &&
					word(tokens[i + 4]) === "NULL" &&
					word(tokens[i + 5]) === "OR" &&
					value !== undefined &&
					inner !== undefined &&
					isPunct(inner, "(")
					? [`${Str.slice(0, value.start)(text)}${Str.slice(inner.start)(text)}`]
					: []
			})
		}
	},
	{
		name: "a CASE expression without its ELSE",
		rule: "caseWithoutElse",
		variants: (text) => {
			const tokens = tokensOf(text)
			/**
			 * A PL/pgSQL body is one dollar token here, so every CASE and END of the statement's own tokens is an
			 * expression's.
			 */
			const open: Array<{ readonly elseAt: number | undefined }> = []
			const out: Array<string> = []
			for (const [i, t] of tokens.entries()) {
				const w = word(t)
				if (w === "CASE") {
					open.push({ elseAt: undefined })
				} else if (w === "ELSE") {
					const top = open.pop()
					if (top !== undefined) {
						open.push({ elseAt: i })
					}
				} else if (w === "END") {
					const top = open.pop()
					const otherwise = top?.elseAt === undefined ? undefined : tokens[top.elseAt]
					if (otherwise !== undefined) {
						out.push(`${Str.slice(0, otherwise.start)(text)}${Str.slice(t.start)(text)}`)
					}
				}
			}
			return out
		}
	},
	{
		name: "a collation other than pg_catalog.pg_c_utf8",
		rule: "collation",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) => {
				const name = tokens[i + 3]
				return word(t) === "COLLATE" && name?.kind === "quotedIdent" && name.text === "pg_c_utf8"
					? Arr.map(
							['"C"', '"en_US"', '"und-x-icu"'],
							(other) =>
								`${Str.slice(0, name.start)(text)}${other}${Str.slice(name.start + name.text.length + 2)(text)}`
						)
					: []
			})
		}
	},
	{
		name: "a NULL test spelled in any of its forms",
		rule: "null",
		variants: (text) => {
			const tokens = tokensOf(text)
			const where = Arr.findFirstIndex(tokens, (t) => word(t) === "WHERE")
			const next = Option.isSome(where) ? tokens[where.value + 1] : undefined
			if (Option.isNone(where) || next === undefined) {
				return []
			}
			return Arr.map(
				[
					"NULL IS NULL AND",
					"NULL ISNULL AND",
					"NULL IS UNKNOWN AND",
					"1 IS DISTINCT FROM NULL AND",
					"NULL NOTNULL AND"
				],
				(test) => insertBefore(text, tokens, where.value + 1, test)
			)
		}
	},
	{
		name: "RETURNING *",
		rule: "selectStar",
		variants: (text) => {
			const tokens = tokensOf(text)
			return Arr.flatMap(tokens, (t, i) =>
				word(t) === "RETURNING" ? [insertBefore(text, tokens, i + 1, "*,")] : []
			)
		}
	},
	{
		name: "a NULL test inside a PL/pgSQL body",
		rule: "null",
		variants: (text) =>
			Arr.flatMap(tokensOf(text), (t) => {
				if (t.kind !== "dollar") {
					return []
				}
				return Arr.flatMap(tokensOf(t.body), (b) => {
					if (b.kind !== "word" || b.upper !== "IF") {
						return []
					}
					const at = t.bodyStart + b.start + b.text.length
					return [`${Str.slice(0, at)(text)} NULL IS NULL AND${Str.slice(at)(text)}`]
				})
			})
	},
	{
		name: "an unterminated string",
		rule: "lex",
		variants: appended("'unterminated", anyText)
	}
]
