import { type Case, drawn, explore, type Kept } from "@bjornpagen/testing/explore"
import { type Reached, required } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import type { ShrinkBudget } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, type Scope, String as Str } from "effect"
import { type AmbientSession, grizzleFirstSession, ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { type Family, installFamily, type Mode, populationsOf } from "#test/support/laws/boxes.ts"
import { fromSelected, type HostLaw, type HostSchema } from "#test/support/laws/model.ts"
import {
	exemptReachable,
	type FamilyCase,
	type FamilyFeature,
	familyCaseGen,
	lawShapes,
	plantedRefusal,
	type RefusalFeature,
	refusalFeatures,
	runSteps
} from "#test/support/laws/support.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/** The rotating stream's cases per test. */
export const casesPerTest = 120

/** The most shrink candidates a failure runs (the header says why it is bounded). */
const shrinkCandidates = 300
export const shrink: ShrinkBudget = { kind: "bounded", candidates: shrinkCandidates }

/**
 * Installs a variant for a case, under the ambient session `ambient`: a schema that does not install fails the case that
 * drew it.
 */
export const installVariant = <P>(
	family: Family<P>,
	p: P,
	ambient: AmbientSession
): Effect.Effect<Installed, CaseFailed, Scope.Scope | Substrate> =>
	Effect.mapError(
		installFamily(family, p, ambient),
		(e) => new CaseFailed({ report: `${family.describe(p)} did not install: ${messageOf(e)}` })
	)

/**
 * What a suite requires of each of a family's schemas, beside what it requires of the family, when the schemas differ in
 * the shape of a law (how its sides pair their fields, what kind of value selects): a refusal by every kind of law from
 * a selected side the schema declares (fromSelected), whose lowering to law columns is where the shapes differ; or, for
 * a family whose every law reads its sides through law columns (the partial projections, test/pg/laws/projections), a
 * refusal by every kind of law it declares but a key. Nothing more, when the schemas vary a law's parameters over one
 * shape. Every law is native (fin.md §7), so no refusal but a key's names a fact, and none is required of a stored fact
 * or a new one.
 */
export type Reach =
	| "the family"
	| "every schema's refusals"
	| "every schema's refusals by every law but a key"

/** The pairs a schema's cases must reach under `reach`. */
export const schemaPairs = <P, F extends string>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	featuresOf: (p: P) => ReadonlyArray<F>
): ReadonlyArray<readonly [`schema ${string}` | F, `schema ${string}` | F]> =>
	Arr.flatMap(variants, (p) =>
		Arr.map(featuresOf(p), (f) => [`schema ${family.describe(p)}`, f] as const)
	)

/**
 * A refusal a suite requires: the feature it notes (support.ts refusalFeatures), and the laws whose refusal may note it.
 */
interface Refusal {
	readonly feature: RefusalFeature
	readonly by: (law: HostLaw, host: HostSchema) => boolean
}

/** A refusal a suite requires, and of which schemas: any of the family's, one of them, or any that holds a trait. */
type Requirement =
	| { readonly of: "the family"; readonly refusal: Refusal }
	| { readonly of: "a schema"; readonly variant: number; readonly refusal: Refusal }
	| { readonly of: "a trait"; readonly trait: string; readonly refusal: Refusal }

const ofKind = (kind: HostLaw["kind"]): Refusal => ({
	feature: `refused by a ${kind}`,
	by: (l) => l.kind === kind
})

/** The kinds of the laws a schema declares that `which` holds of, each once. */
const kindsOf = (
	host: HostSchema,
	which: (law: HostLaw) => boolean
): ReadonlyArray<HostLaw["kind"]> => [
	...new Set(Arr.map(Arr.filter(host.laws, which), (l) => l.kind))
]

const selectedKinds = (host: HostSchema): ReadonlyArray<HostLaw["kind"]> =>
	kindsOf(host, fromSelected)

/**
 * The refusals a family's schema must reach under `reach`: by every kind of law from a selected side it declares; or,
 * for a family of laws over law columns alone, by every kind of law it declares but a key.
 */
