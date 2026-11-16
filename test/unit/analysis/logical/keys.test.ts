/**
 * Keys the logical analysis proves, each property's own documentation beside its search:
 *
 * - Minimal keys (logical/closure.ts minimalKeys): from the whole heading alone, closed under the exchange of a
 *   dependency's determined columns for its determinants, every minimal key of a drawn dependency table is found.
 *   Oracle: every column set's closure by brute force.
 * - Class keys (logical/props.ts finish): k classes of equal columns are one key, its members every other column of
 *   each class, not 2^k keys. Oracle: the classes the filter states, as a specification.
 * - Union class keys (logical/props.ts unionProps): two columns equal in every arm are equal in the union, and a key
 *   of the union is closed under them. Oracle: each arm's partition, intersected.
 * - Forged union equalities (test/support/keys/kernel.ts): the key kernel accepts an arms witness only when each
 *   arm's derivation steps by equalities alone. Oracle: that rule.
 *
 * Features: one or several minimal keys and a key of several columns; each class shape and projection; each arm's
 * copies and equalities; each forged mapping.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type Dependency,
	equalColumns,
	implication,
	keyIn,
	type KeyProof,
	projectionCloses
} from "#compiler/ir/keys.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import { minimalKeys } from "#compiler/logical/closure.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { Ir } from "#test/support/fixtures/ir/build.ts"
import { workModel } from "#test/support/fixtures/ir/work.ts"
import { KeyKernel } from "#test/support/keys/kernel.ts"
import {
	classedGen,
	type ClassFeature,
	type ForgeFeature,
	ghost,
	int4,
	type KeysFeature,
	mappingsGen,
	partition,
	tableGen,
	unionCaseGen,
	type UnionFeature
} from "#test/unit/analysis/logical/keys.fixtures.ts"

/**
 * Minimal keys are exactly the table's minimal keys, every one found from the whole heading.
 *
 * Budget: 500 runs and 500 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/keys.test.ts:102 at 8cad5bce, its runs and its coverage's cases).
 */
export const minimalKeysAreExactlyTheTablesMinimalKeysEveryOneFoundFromTheWholeHeading =
	property.explore(tableGen, {
		needs: {},
		budget: { runs: 500, steered: 500 },
		situations: [
			"one minimal key",
			"several minimal keys",
			"a minimal key of several columns"
		] satisfies ReadonlyArray<Reached<KeysFeature>>,
		check: (_, c: Case<KeysFeature>) => (table) =>
			Effect.sync(() => {
				const columns = Arr.map(indices(table.width), (i) => `c${i}`)
				const of = (mask: number) =>
					Arr.flatMap([...columns.entries()], ([i, column]) =>
						(mask & (1 << i)) !== 0 ? [column] : []
					)
				const dependencies = Arr.map(table.dependencies, (d) => ({
					from: of(d.from),
					to: of(d.to)
				}))
				/** The closure of a column set: every column a chain of dependencies reaches from it. */
				const closure = (start: ReadonlyArray<string>): ReadonlySet<string> => {
					const known = new Set(start)
					let changed = true
					while (changed) {
						changed = false
						for (const d of dependencies) {
							if (Arr.every(d.from, (x) => known.has(x))) {
								for (const x of d.to) {
									if (!known.has(x)) {
										known.add(x)
										changed = true
									}
								}
							}
						}
					}
					return known
				}
				const isKey = (set: ReadonlyArray<string>) => closure(set).size === columns.length
				const keyMasks = Arr.filter([...indices(2 ** table.width)], (mask) => isKey(of(mask)))
				/** A key with no proper subset a key, ordered by size and then heading position. */
				const keyOrder = Order.combine(
					Order.mapInput(Order.Number, (key: ReadonlyArray<string>) => key.length),
					Arr.makeOrder(Order.mapInput(Order.Number, (column: string) => columns.indexOf(column)))
				)
				const oracle = Arr.sort(
					Arr.map(
						Arr.filter(
							keyMasks,
							(mask) => !Arr.some(keyMasks, (other) => other !== mask && (other & mask) === other)
						),
						of
					),
					keyOrder
				)
				c.note(oracle.length > 1 ? "several minimal keys" : "one minimal key")
				if (Arr.some(oracle, (key) => key.length > 1)) {
					c.note("a minimal key of several columns")
				}
				const exchange = Arr.map(dependencies, (d) => ({ from: d.from, to: new Set(d.to) }))
				assert.deepEqual(
					Arr.map(
						minimalKeys(columns, [columns], (cs) => (isKey(cs) ? true : undefined), exchange),
						(k) => k.key
					),
					oracle
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "every column set's closure by brute force, the sets that determine the heading with no proper subset that does"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/logical/keys.test.ts#minimalKeysAreExactlyTheTablesMinimalKeysEveryOneFoundFromTheWholeHeading:-:3.3.8.6.3.b.4.a"
				),
				reason: "the exchange missed a key the heading does not minimize to",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/logical/closure.ts",
				original:
					"\tfor (const { key } of found) {\n\t\tfor (const d of dependencies) {\n\t\t\tadd([...d.from, ...key.filter((c) => !d.to.has(c))])\n\t\t}\n\t}\n",
				replacement: "",
				why: "No exchange after the heading's minimization (logical/closure.ts minimalKeys); the minimal keys property fails."
			}
		]
	})

