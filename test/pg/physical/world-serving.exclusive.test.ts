/**
 * Every world function is index-served at volume: an existence test bound to its arguments, judged by PostgreSQL's
 * serving judge (world-serving.ts, serving.ts), over generated role schemas.
 *
 * The file runs with the cluster to itself (`.exclusive`, vitest.network.config.ts): the fixture's load at a million
 * facts per relation is one SERIALIZABLE transaction judged at COMMIT, and SSI retains every transaction that commits
 * meanwhile.
 *
 * A case draws a documents base, the roles the worlds model's generator draws over it (installGen), and one or two
 * witnesses, each a role writing a query entry over a relation T filtered by a link into another source (world-serving.ts
 * LinkWitness), so every situation below is reached by construction: a witness's filter function, called at its linked
 * source's middle row, probes the source at values it holds, and at values no row holds probes it in vain; its key
 * probes read T at a key it holds and at one it does not; its policy row calls the filter function under row security;
 * and its precheck calls the filter function and every probe. The witness's arm chooses what its link reads: an
 * ordinary relation, the derived relation, or an ordinary relation a declared key reads, such as Share under the
 * base's one-share variant, `key(on(Share, "doc"))`, whose probe is that key's key probe: UniqueObjects.keys holds
 * every declared key beside the primary key (laws/model/uniques.ts uniqueOf, "A UNIQUE over a declared candidate key's
 * fields in its order is that key's", so since 65203c4), and a unique probe is only an object's beyond the keys, which
 * no documents base holds: pg/write/entry-occupants covers it, at its key over a selected side,
 * `key(on(select(Seat, lead), "grp"))`. Its link may bind a second field of the source,
 * to another field of T or to a context's claim, as the documents base's notes bind their document's
 * organization to the tenant's (test/support/worlds/model/bases/docs.ts), so a probe binds what the row and the claim fix together. The joined arm binds it to a field of a third
 * source that another field of T links into, `T ⋈ Y{to: T.from} ⋈ X{to: T.from2, h: Y.g}`, so X's probe binds what
 * the row and Y fix together: the row is one fact, which binds every probe of what it joins, so X is served by one
 * index of both fields rather than read by one and rechecked on the other. Every world function of the drawn roles'
 * writable entries is judged beside them, at T's middle row and at no row.
 *
 * The drawn population holds 20,000 facts per relation, where a scan of a relation reads its index's hundred pages and
 * more against a bound of a few: a lowering that deduplicates each relation a filter reads, which PostgreSQL cannot
 * pull into its join, fails here, the judge naming the scan. One fixed fixture holds a million facts per relation: the
 * documents base's README-shaped worlds over the one-share key, beside a witness of each arm.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { TestContext } from "vitest"
import {
	fixtureRows,
	joinedOf,
	judgeCase,
	linksOf,
	populationRows,
	type Second,
	secondsOf,
	type LinkWitness,
	type WorldCase,
	type WorldServingFeature
} from "#test/pg/physical/world-serving.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { docsBases, docsOneShareInstall } from "#test/support/worlds/model/bases/docs.ts"
import type { BaseSpec } from "#test/support/worlds/model/types.ts"

/** What a witness's link reads: an ordinary relation, a derived one, an ordinary one from a relation a declared key
 * reads, whose probe is the key's key probe, or any source joined to another that a second field of T links into
 * (world-serving.ts Second, `joined`). */
type Arm = "ordinary" | "derived" | "declared key" | "joined"

/**
 * The relations a declared key reads, each once: each holds a key besides its primary key, which an insert through it
 * probes (fin.md §6, "at most one").
 */
const atMostOne = (base: BaseSpec): ReadonlyArray<string> =>
	Arr.dedupe(Arr.flatMap(base.laws, (law) => (law.kind === "key" ? [law.relation] : [])))

/** A link of an arm: from a target, into a source, by a pair of their fields. */
interface ArmLink {
	readonly target: string
	readonly source: string
	readonly link: { readonly from: string; readonly to: string }
}

/**
 * The links an arm draws from in a base, and the seconds each admits: a joined arm's link its joined seconds alone
 * (joinedOf), any other's its second bindings (secondsOf) or none.
 */
const armLinks = (
	base: BaseSpec,
	arm: Arm
): ReadonlyArray<ArmLink & { readonly seconds: (negated: boolean) => ReadonlyArray<Second> }> => {
	const relations = Arr.map(base.relations, (r) => r.name)
	const derived = Arr.map(base.derived, (d) => d.name)
	const between = (targets: ReadonlyArray<string>, sources: ReadonlyArray<string>) =>
		Arr.flatMap(targets, (target) =>
			Arr.map(linksOf(base, target, sources), (l): ArmLink => ({ target, ...l }))
		)
	const drawn = (links: ReadonlyArray<ArmLink>) =>
		Arr.map(links, (l) => ({
			...l,
			seconds: (negated: boolean): ReadonlyArray<Second> => [
				{ kind: "none" },
				...secondsOf(base, l.target, l.source, l.link, negated)
			]
		}))
	switch (arm) {
		case "ordinary":
			return drawn(between(relations, relations))
		case "derived":
			return drawn(between(relations, derived))
		case "declared key":
			return drawn(between(atMostOne(base), relations))
		case "joined": {
			const sources = [...relations, ...derived]
			return Arr.flatMap(between(relations, sources), (l) => {
				const joined = joinedOf(base, l.target, sources, l.source, l.link)
				return joined.length > 0 ? [{ ...l, seconds: () => joined }] : []
			})
		}
	}
}

