import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record } from "effect"
import { withWorkload } from "#compiler/physical/access/extension.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

/** Access indexes over one column list in several directions ().
 *
 * A B-tree serves its order forward and its exact reverse backward, so an access index's identity is its columns and a
 * direction vector canonical under reversal: the vector whose first key ascends. Each drawn case is a workload of
 * ordered programs over one relation's columns (a, b, id), every order stated in full, each in a drawn direction
 * vector, optionally behind an equality on g, whose direction within the seek is free. The installation:
 *
 * - succeeds, so no two indexes share an identifier;
 * - creates one access index on the relation per class of the drawn vectors under reversal, so a vector and its exact
 *   reverse are one index, and its keys are the class's canonical vector: the first ascends;
 * - names distinct classes distinctly;
 * - serves each program's ordered request from the index of its class, as its vector or its exact reverse.
 *
 * Oracle: the classes, computed from the drawn vectors by reversal alone. */
type Dir = "asc" | "desc"
/** A direction vector over the order's three columns, a, b and id, in that order. */
type Vector = readonly [Dir, Dir, Dir]

const T = relation("T", { id: uuid, g: uuid, a: pg.integer, b: pg.integer }, ["id"])
const Dirs = schema("Dirs", { T }, [])

const opposite = (d: Dir): Dir => (d === "asc" ? "desc" : "asc")
const reversed = (vector: Vector): Vector => [
	opposite(vector[0]),
	opposite(vector[1]),
	opposite(vector[2])
]
/** The class's canonical vector: the first key ascends. */
const canonical = (vector: Vector): Vector => (vector[0] === "asc" ? vector : reversed(vector))
const text = (vector: ReadonlyArray<Dir>): string => Arr.join(vector, " ")

/** The program ordering T by `vector`, behind an equality on g when `prefixed`. */
const program = (vector: Vector, prefixed: boolean) =>
	query(Dirs)
		.rule((r) => {
			const { id, g, a, b } = v(T, "t")
			const matched = r.match(T, { id, g, a, b })
			return (prefixed ? matched.where(r.eq(g, r.param("g", uuid))) : matched).find({ id, a, b })
		})
		.orderBy(["a", vector[0]], ["b", vector[1]], ["id", vector[2]])

const dirGen = element<Dir>(["asc", "desc"])
const vectorGen: Gen<Vector> = (source) =>
	[source.draw(dirGen), source.draw(dirGen), source.draw(dirGen)] as const
/** A family of vectors, each drawn or the exact reverse of an earlier one, and whether every program is prefixed. */
const caseGen: Gen<{ readonly vectors: ReadonlyArray<Vector>; readonly prefixed: boolean }> = (
	source
) => {
	const drawnVectors = source.draw(
		array((source) => [source.draw(vectorGen), source.draw(boolean)] as const, { min: 1, max: 5 })
	)
	return {
		vectors: Arr.map(drawnVectors, ([vector, reverse], i): Vector => {
			const earlier = drawnVectors[i - 1]
			return reverse && earlier !== undefined ? reversed(earlier[0]) : vector
		}),
		prefixed: source.draw(boolean)
	}
}

type DirectionFeature =
	| "an exact reverse pair"
	| "a mixed vector"
	| "an all-descending vector"
	| "two classes"
	| "a prefix"

describe("access indexes over one column list in several directions", () => {
	it.effect(
		"install one index per class under reversal, canonical and distinctly named, serving each order forward or backward",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/physical/index-directions",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<DirectionFeature>(
							[
								"an exact reverse pair",
								"a mixed vector",
								"an all-descending vector",
								"two classes",
								"a prefix"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						/** The rotating stream's sample of 64 vectors in 4 classes per column set, in families of up to five. */
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ vectors, prefixed }, c) =>
						Effect.sync(() => {
							const programs = Record.fromEntries(
								Arr.map(vectors, (vector, i) => [`p${i}`, program(vector, prefixed)])
							)
							const plan = succeeded(
								compileTestWorkload(
									[{ login: "server", workloads: [workload(Dirs, programs)] }],
									Dirs,
									testCompile
								)
							)
							const owned = owning(Dirs)
							const installed = compileInstallation(
								owned,
								withWorkload(installOptions(owned, undefined), plan)
							)
							if (!installed.ok) {
								throw new Error(
									`${Arr.join(Arr.map(vectors, text), " | ")}: ${installed.error.message}`
								)
							}
							/** The indexes created for the ordered programs: those serving a seek. */
							const isSeek = (
								r: (typeof installed.value.indexes)[number]["requests"][number]
							): boolean => r.role === "access" && (r.use === "page seek" || r.use === "take seek")
							const created = Arr.filter(
								installed.value.indexes,
								(i) =>
									i.index.kind === "created" && i.relation === "T" && Arr.some(i.requests, isSeek)
							)
							const classes = new Set(Arr.map(vectors, (vector) => text(canonical(vector))))
							/** The order columns, behind g when prefixed: g's direction is free, so it follows the first ascending key. */
							const orderKeys = (index: (typeof created)[number]) =>
								index.keys.slice(prefixed ? 1 : 0)
							assert.deepEqual(
								new Set(Arr.map(created, (index) => text(Arr.map(orderKeys(index), (k) => k.dir)))),
								classes,
								"one index per class, its keys the canonical vector"
							)
							assert.equal(created.length, classes.size, "no class installs twice")
							assert.equal(
								new Set(Arr.map(created, (index) => index.index.name)).size,
								created.length,
								"distinct names"
							)
							for (const index of created) {
								assert.equal(index.keys[0]?.dir, "asc", "the first key ascends")
								assert.deepEqual(
									Arr.map(orderKeys(index), (k) => k.field),
									["a", "b", "id"]
								)
							}
							for (const vector of vectors) {
								const served = Arr.filter(created, (index) =>
									Arr.some(
										index.requests,
										(r) =>
											isSeek(r) &&
											[text(vector), text(reversed(vector))].includes(
												text(Arr.map(r.keys.slice(prefixed ? 1 : 0), (k) => k.dir))
											)
									)
								)
								assert.deepEqual(
									Arr.map(served, (index) => text(Arr.map(orderKeys(index), (k) => k.dir))),
									[text(canonical(vector))],
									`${text(vector)} is served by its class's index`
								)
							}
							if (
								Arr.some(vectors, (vector) =>
									Arr.some(vectors, (w) => text(w) === text(reversed(vector)))
								)
							) {
								c.note("an exact reverse pair")
							}
							if (Arr.some(vectors, (vector) => new Set(vector).size > 1)) {
								c.note("a mixed vector")
							}
							if (Arr.some(vectors, (vector) => Arr.every(vector, (d) => d === "desc"))) {
								c.note("an all-descending vector")
							}
							if (classes.size > 1) {
								c.note("two classes")
							}
							if (prefixed) {
								c.note("a prefix")
							}
						})
				)
			)
	)
})
