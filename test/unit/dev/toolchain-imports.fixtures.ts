/** What the properties of toolchain-imports.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, type Gen, option } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"

/** A package an import names: one the toolchain switch moved, under grizzle's scope, or one it left where it was. */
type Package =
	| { readonly kind: "moved"; readonly name: "testing" | "devtools"; readonly subpath: string }
	| { readonly kind: "kept"; readonly specifier: string }

/** An import line's form, each spelled as a foreign style writes it. */
type Form = "named" | "type" | "sideEffect" | "reexport"

interface Import {
	readonly form: Form
	readonly from: Package
}

/** A drawn file: its leading comment, its imports, and its body lines, in the foreign style. */
interface Drawn {
	readonly header: Option.Option<string>
	readonly imports: Arr.NonEmptyReadonlyArray<Import>
	readonly body: ReadonlyArray<string>
}

/** A package the toolchain switch moved, under grizzle's scope. */
const movedGen: Gen<Package> = (source) => ({
	kind: "moved",
	name: source.draw(element(["testing", "devtools"] as const)),
	subpath: source.draw(element(["", "/gen", "/explore", "/vitest/config"]))
})

/** A package the switch left where it was. */
const keptGen: Gen<Package> = (source) => ({
	kind: "kept",
	specifier: source.draw(element(["effect", "@effect/vitest", "node:path", "#local/a.ts"]))
})

const packageGen: Gen<Package> = (source) => source.draw(source.draw(boolean) ? movedGen : keptGen)

/** An import of a package `packages` draws, in a drawn form. */
const importOf =
	(packages: Gen<Package>): Gen<Import> =>
	(source) => ({
		form: source.draw(element(["named", "type", "sideEffect", "reexport"] as const)),
		from: source.draw(packages)
	})

/**
 * Whole statements, each valid TypeScript, written as grizzle's formatter would not write them: four-space indents,
 * semicolons, single quotes, a line past grizzle's print width unbroken, a blank line.
 */
const BODY: Arr.NonEmptyReadonlyArray<string> = [
	"const greeting = 'hello';",
	"export function twice(x: number): number {\n    return x * 2;\n}",
	"const list = [1,2,3];",
	"export const long = { alpha: 'a', beta: 'b', gamma: 'c', delta: 'd', epsilon: 'e', zeta: 'z', eta: 'h' };",
	""
]

/** A file whose first import names a package `first` draws, every other import any package. */
const drawnOf =
	(first: Gen<Package>, others: Gen<Package>): Gen<Drawn> =>
	(source) => ({
		header: source.draw(option(element(["// a consumer's file", "/** A consumer's module. */"]))),
		imports: [
			source.draw(importOf(first)),
			...source.draw(array(importOf(others), { min: 0, max: 3 }))
		],
		body: source.draw(array(element(BODY), { min: 0, max: 6 }))
	})

export const drawnGen: Gen<Drawn> = drawnOf(packageGen, packageGen)

export type Feature = "a moved import renamed" | "a file with nothing to rename left as it was"

/** The file each feature is aimed at while it is pending: a witness whose turn aims at one draws that file (aimed), the
 * file it runs, prints and keeps: a moved import first, or no moved import. */
export const aims: Arr.NonEmptyReadonlyArray<readonly [Feature, Gen<Drawn>]> = [
	["a moved import renamed", drawnOf(movedGen, packageGen)],
	["a file with nothing to rename left as it was", drawnOf(keptGen, keptGen)]
]

/** A specifier as written under `scope` for a moved package, or as it is for a kept one. */
const specifierOf = (from: Package, scope: "@grizzle" | "@bjornpagen"): string =>
	from.kind === "moved" ? `${scope}/${from.name}${from.subpath}` : from.specifier

/** An import line in the foreign style, its specifier `specifier`. */
const importLine = (form: Form, specifier: string): string => {
	switch (form) {
		case "named":
			return `import { b, a } from '${specifier}';`
		case "type":
			return `import type { T } from '${specifier}';`
		case "sideEffect":
			return `import '${specifier}';`
		case "reexport":
			return `export { c } from '${specifier}';`
	}
}

/** The file's text, each moved package's specifier spelled under `scope`. */
export const textOf = (file: Drawn, scope: "@grizzle" | "@bjornpagen"): string =>
	`${Arr.join(
		[
			...Option.toArray(file.header),
			...Arr.map(file.imports, (i) => importLine(i.form, specifierOf(i.from, scope))),
			...file.body
		],
		"\n"
	)}\n`

/** The foreign repository's formatter configuration: spaces, semicolons, single quotes, as the body is written. */
export const foreignConfig = `{
    "useTabs": false,
    "tabWidth": 4,
    "semi": true,
    "singleQuote": true,
    "printWidth": 120
}
`
