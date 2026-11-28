/**
 * A parameter's value of a pattern, delivered against PostgreSQL 19.
 *
 * Notes declares Code, ^[a-z]{1,4}$, on a stored field and no field of Slug, ^[a-z]{1,8}$. A relation parameter's
 * fields of each, and a scalar parameter of each, are delivered as they are bound by the members of the full world's
 * served workload that read them: each is cast to its own pattern domain, which the installation creates for every
 * pattern a served parameter names, whether or not a stored field declares it, so PostgreSQL checks the value as it
 * binds it and nothing on the host does. The oracle restates each pattern over the drawn text: a case some value of
 * which is outside its pattern is refused by PostgreSQL, ReadFailure ParamRejected at stage execute, which a call
 * answers as a `paramRejected` CallError whose `param` is one of the places a value outside its pattern was bound at
 * (the scalar parameter `slug` or `code`, or the relation parameter `rows`'s field `slug` or `code`); every other case
 * delivers exactly the values it bound.
 */

import {
	assert,
	assertVariant,
	deepEquals,
	nonEmpty,
	unorderedEqual
} from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { CallError } from "#compiler/live/index.ts"
import {
	caseGen,
	type Feature,
	isCode,
	isSlug,
	noteId,
	Notes,
	outsideOf,
	patternsInstall,
	patternsTemplate
} from "#test/pg/parameters/pattern.fixtures.ts"
import { bareRecord } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A parameter's pattern no stored field declares, against PostgreSQL 19 a parameter of any pattern is delivered as it is bound, its values checked at bind.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/parameters/pattern.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/parameters/pattern.test.ts` at its budget
 *   before, `{ runs: 60, steered: 60 }`, each kill's verdict printed with where its witnesses went red (judgedLine with
 *   the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by
 *   path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result each of its 2 kills went red on the first case of its floor stream
 * @decision 1, the least a generative search draws, whose floor stream holds that one case; no headroom: a kill its
 *   witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const aParametersPatternNoStoredFieldDeclaresAgainstPostgreSQL19AParameterOfAnyPatternIsDeliveredAsItIsBoundItsValuesCheckedAtBind =
	property.explore(caseGen, {
		needs: { fixture: Substrate.fresh(patternsTemplate) },
		situations: [
			"relation delivered",
			"relation refused at bind",
			"relation refused for a slug alone",
			"scalar delivered",
			"scalar refused at bind",
			"scalar refused for a slug alone"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 1, steered: 60 },
		check:
			({ fixture }, c: CaseOf<Feature>) =>
			(k) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(
								Notes,
								{ Note: [{ id: noteId, code: "abc" }] },
								patternsInstall,
								taken
							)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})

								const rows = k.via === "relation" ? k.rows : k.rows.slice(0, 1)
								const inside = Arr.every(rows, (b) => isSlug(b.slug) && isCode(b.code))
								const slugAlone = Arr.every(rows, (b) => isCode(b.code)) && !inside
								/** The rows the case delivers, as the oracle states them, or its failure. */
								const read: Result.Result<
									ReadonlyArray<Readonly<Record<string, unknown>>>,
									CallError
								> = k.via === "relation"
									? yield* Effect.result(
											rowsOf(
												db.workload.echoed.once({
													params: {
														rows: Arr.map(rows, (b, n) => ({ slug: b.slug, code: b.code, n }))
													},
													facts: {}
												})
											)
										)
									: yield* Effect.result(
											rowsOf(
												db.workload.tagged.once({
													params: {
														slug: Arr.headNonEmpty(nonEmpty(rows, "a bound row")).slug,
														code: Arr.headNonEmpty(nonEmpty(rows, "a bound row")).code
													},
													facts: {}
												})
											)
										)
								if (!inside) {
									if (Result.isSuccess(read)) {
										return assert.fail("a value outside its pattern is refused")
									}
									const failure = read.failure
									assertVariant(failure, "kind", "paramRejected", "refused at bind")
									assert.ok(
										Arr.some(outsideOf(k.via, rows), (place) => deepEquals(place, failure.param)),
										`the refusal names a place bound outside its pattern, not ${Formatter.format(failure.param)}`
									)
									c.note(`${k.via} refused at bind`)
									if (slugAlone) {
										c.note(`${k.via} refused for a slug alone`)
									}
									return
								}
								if (Result.isFailure(read)) {
									return assert.fail(
										`values inside their patterns are delivered: ${read.failure.kind}`
									)
								}
								const delivered: ReadonlyArray<Readonly<Record<string, unknown>>> =
									k.via === "relation"
										? Arr.map(rows, (b, n) => bareRecord({ slug: b.slug, code: b.code, n }))
										: Arr.map(rows, (b) => bareRecord({ id: noteId, slug: b.slug, code: b.code }))
								unorderedEqual(read.success, delivered, "the values as they were bound")
								c.note(`${k.via} delivered`)
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "each pattern restated over the bound text, and the rows delivered as they were bound"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original: '\t\tconst checked = this.paramTypeRef(p.type, { kind: "scalar", name: param })',
				replacement: "\t\tconst checked = this.baseTypeRef(p.type)",
				why: "A scalar parameter's placeholder is cast to its base (lower/conservative/context.ts scalarParam), so no domain checks it."
			},
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original: "\t\tconst domain = this.names.paramDomain(place, regex)",
				replacement:
					"\t\tconst domain = this.names.textDomain(regex) ?? this.names.paramDomain(place, regex)",
				why: "A parameter of a pattern a stored field declares is cast to that field's text domain rather than its own pattern domain (lower/conservative/context.ts paramTypeRef), so PostgreSQL's refusal names the field's domain and is no ParamRejected naming the parameter."
			}
		]
	})
