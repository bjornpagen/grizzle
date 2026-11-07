import { Array as Arr, Option } from "effect"
import * as ts from "typescript/ast"
import { type Symbol as NativeSymbol, SymbolFlags } from "typescript/sync"
import { declaredValuesOf, missingValueMessage } from "#lint/declared.ts"
import type { Draws, SuperlintOptions } from "#lint/options.ts"
import { isAtAny } from "#lint/paths.ts"
import type { RuleContext, Start } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"
import { relativeTo } from "#shared/repository.ts"

type NoCaseList = SuperlintOptions["noCaseList"]

/** What makes a space a list of cases: a list written in the tests it draws from, or the one value it holds. */
type CaseList =
	| Readonly<{ kind: "written"; list: ts.ArrayLiteralExpression }>
	| Readonly<{ kind: "single" }>

/** The searches and generators the options name, by the symbol each is, and the reports for those the program does
 * not hold. */
type Named = Readonly<{
	spaces: ReadonlyMap<number, string>
	draws: ReadonlyMap<number, Draws>
	misconfigured: ReadonlyArray<string>
}>

/** An expression as written, through parentheses, type assertions, `satisfies` and non-null assertions. */
const bare = (expression: ts.Expression): ts.Expression =>
	ts.isParenthesizedExpression(expression) ||
	ts.isAsExpression(expression) ||
	ts.isSatisfiesExpression(expression) ||
	ts.isNonNullExpression(expression) ||
	ts.isTypeAssertion(expression)
		? bare(expression.expression)
		: expression

const isFunctionLiteral = (expression: ts.Expression): boolean =>
	ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)

/** A literal that is no generator and no list: a weight, a label. */
const isPrimitiveLiteral = (expression: ts.Expression): boolean =>
	ts.isStringLiteral(expression) ||
	ts.isNoSubstitutionTemplateLiteral(expression) ||
	ts.isTemplateExpression(expression) ||
	ts.isNumericLiteral(expression) ||
	ts.isBigIntLiteral(expression) ||
	ts.isPrefixUnaryExpression(expression)

const isConstList = (node: ts.Node): boolean =>
	ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0

/** A property's name as written, when it is an identifier or a string. */
const propertyNameOf = (name: ts.PropertyName): Option.Option<string> =>
	ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
		? Option.some(name.text)
		: Option.none()

/**
 * no-case-list: a search's space is never a list of cases. A test is an example when a person chose its inputs and
 * wrote its verdict, and a list of cases run through `exhaust` or `explore` is one: the search only replays what the
 * list holds. In the files the options name, for every call of a search they name (`exhaust`, `explore`), the space its
 * spec holds (`generator`, `draw`) is refused when it is a case list:
 *
 * - `element` over a list written in the tests: an array literal of the files the options name, outside the
 *   dictionaries, which hold the values the code branches on; held by a constant, or computed from one by a call
 *   (`nonEmpty(cases)`, `Arr.filter(cases, …)`); an array literal of spreads alone writes nothing of its own;
 * - `constant`, one value, which is one case;
 * - a generator that draws one value for each of another's (`map`, `span`, `filter`, `drawn`, `sketched`) over a case
 *   list;
 * - a choice among generators (`oneOf`, `weighted`, `proportional`) whose every option is a case list.
 *
 * A space built from bounds (`int(0, 3)`, `array(g, { min, max })`), from a dictionary, or from a roster the source
 * declares is a generator and passes, as does a product of generators (`record`, `array`) whose dimensions draw from
 * written values: a dictionary's values are inputs the code branches on, never verdicts. Whether a drawn record's field
 * is the verdict a case asserts is not decided here: it needs the flow of the drawn value through the generators and
 * the property's branches (a `switch` on a drawn case name that picks a written verdict), which no syntactic reading
 * settles, so the rule refuses the list itself, whatever its members carry. Names are resolved through the checker,
 * import aliases followed: a search or a generator is the very symbol a configured module exports.
 */