const schemaRefusals = (host: HostSchema, reach: Reach): ReadonlyArray<Refusal> => {
	switch (reach) {
		case "the family":
			return []
		case "every schema's refusals by every law but a key":
			return Arr.map(
				kindsOf(host, (l) => l.kind !== "key"),
				ofKind
			)
		case "every schema's refusals":
			return Arr.map(selectedKinds(host), ofKind)
	}
}

/**
 * Every refusal a suite requires of a family's schemas under `reach`, the most particular first: for each schema, its
 * refusals (schemaRefusals); for each trait of a schema, a refusal by every kind of law from a selected side that
 * schema declares; and of the family, a refusal by every kind of law its schemas declare, and one showing every shape of
 * law they declare. A refusal beside a partial match is noted only of a key's witness, the one a native refusal names, so
 * none is required.
 */
const requirements = <P>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	reach: Reach
): ReadonlyArray<Requirement> => {
	const hosts = Arr.map(variants, family.host)
	const traits = [...new Set(Arr.flatMap(variants, family.traits))]
	const kinds = [...new Set(Arr.flatMap(hosts, (host) => Arr.map(host.laws, (l) => l.kind)))]
	return [
		...Arr.flatMap(hosts, (host, variant) =>
			Arr.map(schemaRefusals(host, reach), (refusal): Requirement => ({
				of: "a schema",
				variant,
				refusal
			}))
		),
		...Arr.flatMap(traits, (trait) => {
			const bearers = Arr.filter(variants, (p) => family.traits(p).includes(trait))
			const selected = new Set(Arr.flatMap(bearers, (p) => selectedKinds(family.host(p))))
			return Arr.map([...selected], (kind): Requirement => ({
				of: "a trait",
				trait,
				refusal: ofKind(kind)
			}))
		}),
		...Arr.map(kinds, (kind): Requirement => ({ of: "the family", refusal: ofKind(kind) })),
		...Arr.map(
			Arr.filter(lawShapes, (shape) =>
				Arr.some(hosts, (host) => Arr.some(host.laws, (l) => shape.declares(l, host)))
			),
			(shape): Requirement => ({
				of: "the family",
				refusal: { feature: shape.feature, by: shape.declares }
			})
		)
	]
}

/** A requirement as the population must reach it: the refusal's feature, paired with its schema or its trait. */
const reachedOf = <P>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	q: Requirement
): Reached<FamilyFeature> => {
	switch (q.of) {
		case "the family":
			return q.refusal.feature
		case "a schema":
			return [
				`schema ${family.describe(defined(variants[q.variant], "a schema"))}`,
				q.refusal.feature
			]
		case "a trait":
			return [`trait ${q.trait}`, q.refusal.feature]
	}
}

const shown = (r: Reached<FamilyFeature>): string =>
	typeof r === "string" ? r : Arr.join(r, " × ")

/** Whether a case on the schema at `variant` meets a requirement's schemas. */
const meets = <P>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	q: Requirement,
	variant: number
): boolean => {
	switch (q.of) {
		case "the family":
			return true
		case "a schema":
			return variant === q.variant
		case "a trait":
			return family.traits(defined(variants[variant], "a schema")).includes(q.trait)
	}
}

/**
 * A planted case: the kept case, the schema it runs on, and every feature its refusal notes whichever violator its
 * witness names.
 */
interface Planted {
	readonly kept: Kept<FamilyCase, FamilyFeature>
	readonly variant: number
	readonly reaches: ReadonlyArray<RefusalFeature>
}

/**
 * The first case the host model finds (support.ts plantedRefusal) reaching a requirement, on the first schema that meets
 * it and declares a law whose refusal may note it; none when no candidate reaches it.
 */
