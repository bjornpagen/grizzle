/**
 * build.sh's verdict on a checkout's pin over the build the PostgreSQL installation holds (scripts/pg/installation.ts
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
 *
 * Plants (~/.cache/grizzle-release/BUILDGUARD/plants): verdict-patch-count.patch (the refusal keyed on the patch count:
 * a pin with fewer patches than the installation refused whatever its release, and a pin of the same release that
 * lacks a patch but holds as many built) and verdict-repin-fewer.patch (the commit's refusal kept, and a pin of
 * another release with fewer patches refused too, a GA repin among them) each turn it red.
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, shuffled, subset } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Equivalence, Formatter, Option } from "effect"
import { type Build, type Verdict, verdict } from "#scripts/pg/installation.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** What a patch file is to the two builds. */
type Role =
	| "in neither"
	| "in both alike"
	| "in the installation's alone"
	| "in the pin's alone"
	| "rewritten"

const roles: Arr.NonEmptyReadonlyArray<Role> = [
	"in neither",
	"in both alike",
	"in the installation's alone",
	"in the pin's alone",
	"rewritten"
]

/** The release the installation's build is of, if it holds one. */
type Release = "nothing installed" | "the pin's release" | "another release"

const releases: Arr.NonEmptyReadonlyArray<Release> = [
	"the pin's release",
	"another release",
	"nothing installed"
]

/** The pin's order: the patches both hold in the installation's order, its own after them; or any order. */
type Order = "the installation's order" | "any order"

const orders: Arr.NonEmptyReadonlyArray<Order> = ["the installation's order", "any order"]

/** A drawn pair, with the construction it was drawn by. */
interface Pair {
	readonly release: Release
	readonly roles: ReadonlyArray<Role>
	readonly installed: Option.Option<Build>
	readonly pin: Build
}

const pinCommit = "dffcca2e3c81178c64d4c1f44543a3507d0b7508"
const otherCommit = "0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89"

/** The patch of file `index` with content `content`, spelled as PG_PIN_PATCHES spells one. */
const patch = (index: number, content: "first" | "second"): string =>
	`p${index}.patch=${content === "first" ? "a1" : "b2"}`

/** The patch the installation's build holds of a file in `role`, if any. */
const installedPatch = (role: Role, index: number): Option.Option<string> =>
	role === "in both alike" || role === "in the installation's alone" || role === "rewritten"
		? Option.some(patch(index, "first"))
		: Option.none()

/** The patch the pin holds of a file in `role`, if any. */
const pinPatch = (role: Role, index: number): Option.Option<string> =>
	role === "in both alike" || role === "in the pin's alone"
		? Option.some(patch(index, "first"))
		: role === "rewritten"
			? Option.some(patch(index, "second"))
			: Option.none()

/**
 * Every pair: the release, each of four files' role, the installation's order, and the pin's. The roles a pair's files
 * take are drawn first, one at least, so a pair whose files take few roles, the pin itself or a reordering among them,
 * is as likely as one that mixes them all.
 */
const pairGen: Gen<Pair> = (source) => {
	const release = source.draw(element(releases))
	const taken = Arr.prepend(
		source.draw(subset(roles, { min: 0, max: roles.length })),
		source.draw(element(roles))
	)
	const fileRoles = source.draw(array(element(taken), { min: 4, max: 4 }))
	const installedPatches = Arr.getSomes(Arr.map(fileRoles, installedPatch))
	const pinPatches = Arr.getSomes(Arr.map(fileRoles, pinPatch))
	const installedOrder = source.draw(
		shuffled(installedPatches, { min: installedPatches.length, max: installedPatches.length })
	)
	const shared = Arr.filter(installedOrder, (entry) => Arr.contains(pinPatches, entry))
	const own = Arr.difference(pinPatches, shared)
	const pinOrder =
		source.draw(element(orders)) === "the installation's order"
			? Arr.appendAll(shared, source.draw(shuffled(own, { min: own.length, max: own.length })))
			: source.draw(shuffled(pinPatches, { min: pinPatches.length, max: pinPatches.length }))
	const installed: Option.Option<Build> =
		release === "nothing installed"
			? Option.none()
			: Option.some({
					commit: release === "the pin's release" ? pinCommit : otherCommit,
					patches: installedOrder
				})
	return { release, roles: fileRoles, installed, pin: { commit: pinCommit, patches: pinOrder } }
}

type Feature =
	| "nothing installed"
	| "another release whose build holds patches the pin lacks"
	| "another release whose build the pin holds every patch of"
	| "the pin itself"
	| "the pin adding patches"
	| "the pin reordering the patches"
	| "the pin lacking patches and adding none"
	| "the pin lacking patches and adding others"
	| "the pin lacking patches yet holding as many"
	| "a patch rewritten"
	| "no patch alike"
	| "both empty"

/** The patches the pin lacks, by construction: those of the files in the installation's alone, and the rewritten. */
const lackingOf = (pair: Pair): ReadonlyArray<string> =>
	Arr.getSomes(
		Arr.map(pair.roles, (role, index) =>
			role === "in the installation's alone" || role === "rewritten"
				? Option.some(patch(index, "first"))
				: Option.none()
		)
	)

/** The verdict the specification gives a pair, read off its construction. */
const expected = (pair: Pair, installed: Build): Verdict["kind"] =>
	pair.release !== "the pin's release"
		? "build"
		: lackingOf(pair).length > 0
			? "older"
			: Arr.makeEquivalence(Equivalence.String)(installed.patches, pair.pin.patches)
				? "built"
				: "build"

const has = (pair: Pair, role: Role): boolean => Arr.contains(pair.roles, role)

/** The situations a pair is, by its release and by what its files are to the two builds. */
const notePair = (pair: Pair, installed: Option.Option<Build>, c: Case<Feature>): void => {
	if (Option.isNone(installed)) {
		c.note("nothing installed")
		return
	}
	const lacking = lackingOf(pair)
	if (pair.release === "another release") {
		c.note(
			lacking.length > 0
				? "another release whose build holds patches the pin lacks"
				: "another release whose build the pin holds every patch of"
		)
		return
	}
	const adding = has(pair, "in the pin's alone")
	if (installed.value.patches.length === 0 && pair.pin.patches.length === 0) {
		c.note("both empty")
	}
	if (has(pair, "rewritten")) {
		c.note("a patch rewritten")
	}
	if (
		!has(pair, "in both alike") &&
		installed.value.patches.length > 0 &&
		pair.pin.patches.length > 0
	) {
		c.note("no patch alike")
	}
	if (lacking.length > 0) {
		c.note(
			adding
				? "the pin lacking patches and adding others"
				: "the pin lacking patches and adding none"
		)
		if (pair.pin.patches.length >= installed.value.patches.length) {
			c.note("the pin lacking patches yet holding as many")
		}
		return
	}
	c.note(
		adding
			? "the pin adding patches"
			: expected(pair, installed.value) === "built"
				? "the pin itself"
				: "the pin reordering the patches"
	)
}

const steered = Object.freeze({ cases: 200, sense: notesOnly })

describe("build.sh's verdict on a pin", () => {
	it.effect(
		"builds over nothing and over another release, refuses a pin of the installation's release that lacks one of its patches, naming them, and keeps the pin itself",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the release keys the refusal; the pin lacks the patches of files in the installation's alone and of rewritten ones"
						},
						suite: "unit/substrate/pin-verdict",
						draw: drawn(pairGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
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
							],
							steered
						),
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(pair, c) =>
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
						})
				)
			)
	)
})
