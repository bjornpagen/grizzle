import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	type Answer,
	at,
	attachmentFeatures,
	expected,
	type Feature,
	features,
	families,
	K,
	keysGen,
	putTargets,
	type Sketch,
	sketchGen,
	writtenRelation,
	Zeros,
	zerosInstall,
	zerosTemplate
} from "#test/pg/write/zero-sign/zero-sign.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { type PlanShape, planShapeGen, planShapeOn } from "#test/support/plan-shapes.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * A float's -0 and +0 are one key and two facts, on PostgreSQL 19: a write of a fact at a stored fact's key whose zero has the other sign writes another fact, by every put target, insert and deletion.
 */
export const aFloatsZerosAreOneKeyAndTwoFactsAWriteOfAFactAtAStoredFactsKeyWhoseZeroHasTheOtherSignWritesAnotherFactByEveryPutTargetInsertAndDeletion =
	property.exhaust(finite(sketchGen), {
		needs: { fixture: Substrate.fresh(zerosTemplate) },
		situations: Arr.filter(
			features,
			(f) => f !== "two zero keys refused as one key"
		) satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(s: Sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Zeros, {}, zerosInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.load.once({
										params: {},
										facts: {
											insert: {
												M: [{ ...at, x: s.stored }],
												I: [{ k: at.k, x: s.stored }]
											}
										}
									})
									const fact = { ...at, x: s.written }
									const call = (() => {
										switch (s.write) {
											case "putEnumerated":
												return db.workload.putEnumerated.once({
													params: {},
													facts: { put: { M: [fact] } }
												})
											case "putDescribed":
												return db.workload.putDescribed.once({
													params: { k: at.k, x: s.written },
													facts: {}
												})
											case "putScoped":
												return db.workload.putScoped.once({
													params: { g: at.g, rows: [fact] },
													facts: {}
												})
											case "putDisplacing":
												return db.workload.putDisplacing.once({
													params: {},
													facts: { put: { I: [{ k: at.k, x: s.written }] } }
												})
											case "insertMutable":
												return db.workload.insertMutable.once({
													params: {},
													facts: { insert: { M: [fact] } }
												})
											case "deleteMutable":
												return db.workload.deleteMutable.once({
													params: {},
													facts: { delete: { M: [fact] } }
												})
										}
									})()
									const outcome = yield* writeAnswerOf(call)
									const state = yield* tableState(o.installed, writtenRelation(s.write))
									const after = Option.getOrUndefined(
										Arr.findFirst(state, (row) => row["k"] === at.k)
									)
									const answer: Answer = {
										outcome: outcome._tag,
										after: after === undefined ? undefined : Number(after["x"])
									}
									const model = expected(s)
									assert.ok(
										answer.outcome === model.outcome &&
											(answer.after === undefined
												? model.after === undefined
												: model.after !== undefined && Object.is(answer.after, model.after)),
										`${Formatter.format(s)}: answered ${Formatter.format(answer)}, the fact identity gives ${Formatter.format(model)}`
									)
									if (outcome._tag === "refused") {
										assert.deepEqual(
											refusedLaws(outcome.refused),
											[
												namesOf(o.installed).described(
													namesOf(o.installed).primaryKeyLaw(writtenRelation(s.write))
												)
											],
											"refused by the written relation's key"
										)
									}
									c.note(
										Object.is(s.stored, s.written)
											? `${s.write} of the stored zero`
											: `${s.write} of the other zero`
									)
									c.noteAll(Arr.map(putTargets(s.write), (t): Feature => `put target ${t}`))
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the fact identity: a fact whose zero has the other sign is another fact at the same key"
		},
		box: "each write (three put targets in place, the pair where a put reads back what it removed, an insert, an exact deletion) of a fact at a stored fact's key, each of the two zeros stored and written",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/compare.ts",
				original: "\treturn or([rowNe(sides, names), ...signs])",
				replacement: "\treturn or([rowNe(sides, names), ...signs.slice(signs.length)])",
				why: "A payload differs by PostgreSQL's equality alone, so a put of a zero over the other zero stores nothing."
			},
			{
				file: "packages/engine/src/ir/compare.ts",
				original: "\treturn and([rowEq(sides, names), ...signs])",
				replacement: "\treturn and([rowEq(sides, names), ...signs.slice(signs.length)])",
				why: "A fact is a stored fact by PostgreSQL's equality alone, so an insert of the other zero is met and an exact deletion of it removes the stored fact."
			},
			{
				file: "packages/engine/src/sql/build.ts",
				original:
					"\tor([ne(a, floatZero(carrier)), eq(signByte(a, carrier), signByte(b, carrier))])",
				replacement:
					"\tor([ne(a, floatZero(carrier)), eq(signByte(a, carrier), signByte(a, carrier))])",
				why: "Two zeros read one sign, so an insert of the other zero is met."
			},
			{
				file: "packages/engine/src/write/probe.ts",
				original:
					"\t\t\tconjunction(equal.map((e) => factFieldEq(e.type, at(e.column), e.value, w.names)))",
				replacement:
					"\t\t\tconjunction(equal.map((e) => typedEq(e.type, at(e.column), e.value, w.names)))",
				why: "The stored row an insert meets at its key repeats the fact by PostgreSQL's equality alone, so an insert of the other zero is met and answered unchanged."
			}
		]
	})

