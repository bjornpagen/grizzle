/**
 * grizzle's library (ir/physical.ts LibraryFn): the SQL functions of its own a scalar operation's SQL calls, each a
 * constant of parameters (sql/ast.ts LibraryConstant), `LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE RETURN <body>`,
 * STRICT exactly where the host term over it is (strictOf), its body this module's, named by its definition's digest,
 * its strictness among it (core/identity.ts libraryFunction), which an installation installs
 * where a persistent expression of its schema calls it (`libraryCalls`), after its schema and before every object that
 * calls it, as every constant is (physical/ddl/context.ts addConstant), and revoked from PUBLIC, so a role is granted
 * EXECUTE on it as on every constant it may call (physical/ddl/roles.ts).
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	flatMapNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { xmlSchemaBlocks } from "@bjornpagen/grizzle-text/regex/xml"
import { xsdCategoryNames } from "@bjornpagen/grizzle-text/regex/xsd"
import { everyProperty } from "#compiler/core/canonical.ts"
import { millisPerDay, wallCycle } from "#compiler/core/clock.ts"
import { constantDigest } from "#compiler/core/fingerprint.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import { type LibraryFn, libraryFns } from "#compiler/ir/physical.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { persistentExprs } from "#compiler/physical/ddl/constants.ts"
import { constantRevoke, type InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { libraryOf, nativeOp, nativeOps, nullRules } from "#compiler/scalar/compute/registry.ts"
import { digestPartOf } from "#compiler/scalar/variant-digest.ts"
import type {
	Expr,
	FrameBound,
	FromItem,
	FromSource,
	Cte,
	FunctionParam,
	LibraryConstant,
	OperandSelect,
	QualifiedFunctionRef,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	and,
	arrayOf,
	asc,
	binary,
	call,
	cast,
	col,
	core,
	countStar,
	cte,
	cteRef,
	cUtf8Collation,
	derived,
	desc,
	eq,
	firstNonNull,
	ge,
	gt,
	isIn,
	le,
	lit,
	lt,
	ne,
	not,
	notExists,
	operandSelect,
	operandUnionAll,
	or,
	param,
	provedCore,
	select,
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import { freshNames, NameSupply } from "#compiler/sql/naming.ts"
import { inertVisitor, visitExpr } from "#compiler/sql/transform.ts"

/** A library function's body: its parameters, read by position in it, its result type and its expression. */
interface LibraryBody {
	readonly params: ReadonlyArray<FunctionParam>
	readonly returns: TypeRef
	readonly body: Expr
}

/** A library function's definition: its body, and whether it is STRICT (strictOf). */
interface LibraryDefinition extends LibraryBody {
	readonly strict: boolean
}

const text = (value: string): Expr => lit.text(value, types.text)
const integer = (value: number): Expr => lit.int(value, types.integer)
const length = (x: Expr): Expr => call("char_length", [x])
/** Whether a part holds any character: a component it stands for is stated, its delimiter at least. */
const stated = (part: Expr): Expr => gt(length(part), integer(0))
const unstated = (part: Expr): Expr => eq(length(part), integer(0))
const concat = (first: Expr, ...rest: ReadonlyArray<Expr>): Expr =>
	rest.reduce((joined, next) => binary("||", joined, next), first)
/** The sum of integers, left to right. */
const sumOf = ([first, ...rest]: NonEmptyReadonlyArray<Expr>): Expr =>
	rest.reduce((sum, next) => binary("+", sum, next), first)
const when = (condition: Expr, then: Expr, otherwise: Expr): Expr => ({
	kind: "case",
	operand: undefined,
	whens: [{ when: condition, result: then }],
	else: otherwise
})
/** The text before `x`'s first `delimiter`, all of it where it holds none. */
const before = (x: Expr, delimiter: string): Expr =>
	call("split_part", [x, text(delimiter), integer(1)])
/** `x` from its character `at`, counted from 1, to its end: none past its end. */
const from = (x: Expr, at: Expr): Expr => call("substring", [x, at])
/** `x` from its first `delimiter` on, the delimiter included: none where it holds none. */
const fromFirst = (x: Expr, delimiter: string): Expr =>
	from(x, binary("+", length(before(x, delimiter)), integer(1)))

/** Named columns of a derived table or a step: each the name the body reads it by and its value. */
type Columns = NonEmptyReadonlyArray<readonly [string, Expr]>

/** A name origin of the library: a body's relation or column, by what it holds. */
const internal = (purpose: string) => ({ kind: "internal", purpose: `library ${purpose}` }) as const

/**
 * A relation of a library body: its alias and its columns, each minted by the body's name supply (sql/naming.ts
 * NameSupply), as every statement grizzle emits names its relations and columns, so no name a body holds is a name a
 * caller or another body could hold, and the structural audit reads every one as generated. The body reads each column
 * by the name it states it by (`read`), which no SQL spells.
 */
interface Named {
	readonly alias: string
	/** The minted columns, in the order the body states them. */
	readonly columns: NonEmptyReadonlyArray<string>
	/** The minted name of the column the body states as `name`. */
	readonly column: (name: string) => string
	/** The column the body states as `name`, read through the relation's alias. */
	readonly read: (name: string) => Expr
}

/** A relation of `what`, of the columns the body states as `heading`, its alias and each column minted by `names`. */
const relationOf = (
	names: NameSupply,
	what: string,
	heading: NonEmptyReadonlyArray<string>
): Named => {
	const alias = names.relation(internal(what))
	const columns = mapNonEmpty(heading, (name) => names.column(internal(`${what} ${name}`)))
	const minted = new Map(heading.map((name, i) => [name, columns[i]] as const))
	const column = (name: string): string =>
		defined(minted.get(name), `the column ${name} of the library's ${what}`)
	return { alias, columns, column, read: (name) => col(alias, column(name)) }
}

/** A derived table and its columns as the body reads them (`Named`). */
interface Table {
	readonly source: FromSource
	readonly read: (name: string) => Expr
}

/**
 * `relation` as a derived table of `columns` over `sources`, `(SELECT … FROM sources) AS alias(columns)`, LATERAL where
 * it reads the sources before it, each column the relation's own, which states them in the same order.
 */
const tableOf = (
	relation: Named,
	columns: Columns,
	sources: ReadonlyArray<FromItem>,
	lateral: boolean
): Table => ({
	source: derived(
		operandSelect(
			core(
				columns.map(([name, value]) => targetAs(value, relation.column(name))),
				sources,
				undefined
			)
		),
		relation.alias,
		lateral
	),
	read: relation.read
})

/** A derived table of `what` over `sources` (`tableOf`), its names minted by `names`. */
const table = (
	names: NameSupply,
	what: string,
	columns: Columns,
	sources: ReadonlyArray<FromItem>,
	lateral: boolean
): Table =>
	tableOf(
		relationOf(
			names,
			what,
			mapNonEmpty(columns, ([name]) => name)
		),
		columns,
		sources,
		lateral
	)

/** One row of `columns` over the sources before it, `LATERAL (SELECT …) AS alias(columns)`, or over none. */
const step = (names: NameSupply, what: string, columns: Columns, lateral: boolean): Table =>
	table(names, what, columns, [], lateral)

/** A window's rows: from `start` to `end`, the segments in order. */
interface Frame {
	readonly start: FrameBound
	readonly end: FrameBound
}

/** Every row from the first through this one. */
const throughHere: Frame = { start: { kind: "unboundedPreceding" }, end: { kind: "currentRow" } }

/** Every row after this one. */
const afterHere: Frame = {
	start: { kind: "offset", offset: 1n, direction: "FOLLOWING" },
	end: { kind: "unboundedFollowing" }
}

/** The window function `name` of `arg` over the rows `frame` names, the segments in order of `order`. */
const windowed = (name: "sum" | "min", arg: Expr, frame: Frame, order: Expr): Expr => ({
	...call(name, [arg]),
	over: { ...windowOf([], [asc(order)]), frame }
})

/** Whether `segment` is a dot segment, `.` or `..`. */
const dotSegment = (segment: Expr): Expr => ({
	kind: "inList",
	expr: segment,
	list: [text("."), text("..")],
	not: false
})

