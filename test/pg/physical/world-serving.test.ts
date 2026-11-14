/**
 * Every world function is index-served: an existence test bound to its arguments, judged by PostgreSQL's serving judge
 * (world-serving.ts, serving.ts), over generated role schemas, each case's population of a drawn small size.
 *
 * A case draws a documents base, the roles the worlds model's generator draws over it (installGen), and one or two
 * witnesses, each a role writing a query entry over a relation T filtered by a link into another source (world-serving.ts
 * LinkWitness), so every situation below is reached by construction: a witness's filter function, called at its linked
 * source's middle row, probes the source at values it holds, and at values no row holds probes it in vain; its key
 * probes read T at a key it holds and at one it does not; its policy row calls the filter function under row security;
 * its read by key through the role's view of the entry, as a workload program over the role reads it, calls the
 * filter function at the row it finds; and its precheck calls the filter function and every probe. The witness's arm
 * chooses what its link reads: an ordinary relation, the derived relation, or an ordinary relation a declared key
 * reads, such as Share under the base's one-share variant, `key(on(Share, "doc"))`, whose probe is that key's key probe: UniqueObjects.keys holds
 * every declared key beside the primary key (laws/model/uniques.ts uniqueOf, "A UNIQUE over a declared candidate key's
 * fields in its order is that key's"), and a unique probe is only an object's beyond the keys, which
 * no documents base holds: pg/write/entry-occupants covers it, at its key over a selected side,
 * `key(on(select(Seat, lead), "grp"))`. Its link may bind a second field of the source,
 * to another field of T or to a context's claim, as the documents base's notes bind their document's
 * organization to the tenant's (test/support/worlds/model/bases/docs.ts), so a probe binds what the row and the claim fix together. The joined arm binds it to a field of a third
 * source that another field of T links into, `T ⋈ Y{to: T.from} ⋈ X{to: T.from2, h: Y.g}`, so X's probe binds what
 * the row and Y fix together: the row is one fact, which binds every probe of what it joins, so X is served by one
 * index of both fields rather than read by one and rechecked on the other. Every world function of the drawn roles'
 * writable entries is judged beside them, at T's middle row and at no row.
 *
 * Each case draws how many facts each relation holds, at most the least population at which every spread field of the
 * load holds two values (mostRows), so its load, one SERIALIZABLE transaction, stays small beside its neighbours'. With
 * sequential and bitmap scans disabled, over relations PostgreSQL plans unanalyzed (test/support/plans.ts unanalyzed),
 * the judge's structural verdicts stand at any size: a lowering that deduplicates each relation a filter reads, which
 * PostgreSQL cannot pull into its join, reads that relation's index with no index condition, and the judge names the
 * scan. Analyzed statistics of a small load decide a plan by its rows: at forty facts a relation, a role's read of Doc
 * by its key through its view merged Doc's row with the whole of Org's one-page primary key, which cost less than a
 * descent into it. What only volume shows, a scan's buffers far past its bound and an index PostgreSQL prefers by its
 * cost, is no property here; that every created index is needed is test/pg/physical/serving.test.ts's.
 *
 * Its kept cases, restated at mostRows: a negated link from Doc into OrgDocs, joined to Share by Doc's owner, whose precheck calls three world
 * functions that PostgreSQL plans at their calls, a role session's first, each of which, over analyzed relations, read
 * the index ends of the join of OrgDocs and Share for its selectivity (world-serving.ts callBound); and a link from Note's doc into Doc's org bound
 * by the tenant's claim, whose read by key through the role's view PostgreSQL drives from the claimed Doc into Note's
 * index on doc, rechecking no, where Note's primary key alone serves it (world-serving.ts resolveClaims); and an entry
 * over Share whose rule fixes user by the session's subject, its head doc alone, whose view a read by key names by doc
 * alone (world-serving.ts ViewKeyField).
 *
 * Features: every situation the witnesses reach by construction (see above).
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): world-serving-access-dropped (the installation plans no index for its
 * workload's and its roles' write filters' access paths).
 */
