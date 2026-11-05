import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { type Reached, required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import type { ShrinkBudget } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	type Scope,
	String as Str
} from "effect"
import { type Family, installFamily, populationsOf } from "#test/pg/laws/families/families.ts"
import { type HostLaw, type HostSchema, isResidual, needs } from "#test/pg/laws/families/model.ts"
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
} from "#test/pg/laws/families/support.ts"
import { type AmbientSession, grizzleFirstSession, ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import type { Installed } from "#test/support/install-migrate.ts"
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

/** How long one case may run before the search stops it as hung: a hang, never a slow case. */
export const caseHang = Duration.minutes(2)

/**
 * A family case's time bound, on average over a test's runs: a case is at most eight ChangeSets and the reads that
 * follow each, about 0.2 s alone and 0.4 s under a load average of 40, 3 s at the slowest seen; a case that does not end
 * at all is the hang guard's (caseHang).
 */
const caseMillis = 4_000

/**
 * A test's time bound: every run a search of `runs` rotating cases may make at caseMillis each, its floor stream's
 * quarter as many (at least one) and a failure's shrink candidates among them.
 */
export const timeoutOf = (runs: number): number =>
	(runs + Math.max(1, Math.ceil(runs / 4)) + shrinkCandidates) * caseMillis

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
 * the shape of a law (how its sides pair their fields, what kind of value selects): a refusal by every kind of residual
 * law the schema declares; and, where the shape is in how a law reaches the facts it names, for a law whose witness
 * names a referring fact (a containment's or coverage's source, an obligation's anchor), one naming a stored fact whose
 * counterpart went and one naming a new fact without one. Nothing more, when the schemas vary a law's parameters over
 * one shape.
 */
export type Reach =
	| "the family"
	| "every schema's refusals"
	| "every schema's refusals of stored and new facts"

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

/** Whether a residual law pairs several fields, so a fact can meet its witness in part. */
const pairsSeveral = (l: HostLaw): boolean =>
	isResidual(l) && Arr.some(needs(l), ({ from }) => from.fields.length > 1)

const residualKinds = (host: HostSchema): ReadonlyArray<HostLaw["kind"]> => [
	...new Set(Arr.map(Arr.filter(host.laws, isResidual), (l) => l.kind))
]

/**
 * The refusals a family's schema must reach under `reach`: by every kind of residual law it declares, and of stored
 * and new facts for those whose witness names a referring fact.
 */
const schemaRefusals = (host: HostSchema, reach: Reach): ReadonlyArray<Refusal> =>
	reach === "the family"
		? []
		: Arr.flatMap(residualKinds(host), (kind): ReadonlyArray<Refusal> => {
				const by = ofKind(kind).by
				return kind === "capacity" || reach === "every schema's refusals"
					? [ofKind(kind)]
					: [
							{ feature: `refused by a ${kind} of a stored fact`, by },
							{ feature: `refused by a ${kind} of a new fact`, by }
						]
			})

/**
 * Every refusal a suite requires of a family's schemas under `reach`, the most particular first: for each schema, its
 * refusals (schemaRefusals); for each trait of a schema, a refusal by every kind of residual law that schema declares;
 * and of the family, a refusal by every kind of law its schemas declare, one showing every shape of law they declare,
 * and under a reach beyond the family, one beside a partial match by every kind of residual law that pairs several
 * fields.
 */
const requirements = <P>(
	family: Family<P>,
	variants: ReadonlyArray<P>,
	reach: Reach
): ReadonlyArray<Requirement> => {
	const hosts = Arr.map(variants, family.host)
	const traits = [...new Set(Arr.flatMap(variants, family.traits))]
	const kinds = [...new Set(Arr.flatMap(hosts, (host) => Arr.map(host.laws, (l) => l.kind)))]
	const partial =
		reach === "the family"
			? []
			: [
					...new Set(
						Arr.flatMap(hosts, (host) =>
							Arr.map(Arr.filter(host.laws, pairsSeveral), (l) => l.kind)
						)
					)
				]
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
			const residual = new Set(Arr.flatMap(bearers, (p) => residualKinds(family.host(p))))
			return Arr.map([...residual], (kind): Requirement => ({
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
		),
		...Arr.map(partial, (kind): Requirement => ({
			of: "the family",
			refusal: {
				feature: `refused by a ${kind} beside a partial match`,
				by: (l) => l.kind === kind && pairsSeveral(l)
			}
		}))
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
 * The case a case runs: the drawn one, or, where the case's steering leaves a requirement pending, the planted case
 * that reaches it, so the steered phase reaches every requirement by construction, since a kept case never counts. A
 * steered case reads the steering it was drawn under, so it replays alike.
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
					Arr.findFirst(aims, ([situation]) => pending.has(situation)),
					([, planted]) => planted
				),
				() => drawnCase
			)
	})

/**
 * One family's generated suite.
 *
 * For each population of the family's box (families.ts populationsOf: its schemas with no mutable relation, and those
 * with one), cases explore through the library's explore, each drawing one of the population's schemas and a sequence
 * of steps (../support.ts runSteps).
 * A schema installs once per test, the first time a case draws it. Its writer's connection belongs to the case: each
 * case opens it and closes it when it ends, so a test holds one case's connection whatever the number of schemas it
 * draws. That the installation enforces exactly the host's laws is judged by outcomes alone: every refusal names a law
 * the host knows and that the final state violates, and every law kind must refuse a step.
 *
 * The population must reach steps accepted and left unchanged, and every refusal the suite requires (requirements):
 * a refusal by every kind of law the family declares, and one showing every shape of law it declares (a coverage across
 * renamed fields, into a selected target, a candidate span key over unequal spans, two residual laws keying one
 * relation apart; support.ts lawShapes); for each trait of a schema (families.ts traits), a refusal by every kind of
 * residual law that schema declares; and for a family whose schemas differ in the shape of a law, each schema a refusal
 * by every kind of residual law it declares (of a stored fact and of a new one, where the shape is in how a law reaches
 * the facts it names), and the family a refusal beside a partial match by every residual law that pairs several
 * fields. Every requirement is planted (plantedRefusals): a kept case reaches it in every run, since a schema of a
 * family meets only a share of the cases and some refusals only a share of a schema's.
 *
 * A failing case shrinks through at most `shrinkCandidates` candidates, each a whole case against the server. A
 * complete shrink is unbounded in time: a failure only some runs of a case reproduce walks it from candidate to
 * candidate, accepting whichever happens to fail. The test's timeout follows from the same budget: every run it may
 * make, its streams' cases and a failure's candidates, at a family case's time bound (caseMillis).
 */
export const familySuite = <P>(family: Family<P>, cases: number, reach: Reach): void => {
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
					...(exempt ? (["accepted beside an anchor no obligation selects"] as const) : []),
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
							suite: `laws/${Str.replaceAll(regex("[^a-z0-9]+", "g"), "-")(family.label)}/${mode}`,
							draw: drawn(familyCaseGen(variants.length)),
							literal: Formatter.format,
							coverage: required<FamilyFeature>(situations, { cases: 4 * cases, sense: notesOnly }),
							kept: Arr.map(planted, (k) => k.kept),
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
				it.effect(
					`${mode}: accepted iff every violation query is empty`,
					(ctx) => searched(ctx, search),
					timeoutOf(cases)
				)
			}
		}
	)
}
