import { transformSync } from "amaro"
import { Array as Arr, Order, Record as Rec, Schema, String as Str } from "effect"
import { type Token, tokenize } from "#test/unit/deps/lexer.ts"

/**
 * The production dependency audit over src/: no RegExp construction, .test or .exec, and no arkregex runtime import.
 *
 * Every module is read as the JavaScript Node runs: amaro, the type stripper Node runs, erases the types, so a
 * type-only import is gone and an `import { type X } from "m"`, which keeps `import {} from "m"` under
 * verbatimModuleSyntax, is still a runtime import of m. The erased text is tokenized (lexer.ts) and checked for:
 *
 * - RegExp construction: a regular expression literal, or any reference to the RegExp global other than the right
 *   operand of instanceof;
 * - RegExp matching: a `.test` or `.exec` member access, and a call of `.match`, `.matchAll` or `.search`, which build a
 *   RegExp from a string argument;
 * - its runtime imports, static, re-exported and dynamic, which the arkregex check reads.
 */
export interface Finding {
	readonly file: string
	readonly line: number
	readonly rule: string
	readonly text: string
}

export interface RuntimeImport {
	readonly specifier: string
	readonly line: number
	readonly kind: "static" | "reexport" | "dynamic" | "require"
}

export interface ModuleAudit {
	readonly file: string
	readonly regex: ReadonlyArray<Finding>
	readonly dynamicCode: ReadonlyArray<Finding>
	readonly imports: ReadonlyArray<RuntimeImport>
	/** Dynamic imports and requires whose specifier is not a string literal, which the arkregex check cannot read. */
	readonly opaque: ReadonlyArray<Finding>
}

/**
 * RegExp.prototype.test and exec, referenced at all; and the String methods that build a RegExp from a string
 * argument, when called (a property of that name on another object, such as a MERGE clause's `when.match`, is not one).
 */
const regexMembers: ReadonlySet<string> = new Set(["test", "exec"])
const regexBuildingCalls: ReadonlySet<string> = new Set(["match", "matchAll", "search"])

/** The erased JavaScript of a TypeScript module, as amaro's type stripping (mode "strip-only") produces it. */
export const erase = (source: string): string => transformSync(source, { mode: "strip-only" }).code

const isPunct = (t: Token | undefined, text: string): boolean =>
	t?.kind === "punct" && t.text === text

const isIdent = (t: Token | undefined, text: string): boolean =>
	t?.kind === "ident" && t.text === text

const regexFindings = (file: string, tokens: ReadonlyArray<Token>): Array<Finding> => {
	const out: Array<Finding> = []
	for (const [i, t] of tokens.entries()) {
		const prev = tokens[i - 1]
		if (t.kind === "regex") {
			out.push({ file, line: t.line, rule: "regex literal", text: t.text })
		} else if (isIdent(t, "RegExp") && !isIdent(prev, "instanceof")) {
			out.push({ file, line: t.line, rule: "RegExp reference", text: t.text })
		} else if (
			t.kind === "ident" &&
			(isPunct(prev, ".") || isPunct(prev, "?.")) &&
			(regexMembers.has(t.text) || (regexBuildingCalls.has(t.text) && isPunct(tokens[i + 1], "(")))
		) {
			out.push({ file, line: t.line, rule: `.${t.text} member`, text: `.${t.text}` })
		}
	}
	return out
}

/** eval and the Function constructor generate code at runtime, which the pure compiler never does. */
const dynamicCodeFindings = (file: string, tokens: ReadonlyArray<Token>): Array<Finding> => {
	const out: Array<Finding> = []
	for (const [i, t] of tokens.entries()) {
		const prev = tokens[i - 1]
		const member = isPunct(prev, ".") || isPunct(prev, "?.")
		if (isIdent(t, "eval") && !member) {
			out.push({ file, line: t.line, rule: "eval", text: t.text })
		}
		if (
			isIdent(t, "Function") &&
			!member &&
			(isIdent(prev, "new") || isPunct(tokens[i + 1], "("))
		) {
			out.push({ file, line: t.line, rule: "Function constructor", text: t.text })
		}
	}
	return out
}

/**
 * Whether token i begins a statement-level import or export declaration: it is not a member name and not
 * `import.meta` or `import(`.
 */
const atDeclaration = (tokens: ReadonlyArray<Token>, i: number): boolean => {
	const prev = tokens[i - 1]
	return !(isPunct(prev, ".") || isPunct(prev, "?."))
}