const plant = <P>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	q: Requirement
): Planted | undefined => {
	const { feature, by } = q.refusal
	for (const [variant, p] of variants.entries()) {
		const host = family.host(p)
		if (!meets(family, variants, q, variant) || !Arr.some(host.laws, (l) => by(l, host))) {
			continue
		}
		const c = plantedRefusal(host, family.domains, (r) =>
			refusalFeatures(host, r).includes(feature)
		)
		if (c === undefined) {
			continue
		}
		const [first, ...rest] = c.refusals
		const reaches = Arr.filter(refusalFeatures(host, first), (f) =>
			Arr.every(rest, (r) => refusalFeatures(host, r).includes(f))
		)
		return {
			kept: {
				note: `${family.describe(p)}: ${feature}`,
				sketch: { variant, steps: [...c.lawful, c.refused] },
				draws: "",
				reaches: [feature, ...Arr.filter(reaches, (f) => f !== feature)]
			},
			variant,
			reaches
		}
	}
	return undefined
}

/**
 * Every requirement planted, in order: each a case planted before it does not reach is planted by the first case the
 * host model finds reaching it. A requirement no candidate reaches fails the suite where it is declared, so the
 * population reaches every requirement in every run, whatever its streams draw.
 */
const plantedRefusals = <P>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	situations: ReadonlyArray<Requirement>
): ReadonlyArray<Planted> => {
	const planted: Array<Planted> = []
	for (const q of situations) {
		if (
			!Arr.some(
				planted,
				(k) => meets(family, variants, q, k.variant) && k.reaches.includes(q.refusal.feature)
			)
		) {
			planted.push(
				defined(
					plant(family, variants, q),
					`a planted case of ${family.label} reaching ${shown(reachedOf(family, variants, q))}`
				)
			)
		}
	}
	return planted
}

/** Each requirement's situation and the planted case that reaches it. */
type Aim = readonly [situation: Reached<FamilyFeature>, planted: FamilyCase]

const aimsOf = <P>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	situations: ReadonlyArray<Requirement>,
	planted: ReadonlyArray<Planted>
): ReadonlyArray<Aim> =>
	Arr.flatMap(situations, (q) =>
		Option.match(
			Arr.findFirst(
				planted,
				(k) => meets(family, variants, q, k.variant) && k.reaches.includes(q.refusal.feature)
			),
			{
				onNone: () => [],
				onSome: (k): ReadonlyArray<Aim> => [[reachedOf(family, variants, q), k.kept.sketch]]
			}
		)
	)

/**
 * The case a case runs: the drawn one, or, where the requirement its turn aims at (Case.steering) is one a planted case
 * reaches, that planted case, so the steered phase reaches every requirement by construction, since a kept case never
 * counts. The cases of one window aim at distinct pending requirements, so none waits behind another. A steered case
 * reads the steering it was drawn under, so it replays alike.
 */
const aimedCase = (
	drawnCase: FamilyCase,
	steering: Case<FamilyFeature>["steering"],
	aims: ReadonlyArray<Aim>
): FamilyCase =>
	Option.match(steering, {
		onNone: () => drawnCase,
		onSome: (pending) =>
			Option.getOrElse(
				Option.map(
					Arr.findFirst(aims, ([situation]) => pending.aimed(situation)),
					([, planted]) => planted
				),
				() => drawnCase
			)
	})

/** A suite's own kept cases, by population: counterexamples its search once found, each replayed in every run. */
export type KeptCases = Readonly<Record<Mode, ReadonlyArray<Kept<FamilyCase, FamilyFeature>>>>

/** No kept case in either population. */
export const noKeptCases: KeptCases = { immutable: [], mutable: [] }

