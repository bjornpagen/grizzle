import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Option, Order, Result } from "effect"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { hostParams } from "#adapter/reader/params.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { RelationParamDecl } from "#compiler/ir/products.ts"
import type { RelationColumn } from "#compiler/lower/conservative/types.ts"
import { pg } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { textOfParam } from "#test/support/wire.ts"
import {
	Color,
	type ColumnName,
	delivered,
	factsOf,
	headingOf,
	inputCaseGen,
	type InputFeature,
	Pinned,
	pinnedCodes,
	type PinnedFeature,
	pinnedReadGen,
	plantedFacts,
	refusalOf,
	refusedSlot,
	Sample,
	slotColumn,
	uuidScalar,
	uuidAt
} from "#test/unit/adapter/reader.fixtures.ts"

/**
 * Every declared parameter admitted at the read boundary refuses a scalar parameter of another host type whether or
 * not the optimized artifact binds it, and admits a valid one.
 *
 * Budget: its suite's count before the conversion (unit/adapter/reader-eliminated-parameter: 100 independent cases and
 * 0 steered, Vitest at grizzle 4ca3036a).
 */
export const everyDeclaredParameterAdmittedAtTheReadBoundaryRefusesAScalarParameterOfAnotherHostTypeWhetherOrNotTheOptimizedArtifactBindsItAndAdmitsAValidOne =
	property.explore(pinnedReadGen, {
		needs: {},
		situations: [
			"a parameter only an eliminated rule reads",
			"a parameter a statement binds"
		] satisfies ReadonlyArray<Reached<PinnedFeature>>,
		check:
			(_, c: Case<PinnedFeature>) =>
			({ read: { inner, outer, kind }, wrong }) =>
				Effect.sync(() => {
					const q = queryOver(Pinned)
						.rule((r: RuleValue) => {
							const { id, [kind.field]: x } = varsOver(Sample, "sample")
							const pinned = r.interior((r2: RuleValue) => {
								const { id: handle } = varsOver(Color, "color")
								return r2.match(Color, { id: handle }).where(r2.eq(handle, inner)).find({ handle })
							})
							return r
								.match(Sample, { id, color: outer, [kind.field]: x })
								.match(pinned, { handle: outer })
								.where(r.eq(x, r.param("p", kind.type)))
								.find({ id })
						})
						.rule((r: RuleValue) => {
							const { id, whole } = varsOver(Sample, "sample")
							return r
								.match(Sample, { id, whole })
								.where(r.eq(whole, r.param("q", pg.integer)))
								.find({ id })
						})
					const template = succeeded(compileTemplate(q, Pinned, testCompile))
					const p = Option.getOrThrowWith(
						Arr.findFirst(template.params, (d) => d.name === "p"),
						() => new Error("the read declares p")
					)
					/** The optimized artifact's statement: a rule that is not empty binds p. */
					const bound = Arr.some(
						template.programs.optimized.statement.params,
						(slot) => slot.kind === "scalar" && slot.param === p.id
					)
					if (inner === outer) {
						assert.ok(bound, `pinned and matched at ${inner}: its statement binds p`)
					}
					c.note(
						bound ? "a parameter a statement binds" : "a parameter only an eliminated rule reads"
					)
					const valid = { p: kind.valid, q: 3 }
					const refused = executionInputs(paramCodecs(template.params, pinnedCodes), {
						...valid,
						p: wrong
					})
					assert.ok(
						Result.isFailure(refused),
						`p declared ${kind.field}, given a value of another host type, is admitted`
					)
					assert.deepEqual(refusalOf(new ReadFailure({ reason: refused.failure })), {
						kind: "codec",
						slot: "p"
					})
					/**
					 * A valid value is admitted, and every declared scalar parameter is encoded, the eliminated one too.
					 */
					const admitted = Result.getOrThrow(
						executionInputs(paramCodecs(template.params, pinnedCodes), valid)
					)
					assert.deepEqual(
						new Set(admitted.scalars.keys()),
						new Set(Arr.flatMap(template.params, (d) => (d.kind === "relation" ? [] : [d.id])))
					)
				}),
		oracle: {
			kind: "specification",
			name: "every declared parameter is admitted at the read boundary, whatever the optimizer eliminated"
		},
		budget: { runs: 100, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/reader/relations.ts",
				original: "\t\t\t\treturn Result.fail(text.error)",
				replacement: "\t\t\t\tcontinue",
				why: "A scalar parameter its codec refuses is left out rather than refused."
			}
		]
	})

