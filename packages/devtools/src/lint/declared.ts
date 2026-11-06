import { Array as Arr, Option, Result } from "effect"
import { type Checker, type Symbol as NativeSymbol, SymbolFlags, type Type } from "typescript/sync"
import { directoriesAbove } from "#lint/paths.ts"

/** A type alias a repository module exports, by the module's repository-relative path and the alias's name. */
export type DeclaredAlias = Readonly<{ module: string; alias: string }>

/** The declared aliases a rule reads, as the linted file's program holds them: the types found, and the aliases the
 * program does not hold, which the rule reports as a misconfigured option. */
export type DeclaredAliases<A> = Readonly<{
	found: ReadonlyArray<Readonly<{ declared: A; type: Type }>>
	missing: ReadonlyArray<A>
}>

/** The program's module at a repository-relative path. The repository root is one of the directories above the
 * linted file, so the module is the first file at the path beside one of them; the checker refuses a path the program
 * does not hold. */
const moduleOf = (
	checker: Checker,
	fileName: string,
	module: string
): Option.Option<NativeSymbol> =>
	Arr.findFirst(directoriesAbove(fileName), (directory) =>
		Option.flatMap(
			Result.getSuccess(Result.try(() => checker.getSymbolOfSourceFile(`${directory}/${module}`))),
			Option.fromUndefinedOr
		)
	)

/** The type an exported alias declares, the alias resolved when the module re-exports it. */
const aliasTypeOf = (checker: Checker, module: NativeSymbol, alias: string): Option.Option<Type> =>
	Option.flatMap(
		Option.fromUndefinedOr(checker.getMemberInModuleExports(module, alias)),
		(exported) => {
			const symbol =
				(exported.flags & SymbolFlags.Alias) === 0 ? exported : checker.getAliasedSymbol(exported)
			return (symbol.flags & SymbolFlags.TypeAlias) === 0
				? Option.none()
				: Option.some(checker.getDeclaredTypeOfSymbol(symbol))
		}
	)

/** Each declared alias's type in the linted file's program, read through the checker. */
export const declaredAliasesOf = <A extends DeclaredAlias>(
	input: Readonly<{ checker: Checker; fileName: string; declared: ReadonlyArray<A> }>
): DeclaredAliases<A> => {
	const { checker, fileName } = input
	const modules = new Map(
		Arr.map(
			Arr.dedupe(Arr.map(input.declared, (declared) => declared.module)),
			(module): readonly [string, Option.Option<NativeSymbol>] => [
				module,
				moduleOf(checker, fileName, module)
			]
		)
	)
	const resolved = Arr.map(input.declared, (declared) => ({
		declared,
		type: Option.flatMap(
			Option.flatten(Option.fromUndefinedOr(modules.get(declared.module))),
			(module) => aliasTypeOf(checker, module, declared.alias)
		)
	}))
	return {
		found: Arr.filterMap(resolved, ({ declared, type }) =>
			Option.match(type, {
				onNone: () => Result.failVoid,
				onSome: (value) => Result.succeed({ declared, type: value })
			})
		),
		missing: Arr.filterMap(resolved, ({ declared, type }) =>
			Option.isNone(type) ? Result.succeed(declared) : Result.failVoid
		)
	}
}

/** The report text for a declared alias the program does not hold. */
export const missingAliasMessage = (option: string, declared: DeclaredAlias): string =>
	`The superlint option ${option} names the type alias ${declared.alias} of ${declared.module}, which this file's program does not hold.`

/** A value a repository module exports, by the module's repository-relative path and the value's name. */
export type DeclaredValue = Readonly<{ module: string; name: string }>

/** The declared values a rule reads, as the linted file's program holds them: the symbol each finally names, an
 * import alias resolved, and the values the program does not hold, which the rule reports as a misconfigured option. */
export type DeclaredValues<A> = Readonly<{
	found: ReadonlyArray<Readonly<{ declared: A; symbol: NativeSymbol }>>
	missing: ReadonlyArray<A>
}>

/** The symbol an exported value finally names, the alias resolved when the module re-exports it. */
const valueSymbolOf = (
	checker: Checker,
	module: NativeSymbol,
	name: string
): Option.Option<NativeSymbol> =>
	Option.flatMap(
		Option.fromUndefinedOr(checker.getMemberInModuleExports(module, name)),
		(exported) => {
			const symbol =
				(exported.flags & SymbolFlags.Alias) === 0 ? exported : checker.getAliasedSymbol(exported)
			return (symbol.flags & SymbolFlags.Value) === 0 ? Option.none() : Option.some(symbol)
		}
	)

/** Each declared value's symbol in the linted file's program, read through the checker. */
export const declaredValuesOf = <A extends DeclaredValue>(
	input: Readonly<{ checker: Checker; fileName: string; declared: ReadonlyArray<A> }>
): DeclaredValues<A> => {
	const { checker, fileName } = input
	const modules = new Map(
		Arr.map(
			Arr.dedupe(Arr.map(input.declared, (declared) => declared.module)),
			(module): readonly [string, Option.Option<NativeSymbol>] => [
				module,
				moduleOf(checker, fileName, module)
			]
		)
	)
	const resolved = Arr.map(input.declared, (declared) => ({
		declared,
		symbol: Option.flatMap(
			Option.flatten(Option.fromUndefinedOr(modules.get(declared.module))),
			(module) => valueSymbolOf(checker, module, declared.name)
		)
	}))
	return {
		found: Arr.filterMap(resolved, ({ declared, symbol }) =>
			Option.match(symbol, {
				onNone: () => Result.failVoid,
				onSome: (value) => Result.succeed({ declared, symbol: value })
			})
		),
		missing: Arr.filterMap(resolved, ({ declared, symbol }) =>
			Option.isNone(symbol) ? Result.succeed(declared) : Result.failVoid
		)
	}
}

/** The report text for a declared value the program does not hold. */
export const missingValueMessage = (option: string, declared: DeclaredValue): string =>
	`The superlint option ${option} names the value ${declared.name} of ${declared.module}, which this file's program does not hold.`
