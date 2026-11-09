import {
	type Family,
	type Operator as LibraryOperator,
	OPERATORS,
	type Rule
} from "@grizzle/testing/mutants"
import { regex } from "arkregex"
import { Array as Arr, Option, Result, String as Str } from "effect"
import * as ts from "typescript/ast"

/**
 * The operators of the `sql-world` family, each a compiler bug in the SQL that installs and enters a world:
 *
 * - world-conjunct: one conjunct of a SQL builder `and([...])` dropped, or one list of them where the list is spread
 *   into the conjunction (`and(appendNonEmpty([...], last))`), from a policy's, a key probe's or a filter's predicate;
 * - world-policy-true: a policy's USING or its WITH CHECK printed as `true`;
 * - world-barrier: security_barrier dropped from a view, in the printer and where a view's AST asks for it;
 * - world-definer: a function printed SECURITY INVOKER instead of its declared security;
 * - world-search-path: a function's search_path pin left out of its header;
 * - world-catalog-bare: a pg_catalog type or a builtin function printed by its bare name, resolved through the session's
 *   search path, instead of qualified by pg_catalog;
 * - world-grant: SELECT, UPDATE or TRUNCATE added to a privilege list a role is granted: a base-table SELECT,
 *   UPDATE on an immutable relation, TRUNCATE;
 * - world-public-execute: EXECUTE granted to PUBLIC right after a function's REVOKE from PUBLIC;
 * - world-membership: a membership granted WITH INHERIT TRUE or SET FALSE, or a login created INHERIT;
 * - world-claims-session: the ledger's `set_config` of a Db transaction's role and claims made for the session instead
 *   of the transaction;
 * - world-context-field: a context source's claims read at the wrong key, each field read at its context's name;
 * - world-advance-max: an advance function's setval made unconditional, so it can move the sequence back;
 * - world-isolation-guard: the below-SERIALIZABLE refusal dropped from the isolation guard's body;
 * - world-reads-flip: a catalogue overload that reads its operands' display scale declared to read values only, so its
 *   operands reach PostgreSQL without trim_scale, or a float or money aggregate's exact lowering declared native, so
 *   it accumulates in its argument's type;
 * - world-precondition-drop: a catalogue overload's totality declared `total`: a partial one's preconditions dropped,
 *   so a division, a root or a narrowing is emitted with no proof and can raise on a row, or an exact or IEEE 754 one's
 *   rendering dropped, so integer and money arithmetic overflows and float arithmetic raises at a bound.
 */
export const worldOperators = [
	"world-conjunct",
	"world-policy-true",
	"world-barrier",
	"world-definer",
	"world-search-path",
	"world-catalog-bare",
	"world-grant",
	"world-public-execute",
	"world-membership",
	"world-claims-session",
	"world-context-field",
	"world-advance-max",
	"world-isolation-guard",
	"world-reads-flip",
	"world-precondition-drop"
] as const
export type WorldOperator = (typeof worldOperators)[number]

/** The Compute catalogue, whose overloads declare what they read of their operands. */
const registryPath = "packages/engine/src/scalar/compute/registry.ts"

/** The aggregate overloads, each declaring how it is lowered. */
const aggregatePath = "packages/engine/src/scalar/aggregate.ts"

/** The ledger's statements, among them the entry of every Db transaction, which sets its role and claims. */
const ledgerPath = "packages/engine/src/deploy/ledger/ledger.ts"

/**
 * The files whose code builds the emitted world SQL: the role, view, policy, function and grant DDL, the advance
 * function and the isolation guard, the membership rendering, the claims lowering, the printer, and the ledger's
 * statements, whose entry takes on a Db's role and claims for each transaction; and the declarations every emitted
 * reading and aggregate is rendered by, the Compute catalogue and the aggregate overloads. Only their code takes a
 * `sql-world` mutant.
 */
