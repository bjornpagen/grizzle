/**
 * What a plan of a statement over several tables offers each scan of a stored table, and what the scan binds of it: the
 * plan-shape law's reading of a rule judge's statements (plan-shape.test.ts), whose tables meet in joins rather than in
 * one WHERE of parameters.
 *
 * A scan's binding is every column of its table that an equality fixes to what the scan can be given before it runs:
 * its own conditions' equalities to a parameter, a constant or another relation's column (a nested loop's inner side
 * parameterized by its outer row's), and a join's equalities over the side the join probes, the inner side of a nested
 * loop, a hash or a merge join, an anti or a semi join's subquery (the side a Right anti or semi join hashes is the
 * other), to a column of a relation outside that side. What it binds is what its index condition fixes of those. Every
 * condition is read as EXPLAIN (VERBOSE) prints it, each column qualified by its relation's alias.
 */

import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"
import type { EstimatedNode } from "#bench/harness/explain.ts"

/** The index of the parenthesis that closes the one at `at`, string literals and quoted names skipped, or -1. */
const closing = (s: string, at: number): number => {
	let depth = 0
	let quote: string | undefined
	for (let i = at; i < s.length; i++) {
		const ch = s[i]
		if (quote !== undefined) {
			if (ch === quote) {
				quote = undefined
			}
		} else if (ch === "'" || ch === '"') {
			quote = ch
		} else if (ch === "(") {
			depth++
		} else if (ch === ")") {
			depth--
			if (depth === 0) {
				return i
			}
		}
	}
	return -1
}

/** `text` without the parentheses that enclose all of it. */
const stripped = (text: string): string => {
	let s = Str.trim(text)
	while (Str.startsWith("(")(s) && closing(s, 0) === s.length - 1) {
		s = Str.trim(Str.slice(1, -1)(s))
	}
	return s
}

/** `s` split at each `separator` outside parentheses, string literals and quoted names. */
const splitTop = (s: string, separator: string): ReadonlyArray<string> => {
	const parts: Array<string> = []
	let depth = 0
	let quote: string | undefined
	let start = 0
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]
		if (quote !== undefined) {
			if (ch === quote) {
				quote = undefined
			}
		} else if (ch === "'" || ch === '"') {
			quote = ch
		} else if (ch === "(") {
			depth++
		} else if (ch === ")") {
			depth--
		} else if (depth === 0 && Str.startsWith(separator, i)(s)) {
			parts.push(Str.slice(start, i)(s))
			start = i + separator.length
			i += separator.length - 1
		}
	}
	parts.push(Str.slice(start)(s))
	return parts
}

/** The conjuncts of a condition, each stripped of its enclosing parentheses, an AND within one split again. */
const conjunctsOf = (condition: string): ReadonlyArray<string> =>
	Arr.flatMap(splitTop(stripped(condition), " AND "), (part) => {
		const inner = stripped(part)
		return splitTop(inner, " AND ").length > 1 ? conjunctsOf(inner) : [inner]
	})

/** A column a condition names, by its relation's alias. */
interface ColumnRef {
	readonly alias: string
	readonly column: string
}

/** A column named `alias.column` or `alias."column"`: none a cast's schema-qualified type, none a function's name. */
const columnRef = regex(
	'(?<![\\w.:"])([a-z_][a-z0-9_]*)\\.("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?!\\s*\\()',
	"g"
)

/** A string literal, its quotes doubled within. */
const stringLiteral = regex("'(?:[^']|'')*'", "g")

/**
 * The columns one side of an equality names, `alias.column` or `alias."column"`: none in a string literal, none a cast's
 * schema-qualified type (`::schema.type`), none a schema-qualified function (`schema.fn(`).
 */
const refsOf = (side: string): ReadonlyArray<ColumnRef> =>
	Arr.map([...Str.matchAll(columnRef)(Str.replaceAll(stringLiteral, "''")(side))], (m) => {
		const column = m[2] ?? ""
		return {
			alias: m[1] ?? "",
			column: Str.startsWith('"')(column)
				? Str.replaceAll('""', '"')(Str.slice(1, -1)(column))
				: column
		}
	})

/**
 * The columns of `alias` a condition's equalities fix, each beside the aliases its other side reads: an equality of a
 * side naming that one column alone, and of another side naming no column of `alias`.
 */