/**
 * remove_dot_segments (RFC 3986 §5.2.4) of the path `input`, over its segments, `string_to_table(input, '/') WITH
 * ORDINALITY`, each `t` numbered `k` from 1, as a LATERAL one-row table of `path`, the path without its dot segments,
 * the units that survive in order, every other read as the empty text (NULL where `input` has no segment, the empty
 * path's, which its reader reads as the empty text), and `climbs`, how
 * many of its `..` segments climbed past its root, each one that found no segment before it to remove, which the RFC
 * drops (@bjornpagen/grizzle-text uri.ts `walked`): the loop of rules A to E is a stack of the units it moves to its
 * output buffer, each segment pushing one, popping one, or neither, so the output is every unit no later pop removes,
 * in order.
 *
 * - While every segment before it is `.` or `..` (`lead`: rule A strips those a `/` follows, rule D the last), a
 *   segment pushes itself, slashless, unless it is one of them: rule E's first move of a path that does not begin
 *   with `/`, which an empty first segment, one that does, pushes harmlessly beneath every other. A leading `..`
 *   climbs.
 * - After it, a `.` pushes `/` where it is the last segment and nothing otherwise (rule B), a `..` pops and pushes `/`
 *   where it is the last (rule C), and any other segment pushes `/` and itself (rule E).
 *
 * A push survives where no later run of segments pops more than it pushes: with `n` the running count of pushes less
 * pops, unclamped, the push of a segment survives where every later segment's count before its push (`n` less its
 * own push) is at least its own `n`, so the empty stack a pop leaves alone needs no case. A pop climbs where it finds
 * no unit but the empty one a leading empty segment pushes, the output then empty: with `m` the running count of the
 * units that hold characters less pops, taken after the segment's pop and before its push, a pop climbs where `m` is
 * below zero. The segments are read once, by each window and by the aggregate, so the work is the path's length and
 * the sort of its segments, and no regular expression is read.
 */
const dotSegmentWalk = (names: NameSupply, input: Expr): Table => {
	const split = relationOf(names, "path segments", ["t", "k"])
	const segments: FromSource = {
		kind: "function",
		call: call("string_to_table", [input, text("/")]),
		alias: split.alias,
		columns: { kind: "named", names: split.columns, ordinality: true },
		lateral: false
	}
	const s = split.read
	const counted = table(
		names,
		"counted segments",
		[
			["t", s("t")],
			["k", s("k")],
			["dot", dotSegment(s("t"))],
			["count", { ...countStar(), over: windowOf([], []) }],
			[
				"plain",
				windowed("sum", when(dotSegment(s("t")), integer(0), integer(1)), throughHere, s("k"))
			]
		],
		[segments],
		false
	)
	const g = counted.read
	const led = table(
		names,
		"led segments",
		[
			["t", g("t")],
			["k", g("k")],
			["dot", g("dot")],
			["last", eq(g("k"), g("count"))],
			["lead", eq(g("plain"), when(g("dot"), integer(0), integer(1)))]
		],
		[counted.source],
		false
	)
	const l = led.read
	const push: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{ when: not(l("dot")), result: integer(1) },
			{ when: l("lead"), result: integer(0) },
			{ when: l("last"), result: integer(1) }
		],
		else: integer(0)
	}
	const moves = table(
		names,
		"segment moves",
		[
			["k", l("k")],
			[
				"unit",
				{
					kind: "case",
					operand: undefined,
					whens: [
						{ when: l("lead"), result: l("t") },
						{ when: l("dot"), result: text("/") }
					],
					else: concat(text("/"), l("t"))
				}
			],
			["push", push],
			["held", when(and([l("lead"), eq(l("t"), text(""))]), integer(0), push)],
			["pop", when(and([not(l("lead")), eq(l("t"), text(".."))]), integer(1), integer(0))],
			["leading", and([l("lead"), eq(l("t"), text(".."))])]
		],
		[led.source],
		false
	)
	const p = moves.read
	const running = table(
		names,
		"running pushes",
		[
			["k", p("k")],
			["unit", p("unit")],
			["push", p("push")],
			["n", windowed("sum", binary("-", p("push"), p("pop")), throughHere, p("k"))],
			[
				"climb",
				or([
					p("leading"),
					and([
						eq(p("pop"), integer(1)),
						lt(
							binary(
								"-",
								windowed("sum", binary("-", p("held"), p("pop")), throughHere, p("k")),
								p("held")
							),
							integer(0)
						)
					])
				])
			]
		],
		[moves.source],
		false
	)
	const n = running.read
	const later = table(
		names,
		"later pushes",
		[
			["k", n("k")],
			["unit", n("unit")],
			["push", n("push")],
			["n", n("n")],
			["climb", n("climb")],
			["later", windowed("min", binary("-", n("n"), n("push")), afterHere, n("k"))]
		],
		[running.source],
		false
	)
	const a = later.read
	const kept = and([eq(a("push"), integer(1)), ge(firstNonNull([a("later"), a("n")]), a("n"))])
	return table(
		names,
		"walked path",
		[
			[
				"path",
				{
					...call("string_agg", [when(kept, a("unit"), text("")), text("")]),
					orderBy: [asc(a("k"))]
				}
			],
			["climbs", { ...countStar(), filter: a("climb") }]
		],
		[later.source],
		true
	)
}

/** The two texts resolveReference splits, the base's parts named `b_…` in a step and the reference's `r_…`. */
const sides = ["b", "r"] as const
type Side = (typeof sides)[number]
const part = (row: Table, side: Side, name: string): Expr => row.read(`${side}_${name}`)
/** A step's columns: `f`'s parts of the base, then of the reference. */
const bothSides = (f: (side: Side) => Columns): Columns =>
	flatMapNonEmpty(sides, (side) =>
		mapNonEmpty(f(side), ([name, value]) => [`${side}_${name}`, value] as const)
	)

/**
 * The resolution of the reference `$2` against the base `$1` (RFC 3986 §5.2.2, strict, then §5.3's recomposition), as
 * @bjornpagen/grizzle-text's uri.ts resolution computes it on the host: its steps, each a one-row FROM item, its
 * `target`, and `climbed`, whether a `..` segment of the path it walks climbed past that path's root, none where it
 * walks none.
 *
 * Each text is split as Appendix B splits a reference, each component with the delimiter that states it, `scheme:`,
 * `//authority`, the path, `?query` and `#fragment`, so a component the text does not state is the empty text, one it
 * states empty its delimiter alone, and the target their concatenation: the fragment from the first `#`, the query from
 * the first `?` before it, the scheme before the first `:` where that is no empty text and holds no `/`, the authority
 * after `//` up to the next `/`, and the path the rest. Each step is one row that reads the steps before it, so no part
 * is computed twice. The target's path is the base's where the reference states no scheme, authority or path, and
 * otherwise its dot segments removed (dotSegmentWalk) from the reference's where it states a scheme or an authority
 * or begins with `/`, or from its merge with the base's (§5.2.3): `/` and it where the base states an authority and an
 * empty path, else the base's up to its last `/` and it.
 */