const worldPaths: ReadonlyArray<string> = [
	registryPath,
	aggregatePath,
	"packages/engine/src/physical/ddl/roles.ts",
	"packages/engine/src/physical/ddl/advance.ts",
	"packages/engine/src/physical/ddl/isolation.ts",
	"packages/engine/src/write/entry/",
	"packages/engine/src/lower/conservative/claims/",
	"packages/engine/src/sql/print.ts",
	ledgerPath
]

const isWorldFile = (file: string): boolean =>
	Arr.some(worldPaths, (path) => Str.startsWith(path)(file))

/** Where a world operator found a fault to plant: the file's text, its syntax tree, and the sink of mutants. */
interface WorldSite {
	readonly file: string
	readonly text: string
	readonly source: ts.SourceFile
	readonly add: (operator: WorldOperator, start: number, end: number, replacement: string) => void
}

const textOf = (site: WorldSite, node: ts.Node): string =>
	Str.slice(node.getStart(site.source), node.end)(site.text)

/** The offset just past the `}` that closes the template substitution whose `${` starts at `open`. */
const substitutionEnd = (text: string, open: number): number => {
	let depth = 1
	for (let k = open + 1; k < text.length; k++) {
		depth += text[k] === "{" ? 1 : text[k] === "}" ? -1 : 0
		if (depth === 0) {
			return k + 1
		}
	}
	return text.length
}

/** A span of a text, as offsets into it. */
interface Span {
	readonly start: number
	readonly end: number
}

/** The `${...}` substitution right after `prefix` in `raw`, as offsets into `raw`, if `raw` holds `prefix${`. */
const substitutionAfter = (raw: string, prefix: string): Option.Option<Span> =>
	Option.map(Str.indexOf(`${prefix}\${`)(raw), (at): Span => {
		const start = at + prefix.length
		return { start, end: substitutionEnd(raw, start + 1) }
	})

const policyClauses = ["USING (", "WITH CHECK ("] as const

/** world-policy-true on one template literal. */
const policyTemplate = (site: WorldSite, node: ts.TemplateExpression): void => {
	const start = node.getStart(site.source)
	const raw = textOf(site, node)
	for (const clause of policyClauses) {
		for (const sub of Option.toArray(substitutionAfter(raw, clause))) {
			site.add("world-policy-true", start + sub.start, start + sub.end, "true")
		}
	}
}

/** world-definer, world-search-path and world-membership on the text of one template literal or string. */
const headerText = (site: WorldSite, node: ts.Node): void => {
	const start = node.getStart(site.source)
	const raw = textOf(site, node)
	for (const security of Option.toArray(substitutionAfter(raw, "SECURITY "))) {
		site.add("world-definer", start + security.start, start + security.end, "INVOKER")
	}
	for (const pin of Option.toArray(substitutionAfter(raw, " SET search_path = "))) {
		site.add(
			"world-search-path",
			start + pin.start - " SET search_path = ".length,
			start + pin.end,
			""
		)
	}
	const flips: ReadonlyArray<readonly [string, string]> = [
		["WITH INHERIT FALSE", "WITH INHERIT TRUE"],
		["INHERIT FALSE, SET TRUE", "INHERIT FALSE, SET FALSE"],
		["LOGIN NOINHERIT", "LOGIN INHERIT"]
	]
	for (const [from, to] of flips) {
		for (const at of Option.toArray(Str.indexOf(from)(raw))) {
			site.add("world-membership", start + at, start + at + from.length, to)
		}
	}
}

/** world-barrier on one plain string literal. */
const plainString = (
	site: WorldSite,
	node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral
): void => {
	const start = node.getStart(site.source)
	const raw = textOf(site, node)
	if (Str.includes("security_barrier")(raw)) {
		site.add("world-barrier", start, node.end, '""')
	}
	headerText(site, node)
}

const privileges = ["SELECT", "UPDATE", "TRUNCATE"] as const

