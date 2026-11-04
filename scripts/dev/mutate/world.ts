import { Array as Arr, Option, Result, String as Str } from "effect"
import * as ts from "typescript/ast"

import { regex } from "arkregex"
/**
 * The operators of the `sql-world` family, each a compiler bug in the SQL that installs and enters a world:
 *
 * - world-conjunct: one argument of a SQL builder `and(...)` dropped, a conjunct of a policy's, a key probe's or a
 *   filter's predicate;
 * - world-policy-true: a policy's USING or its WITH CHECK printed as `true`;
 * - world-policy-swap: a policy's USING and WITH CHECK expressions swapped, where they differ;
 * - world-barrier: security_barrier dropped from a view, in the printer and where a view's AST asks for it;
 * - world-definer: a function printed SECURITY INVOKER instead of its declared security;
 * - world-search-path: a function's search_path pin left out of its header;
 * - world-catalog-bare: a pg_catalog type or a builtin function printed by its bare name, resolved through the session's
 *   search path, instead of qualified by pg_catalog;
 * - world-grant: SELECT, UPDATE or TRUNCATE added to a privilege list a role is granted: a base-table SELECT,
 *   UPDATE on an immutable relation, TRUNCATE;
 * - world-public-execute: EXECUTE granted to PUBLIC right after a function's REVOKE from PUBLIC;
 * - world-membership: a membership granted WITH INHERIT TRUE or SET FALSE, or a login created INHERIT;
 * - world-claims-session: a prologue `set_config` made for the session instead of the transaction;
 * - world-context-field: a context source's claims read at the wrong key, each field read at its context's name;
 * - world-witness: a law function's DETAIL witness shown whatever the transaction's role;
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
	"world-policy-swap",
	"world-barrier",
	"world-definer",
	"world-search-path",
	"world-catalog-bare",
	"world-grant",
	"world-public-execute",
	"world-membership",
	"world-claims-session",
	"world-context-field",
	"world-witness",
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

/**
 * The files whose code builds the emitted world SQL: the role, view, policy, function and grant DDL, the advance
 * function and the isolation guard, the residual law functions, the membership rendering, the claims lowering, the
 * printer, and the adapter's transaction prologue; and the declarations every emitted reading and aggregate is
 * rendered by, the Compute catalogue and the aggregate overloads. Only their code takes a `sql-world` mutant.
 */
const worldPaths: ReadonlyArray<string> = [
	registryPath,
	aggregatePath,
	"packages/engine/src/physical/ddl/roles.ts",
	"packages/engine/src/physical/ddl/advance.ts",
	"packages/engine/src/physical/ddl/isolation.ts",
	"packages/engine/src/laws/residual/",
	"packages/engine/src/write/entry/",
	"packages/engine/src/lower/conservative/claims/",
	"packages/engine/src/sql/print.ts",
	"packages/grizzle/src/adapter/wire/batch.ts",
	"packages/grizzle/src/adapter/wire/session.ts"
]

export const isWorldFile = (file: string): boolean =>
	Arr.some(worldPaths, (path) => Str.startsWith(path)(file))

/** Where a world operator found a fault to plant: the file's text, its syntax tree, and the sink of mutants. */
export interface WorldSite {
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

/** world-policy-true and world-policy-swap on one template literal and its siblings. */
const policyTemplate = (site: WorldSite, node: ts.TemplateExpression): void => {
	const start = node.getStart(site.source)
	const raw = textOf(site, node)
	for (const clause of policyClauses) {
		for (const sub of Option.toArray(substitutionAfter(raw, clause))) {
			site.add("world-policy-true", start + sub.start, start + sub.end, "true")
		}
	}
	const parent = node.parent
	const using = substitutionAfter(raw, "USING (")
	if (!ts.isArrayLiteralExpression(parent) || Option.isNone(using)) {
		return
	}
	const checks = Arr.filterMap(parent.elements, (e) => {
		const sub = ts.isTemplateExpression(e)
			? substitutionAfter(textOf(site, e), "WITH CHECK (")
			: Option.none()
		return Option.isSome(sub) ? Result.succeed({ node: e, sub: sub.value }) : Result.failVoid
	})
	for (const check of checks) {
		swapClauses(site, node, using.value, check)
	}
}

/** world-policy-swap: the USING expression of `node` at `using` and a sibling's WITH CHECK expression swapped. */
const swapClauses = (
	site: WorldSite,
	node: ts.TemplateExpression,
	using: Span,
	check: { readonly node: ts.Expression; readonly sub: Span }
): void => {
	const start = node.getStart(site.source)
	const raw = textOf(site, node)
	const checkRaw = textOf(site, check.node)
	const withCheck = check.sub
	const usingExpr = Str.slice(using.start, using.end)(raw)
	const checkExpr = Str.slice(withCheck.start, withCheck.end)(checkRaw)
	const checkStart = check.node.getStart(site.source)
	const between = Str.slice(start + using.end, checkStart + withCheck.start)(site.text)
	site.add(
		"world-policy-swap",
		start + using.start,
		checkStart + withCheck.end,
		`${checkExpr}${between}${usingExpr}`
	)
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

/** world-barrier and world-claims-session on one plain string literal. */
const plainString = (
	site: WorldSite,
	node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral
): void => {
	const start = node.getStart(site.source)
	const raw = textOf(site, node)
	if (Str.includes("security_barrier")(raw)) {
		site.add("world-barrier", start, node.end, '""')
	}
	for (const match of Str.matchAll(regex("set_config\\('[^']*', \\$\\d+, true\\)", "g"))(raw)) {
		for (const index of Option.toArray(Option.fromUndefinedOr(match.index))) {
			const at = start + index + match[0].length - "true)".length
			site.add("world-claims-session", at, at + "true".length, "false")
		}
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

/** world-conjunct, world-grant and world-advance-max on one call. */
const worldCall = (site: WorldSite, call: ts.CallExpression): void => {
	const name = calleeName(call)
	const args = call.arguments
	if (name === "and" && args.length >= 2) {
		for (const dropped of args.keys()) {
			const kept = Arr.remove(args, dropped)
			site.add(
				"world-conjunct",
				call.getStart(site.source),
				call.end,
				`and(${Arr.join(
					Arr.map(kept, (a) => textOf(site, a)),
					", "
				)})`
			)
		}
	}
	const [first] = args
	if (name === "grant" && first !== undefined) {
		for (const list of privilegeLists(first)) {
			privilegeList(site, list)
		}
	}
	const where = args[2]
	const advance = site.file === "packages/engine/src/physical/ddl/advance.ts"
	if (
		advance &&
		name === "simpleSelect" &&
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

/** world-barrier on `barrier: true`, world-witness on a CASE's `when: <identifier>`. */
const worldProperty = (site: WorldSite, p: ts.PropertyAssignment): void => {
	if (!ts.isIdentifier(p.name)) {
		return
	}
	const value = p.initializer
	if (p.name.text === "barrier" && value.kind === ts.SyntaxKind.TrueKeyword) {
		site.add("world-barrier", value.getStart(site.source), value.end, "false")
	}
	const residual = Str.startsWith("packages/engine/src/laws/residual/")(site.file)
	if (residual && p.name.text === "when" && ts.isIdentifier(value)) {
		site.add("world-witness", value.getStart(site.source), value.end, "lit.bool(true)")
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

/** Every `sql-world` mutant one node of a world file holds; the caller visits every node. */
export const visitWorld: (site: WorldSite, node: ts.Node) => void = (site, node) => {
	if (ts.isCallExpression(node)) {
		worldCall(site, node)
		catalogBare(site, node)
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