const resolution = (
	names: NameSupply
): {
	readonly sources: ReadonlyArray<FromSource>
	readonly target: Expr
	readonly climbed: Expr
} => {
	const texts: { readonly [S in Side]: Expr } = {
		b: param(1, types.text),
		r: param(2, types.text)
	}
	const fragments = step(
		names,
		"fragments",
		[
			["b_before", before(texts.b, "#")],
			["r_before", before(texts.r, "#")],
			["r_fragment", fromFirst(texts.r, "#")]
		],
		false
	)
	const queries = step(
		names,
		"queries",
		bothSides((side) => [
			["hier", before(part(fragments, side, "before"), "?")],
			["query", fromFirst(part(fragments, side, "before"), "?")]
		]),
		true
	)
	const heads = step(
		names,
		"heads",
		bothSides((side) => [["head", before(part(queries, side, "hier"), ":")]]),
		true
	)
	const schemes = step(
		names,
		"schemes",
		bothSides((side) => {
			const head = part(heads, side, "head")
			const scheme = when(
				and([
					stated(head),
					lt(length(head), length(part(queries, side, "hier"))),
					eq(length(before(head, "/")), length(head))
				]),
				concat(head, text(":")),
				text("")
			)
			return [["scheme", scheme]]
		}),
		true
	)
	const afters = step(
		names,
		"afters",
		bothSides((side) => [
			[
				"after",
				from(
					part(queries, side, "hier"),
					binary("+", length(part(schemes, side, "scheme")), integer(1))
				)
			]
		]),
		true
	)
	const authorities = step(
		names,
		"authorities",
		bothSides((side) => {
			const after = part(afters, side, "after")
			const authority = when(
				call("starts_with", [after, text("//")]),
				concat(text("//"), before(from(after, integer(3)), "/")),
				text("")
			)
			return [["authority", authority]]
		}),
		true
	)
	const paths = step(
		names,
		"paths",
		bothSides((side) => [
			[
				"path",
				from(
					part(afters, side, "after"),
					binary("+", length(part(authorities, side, "authority")), integer(1))
				)
			]
		]),
		true
	)
	const baseAuthority = part(authorities, "b", "authority")
	const basePath = part(paths, "b", "path")
	const referenceScheme = part(schemes, "r", "scheme")
	const referencePath = part(paths, "r", "path")
	const named = or([stated(referenceScheme), stated(part(authorities, "r", "authority"))])
	const merged = when(
		and([stated(baseAuthority), unstated(basePath)]),
		concat(text("/"), referencePath),
		concat(
			call("left", [
				basePath,
				binary("-", length(basePath), length(before(call("reverse", [basePath]), "/")))
			]),
			referencePath
		)
	)
	const targets = step(
		names,
		"resolved target",
		[
			["scheme", when(stated(referenceScheme), referenceScheme, part(schemes, "b", "scheme"))],
			["authority", when(named, part(authorities, "r", "authority"), baseAuthority)],
			["kept", and([not(named), unstated(referencePath)])],
			[
				"input",
				when(or([named, call("starts_with", [referencePath, text("/")])]), referencePath, merged)
			]
		],
		true
	)
	const kept = targets.read("kept")
	const query = when(
		and([kept, unstated(part(queries, "r", "query"))]),
		part(queries, "b", "query"),
		part(queries, "r", "query")
	)
	const walk = dotSegmentWalk(names, targets.read("input"))
	return {
		sources: [fragments, queries, heads, schemes, afters, authorities, paths, targets, walk].map(
			(t) => t.source
		),
		target: concat(
			targets.read("scheme"),
			targets.read("authority"),
			when(kept, basePath, firstNonNull([walk.read("path"), text("")])),
			query,
			part(fragments, "r", "fragment")
		),
		climbed: and([not(kept), gt(walk.read("climbs"), integer(0))])
	}
}

/** The two texts a resolution reads (resolution): the base, then the reference. */
const resolutionParams: ReadonlyArray<FunctionParam> = [
	{ name: "base", type: types.text },
	{ name: "reference", type: types.text }
]

/**
 * resolveReference(base, reference): the target of `reference` resolved against `base` (resolution), every `..` that
 * climbs past its path's root dropped, as the RFC states.
 */
const resolveReferenceDefinition = (): LibraryBody => {
	const names = new NameSupply(freshNames)
	const { sources, target } = resolution(names)
	return {
		params: resolutionParams,
		returns: types.text,
		body: {
			kind: "subquery",
			query: operandSelect(
				core([targetAs(target, names.column(internal("resolved reference")))], sources, undefined)
			)
		}
	}
}

/**
 * resolvedWithin(base, reference): the target of `reference` resolved within `base` (resolution), as an array of it
 * where no `..` segment of the path it walks climbs past that path's root, or of none where one does, so a hierarchy
 * rooted at the base, a package's entries under its root, holds no target of it (@bjornpagen/grizzle-text uri.ts
 * resolveWithin). The split of a reference into its target within its base (lower/conservative/call
 * lowerResolvedWithin) reads its elements, one row or none.
 */
const resolvedWithinDefinition = (): LibraryBody => {
	const names = new NameSupply(freshNames)
	const { sources, target, climbed } = resolution(names)
	const within: Expr = {
		kind: "array",
		query: select(
			provedCore(
				"oneRow",
				[targetAs(target, names.column(internal("target within the base")))],
				[],
				not(climbed)
			)
		)
	}
	return {
		params: resolutionParams,
		returns: defined(arrayOf(types.text), "a text array type"),
		body: {
			kind: "subquery",
			query: operandSelect(
				core(
					[targetAs(within, names.column(internal("targets within the base")))],
					sources,
					undefined
				)
			)
		}
	}
}

/**
 * cutBefore(text, chars) and cutFrom(text, chars): `text` before its first character among `chars`, all of it where it
 * holds none, and `text` from that character on, the empty text where it holds none, as @bjornpagen/grizzle-text's
 * text.ts cutBefore and cutFrom compute it on the host, so the two concatenate to `text`. The cut is at the least
 * strpos of `text` over each character of `chars`, `substring(chars, i, 1)` for each place `i` of `chars` from 1, and
 * past `text`'s last character where none is found (min over no place found, or over `chars` empty, is NULL): `left`
 * of `text` to the character before it, or `substring` of `text` from it. strpos, left and substring count code points, as
 * the host does, and each reads `text` once a character of `chars`, which allocates nothing past `text`'s own bytes.
 */
const cutDefinition = (fn: "cutBefore" | "cutFrom"): LibraryBody => {
	const names = new NameSupply(freshNames)
	const subject = param(1, types.text)
	const chars = param(2, types.text)
	const places = relationOf(names, "set places", ["i"])
	const series: FromSource = {
		kind: "function",
		call: call("generate_series", [integer(1), length(chars)]),
		alias: places.alias,
		columns: { kind: "named", names: places.columns, ordinality: false },
		lateral: false
	}
	const found = call("strpos", [subject, call("substring", [chars, places.read("i"), integer(1)])])
	const at = firstNonNull([
		call("min", [{ kind: "nullif", expr: found, absent: integer(0) }]),
		binary("+", length(subject), integer(1))
	])
	const cut =
		fn === "cutBefore" ? call("left", [subject, binary("-", at, integer(1))]) : from(subject, at)
	return {
		params: [
			{ name: "text", type: types.text },
			{ name: "chars", type: types.text }
		],
		returns: types.text,
		body: {
			kind: "subquery",
			query: operandSelect(
				core([targetAs(cut, names.column(internal("cut")))], [series], undefined)
			)
		}
	}
}

/**
 * The letter decodedPath writes before a path it splits at its `%`s, so its first piece, all literal, is a piece however
 * empty the path is, and the pieces' one group is never empty; the decoded path is read past it.
 */
const writtenFirst = "x"

/** Whether the integer `x` lies within `low` and `high`, both included. */
const within = (x: Expr, low: number, high: number): Expr =>
	and([ge(x, integer(low)), le(x, integer(high))])

/** Whether the octet `b`, -1 where there is none, is a UTF-8 continuation octet, 80 to BF. */
const continuation = (b: Expr): Expr => within(b, 0x80, 0xbf)

/** The window of a path's escapes in one run (decodedPathDefinition): the run's, by their place. */
const lagged = (name: "lag" | "lead", b: Expr, offset: number, run: Expr, order: Expr): Expr => ({
	...call(name, [b, integer(offset), integer(-1)]),
	over: windowOf([run], [asc(order)])
})

/**
 * decodedPath(text): the path a percent-encoded URI path spells (RFC 3986 §2.1, §2.5), as a text array of the one
 * decoded path, or of none where the text spells none: a `%` that begins no `%HH` (§2.1 gives it no octet), escaped
 * octets that are no UTF-8 (each maximal run of escapes must be well-formed UTF-8, The Unicode Standard Table 3-7, a
 * literal character, whose own octets are UTF-8, ending a run), an escape of U+0000, which no text holds, or of `/`,
 * which would join two segments (§2.2: an encoded reserved character is data), and a segment made of dots alone of
 * which one is written `%2E`, which would decode to a dot segment the written path does not hold. Every other
 * character stands as written, a literal `/`, `.` or `..` among them.
 *
 * The text is read once as its pieces between its `%`s, `string_to_table('x' || text, '%') WITH ORDINALITY`, each `p`
 * numbered `n` from 1: the first all literal, every other an escape's two hex digits then a literal. Each escape's octet
 * `b`, -1 where its digits are no hex; the escapes of one run, `run` the count of literal pieces before it, read the
 * octets around them within the run (lag and lead, -1 past it), so a continuation octet stands where the run's octet
 * before it begins a sequence it completes (its second octet in the lead's own range: E0 A0-BF, ED 80-9F, F0 90-BF,
 * F4 80-8F) and a lead where the continuations it needs follow, which is exactly well-formed UTF-8, each sequence
 * delimited by its lead. A lead's code point is its octets' bits, chr of which is its character, and the decoded path
 * is the pieces' characters and literals in order. No regular expression reads the text, so the work is its length and
 * the sort of its pieces, at any length. The pieces are one group, by a carried constant, which the letter written
 * before the text (writtenFirst) makes never empty, so `bool_and` and `string_agg` read one piece at least. The array
 * holds the path where every piece stands and no segment, `string_to_table(text, '/')`, is a written dot segment; the
 * split of a path into its decoded path (lower/conservative/call lowerDecodedPath) reads its elements, one row or none.
 */
