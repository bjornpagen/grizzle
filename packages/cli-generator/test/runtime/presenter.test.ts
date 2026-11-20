/**
 * The generated entry presents what effect's CLI says where the design routes it (7.4): requested help and the version
 * on stdout, implicit help (a group run with no subcommand) on stderr, both exiting 0; a refused invocation on stderr
 * only, exiting 2 and reported once, never quoting the value it refused; every text the formatter in context writes,
 * its terminal-driving and invisible characters removed. exitForHelp ends help asked for with errors at exit 2, help
 * with none at exit 0, and passes any other failure through.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aimedPresentations,
	expectedFacts,
	expectedHelpExit,
	factsOf,
	helpExitFeatures,
	type HelpExitFeature,
	helpExitOf,
	helpExits,
	type PresentationFeature,
	presentationFeatures,
	presentedOf
} from "#test/runtime/presenter.fixtures.ts"

/**
 * Each invocation reaches the stream the routing table names, sanitized and value-free. It replaces eight example
 * cases; its rotating stream is eight drawn presentations, its floor and steered phase reach each invocation under
 * each formatter by an aimed one.
 */
export const presented = property.explore(aimedPresentations, {
	needs: {},
	situations: [
		"requested help, value-free",
		"requested help, hostile",
		"version, value-free",
		"version, hostile",
		"implicit help, value-free",
		"implicit help, hostile",
		"an invalid value, value-free",
		"an invalid value, hostile",
		"errors rendered",
		"errors left to finalCatch"
	] satisfies ReadonlyArray<Reached<PresentationFeature>>,
	check: (_, c: Case<PresentationFeature>) => (presentation) =>
		Effect.gen(function* () {
			c.noteAll(presentationFeatures(presentation))
			const run = yield* presentedOf(presentation)
			assert.deepEqual(factsOf(presentation, run), expectedFacts(presentation))
		}),
	oracle: {
		kind: "specification",
		name: "design 7.4's routing table: each text's stream, its exit, sanitized and value-free"
	},
	kept: [],
	budget: { runs: 8, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: '\t\t\tif (event.reason === "Requested") {',
			replacement: '\t\t\tif (event.reason !== "Requested") {',
			why: "Requested help goes to stderr and implicit help to stdout; the property fails (CATCH's evidence, mutant 9eecbd00ce)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "yield* Console.log(sanitize(format.formatVersion(event.name, event.version)))",
			replacement: "{}",
			why: "The version is never printed; the property fails (CATCH's evidence, mutant e8a4769f5a)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "yield* Console.error(help)",
			replacement: "{}",
			why: "Implicit help is never printed on stderr; the property fails (CATCH's evidence, mutant 3552e5b6a8)."
		}
	]
})

/**
 * exitForHelp ends help with errors at 2, help without at 0, and passes other failures through. It replaces three
 * example cases; its budget is 6 drawn failures, steered up to 6 while a situation is unreached.
 */
export const helpExit = property.explore(helpExits, {
	needs: {},
	situations: [
		"help with errors",
		"help without errors",
		"another failure"
	] satisfies ReadonlyArray<Reached<HelpExitFeature>>,
	check: (_, c: Case<HelpExitFeature>) => (exit) =>
		Effect.gen(function* () {
			c.noteAll(helpExitFeatures(exit))
			const exited = yield* helpExitOf(exit)
			assert.deepEqual(exited, expectedHelpExit(exit))
		}),
	oracle: {
		kind: "specification",
		name: "help with errors exits 2, help without exits 0, any other failure keeps its own"
	},
	kept: [],
	budget: { runs: 6, steered: 6 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "isShowHelp(error)",
			replacement: "false",
			why: "exitForHelp catches no help, so help with no errors fails instead of exiting 0; the property fails (CATCH's evidence, mutant ffb38e7c07)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: 'CliError.isCliError(error) && error._tag === "ShowHelp"',
			replacement: "true",
			why: "Every failure reads as help, so another failure is taken for help and loses its exit code; the property fails (CATCH's evidence, mutant c88c49b505)."
		}
	]
})
