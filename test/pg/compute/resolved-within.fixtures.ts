/**
 * What the property of resolved-within.test.ts reads: its fixture, its reads of a reference's target within its base,
 * its batches and the two models it judges by.
 */

import { resolveWithin } from "@bjornpagen/grizzle-text/uri"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { regexField } from "#compiler/text/field.ts"
import { climbsOf, resolvedReference } from "#test/support/oracle/evaluate/uri.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"
import {
	referenceCaseGen,
	rfcExamples,
	type UriFeature
} from "#test/support/unit/text/uri.fixtures.ts"

/** A text within 512 bytes: every base and reference, so a target is within 1,025, which a query holds. */
const Uri = str.bytes(512, regexField<string>("^.*$", ["su"]))

/** Each reference and the base it resolves against, by its id. */
const Pair = relation("Pair", { id: int4, base: Uri, reference: Uri }, ["id"])

export const Resolutions = schema("Resolutions", [Pair], [])

/** The reads a case holds to the models: each target within its base, and the pairs whose walk climbs, a negation. */
const programs = Object.freeze({
	load: ChangeSet.empty(Resolutions).insert(Pair, []),
	within: query(Resolutions).rule((r) => {
		const { id, base, reference } = v(Pair, "p")
		const resolved = r.resolvedWithin(base, reference)
		const { target } = v(resolved, "t")
		return r.match(Pair, { id, base, reference }).match(resolved, { target }).find({ id, target })
	}),
	above: query(Resolutions).rule((r) => {
		const { id, base, reference } = v(Pair, "p")
		return r
			.match(Pair, { id, base, reference })
			.where(r.not(r.resolvedWithin(base, reference), {}))
			.find({ id })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const resolutionsInstall = Object.freeze({ label: "resolved_within", programs })

/** Resolutions installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const resolutionsTemplate = fixtureTemplate(import.meta, Resolutions, resolutionsInstall)

/** One reference against one base. */
export interface Pairing {
	readonly base: string
	readonly reference: string
}

/** A package's documents as an importer resolves against them: the package root's URI and a document's under it. */
const packageBases = [
	"package:///imsmanifest.xml",
	"package:///items/i.xml",
	"package:///a/b/c.xml"
] as const

/** A package's references: within it, at its root, and climbing above it by one or two. */
const packageReferences = [
	"a.png",
	"./a.png",
	"../a.png",
	"../../a.png",
	"../../../a.png",
	"x/../../a.png",
	"x/./y/../a.png",
	"..",
	"../",
	"/../a.png",
	"media//a.png"
] as const

/** A package's pairing: a document of it and one of its references. */
const packageGen: Gen<Pairing> = (s) => ({
	base: s.draw(element(packageBases)),
	reference: s.draw(element(packageReferences))
})

/** Bases whose own paths' `..` segments climb past their roots, which a reference of no path keeps unwalked. */
const climbingBases = ["http://a/../g", "foo:/../../g?q", "http://a/b/../../c/d"] as const

/** References of no path: none at all, a query alone, a fragment alone. */
const pathless = ["", "?y", "#s"] as const

/** A reference of no path against a base whose own path climbs: its target the base's, unwalked, within it. */
const keptGen: Gen<Pairing> = (s) => ({
	base: s.draw(element(climbingBases)),
	reference: s.draw(element(pathless))
})

/**
 * A batch: RFC 3986 §5.4's 42 examples, up to 24 drawn pairings, up to 12 of a package's, and up to 3 references of no
 * path against a climbing base.
 */
export const pairingsGen: Gen<{
	readonly pairs: Arr.NonEmptyReadonlyArray<Pairing>
	readonly features: ReadonlyArray<UriFeature>
}> = (s) => {
	const drawn = s.draw(array(referenceCaseGen, { min: 0, max: 24 }))
	const packaged = s.draw(array(packageGen, { min: 0, max: 12 }))
	const kept = s.draw(array(keptGen, { min: 0, max: 3 }))
	return {
		pairs: [...rfcExamples, ...drawn, ...packaged, ...kept],
		features: Arr.dedupe(Arr.flatMap(drawn, (d) => d.features))
	}
}

/** A batch's facts: its pairs by their ids from 1. */
export const factsOf = (pairs: ReadonlyArray<Pairing>) => ({
	Pair: Arr.map(pairs, ({ base, reference }, i) => ({ id: i + 1, base, reference }))
})

/** Rows of targets, each written as its identity. */
export const targetsText = (
	rows: Iterable<{ readonly id: number; readonly target: string }>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => `${r.id} ${jsonText(r.target)}`),
		Order.String
	)

/** The ids of rows, in order. */
export const idsOf = (rows: Iterable<{ readonly id: number }>): ReadonlyArray<number> =>
	Arr.sort(
		Arr.map(Arr.fromIterable(rows), (r) => r.id),
		Order.Number
	)

/** The host's targets within their bases (@bjornpagen/grizzle-text uri.ts resolveWithin), by their pairs' ids. */
export const hostTargets = (pairs: ReadonlyArray<Pairing>): ReadonlyArray<string> =>
	targetsText(
		Arr.flatMap(pairs, ({ base, reference }, i) => {
			const within = resolveWithin(base, reference)
			return within._tag === "Within" ? [{ id: i + 1, target: within.target }] : []
		})
	)

/**
 * The reference's targets within their bases: the oracle's own resolution where its own depth over the walked path's
 * segments climbs nowhere (test/support/oracle/evaluate/uri.ts resolvedReference, climbsOf).
 */
export const referenceTargets = (pairs: ReadonlyArray<Pairing>): ReadonlyArray<string> =>
	targetsText(
		Arr.flatMap(pairs, ({ base, reference }, i) =>
			climbsOf(base, reference) === 0
				? [{ id: i + 1, target: resolvedReference(base, reference) }]
				: []
		)
	)

/** The reference's ids of the pairs whose walk climbs past its root. */
export const referenceAbove = (pairs: ReadonlyArray<Pairing>): ReadonlyArray<number> =>
	Arr.flatMap(pairs, ({ base, reference }, i) => (climbsOf(base, reference) === 0 ? [] : [i + 1]))

export type WithinFeature =
	| UriFeature
	| "a package's reference within it"
	| "a package's reference above its root"
	| "a reference of no path against a climbing base"

/** The situations a batch reaches: its drawn pairings', and its package pairings' within and above the root. */
export const withinFeatures = (batch: {
	readonly pairs: ReadonlyArray<Pairing>
	readonly features: ReadonlyArray<UriFeature>
}): ReadonlyArray<WithinFeature> => {
	const packaged = Arr.filter(batch.pairs, (p) => Arr.some(packageBases, (b) => b === p.base))
	return [
		...batch.features,
		...(Arr.some(packaged, (p) => climbsOf(p.base, p.reference) === 0)
			? ["a package's reference within it" as const]
			: []),
		...(Arr.some(packaged, (p) => climbsOf(p.base, p.reference) > 0)
			? ["a package's reference above its root" as const]
			: []),
		...(Arr.some(batch.pairs, (p) => Arr.some(climbingBases, (b) => b === p.base))
			? ["a reference of no path against a climbing base" as const]
			: [])
	]
}
