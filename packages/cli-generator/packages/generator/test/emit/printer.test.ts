/**
 * The printer against TypeScript's own parser and the formatter. A generated module inside the printer's syntax subset
 * prints to text that TypeScript 7 parses with no syntax diagnostic and reads back as the module: object keys and
 * interface fields in UTF-16 code-unit order, unions flattened, imports as the same bindings. The text holds the
 * docs/printer.md layout: LF lines, one final newline, no trailing whitespace and no tab, two-space indents, exactly one
 * blank line between top-level blocks and none elsewhere, imports in their documented order, string literals in the formatter's quotes with every code point of the escape
 * set escaped as four uppercase hex digits and quoted keys ASCII, a JSDoc filled greedily, and a statement holding
 * `${...}` fenced for oxlint. oxfmt, under the options docs/printer.md names, leaves it unchanged. A module holding one
 * planted construct outside the subset is refused with that construct's reason. A JSON value prints to text that reads
 * back as the value with its keys sorted and its objects broken, and a package manifest prints with its top-level keys
 * in the documented order, its dependency maps sorted and every array and object broken; the formatter leaves both
 * unchanged, and a manifest with a key outside the order is refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { syntaxOf } from "@bjornpagen/testing/syntax"
import { Array as Arr, Effect, Option, Result } from "effect"
import { printJson, printModule, printPackageJson } from "#emit/printer.ts"
import { JsonLiteral } from "#model/brands.ts"
import {
	canonicalModule,
	type FaultFeature,
	faultyGen,
	type Feature,
	formatted,
	importFindings,
	type JsonFeature,
	jsonFeatures,
	jsonGen,
	layoutFindings,
	manifestCaseGen,
	type ManifestFeature,
	manifestFeatures,
	manifestTree,
	moduleFeatures,
	moduleSpace,
	readJsonFile,
	readModule,
	refusalOf,
	shapesOf,
	sortedMembers,
	stringFindings,
	syntaxCodes,
	textFeatures,
	treeFeatures,
	treeOf
} from "#test/emit/printer.fixtures.ts"

/**
 * A module inside the subset prints to text TypeScript reads back as the module, in the layout docs/printer.md and
 * the formatter keep. Its budget is the count its suite stated
 * before the conversion: 300 independent cases, and up to 1500 steered while a situation is unreached.
 */
