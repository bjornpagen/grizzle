import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { contractOf, numericTypmodOf, sameScalarType, textOf } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight, statementOutput } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import { plainType, wildcardText } from "#compiler/scalar/compute/types.ts"
import { assert } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { isPlainCarrier } from "#test/support/fixtures/ir/scalar.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { checkedLowering } from "#test/support/oracle/verify/index.ts"

/**
 * The scalar types a lowering states are the registry's: a plain or wildcard-text column of a lowered statement's result
 * heading, whatever node or delivery column introduced it, is the one type of its carrier the registry builds
 * (scalar/compute/types.ts plainType and wildcardText), capabilities included. A type built anywhere else carries an
 * identity no field descriptor decodes to, as a hand-built unit column of the conservative delivery would.
 *
 * Each oracle case (test/support/oracle/gen: plain, attached and heterogeneous-union roots) is lowered conservatively
 * and optimized as the page totality suite lowers its cases (test/unit/page/total.test.ts); a case either lowering
 * refuses is no case: the lowerings are not this property's subject.
 */

type RootFeature = "plain root" | "attached root" | "heterogeneous union"

/** A delivered column of a plain carrier is typed as the registry states the carrier, and wildcard text as the registry's. */
const registryTyped = (column: HeadingColumn): void => {
	const type = column.type
	if (
		isPlainCarrier(type.carrier) &&
		contractOf(type) === undefined &&
		!("serial" in type) &&
		numericTypmodOf(type) === undefined
	) {
		assert.ok(
			sameScalarType(type, plainType(type.carrier)),
			`${column.name}: the registry's ${type.carrier}`
		)
	}
	if (textOf(type)?.regex === "wildcard" && contractOf(type) === undefined) {
		assert.ok(sameScalarType(type, wildcardText), `${column.name}: the registry's wildcard text`)
	}
}

describe("the scalar types of lowered statements", () => {
	it.effect(
		"are the registry's: every plain or wildcard-text result column of both artifacts is its carrier's one type",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/lower/registry-types",
						draw: drawn(
							queryCaseGen({
								...defaultGenConfig,
								query: {
									...defaultGenConfig.query,
									roots: {
										...defaultGenConfig.query.roots,
										plain: 2,
										attach: 2,
										hetero: 4
									}
								}
							})
						),
						/**
						 * The rotating stream's sample, each case lowered twice without a database: the attached and
						 * heterogeneous roots are 2 and 4 of the 8 root weights.
						 */
						runs: 200,
						literal: Formatter.format,
						coverage: required<RootFeature>(
							["plain root", "attached root", "heterogeneous union"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, n) =>
						Effect.gen(function* () {
							const query: LogicalQuery = { dag: c.query.dag, params: genParamDecls(c.query) }
							const names = standInNames("Oracle", schemaCodes(c.schema))
							const conservative = lowerConservative(conservativeInput(query), {
								names,
								params: query.params,
								subject: { kind: "query" }
							})
							if (!conservative.ok) {
								return yield* n.assume(false)
							}
							const catalog = genCatalog(c.schema)
							const optimized = lowerOptimized(query, {
								names,
								context: "snapshot",
								catalog,
								subject: { kind: "query" }
							})
							if (!optimized.ok) {
								return yield* n.assume(false)
							}
							checkedLowering({
								optimized: optimized.value,
								alignment: { kind: "aligned", conservative: conservative.value },
								context: "snapshot",
								catalog
							})
							const root = query.dag.roots[0]
							if (root.kind === "Attach") {
								n.note("attached root")
							} else if (root.kind === "Union" && root.groups.length > 1) {
								n.note("heterogeneous union")
							} else {
								n.note("plain root")
							}
							for (const statement of [
								...flight(conservative.value.roots),
								...flight(optimized.value.roots)
							]) {
								for (const column of statementOutput(statement.role, statement.heading, [])
									.heading) {
									registryTyped(column)
								}
							}
						})
				)
			)
	)
})