const importsOf = (
	file: string,
	tokens: ReadonlyArray<Token>
): { imports: Array<RuntimeImport>; opaque: Array<Finding> } => {
	const imports: Array<RuntimeImport> = []
	const opaque: Array<Finding> = []
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]
		if (t === undefined) {
			continue
		}
		/** import("m") and import("m", options) */
		const next = tokens[i + 1]
		if (isIdent(t, "import") && atDeclaration(tokens, i)) {
			if (isPunct(next, ".")) {
				continue
			}
			if (isPunct(next, "(")) {
				const arg = tokens[i + 2]
				if (
					arg?.kind === "string" &&
					(isPunct(tokens[i + 3], ")") || isPunct(tokens[i + 3], ","))
				) {
					imports.push({ specifier: arg.text, line: t.line, kind: "dynamic" })
				} else {
					opaque.push({
						file,
						line: t.line,
						rule: "dynamic import of a computed specifier",
						text: "import("
					})
				}
				continue
			}
			if (next?.kind === "string") {
				imports.push({ specifier: next.text, line: t.line, kind: "static" })
				continue
			}
			/** import <bindings> from "m" */
			let j = i + 1
			while (j < tokens.length && !isIdent(tokens[j], "from")) {
				j += 1
			}
			const spec = tokens[j + 1]
			if (spec?.kind !== "string") {
				throw new Error(`${file}:${t.line}: an import without a from clause`)
			}
			imports.push({ specifier: spec.text, line: t.line, kind: "static" })
			i = j + 1
		} else if (
			isIdent(t, "export") &&
			atDeclaration(tokens, i) &&
			(isPunct(next, "*") || isPunct(next, "{"))
		) {
			/** export * [as x] from "m", export { ... } [from "m"] */
			let j = i + 1
			if (isPunct(next, "{")) {
				while (j < tokens.length && !isPunct(tokens[j], "}")) {
					j += 1
				}
				j += 1
			} else {
				j += 1
				if (isIdent(tokens[j], "as")) {
					j += 2
				}
			}
			if (isIdent(tokens[j], "from")) {
				const spec = tokens[j + 1]
				if (spec?.kind !== "string") {
					throw new Error(`${file}:${t.line}: a re-export without a specifier`)
				}
				imports.push({ specifier: spec.text, line: t.line, kind: "reexport" })
			}
		} else if (
			isIdent(t, "require") &&
			isPunct(next, "(") &&
			!(isPunct(tokens[i - 1], ".") || isPunct(tokens[i - 1], "?."))
		) {
			const arg = tokens[i + 2]
			if (arg?.kind === "string") {
				imports.push({ specifier: arg.text, line: t.line, kind: "require" })
			} else {
				opaque.push({
					file,
					line: t.line,
					rule: "require of a computed specifier",
					text: "require("
				})
			}
		}
	}
	return { imports, opaque }
}

/** Audits one module's TypeScript source. */
export const auditSource = (file: string, source: string): ModuleAudit => {
	const tokens = tokenize(erase(source))
	const { imports, opaque } = importsOf(file, tokens)
	return {
		file,
		regex: regexFindings(file, tokens),
		dynamicCode: dynamicCodeFindings(file, tokens),
		imports,
		opaque
	}
}

/**
 * The TypeScript modules of a directory's recursive listing, declaration files aside, as paths relative to the root the
 * directory is under, sorted. The caller reads the listing (deps.test.ts): the audit itself does no I/O.
 */
export const modulesIn = (entries: ReadonlyArray<string>, dir: string): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(
			Arr.filter(entries, (name) => Str.endsWith(".ts")(name) && !Str.endsWith(".d.ts")(name)),
			(name) => `${dir}/${name}`
		),
		Order.String
	)

/**
 * A bare specifier's package: "effect/Schema" -> "effect", "@vercel/functions/db-connections" -> "@vercel/functions",
 * and a builtin as written ("node:fs").
 */
export const packageOf = (specifier: string): string => {
	if (Str.startsWith("node:")(specifier)) {
		return specifier
	}
	const parts = Str.split(specifier, "/")
	const [head] = parts
	return Str.startsWith("@")(specifier) ? `${parts[0]}/${parts[1]}` : head
}

/**
 * The fields of package.json the entry points come from, admitted by their schema: an export is a path, or its
 * declarations' and its code's paths.
 */
export const PackageJson = Schema.Struct({
	exports: Schema.Record(
		Schema.String,
		Schema.Union([Schema.String, Schema.Struct({ types: Schema.String, default: Schema.String })])
	),
	bin: Schema.optional(Schema.Record(Schema.String, Schema.String))
})
export type PackageJson = typeof PackageJson.Type

/** The source of a published module: dist/<module>.js is built from src/<module>.ts alone (scripts/build.ts). */
const sourceOf = (entry: string, path: string): string => {
	if (!Str.startsWith("./dist/")(path) || !Str.endsWith(".js")(path)) {
		throw new Error(`${entry} is not ./dist/*.js: ${path}`)
	}
	return `./src/${Str.slice("./dist/".length, -".js".length)(path)}.ts`
}

/** The workspace packages, by their directory under packages/: the engine and the shell. */
export const packageDirectories: ReadonlyArray<string> = ["engine", "grizzle"]

/**
 * One package's entry points, from its package.json: every export's and bin's code is a module of its dist/, and the
 * audit reads its source under its src/, the TypeScript Node runs in development, as a path from the repository root.
 * The "./package.json" export is not code. The engine's "./internal/<module>.ts" exports are exactly the modules the
 * shell imports, each an entry.
 */
export const entriesOf = (directory: string, pkg: PackageJson): ReadonlyArray<string> => {
	const within = (path: string): string => `packages/${directory}/${Str.slice("./".length)(path)}`
	const targets: Array<string> = []
	for (const [subpath, target] of Rec.toEntries(pkg.exports)) {
		if (subpath !== "./package.json") {
			targets.push(
				within(sourceOf(`export ${subpath}`, typeof target === "string" ? target : target.default))
			)
		}
	}
	for (const path of Rec.values(pkg.bin ?? {})) {
		targets.push(within(sourceOf("bin", path)))
	}
	return targets
}
