import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	builtinFunctions,
	type Expr,
	type FromItem,
	type FromSource,
	type OperandSelect,
	overRowsOf,
	type PlBlock,
	returnsSet,
	type SelectCore,
	selectColumns,
	type SqlStatement,
	type Target,
	targetColumnName
} from "#compiler/sql/ast.ts"
import { conjunction } from "#compiler/sql/build.ts"
import {
	type AstHooks,
	holdsPlaceholder,
	identityHooks,
	inertVisitor,
	Transform,
	visitExpr,
	visitLevelExpr
} from "#compiler/sql/transform.ts"

/**
 * Print pulled up: a statement's text states a sub-query of a FROM list only where PostgreSQL plans it as one.
 *
 * PostgreSQL pulls every simple sub-query of a query's FROM list up into that query before it plans it
 * (prepjointree.c pull_up_subqueries, pull_up_simple_subquery): the sub-query's FROM items join the reader's, its WHERE
 * joins the reader's, and every reference to one of its columns reads that column's target expression. A sub-query
 * printed as one is read three times over: parsed and analyzed, copied and translated by the pull-up, then planned
 * flattened all the same. A lowering builds a statement stage by stage, a projection, a filter or a renaming each a
 * level, and those levels were half its text (lane PRINTONCE4: 557 of begin/1's 840 sub-queries, 54% of its bytes). So
 * the printer prints each such sub-query flattened into its reader, as the pull-up makes it: the same query and the
 * same plan, read once.
 *
 * A sub-query is pulled up where PostgreSQL's is_simple_subquery admits it, at a position this printer flattens: an
 * item of a core's own FROM list, not LATERAL (`flattenable`). Simple: its query is one core of no WITH, ORDER BY,
 * LIMIT, OFFSET, DISTINCT, GROUP BY or HAVING, whose targets, one per column its query names (sql/ast.ts
 * selectColumns), call no aggregate, window or set-returning function at its own level and no VOLATILE function at any
 * (`simpleTarget`). Each target must also read the same substituted at each reference to its column (`substitutable`):
 * one holding a placeholder or a sub-query is read exactly once, any other computed one at most once, so the flatten
 * never drops a placeholder from its unit nor prints a sub-query or an expression twice; the references counted are
 * every one the flatten rewrites, the reader's own and its query's ORDER BY, LIMIT and OFFSET (`Clauses`). Two further
 * conditions are the text's own, where a flatten could not keep the statement's meaning: an alias a met source names as
 * the rows beside it, which it reads by name, and an alias two FROM items of the statement declare, which a
 * substitution by name could not tell apart, stay sub-queries (`Pinned`). No reference reads a column unqualified in a
 * query the printer is given: the statement as the lowering built it is held to its scope first (sql/scope.ts
 * assertScoped, 962f3a9fd4), and a set operation's ORDER BY, which names its outputs unqualified, reads names every
 * flatten keeps (`namesKept`).
 * A join chain's sources and a LATERAL sub-query stay sub-queries for now: PostgreSQL pulls them up under conditions of
 * their own (an outer join's nullable side, a lateral reference's level), which the printer does not state yet.
 *
 * The statement's other text never moves: a sub-query's FROM items stand where it stood, so a single statement's units
 * (write/program/single.ts), each a CTE or an arm, keep every placeholder of their own.
 *
 * A flattenable sub-query still printed as one is an internal compiler error (assertPulledUp), the invariant every
 * printed statement is held to beside print once's (sql/print-once.ts printedOnce).
 */

/** A FROM list's sub-query: a derived table. */
type Derived = Extract<FromSource, { readonly kind: "derived" }>

/** What a flatten replaces each reference to a flattened sub-query's column with: its target, by alias, then column. */
type Substitution = ReadonlyMap<string, ReadonlyMap<string, Expr>>

/**
 * What no flatten of a statement may touch (the module header): each alias a met source names as the rows beside it
 * (FromSource `met` rows) or that two FROM items declare.
 */
interface Pinned {
	readonly aliases: ReadonlySet<string>
}

/** The alias a FROM source declares, if it declares one. */
const aliasOf = (source: FromSource): string | undefined => source.alias

