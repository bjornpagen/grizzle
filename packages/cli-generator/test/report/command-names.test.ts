/**
 * The generation report's `commandNames` (design 8.1): over up to three operations, each named by one source (Fern's or
 * Forge's extensions, a tag and its operationId, the author config, an operationId alone, its route), with up to two
 * `x-forge-aliases` entries, each in a group of its own or beside its primary, named by Forge or Fern, or at the root by
 * an operationId of its own, and some with a request body emitCli cannot express, the report generate writes lists
 * every emitted command in design 8.3's command order (the groups in first-use order, each group's commands before its
 * child groups, then the root's), each with its visible path, its operation's use site, the source of its group's and
 * its command's name and an alias's index; an operation emitCli refuses is refused once, as `EMT-1/unsupported-body`
 * at its pointer, and none of its names is listed; and a scheme the author config adds is listed under
 * `authorSuppliedSchemes` by its config key, which is absent when it adds none.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import { Digest } from "effect/crypto"
import {
	expectedOf,
	featuresOf,
	type NamesFeature,
	namesSpace,
	outcomeOf
} from "#test/report/command-names.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * The report lists the emitted commands, its refusals and its added schemes as design 8.1 states them. It replaces four
 * example cases, so its rotating stream is four drawn cases; its floor and steered phase reach each of its 19 situations
 * by an aimed case. The suite's fifth case, two runs printing equal bytes, is determinism.test.ts's, over every file
 * generate writes, and could state no kill here.
 */
export const commandNames = property.explore(namesSpace, {
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"a command named by config",
		"a command named by operationId",
		"a command named by route",
		"a command named by x-fern",
		"a command named by x-forge",
		"a group named by config",
		"a group named by none",
		"a group named by tag",
		"a group named by x-fern",
		"a group named by x-forge",
		"a nested group",
		"an alias in a group of its own",
		"an alias at the root",
		"an alias beside its primary",
		"a second alias",
		"a group's commands before its child group",
		"a root command before a group's in plan order",
		"an operation emitCli refuses",
		"an author-supplied scheme"
	] satisfies ReadonlyArray<Reached<NamesFeature>>,
	check:
		({ dir, digest }, k: Case<NamesFeature>) =>
		(c) =>
			Effect.gen(function* () {
				k.noteAll(featuresOf(c))
				const scratch = yield* dir
				const service = yield* digest
				const outcome = yield* Effect.provideService(outcomeOf(c, scratch), Digest.Digest, service)
				assert.deepEqual(outcome, expectedOf(c))
			}),
	oracle: {
		kind: "specification",
		name: "design 8.1's commandNames in design 8.3's command order, its EMT-1 refusals and authorSuppliedSchemes"
	},
	kept: [],
	budget: { runs: 4, steered: 40 },
	kills: [
		{
			file: "packages/generator/src/generate.ts",
			original: "refusedBy(refusals, entry.command.operation) ? [] : [commandName(entry)]",
			replacement: "[commandName(entry)]",
			why: "A refused operation's commands are listed beside the emitted ones; the property fails."
		},
		{
			file: "packages/generator/src/generate.ts",
			original: "\tif (command.alias !== undefined) {",
			replacement: "\tif (command.alias === undefined) {",
			why: "An alias command is listed with no alias index; the property fails."
		},
		{
			file: "packages/generator/src/generate.ts",
			original: "path: [...namesOf(group), command.name]",
			replacement: "path: [group.name, command.name]",
			why: "A command of a nested group is listed without its parent groups' names; the property fails."
		},
		{
			file: "packages/generator/src/generate.ts",
			original:
				"\t\t...Arr.map(group.commands, (command) => ({ command, path: [...namesOf(group), command.name] })),\n\t\t...Arr.flatMap(\n\t\t\tArr.filter(plan.groups, (child) => child.parent === group.tag),\n\t\t\twalk\n\t\t)",
			replacement:
				"\t\t...Arr.flatMap(\n\t\t\tArr.filter(plan.groups, (child) => child.parent === group.tag),\n\t\t\twalk\n\t\t),\n\t\t...Arr.map(group.commands, (command) => ({ command, path: [...namesOf(group), command.name] }))",
			why: "A group's child groups are walked before its own commands, so the order is not design 8.3's; the property fails."
		},
		{
			file: "packages/generator/src/generate.ts",
			original:
				"\treturn [\n\t\t...Arr.flatMap(\n\t\t\tArr.filter(plan.groups, (group) => group.parent === undefined),\n\t\t\twalk\n\t\t),\n\t\t...Arr.map(plan.root, (command) => ({ command, path: [command.name] }))\n\t]",
			replacement:
				"\treturn [\n\t\t...Arr.map(plan.root, (command) => ({ command, path: [command.name] })),\n\t\t...Arr.flatMap(\n\t\t\tArr.filter(plan.groups, (group) => group.parent === undefined),\n\t\t\twalk\n\t\t)\n\t]",
			why: "The root's commands are listed before the groups', so the order is not design 8.3's; the property fails."
		},
		{
			file: "packages/generator/src/report/index.ts",
			original: '(scheme) => scheme.source === "author-supplied"',
			replacement: '(scheme) => scheme.source !== "author-supplied"',
			why: "A scheme the author config adds is left out of authorSuppliedSchemes; the property fails."
		}
	]
})