const arms: Arr.NonEmptyReadonlyArray<Arm> = ["ordinary", "derived", "declared key", "joined"]

/** The arms a base admits: those with a link to draw. */
const armsOf = (base: BaseSpec): ReadonlyArray<Arm> =>
	Arr.filter(arms, (arm) => armLinks(base, arm).length > 0)

/** A witness of `arm` over `base`: a link of the arm, matched or negated, and a second the link admits under it. */
const witnessGen =
	(base: BaseSpec, arm: Arm): Gen<LinkWitness> =>
	(source) => {
		const chosen = source.draw(
			element(knownNonEmpty(armLinks(base, arm), `the ${arm} links of ${base.name}`))
		)
		const negated = source.draw(boolean)
		const second: Second = source.draw(
			element(knownNonEmpty(chosen.seconds(negated), `the seconds of a ${arm} link`))
		)
		return { target: chosen.target, source: chosen.source, link: chosen.link, second, negated }
	}

/**
 * A case: its first witness's arm, then a documents base that admits it, the witness, perhaps a second of any arm the
 * base admits, and the roles the worlds model draws over the base.
 */
const caseGen: Gen<WorldCase> = (source) => {
	const arm = source.draw(element(arms))
	const base = source.draw(
		element(
			knownNonEmpty(
				Arr.filter(docsBases, (b) => armsOf(b).includes(arm)),
				`the documents bases admitting a ${arm} witness`
			)
		)
	)
	const first = source.draw(witnessGen(base, arm))
	const admitted = knownNonEmpty(armsOf(base), `the arms of ${base.name}`)
	const more = source.draw(
		array((inner) => inner.draw(witnessGen(base, inner.draw(element(admitted)))), {
			min: 0,
			max: 1
		})
	)
	return { install: source.draw(installGen(base)), witnesses: [first, ...more] }
}

/** The situations every run reaches (see the header), and the fixture alone. */
const requiredSituations: Arr.NonEmptyReadonlyArray<WorldServingFeature> = [
	"a filter function's probe that finds its fact",
	"a filter function's probe that finds none",
	"a filter function's probe of a derived relation",
	"a filter function's probe bound by its argument and a claim",
	"a filter function's probe bound by its argument and a joined source",
	"a key probe that reads its key's fact",
	"a key probe that finds no fact at its key",
	"a declared key's probe that reads its key's fact",
	"a declared key's probe that finds no fact at its key",
	"a policy row calling the filter function",
	"a precheck calling the filter function"
]

const populationSuite = (runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				suite: "pg/physical/world-serving",
				draw: drawn(caseGen),
				literal: Formatter.format,
				coverage: required<WorldServingFeature>(requiredSituations, {
					cases: runs,
					sense: notesOnly
				}),
				kept: [],
				runs,
				shrink: { kind: "bounded", candidates: 24 },
				concurrency: 1,
				steerEvery: 4,
				caseHang
			},
			(c, cx) =>
				Effect.scoped(
					Effect.gen(function* () {
						const problems = yield* judgeCase(c, populationRows, cx.note)
						assert.deepEqual(problems, [], "every world function call reads by its indexes")
					})
				)
		)
	)

/**
 * The fixture's witnesses, one of each arm: a note's document; a document no derived row holds under its own organization;
 * a share's user, the owner of a document of the tenant's organization; and a share whose user wrote a note on a
 * document id equal to its document's organization, so the note is probed by the share's user and the document's
 * organization at once.
 */
const fixtureWitnesses: Arr.NonEmptyReadonlyArray<LinkWitness> = [
	{
		target: "Note",
		source: "Doc",
		link: { from: "doc", to: "id" },
		second: { kind: "none" },
		negated: false
	},
	{
		target: "Doc",
		source: "OrgDocs",
		link: { from: "id", to: "doc" },
		second: { kind: "field", pair: { from: "org", to: "org" } },
		negated: true
	},
	{
		target: "Share",
		source: "Doc",
		link: { from: "user", to: "owner" },
		second: { kind: "claim", to: "org", context: "Tenant", field: "org" },
		negated: false
	},
	{
		target: "Share",
		source: "Doc",
		link: { from: "doc", to: "id" },
		second: {
			kind: "joined",
			to: "org",
			source: "Note",
			link: { from: "user", to: "author" },
			field: "doc"
		},
		negated: false
	}
]

layer(Substrate.layer)("world functions, judged by PostgreSQL at volume", (it) => {
	it.effect(
		"every world function of generated roles reads by its indexes at 20,000 facts per relation",
		populationSuite(24)
	)
	it.effect(
		"the README's worlds and a witness of each arm read by their indexes at a million facts per relation",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const reached = new Set<WorldServingFeature>()
					const problems = yield* judgeCase(
						{ install: docsOneShareInstall, witnesses: fixtureWitnesses },
						fixtureRows,
						(feature) => {
							reached.add(feature)
						}
					)
					assert.deepEqual(problems, [], "every world function call reads by its indexes")
					assert.deepEqual(
						Arr.filter(requiredSituations, (f) => !reached.has(f)),
						[],
						"the fixture reaches every situation"
					)
				})
			)
	)
})
