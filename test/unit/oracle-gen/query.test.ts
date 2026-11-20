/**
 * Generated query cases: the conservative-oracle gate's case population.
 *
 * Every case is valid by construction: the schema decodes as a Description, the facts satisfy every declared key and
 * containment under native equality, the DAG validates and is normalized, and every parameter it reads has a value.
 * Ownership accepts every schema, so every key is representable. A configuration that leaves forms out draws none of
 * them. Which forms the population reaches is the gate's own required features
 * (test/pg/oracle/conservative.test.ts), never a share measured here.
 *
 * Normalized: identifiers by first occurrence from the root (test/support/dag.ts normalizeDag).
 *
 * The edges of an acyclic closure pass a strict order filter: src < dst.
 *
 * Oracles: the specification, each claim judged by the engine's own checks (admitSchemaDesc, ownership, the DAG
 * validator, every key and containment over native equality, literalProblem). The validity property requires no
 * feature: which forms the population reaches is the gate's own required features, as above. Features of the
 * configuration properties: a closure under the acyclic configuration.
 */
import { assert, defined, lacks } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, family, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record } from "effect"
import { NodeId } from "#compiler/core/ids.ts"
import { literalProblem } from "#compiler/ir/expr.ts"
import { admitSchemaDesc } from "#compiler/schema/admit.ts"
import { validateDag } from "#test/support/oracle/dag-validate.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { literalRowKey } from "#test/support/oracle/gen/domain.ts"
import { factValues } from "#test/support/oracle/gen/facts.ts"
import { allKeys, keyIndices, relationNamed, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { ownedInput } from "#test/support/policy.ts"
import { acyclic, fits, holds, nodes, plain } from "#test/unit/oracle-gen/query.fixtures.ts"

/**
 * Generated query cases are valid: Description, facts under the laws, a normalized valid DAG, bound parameters.
 *
 * Budget: its suite's count before the conversion (unit/oracle-gen/query-valid: 2000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const generatedQueryCasesAreValidDescriptionFactsUnderTheLawsANormalizedValidDAGBoundParameters =
	property.explore(queryCaseGen(defaultGenConfig), {
		needs: {},
		situations: [],
		check: () => (c) =>
			Effect.sync(() => {
				holds(
					admitSchemaDesc(schemaDesc(c.schema)).ok,
					"the schema Description decodes and its closed relations are admitted",
					c
				)
				/** An admissible schema: ownership accepts it, every key representable. */
				const owned = ownedInput(schemaDesc(c.schema))
				if (!owned.ok) {
					holds(false, `ownership: ${owned.error.message}`, c)
				}
				validateDag(c.query.dag)
				assert.deepEqual(c.query.dag.roots, [c.query.dag.roots[0]])
				const root = c.query.dag.roots[0]
				assert.equal(root.id, NodeId("n#0"))
				assert.deepEqual(
					Arr.sort(Record.keys(c.query.params), Order.String),
					Arr.sort(root.meta.paramDeps, Order.String)
				)
				for (const p of Record.values(c.query.params)) {
					holds(
						p.kind === "scalar"
							? literalProblem(p.value, p.type) === undefined
							: Arr.every(p.rows, (row) => fits(row, p.heading)),
						"every parameter value fits its type",
						c
					)
				}
				const values = factValues(c.facts)
				for (const r of c.schema.relations) {
					const rows = defined(values[r.name], `the facts of ${r.name}`)
					holds(
						Arr.every(rows, (row) => fits(row, r.columns)),
						`every fact of ${r.name} fits its columns`,
						c
					)
					for (const key of allKeys(r)) {
						const cols = keyIndices(r, key)
						holds(
							new Set(Arr.map(rows, (row) => literalRowKey(row, cols))).size === rows.length,
							`${r.name} key ${Arr.join(key, ",")}`,
							c
						)
					}
				}
				for (const k of c.schema.containments) {
					const from = relationNamed(c.schema, k.from.relation)
					const to = relationNamed(c.schema, k.to.relation)
					const targets = new Set(
						Arr.map(defined(values[to.name], `the facts of ${to.name}`), (row) =>
							literalRowKey(row, keyIndices(to, k.to.fields))
						)
					)
					for (const row of defined(values[from.name], `the facts of ${from.name}`)) {
						holds(
							targets.has(literalRowKey(row, keyIndices(from, k.from.fields))),
							`${from.name} is contained`,
							c
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the engine's schema admission, ownership, DAG validation, keys, containments and literal checks"
		},
		budget: { runs: 2000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: `\t\t\treturn norm >= cosineNormMin && norm <= cosineNormMax\n\t\t\t\t? undefined\n\t\t\t\t: \`a vector literal whose native norm lies in the cosine domain [\${cosineNormMin}, \${cosineNormMax}]\``,
				replacement: `\t\t\treturn norm >= cosineNormMin && norm <= cosineNormMax ? \`a vector literal whose native norm lies in the cosine domain [\${cosineNormMin}, \${cosineNormMax}]\` : undefined`,
				why: "Operator mutant (arm-swap) at packages/engine/src/ir/expr.ts:964 in literalProblem: `norm >= cosineNormMin.value && norm <= cosineNormMax.value\n\t\t\t\t? undefined\n\t\t\t\t:` becomes `norm >= cosineNormMin.value && norm <= cosineNormMax.value ? `a vector literal w`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Generated query cases honor a configuration that leaves forms out: the plain configuration draws no node of them and
 * no parameter, and the acyclic one filters every closure's edges.
 *
 * Budget, each member: its suite's count before the conversion (unit/oracle-gen/query-<member>: 300 independent
 * cases and 0 steered, Vitest at grizzle 4ca3036a).
 */
export const generatedQueryCasesHonorAConfigurationThatLeavesFormsOut = family({
	plain: property.explore(queryCaseGen(plain), {
		needs: {},
		situations: [],
		check: () => (c) =>
			Effect.sync(() => {
				for (const n of nodes(c)) {
					lacks(["Recursive", "Intersect", "Difference", "Take", "Attach", "InputSet"], n.kind)
				}
				assert.equal(Record.size(c.query.params), 0)
			}),
		oracle: {
			kind: "specification",
			name: "a configuration that leaves forms out draws no node of them and no parameter"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/categories.generated.ts",
				original: ',\n\t"Sc"',
				replacement: "",
				why: 'Operator mutant 79172ed58c at packages/text/src/regex/categories.generated.ts:28 in <module>: `,  "Sc"` becomes ``; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	}),
	acyclic: property.explore(queryCaseGen(acyclic), {
		needs: {},
		situations: ["closure"] satisfies ReadonlyArray<Reached<"closure">>,
		check: (_, reached: Case<"closure">) => (c) =>
			Effect.sync(() => {
				for (const n of nodes(c)) {
					if (n.kind !== "Recursive") {
						continue
					}
					reached.note("closure")
					const edges = n.base
					if (edges.kind !== "ProjectSet") {
						assert.fail(`a closure's edges are a ${edges.kind}, not a ProjectSet`)
					}
					assert.equal(edges.input.kind, "Filter")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the acyclic configuration filters every closure's edges"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original:
					"\ta === b ||\n\t(a.length === b.length &&\n\t\ta.every((p, i) => {\n\t\t\tconst q = b[i]\n\t\t\treturn q !== undefined && p.source === q.source && p.flags === q.flags\n\t\t}))",
				replacement: "\tfalse",
				why: "Operator mutant (boolean-return) at packages/engine/src/ir/scalar.ts:842 in samePatterns: `a === b ||\n\t(a.length === b.length &&\n\t\ta.every((p, i) => {\n\t\t\tconst q = b[i]\n\t\t` becomes `false`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
})