import { drawn, explore, type Kept } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { TestContext } from "vitest"
import {
	joinedOf,
	judgeCase,
	linksOf,
	rowsPerSpreadValue,
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
import { docsBase, docsBases } from "#test/support/worlds/model/bases/docs.ts"
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
const worldGen: Gen<WorldCase> = (source) => {
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

/** A case: its world, and how many facts each relation of its base holds. */
interface PopulationCase {
	readonly world: WorldCase
	readonly rows: number
}

/**
 * The most facts a relation holds in a case, derived: the least population at which every spread field of the load
 * holds two values (world-serving.ts rowsPerSpreadValue), so a probe that binds one spread field and rechecks another
 * removes rows the judge reads. A larger population shows the judge nothing more: sequential and bitmap scans are
 * disabled, so a scan's structure is the same at any size, and a scan's buffers past its bound are no property here.
 */
const mostRows = 2 * rowsPerSpreadValue

/**
 * A case's population: half the cases at mostRows, where a recheck shows, and half at any size up to it, down to one
 * fact a relation. The weights are a search budget, never a claim: the size that shows a recheck is one point of the
 * range, which a uniform draw would reach once in mostRows cases.
 */
const rowsGen: Gen<number> = weighted([
	[1, constant(mostRows)],
	[1, int(1, mostRows)]
])

const caseGen: Gen<PopulationCase> = (source) => ({
	world: source.draw(worldGen),
	rows: source.draw(rowsGen)
})

/** The cases kept from failure reports, each replayed first by value (see the header). */
const kept: ReadonlyArray<Kept<PopulationCase, WorldServingFeature>> = [
	{
		note: "a negated link from Doc into OrgDocs, joined to Share by Doc's owner, whose filter function plans a join of OrgDocs and Share: a precheck's three calls, its role session's first, plan each body at its call and read 12 buffers of index ends apiece",
		sketch: {
			rows: mostRows,
			world: {
				install: {
					base: docsBase,
					roles: [
						{
							name: "alpha",
							entries: { Org: { kind: "whole", relation: "Org" } },
							write: [],
							refresh: []
						}
					],
					logins: [{ name: "web", roles: ["alpha"] }]
				},
				witnesses: [
					{
						target: "Org",
						source: "Doc",
						link: { from: "id", to: "id" },
						second: { kind: "none" },
						negated: false
					},
					{
						target: "Doc",
						source: "OrgDocs",
						link: { from: "org", to: "org" },
						second: {
							kind: "joined",
							to: "doc",
							source: "Share",
							link: { from: "owner", to: "user" },
							field: "doc"
						},
						negated: true
					}
				]
			}
		},
		draws: "",
		reaches: [
			"a filter function's probe of a derived relation",
			"a filter function's probe bound by its argument and a joined source",
			"a precheck calling the filter function"
		]
	},
	{
		note: "a link from Note's doc into Doc's org, Doc's id the tenant's claim: a read by key through the view joins the claimed Doc to Note, and PostgreSQL reads Note through its index on doc at the Doc's org, rechecking no on the note's 54 neighbours, rather than through Note's primary key, which serves the read alone",
		sketch: {
			rows: mostRows,
			world: {
				install: {
					base: docsBase,
					roles: [
						{
							name: "alpha",
							entries: { Org: { kind: "whole", relation: "Org" } },
							write: [],
							refresh: []
						}
					],
					logins: [{ name: "web", roles: ["alpha"] }]
				},
				witnesses: [
					{
						target: "Note",
						source: "Doc",
						link: { from: "doc", to: "org" },
						second: { kind: "claim", to: "id", context: "Tenant", field: "org" },
						negated: false
					}
				]
			}
		},
		draws: "",
		reaches: [
			"a read through a narrowed entry's view calling the filter function",
			"a world function's scan read through another planned index than one serving it alone"
		]
	},
	{
		note: "an entry over Share whose rule fixes user by the session's subject and whose head is doc alone: its view holds no column user, and a read by key through it names doc",
		sketch: {
			rows: mostRows,
			world: {
				install: {
					base: docsBase,
					roles: [
						{
							name: "alpha",
							entries: {
								Doc: { kind: "whole", relation: "Doc" },
								OrgDocs: { kind: "whole", relation: "OrgDocs" },
								View0: {
									kind: "query",
									rules: [
										{
											matches: [
												{
													source: { kind: "ordinary", name: "Share" },
													fields: {
														doc: { kind: "var", name: "v_doc" },
														user: { kind: "var", name: "c_Session_sub" }
													}
												},
												{
													source: { kind: "context", name: "Session" },
													fields: { sub: { kind: "var", name: "c_Session_sub" } }
												}
											],
											negations: [],
											comparisons: [],
											head: { doc: { kind: "var", name: "v_doc" } }
										}
									]
								},
								Share: { kind: "whole", relation: "Share" }
							},
							write: ["Doc", "View0"],
							refresh: []
						}
					],
					logins: [{ name: "web", roles: ["alpha"] }]
				},
				witnesses: [
					{
						target: "Doc",
						source: "OrgDocs",
						link: { from: "org", to: "org" },
						second: { kind: "none" },
						negated: false
					}
				]
			}
		},
		draws: "",
		reaches: [
			"a policy row of a membership reading no other relation",
			"a read through a view whose rule fixes a field of T's key"
		]
	}
]

/** The situations every run reaches (see the header). */
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
	"a read through a narrowed entry's view calling the filter function",
	"a precheck calling the filter function"
]

const populationSuite = (runs: number) => (ctx: TestContext) =>
	searched(
		ctx,
		explore(
			{
				oracle: {
					kind: "postgresql",
					name: "PostgreSQL's serving judge: each world function call reads by its indexes"
				},
				suite: "pg/physical/world-serving",
				draw: drawn(caseGen),
				literal: Formatter.format,
				coverage: required<WorldServingFeature>(requiredSituations, {
					cases: runs,
					sense: notesOnly
				}),
				kept,
				runs,
				shrink: { kind: "bounded", candidates: 24 },
				concurrency: 1,
				steerEvery: 4,
				caseHang
			},
			(c, cx) =>
				Effect.scoped(
					Effect.gen(function* () {
						const problems = yield* judgeCase(c.world, c.rows, cx.note)
						assert.deepEqual(problems, [], "every world function call reads by its indexes")
					})
				)
		)
	)

layer(Substrate.layer)("world functions, judged by PostgreSQL", (it) => {
	it.effect(
		"every world function of generated roles reads by its indexes, over drawn small populations",
		populationSuite(24)
	)
})
