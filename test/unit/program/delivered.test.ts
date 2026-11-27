import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { buildSchema } from "#test/support/oracle/public/build.ts"
import {
	caseSketchGen,
	type MixedForm,
	mixedForms,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import {
	checkRebuilt,
	checkRemovedKeys,
	checkRestated,
	type LayoutFeature,
	mixedRead,
	plantGen,
	type RebuiltFeature,
	type RestatedFeature,
	unplanted
} from "#test/unit/program/delivered.fixtures.ts"

/** Typed rows at bind refuse a stated delivery the facts break, and bind one the program proves. Its budget is its suite's before it was a property (test/unit/program/delivered.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const typedRowsAtBindRefuseAStatedDeliveryTheFactsBreakAndBindOneTheProgramProves =
	property.explore((source) => [source.draw(caseSketchGen), source.draw(plantGen)] as const, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"option the facts break: refused",
			"one the facts break: refused",
			"option the program proves: bound",
			"one the program proves: bound"
		] satisfies ReadonlyArray<Reached<RestatedFeature>>,
		check:
			(_, notes: Case<RestatedFeature>) =>
			([sketch, plant]) =>
				Effect.sync(() => checkRestated(notes.draw(resolveCase(sketch)), notes.note, plant)),
		oracle: {
			kind: "second-implementation",
			name: "the reference's children per parent (oracle/public/meaning.ts) and the program language's own proof (delivery.ts)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/program/delivered.test.ts#typedRowsAtBindRefuseAStatedDeliveryTheFactsBreakAndBindOneTheProgramProves:-:2.0.0.0.0.0.0.0.0.1.2.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.uca.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0"
				),
				reason:
					"a reflexive aggregate child with an attachment of its own, stated one, which the program proves, was refused",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/program/delivered.test.ts#typedRowsAtBindRefuseAStatedDeliveryTheFactsBreakAndBindOneTheProgramProves:-:2.1.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.2.1.0.1.0.0.0.1.0.1.0.0.1.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.2.1.2.1.0.1.2.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.4.r.0.0.0.0.0.0.cn4.0.0.0.0.0.0.0.1.0.0.0.0.0.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.1.0.0.0"
				),
				reason:
					"TOOLTRUST's sync at faa39c3c1, its key-derived seed: a child bound on its relation's primary key, the relation keyed by a candidate key too and holding a float, stated option, which the program proves, was refused",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/unit/program/delivered.test.ts#typedRowsAtBindRefuseAStatedDeliveryTheFactsBreakAndBindOneTheProgramProves:-:2.1.0.1.0.1.0.1.0.1.0.0.1.0.0.1.0.0.1.2.0.1.2.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.1.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.1.0.0.0.0.0.0.4.0.0.0.0.0.0.0.cn4.pa8.0.0.0.0.0.0.1.0.0.0.0.0.1.3.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.2.0"
				),
				reason:
					"train C's gate C4 at 1d63590a, rotating seed 0xa6334a8f, case 22: a child matching Rel1x0, whose primary key [Bool, field1] binds the parent's columns beside its candidate key(field0) and its float field1, stated option, which the program proves, was refused: the source's key proof chose key(field0), and its primary key, an alternative, was read as no key",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/runtime/read/record.ts",
				original: "\t\t\tif (!licenses(at.proved, field.delivery)) {",
				replacement:
					'\t\t\tif (field.delivery !== "option" && !licenses(at.proved, field.delivery)) {',
				why: "An Option delivery is bound over layouts that may hold many children."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\tconst key = keyIn(k, holds)\n",
				replacement: "\t\tconst key = k.key.every(holds) ? k.key : undefined\n",
				why: "A source's key proof is read by its own key alone, never by its alternatives (logical/props.ts keyAmong): the region over Rel1x0 at its primary key, the proof's alternative beside its candidate key, reads, for all its readers know, two facts a binding, its float is no field of one fact, and the child's projection, its float's zeros apart, claims no key, so its stated option, which the program proves, is refused (the kept case)."
			}
		]
	})

/** Typed rows at bind refuse a layout without one of the record's keys. Its budget is its suite's before it was a property (test/unit/program/delivered.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const typedRowsAtBindRefuseALayoutWithoutOneOfTheRecordsKeys = property.explore(
	caseSketchGen,
	{
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: ["column removed: refused", "attachment removed: refused"] satisfies ReadonlyArray<
			Reached<LayoutFeature>
		>,
		check: (_, notes: Case<LayoutFeature>) => (sketch) =>
			Effect.sync(() => checkRemovedKeys(notes.draw(resolveCase(sketch)), notes.note, unplanted)),
		oracle: {
			kind: "specification",
			name: "a record binds only to layouts holding every one of its keys"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/read/record.ts",
				original:
					'\tlayout.columns.get(key) ?? refuseLayout(key, "a column of the statement that delivers the record")',
				replacement: "\tlayout.columns.get(key) ?? -1",
				why: "A record key its layout lacks is read as absent, not refused at bind."
			}
		]
	}
)

/** Typed rows at bind refuse to read a query rebuilt from its Description. Its budget is its suite's before it was a property (test/unit/program/delivered.test.ts at 4ca3036a): 40 runs and 40 steered cases. */
export const typedRowsAtBindRefuseToReadAQueryRebuiltFromItsDescription = property.explore(
	caseSketchGen,
	{
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			"rebuilt: refused",
			"rebuilt arm beside a typed arm: refused"
		] satisfies ReadonlyArray<Reached<RebuiltFeature>>,
		check: (_, notes: Case<RebuiltFeature>) => (sketch) =>
			Effect.sync(() => checkRebuilt(notes.draw(resolveCase(sketch)), notes.note, unplanted)),
		oracle: {
			kind: "specification",
			name: "a query rebuilt from its Description has no decoder of its own"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/group/index.ts",
				original:
					"\t\tread.present === undefined ? node.keys.map((k) => columnIn(read.bound, k)) : [read.present]",
				replacement:
					"\t\tread.present !== undefined ? node.keys.map((k) => columnIn(read.bound, k)) : [read.present]",
				why: "Operator mutant 19254889aa at packages/engine/src/lower/conservative/group/index.ts:169 in lowerGroup: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	}
)

/** Typed rows at bind decode each heading group of a heterogeneous union as its own record. Its budget is its suite's before it was a property (test/unit/program/delivered.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const typedRowsAtBindDecodeEachHeadingGroupOfAHeterogeneousUnionAsItsOwnRecord =
	property.explore(caseSketchGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: mixedForms satisfies ReadonlyArray<Reached<MixedForm>>,
		check: (_, notes: Case<MixedForm>) => (sketch) =>
			Effect.sync(() => {
				const c = notes.draw(resolveCase(sketch))
				const built = buildSchema(c.schema)
				for (const read of c.reads) {
					if (read.kind === "mixed") {
						mixedRead(c, read.root, built, notes.note)
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference's answer of each heading group (oracle/public/answer.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original:
					'{\n\t\t\tconst input: S["node"] = yield n.input\n\t\t\tconst out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))\n\t\t\treturn { ...n, input, out, meta: m.meta(n.meta) }\n\t\t}\n\t\tcase "SemiJoin": {\n\t\t\tconst left: S["node"] = yield n.left\n\t\t\tconst right: S["node"] = yield n.right\n\t\t\treturn { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }\n\t\t}',
				replacement:
					'{    const left: S["node"] = yield n.left    const right: S["node"] = yield n.right    return { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }   }   case "SemiJoin": {    const input: S["node"] = yield n.input    const out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))    return { ...n, input, out, meta: m.meta(n.meta) }   }',
				why: 'Operator mutant ce9b2811c1 at packages/engine/src/ir/rel.ts:1060 in mapNode: `{    const input: S["node"] = yield n.input    const out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))    return { ...n, input, out, meta: m.meta(n.meta) }   }   case "SemiJoin": {    const left: S["node"] = yield n.left    const right: S["node"] = yield n.right    return { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }   }` becomes `{    const left: S["node"] = yield n.left    const right: S["node"] = yield n.right    return { ...n, left, right: keptRight(right), meta: m.meta(n.meta) }   }   case "SemiJoin": {    const input: S["node"] = yield n.input    const out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))    return { ...n, input, out, meta: m.meta(n.meta) }   }`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})