/** world-grant on one privilege list literal of a `grant(...)` call. */
const privilegeList = (site: WorldSite, list: ts.ArrayLiteralExpression): void => {
	const held = Arr.filterMap(list.elements, (e) =>
		ts.isStringLiteral(e) ? Result.succeed(e.text) : Result.failVoid
	)
	if (held.length !== list.elements.length) {
		return
	}
	for (const privilege of privileges) {
		if (!Arr.contains(held, privilege)) {
			site.add(
				"world-grant",
				list.getStart(site.source),
				list.end,
				`[${Arr.join([...Arr.map(list.elements, (e) => textOf(site, e)), `"${privilege}"`], ", ")}]`
			)
		}
	}
}

/** The privilege list literals of a `grant(...)` call's first argument: a literal, or each branch of a conditional. */
const privilegeLists = (arg: ts.Expression): ReadonlyArray<ts.ArrayLiteralExpression> => {
	if (ts.isArrayLiteralExpression(arg)) {
		return [arg]
	}
	if (ts.isConditionalExpression(arg)) {
		return [...privilegeLists(arg.whenTrue), ...privilegeLists(arg.whenFalse)]
	}
	return []
}

const calleeName = (call: ts.CallExpression): string =>
	ts.isIdentifier(call.expression) ? call.expression.text : ""

/**
 * The list of conjuncts an `and(...)` argument states, and how the argument is spelled with one of them dropped: a list
 * literal keeps at least one conjunct, so it needs two; `appendNonEmpty([...], last)` always keeps `last`.
 */
const conjunctLists = (
	site: WorldSite,
	arg: ts.Expression
): Option.Option<{
	readonly list: ts.ArrayLiteralExpression
	readonly spell: (kept: string) => string
	readonly least: number
}> => {
	if (ts.isArrayLiteralExpression(arg)) {
		return Option.some({ list: arg, spell: (kept) => kept, least: 2 })
	}
	const [list, last] = ts.isCallExpression(arg) ? arg.arguments : []
	return ts.isCallExpression(arg) &&
		calleeName(arg) === "appendNonEmpty" &&
		list !== undefined &&
		last !== undefined &&
		ts.isArrayLiteralExpression(list)
		? Option.some({
				list,
				spell: (kept) => `appendNonEmpty(${kept}, ${textOf(site, last)})`,
				least: 1
			})
		: Option.none()
}

/** world-conjunct, world-grant and world-advance-max on one call. */
const worldCall = (site: WorldSite, call: ts.CallExpression): void => {
	const name = calleeName(call)
	const args = call.arguments
	const [first] = args
	const conjuncts =
		name === "and" && first !== undefined ? conjunctLists(site, first) : Option.none()
	for (const { list, spell, least } of Option.toArray(conjuncts)) {
		if (list.elements.length >= least) {
			for (const dropped of list.elements.keys()) {
				const kept = Arr.map(Arr.remove(list.elements, dropped), (e) => textOf(site, e))
				site.add(
					"world-conjunct",
					call.getStart(site.source),
					call.end,
					`and(${spell(`[${Arr.join(kept, ", ")}]`)})`
				)
			}
		}
	}
	if (name === "grant" && first !== undefined) {
		for (const list of privilegeLists(first)) {
			privilegeList(site, list)
		}
	}
	const where = args[2]
	const advance = site.file === "packages/engine/src/physical/ddl/advance.ts"
	if (
		advance &&
		(name === "simpleSelect" || name === "core") &&
		where !== undefined &&
		ts.isCallExpression(where) &&
		calleeName(where) === "gt"
	) {
		site.add("world-advance-max", where.getStart(site.source), where.end, "undefined")
	}
}

type Named = ts.PropertyAssignment | ts.ShorthandPropertyAssignment

const isNamed = (p: ts.ObjectLiteralElementLike): p is Named =>
	ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)

const propertyNamed = (o: ts.ObjectLiteralExpression, name: string): Option.Option<Named> =>
	Arr.findFirst(
		Arr.filter(o.properties, isNamed),
		(p) => ts.isIdentifier(p.name) && p.name.text === name
	)