/** What `walk`, a walk of one statement or one function body by the hooks it is given, pins (`Pinned`). */
const pinnedBy = (walk: (hooks: AstHooks) => unknown): Pinned => {
	const aliases = new Set<string>()
	const declared = new Set<string>()
	walk({
		...identityHooks,
		fromSource: (source) => {
			if (source.kind === "met") {
				aliases.add(source.rows)
			}
			const alias = aliasOf(source)
			if (alias !== undefined) {
				if (declared.has(alias)) {
					aliases.add(alias)
				}
				declared.add(alias)
			}
			return source
		}
	})
	return { aliases }
}

/**
 * The clauses of the query each core is the body of, by that core: its ORDER BY's expressions, its LIMIT and its
 * OFFSET, which read the core's FROM list as its targets do and which a flatten substitutes as it substitutes them
 * (pullUpHooks `select`), so a flatten counts every reference it rewrites (`referencesIn`), where it counted the core's
 * own alone and substituted a placeholder target its query's ORDER BY read too at both, printing it twice (test/pg/sql/
 * fold, against a twin fenced by OFFSET 0 from every pull-up; test/unit/sql/pull-up's box holds it). A core two queries
 * hold as their body holds the clauses of both; one no query holds as its body, a set operation's arm, holds none.
 */
type Clauses = ReadonlyMap<SelectCore, ReadonlyArray<Expr>>

/** A query's clauses that read its body's FROM list beside the body (`Clauses`). */
const queryClauses = (q: OperandSelect): ReadonlyArray<Expr> => [
	...q.orderBy.map((o) => o.expr),
	...(q.limit === undefined ? [] : [q.limit]),
	...(q.offset === undefined ? [] : [q.offset])
]

/**
 * What `walk`, a walk of one statement or one function body by the hooks it is given, finds of each query's clauses
 * (`Clauses`).
 */
const clausesBy = (walk: (hooks: AstHooks) => unknown): Clauses => {
	const clauses = new Map<SelectCore, ReadonlyArray<Expr>>()
	walk({
		...identityHooks,
		select: (query, original) => {
			if (original.body.kind === "core") {
				clauses.set(original.body, [
					...(clauses.get(original.body) ?? []),
					...queryClauses(original)
				])
			}
			return query
		}
	})
	return clauses
}

/**
 * Whether a target keeps its sub-query simple (is_simple_subquery): no call over rows (an aggregate or a window call)
 * and no set-returning call at its own level, which PostgreSQL's hasAggs, hasWindowFuncs and hasTargetSRFs count, and
 * no VOLATILE call at any level, sub-links' included, as contain_volatile_functions reads a target list.
 */
const simpleTarget = (e: Expr): boolean => {
	let simple = true
	visitLevelExpr(e, (x) => {
		simple &&= overRowsOf(x) === undefined && !returnsSet(x)
	})
	visitExpr(e, {
		...inertVisitor,
		expr: (x) => {
			if (x.kind === "call") {
				simple &&=
					(x.fn.kind === "qualified" ? x.fn.volatility : builtinFunctions[x.fn.name].volatility) !==
					"VOLATILE"
			}
		}
	})
	return simple
}

/**
 * Whether PostgreSQL pulls a sub-query of this query up into its reader where it stands as a FROM item it flattens
 * (prepjointree.c is_simple_subquery, as grizzle's queries meet it): one core of no WITH, ORDER BY, LIMIT, OFFSET,
 * DISTINCT, GROUP BY or HAVING, each target simple (`simpleTarget`). The binding fences every derived table it leaves
 * that is one (sql/bind.ts), so each is planned apart under its alias.
 */
export const simpleQuery = (q: OperandSelect): boolean =>
	q.with === undefined &&
	q.orderBy.length === 0 &&
	q.limit === undefined &&
	q.offset === undefined &&
	q.body.kind === "core" &&
	q.body.distinct === false &&
	q.body.groupBy.length === 0 &&
	q.body.having === undefined &&
	q.body.targets.every((t) => simpleTarget(t.expr))

/** What a flattenable sub-query is flattened from: its one core, and its target by each column its query names. */
interface Flattenable {
	readonly core: SelectCore
	readonly columns: ReadonlyMap<string, Expr>
}

/**
 * What a FROM list's sub-query `item` is flattened from, where it is flattenable (the module header): its targets each
 * under the column its query names it (sql/ast.ts selectColumns), every target one, and every column one target's.
 */
