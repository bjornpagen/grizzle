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

/** A character of a name: an ASCII letter or digit, `_` or `$`. */
const isNameChar = (c: string): boolean =>
	(c >= "a" && c <= "z") ||
	(c >= "A" && c <= "Z") ||
	(c >= "0" && c <= "9") ||
	c === "_" ||
	c === "$"

/**
 * The names a program's code reads, which its imports are read off: each identifier outside its comments and its
 * string literals, a template's text included and its substitutions code, that is neither the property a `.` reads of
 * another value nor the key of an object or type literal's member (`{ Line: … }`, `readonly r0: …`). A name a
 * directive or a case's doc mentions, a string spells (a roster's handle, `Rostered<"Kind">`, a relation's name in a
 * union of names), a member access names or a key states is no read of it, and an import of a value no code reads is
 * a TS6133 the program never states.
 */
export const identifiers = (text: string): ReadonlySet<string> => {
	const chars = Str.split(text, "")
	const char = (i: number): string => chars[i] ?? ""
	const blank = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r"
	/** The index of the first `close` at or after `from`, or the text's end. */
	const until = (from: number, close: ReadonlyArray<string>): number => {
		let i = from
		while (i < chars.length && !Arr.every(close, (c, k) => char(i + k) === c)) {
			i += 1
		}
		return i
	}
	const names = new Set<string>()
	/** The closing quote of each string or template the scan is inside, innermost last, or `}` for a substitution. */
	const open: Array<string> = []
	let at = 0
	let previous = ""
	while (at < chars.length) {
		const c = char(at)
		const inside = open.at(-1)
		if (inside === '"' || inside === "'" || inside === "`") {
			if (c === "\\") {
				at += 2
			} else if (c === inside) {
				open.pop()
				at += 1
			} else if (inside === "`" && c === "$" && char(at + 1) === "{") {
				open.push("}")
				at += 2
			} else {
				at += 1
			}
			continue
		}
		if (c === "/" && char(at + 1) === "/") {
			at = until(at, ["\n"])
			continue
		}
		if (c === "/" && char(at + 1) === "*") {
			at = until(at + 2, ["*", "/"]) + 2
			continue
		}
		if (c === '"' || c === "'" || c === "`") {
			open.push(c)
			at += 1
			previous = c
			continue
		}
		if (c === "." && char(at + 1) === "." && char(at + 2) === ".") {
			at += 3
			previous = "..."
			continue
		}
		if (inside === "}" && c === "}") {
			open.pop()
			at += 1
			continue
		}
		if (inside === "}" && c === "{") {
			open.push("}")
			at += 1
			continue
		}
		if (isNameChar(c)) {
			let end = at
			while (end < chars.length && isNameChar(char(end))) {
				end += 1
			}
			const name = Arr.join(chars.slice(at, end), "")
			let next = end
			while (next < chars.length && blank(char(next))) {
				next += 1
			}
			const colon = char(next) === ":" || (char(next) === "?" && char(next + 1) === ":")
			const key =
				colon &&
				(previous === "{" || previous === "," || previous === ";" || previous === "readonly")
			if (previous !== "." && !key) {
				names.add(name)
			}
			previous = name
			at = end
			continue
		}
		if (!blank(c)) {
			previous = c
		}
		at += 1
	}
	return names
}

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

/**
 * A generated program: its `header` line, the imports its `body` names through its prelude as `at` reaches it, then
 * the body.
 */
export const preludeProgram = (header: string, at: PreludeAt, body: string): string =>
	Arr.join([header, ...preludeImports(at, identifiers(body)), "", body], "\n")
