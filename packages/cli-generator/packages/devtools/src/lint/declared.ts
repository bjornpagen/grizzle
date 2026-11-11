import { Array as Arr, Option, Result } from "effect"
import { type Checker, type Symbol as NativeSymbol, SymbolFlags, type Type } from "typescript/sync"
import { directoriesAbove } from "#lint/paths.ts"

/** A type a repository module exports, by the module's repository-relative path and the type's name: a type alias,
 * an interface or a class. */
type DeclaredType = Readonly<{ module: string; type: string }>

/** The declared types a rule reads, as the linted file's program holds them: the types found, and the declarations
 * whose module the program holds without the type, which the rule reports as a misconfigured option. A module the
 * program does not hold declares nothing the file can name, so its types are neither. */
type DeclaredTypes = Readonly<{
	found: ReadonlyArray<Readonly<{ declared: DeclaredType; type: Type }>>
	missing: ReadonlyArray<DeclaredType>
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

/** The symbol flags of a declaration that names a type. */
const DECLARES_TYPE = SymbolFlags.TypeAlias | SymbolFlags.Interface | SymbolFlags.Class

/** The type an export declares, the export resolved when the module re-exports it. */
const declaredTypeOf = (
	checker: Checker,
	module: NativeSymbol,
	name: string
): Option.Option<Type> =>
	Option.flatMap(
		Option.fromUndefinedOr(checker.getMemberInModuleExports(module, name)),
		(exported) => {
			const symbol =
				(exported.flags & SymbolFlags.Alias) === 0 ? exported : checker.getAliasedSymbol(exported)
			return (symbol.flags & DECLARES_TYPE) === 0
				? Option.none()
				: Option.some(checker.getDeclaredTypeOfSymbol(symbol))
		}
	)

/** Each declared type in the linted file's program, read through the checker. */
export const declaredTypesOf = (
	input: Readonly<{ checker: Checker; fileName: string; declared: ReadonlyArray<DeclaredType> }>
): DeclaredTypes => {
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
	const held = Arr.filterMap(input.declared, (declared) =>
		Option.match(Option.flatten(Option.fromUndefinedOr(modules.get(declared.module))), {
			onNone: () => Result.failVoid,
			onSome: (module) =>
				Result.succeed({ declared, type: declaredTypeOf(checker, module, declared.type) })
		})
	)
	return {
		found: Arr.filterMap(held, ({ declared, type }) =>
			Option.match(type, {
				onNone: () => Result.failVoid,
				onSome: (value) => Result.succeed({ declared, type: value })
			})
		),
		missing: Arr.filterMap(held, ({ declared, type }) =>
			Option.isNone(type) ? Result.succeed(declared) : Result.failVoid
		)
	}
}

/** The report text for a declared type its module does not export. */
export const missingTypeMessage = (option: string, declared: DeclaredType): string =>
	`The superlint option ${option} names the type ${declared.type} of ${declared.module}, which that module does not export.`
