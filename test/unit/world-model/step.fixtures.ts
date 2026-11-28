/** What the properties of step.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { sameValues } from "#test/support/laws/model.ts"
import { asDrafted, compile } from "#test/support/migrate/kit.ts"
import { baseBuild } from "#test/support/worlds/execute/build.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { knownNonEmpty, sameDomain } from "#test/support/worlds/generate/domain.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import { actionKinds, type Weights, weightsGen } from "#test/support/worlds/generate/weights.ts"
import { takenIdentity } from "#test/support/worlds/invalid/migrations.ts"
import { docsBase, docsInstall, docsWorlds } from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { type FolderFile } from "#test/support/worlds/model/session/migrate.ts"
import { observedNext } from "#test/support/worlds/model/step.ts"
import {
	type ActionKind,
	type ActionOutcome,
	type BaseSpec,
	type Branch,
	type HostFact,
	type HostState,
	type InstallSpec,
	installSpec,
	type LawSpec,
	type RelationSpec,
	type Term
} from "#test/support/worlds/model/types.ts"

export type StepFeature =
	| `step:${ActionKind}`
	| "rows compared as keyed sets"
	| "read-backs compared as keyed sets"

export const stepFeatures: Arr.NonEmptyReadonlyArray<StepFeature> = [
	...Arr.map(actionKinds, (k): StepFeature => `step:${k}`),
	"rows compared as keyed sets",
	"read-backs compared as keyed sets"
]

/** The longest walk a case takes. */
export const depth = 16

export const names = installedNames(docsInstall)

const host = hostSchemaOf(docsBase, names)

/** Facts with their first fact repeated after them: what a delivery that repeats a row shows. */
const repeatingFirst = (facts: ReadonlyArray<HostFact>): ReadonlyArray<HostFact> =>
	facts.concat(facts.slice(0, 1))

/**
 * Rows as keyed sets, as the real system shows them: the branch agrees with its rows reordered, and not with a
 * row repeated or a row gone.
 */
export const checkRowsAsKeyedSets = (
	b: Branch,
	shown: Extract<ActionOutcome, { readonly kind: "rows" }>
): void => {
	assert.ok(
		observedNext(b, { kind: "rows", rows: Arr.reverse([...shown.rows]) }) !== undefined,
		"rows reordered agree"
	)
	const [gone, ...kept] = shown.rows
	if (gone === undefined) {
		return
	}
	assert.ok(
		observedNext(b, { kind: "rows", rows: repeatingFirst(Arr.reverse([...shown.rows])) }) ===
			undefined,
		"rows repeating a row do not agree"
	)
	if (!Arr.some(kept, (r) => sameValues(r, gone))) {
		assert.ok(
			observedNext(b, { kind: "rows", rows: kept }) === undefined,
			"rows missing a fact do not agree"
		)
	}
}

/**
 * Read-backs as keyed sets, as the real system shows them: the branch agrees with no read-back that repeats a
 * row of its rows, of its inserted delta or of its deleted delta. Whether any was checked.
 */
export const checkReadBacksAsKeyedSets = (
	b: Branch,
	shown: Extract<ActionOutcome, { readonly kind: "applied" }>
): boolean => {
	const sites = Arr.flatMap(shown.reads, (r, i) =>
		Arr.map(
			[
				...(r.rows.length > 0 ? [{ ...r, rows: repeatingFirst(r.rows) }] : []),
				...(r.delta.inserted.length > 0
					? [{ ...r, delta: { ...r.delta, inserted: repeatingFirst(r.delta.inserted) } }]
					: []),
				...(r.delta.deleted.length > 0
					? [{ ...r, delta: { ...r.delta, deleted: repeatingFirst(r.delta.deleted) } }]
					: [])
			],
			(repeated) => Arr.map(shown.reads, (other, j) => (j === i ? repeated : other))
		)
	)
	for (const reads of sites) {
		assert.ok(
			observedNext(b, { ...shown, reads }) === undefined,
			"a read-back repeating a row does not agree"
		)
	}
	return sites.length > 0
}

/** A walk's start: a reality of the docs base, and the swarm weights its actions are drawn under. */
interface Walk {
	readonly reality: HostState
	readonly weights: Weights
}

export const walkGen: Gen<Walk> = (source) => ({
	reality: source.draw(realityGen(docsBase, host)),
	weights: source.draw(weightsGen)
})

/**
 * The laws a migration may add to a base, each one PostgreSQL enforces itself: a key over a field outside a one-field
 * primary key, a check that an integer field is not negative, a containment of a field in another relation's one-field
 * key of its domain; the draw keeps those of an identity the base does not hold (takenIdentity).
 */