/**
 * One family's generated suite.
 *
 * For each population of the family's box (boxes.ts populationsOf: its schemas with no mutable relation, and those
 * with one), cases explore through the library's explore, each drawing one of the population's schemas and a sequence
 * of steps (../support.ts runSteps).
 * A schema installs once per test, the first time a case draws it. Its writer's connection belongs to the case: each
 * case opens it and closes it when it ends, so a test holds one case's connection whatever the number of schemas it
 * draws. That the installation enforces exactly the host's laws is judged by outcomes alone: every refusal names a law
 * the host knows and that the final state violates, and every law kind must refuse a step.
 *
 * The population must reach steps accepted and left unchanged, and every refusal the suite requires (requirements):
 * a refusal by every kind of law the family declares, and one showing every shape of law it declares (a coverage across
 * renamed fields, into a selected target, a candidate span key over unequal spans, and a selected containment refused
 * after a write of one side alone, a source switched into its selection or its target moved; support.ts lawShapes); for
 * each trait of a schema (boxes.ts traits), a refusal by every kind of law from a selected side that schema declares;
 * and for a family whose schemas differ in the shape of a law, each schema a refusal by every kind of law from a
 * selected side it declares (schemaRefusals). Every requirement is planted (plantedRefusals): a kept case reaches it in every run, since a schema of a
 * family meets only a share of the cases and some refusals only a share of a schema's. Beside them run the suite's own
 * kept cases of the population (`kept`).
 *
 * A failing case shrinks through at most `shrinkCandidates` candidates, each a whole case against the server. A
 * complete shrink is unbounded in time: a failure only some runs of a case reproduce walks it from candidate to
 * candidate, accepting whichever happens to fail.
 */
export const familySuite = <P>(
	family: Family<P>,
	cases: number,
	reach: Reach,
	kept: KeptCases
): void => {
	layer(Substrate.layer, { excludeTestServices: true })(
		`law-bearing generated schemas: ${family.label}`,
		(it) => {
			for (const { mode, variants } of populationsOf(family)) {
				const refusals = requirements(family, variants, reach)
				const planted = plantedRefusals(family, variants, refusals)
				const aims = aimsOf(family, variants, refusals, planted)
				const exempt = Arr.some(variants, (p) => exemptReachable(family.host(p), family.domains))
				const situations: Arr.NonEmptyReadonlyArray<Reached<FamilyFeature>> = [
					"accepted",
					"no-change",
					...(exempt
						? (["accepted beside a source fact no selected containment selects"] as const)
						: []),
					...Arr.map(refusals, (q) => reachedOf(family, variants, q))
				]
				/** The writer's session is the case's: it closes when the case ends. */
				const search = Effect.gen(function* () {
					/**
					 * Every variant's installation, made before the first case; it holds no connection. The mutable
					 * population installs under the installation-first path, the immutable one under the cluster's own.
					 */
					const installs = yield* Effect.forEach(variants, (p) =>
						installVariant(family, p, mode === "mutable" ? grizzleFirstSession : ordinarySession)
					)
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: `laws/${Str.replaceAll(regex("[^a-z0-9]+", "g"), "-")(family.label)}/${mode}`,
							draw: drawn(familyCaseGen(variants.length)),
							literal: Formatter.format,
							coverage: required<FamilyFeature>(situations, { cases: 4 * cases, sense: notesOnly }),
							kept: [...Arr.map(planted, (k) => k.kept), ...kept[mode]],
							runs: cases,
							shrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnCase, c) =>
							Effect.gen(function* () {
								const k = aimedCase(drawnCase, c.steering, aims)
								const p = elementAt(variants, k.variant, "the family's schemas")
								const schemaFeature: FamilyFeature = `schema ${family.describe(p)}`
								const traits = Arr.map(
									family.traits(p),
									(nested): FamilyFeature => `trait ${nested}`
								)
								c.note(schemaFeature)
								for (const nested of traits) {
									c.note(nested)
								}
								/** Each refusal is noted with the schema it ran on, and with each of its traits. */
								const note = (f: FamilyFeature) => {
									c.note(f)
									if (Str.startsWith("refused by a ")(f)) {
										c.pair(schemaFeature, f)
										for (const nested of traits) {
											c.pair(nested, f)
										}
									}
								}
								const installed = elementAt(installs, k.variant, "the family's installations")
								yield* Effect.scoped(
									Effect.flatMap(
										Effect.mapError(
											family.connect(p, installed),
											(e) =>
												new CaseFailed({
													report: `${family.describe(p)} did not connect: ${messageOf(e)}`
												})
										),
										(session) => runSteps(session, family.domains, k.steps, note)
									)
								)
							})
					)
				})
				it.effect(`${mode}: accepted iff every violation query is empty`, (ctx) =>
					searched(ctx, search)
				)
			}
		}
	)
}
