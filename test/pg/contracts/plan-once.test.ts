/**
 * C5, plan once: no statement a call sends names a per-session object, but a carrier's own fill and emptying (laws.ts
 * planOnce). A text that reads a temporary relation or calls a temporary function resolves to another object on every
 * session, so each session's statement is a new one, a new plan and a new pg_stat_statements entry (edullm's assign
 * slot read, replanned at every fresh session). The bound is zero such texts.
 *
 * Oracle: the wire (test/support/wire-tap.ts), every statement text a call parses and binds.
 *
 * Space: drawn shapes (shapes.ts), every one with a write that carries a binding past its first stratum.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { type ContractFeature, contractCase } from "#test/pg/contracts/observed.ts"
import { shapeGen } from "#test/pg/contracts/shapes.ts"
import { planOnce } from "#test/pg/contracts/wire-laws.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** No statement a call sends names a per-session object, but a carrier's own steps. */
export const noStatementACallSendsNamesAPerSessionObject = property.explore(shapeGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: ["a carried binding", "a two-strata write"] satisfies ReadonlyArray<
		Reached<ContractFeature>
	>,
	check:
		({ substrate }, c: Case<ContractFeature>) =>
		(s) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					contractCase(s, c.note, (_, o) => planOnce(o), "no statement names a per-session object")
				),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: { kind: "postgresql", name: "the wire: every statement text a call parses and binds" },
	budget: { runs: 8, steered: 8 },
	show: Formatter.format,
	kept: [],
	kills: []
})