export const printedModule = property.explore(moduleSpace, {
	needs: {},
	situations: [
		"a shebang",
		"a type-only import",
		"a namespace import",
		"relative imports after package imports",
		"an import broken one name per line",
		"a JSDoc over several lines",
		"a quoted key",
		"a computed __proto__ key",
		"a reserved word as a bare key",
		"an object broken",
		"an array of numbers filled",
		"an array always broken",
		"a hugged last argument",
		"an arrow head broken",
		"an arrow body below its head",
		"a conditional broken",
		"a long union broken",
		"a type alias below its name",
		"a const value below its head",
		"a property value below its key",
		"a second call group",
		"a curried call",
		"a new expression",
		"a dynamic import",
		"a broken plus",
		"an escaped code point",
		"a single-quoted string",
		"a fenced template placeholder",
		"a line past column 100",
		"a wide or zero-width character on a full line",
		"an as-const value",
		"an optional field",
		"a top-level call",
		"arguments broken as a function composition",
		"a long import of one name"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_resources, k: Case<Feature>) => (module) =>
		Effect.gen(function* () {
			const text = yield* printModule(module)
			const formatter = yield* formatted("printed.ts", text)
			const tree = yield* syntaxOf("/printed.ts", text, (file) => ({
				read: readModule(file),
				strings: stringFindings(file, text),
				features: treeFeatures(file)
			}))
			k.noteAll([...moduleFeatures(module), ...textFeatures(text), ...tree.features])
			const syntax = yield* syntaxCodes(text)
			const got = {
				syntax,
				formatter,
				read: Result.map(tree.read, (read) => read.reading),
				layout: [
					...layoutFindings(text, module),
					...Result.match(tree.read, {
						onFailure: () => [],
						onSuccess: (read) => importFindings(read.imports)
					}),
					...tree.strings
				]
			}
			const want: typeof got = {
				syntax: [],
				formatter: { code: text, errors: [] },
				read: Result.succeed(canonicalModule(module)),
				layout: []
			}
			assert.deepEqual(got, want)
		}),
	oracle: {
		kind: "universal",
		name: "TypeScript's parse of the printed text reads back as the module, in a layout oxfmt leaves unchanged"
	},
	kept: [
		{
			token: ReplayToken(
				"test/emit/printer.test.ts#printedModule:-:0.1.0.1.0.1.0.0.0.4.1.6.0.7.b.7.5.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"a conditional beside a long key whose test, a chain of a call holding an argument and an empty one, does not fit whole but whose first argument list starts on the key's line: the formatter breaks that list and keeps the conditional beside its key (found by the push gate's rotating stream at TEST_SEED=559022411)",
			since: "2026-11-17"
		},
		{
			token: ReplayToken(
				"test/emit/printer.test.ts#printedModule:-:0.1.8.0.1.0.0.1.4.1.6.0.1.7.5.0.5.0.0.0.1.0.0.6.b.1.0"
			),
			reason:
				"a chain beside a long key whose one argument is a string of sixteen wide characters, 18 code units but 34 columns, past the quarter line the formatter calls a short argument: the formatter breaks the chain's argument list beside the key rather than moving the chain below it (found by the push gate's rotating stream at seed 0x848d5dc6)",
			since: "2026-11-17"
		},
		{
			token: ReplayToken(
				"test/emit/printer.test.ts#printedModule:-:0.1.0.0.2.7.0.0.7.4.1.1.0.0.0.1.4.0.1.0.0"
			),
			reason:
				"a chain beside a long const name, `a.pipe()({})`, that does not fit after its `=` but whose argument list holding `{}` starts on that line: an empty object is no short argument, so the formatter breaks that list beside `=` rather than moving the chain below (found by the push gate's rotating stream at seed 0x46c01f85)",
			since: "2026-11-18"
		}
	],
	budget: { runs: 300, steered: 1500 },
	kills: [
		{
			file: "packages/generator/src/emit/printer.ts",
			original:
				'(expr._tag === "String" && textWidth(stringLiteral(expr.value)) <= shortArgumentWidth)',
			replacement:
				'(expr._tag === "String" && stringLiteral(expr.value).length <= shortArgumentWidth)',
			why: "A string argument is measured in code units, so one of wide characters reads as short and its chain moves below its key, where the formatter breaks the chain's arguments beside the key; the property fails."
		},
		{
			file: "packages/generator/src/emit/printer.ts",
			original:
				"Option.orElse(firstLine(choice.test), () => Option.fromUndefinedOr(flat(choice.test)))",
			replacement: "Option.fromUndefinedOr(flat(choice.test))",
			why: "A conditional is measured by the whole of its test, so one whose test breaks in an argument list on the key's line moves below the key, where the formatter keeps it beside; the property fails."
		},
		{
			file: "packages/generator/src/emit/printer.ts",
			original: "\tconst place = { column: indent + textWidth(key) + 2, indent, tail: 1 }",
			replacement: "\tconst place = { column: indent + textWidth(key) + 1, indent, tail: 1 }",
			why: "A property's value is measured from one column left of where it starts (its key's width plus `: `), so a value that just overflows the line is kept beside its key instead of moving below it; the property fails (CATCH's evidence, mutant 3d11770dae)."
		},
		{
			file: "packages/generator/src/emit/printer.ts",
			original: '\texpr._tag === "Boolean"\n\n/**\n * A chain the formatter cannot break well',
			replacement:
				'\texpr._tag === "Boolean" ||\n\t(expr._tag === "Object" && expr.entries.length === 0)\n\n/**\n * A chain the formatter cannot break well',
			why: "An empty object reads as a short argument, so a chain taking `{}` that does not fit beside `=` moves below it whole, where the formatter breaks its argument list beside `=`; the property fails."
		}
	]
})