/**
 * A read's relation input is its distinct facts, in arrays of every column order a slot reads, from any delivery and
 * any number of facts; a codec's refusal names its slot.
 *
 * Budget: its suite's count before the conversion (unit/adapter/reader-inputs: 120 independent cases and 80 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aReadsRelationInputIsItsDistinctFactsInArraysOfEveryColumnOrderASlotReadsFromAnyDeliveryAndAnyNumberOfFactsACodecsRefusalNamesItsSlot =
	property.explore(inputCaseGen, {
		needs: {},
		situations: [
			"an array",
			"a Stream",
			"an iterable read once",
			"a Stream that fails",
			"no fact",
			"a repeated fact",
			"more facts than a statement binds parameters",
			"columns read in another order",
			"refused: a field no uuid",
			"refused: a null field",
			"refused: a null fact",
			"refused: no iterable",
			"refused: a failing Stream"
		] satisfies ReadonlyArray<Reached<InputFeature>>,
		check: (_2, k: Case<InputFeature>) => (c) =>
			Effect.gen(function* () {
				const heading = headingOf(c.width)
				const ids: RelationParamDecl = {
					id: ParamId("p1"),
					name: "ids",
					kind: "relation",
					heading: Arr.map(heading, (name) => ({ name, type: uuidScalar }))
				}
				const account = uuidAt(c.account)
				const declared = [
					ids,
					{ id: ParamId("p2"), name: "account", kind: "scalar", type: uuidScalar } as const
				]
				const facts = factsOf(c)
				const value = delivered(c, plantedFacts(c, facts))
				const slot = refusedSlot(c)
				const host = yield* Effect.exit(
					value.kind === "typed"
						? hostParams("the case's read", declared, { ids: value.value, account })
						: Effect.succeed({ ids: value.value, account })
				)
				const prepared = Exit.isSuccess(host)
					? executionInputs(paramCodecs(declared, emptyCodebook), host.value)
					: undefined
				if (c.fault.kind !== "no iterable") {
					k.note(c.delivery)
				}
				if (slot !== undefined) {
					const refusal: EncodingFailure | ReadFailure | undefined = Exit.isFailure(host)
						? Option.getOrUndefined(Exit.findErrorOption(host))
						: prepared !== undefined && Result.isFailure(prepared)
							? prepared.failure
							: undefined
					const reason = refusal instanceof ReadFailure ? refusal.reason : refusal
					assert.deepEqual(
						reason?._tag === "EncodingFailure" ? reason.place : undefined,
						{ _tag: "Slot", name: slot },
						"the refusal names its slot"
					)
					k.note(
						c.fault.kind === "none"
							? "refused: a failing Stream"
							: c.delivery === "a Stream that fails" && c.fault.kind !== "no iterable"
								? "refused: a failing Stream"
								: `refused: ${c.fault.kind}`
					)
					return
				}
				assert.ok(Exit.isSuccess(host), "the host step admits the input")
				const passed = host.value["ids"]
				assert.ok(
					passed === value.value || c.delivery !== "an array",
					"an array passes the host step as it is"
				)
				const inputs = succeeded(defined(prepared, "the inputs"))
				assert.ok(inputs.scalars.has(ParamId("p2")), "the scalar parameter is admitted")
				const input = defined(inputs.relations.get(ids.id), "the read admits ids")
				/** The input's arrays over `columns`, each placeholder's written by itself at its part. */
				const arraysOver = (columns: ReadonlyArray<RelationColumn>) =>
					Arr.map(columns, (_, part) => succeeded(input.array(columns, part)))
				const otherNames = Arr.map(c.order, (i) => defined(heading[i], "a column"))
				const declaredColumns = Arr.map(heading, (name, i) => slotColumn(name, `c${i}`))
				const otherColumns = Arr.map(otherNames, (name, i) => slotColumn(name, `d${i}`))
				/** A row as one text: its values, uuids which hold no space, joined by spaces. */
				const keyOf = (row: ReadonlyArray<unknown>): string =>
					Arr.join(
						Arr.map(row, (value) => String(value)),
						" "
					)
				const projectedKeys = (names: ReadonlyArray<ColumnName>) =>
					Arr.sort(
						new Set(Arr.map(facts, (fact) => keyOf(Arr.map(names, (name) => fact[name])))),
						Order.String
					)
				for (const [names, columns] of [
					[heading, declaredColumns],
					[otherNames, otherColumns]
				] as const) {
					const literals = Arr.map(arraysOver(columns), (array) =>
						readArrayLiteral(textOfParam(array))
					)
					const rows = Arr.map(defined(literals[0], "a column's array"), (_, row) =>
						keyOf(Arr.map(literals, (column) => column[row]))
					)
					assert.equal(new Set(rows).size, rows.length, "no row twice")
					assert.deepEqual(
						Arr.sort(rows, Order.String),
						projectedKeys(names),
						"the distinct facts over the slot's columns"
					)
				}
				const distinct = projectedKeys(heading)
				const declaredArrays = arraysOver(declaredColumns)
				assert.deepEqual(
					arraysOver(otherColumns),
					Arr.map(c.order, (i) => defined(declaredArrays[i], "a column's array")),
					"another order's arrays are the declared order's, permuted"
				)
				if (distinct.length === 0) {
					k.note("no fact")
				}
				if (distinct.length < facts.length) {
					k.note("a repeated fact")
				}
				if (facts.length > 65_535) {
					k.note("more facts than a statement binds parameters")
				}
				if (Arr.some(c.order, (position, i) => position !== i)) {
					k.note("columns read in another order")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the input's distinct facts, projected onto each column order a slot reads"
		},
		budget: { runs: 120, steered: 80 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/reader/relations.ts",
				original: '\tif (typeof value !== "object" || !Predicate.isIterable(value)) {',
				replacement: '\tif (typeof value === "object" || !Predicate.isIterable(value)) {',
				why: "Operator mutant (comparison) at packages/grizzle/src/adapter/reader/relations.ts:144 in prepareInput: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