export const noCaseList: Start = ({ checker }) => {
	let named = Option.none<Named>()
	const namedOf = (fileName: string, options: NoCaseList): Named => {
		if (Option.isSome(named)) {
			return named.value
		}
		const searches = declaredValuesOf({ checker, fileName, declared: options.searches })
		const generators = declaredValuesOf({
			checker,
			fileName,
			declared: Arr.flatMap(options.generators, ({ module, names, draws }) =>
				Arr.map(names, (name) => ({ module, name, draws }))
			)
		})
		const resolved: Named = {
			spaces: new Map(
				Arr.map(searches.found, ({ declared, symbol }): readonly [number, string] => [
					symbol.id,
					declared.space
				])
			),
			draws: new Map(
				Arr.map(generators.found, ({ declared, symbol }): readonly [number, Draws] => [
					symbol.id,
					declared.draws
				])
			),
			misconfigured: [
				...Arr.map(searches.missing, (missing) =>
					missingValueMessage("noCaseList.searches", missing)
				),
				...Arr.map(generators.missing, (missing) =>
					missingValueMessage("noCaseList.generators", missing)
				)
			]
		}
		named = Option.some(resolved)
		return resolved
	}
	return (context: RuleContext) => visitOf(context, namedOf)
}

const visitOf = (
	context: RuleContext,
	namedOf: (fileName: string, options: NoCaseList) => Named
): ((node: ts.Node) => ReadonlyArray<Report>) => {
	const { sourceFile, checker, semantics, options, root } = context
	const { files } = options.noCaseList
	const dictionaries = Arr.flatMap(
		options.noCaseList.dictionaries,
		(dictionary) => dictionary.files
	)
	if (!isAtAny(root, files, sourceFile.fileName)) {
		return () => []
	}
	const targetOf = (node: ts.Node): NativeSymbol | undefined => {
		const symbol = semantics.symbolAt(node)
		return symbol === undefined ? undefined : semantics.aliasTarget(symbol)
	}
	/** The value a name holds: a constant's initializer, or a property's value. */
	const heldBy = (node: ts.Node): Option.Option<ts.Expression> => {
		const { parent } = node
		const symbol =
			ts.isShorthandPropertyAssignment(parent) && parent.name === node
				? checker.getShorthandAssignmentValueSymbol(parent)
				: targetOf(node)
		if (symbol === undefined || (symbol.flags & SymbolFlags.Value) === 0) {
			return Option.none()
		}
		return Arr.findFirst(semantics.declarationsOf(semantics.aliasTarget(symbol)), (declaration) => {
			if (
				ts.isVariableDeclaration(declaration) &&
				declaration.initializer !== undefined &&
				isConstList(declaration.parent)
			) {
				return Option.some(declaration.initializer)
			}
			return ts.isPropertyAssignment(declaration)
				? Option.some(declaration.initializer)
				: Option.none()
		})
	}
	const isWritten = (list: ts.ArrayLiteralExpression): boolean => {
		const file = list.getSourceFile().fileName
		return isAtAny(root, files, file) && !isAtAny(root, dictionaries, file)
	}
	/** The list written in the tests that an expression is, holds or is computed from. */
	const writtenListOf = (
		expression: ts.Expression,
		seen: Set<ts.Node>
	): Option.Option<ts.ArrayLiteralExpression> => {
		const node = bare(expression)
		if (seen.has(node)) {
			return Option.none()
		}
		seen.add(node)
		if (ts.isArrayLiteralExpression(node)) {
			if (!isWritten(node)) {
				return Option.none()
			}
			return Arr.some(node.elements, (element) => !ts.isSpreadElement(element))
				? Option.some(node)
				: Arr.findFirst(node.elements, (element) =>
						ts.isSpreadElement(element) ? writtenListOf(element.expression, seen) : Option.none()
					)
		}
		if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
			return Option.flatMap(heldBy(ts.isIdentifier(node) ? node : node.name), (held) =>
				writtenListOf(held, seen)
			)
		}
		return ts.isCallExpression(node)
			? Arr.findFirst(node.arguments, (argument) =>
					isFunctionLiteral(bare(argument)) ? Option.none() : writtenListOf(argument, seen)
				)
			: Option.none()
	}
	/** The generators a choice offers: its arguments, through the lists that hold them, without the weights beside them;
	 * a function written in place is a generator of its own, and so an option that is no case list. */
	const optionsOf = (
		expressions: ReadonlyArray<ts.Expression>,
		seen: Set<ts.Node>
	): ReadonlyArray<ts.Expression> =>
		Arr.flatMap(expressions, (expression) => {
			const node = bare(expression)
			if (isPrimitiveLiteral(node) || seen.has(node)) {
				return []
			}
			seen.add(node)
			if (ts.isArrayLiteralExpression(node)) {
				return optionsOf(node.elements, seen)
			}
			if (ts.isIdentifier(node)) {
				const held = heldBy(node)
				return Option.exists(held, (value) => ts.isArrayLiteralExpression(bare(value)))
					? optionsOf(Option.toArray(held), seen)
					: [node]
			}
			return [node]
		})
	/** Whether a space is a case list, and what makes it one. */
	const caseListOf = (
		named: Named,
		expression: ts.Expression,
		seen: Set<ts.Node>
	): Option.Option<CaseList> => {
		const node = bare(expression)
		if (seen.has(node)) {
			return Option.none()
		}
		seen.add(node)
		if (ts.isIdentifier(node)) {
			return Option.flatMap(heldBy(node), (held) => caseListOf(named, held, seen))
		}
		if (!ts.isCallExpression(node)) {
			return Option.none()
		}
		const callee = targetOf(node.expression)
		const draws = callee === undefined ? undefined : named.draws.get(callee.id)
		const [first] = node.arguments
		switch (draws) {
			case undefined:
				return Option.none()
			case "list":
				return first === undefined
					? Option.none()
					: Option.map(writtenListOf(first, new Set()), (list): CaseList => ({
							kind: "written",
							list
						}))
			case "value":
				return Option.some({ kind: "single" })
			case "each":
				return Arr.findFirst(node.arguments, (argument) =>
					isFunctionLiteral(bare(argument)) || isPrimitiveLiteral(bare(argument))
						? Option.none()
						: caseListOf(named, argument, seen)
				)
			case "union": {
				const lists = Arr.map(optionsOf(node.arguments, new Set()), (option) =>
					caseListOf(named, option, seen)
				)
				return Arr.isReadonlyArrayNonEmpty(lists) && Arr.every(lists, Option.isSome)
					? Arr.headNonEmpty(lists)
					: Option.none()
			}
		}
	}
	/** The spec object a search is handed, as written or held by a constant. */
	const specOf = (expression: ts.Expression): Option.Option<ts.ObjectLiteralExpression> => {
		const node = bare(expression)
		if (ts.isObjectLiteralExpression(node)) {
			return Option.some(node)
		}
		return ts.isIdentifier(node) ? Option.flatMap(heldBy(node), specOf) : Option.none()
	}
	/** The property of a spec that holds its space, and the space. */
	const spaceOf = (
		spec: ts.ObjectLiteralExpression,
		name: string
	): Option.Option<Readonly<{ property: ts.Node; space: ts.Expression }>> =>
		Arr.findLast(
			spec.properties,
			(property): Option.Option<Readonly<{ property: ts.Node; space: ts.Expression }>> => {
				if (ts.isPropertyAssignment(property)) {
					return Option.contains(propertyNameOf(property.name), name)
						? Option.some({ property, space: property.initializer })
						: Option.none()
				}
				return ts.isShorthandPropertyAssignment(property) &&
					ts.isIdentifier(property.name) &&
					property.name.text === name
					? Option.some({ property, space: property.name })
					: Option.none()
			}
		)
	let reported = false
	return (node) => {
		if (!ts.isCallExpression(node)) {
			return []
		}
		const callee = targetOf(node.expression)
		if (callee === undefined) {
			return []
		}
		const named = namedOf(sourceFile.fileName, options.noCaseList)
		const misconfiguration = reported
			? []
			: Arr.map(named.misconfigured, (message): Report => ({ node, message }))
		reported = reported || Arr.isReadonlyArrayNonEmpty(misconfiguration)
		const name = named.spaces.get(callee.id)
		const [spec] = node.arguments
		if (name === undefined || spec === undefined) {
			return misconfiguration
		}
		const found = Option.flatMap(
			Option.flatMap(specOf(spec), (literal) => spaceOf(literal, name)),
			({ property, space }) =>
				Option.map(caseListOf(named, space, new Set()), (list) => ({ property, list }))
		)
		return Option.match(found, {
			onNone: () => misconfiguration,
			onSome: ({ property, list }) => [...misconfiguration, reportOf({ property, list, root })]
		})
	}
}

const reportOf = ({
	property,
	list,
	root
}: Readonly<{ property: ts.Node; list: CaseList; root: string }>): Report => {
	const suggestion =
		"Draw the space from a generator its bounds define, from a dictionary of the values the code branches on (the superlint option noCaseList.dictionaries), or from a roster the source declares; a case list belongs nowhere."
	switch (list.kind) {
		case "single":
			return {
				node: property,
				message:
					"This search's space is one value: its one case is an example, which a person chose and whose verdict a person wrote.",
				suggestion
			}
		case "written": {
			const file = list.list.getSourceFile()
			const { line } = file.getLineAndCharacterOfPosition(list.list.getStart(file))
			return {
				node: property,
				message: `This search's space is a list of cases written in the tests (${relativeTo(root)(file.fileName)}:${line + 1}): a person chose every input, so the search replays examples.`,
				suggestion
			}
		}
	}
}