const decodedPathDefinition = (): LibraryBody => {
	const names = new NameSupply(freshNames)
	const path = param(1, types.text)
	const split = relationOf(names, "path pieces", ["p", "n"])
	const pieces: FromSource = {
		kind: "function",
		call: call("string_to_table", [concat(text(writtenFirst), path), text("%")]),
		alias: split.alias,
		columns: { kind: "named", names: split.columns, ordinality: true },
		lateral: false
	}
	const s = split.read
	const hex = call("left", [s("p"), integer(2)])
	const octets = table(
		names,
		"escaped octets",
		[
			["n", s("n")],
			["p", s("p")],
			[
				"b",
				when(
					and([
						gt(s("n"), integer(1)),
						ge(length(s("p")), integer(2)),
						eq(call("translate", [hex, text("0123456789abcdefABCDEF"), text("")]), text(""))
					]),
					call("get_byte", [call("decode", [hex, text("hex")]), integer(0)]),
					integer(-1)
				)
			],
			[
				"ends",
				when(or([eq(s("n"), integer(1)), gt(length(s("p")), integer(2))]), integer(1), integer(0))
			]
		],
		[pieces],
		false
	)
	const o = octets.read
	const runs = table(
		names,
		"escape runs",
		[
			["n", o("n")],
			["p", o("p")],
			["b", o("b")],
			["run", binary("-", windowed("sum", o("ends"), throughHere, o("n")), o("ends"))]
		],
		[octets.source],
		false
	)
	const r = runs.read
	const around = table(
		names,
		"escape neighbours",
		[
			["n", r("n")],
			["p", r("p")],
			["b", r("b")],
			["b1", lagged("lag", r("b"), 1, r("run"), r("n"))],
			["b2", lagged("lag", r("b"), 2, r("run"), r("n"))],
			["b3", lagged("lag", r("b"), 3, r("run"), r("n"))],
			["a1", lagged("lead", r("b"), 1, r("run"), r("n"))],
			["a2", lagged("lead", r("b"), 2, r("run"), r("n"))],
			["a3", lagged("lead", r("b"), 3, r("run"), r("n"))]
		],
		[runs.source],
		false
	)
	const a = around.read
	const bits = (x: Expr, lead: number): Expr => binary("-", x, integer(lead))
	const shifted = (x: Expr, by: number): Expr => binary("*", x, integer(by))
	const point: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{ when: within(a("b"), 0, 0x7f), result: a("b") },
			{
				when: within(a("b"), 0xc2, 0xdf),
				result: binary("+", shifted(bits(a("b"), 0xc0), 64), bits(a("a1"), 0x80))
			},
			{
				when: within(a("b"), 0xe0, 0xef),
				result: sumOf([
					shifted(bits(a("b"), 0xe0), 4096),
					shifted(bits(a("a1"), 0x80), 64),
					bits(a("a2"), 0x80)
				])
			},
			{
				when: within(a("b"), 0xf0, 0xf4),
				result: sumOf([
					shifted(bits(a("b"), 0xf0), 262_144),
					shifted(bits(a("a1"), 0x80), 4096),
					shifted(bits(a("a2"), 0x80), 64),
					bits(a("a3"), 0x80)
				])
			}
		],
		else: integer(-1)
	}
	const points = table(
		names,
		"escape points",
		[
			["n", a("n")],
			["p", a("p")],
			["b", a("b")],
			["b1", a("b1")],
			["b2", a("b2")],
			["b3", a("b3")],
			["a1", a("a1")],
			["a2", a("a2")],
			["a3", a("a3")],
			["cp", point]
		],
		[around.source],
		false
	)
	const x = points.read
	const b = x("b")
	const b1 = x("b1")
	const second = or([
		within(b1, 0xc2, 0xdf),
		and([eq(b1, integer(0xe0)), within(b, 0xa0, 0xbf)]),
		within(b1, 0xe1, 0xec),
		and([eq(b1, integer(0xed)), within(b, 0x80, 0x9f)]),
		within(b1, 0xee, 0xef),
		and([eq(b1, integer(0xf0)), within(b, 0x90, 0xbf)]),
		within(b1, 0xf1, 0xf3),
		and([eq(b1, integer(0xf4)), within(b, 0x80, 0x8f)])
	])
	const stands: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{ when: eq(x("n"), integer(1)), result: lit.bool(true) },
			{ when: or([eq(b, integer(0)), eq(b, integer(0x2f))]), result: lit.bool(false) },
			{ when: within(b, 0x01, 0x7f), result: lit.bool(true) },
			{
				when: continuation(b),
				result: or([
					second,
					and([continuation(b1), within(x("b2"), 0xe0, 0xf4)]),
					and([continuation(b1), continuation(x("b2")), within(x("b3"), 0xf0, 0xf4)])
				])
			},
			{ when: within(b, 0xc2, 0xdf), result: continuation(x("a1")) },
			{ when: within(b, 0xe0, 0xef), result: and([continuation(x("a1")), continuation(x("a2"))]) },
			{
				when: within(b, 0xf0, 0xf4),
				result: and([continuation(x("a1")), continuation(x("a2")), continuation(x("a3"))])
			}
		],
		else: lit.bool(false)
	}
	const scalar = and([within(x("cp"), 1, 0x10ffff), not(within(x("cp"), 0xd800, 0xdfff))])
	const piece: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{ when: eq(x("n"), integer(1)), result: x("p") },
			{ when: scalar, result: concat(call("chr", [x("cp")]), from(x("p"), integer(3))) }
		],
		else: from(x("p"), integer(3))
	}
	const decoded = table(
		names,
		"decoded pieces",
		[
			["n", x("n")],
			["ok", stands],
			["piece", piece],
			["one", integer(1)]
		],
		[points.source],
		false
	)
	const d = decoded.read
	const wholeNames = relationOf(names, "decoded path", ["ok", "path"])
	const whole = derived(
		operandSelect({
			...core(
				[
					targetAs(call("bool_and", [d("ok")]), wholeNames.column("ok")),
					targetAs(
						from(
							{ ...call("string_agg", [d("piece"), text("")]), orderBy: [asc(d("n"))] },
							integer(2)
						),
						wholeNames.column("path")
					)
				],
				[decoded.source],
				undefined
			),
			groupBy: [d("one")]
		}),
		wholeNames.alias,
		false
	)
	const segment = relationOf(names, "written segments", ["g"])
	const segments: FromSource = {
		kind: "function",
		call: call("string_to_table", [path, text("/")]),
		alias: segment.alias,
		columns: { kind: "named", names: segment.columns, ordinality: false },
		lateral: false
	}
	const g = segment.read("g")
	const writtenDot = and([
		or([
			gt(call("strpos", [g, text("%2E")]), integer(0)),
			gt(call("strpos", [g, text("%2e")]), integer(0))
		]),
		eq(
			call("translate", [
				call("replace", [call("replace", [g, text("%2E"), text("")]), text("%2e"), text("")]),
				text("."),
				text("")
			]),
			text("")
		)
	])
	const w = wholeNames.read
	const decodedArray: Expr = {
		kind: "array",
		query: select(
			provedCore(
				"oneRow",
				[targetAs(w("path"), names.column(internal("decoded path")))],
				[whole],
				and([
					w("ok"),
					notExists(
						operandSelect(
							core(
								[targetAs(integer(1), names.column(internal("written dot segment")))],
								[segments],
								writtenDot
							)
						)
					)
				])
			)
		)
	}
	return {
		params: [{ name: "path", type: types.text }],
		returns: defined(arrayOf(types.text), "a text array type"),
		body: {
			kind: "subquery",
			query: select(
				provedCore(
					"oneRow",
					[targetAs(decodedArray, names.column(internal("decoded paths")))],
					[],
					undefined
				)
			)
		}
	}
}