/**
 * Two facts at -0 and +0 of a float key are one key, on PostgreSQL 19: a put of both in one stratum is refused on the key before any SQL, as two facts of one key are.
 */
export const twoFactsAtMinusZeroAndPlusZeroOfAFloatKeyAreOneKeyAPutOfBothIsRefusedOnTheKey =
	property.exhaust(finite(keysGen), {
		needs: { fixture: Substrate.fresh(zerosTemplate) },
		situations: ["two zero keys refused as one key"] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			([a, b]) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Zeros, {}, zerosInstall, taken)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									const outcome = yield* writeAnswerOf(
										db.workload.putKeys.once({
											params: {},
											facts: {
												put: {
													K: [
														{ x: a, n: 1n },
														{ x: b, n: 2n }
													]
												}
											}
										})
									)
									if (outcome._tag !== "refused") {
										return assert.fail(`two facts of one key refused, not ${outcome._tag}`)
									}
									const names = namesOf(o.installed)
									assert.deepEqual(refusedLaws(outcome.refused), [
										names.described(names.primaryKeyLaw(K))
									])
									const stored = yield* tableState(o.installed, K)
									assert.deepEqual(stored, [])
									if (!Object.is(a, b)) {
										c.note("two zero keys refused as one key")
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "a key's equality: -0 and +0 are one key, as PostgreSQL's unique index holds them"
		},
		box: "two facts of K, each at either zero key",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\tfloat8: (text) => (text === floatText(-0) ? floatText(0) : text)",
				replacement: "\tfloat8: (text) => text",
				why: "A key text tells -0 from +0, so the host sends both and PostgreSQL's ON CONFLICT meets one row twice."
			}
		]
	})

/**
 * A float key's -0 and +0 are one key to an attachment, on PostgreSQL 19 under every plan shape: a parent at either zero has the children at both zeros, each delivering its own zero.
 */
export const aFloatKeysZerosAreOneKeyToAnAttachmentAParentAtEitherZeroHasTheChildrenAtBothZerosUnderEveryPlanShape =
	property.exhaust(finite(planShapeGen), {
		needs: { fixture: Substrate.fresh(zerosTemplate) },
		situations: attachmentFeatures satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ fixture }, c: Case<Feature>) =>
			(shape: PlanShape) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Zeros, {}, zerosInstall, taken)
								yield* planShapeOn(o.installed.as(o.server).role, shape)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})
									yield* db.workload.loadFamilies.once({
										params: {},
										facts: { insert: { P: families.P, C: families.C } }
									})
									const rows = yield* db.workload.parents.once({ params: {}, facts: {} })
									const read = Arr.map(Arr.fromIterable(rows), (row) => ({
										id: row.id,
										x: row.x,
										children: Arr.map(row.children, (child) => ({ id: child.id, x: child.x }))
									}))
									const childrenOf = (id: bigint) =>
										Option.getOrUndefined(Arr.findFirst(read, (row) => row.id === id))?.children
									for (const parent of families.P) {
										const children = childrenOf(parent.id) ?? []
										assert.ok(
											children.length === families.C.length &&
												Arr.every(families.C, (stored) =>
													Arr.some(
														children,
														(child) => child.id === stored.id && Object.is(child.x, stored.x)
													)
												),
											`${shape}: the parent at ${Object.is(parent.x, -0) ? "-0" : "0"} has ${Formatter.format(children)}, where every child at either zero is its child`
										)
									}
									c.note(`children of both zeros under the ${shape} plan`)
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's equality, under which -0 = 0: every child is a child of each parent"
		},
		box: "the four plan shapes, over parents and children at each zero",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/reader/execution.ts",
				original: "\t\t\t\tcell: scalarReader(c.type, codes).keyText\n\t\t\t})),",
				replacement: "\t\t\t\tcell: scalarReader(c.type, codes).cellText\n\t\t\t})),",
				why: "A parent is keyed by its own key's identity text, so the parent at -0 looks its children up under -0, where the attachment's join key, a merge of equal zeros, files them under 0 as every merge takes +0, and it gets none."
			}
		]
	})
