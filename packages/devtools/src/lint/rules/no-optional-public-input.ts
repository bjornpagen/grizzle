import { Array as Arr, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import {
	type Checker,
	type NodeHandle,
	type Symbol as NativeSymbol,
	SymbolFlags,
	type Type,
	TypeFlags
} from "typescript/sync"
import { isOwnSourcePath } from "#lint/paths.ts"
import type { Start } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

/** Which way a value crosses the surface: an input the caller hands the package, or an output the package hands the
 * caller. */
type Direction = "input" | "output"

const reversed = (direction: Direction): Direction => (direction === "input" ? "output" : "input")

/** A type the walk has still to read, the way it crosses, and the path that reached it, named in the report. */
type Reached = Readonly<{ type: Type; direction: Direction; path: string }>

/** An optional property of a public input: its declaration, its name, and the path that first reached it. */
type Found = Readonly<{ declaration: NodeHandle; name: string; path: string }>

/** Whether a declaration lies in the program's own source rather than an installed package or a declaration file. */
const isOwnSource = (handle: NodeHandle): boolean => isOwnSourcePath(handle.path)

const handleKey = (handle: NodeHandle): string => `${handle.path}#${String(handle.index)}`

/** The checker names a property keyed by a unique symbol `__@<name>@<id>`. */
const isSymbolKeyed = (property: NativeSymbol): boolean =>
	Str.startsWith("__@")(property.escapedName)

/** A key typed never or undefined holds no value: an optional one only refuses the key, and leaving it out is the
 * one way to meet it. */
const REFUSING = TypeFlags.Never | TypeFlags.Undefined

/** The exported values of the surface's modules, each the start of the walk: an output named as the module exports it. */
const surfaceValuesOf = (
	checker: Checker,
	surface: ReadonlyArray<string>
): ReadonlyArray<Reached> => {
	const values = Arr.flatMap(surface, (entry) => {
		const module = checker.getSymbolOfSourceFile(entry)
		if (module === undefined) {
			return []
		}
		return Arr.filterMap(checker.getExportsOfModule(module), (exported) => {
			const target =
				(exported.flags & SymbolFlags.Alias) === 0 ? exported : checker.getAliasedSymbol(exported)
			return (target.flags & SymbolFlags.Value) === 0
				? Result.failVoid
				: Result.succeed({ name: exported.name, target })
		})
	})
	if (!Arr.isReadonlyArrayNonEmpty(values)) {
		return []
	}
	const types = checker.getTypeOfSymbol(Arr.map(values, (value) => value.target))
	return Arr.map(Arr.zip(values, types), ([value, type]) => ({
		type,
		direction: "output",
		path: value.name
	}))
}

/** Every optional property of a public input the surface reaches, once each, with the first path that reached it. */
const optionalInputsOf = (
	checker: Checker,
	surface: ReadonlyArray<string>
): ReadonlyArray<Found> => {
	const pending: Array<Reached> = [...surfaceValuesOf(checker, surface)]
	const walked = new Set<string>()
	const found = new Map<string, Found>()
	const firstTime = (key: string): boolean => {
		if (walked.has(key)) {
			return false
		}
		walked.add(key)
		return true
	}
	const reach = (type: Type, direction: Direction, path: string): void => {
		pending.push({ type, direction, path })
	}

	const typeArguments = (type: Type, direction: Direction, path: string): void => {
		for (const argument of type.getAliasTypeArguments()) {
			reach(argument, direction, path)
		}
		if (type.isTypeReference()) {
			for (const argument of checker.getTypeArguments(type)) {
				reach(argument, direction, path)
			}
		}
	}

	const signatures = (type: Type, direction: Direction, path: string): void => {
		const unread = Arr.filter(
			[...type.getCallSignatures(), ...type.getConstructSignatures()],
			({ declaration, id }) =>
				firstTime(
					`call ${direction} ${declaration === undefined ? `signature ${String(id)}` : handleKey(declaration)}`
				)
		)
		for (const signature of unread) {
			const parameters = signature.getParameters()
			if (Arr.isReadonlyArrayNonEmpty(parameters)) {
				for (const [parameter, parameterType] of Arr.zip(
					parameters,
					checker.getTypeOfSymbol(parameters)
				)) {
					reach(parameterType, reversed(direction), `${path}(${parameter.name})`)
				}
			}
			reach(signature.getReturnType(), direction, `${path}()`)
		}
	}

	const properties = (type: Type, direction: Direction, path: string): void => {
		const own = Arr.filter(type.getProperties(), (property) => {
			const [declaration] = property.declarations
			return (
				declaration !== undefined &&
				isOwnSource(declaration) &&
				!isSymbolKeyed(property) &&
				firstTime(`property ${direction} ${handleKey(declaration)}`)
			)
		})
		if (!Arr.isReadonlyArrayNonEmpty(own)) {
			return
		}
		for (const [property, propertyType] of Arr.zip(own, checker.getTypeOfSymbol(own))) {
			const [declaration] = property.declarations
			if (
				direction === "input" &&
				declaration !== undefined &&
				(property.flags & SymbolFlags.Optional) !== 0 &&
				(checker.getNonMissingTypeOfSymbol(property).flags & REFUSING) === 0 &&
				!found.has(handleKey(declaration))
			) {
				found.set(handleKey(declaration), { declaration, name: property.name, path })
			}
			reach(propertyType, direction, `${path}.${property.name}`)
		}
	}

	const objectType = (type: Type, direction: Direction, path: string): void => {
		const [declaration] = type.getSymbol()?.declarations ?? []
		const library = declaration !== undefined && !isOwnSource(declaration)
		if (
			checker.isArrayType(type) ||
			checker.isTupleType(type) ||
			(library && !type.isMappedType())
		) {
			typeArguments(type, direction, path)
			return
		}
		signatures(type, direction, path)
		for (const index of checker.getIndexInfosOfType(type)) {
			reach(index.valueType, direction, `${path}[key]`)
		}
		properties(type, direction, path)
	}

	const read = ({ type, direction, path }: Reached): void => {
		if (!firstTime(`type ${direction} ${String(type.id)}`)) {
			return
		}
		if (type.isUnionType() || type.isIntersectionType()) {
			for (const member of type.getTypes()) {
				reach(member, direction, path)
			}
			return
		}
		if (type.isConditionalType()) {
			reach(type.getTrueType(), direction, path)
			reach(type.getFalseType(), direction, path)
			return
		}
		if (type.isSubstitutionType()) {
			reach(type.getBaseType(), direction, path)
			return
		}
		if (type.isTypeParameter() || type.isIndexedAccessType()) {
			const constraint = direction === "input" ? checker.getBaseConstraintOfType(type) : undefined
			if (constraint !== undefined) {
				reach(constraint, direction, path)
			}
			return
		}
		if (type.isObjectType()) {
			objectType(type, direction, path)
		}
	}

	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		read(next)
	}
	return Arr.fromIterable(found.values())
}

