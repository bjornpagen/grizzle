import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { defined } from "#test/support/assert.ts"
import { fileText, joinPath, repoRoot } from "#test/support/files.ts"

/**
 * A generated program's prelude (test/support/programs): the one module of real export statements a type
 * population's generated programs read every repository name from. Fallow reads each prelude as an entry, so every
 * name it re-exports is a use of that name's declaration, and the compiler checks that every name it states exists;
 * a generator renders a program's imports from the prelude's names alone (preludeImports), so a program reads no
 * repository name its prelude does not state, and an unused-export fix can no longer silently break a population.
 *
 * Its names are read off its own source: each value and each type by the name it exports it under. A prelude holds
 * export statements of exactly two forms, `export { … } from "…"` and `export type { … } from "…"`, each name a name
 * or `name as alias`, the first form's names each perhaps `type`-marked, and comments; anything else, and a name
 * exported twice, is a defect of the prelude, refused when it is read.
 */
export interface Prelude {
	/** The prelude's repository path, which a program's `entry` turns into the specifier it imports from. */
	readonly path: string
	readonly values: ReadonlyArray<string>
	readonly types: ReadonlyArray<string>
}

/**
 * The identifiers a program's text names outside its comments, which its imports are read off: a name a directive or a
 * case's doc mentions is no use of it.
 */
export const identifiers = (text: string): ReadonlySet<string> =>
	new Set(Str.split(Str.replace(comment(), "")(text), regex("[^A-Za-z0-9_$]+")))

/** One exported name of a prelude: the name it exports under, and whether it is a type alone. */
interface Exported {
	readonly name: string
	readonly type: boolean
}

/** An export statement of the two a prelude holds: whether it is type-only, and its braced names. */
const exportStatement = () => regex('export\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+"[^"]+"', "g")
/** One braced name: whether it is `type`-marked, its name, and the alias it is exported under. */
const exportItem = () =>
	regex("^(type\\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\\s+as\\s+([A-Za-z_$][A-Za-z0-9_$]*))?$")
/** A comment, block or line. */
const comment = () => regex("/\\*[\\s\\S]*?\\*/|//[^\\n]*", "g")

/** The names of one braced list of a statement, type-only or not, refused where an item is no name. */
const itemsOf = (path: string, list: string, typeOnly: boolean): ReadonlyArray<Exported> =>
	Arr.map(Arr.filter(Arr.map(Str.split(list, ","), Str.trim), Str.isNonEmpty), (item): Exported => {
		const match = exportItem().exec(item)
		if (match === null) {
			throw new Error(`the prelude ${path} exports ${jsonText(item)}, which is no name`)
		}
		const [, typed, name, alias] = match
		return { name: alias ?? name, type: typeOnly || typed !== undefined }
	})

/** A prelude's names read off its source `text` (see Prelude), refused where it holds anything else. */
const preludeOf = (path: string, text: string): Prelude => {
	const code = Str.replace(comment(), "")(text)
	const statements = Arr.fromIterable(Str.matchAll(exportStatement())(code))
	const rest = Str.trim(Str.replace(exportStatement(), "")(code))
	if (Str.isNonEmpty(rest)) {
		throw new Error(`the prelude ${path} holds a statement other than export { … } from: ${rest}`)
	}
	const names = Arr.flatMap(statements, ([, typed, list]) =>
		itemsOf(path, defined(list, "an export statement's braced names"), typed !== undefined)
	)
	const duplicate = Arr.findFirst(names, (n, i) =>
		Arr.some(Arr.take(names, i), (m) => m.name === n.name)
	)
	if (Option.isSome(duplicate)) {
		throw new Error(`the prelude ${path} exports ${duplicate.value.name} twice`)
	}
	const of = (type: boolean): ReadonlyArray<string> =>
		Arr.sort(
			Arr.map(
				Arr.filter(names, (n) => n.type === type),
				(n) => n.name
			),
			Order.String
		)
	return { path, values: of(false), types: of(true) }
}

/**
 * The prelude at the repository path `path`, read once by the generator that renders from it, as the module that
 * loads it reads it: `await Effect.runPromise(preludeAt(path))`.
 */
export const preludeAt = (path: string): Effect.Effect<Prelude> =>
	Effect.map(fileText(joinPath(repoRoot, path)), (text) => preludeOf(path, text))

/** A prelude as a generated program reaches it: its names, and its path as the program's directory spells it. */
export interface PreludeAt {
	readonly prelude: Prelude
	readonly specifier: string
}

/** `prelude` as a program reaches it, `entry` spelling a repository path from the program's directory. */
export const preludeFrom = (prelude: Prelude, entry: (path: string) => string): PreludeAt => ({
	prelude,
	specifier: entry(prelude.path)
})

/**
 * The import statements of a program whose text names `named`, reading its prelude as `at` reaches it: its values,
 * then its types, each a statement only where the program names one.
 */
export const preludeImports = (
	at: PreludeAt,
	named: ReadonlySet<string>
): ReadonlyArray<string> => {
	const statement = (kind: "import" | "import type", names: ReadonlyArray<string>) => {
		const used = Arr.filter(names, (n) => named.has(n))
		return Arr.isReadonlyArrayNonEmpty(used)
			? [`${kind} { ${Arr.join(used, ", ")} } from ${jsonText(at.specifier)}`]
			: []
	}
	return [...statement("import", at.prelude.values), ...statement("import type", at.prelude.types)]
}
