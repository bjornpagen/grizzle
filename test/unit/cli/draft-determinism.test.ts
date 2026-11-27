/**
 * A draft is a function of its source and its committed chain: `grizzle generate` run on one source twice, from
 * nothing, in two projects at two absolute paths, by two processes each run from another directory (the project, the
 * workspace above it, or the checkout's root naming the configuration by its absolute path), its configuration file
 * under one name or another, in another time zone and
 * another locale (TZ, LANG and LC_ALL), one after the other, writes one tree byte for byte, folder names included; and so
 * does a second folder drafted on the committed chain, a draft of the source's next version or a custom folder, the
 * chain's one folder named as drafted or renamed to a second a clock once wrote, as a chain the command line named by
 * its clock before holds it. One project's migrations directory may hold a hidden directory with a snapshot.json, which
 * no command reads (cli/files.ts visibleEntries), where a visible one would be an abandoned schema's.
 *
 * Oracle: the two runs agree with each other on every byte of every file under the migrations directory, and each
 * newest folder's timestamp is the documented rule's (cli/timestamp.ts nextTimestamp): the epoch, 19700101000000, for
 * a chain of none, and the second after the chain's last folder's, by the calendar's day arithmetic
 * (test/support/calendar.ts), a second implementation.
 *
 * Features: the first folder named by --name or after its change, the second after the epoch's folder or after a
 * clock's second, drafted or custom, and each directory a run runs from.
 */
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DraftFeature,
	draftFeatures,
	draftingSpace,
	draftTwice
} from "#test/unit/cli/draft-determinism.fixtures.ts"

/**
 * One source drafted twice, from nothing and then on its committed chain, by two processes at two paths, from two
 * directories, in two time zones and two locales, one after the other, writes one tree byte for byte, folder names
 * included, each newest folder stamped its chain's next second.
 *
 * Budget: every case runs the bin four times, about ten seconds each on a loaded machine (33 to 42 s a case,
 * toolchain-test runs of 2026-11-26 at an allowance of 4); two independent cases, each two of the three directories a
 * run runs from, and a steered case at most for each situation, each aimed at one still pending (draftingSpace), so the
 * steered phase reaches every situation whatever the floor drew, and stops once it has.
 */
export const oneSourceDraftedTwiceFromNothingAndOnItsCommittedChainByTwoProcessesAtTwoPathsInTwoTimeZonesAndLocalesWritesOneTreeByteForByte =
	property.explore(draftingSpace, {
		needs: { checkout: Checkout.dir },
		situations: draftFeatures satisfies ReadonlyArray<Reached<DraftFeature>>,
		check: (resources, c: Case<DraftFeature>) => (d) =>
			Effect.flatMap(resources.checkout, (checkout) => draftTwice(checkout, d, c)),
		oracle: {
			kind: "second-implementation",
			name: "the two runs agree byte for byte, and each newest folder's timestamp is the documented rule's by the calendar's day arithmetic: the epoch for a chain of none, the second after the chain's last folder's"
		},
		budget: { runs: 2, steered: draftFeatures.length },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/timestamp.ts",
				original:
					"\t\t\tonNone: () => chainStart,\n\t\t\tonSome: (last) => DateTime.add(instantOf(last), timestampResolution)",
				replacement:
					"\t\t\tonNone: () => DateTime.nowUnsafe(),\n\t\t\tonSome: (last) =>\n\t\t\t\tDateTime.max(DateTime.nowUnsafe(), DateTime.add(instantOf(last), timestampResolution))",
				why: "The clock put back in nextTimestamp, as before DRAFTDET: a folder is the current UTC second or the second after its chain's last, whichever is later, so two drafts of one source at two times are named apart."
			},
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original: "\t\tfor (const name of yield* visibleEntries(fs, config.migrations)) {",
				replacement: "\t\tfor (const name of yield* fs.readDirectory(config.migrations)) {",
				why: "A schema's first draft lists the migrations directory's hidden entries too, as before DRAFTDET: a hidden directory holding a snapshot.json is an abandoned schema, and the draft beside it starts under the loss of its rows."
			}
		]
	})