/**
 * The classes of a pattern's characters the recognizer's table reads (xsdPatternDefinition), each a column of it, in
 * the order of `xsdClassKeys` for the first fifteen: the metacharacters and punctuation Appendix F reads by themselves,
 * then the decimal digits, the letters of the single-character escapes no metacharacter spells (n, r, t), those of the
 * multi-character escapes, those of the category escapes (p, P), and every other character.
 */
const xsdClasses = [
	"\\",
	"[",
	"]",
	"(",
	")",
	"{",
	"}",
	"|",
	"?",
	"*",
	"+",
	"-",
	"^",
	",",
	".",
	"digit",
	"entry",
	"multi",
	"property",
	"other"
] as const

type XsdClass = (typeof xsdClasses)[number]

/** Each character a class other than `other` holds, and its class. */
const xsdClassKeys: ReadonlyArray<readonly [string, XsdClass]> = [
	...xsdClasses.slice(0, 15).map((c): readonly [string, XsdClass] => [c, c]),
	..."0123456789".split("").map((c): readonly [string, XsdClass] => [c, "digit"]),
	..."nrt".split("").map((c): readonly [string, XsdClass] => [c, "entry"]),
	..."sSiIcCdDwW".split("").map((c): readonly [string, XsdClass] => [c, "multi"]),
	..."pP".split("").map((c): readonly [string, XsdClass] => [c, "property"])
]

/**
 * The class of each ASCII code point, by the code point: the table the recognizer finds a character's class in, every
 * character past it of class `other`, as every character no key names.
 *
 * @formatConstant the ASCII code points, 0 to 127
 */
const asciiClasses: ReadonlyArray<XsdClass> = Array.from({ length: 0x80 }, (_, point) => {
	const keyed = xsdClassKeys.find(([key]) => key.codePointAt(0) === point)
	return keyed === undefined ? "other" : keyed[1]
})

/**
 * The recognizer's states, each a row of its table, what the reader (regex/xsd.ts) is reading: a branch where no
 * quantifier may stand (its start, after `|`, `(` or a quantifier), after an atom, an escape, a category escape's brace
 * and name, a count's `{`, least digits, comma and greatest digits, and in a class: just opened, no member yet, members,
 * a `-` before any member or after one, a character that may begin a range, it and a `-`, an escape, an escape ending a
 * range, a category escape's brace and name, a subtraction's `]` that its class's `]` must follow; and refused.
 */
const xsdStates = [
	"branch",
	"atom",
	"escape",
	"propertyBrace",
	"propertyName",
	"countOpen",
	"least",
	"comma",
	"most",
	"classOpen",
	"classEmpty",
	"classMembers",
	"dashEmpty",
	"dashMembers",
	"char",
	"charDash",
	"classEscape",
	"rangeEscape",
	"classPropertyBrace",
	"classPropertyName",
	"subtracted",
	"refused"
] as const

type XsdState = (typeof xsdStates)[number]

/**
 * What a move does beside its state, each over the recognizer's registers: open or close a group (the open groups'
 * count), open a class or a subtraction or close one (the open classes' count, closing into `atom` or `subtracted` by
 * it), a range's first code point from a character or an escape and a range's last checked against it, a category
 * escape's name begun, extended and checked against the names Appendix F's tables hold, and a count's least and
 * greatest numerals begun, extended and checked in order.
 */
const xsdOps = [
	"none",
	"openGroup",
	"closeGroup",
	"openClass",
	"openSubtraction",
	"closeClass",
	"firstChar",
	"firstEscape",
	"lastChar",
	"lastEscape",
	"nameOpen",
	"nameAdd",
	"nameClose",
	"leastOpen",
	"leastAdd",
	"mostOpen",
	"mostAdd",
	"ordered"
] as const

type XsdOp = (typeof xsdOps)[number]

/** A move of the recognizer's table: the next state and what it does. */
type Move = readonly [XsdState, XsdOp]

const refused: Move = ["refused", "none"]

/** The classes whose escape names one character: a metacharacter's own, and n, r and t (regex/xsd.ts singleCharacterEscapes). */
const entryEscapes: ReadonlySet<XsdClass> = new Set([
	"\\",
	"|",
	".",
	"?",
	"*",
	"+",
	"(",
	")",
	"{",
	"}",
	"-",
	"[",
	"]",
	"^",
	"entry"
])

/** A branch's move, where no quantifier stands: `|`, a group, an escape, a class, a closing bracket or an atom. */
const branchMove = (c: XsdClass): Move => {
	switch (c) {
		case "\\":
			return ["escape", "none"]
		case "[":
			return ["classOpen", "openClass"]
		case "(":
			return ["branch", "openGroup"]
		case ")":
			return ["atom", "closeGroup"]
		case "|":
			return ["branch", "none"]
		case "]":
		case "{":
		case "}":
		case "?":
		case "*":
		case "+":
			return refused
		case "-":
		case "^":
		case ",":
		case ".":
		case "digit":
		case "entry":
		case "multi":
		case "property":
		case "other":
			return ["atom", "none"]
	}
}

/** A class's move once it holds a member: its `]`, a `-`, an escape, or a character that may begin a range. */
const membersMove = (c: XsdClass): Move => {
	switch (c) {
		case "]":
			return ["atom", "closeClass"]
		case "[":
			return refused
		case "-":
			return ["dashMembers", "none"]
		case "\\":
			return ["classEscape", "none"]
		case "(":
		case ")":
		case "{":
		case "}":
		case "|":
		case "?":
		case "*":
		case "+":
		case "^":
		case ",":
		case ".":
		case "digit":
		case "entry":
		case "multi":
		case "property":
		case "other":
			return ["char", "firstChar"]
	}
}

/** A state's move on a character of class `c`: the table's cell, written as the reader reads (regex/xsd.ts Reader). */
const moveOf = (state: XsdState, c: XsdClass): Move => {
	switch (state) {
		case "branch":
			return branchMove(c)
		case "atom":
			return c === "?" || c === "*" || c === "+"
				? ["branch", "none"]
				: c === "{"
					? ["countOpen", "none"]
					: branchMove(c)
		case "escape":
			return entryEscapes.has(c) || c === "multi"
				? ["atom", "none"]
				: c === "property"
					? ["propertyBrace", "none"]
					: refused
		case "propertyBrace":
			return c === "{" ? ["propertyName", "nameOpen"] : refused
		case "propertyName":
			return c === "}" ? ["atom", "nameClose"] : ["propertyName", "nameAdd"]
		case "countOpen":
			return c === "digit" ? ["least", "leastOpen"] : refused
		case "least":
			return c === "digit"
				? ["least", "leastAdd"]
				: c === ","
					? ["comma", "none"]
					: c === "}"
						? ["branch", "none"]
						: refused
		case "comma":
			return c === "digit" ? ["most", "mostOpen"] : c === "}" ? ["branch", "none"] : refused
		case "most":
			return c === "digit" ? ["most", "mostAdd"] : c === "}" ? ["branch", "ordered"] : refused
		case "classOpen":
			return c === "^" ? ["classEmpty", "none"] : moveOf("classEmpty", c)
		case "classEmpty":
			return c === "]" || c === "["
				? refused
				: c === "-"
					? ["dashEmpty", "none"]
					: c === "\\"
						? ["classEscape", "none"]
						: ["char", "firstChar"]
		case "classMembers":
			return membersMove(c)
		case "dashEmpty":
			return c === "[" ? refused : membersMove(c)
		case "dashMembers":
			return c === "["
				? ["classOpen", "openSubtraction"]
				: c === "]"
					? ["atom", "closeClass"]
					: refused
		case "char":
			return c === "-" ? ["charDash", "none"] : membersMove(c)
		case "charDash":
			return c === "]"
				? ["atom", "closeClass"]
				: c === "["
					? ["classOpen", "openSubtraction"]
					: c === "-"
						? refused
						: c === "\\"
							? ["rangeEscape", "none"]
							: ["classMembers", "lastChar"]
		case "classEscape":
			return entryEscapes.has(c)
				? ["char", "firstEscape"]
				: c === "multi"
					? ["classMembers", "none"]
					: c === "property"
						? ["classPropertyBrace", "none"]
						: refused
		case "rangeEscape":
			return entryEscapes.has(c) ? ["classMembers", "lastEscape"] : refused
		case "classPropertyBrace":
			return c === "{" ? ["classPropertyName", "nameOpen"] : refused
		case "classPropertyName":
			return c === "}" ? ["classMembers", "nameClose"] : ["classPropertyName", "nameAdd"]
		case "subtracted":
			return c === "]" ? ["atom", "closeClass"] : refused
		case "refused":
			return refused
	}
}