const flattenable = (
	item: Derived,
	pinned: Pinned,
	references: References
): Flattenable | undefined => {
	const q = item.query
	const names = selectColumns(q)
	if (item.lateral || pinned.aliases.has(item.alias) || !simpleQuery(q) || q.body.kind !== "core") {
		return undefined
	}
	const core = q.body
	const read = references.counts.get(item.alias)
	const aggregated = references.aggregated.get(item.alias)
	const own = declaredAliases(core.from)
	const columns = new Map<string, Expr>()
	for (const [at, t] of core.targets.entries()) {
		const column = names[at]
		if (
			column === undefined ||
			!substitutable(t.expr, read?.get(column) ?? 0) ||
			(aggregated?.has(column) === true && !anchored(t.expr, own))
		) {
			return undefined
		}
		columns.set(column, t.expr)
	}
	return columns.size === names.length ? { core, columns } : undefined
}

/** The aliases a FROM list declares, a join chain's sources' among them: what its columns are read under. */
const declaredAliases = (from: ReadonlyArray<FromItem>): ReadonlySet<string> =>
	new Set(
		from.flatMap((item) =>
			item.kind === "joins"
				? [item.first, ...item.steps.map((step) => step.source)].flatMap(sourceAlias)
				: sourceAlias(item)
		)
	)

/** The name a FROM source's columns are read under: its alias, or a CTE's own name where it has none. */
const sourceAlias = (source: FromSource): ReadonlyArray<string> =>
	source.alias !== undefined ? [source.alias] : source.kind === "cte" ? [source.name] : []

/**
 * Whether a target keeps the level of a call over rows its reader reads it in: it reads a column of the sub-query's
 * own FROM items (`own`) at its own level, which the flatten makes the reader's, or no column at all. PostgreSQL
 * places an aggregate at the level of the columns its arguments read, so a target of outer columns alone, a correlated
 * read of the query around the reader, substituted into an aggregate's argument, would make it that query's aggregate,
 * one a FROM item of its own level cannot hold (42803), and a window call read so would range over other rows. Its
 * parse tree keeps the aggregate where it was, so PostgreSQL's own pull-up never meets this; the text the printer
 * writes is parsed anew, so the printer keeps such a sub-query.
 */
const anchored = (e: Expr, own: ReadonlySet<string>): boolean => {
	const read: Array<Expr> = []
	visitExpr(e, {
		...inertVisitor,
		expr: (x) => {
			if (x.kind === "column") {
				read.push(x)
			}
		}
	})
	const ownRead: Array<Expr> = []
	visitLevelExpr(e, (x) => {
		if (x.kind === "column" && x.table !== undefined && own.has(x.table)) {
			ownRead.push(x)
		}
	})
	return read.length === 0 || ownRead.length > 0
}

/** Whether an expression holds a sub-query at its own level: a sub-link, whose query is a level of its own. */
const holdsSubquery = (e: Expr): boolean => {
	let holds = false
	visitLevelExpr(e, (x) => {
		holds ||= x.kind === "exists" || x.kind === "subquery" || x.kind === "array"
	})
	return holds
}

/**
 * Whether a target its reader reads `n` times keeps the reader's text and meaning substituted at each reference: one
 * holding a placeholder or a sub-query read exactly once, since a placeholder no text reads leaves its unit's block of
 * placeholders broken (write/program/single.ts cutTexts) and a sub-query printed twice or never moves print once's count
 * of the CTEs it reads; any other computed one at most once, so no flatten prints an expression twice where its level
 * printed it once; a column or a constant any number of times, no longer than the reference it replaces.
 */
const substitutable = (e: Expr, n: number): boolean => {
	if (e.kind === "column" || e.kind === "literal") {
		return true
	}
	return holdsPlaceholder(e) || holdsSubquery(e) ? n === 1 : n <= 1
}

/**
 * The references a core and its query's clauses (`Clauses`) hold to the columns of the core's FROM list's sub-queries,
 * at any depth: how many to each, by alias then column, and the columns any call over rows (an aggregate or a window
 * call) reads in its arguments.
 */
