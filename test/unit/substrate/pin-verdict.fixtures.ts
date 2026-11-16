/** What the properties of pin-verdict.test.ts read: its spaces, models and helpers. */

import { type Case } from "@bjornpagen/testing/explore"
import { array, element, type Gen, shuffled, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Equivalence, Option } from "effect"
import { type Build, type Verdict } from "#pg/installation.ts"

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
export const pairGen: Gen<Pair> = (source) => {
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

export type Feature =
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
export const lackingOf = (pair: Pair): ReadonlyArray<string> =>
	Arr.getSomes(
		Arr.map(pair.roles, (role, index) =>
			role === "in the installation's alone" || role === "rewritten"
				? Option.some(patch(index, "first"))
				: Option.none()
		)
	)

/** The verdict the specification gives a pair, read off its construction. */
export const expected = (pair: Pair, installed: Build): Verdict["kind"] =>
	pair.release !== "the pin's release"
		? "build"
		: lackingOf(pair).length > 0
			? "older"
			: Arr.makeEquivalence(Equivalence.String)(installed.patches, pair.pin.patches)
				? "built"
				: "build"

const has = (pair: Pair, role: Role): boolean => Arr.contains(pair.roles, role)

/** The situations a pair is, by its release and by what its files are to the two builds. */
export const notePair = (pair: Pair, installed: Option.Option<Build>, c: Case<Feature>): void => {
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