/** The number of a state, a class or an op: its place in its roster. */
const placeOf = <T extends string>(roster: ReadonlyArray<T>, member: T): number =>
	roster.indexOf(member)

/** An integer[] constant of `values`, `'{…}'::integer[]`. */
const integers = (values: ReadonlyArray<number>): Expr =>
	lit.text(`{${values.join(",")}}`, defined(arrayOf(types.integer), "an integer array type"))

/** `array[index]`, counted from 1. */
const subscript = (array: Expr, index: Expr): Expr => ({ kind: "subscript", array, index })

/** The code point of a one-unit ASCII character. */
const cp = (ch: string): number => ch.charCodeAt(0)

/**
 * isXsdPattern(text): whether a text is a string of XML Schema 1.0's regExp production (Part 2, Appendix F), as
 * @bjornpagen/grizzle-text's regex/xsd.ts reader reads it on the host: the same grammar, with no state budget and no
 * bound on a count.
 *
 * The grammar is not regular (groups nest, and a class subtraction nests `[a-[b-[c]]]`), but its nesting needs only
 * counts, so its recognizer is a table of moves over its characters (xsdStates, xsdClasses, moveOf), the reader's own
 * loop as data, and a few registers: the open groups, the open classes, a range's first code point, the name of a
 * category escape or a count's greatest digits, and its least digits. The text's code points are read once into an
 * integer array (`t`, MATERIALIZED, so it is computed once and never per row of the recursion, as an inlined CTE would
 * be), whose element any row reads in constant time; a recursive query then reads them in order, one row a character,
 * each row the state and the registers after it: a character's class by an ASCII table (asciiClasses, every other
 * character of class `other`), the move by its place in two integer arrays, the state's row and the class's column,
 * and the registers by what the move does (xsdOps); a refusal ends it. The text is a member where the last row stands
 * in a branch or after an atom with every group closed. A category escape's name is one of the General_Category values
 * or `Is` and a block of XML Schema's table, which grizzle-text's own tables give, and a count's numerals are compared
 * as written, by their length without leading zeros and then by code point, so no count is too large to compare. It
 * reads no regular expression but the split of the text into its characters, and builds nothing per character but its
 * row: 10,001 code points of groups nested 2,000 deep take 114 ms, and 100,000 code points 2.2 s, on cassowary at a
 * load of 700.
 */
const xsdPatternDefinition = (): LibraryBody => {
	const pattern = param(1, types.text)
	const width = xsdClasses.length
	const nexts = xsdStates.flatMap((s) => xsdClasses.map((c) => placeOf(xsdStates, moveOf(s, c)[0])))
	const ops = xsdStates.flatMap((s) => xsdClasses.map((c) => placeOf(xsdOps, moveOf(s, c)[1])))
	const state = (s: XsdState): Expr => integer(placeOf(xsdStates, s))
	const op = (o: XsdOp): Expr => integer(placeOf(xsdOps, o))
	const names = new NameSupply(freshNames)
	const lengthNames = relationOf(names, "pattern length", ["n"])
	const splitNames = relationOf(names, "pattern characters", ["c", "k"])
	const charactersNames = relationOf(names, "pattern code points", ["cs", "n"])
	const readNames = relationOf(names, "pattern read", [
		"i",
		"s",
		"parens",
		"depth",
		"first",
		"acc",
		"lo"
	])
	const charNames = relationOf(names, "pattern character", ["c"])
	const classNames = relationOf(names, "pattern class", ["k"])
	const moveNames = relationOf(names, "pattern move", ["next", "op"])
	const afterNames = relationOf(names, "pattern registers", [
		"s",
		"parens",
		"depth",
		"first",
		"acc",
		"lo"
	])
	const r = readNames.read
	const c = charNames.read("c")
	const character = call("chr", [c])
	const moved = moveNames.read("op")
	const next = moveNames.read("next")
	/** A move's effect on one register: its value under each op that sets it, the register as it was under any other. */
	const register = (kept: Expr, set: NonEmptyReadonlyArray<readonly [XsdOp, Expr]>): Expr => ({
		kind: "case",
		operand: moved,
		whens: mapNonEmpty(set, ([o, value]) => ({ when: op(o), result: value })),
		else: kept
	})
	/** The state a move leads to, or refused where its check fails. */
	const unless = (holds: Expr): Expr => when(holds, next, state("refused"))
	const escaped: Expr = {
		kind: "case",
		operand: c,
		whens: [
			{ when: integer(cp("n")), result: integer(0x0a) },
			{ when: integer(cp("r")), result: integer(0x0d) },
			{ when: integer(cp("t")), result: integer(0x09) }
		],
		else: c
	}
	const categories = [...xsdCategoryNames, ...[...xmlSchemaBlocks.keys()].map((b) => `Is${b}`)]
	const digits = (numeral: Expr): Expr => call("ltrim", [numeral, text("0")])
	const least = digits(r("lo"))
	const most = digits(r("acc"))
	const inCodePointOrder = (e: Expr): Expr => ({
		kind: "collate",
		expr: e,
		collation: cUtf8Collation
	})
	const split: FromSource = {
		kind: "function",
		call: call("regexp_split_to_table", [pattern, text("")]),
		alias: splitNames.alias,
		columns: { kind: "named", names: splitNames.columns, ordinality: true },
		lateral: false
	}
	/** The pattern's length, one row, carried beside its characters so their aggregate groups by it: a pattern of no
	 * character holds no row of them, and no group, and the recursion reads none, as it reads none of a pattern of n = 0. */
	const counted = tableOf(lengthNames, [["n", length(pattern)]], [], false)
	const characters: Cte = {
		...cte(
			charactersNames.alias,
			operandSelect({
				...core(
					[
						targetAs(
							{
								...call("array_agg", [call("ascii", [splitNames.read("c")])]),
								orderBy: [asc(splitNames.read("k"))]
							},
							charactersNames.column("cs")
						),
						targetAs(counted.read("n"), charactersNames.column("n"))
					],
					[counted.source, split],
					undefined
				),
				groupBy: [counted.read("n")]
			})
		),
		materialized: "MATERIALIZED"
	}
	const start = core(
		[
			targetAs(integer(1), readNames.column("i")),
			targetAs(state("branch"), readNames.column("s")),
			targetAs(integer(0), readNames.column("parens")),
			targetAs(integer(0), readNames.column("depth")),
			targetAs(integer(0), readNames.column("first")),
			targetAs(text(""), readNames.column("acc")),
			targetAs(text(""), readNames.column("lo"))
		],
		[],
		undefined
	)
	const cell = binary(
		"+",
		binary("+", binary("*", r("s"), integer(width)), classNames.read("k")),
		integer(1)
	)
	const following = core(
		[
			targetAs(binary("+", r("i"), integer(1)), readNames.column("i")),
			...["s", "parens", "depth", "first", "acc", "lo"].map((x) =>
				targetAs(afterNames.read(x), readNames.column(x))
			)
		],
		[
			cteRef(readNames.alias),
			cteRef(charactersNames.alias),
			tableOf(charNames, [["c", subscript(charactersNames.read("cs"), r("i"))]], [], true).source,
			tableOf(
				classNames,
				[
					[
						"k",
						firstNonNull([
							subscript(
								integers(asciiClasses.map((k) => placeOf(xsdClasses, k))),
								binary("+", c, integer(1))
							),
							integer(placeOf(xsdClasses, "other"))
						])
					]
				],
				[],
				true
			).source,
			tableOf(
				moveNames,
				[
					["next", subscript(integers(nexts), cell)],
					["op", subscript(integers(ops), cell)]
				],
				[],
				true
			).source,
			tableOf(
				afterNames,
				[
					[
						"s",
						register(next, [
							["closeGroup", unless(gt(r("parens"), integer(0)))],
							["closeClass", when(eq(r("depth"), integer(1)), state("atom"), state("subtracted"))],
							["lastChar", unless(ge(c, r("first")))],
							["lastEscape", unless(ge(escaped, r("first")))],
							[
								"nameClose",
								unless({
									kind: "equalsAny",
									expr: r("acc"),
									array: lit.text(
										`{${categories.map((n) => `"${n}"`).join(",")}}`,
										defined(arrayOf(types.text), "a text array type")
									),
									schema: undefined
								})
							],
							[
								"ordered",
								unless(
									or([
										lt(length(least), length(most)),
										and([
											eq(length(least), length(most)),
											binary("<=", inCodePointOrder(least), inCodePointOrder(most))
										])
									])
								)
							]
						])
					],
					[
						"parens",
						register(r("parens"), [
							["openGroup", binary("+", r("parens"), integer(1))],
							["closeGroup", binary("-", r("parens"), integer(1))]
						])
					],
					[
						"depth",
						register(r("depth"), [
							["openClass", integer(1)],
							["openSubtraction", binary("+", r("depth"), integer(1))],
							["closeClass", binary("-", r("depth"), integer(1))]
						])
					],
					[
						"first",
						register(r("first"), [
							["firstChar", c],
							["firstEscape", escaped]
						])
					],
					[
						"acc",
						register(r("acc"), [
							["nameOpen", text("")],
							["nameAdd", concat(r("acc"), character)],
							["mostOpen", character],
							["mostAdd", concat(r("acc"), character)]
						])
					],
					[
						"lo",
						register(r("lo"), [
							["leastOpen", character],
							["leastAdd", concat(r("lo"), character)]
						])
					]
				],
				[],
				true
			).source
		],
		and([le(r("i"), charactersNames.read("n")), ne(r("s"), state("refused"))])
	)
	const read = cte(readNames.alias, operandSelect(operandUnionAll([start, following])))
	const last: OperandSelect = {
		...operandSelect(
			core(
				[
					targetAs(
						and([isIn(r("s"), [state("branch"), state("atom")]), eq(r("parens"), integer(0))]),
						names.column(internal("pattern member"))
					)
				],
				[cteRef(readNames.alias)],
				undefined
			)
		),
		with: { recursive: true, ctes: [characters, read] },
		orderBy: [desc(r("i"))],
		limit: integer(1)
	}
	return {
		params: [{ name: "pattern", type: types.text }],
		returns: types.boolean,
		body: { kind: "subquery", query: last }
	}
}