/** The text a property's value has: its initializer's, or a shorthand property's own name. */
const valueText = (site: WorldSite, p: Named): string => {
	if (ts.isPropertyAssignment(p)) {
		return textOf(site, p.initializer)
	}
	return ts.isIdentifier(p.name) ? p.name.text : textOf(site, p.name)
}

const initializerText = (
	site: WorldSite,
	o: ts.ObjectLiteralExpression,
	name: string
): Option.Option<string> => Option.map(propertyNamed(o, name), (p) => valueText(site, p))

/** world-public-execute and world-context-field on one object literal. */
const worldObject = (site: WorldSite, o: ts.ObjectLiteralExpression): void => {
	const kind = initializerText(site, o, "kind")
	const isKind = (literal: string): boolean => Option.exists(kind, (k) => k === literal)
	const revokedFrom = Option.all({
		on: initializerText(site, o, "on"),
		from: initializerText(site, o, "from")
	})
	const publicFunction = Option.filter(
		revokedFrom,
		({ on, from }) => Str.includes('"FUNCTION"')(on) && Str.includes('"PUBLIC"')(from)
	)
	if (
		isKind('"revoke"') &&
		ts.isArrayLiteralExpression(o.parent) &&
		Option.isSome(publicFunction)
	) {
		site.add(
			"world-public-execute",
			o.end,
			o.end,
			`, { kind: "grant", privileges: ["EXECUTE"], on: ${publicFunction.value.on}, to: [{ kind: "PUBLIC" }] }`
		)
	}
	const source = Option.all({
		columns: propertyNamed(o, "columns"),
		context: initializerText(site, o, "context")
	})
	if (isKind('"context"') && Option.isSome(source)) {
		const { columns, context } = source.value
		site.add(
			"world-context-field",
			columns.getStart(site.source),
			columns.end,
			`columns: ${valueText(site, columns)}.map((c) => ({ ...c, field: ${context} }))`
		)
	}
}

/** world-barrier on `barrier: true`. */
const worldProperty = (site: WorldSite, p: ts.PropertyAssignment): void => {
	if (!ts.isIdentifier(p.name)) {
		return
	}
	const value = p.initializer
	if (p.name.text === "barrier" && value.kind === ts.SyntaxKind.TrueKeyword) {
		site.add("world-barrier", value.getStart(site.source), value.end, "false")
	}
}

/** world-isolation-guard: the refusal dropped from an array of statements. */
const guardElement = (site: WorldSite, list: ts.ArrayLiteralExpression): void => {
	for (const [k, e] of list.elements.entries()) {
		if (ts.isIdentifier(e) && e.text === "refuseBelowSerializable") {
			const rest = Arr.remove(list.elements, k)
			site.add(
				"world-isolation-guard",
				list.getStart(site.source),
				list.end,
				`[${Arr.join(
					Arr.map(rest, (r) => textOf(site, r)),
					", "
				)}]`
			)
		}
	}
}

/**
 * world-reads-flip: a catalogue overload's "displayScale" reading, an argument of its builder, declared "value"; an
 * aggregate overload's exactSum or exactMean lowering declared native.
 */
const readsFlip = (site: WorldSite, node: ts.Node): void => {
	if (
		site.file === registryPath &&
		ts.isStringLiteral(node) &&
		node.text === "displayScale" &&
		ts.isCallExpression(node.parent)
	) {
		site.add("world-reads-flip", node.getStart(site.source), node.end, '"value"')
	}
	if (
		site.file === aggregatePath &&
		ts.isCallExpression(node) &&
		(calleeName(node) === "exactSum" || calleeName(node) === "exactMean")
	) {
		site.add("world-reads-flip", node.getStart(site.source), node.end, "native")
	}
}

/** The totalities of the catalogue that are not `total`: the requiring constants, and the exact ones. */
const partialTotalities: ReadonlySet<string> = new Set([
	"divisor",
	"narrowing",
	"finiteNarrowing",
	"exactInteger",
	"exactMoney"
])