/** The node a report points at: a property's name, where the declaration has one. */
const reportedAt = (declaration: ts.Node): ts.Node =>
	ts.isPropertySignatureDeclaration(declaration) || ts.isPropertyDeclaration(declaration)
		? declaration.name
		: declaration

/**
 * no-optional-public-input: a public input type has no optional property. A caller who leaves a key out states
 * nothing, and every reader of the input then guesses what the gap meant; absence is a variant the type names, `T |
 * undefined` where nothing is a value, or a case of its own where the absence means something.
 *
 * The public surface is what a package publishes: the source module of every public subpath of its package.json
 * `exports` map, the map fallow and the package's consumers resolve (lint/surface.ts reads it; a subpath under
 * `./internal/` is a door between the repository's own packages, never public). A public input is every type a
 * caller hands the package through that surface, found by a walk over the checker's types that tracks which way each
 * value crosses:
 *
 * - every value a public module exports is an output: the package hands it to the caller;
 * - an output's call and construct signatures take inputs (their parameters) and give outputs (their returns), and its
 *   properties are outputs, so a builder's methods, reached through what the package returns, take inputs too;
 * - an input's properties, index signatures' values and members are inputs, and a function the caller passes in turns
 *   it around: its parameters are outputs, what it returns an input;
 * - a type parameter in an input is its constraint, the shape every argument meets, while an output typed by a type
 *   parameter is the caller's own value handed back, which adds nothing;
 * - a conditional type is both its branches, a union or intersection each member;
 * - a library's type (declared under node_modules or in a declaration file) is its library's contract and is not
 *   entered, but its type arguments are its payload and keep its direction, as an array's and a tuple's elements do;
 *   a mapped type of the library (Readonly, Partial, Record) is entered, since its properties are ours.
 *
 * Each declaration is walked once per direction, at the first instantiation the walk meets, which keeps a recursive
 * builder finite. What is not an option: a key typed never or undefined, which only refuses a value (the exclusive
 * keys of a page request), and a key named by a symbol, a phantom no caller can spell. The rule reports the optional
 * property at its declaration, in the run of the package that declares it.
 */
export const noOptionalPublicInput: Start = ({ checker, surface }) => {
	const reports = new Map<ts.Node, Report>()
	for (const { declaration, name, path } of optionalInputsOf(checker, surface)) {
		const node = declaration.resolve()
		if (node !== undefined) {
			reports.set(node, {
				node: reportedAt(node),
				message: `The public input property '${name}' is optional (reached as ${path}): a caller who leaves a key out states nothing, so absence is a variant the type names.`,
				suggestion: `Make '${name}' required: '${name}: T | undefined' where nothing is a value, or give the case its own variant where the absence means something.`
			})
		}
	}
	return () => (node) => {
		const report = reports.get(node)
		return report === undefined ? [] : [report]
	}
}