/**
 * textDigest(text): the SHA-256 digest of a text's UTF-8 bytes, `sha256(convert_to($1, 'UTF8'))`, 32 bytes, the digest
 * Crypto.sha256 over a text is on the host too (scalar/values/sha256.ts Sha256.ofText), a digest field a key may be
 * declared over. An installation's
 * database is UTF8 (grizzle refuses another at its first migration), so convert_to converts nothing and copies the
 * text's bytes as they are stored; convert_to is STABLE in pg_proc only because a conversion's result can depend on the database's
 * encoding, which a database never changes, and sha256 is IMMUTABLE, so the digest is one value of a text wherever it
 * stands, a generated column among them, and the function is declared IMMUTABLE as PostgreSQL's own digests are.
 */
const textDigestDefinition = (): LibraryBody => ({
	params: [{ name: "text", type: types.text }],
	returns: types.bytea,
	body: call("sha256", [call("convert_to", [param(1, types.text), text("UTF8")])])
})

/**
 * wall(bigint, text): a zone's wall clock at an instant, both counted in milliseconds, the instant's since the Unix epoch
 * and the wall clock's since the local epoch, 1970-01-01 00:00 on the zone's clock: the instant plus the zone's offset
 * from UT at it, as PostgreSQL's tzdata reads the zone its IANA name names (registry.ts zoneWall). The instant becomes a
 * timestamp of its UTC wall clock exactly, by integers alone: its day, floored, `'1970-01-01'::date + d`, and its
 * milliseconds into it, `r * '1 millisecond'::interval`, r below a day's, so the product's microseconds are an integer a
 * double holds exactly. The offset at it is the zone's wall clock less that one, `extract('epoch', timezone(zone,
 * timezone('0 seconds'::interval, utc))) - extract('epoch', utc)`, exact numerics of seconds: the timestamptz of the
 * instant is made at offset zero, with no zone looked up. An instant in the first or the last Gregorian cycle of
 * timestamptz's range has its offset read one cycle in (core/clock.ts wallCycle), where it is the same, so no wall clock
 * past the range is built: wall is defined on every instant timestamptz holds. Every function and operator it reads is
 * IMMUTABLE in pg_proc.
 */
const wallDefinition = (): LibraryBody => {
	const instant = param(1, types.bigint)
	const zone = param(2, types.text)
	const bigint = (value: bigint): Expr => lit.int(value, types.bigint)
	const day = bigint(millisPerDay)
	const shift: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{ when: lt(instant, bigint(wallCycle.below)), result: bigint(wallCycle.millis) },
			{ when: gt(instant, bigint(wallCycle.above)), result: bigint(-wallCycle.millis) }
		],
		else: bigint(0n)
	}
	const read = binary("+", instant, shift)
	const intoDay = binary("%", binary("+", binary("%", read, day), day), day)
	const days = binary("/", binary("-", read, intoDay), day)
	const utc = binary(
		"+",
		binary("+", lit.text("1970-01-01", types.date), cast(days, types.integer)),
		binary("*", intoDay, lit.text("1 millisecond", types.interval))
	)
	const seconds = (timestamp: Expr): Expr =>
		call("extract", [lit.text("epoch", types.text), timestamp])
	const offsetAt = (timestamp: Expr): Expr =>
		binary(
			"-",
			seconds(
				call("timezone", [
					zone,
					call("timezone", [lit.text("0 seconds", types.interval), timestamp])
				])
			),
			seconds(timestamp)
		)
	const offset = offsetAt(utc)
	return {
		params: [
			{ name: "instant", type: types.bigint },
			{ name: "zone", type: types.text }
		],
		returns: types.bigint,
		body: binary(
			"+",
			instant,
			cast(binary("*", offset, lit.int(1000n, types.integer)), types.bigint)
		)
	}
}

/**
 * closedRow(bigint[], bigint, bigint, bit varying): a closed relation's row of a prefix (sql/constants.ts completions),
 * the run of `count` cells from cell `first` of the constant's cells `cells` (ir/cells.ts Constant), as the set `empty`,
 * the empty set of the row's roster at its width, with the bit of each cell of the run the cells hold set. The run's
 * cells are the elements in [first, first + count): those after the elements at or below first - 1 and up to the last at
 * or below first + count - 1, the counts width_bucket gives, so two binary searches over the sorted cells, O(log n), find
 * them, and only they are read, each setting its bit, `set_bit(empty, cell - first, 1)`, OR'd by bit_or; a run of no
 * held cell, or of no cell, is `empty` itself. Every index the searches ask for is at or above -1, the sentinel, so each
 * count is at least 1. No bit string is built from text: every bit is set on the hex literal its caller passes. STRICT,
 * so a NULL code of the prefix reads NULL; it reads its arguments alone, so a table's CHECK holds it where it refuses a
 * subquery of its own (pantry's `Enters.row(n.kind)`).
 */
