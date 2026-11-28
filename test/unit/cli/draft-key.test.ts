/**
 * A draft's key is a function of its inputs, the roster of them (packages/grizzle/src/cli/draft-inputs.ts), which
 * CONTRIBUTING.md names and a real generate reads alone.
 *
 * - **CONTRIBUTING.md is the roster:** its section "Drafts and their key" names each member of the roster, its text
 *   word for word as the roster states it, wrapped, and as many numbered inputs as the roster has members.
 * - **Twin projects give one key, and generate reads the roster alone:** one source at two paths, `grizzle draft-key`
 *   run in each by a process of its own, in two time zones and two locales, from two directories, its configuration
 *   file under one name or another, prints one key; and a real `grizzle generate` in the first, under a read trace
 *   (test/support/read-trace-probe.ts), loads no module, reads no path, reads no variable and reads no clock outside the
 *   roster: every module grizzle's, a package's or the configuration's own, every read the configuration file, a
 *   visible entry of the migrations directory or a path at or under the process's own staging entry of one, every
 *   variable one Node reads of its
 *   own, by Node's own code, and no clock at all.
 * - **One input changed, the key moves; anything else, it stays:** a project's tree, its configuration's two modules,
 *   its lockfile, its migrations directory and a checkout of grizzle's packages, keyed as made, as a twin at another
 *   path, which keys alike, and with one change: a flag, a closure module's bytes, the lockfile's, a visible migrations
 *   entry's, a file of grizzle's packages' or Node's version, each of which moves the key, or a hidden entry, a file
 *   beside the configuration or a file beside grizzle's sources, none of which does.
 *
 * Oracle: the roster's own statement of its members and their texts (specification); the trace's reads against the
 * roster's own predicates of what each member names (draft-inputs.ts isGrizzleFile, isPackageFile, isVisibleUnder,
 * nodeVariables); and the two runs, and the two trees, against each other.
 *
 * Features: each directory a run runs from, a nesting with a space, a configuration file of another name, and each kind
 * of change.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { draftInputOrder, draftInputs } from "#cli/draft-inputs.ts"
import type { RunFeature } from "#test/support/bin-runs.ts"
import { draftInputMembers } from "#test/unit/cli/draft-key.dictionary.ts"
import {
	type Change,
	changedSpace,
	changes,
	keyedApart,
	numberedItems,
	documentedSection,
	twinKeysAndTrace,
	twinsSpace,
	unwrapped
} from "#test/unit/cli/draft-key.fixtures.ts"

/** CONTRIBUTING.md's draft section names each member of the draft's roster word for word, and no input besides. */
export const contributingsDraftSectionNamesEachMemberOfTheDraftsRosterWordForWordAndNoInputBesides =
	property.exhaust(finite(word(draftInputMembers)), {
		box: "every member of the roster of a draft's inputs (cli/draft-inputs.ts draftInputOrder)",
		needs: {},
		situations: [],
		check: () => (input) =>
			Effect.gen(function* () {
				const section = yield* documentedSection
				const items = numberedItems(section)
				assert.equal(items.length, draftInputOrder.length, "CONTRIBUTING.md's numbered inputs")
				assert.equal(
					items[draftInputOrder.indexOf(input)],
					unwrapped(draftInputs[input].documented),
					`CONTRIBUTING.md names ${input} as the roster does, in its place`
				)
			}),
		oracle: { kind: "specification", name: "the roster's own texts of its members" },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/draft-inputs.ts",
				original: "never the configuration file's path or `--phases`, which writes to stderr alone",
				replacement: "never the configuration file's path or `--phases`",
				why: "A member's text reworded where CONTRIBUTING.md is not."
			}
		]
	})

/**
 * Twin projects of one source give one key, and a real generate traced in one reads nothing outside the roster.
 *
 * Budget: every case runs the bin three times, about ten seconds each on a loaded machine; two independent cases and a
 * steered case at most for each situation, each aimed at one still pending (twinsSpace).
 */
export const twinProjectsOfOneSourceGiveOneKeyAndARealGenerateTracedInOneReadsNothingOutsideTheRoster =
	property.explore(twinsSpace, {
		needs: { checkout: Checkout.dir },
		situations: [
			"run from the project",
			"run from the workspace",
			"run from the checkout",
			"a project nested in a path with a space",
			"a configuration file of another name"
		] satisfies ReadonlyArray<Reached<RunFeature>>,
		check: (resources, c: Case<RunFeature>) => (t) =>
			Effect.flatMap(resources.checkout, (checkout) => twinKeysAndTrace(checkout, t, c)),
		oracle: {
			kind: "specification",
			name: "the roster's members as its own predicates name them, and the twin runs' keys against each other"
		},
		budget: { runs: 2, steered: 5 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original:
					"\tconst tree = yield* readSchemaTree(schema.declared, schema.directory)\n\tconst committed",
				replacement:
					'\tconst tree = yield* readSchemaTree(schema.declared, schema.directory)\n\tconst stray = yield* FileSystem.FileSystem\n\tyield* Effect.ignore(stray.readFileString(process.getBuiltinModule("node:path").join(process.getBuiltinModule("node:os").homedir(), ".grizzlerc")))\n\tconst committed',
				why: "generate reads a file outside the roster, a stray ~/.grizzlerc, which no key names."
			},
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original: "\t\t\t\tconst text = loginText(entry, kind)\n",
				replacement: '\t\t\t\tconst text = [...loginText(entry, kind), process.env["TZ"] ?? ""]\n',
				why: "generate reads TZ into a served file, a variable no key names."
			}
		]
	})

/** One input of the roster changed moves the key, and a change of nothing the roster names leaves it. */
export const oneInputOfTheRosterChangedMovesTheKeyAndAChangeOfNothingTheRosterNamesLeavesIt =
	property.explore(changedSpace, {
		needs: {},
		situations: changes satisfies ReadonlyArray<Reached<Change>>,
		check: (_, c: Case<Change>) => (d) => keyedApart(d, c),
		oracle: {
			kind: "specification",
			name: "the roster's members: a change of one moves the key, a change of none leaves it"
		},
		budget: { runs: 24, steered: 18 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/draft-inputs.ts",
				original: "\t\tfor (const input of draftInputOrder) {",
				replacement:
					'\t\tfor (const input of Arr.filter(draftInputOrder, (i) => i !== "lockfile")) {',
				why: "The key omits a member of the roster, the lockfile: a lockfile changed leaves the key."
			}
		]
	})