/**
 * Keys over classes of equal columns are one key for k pairs of equal columns, never 2^k: each class's first column,
 * the others its members.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/keys.test.ts:236 at 8cad5bce, its runs and its coverage's cases).
 */
export const keysOverClassesOfEqualColumnsAreOneKeyForKPairsOfEqualColumnsNever2KEachClasssFirstColumnTheOthersItsMembers =
	property.explore(classedGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"eight or more classes of several columns",
			"a class of three columns",
			"a column of no other's class",
			"a projection dropping a class's first column"
		] satisfies ReadonlyArray<Reached<ClassFeature>>,
		check: (_, c: Case<ClassFeature>) => (drawnCase) =>
			Effect.sync(() => {
				/** Class i's columns c<i>_<j>, in the order the filter chains them. */
				const classes = Arr.map(drawnCase.sizes, (size, i) =>
					Arr.map(indices(size), (j) => `c${i}_${j}`)
				)
				const declared = Arr.flatten(classes)
				const position = (column: string) =>
					defined(drawnCase.positions[declared.indexOf(column)], "a column's position")
				const heading = Arr.sort(
					declared,
					Order.combine(
						Order.mapInput(Order.Number, position),
						Order.mapInput(Order.Number, (column: string) => declared.indexOf(column))
					)
				)
				const several = Arr.filter(classes, (members) => members.length > 1)
				if (several.length >= 8) {
					c.note("eight or more classes of several columns")
				}
				if (Arr.some(classes, (members) => members.length === 3)) {
					c.note("a class of three columns")
				}
				if (Arr.some(classes, (members) => members.length === 1)) {
					c.note("a column of no other's class")
				}
				const q = new Ir(workModel())
				const rows = q.input(
					"rows",
					Arr.map(heading, (column) => [column, int4] as const)
				)
				const equalities = Arr.flatMap(several, (members) =>
					Arr.map(Arr.zip(members, Arr.drop(members, 1)), ([x, y]) =>
						q.eq(q.col(rows, x), q.col(rows, y))
					)
				)
				const [firstEquality, ...laterEqualities] = equalities
				const pred =
					firstEquality === undefined
						? undefined
						: Arr.reduce(laterEqualities, firstEquality, (all: ScalarExpr, e) =>
								q.op("and", [all, e])
							)
				const filtered = pred === undefined ? rows : q.filter(rows, pred)
				/** The projection keeps the columns drawn kept, and each class's first column in declaration order. */
				const keptColumns = Arr.filter(
					heading,
					(column) =>
						defined(drawnCase.kept[declared.indexOf(column)], "a column's kept draw") ||
						Arr.some(classes, (members) => members[0] === column)
				)
				const root = drawnCase.projected
					? q.project(
							filtered,
							Arr.map(keptColumns, (column) => [column, column] as const),
							conservativeMeta
						)
					: filtered
				const built = q.build(root)
				const analysis = succeeded(analyzeLogical(built.dag, checkerEvidence))
				const kernel = new KeyKernel(analysis.dag, {
					keyedViews: false
				})
				const check = (at: RelNode, columns: ReadonlyArray<string>) => {
					const { props } = analysis.of(at)
					/** Each class's columns the node has, in its heading order. */
					const present = Arr.filter(
						Arr.map(classes, (members) =>
							Arr.filter(columns, (column) => members.includes(column))
						),
						Arr.isReadonlyArrayNonEmpty
					)
					assert.equal(
						props.keys.length,
						1,
						`one key over ${present.length} classes of ${columns.length} columns, not ${Arr.reduce(present, 1, (n, members) => n * members.length)}`
					)
					const [key] = props.keys
					const proof = defined(key, "the one key")
					assert.deepEqual(
						proof.key,
						Arr.filter(columns, (column) => Arr.some(present, (members) => members[0] === column)),
						"the key is each class's first column in heading order"
					)
					assert.deepEqual(
						Arr.sort(
							Arr.map(proof.members, (m) => `${m.of}->${m.column}`),
							Order.String
						),
						Arr.sort(
							Arr.flatMap(present, ([first, ...others]) =>
								Arr.map(others, (other) => `${first}->${other}`)
							),
							Order.String
						),
						"its members are every other column of its classes, each standing for its class's first"
					)
					assert.deepEqual(kernel.check(proof), [], "the key kernel accepts the proof")
				}
				check(filtered, heading)
				if (drawnCase.projected) {
					const dropsFirst = Arr.some(several, (members) =>
						Option.exists(
							Arr.findFirst(heading, (column) => members.includes(column)),
							(first) => !keptColumns.includes(first)
						)
					)
					if (dropsFirst) {
						c.note("a projection dropping a class's first column")
					}
					check(root, keptColumns)
				}
			}),
		oracle: {
			kind: "specification",
			name: "one key, each class's first column in heading order, its members every other column of its class"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\tconst classes = classesIn(columns, forest)",
				replacement: "\tconst classes = classesIn(columns, forestOf(columns, []))",
				why: "Every column its own class (logical/props.ts finish); the class keys property fails."
			}
		]
	})