const closedRowDefinition = (): LibraryBody => {
	const names = new NameSupply(freshNames)
	const cells = param(1, types.codes)
	const first = param(2, types.bigint)
	const count = param(3, types.bigint)
	const empty = param(4, types.varbit)
	const one = lit.int(1, types.bigint)
	const atOrBelow = (cell: Expr): Expr => call("width_bucket", [cell, cells])
	const places = relationOf(names, "row places", ["i"])
	const run: FromSource = {
		kind: "function",
		call: call("generate_series", [
			binary("+", atOrBelow(binary("-", first, one)), integer(1)),
			atOrBelow(binary("-", binary("+", first, count), one))
		]),
		alias: places.alias,
		columns: { kind: "named", names: places.columns, ordinality: false },
		lateral: false
	}
	const offset = binary("-", subscript(cells, places.read("i")), first)
	return {
		params: [
			{ name: "cells", type: types.codes },
			{ name: "first", type: types.bigint },
			{ name: "count", type: types.bigint },
			{ name: "empty", type: types.varbit }
		],
		returns: types.varbit,
		body: {
			kind: "subquery",
			query: operandSelect(
				core(
					[
						targetAs(
							firstNonNull([
								call("bit_or", [call("set_bit", [empty, cast(offset, types.integer), integer(1)])]),
								empty
							]),
							names.column(internal("row"))
						)
					],
					[run],
					undefined
				)
			)
		}
	}
}

/**
 * Whether the library function `fn` is STRICT: exactly where every native node that calls it (registry.ts libraryOf)
 * meets a NULL operand by the strict rule (registry.ts nullRules), which the host evaluator applies to it, so a call of
 * a NULL argument is NULL in PostgreSQL, which returns it without running the body, as it is on the host. One that is
 * not meets a NULL as its body says, which must then be the host's rule.
 */
const strictOf = (fn: LibraryFn): boolean =>
	nativeOps.every((op) => libraryOf(op.sql) !== fn || nullRules[op.fn] === "strict")

/** `fn`'s definition: its body, and its strictness (strictOf). */
const definedAs = (fn: LibraryFn, body: LibraryBody): LibraryDefinition => ({
	...body,
	strict: strictOf(fn)
})

/** Each library function's definition, made once. */
const definitions: { readonly [F in LibraryFn]: LibraryDefinition } = {
	closedRow: definedAs("closedRow", closedRowDefinition()),
	cutBefore: definedAs("cutBefore", cutDefinition("cutBefore")),
	cutFrom: definedAs("cutFrom", cutDefinition("cutFrom")),
	decodedPath: definedAs("decodedPath", decodedPathDefinition()),
	isXsdPattern: definedAs("isXsdPattern", xsdPatternDefinition()),
	resolveReference: definedAs("resolveReference", resolveReferenceDefinition()),
	resolvedWithin: definedAs("resolvedWithin", resolvedWithinDefinition()),
	textDigest: definedAs("textDigest", textDigestDefinition()),
	wall: definedAs("wall", wallDefinition())
}

/** Each library function's identity, by its name and its definition's digest, minted once. */
const identities: { readonly [F in LibraryFn]: Identity<"libraryFunction"> } = {
	closedRow: identity.libraryFunction(
		"closedRow",
		constantDigest("library-function", definitions.closedRow, everyProperty)
	),
	cutBefore: identity.libraryFunction(
		"cutBefore",
		constantDigest("library-function", definitions.cutBefore, everyProperty)
	),
	cutFrom: identity.libraryFunction(
		"cutFrom",
		constantDigest("library-function", definitions.cutFrom, everyProperty)
	),
	decodedPath: identity.libraryFunction(
		"decodedPath",
		constantDigest("library-function", definitions.decodedPath, everyProperty)
	),
	isXsdPattern: identity.libraryFunction(
		"isXsdPattern",
		constantDigest("library-function", definitions.isXsdPattern, everyProperty)
	),
	resolveReference: identity.libraryFunction(
		"resolveReference",
		constantDigest("library-function", definitions.resolveReference, everyProperty)
	),
	resolvedWithin: identity.libraryFunction(
		"resolvedWithin",
		constantDigest("library-function", definitions.resolvedWithin, everyProperty)
	),
	textDigest: identity.libraryFunction(
		"textDigest",
		constantDigest("library-function", definitions.textDigest, everyProperty)
	),
	wall: identity.libraryFunction(
		"wall",
		constantDigest("library-function", definitions.wall, everyProperty)
	)
}

/**
 * Whether a library function's body reads no table, read off the body itself: each FROM item of it is a CTE's, a
 * derived table's, a VALUES list's, a function's or its parameters' rows, every function it calls is PostgreSQL's own,
 * and so none reads a stored table, a write's met rows, a trigger's transition table, an enclosing statement's rows or
 * the session's claims. A body that calls a function of a schema may read what that function reads, so it is no such
 * body.
 */
const bodyReadsNoTable = (body: Expr): boolean => {
	let reads = false
	visitExpr(body, {
		...inertVisitor,
		fromItem: (item) => {
			switch (item.kind) {
				case "cte":
				case "derived":
				case "values":
				case "function":
				case "arrays":
				case "joins":
					return
				case "table":
				case "probe":
				case "met":
				case "metRows":
				case "transition":
				case "enclosing":
				case "context":
					reads = true
			}
		},
		expr: (e) => {
			if (e.kind === "call" && e.fn.kind === "qualified") {
				reads = true
			}
		}
	})
	return !reads
}

/**
 * Each library function whose definition reads no table (bodyReadsNoTable), read off its definition once: what the
 * certifier reads a call of as no read of any relation (program/isolation/certification.ts extractNames).
 */
export const tablelessLibrary: ReadonlyArray<LibraryFn> = libraryFns.filter((fn) =>
	bodyReadsNoTable(definitions[fn].body)
)

/** The library function an expression calls: its native operation's SQL's (registry.ts libraryOf), or a variant digest's textDigest where it images a text (scalar/variant-digest.ts); or none. */
export const calledLibrary = (e: ScalarExpr): LibraryFn | undefined => {
	if (e.kind === "variant") {
		return e.op.kind === "digest" && digestReadsText(e) ? "textDigest" : undefined
	}
	const sql = e.kind === "op" ? nativeOp(e.op)?.sql : undefined
	return sql === undefined ? undefined : libraryOf(sql)
}

/** Whether a variant's digest images a text or an exact integer, each by the library's textDigest (scalar/variant-digest.ts). */
const digestReadsText = (e: ScalarExpr): boolean => {
	const subject = e.args[0]
	const base = subject === undefined ? undefined : baseOf(subject.type)
	return (
		base?.carrier === "variant" &&
		base.variant.arms.some((arm) =>
			arm.fields.some((f) => {
				const image = digestPartOf(f.type)
				return image === "text" || image === "integer"
			})
		)
	)
}

/** The identity a library function is named by (core/identity.ts libraryFunction). */
export const libraryIdentity = (fn: LibraryFn): Identity<"libraryFunction"> => identities[fn]

/** A library function as an installation in `schema` creates it (libraryCreate) and a statement calls it. */
export const libraryRef = (schema: string, fn: LibraryFn): QualifiedFunctionRef => ({
	kind: "qualified",
	schema,
	name: libraryIdentity(fn).identifier,
	volatility: "IMMUTABLE"
})

/**
 * The library functions the persistent expressions of `model` call (constants.ts persistentExprs), in name order: what
 * the installation's one collector of its artifacts' objects reads for them beside its checked DAGs' calls
 * (physical/install/plan.ts artifactObjects).
 */
export const libraryCalls = (model: LawModel): ReadonlyArray<LibraryFn> => {
	const called = new Set<LibraryFn>()
	for (const e of exprClosure(persistentExprs(model))) {
		const fn = calledLibrary(e)
		if (fn !== undefined) {
			called.add(fn)
		}
	}
	return [...called].toSorted(compareStrings)
}

/** A library function's CREATE in the schema `schema`: an installation's, or a session's pg_temp. */
export const libraryCreate = (schema: string, fn: LibraryFn): LibraryConstant => ({
	kind: "createConstant",
	language: "sql",
	name: { schema, name: libraryIdentity(fn).identifier },
	...definitions[fn]
})

/** The library functions the installation installs as its objects, after its schema, each its CREATE and its revoke. */
export const addLibrary = (b: InstallBuilder): void => {
	for (const fn of b.library) {
		const named = libraryIdentity(fn)
		b.name(named)
		const create = libraryCreate(b.schema, fn)
		b.addConstant(
			named,
			{
				ddl: () => [create, constantRevoke(create)],
				reasons: [enforcement(`the library function ${fn}`)]
			},
			[b.schemaNode]
		)
	}
}