/**
 * world-precondition-drop: in the catalogue, a `requires(...)` or `ieee(...)` totality, or an overload's argument naming
 * a requiring or exact totality, declared `total`.
 */
const preconditionDrop = (site: WorldSite, node: ts.Node): void => {
	if (site.file !== registryPath) {
		return
	}
	if (
		ts.isCallExpression(node) &&
		(calleeName(node) === "requires" || calleeName(node) === "ieee")
	) {
		site.add("world-precondition-drop", node.getStart(site.source), node.end, "total")
	}
	if (
		ts.isIdentifier(node) &&
		partialTotalities.has(node.text) &&
		ts.isCallExpression(node.parent) &&
		node.parent.expression !== node &&
		Arr.some(node.parent.arguments, (a) => a === node)
	) {
		site.add("world-precondition-drop", node.getStart(site.source), node.end, "total")
	}
}

/** The const a node's code belongs to: the nearest variable declaration it sits in, if any. */
const enclosingConst = (node: ts.Node): Option.Option<string> => {
	for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) {
		if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) {
			return Option.some(at.name.text)
		}
	}
	return Option.none()
}

/** The printers that qualify a pg_catalog name: a type's (printCatalogType) and a builtin function's. */
const catalogPrinters: ReadonlySet<string> = new Set(["printCatalogType", "printFunctionName"])

/** world-catalog-bare: an `inCatalog(name)` of a catalog printer printed as the bare `name`. */
const catalogBare = (site: WorldSite, call: ts.CallExpression): void => {
	const [name] = call.arguments
	if (
		site.file === "packages/engine/src/sql/print.ts" &&
		calleeName(call) === "inCatalog" &&
		name !== undefined &&
		Option.exists(enclosingConst(call), (printer) => catalogPrinters.has(printer))
	) {
		site.add("world-catalog-bare", call.getStart(site.source), call.end, textOf(site, name))
	}
}

/**
 * world-claims-session: in the ledger, a `call("set_config", [name, value, lit.bool(true)])`, a setting local to the
 * transaction, made for the session: `lit.bool(false)`.
 */
const sessionSetting = (site: WorldSite, call: ts.CallExpression): void => {
	const [fn, list] = call.arguments
	if (
		site.file !== ledgerPath ||
		calleeName(call) !== "call" ||
		fn === undefined ||
		!ts.isStringLiteral(fn) ||
		fn.text !== "set_config" ||
		list === undefined ||
		!ts.isArrayLiteralExpression(list)
	) {
		return
	}
	const local = list.elements[2]
	const flag = local !== undefined && ts.isCallExpression(local) ? local.arguments[0] : undefined
	if (
		local !== undefined &&
		ts.isCallExpression(local) &&
		textOf(site, local.expression) === "lit.bool" &&
		flag !== undefined &&
		flag.kind === ts.SyntaxKind.TrueKeyword
	) {
		site.add("world-claims-session", flag.getStart(site.source), flag.end, "false")
	}
}

/** Every `sql-world` mutant one node of a world file holds; the caller visits every node. */
const visitWorld: (site: WorldSite, node: ts.Node) => void = (site, node) => {
	if (ts.isCallExpression(node)) {
		worldCall(site, node)
		catalogBare(site, node)
		sessionSetting(site, node)
	}
	if (ts.isTemplateExpression(node)) {
		policyTemplate(site, node)
		headerText(site, node)
	}
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		plainString(site, node)
	}
	if (ts.isObjectLiteralExpression(node)) {
		worldObject(site, node)
	}
	if (ts.isArrayLiteralExpression(node)) {
		guardElement(site, node)
	}
	if (ts.isPropertyAssignment(node)) {
		worldProperty(site, node)
	}
	readsFlip(site, node)
	preconditionDrop(site, node)
}