/**
 * Keys of a union are closed under the columns every arm makes equal, and only those.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/keys.test.ts:476 at 8cad5bce, its runs and its coverage's cases).
 */
export const keysOfAUnionAreClosedUnderTheColumnsEveryArmMakesEqualAndOnlyThose = property.explore(
	unionCaseGen,
	{
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"an equality every arm holds",
			"an equality some arm lacks",
			"an equality every arm holds by copying one column",
			"an equality every arm holds by its filter",
			"an equality every arm holds through its group",
			"three arms"
		] satisfies ReadonlyArray<Reached<UnionFeature>>,
		check: (_, c: Case<UnionFeature>) => (drawnCase) =>
			Effect.sync(() => {
				const columns = Arr.map(indices(drawnCase.width), (j) => `c${j}`)
				const name = (j: number) => defined(columns[j], "a column")
				const q = new Ir(workModel())
				/** Per arm, the input column each output copies, and the classes of its outputs. */
				const arms = Arr.map(drawnCase.arms, (arm, i) => {
					const copyOf = (j: number) => defined(arm.copies[j], "a copy draw") % (j + 1)
					const pairs = Arr.filter(arm.equalities, ([x, y]) => x !== y)
					const inputClass = partition(drawnCase.width, pairs)
					const classOf = (j: number) => inputClass(copyOf(j))
					const rows = q.input(
						`rows${i}`,
						Arr.map(columns, (column) => [column, int4] as const)
					)
					const equalities = Arr.map(pairs, ([x, y]) =>
						q.eq(q.col(rows, name(x)), q.col(rows, name(y)))
					)
					const [firstEquality, ...laterEqualities] = equalities
					const filtered =
						firstEquality === undefined
							? rows
							: q.filter(
									rows,
									Arr.reduce(laterEqualities, firstEquality, (all: ScalarExpr, e) =>
										q.op("and", [all, e])
									)
								)
					const grouped = arm.grouped
						? q.group(filtered, columns, columns, [], conservativeMeta)
						: filtered
					const node = q.project(
						grouped,
						[
							["tag", q.lit(i, int4)],
							...Arr.map(indices(drawnCase.width), (j) => [name(j), name(copyOf(j))] as const)
						],
						conservativeMeta
					)
					return { node, copyOf, classOf }
				})
				if (arms.length > 2) {
					c.note("three arms")
				}
				const union = q.union(
					Arr.map(arms, (a) => a.node),
					[],
					conservativeMeta
				)
				const everyArm = (x: number, y: number) =>
					Arr.every(arms, (a) => a.classOf(x) === a.classOf(y))
				for (const x of indices(drawnCase.width)) {
					for (const y of indices(drawnCase.width)) {
						if (x >= y) {
							continue
						}
						if (everyArm(x, y)) {
							c.note("an equality every arm holds")
							if (Arr.every(arms, (a) => a.copyOf(x) === a.copyOf(y))) {
								c.note("an equality every arm holds by copying one column")
							}
							if (Arr.every(arms, (a) => a.copyOf(x) !== a.copyOf(y))) {
								c.note("an equality every arm holds by its filter")
								if (Arr.every(drawnCase.arms, (a) => a.grouped)) {
									c.note("an equality every arm holds through its group")
								}
							}
						} else if (Arr.some(arms, (a) => a.classOf(x) === a.classOf(y))) {
							c.note("an equality some arm lacks")
						}
					}
				}
				const analysis = succeeded(analyzeLogical(q.build(union).dag, checkerEvidence))
				const kernel = new KeyKernel(analysis.dag, {
					keyedViews: false
				})
				const { props } = analysis.of(union)
				assert.ok(props.keys.length > 0, "the union is keyed by tag and its columns")
				const index = (column: string) => columns.indexOf(column)
				for (const proof of props.keys) {
					assert.deepEqual(kernel.check(proof), [], "the key kernel accepts the union's key")
					assert.deepEqual(
						Arr.sort(
							Arr.map(proof.members, (m) => `${m.of}->${m.column}`),
							Order.String
						),
						Arr.sort(
							Arr.flatMap(proof.key, (k) =>
								Arr.flatMap(columns, (o) =>
									k !== "tag" && o !== k && everyArm(index(k), index(o)) ? [`${k}->${o}`] : []
								)
							),
							Order.String
						),
						"its members are exactly the columns equal to a key column in every arm"
					)
					for (const k of proof.key) {
						for (const o of Arr.filter(
							columns,
							(o) => o !== k && k !== "tag" && everyArm(index(k), index(o))
						)) {
							const swapped = Arr.map(proof.key, (x) => (x === k ? o : x))
							assert.ok(
								keyIn(proof, (x) => swapped.includes(x)) !== undefined,
								`[${Arr.join(swapped, ", ")}] is a key by the class of [${Arr.join(proof.key, ", ")}]`
							)
							const direct = defined(
								props.prove(swapped),
								`the union proves [${Arr.join(swapped, ", ")}]`
							)
							assert.deepEqual(kernel.check(direct), [], "the key kernel accepts it")
						}
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "each arm's outputs partitioned by their copies and equalities, the arms' partitions intersected"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/logical/keys.test.ts#keysOfAUnionAreClosedUnderTheColumnsEveryArmMakesEqualAndOnlyThose:-:0.2.0.0.0.0.0.0.0.0"
				),
				reason: "a get by a column every arm copies from a key column's variable was refused",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					"\t\t\tconst there = everyArm(arms, (a) => equalPath(a, c, o))\n\t\t\tconst back = everyArm(arms, (a) => equalPath(a, o, c))",
				replacement:
					"\t\t\tconst there = everyArm(arms, () => equalPath(arms[0], c, o))\n\t\t\tconst back = everyArm(arms, () => equalPath(arms[0], o, c))",
				why: "Two columns the first arm makes equal are the union's equal columns (logical/props.ts unionProps); the union class keys property fails."
			}
		]
	}
)