interface References {
	readonly counts: ReadonlyMap<string, ReadonlyMap<string, number>>
	readonly aggregated: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * The references `core` and `clauses`, its query's, hold to the columns of its FROM list's sub-queries (`References`).
 */
const referencesIn = (core: SelectCore, clauses: ReadonlyArray<Expr>): References => {
	const aliases = new Set(
		core.from.flatMap((item) => (item.kind === "derived" ? [item.alias] : []))
	)
	const counts = new Map<string, Map<string, number>>()
	const aggregated = new Map<string, Set<string>>()
	if (aliases.size === 0) {
		return { counts, aggregated }
	}
	const counting = new Transform({
		...identityHooks,
		expr: (e) => {
			if (e.kind === "column" && e.table !== undefined && aliases.has(e.table)) {
				const of = counts.getOrInsertComputed(e.table, () => new Map<string, number>())
				of.set(e.column, (of.get(e.column) ?? 0) + 1)
			}
			if (overRowsOf(e) !== undefined) {
				visitExpr(e, {
					...inertVisitor,
					expr: (x) => {
						if (x.kind === "column" && x.table !== undefined && aliases.has(x.table)) {
							aggregated.getOrInsertComputed(x.table, () => new Set<string>()).add(x.column)
						}
					}
				})
			}
			return e
		}
	})
	counting.coreChildren(core)
	for (const clause of clauses) {
		counting.expr(clause)
	}
	return { counts, aggregated }
}

/**
 * `rewritten`'s targets under the names `original`'s delivered (sql/ast.ts targetColumnName): a target a substitution
 * rewrote from a bare column, which names its column by the column's own name, keeps that name as its alias. A derived
 * table's and a query CTE's columns are their query's targets' names (sql/ast.ts selectColumns), so a target renamed by
 * a substitution would leave every reference to its column naming a column its query no longer delivers (42703).
 */
const namesKept = (rewritten: SelectCore, original: SelectCore): SelectCore => {
	if (rewritten.targets === original.targets) {
		return rewritten
	}
	const kept = (t: Target, i: number): Target => {
		const before = original.targets[i]
		const name = before === undefined ? undefined : targetColumnName(before)
		return name !== undefined && targetColumnName(t) !== name ? { ...t, alias: name } : t
	}
	return rewritten.distinct === false
		? { ...rewritten, targets: rewritten.targets.map(kept) }
		: { ...rewritten, targets: mapNonEmpty(rewritten.targets, kept) }
}

/**
 * Each reference to a column of a flattened sub-query read as its target (`by`), at any depth, every core it rewrites
 * keeping the names its targets delivered (namesKept).
 */
const substitutionHooks = (by: Substitution): AstHooks => ({
	...identityHooks,
	core: (core, original) => namesKept(core, original),
	expr: (e) =>
		e.kind === "column" && e.table !== undefined ? (by.get(e.table)?.get(e.column) ?? e) : e
})

/** A predicate's conjuncts: an AND's operands, any other predicate itself. */
const conjuncts = (e: Expr): ReadonlyArray<Expr> => (e.kind === "and" ? e.args : [e])

/** A core and its query's clauses (`Clauses`), as a flatten reads and rewrites them. */
interface Reader {
	readonly core: SelectCore
	readonly clauses: ReadonlyArray<Expr>
}

/**
 * `reader`'s core with every flattenable sub-query of its FROM list flattened into it: the sub-query's FROM items in
 * its place, its WHERE conjoined before the core's, and every reference to its columns, at any depth and in its
 * query's clauses, its target; with the substitution it made. None where no sub-query of its FROM list is
 * flattenable. Its sub-queries are flattened first (a transform rewrites children first), so a flattened target
 * already reads through every level below it.
 */
const flattened = (
	{ core, clauses }: Reader,
	pinned: Pinned
): { readonly reader: Reader; readonly by: Substitution } | undefined => {
	const references = referencesIn(core, clauses)
	const by = new Map<string, ReadonlyMap<string, Expr>>()
	const from: Array<FromItem> = []
	const wheres: Array<Expr> = []
	for (const item of core.from) {
		const flat = item.kind === "derived" ? flattenable(item, pinned, references) : undefined
		if (item.kind !== "derived" || flat === undefined) {
			from.push(item)
			continue
		}
		by.set(item.alias, flat.columns)
		for (const inner of flat.core.from) {
			from.push(inner)
		}
		for (const conjunct of flat.core.where === undefined ? [] : conjuncts(flat.core.where)) {
			wheres.push(conjunct)
		}
	}
	if (by.size === 0) {
		return undefined
	}
	const where = conjunction([...wheres, ...(core.where === undefined ? [] : conjuncts(core.where))])
	const substitution = new Transform(substitutionHooks(by))
	return {
		reader: {
			core: namesKept(substitution.coreChildren({ ...core, from, where }), core),
			clauses: clauses.map((clause) => substitution.expr(clause))
		},
		by
	}
}

/**
 * `reader`'s core flattened until no sub-query of its FROM list is flattenable, with each round's substitution in
 * order: a sub-query flattened in brings its own FROM items into the core, whose references the core and its query's
 * clauses, each substituted, now count, a target its flatten dropped among them no longer reading them, so one of them
 * may be flattenable in the core where it was not in the sub-query. Each round removes a sub-query, so the rounds end.
 */
const flattenedFully = (
	reader: Reader,
	pinned: Pinned
): { readonly core: SelectCore; readonly rounds: ReadonlyArray<Substitution> } => {
	const rounds: Array<Substitution> = []
	let current = reader
	for (
		let flat = flattened(current, pinned);
		flat !== undefined;
		flat = flattened(current, pinned)
	) {
		rounds.push(flat.by)
		current = flat.reader
	}
	return { core: current.core, rounds }
}

/**
 * The hooks that print a statement or a function body pulled up (the module header): each core flattened fully beside
 * its query's clauses (`Clauses`, keyed by the core as the statement holds it), and a query whose body is a flattened
 * core reading its ORDER BY, LIMIT and OFFSET through the same substitutions, in order.
 */
const pullUpHooks = (pinned: Pinned, clauses: Clauses): AstHooks => {
	const substituted = new WeakMap<SelectCore, ReadonlyArray<Substitution>>()
	return {
		...identityHooks,
		core: (core, original) => {
			const flat = flattenedFully({ core, clauses: clauses.get(original) ?? [] }, pinned)
			if (flat.rounds.length > 0) {
				substituted.set(flat.core, flat.rounds)
			}
			return flat.core
		},
		select: (query) => {
			const rounds = query.body.kind === "core" ? substituted.get(query.body) : undefined
			if (rounds === undefined) {
				return query
			}
			const through = (e: Expr): Expr =>
				rounds.reduce((read, by) => new Transform(substitutionHooks(by)).expr(read), e)
			return {
				...query,
				orderBy: query.orderBy.map((o) => ({ ...o, expr: through(o.expr) })),
				limit: query.limit === undefined ? undefined : through(query.limit),
				offset: query.offset === undefined ? undefined : through(query.offset)
			}
		}
	}
}

/** A statement printed pulled up (the module header). */
export const pulledUpStatement = (statement: SqlStatement): SqlStatement => {
	const walk = (hooks: AstHooks) => new Transform(hooks).statement(statement)
	return new Transform(pullUpHooks(pinnedBy(walk), clausesBy(walk))).statement(statement)
}

/** A PL/pgSQL function's body printed pulled up (the module header). */
export const pulledUpBlock = (body: PlBlock): PlBlock => {
	const walk = (hooks: AstHooks) => new Transform(hooks).plBlock(body)
	return new Transform(pullUpHooks(pinnedBy(walk), clausesBy(walk))).plBlock(body)
}

/**
 * The hooks that refuse a flattenable sub-query a walk meets (assertPulledUp), each core's references counted with its
 * query's clauses as the flatten counts them.
 */
const refusingHooks = (pinned: Pinned, clauses: Clauses): AstHooks => ({
	...identityHooks,
	core: (core, original) => {
		const references = referencesIn(core, clauses.get(original) ?? [])
		for (const item of core.from) {
			if (item.kind === "derived" && flattenable(item, pinned, references) !== undefined) {
				defect(
					`print pulled up: the sub-query ${item.alias} is simple and stands in its reader's FROM list, so PostgreSQL pulls it up into its reader before it plans; the printer prints it flattened (sql/pull-up.ts)`
				)
			}
		}
		return core
	}
})

/**
 * The invariant every printed statement is held to: no core of it reads in its FROM list a sub-query the printer
 * flattens (`flattenable`). A statement that breaks it is a defect of the printer, never a property of its lowering.
 */
export const assertPulledUp = (statement: SqlStatement): void => {
	const walk = (hooks: AstHooks) => new Transform(hooks).statement(statement)
	new Transform(refusingHooks(pinnedBy(walk), clausesBy(walk))).statement(statement)
}

/** assertPulledUp of a PL/pgSQL block, a function's body or a DO statement's (sql/print-once.ts printedBlock). */
export const assertBlockPulledUp = (block: PlBlock): void => {
	const walk = (hooks: AstHooks) => new Transform(hooks).plBlock(block)
	new Transform(refusingHooks(pinnedBy(walk), clausesBy(walk))).plBlock(block)
}