const nativeLaws = (base: BaseSpec): ReadonlyArray<LawSpec> => [
	...Arr.flatMap(base.relations, (r) =>
		Arr.map(
			Arr.filter(r.fields, (f) => !r.key.includes(f.name) || r.key.length > 1),
			(f): LawSpec => ({ kind: "key", relation: r.name, fields: [f.name] })
		)
	),
	...Arr.flatMap(base.relations, (r) =>
		Arr.flatMap(r.fields, (f): ReadonlyArray<LawSpec> =>
			f.domain.kind === "integer"
				? [
						{
							kind: "check",
							name: `Counted${r.name}${f.name}`,
							relation: r.name,
							predicate: { kind: "compare", field: f.name, op: ">=", value: 0 }
						}
					]
				: []
		)
	),
	...Arr.flatMap(base.relations, (s) =>
		Arr.flatMap(s.fields, (f) =>
			Arr.flatMap(base.relations, (t: RelationSpec): ReadonlyArray<LawSpec> => {
				const [key, ...more] = t.key
				const target = Arr.findFirst(t.fields, (g) => g.name === key)
				return t.name === s.name ||
					more.length > 0 ||
					Option.isNone(target) ||
					!sameDomain(target.value.domain, f.domain)
					? []
					: [
							{
								kind: "contained",
								source: { relation: s.name, fields: [f.name], where: {} },
								target: { relation: t.name, fields: [target.value.name], where: {} }
							}
						]
			})
		)
	)
]

/** The phase a folder file's name carries (`NN-<phase>.sql`): Setup's setup, the concurrent indexes' indexes, and so on. */
export const phaseOf = (file: FolderFile): string => {
	switch (file) {
		case "setup":
			return "setup"
		case "structure":
			return "structure"
		case "indexes":
		case "concurrent":
			return "indexes"
		case "validate":
			return "validate"
		case "publish":
			return "publish"
	}
}

export type FolderFeature =
	| "worlds change"
	| "no worlds change"
	| "a new law"
	| "a world object created again and no Publish file"
	| "the stranger holds another relation"

/** alpha's query view of Doc's org, its document matched by `id`, under a session or not. */
const alphaOver = (id: Term, session: boolean): InstallSpec =>
	installSpec({
		base: docsInstall.base,
		roles: [
			{
				name: "alpha",
				entries: {
					View0: {
						kind: "query",
						rules: [
							{
								matches: [
									{
										source: { kind: "ordinary", name: "Doc" },
										fields: { org: { kind: "var", name: "v_org" }, id }
									},
									...(session
										? [{ source: { kind: "context", name: "Session" }, fields: {} } as const]
										: [])
								],
								negations: [],
								comparisons: [],
								head: { org: { kind: "var", name: "v_org" } }
							}
						]
					}
				},
				write: []
			}
		],
		logins: [{ name: "web", roles: ["alpha"] }]
	})

/**
 * A migration that creates a role's query view again and changes nothing else it grants: alpha's view of Doc reads one
 * literal document where it read any under a session, its columns and its grants the same, so Structure drops the view,
 * creates it again and grants it right there, and no Publish file follows (the kept case over the derived OrgDocs it
 * replaces, which the worlds model no longer has).
 */
export const viewCreatedAgain: { readonly from: InstallSpec; readonly to: InstallSpec } = {
	from: alphaOver({ kind: "var", name: "v_doc" }, true),
	to: alphaOver({ kind: "literal", value: "5eeda101-7c3e-4a1b-9d2f-0e5c7a9b3d1f" }, false)
}

/**
 * A migration that moves the stranger's one entry (model/types.ts installSpec, whole over its base's first relation): the
 * documents base's README-shaped worlds to the same worlds over the base with Doc listed first, so the stranger, an
 * ordinary role of both, holds Doc whole where it held Org, and nothing else changes; folderFiles predicts its folder from
 * the stranger's world objects and grants as from any role's.
 */
export const strangerMoved: { readonly from: InstallSpec; readonly to: InstallSpec } = {
	from: docsInstall,
	to: installSpec({
		...docsWorlds,
		base: {
			...docsBase,
			relations: [
				Option.getOrThrowWith(
					Arr.findFirst(docsBase.relations, (r) => r.name === "Doc"),
					() => new Error("the documents base declares Doc")
				),
				...Arr.filter(docsBase.relations, (r) => r.name !== "Doc")
			]
		}
	})
}

/**
 * The laws the docs base does not hold that the law model discharges natively once added, read off the compiled schema:
 * a containment the rule judge holds (laws/model/plan.ts containmentDischarge: immutable relations joined within one
 * unit, into a target with a field the key does not reference), Share's document into Org's id, is a rule, which the
 * worlds model, every law of it native, does not model. The base's installs keep its relations' mutability, so the laws
 * native over the base are native over each.
 */
const addedNative: ReadonlyArray<LawSpec> = Arr.filter(
	nativeLaws(docsBase),
	(law) =>
		!takenIdentity(docsBase, law) &&
		!Arr.some(
			compile(
				Effect.runSync(
					Effect.orDie(
						baseBuild({ ...docsInstall, base: { ...docsBase, laws: [...docsBase.laws, law] } })
					)
				).base,
				asDrafted
			).laws.rules,
			(r) => r.rule.kind === "whole"
		)
)

/** A migration from one installation over the docs base: to another of its installations, or with one native law added. */
export const migrationGen: Gen<{ readonly from: InstallSpec; readonly to: InstallSpec }> = (
	source
) => {
	const from = source.draw(installGen(docsBase))
	const to = source.draw(
		oneOf([
			installGen(docsBase),
			map(
				element(knownNonEmpty(addedNative, "the native laws the docs base does not hold")),
				(law): InstallSpec => ({ ...from, base: { ...from.base, laws: [...from.base.laws, law] } })
			)
		])
	)
	return { from, to }
}