const equatedIn = (
	condition: string,
	alias: string
): ReadonlyArray<{ readonly column: string; readonly others: ReadonlySet<string> }> =>
	Arr.flatMap(conjunctsOf(condition), (c) => {
		const sides = splitTop(c, " = ")
		if (sides.length !== 2) {
			return []
		}
		const [left = "", right = ""] = sides
		return Arr.flatMap(
			[
				[left, right],
				[right, left]
			] as const,
			([mine, other]) => {
				const [only, ...more] = refsOf(mine)
				const theirs = refsOf(other)
				return only !== undefined &&
					more.length === 0 &&
					only.alias === alias &&
					!Arr.some(theirs, (r) => r.alias === alias)
					? [{ column: only.column, others: new Set(Arr.map(theirs, (r) => r.alias)) }]
					: []
			}
		)
	})

/** Every alias a plan's subtree names. */
const aliasesOf = (node: EstimatedNode): ReadonlySet<string> =>
	new Set([...Option.toArray(node.alias), ...Arr.flatMap(node.children, (c) => [...aliasesOf(c)])])

/** A join's conditions, its Join Filter, Hash Cond and Merge Cond. */
const joinConditions = (node: EstimatedNode): ReadonlyArray<string> => [
	...(node.joinFilter.kind === "filter" ? [node.joinFilter.condition] : []),
	...Option.toArray(node.hashCond),
	...Option.toArray(node.mergeCond)
]

/** The child of a join its conditions probe: the inner one, but the first of a Right join's; none of a Full join. */
const probedChild = (node: EstimatedNode): number | undefined => {
	const type = Option.getOrUndefined(node.joinType)
	if (type === undefined || node.children.length !== 2 || type === "Full") {
		return undefined
	}
	return Str.startsWith("Right")(type) ? 0 : 1
}

/** A condition a join offers the scans of the side it probes, and the aliases of that side. */
interface Offered {
	readonly condition: string
	readonly inside: ReadonlySet<string>
}

/** A scan of a stored table: its table and alias, its type, the indexes it reads, its binding and what it binds. */
export interface ScanBinding {
	readonly schema: string
	readonly relation: string
	readonly alias: string
	readonly nodeType: string
	readonly indexes: ReadonlyArray<string>
	readonly binding: ReadonlySet<string>
	readonly bound: ReadonlySet<string>
}

const scanTypes: ReadonlySet<string> = new Set([
	"Seq Scan",
	"Index Scan",
	"Index Only Scan",
	"Bitmap Heap Scan"
])

/** The Bitmap Index Scans a bitmap heap scan reads, through any BitmapAnd or BitmapOr. */
const bitmapIndexScans = (node: EstimatedNode): ReadonlyArray<EstimatedNode> =>
	Arr.flatMap(node.children, (c) =>
		c.nodeType === "Bitmap Index Scan" ? [c] : bitmapIndexScans(c)
	)

/** Every scan of a stored table in a plan, with its binding and what its index conditions bind of it (`ScanBinding`). */
export const scanBindings = (plan: EstimatedNode): ReadonlyArray<ScanBinding> => {
	const visit = (
		node: EstimatedNode,
		offered: ReadonlyArray<Offered>
	): ReadonlyArray<ScanBinding> => {
		const relation = Option.getOrUndefined(node.relation)
		const alias = Option.getOrUndefined(node.alias)
		if (scanTypes.has(node.nodeType) && relation !== undefined && alias !== undefined) {
			const indexScans = node.nodeType === "Bitmap Heap Scan" ? bitmapIndexScans(node) : [node]
			const indexConditions = Arr.flatMap(indexScans, (n) => Option.toArray(n.indexCond))
			const own = [
				...indexConditions,
				...Option.toArray(node.recheckCond),
				...Option.toArray(node.filter)
			]
			const binding = new Set([
				...Arr.flatMap(own, (c) => Arr.map(equatedIn(c, alias), (e) => e.column)),
				...Arr.flatMap(offered, (o) =>
					Arr.flatMap(equatedIn(o.condition, alias), (e) =>
						Arr.some([...e.others], (a) => o.inside.has(a)) ? [] : [e.column]
					)
				)
			])
			return [
				{
					schema: Option.getOrElse(node.schema, () => ""),
					relation,
					alias,
					nodeType: node.nodeType,
					indexes: Arr.flatMap(indexScans, (n) => Option.toArray(n.index)),
					binding,
					bound: new Set(
						Arr.flatMap(indexConditions, (c) => Arr.map(equatedIn(c, alias), (e) => e.column))
					)
				}
			]
		}
		const probed = probedChild(node)
		return Arr.flatMap(node.children, (child, at) => {
			if (at !== probed) {
				return visit(child, offered)
			}
			const inside = aliasesOf(child)
			return visit(child, [
				...offered,
				...Arr.map(joinConditions(node), (condition) => ({ condition, inside }))
			])
		})
	}
	return visit(plan, [])
}
