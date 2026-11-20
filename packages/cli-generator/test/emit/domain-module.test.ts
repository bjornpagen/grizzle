/**
 * The domain module as a property. A generated set of JSON Schema definitions, some reachable from the request roots
 * and some not, prints to `domain/schemas.ts`, which TypeScript parses with no syntax diagnostic and oxfmt, under the
 * options docs/printer.md names, leaves unchanged. It exports exactly the reachable definitions, each under the name
 * the identifier map gives it and each after every definition it reads outside a `Schema.suspend`, an alias of a
 * recursive definition among them in either name order; the same set in another order prints the same bytes; no
 * `default`, `example` or `examples` value reaches it; and no reachable definition prints the empty module. A set is
 * drawn as the validation copy can be: no cycle of references returns to a schema without descending into the
 * instance. A planted fault is refused with its reason: a reachable definition that is no schema object, one the
 * importer rejects, a reachable key the identifier map leaves out, two reachable keys given one name, and a name Effect
 * would export differently.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { syntaxDiagnosticsOf } from "@bjornpagen/testing/syntax"
import { Array as Arr, Cause, Effect, Exit, Option, Order, String as Str } from "effect"
import { format } from "oxfmt"
import {
	caseGen,
	emitted,
	type Fault,
	type Feature,
	featuresOf,
	FORMAT_OPTIONS,
	identifiersOf,
	outOfOrder,
	parsedExports,
	plantedGen,
	reachableFrom,
	SENTINEL
} from "#test/emit/domain-module.fixtures.ts"

/**
 * A definition set prints its reachable definitions in dependency order, the same in any order, in the layout the
 * formatter keeps. Its budget is the count its suite stated
 * before the conversion: 200 independent cases, and up to 800 steered while a situation is unreached.
 */
export const domainModule = property.explore(caseGen, {
	needs: {},
	situations: [
		"the empty module",
		"a recursive definition",
		"an alias named before its recursive target",
		"an alias named after its recursive target",
		"mutually recursive definitions",
		"an unreachable definition",
		"an annotation left out",
		"a long name",
		"a folded name",
		"a name Effect also exports",
		"a closed object",
		"a nullable member"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_resources, k: Case<Feature>) => (drawnCase) =>
		Effect.gen(function* () {
			const identifiers = identifiersOf(drawnCase.definitions)
			const file = yield* emitted(drawnCase.definitions, drawnCase.roots, identifiers)
			const again = yield* emitted(drawnCase.reordered, drawnCase.roots, identifiers)
			const formatted = yield* Effect.promise(() =>
				format("schemas.ts", file.content, FORMAT_OPTIONS)
			)
			const syntax = yield* syntaxDiagnosticsOf("schemas.ts", file.content)
			const exported = yield* parsedExports(file.content)
			const reachable = reachableFrom(drawnCase.definitions, drawnCase.roots)
			k.noteAll(featuresOf(drawnCase, identifiers, reachable, file.content, exported.types))
			assert.deepEqual(
				{
					path: file.path,
					reordered: again.content,
					formatted: formatted.code,
					syntax: syntax.length,
					exported: Arr.sort(
						Arr.map(exported.constants, (constant) => constant.name),
						Order.String
					),
					outOfOrder: outOfOrder(exported.constants),
					annotations: Str.includes(SENTINEL)(file.content)
				},
				{
					path: "src/domain/schemas.ts",
					reordered: file.content,
					formatted: file.content,
					syntax: 0,
					exported: Arr.sort(
						Arr.getSomes(Arr.map(reachable, (key) => Option.fromUndefinedOr(identifiers.get(key)))),
						Order.String
					),
					outOfOrder: [],
					annotations: false
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "TypeScript's parser and oxfmt as judges, and exactly the reachable definitions under the identifier map's names, each after what it reads"
	},
	kept: [
		{
			token: ReplayToken(
				"packages/cli-generator/test/emit/domain-module.test.ts#domainModule:-:0.5.4.0.0.0.0.3.0.0.3.5.0.0.3.0.0.0.0.7.0.1.0.7.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0"
			),
			reason:
				"a type alias past column 100 of a union hugging null, `ReadonlyArray<User> | null`: the formatter moves it under the `=` as it moves `ReadonlyArray<User>`, where the module printed it on the `=` line (found by the rotating stream at TEST_SEED=1484871236)",
			since: "2026-11-20"
		}
	],
	budget: { runs: 200, steered: 800 },
	kills: [
		{
			file: "packages/cli-generator/src/emit/domain.ts",
			original: 'if (type._tag === "Union" && !hugsUnion(type.members)) {',
			replacement: 'if (type._tag === "Union") {',
			why: "A type alias of a union hugging null opens it on the `=` line, so a long `ReadonlyArray<X> | null` stays there where the formatter moves it under the `=`; the property fails (its kept case)."
		},
		{
			file: "packages/cli-generator/src/emit/domain.ts",
			original: '[name, group(["<", indent([softline, join([",", line], args)]), softline, ">"])]',
			replacement: '[group(["<", indent([softline, join([",", line], args)]), softline, ">"])]',
			why: "A reference whose type arguments do not hug prints them without its name; the property fails (CATCH's evidence, mutant b7a7d92d86)."
		},
		{
			file: "packages/cli-generator/src/names/domain.ts",
			original: "identifiers.set(key, identifier)",
			replacement: "{}",
			why: "The domain module's identifier map keeps no name, so every definition is refused as unnamed; the property fails (EOCG-EMIT's handoff from help-non-standard.test.ts, mutant b463d38258)."
		}
	]
})

/**
 * A definition set holding one planted fault is refused with that fault's reason. Its budget is the count its suite stated
 * before the conversion: 100 independent cases, and up to 200 steered while a situation is unreached.
 */
export const domainRefusal = property.explore(plantedGen, {
	needs: {},
	situations: [
		"a definition that is no schema object",
		"a schema the importer rejects",
		"a key the identifier map leaves out",
		"two keys given one name",
		"a name Effect exports differently"
	] satisfies ReadonlyArray<Reached<Fault>>,
	check: (_, k: Case<Fault>) => (planted) =>
		Effect.map(
			Effect.exit(emitted(planted.definitions, planted.roots, planted.identifiers)),
			(exit) => {
				k.note(planted.fault)
				assert.deepEqual(
					Exit.match(exit, {
						onSuccess: () => Option.none<string>(),
						onFailure: (cause) => Option.map(Cause.findErrorOption(cause), (error) => error.reason)
					}),
					Option.some(planted.reason)
				)
			}
		),
	oracle: { kind: "specification", name: "each planted fault's refusal reason" },
	kept: [],
	budget: { runs: 100, steered: 200 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/schemas.ts",
			original: '\treturn defs === "$defs" && rest.length === 0 ? key : undefined',
			replacement: '\treturn defs === "$defs" && rest.length === (-1) ? key : undefined',
			why: "referenceKey reads no `#/$defs/<token>` reference as naming a definition, so a definition set's references are refused or resolved wrongly; the property fails (CATCH's evidence, mutant 05368cc231)."
		}
	]
})