/**
 * The key kernel's union equalities refuses a forged equal step whose arms only determine the column, or that cites a
 * column pair none has.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/logical/keys.test.ts:677 at 8cad5bce, its runs and its coverage's cases).
 */
export const theKeyKernelsUnionEqualitiesRefusesAForgedEqualStepWhoseArmsOnlyDetermineTheColumnOrThatCitesAColumnPairNoneHas =
	property.explore(mappingsGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"every arm makes b equal to a",
			"an arm shifts",
			"arms shifting by different amounts",
			"an equality through a filter",
			"three arms"
		] satisfies ReadonlyArray<Reached<ForgeFeature>>,
		check: (_, c: Case<ForgeFeature>) => (sketch) =>
			Effect.gen(function* () {
				const mappings = (([head, tail]) => [head, ...tail] as const)(sketch)
				return yield* Effect.sync(() => {
					const shifts = Arr.flatMap(mappings, (m) => (m.kind === "shift" ? [m.by] : []))
					const equal = shifts.length === 0
					c.note(equal ? "every arm makes b equal to a" : "an arm shifts")
					if (new Set(shifts).size > 1) {
						c.note("arms shifting by different amounts")
					}
					if (Arr.some(mappings, (m) => m.kind === "filtered")) {
						c.note("an equality through a filter")
					}
					if (mappings.length > 2) {
						c.note("three arms")
					}
					const q = new Ir(workModel())
					const arms = Arr.map(mappings, (mapping, i) => {
						const rows = q.input(`rows${i}`, [
							["x", int4],
							["y", int4]
						])
						const input =
							mapping.kind === "filtered"
								? q.filter(rows, q.eq(q.col(rows, "x"), q.col(rows, "y")))
								: rows
						const b =
							mapping.kind === "copy"
								? q.col(input, "x")
								: mapping.kind === "filtered"
									? q.col(input, "y")
									: q.op("add", [q.col(input, "x"), q.lit(mapping.by, int4)])
						const node = q.project(
							input,
							[
								["tag", q.lit(i, int4)],
								["a", "x"],
								["b", b],
								["c", "y"]
							],
							conservativeMeta
						)
						return { node, input, mapping }
					})
					const union = q.union(
						Arr.map(arms, (a) => a.node),
						[],
						conservativeMeta
					)
					const analysis = succeeded(analyzeLogical(q.build(union).dag, checkerEvidence))
					const kernel = new KeyKernel(analysis.dag, {
						keyedViews: false
					})
					const proof = defined(analysis.of(union).props.keys[0], "a key of the union")
					assert.deepEqual(kernel.check(proof), [], "the kernel accepts the union's key as proved")
					const basis = proof.basis
					if (basis.kind !== "rows") {
						assert.fail("a union of one heading group proves its keys by its rows")
					}
					/** The union's key with `step` appended to its derivation, once every column is known. */
					const forged = (step: Dependency): KeyProof => ({
						...proof,
						basis: {
							...basis,
							implication: implication(proof.node, basis.implication.from, [
								...basis.implication.steps,
								step
							])
						}
					})
					/** Each arm's derivation that `from` determines b: a projection step over its input's x and y. */
					const derivations = (from: string) =>
						Arr.map(arms, ({ node, input, mapping }) => {
							const inputProps = analysis.of(input).props
							const through =
								mapping.kind === "filtered"
									? [
											defined(
												Option.getOrUndefined(
													Arr.findFirst(
														inputProps.dependencies,
														(d) => d.rule.rule === "equal" && d.from[0] === "x" && d.to[0] === "y"
													)
												),
												"the filter's equality of x and y"
											)
										]
									: []
							return implication(
								analysis.of(node).props.node.id,
								[from],
								[projectionCloses([from], ["b"], implication(inputProps.node.id, ["x"], through))]
							)
						})
					const faults = kernel.check(
						forged(equalColumns("a", "b", { kind: "arms", arms: derivations("a") }))
					)
					assert.equal(
						faults.length === 0,
						equal,
						equal
							? "the kernel accepts a = b where every arm makes b a copy of a"
							: "the kernel refuses a = b where an arm only determines b"
					)
					assert.ok(
						kernel.check(forged(equalColumns("a", ghost, { kind: "arms", arms: derivations("a") })))
							.length > 0,
						"the kernel refuses an equal step citing a column the union lacks"
					)
					assert.ok(
						kernel.check(forged(equalColumns("a", "b", { kind: "arms", arms: derivations(ghost) })))
							.length > 0,
						"the kernel refuses arm derivations from a column the arms lack"
					)
				})
			}),
		oracle: {
			kind: "specification",
			name: "an arms witness proves two union columns equal only when each arm's derivation steps by equalities alone"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/logical/keys.test.ts#theKeyKernelsUnionEqualitiesRefusesAForgedEqualStepWhoseArmsOnlyDetermineTheColumnOrThatCitesAColumnPairNoneHas:-:2.0.1.2.1"
				),
				reason: "an arms witness of two arms that map a to b differently was accepted",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\treturn [head, ...tail, ...rest.flatMap((g) => g.arms)]",
				replacement: "\treturn [head, ...rest.flatMap((g) => g.arms)]",
				why: "Operator mutant (element) at packages/engine/src/ir/rel.ts:580 in unionArms: `[head, ...tail, ...rest.flatMap((g) => g.arms)]` becomes `[head, ...rest.flatMap((g) => g.arms)]`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