/**
 * A module holding one construct outside the subset is refused with that construct's reason. Its budget is the count its suite stated
 * before the conversion: 300 independent cases, and up to 600 steered while a situation is unreached.
 */
export const refusedConstruct = property.explore(faultyGen, {
	needs: {},
	situations: [
		"a repeated object key",
		"a repeated field key",
		"a non-finite number",
		"an arrow whose body is an arrow, a conditional or a plus",
		"a conditional with a conditional or an arrow operand",
		"a third call group",
		"a second call group on a lower-case head",
		"a call of no path",
		"a member of no path outside a callee",
		"a new of no path",
		"a plus outside a call argument",
		"a plus of a call",
		"a statement that is no call",
		"a const head past column 100",
		"a field past column 100",
		"a type alias past column 100",
		"a union member past column 100"
	] satisfies ReadonlyArray<Reached<FaultFeature>>,
	check:
		(_, k: Case<FaultFeature>) =>
		({ module, plant }) =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(printModule(module))
				k.note(plant.feature)
				assert.deepEqual(
					refusalOf(exit, Option.isSome(plant.subject)),
					Option.some({ reason: plant.reason, subject: plant.subject })
				)
			}),
	oracle: { kind: "specification", name: "each planted construct's refusal reason" },
	kept: [],
	budget: { runs: 300, steered: 600 },
	kills: [
		{
			file: "packages/generator/src/emit/printer.ts",
			original:
				'fn.body._tag === "Arrow" || fn.body._tag === "Conditional" || fn.body._tag === "Plus"',
			replacement: 'fn.body._tag === "Arrow" || fn.body._tag === "Conditional"',
			why: "An arrow whose body is a `+` is no longer refused as an arrow body needing parentheses; the property fails (CATCH's evidence, mutant 84a8b66720)."
		}
	]
})

/**
 * A JSON value prints to text that reads back as the value, keys sorted and objects broken, which the formatter
 * keeps. Its budget is the count its suite stated
 * before the conversion: 300 independent cases, and up to 1000 steered while a situation is unreached.
 */
export const printedJson = property.explore(jsonGen(3), {
	needs: {},
	situations: [
		"an empty object",
		"an empty array",
		"a flat array",
		"a broken array",
		"a filled number array",
		"an array of arrays",
		"a nested object",
		"an escaped character",
		"a non-ASCII key",
		"a numeric key"
	] satisfies ReadonlyArray<Reached<JsonFeature>>,
	check: (_resources, k: Case<JsonFeature>) => (value) =>
		Effect.gen(function* () {
			const text = printJson(JsonLiteral.make(value))
			const formatter = yield* formatted("printed.json", text)
			const tree = yield* syntaxOf("/printed-json.ts", `(${text})`, (file) => ({
				read: readJsonFile(file),
				shapes: shapesOf(file)
			}))
			k.noteAll(jsonFeatures(value, text, tree.shapes))
			const got = {
				formatter,
				read: tree.read,
				unbroken: Arr.filter(
					tree.shapes,
					(shape) => shape.kind === "object" && !shape.empty && !shape.broken
				)
			}
			const want: typeof got = {
				formatter: { code: text, errors: [] },
				read: Result.succeed(treeOf(value, sortedMembers)),
				unbroken: []
			}
			assert.deepEqual(got, want)
		}),
	oracle: {
		kind: "universal",
		name: "the printed text reads back as the value, its keys sorted, and oxfmt leaves it unchanged"
	},
	kept: [],
	budget: { runs: 300, steered: 1000 },
	kills: [
		{
			file: "packages/generator/src/emit/printer.ts",
			original:
				"value === null ||\n\tPredicate.isBoolean(value) ||\n\tPredicate.isNumber(value) ||\n\tPredicate.isString(value)",
			replacement:
				"Predicate.isBoolean(value) || Predicate.isNumber(value) || Predicate.isString(value)",
			why: "null is not a JSON scalar to the printer, so a null value is printed as an object or refused; the property fails (CATCH's evidence, mutant 69b9f719b3)."
		},
		{
			file: "packages/generator/src/emit/printer.ts",
			original:
				"value === null ||\n\tPredicate.isBoolean(value) ||\n\tPredicate.isNumber(value) ||\n\tPredicate.isString(value)",
			replacement: "false",
			why: "No value is a JSON scalar to the printer, so every scalar is printed as a container or refused; the property fails (EOCG-EMIT's handoff from author-supplied.test.ts, mutant d165845e5c)."
		}
	]
})

