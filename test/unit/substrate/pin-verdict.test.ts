/**
 * build.sh's verdict on a checkout's pin over the build the PostgreSQL installation holds (packages/pg/src/installation.ts
 * verdict), over drawn pairs of an installed stamp and a checkout's pin:
 *
 * - nothing installed, or a build of another release, a repin, builds the pin, however many patches either holds, so a
 *   GA repin that drops the patches its release includes is never refused;
 * - a build of the pin's own release with a patch the pin lacks, a patch dropped or one rewritten under its old name,
 *   is refused as older than the installation, naming exactly the patches the pin lacks, in the installation's order;
 * - a build of the pin's own release whose every patch the pin applies too is built again unless it is the pin itself,
 *   the same patches in the same order, which is left as it is.
 *
 * Inputs are constructed, never filtered: the release the installation builds (nothing, the pin's, or another), the
 * roles a pair's files take, what each of four patch files is to the two builds (in neither, in both alike, in the installation's alone, in the pin's
 * alone, or in both with other content), the installation's order, and the pin's order, either the installation's with
 * its own patches after them or any. The oracle is the specification, read off that construction: the patches the pin
 * lacks are those of the files in the installation's alone and of the rewritten ones.
 *
 * Features: nothing installed; another release, with and without patches the pin lacks; the pin itself; the pin adding
 * patches; the pin reordering them; the pin lacking patches and adding none, adding others, or holding as many as the
 * installation; a patch rewritten; no patch alike; and both empty.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { type Verdict, verdict } from "#pg/installation.ts"
import { assert } from "#test/support/assert.ts"
import {
	expected,
	type Feature,
	lackingOf,
	notePair,
	pairGen
} from "#test/unit/substrate/pin-verdict.fixtures.ts"

/** Build.sh's verdict on a pin builds over nothing and over another release, refuses a pin of the installation's release that lacks one of its patches, naming them, and keeps the pin itself. */
export const buildShsVerdictOnAPinBuildsOverNothingAndOverAnotherReleaseRefusesAPinOfTheInstallationsReleaseThatLacksOneOfItsPatchesNamingThemAndKeepsThePinItself =
	property.explore(pairGen, {
		needs: {},
		situations: [
			"nothing installed",
			"another release whose build holds patches the pin lacks",
			"another release whose build the pin holds every patch of",
			"the pin itself",
			"the pin adding patches",
			"the pin reordering the patches",
			"the pin lacking patches and adding none",
			"the pin lacking patches and adding others",
			"the pin lacking patches yet holding as many",
			"a patch rewritten",
			"no patch alike",
			"both empty"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (pair) =>
			Effect.sync(() => {
				const decided = verdict(pair.installed, pair.pin)
				assert.equal(
					decided.kind,
					Option.match(pair.installed, {
						onNone: (): Verdict["kind"] => "build",
						onSome: (installed) => expected(pair, installed)
					})
				)
				if (decided.kind === "older" && Option.isSome(pair.installed)) {
					const lacking = lackingOf(pair)
					assert.deepEqual<ReadonlyArray<string>>(
						decided.lacking,
						Arr.filter(pair.installed.value.patches, (entry) => Arr.contains(lacking, entry))
					)
				}
				notePair(pair, pair.installed, c)
			}),
		oracle: {
			kind: "specification",
			name: "the release keys the refusal; the pin lacks the patches of files in the installation's alone and of rewritten ones"
		},
		kept: [],
		kills: [
			{
				file: "packages/pg/src/installation.ts",
				original:
					'\tOption.match(\n\t\tOption.filter(installed, (build) => build.commit === pin.commit),\n\t\t{\n\t\t\tonNone: (): Verdict => ({ kind: "build" }),\n\t\t\tonSome: (build): Verdict => {\n\t\t\t\tconst lacking = Arr.difference(build.patches, pin.patches)\n\t\t\t\treturn Arr.isReadonlyArrayNonEmpty(lacking)\n\t\t\t\t\t? { kind: "older", lacking }\n\t\t\t\t\t: samePatches(build.patches, pin.patches)\n\t\t\t\t\t\t? { kind: "built" }\n\t\t\t\t\t\t: { kind: "build" }\n\t\t\t}\n\t\t}\n\t)',
				replacement:
					'\tOption.match(installed, {\n\t\tonNone: (): Verdict => ({ kind: "build" }),\n\t\tonSome: (build): Verdict => {\n\t\t\tconst lacking = Arr.difference(build.patches, pin.patches)\n\t\t\treturn build.patches.length > pin.patches.length && Arr.isReadonlyArrayNonEmpty(lacking)\n\t\t\t\t? { kind: "older", lacking }\n\t\t\t\t: build.commit === pin.commit && samePatches(build.patches, pin.patches)\n\t\t\t\t\t? { kind: "built" }\n\t\t\t\t\t: { kind: "build" }\n\t\t}\n\t})',
				why: "The refusal is keyed on the patch count: a pin with fewer patches than the installation is refused whatever its release, and a pin of the same release that lacks a patch but holds as many is built; the property fails."
			},
			{
				file: "packages/pg/src/installation.ts",
				original: "\t\tOption.filter(installed, (build) => build.commit === pin.commit),",
				replacement:
					"\t\tOption.filter(\n\t\t\tinstalled,\n\t\t\t(build) => build.commit === pin.commit || build.patches.length > pin.patches.length\n\t\t),",
				why: "The commit's refusal is kept, and a pin of another release with fewer patches is refused too, a GA repin among them; the property fails."
			}
		]
	})
