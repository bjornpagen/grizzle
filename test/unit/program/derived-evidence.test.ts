import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Record } from "effect"
import type { ConstraintName } from "#compiler/core/ids.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { changeSetOver as ChangeSet, changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Reporting } from "#test/support/fixtures/api/payroll.ts"
import { AccountBudget, Reports } from "#test/support/fixtures/api/work.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { checking } from "#test/support/policy.ts"

/**
 * A query over a derived relation rests on the view's unique index.
 *
 * A derived relation inherits a key from its definition (analysis/derived), which its installation enforces with a
 * unique index on the view. The optimized artifact of a query over it is annotated under the schema's derived keys
 * (logical/annotate.ts queryEvidence), so a projection of the view that keeps the inherited key is keyed by it, and the
 * proof that the projection delivers no duplicate rests on the view's index, which a certificate of the template names
 * as a premise. Annotated under the
 * checker's evidence alone, the view's Base is keyed by its whole heading, the projection keeps a DISTINCT, and no
 * premise names the index. A ChangeSet's read-back of the same projection is lowered under the same evidence
 * (write/readback/lower.ts), so the compiled write rests it on the same index.
 *
 * The oracle generators draw no derived relation, so the space is exhaustive over the public fixtures' views: Reports'
 * AccountBudget, keyed by account, and Reporting's RunTotal, keyed by run, each projected to its key and every proper
 * subset of its other columns, so every projection drops a column.
 *
 * A view of a fixture schema: the schema, the derived relation and the key it inherits from its definition
 * (test/unit/derived/keys.test.ts derives both).
 */
interface View {
	readonly schema: AnySchema
	readonly relation: { readonly name: ViewName; readonly heading: object }
	readonly key: ReadonlyArray<string>
}

type ViewName = "AccountBudget" | "RunTotal"
type EvidenceFeature = ViewName | "read-back over a view"

const views: Arr.NonEmptyReadonlyArray<View> = [
	{ schema: Reports, relation: AccountBudget, key: ["account"] },
	{ schema: Reporting, relation: Reporting.relations.RunTotal, key: ["run"] }
]

/**
 * The view's unique index on its inherited key, as its schema's installation creates it, and the schema's artifacts,
 * whose names a write compiles under.
 */
interface Installed {
	readonly index: ConstraintName
	readonly artifacts: SchemaArtifacts
}

const installedOf = (view: View): Installed => {
	const artifacts = testArtifacts(view.schema, testCompile)
	if (!artifacts.ok) {
		throw new Error(
			`the schema of ${view.relation.name} has no artifacts: ${artifacts.error.message}`
		)
	}
	return {
		index: installationNamesOf(installationOf(view.schema, { kind: "declared" })).viewKeyIndex(
			view.relation,
			view.key
		),
		artifacts: artifacts.value
	}
}

/** The query over a view's schema that matches the view and finds `columns`. */
const projectionOf = (view: View, columns: ReadonlyArray<string>): unknown =>
	queryOver(view.schema).rule((r: RuleValue) => {
		const vars = varsOver(view.relation, "relation")
		const head = Record.fromEntries(
			Arr.map(columns, (column) => [column, defined(vars[column], `the variable of ${column}`)])
		)
		return r.match(view.relation, vars).find(head)
	})

const shown = (constraints: ReadonlyArray<string>): string =>
	constraints.length === 0 ? "no premise" : Arr.join(constraints, ", ")

/** The columns of a view outside its key. */
const othersOf = (view: View): ReadonlyArray<string> =>
	Arr.filter(Record.keys(view.relation.heading), (column) => !view.key.includes(column))

/**
 * A subset of `items` that leaves at least one out, in their order: its size, smaller first, then each member after
 * the one before, each far enough from the end to leave room for the rest. Every proper subset is one case, smaller
 * subsets first, so an enumeration meets each once and discards none.
 */
const properSubset =
	<A>(items: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	(source) => {
		const size = source.draw(int(0, items.length - 1))
		const kept: Array<A> = []
		let from = 0
		for (let left = size; left > 0; left -= 1) {
			const at = source.draw(int(from, items.length - left))
			kept.push(defined(items[at], `item ${at}`))
			from = at + 1
		}
		return kept
	}

/** Every projection of a view that keeps its key and drops at least one other column. */
const space: Gen<{ readonly view: View; readonly columns: ReadonlyArray<string> }> = (source) => {
	const view = source.draw(element(views))
	const kept = source.draw(properSubset(othersOf(view)))
	return { view, columns: [...view.key, ...kept] }
}

describe("a query over a derived relation", () => {
	it.effect(
		"rests its optimized proof, and a read-back's of it, on the view's unique index",
		(ctx) =>
			Effect.gen(function* () {
				const installed = new Map(Arr.map(views, (view) => [view, installedOf(view)]))
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/program/derived-evidence",
							generator: space,
							literal: Formatter.format,
							/** AccountBudget's three projections and RunTotal's seven. */
							limit: 10,
							coverage: requiredInSpace<EvidenceFeature>([
								"AccountBudget",
								"RunTotal",
								"read-back over a view"
							]),
							caseHang: Duration.minutes(2)
						},
						({ view, columns }, c) =>
							Effect.sync(() => {
								c.note(view.relation.name)
								const { index, artifacts } = defined(
									installed.get(view),
									`the installation of ${view.relation.name}`
								)
								const what = `the projection of ${view.relation.name} to ${Arr.join(columns, ", ")}`
								const template = compileTemplate(
									projectionOf(view, columns),
									view.schema,
									testCompile
								)
								if (!template.ok) {
									throw new Error(`${what} does not compile: ${template.error.message}`)
								}
								const premises = Arr.flatMap(template.value.certificates, (certificate) =>
									Arr.flatMap(certificate.premises, (p) =>
										p.kind === "constraint" ? [p.constraint] : []
									)
								)
								if (!premises.includes(index)) {
									throw new Error(
										`${what} rests on ${shown(premises)}, not on the view's index ${index}`
									)
								}
								/** A ChangeSet whose one read-back is the projection. */
								const readBack = ChangeSet.empty(view.schema).read("projection", () =>
									projectionOf(view, columns)
								)
								const write = compileWrite(
									checking(view.schema),
									defined(changeSetDesc(readBack), "the ChangeSet's Description"),
									{
										names: artifacts.names,
										reads: artifacts.reads,
										claims: { kind: "every" },
										world: { kind: "reality" },
										laws: artifacts.laws,
										derived: artifacts.derived
									}
								)
								if (!write.ok) {
									throw new Error(`a read-back of ${what} does not compile: ${write.error.message}`)
								}
								const cited = Arr.flatMap(write.value.certificates, (certificate) =>
									Arr.flatMap(certificate.premises, (p) =>
										p.kind === "constraint" ? [p.constraint] : []
									)
								)
								if (!cited.includes(index)) {
									throw new Error(
										`a read-back of ${what} rests on ${shown(cited)}, not on the view's index ${index}`
									)
								}
								c.note("read-back over a view")
							})
					)
				)
			})
	)
})