/**
 * A manifest prints with its keys in the documented order, every array and object broken, which the formatter
 * keeps; a key outside the order is refused. Its budget is the count its suite stated
 * before the conversion: 200 independent cases, and up to 600 steered while a situation is unreached.
 */
export const printedManifest = property.explore(manifestCaseGen, {
	needs: {},
	situations: [
		"keys reordered",
		"a map sorted by key",
		"a map kept in its order",
		"an empty map",
		"a key outside the order",
		"a root that is no object"
	] satisfies ReadonlyArray<Reached<ManifestFeature>>,
	check: (_resources, k: Case<ManifestFeature>) => (drawnCase) =>
		drawnCase.kind === "refused"
			? Effect.map(Effect.exit(printPackageJson(JsonLiteral.make(drawnCase.manifest))), (exit) => {
					k.note(drawnCase.feature)
					assert.deepEqual(
						refusalOf(exit, true),
						Option.some({
							reason: "unsupported-package-json" as const,
							subject: Option.some(drawnCase.subject)
						})
					)
				})
			: Effect.gen(function* () {
					const { manifest } = drawnCase
					const text = yield* printPackageJson(JsonLiteral.make(manifest))
					const formatter = yield* formatted("package.json", text)
					const tree = yield* syntaxOf("/package-json.ts", `(${text})`, (file) => ({
						read: readJsonFile(file),
						shapes: shapesOf(file)
					}))
					k.noteAll(manifestFeatures(manifest))
					const got = {
						formatter,
						read: tree.read,
						unbroken: Arr.filter(tree.shapes, (shape) => !shape.empty && !shape.broken)
					}
					const want: typeof got = {
						formatter: { code: text, errors: [] },
						read: Result.succeed(manifestTree(manifest)),
						unbroken: []
					}
					assert.deepEqual(got, want)
				}),
	oracle: {
		kind: "specification",
		name: "the manifest's documented key order and sorted maps, and oxfmt's fixed point"
	},
	kept: [],
	budget: { runs: 200, steered: 600 },
	kills: [
		{
			file: "packages/generator/src/emit/printer.ts",
			original:
				"onSome: (value) => [[key, sortedKeys.has(key) ? sortedMap(value) : value] as const]",
			replacement: "onSome: (value) => [[key, value] as const]",
			why: "The manifest's dependency maps, `bin` and `engines` print in the order they were written, not sorted by key, so the formatter would reorder them; the property fails."
		},
		{
			file: "packages/generator/src/emit/printer.ts",
			original:
				"Arr.findFirst(Record.keys<string, Schema.Json>(manifest), (key) => !knownPackageKeys.has(key)),",
			replacement:
				"Arr.findFirst(Record.keys<string, Schema.Json>(manifest), (key) => false && !knownPackageKeys.has(key)),",
			why: "A top-level key outside the documented order is no longer refused: it is dropped from the printed manifest; the property fails."
		}
	]
})