/** The `sql-world` family: every world operator, in the world files alone, each found by `visitWorld`. */
export const sqlWorld: Family<WorldOperator> = {
	operators: worldOperators,
	applies: isWorldFile,
	rules: [
		(node, site) =>
			visitWorld(
				{
					file: site.file,
					text: site.text,
					source: site.source,
					add: (operator, start, end, replacement) =>
						site.add(operator, { start, end }, replacement)
				},
				node
			)
	]
}

/** The occurrences of `needle` in `text`, as offsets, with the text each matched. */
const occurrences = (
	text: string,
	needle: RegExp
): ReadonlyArray<{ readonly at: number; readonly match: string }> =>
	Arr.flatMap([...Str.matchAll(needle)(text)], (m) =>
		m.index === undefined ? [] : [{ at: m.index, match: m[0] }]
	)

/**
 * SQL text inside a string literal or a template part: UNION ALL and UNION swapped, DISTINCT dropped. Only SQL: a
 * literal that is a set keyword alone, or reads like a statement; prose that names UNION is left alone.
 */
const sqlText: Rule<"set-semantics"> = (node, { add, source, text }) => {
	if (
		!(
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateLiteralToken(node)
		) ||
		(!regex("^\\s*(?:UNION(?: ALL)?|DISTINCT)\\s*$").test(node.text) &&
			!regex("\\b(?:SELECT|FROM|WHERE|JOIN)\\b").test(node.text))
	) {
		return
	}
	const start = node.getStart(source)
	const raw = Str.slice(start, node.end)(text)
	for (const { at } of occurrences(raw, regex("\\bUNION ALL\\b", "g"))) {
		add("set-semantics", { start: start + at, end: start + at + 9 }, "UNION")
	}
	for (const { at } of occurrences(raw, regex("\\bUNION\\b(?! ALL\\b)", "g"))) {
		add("set-semantics", { start: start + at, end: start + at + 5 }, "UNION ALL")
	}
	for (const { at, match } of occurrences(
		raw,
		regex("(?<!\\bIS (?:NOT )?)\\bDISTINCT (?!FROM\\b)", "g")
	)) {
		add("set-semantics", { start: start + at, end: start + at + match.length }, "")
	}
}

/** A `distinct: true` or `distinct: false` flag of an AST or a plan, flipped. */
const distinctFlag: Rule<"set-semantics"> = (node, { add, source }) => {
	if (
		!ts.isPropertyAssignment(node) ||
		!ts.isIdentifier(node.name) ||
		node.name.text !== "distinct"
	) {
		return
	}
	const value = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer
	if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
		add(
			"set-semantics",
			{ start: value.getStart(source), end: value.end },
			value.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true"
		)
	}
}

/**
 * The `set-semantics` family, in every file: grizzle's slips between a bag and a set, UNION ALL swapped with UNION and
 * a DISTINCT dropped in SQL text, and a `distinct` flag flipped.
 */
export const setSemantics: Family<"set-semantics"> = {
	operators: ["set-semantics"],
	applies: () => true,
	rules: [sqlText, distinctFlag]
}

/** Every operator grizzle's mutation runs choose from: the library's, set-semantics, and the sql-world family's. */
export type Operator = LibraryOperator | "set-semantics" | WorldOperator

export const operators: ReadonlyArray<Operator> = [...OPERATORS, "set-semantics", ...worldOperators]

/**
 * The classic family: comparison, conjunct, boolean-return and bound and guard from the library, and set-semantics,
 * grizzle's own.
 */
const classicOperators = [
	"comparison",
	"conjunct",
	"boolean-return",
	"set-semantics",
	"bound",
	"guard"
] as const

/**
 * The operator families a run names with --operators, each the operators it stands for: `classic`, `sql-world`, and
 * `library`, every operator of the library's.
 */
export const families: Readonly<Record<string, ReadonlyArray<Operator>>> = {
	classic: classicOperators,
	"sql-world": worldOperators,
	library: OPERATORS
}

/** The operators a run tests when it names none: the classic and sql-world families. */
export const defaultOperators: ReadonlyArray<Operator> = [...classicOperators, ...worldOperators]
