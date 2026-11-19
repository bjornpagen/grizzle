/**
 * insertPreview compiles the insert of what it previews (engine program/preview.ts): the schema's law model, which every
 * reader of the schema value shares, and, where a call first writes them, the host half of the insert of the families
 * its rows write, no statement built, kept for every later call that writes the same.
 *
 * The answers are the served write's: each case draws a preview case of test/pg/write/preview (a schema of families,
 * trees, ordered and counted families, folds and copies beside the palette's closed ids, a counted family and a
 * sequence, an instance and a fault aimed at each refusal), beside it the stamps a schema may hold (a clock and a
 * reference it stamps, or with them a reference no one clock stamps, whose insert no compile admits, each call stating
 * no row of a clock), and one to three
 * calls, each the case's facts with a drawn set of relations stated and every other empty. Each call's preview is held
 * to the binding of the same rows by the served write of insertAll over every top-level relation an insert compiles of,
 * compiled whole, projected and loaded as an application runs it (preview.fixtures.ts servedWrite), read as a preview
 * reads a write (previewThrough): its rows, every writable relation's as a set, and its refusals, InputRefused,
 * KeyConflict, GeneratedNull and OwnerAbsent, each exactly. A call stating rows of the relation no clock stamps is
 * refused as Uncompiled by the very refusal the whole write's compile meets.
 *
 * The work is the preview's own, counted, never timed (kernel/calls.ts callCounts): what compiling and binding an insert
 * compiles of each relation it reads (`relationWork`: the relations a ChangeSet names, a relation's unique objects and
 * key laws, its host key checks, a nesting, its CHECKs' laws and its witness fields, a member's admission and its
 * group's binding) and each front end compiled, while insertPreview compiles and previews the palette's rows, its law
 * model compiled before. The palette's schema alone and the palette beside the case's families and stamps compile the
 * same of each, so the preview compiles the palette's insert and nothing of the rest, however much the schema holds;
 * and a second call of the same rows compiles no front end.
 *
 * Features: each of PreviewCostFeature, noted where a case reaches it.
 */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { type PreviewRowsByName, previewOver, previewThrough } from "#compiler/program/preview.ts"
import type { PreviewRefusal } from "#compiler/types/changeset/preview.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	callOf,
	previewCostCaseGen,
	caseSchema,
	modelOf,
	paletteSchema,
	type PreviewCostCase,
	type PreviewCostFeature,
	servedRelations,
	servedWrite,
	transport
} from "#test/unit/program/preview.fixtures.ts"

/** An answer as the case compares it: every relation's rows as a set, each row by its text, or the refusal. */
const comparable = (answer: Engine.Result<PreviewRowsByName, PreviewRefusal>) =>
	answer.ok
		? {
				rows: Rec.map(answer.value, (rows) =>
					Arr.sort(
						Arr.map(rows, (row) => Formatter.format(row)),
						Order.String
					)
				)
			}
		: answer.error._tag === "Uncompiled"
			? { uncompiled: Formatter.format(answer.error.error.reason) }
			: { refused: answer.error }

/** Each call's preview is the served write's binding of its rows, refusals included; an insert that does not compile refuses as the whole write's compile does. */
export const eachCallsPreviewIsTheServedWritesBindingOfItsRowsRefusalsIncludedAnInsertThatDoesNotCompileRefusesAsTheWholeWritesCompileDoes =
	property.explore(previewCostCaseGen, {
		needs: {},
		situations: [
			"a call stating one relation",
			"a call stating several families",
			"a call writing a family it states only a member of",
			"a call reusing a compiled insert",
			"a reference its insert stamps beside its clock's",
			"an insert that does not compile, refused",
			"rows given",
			"a refusal"
		] satisfies ReadonlyArray<Reached<PreviewCostFeature>>,
		check: (_, c: Case<PreviewCostFeature>) => (k: PreviewCostCase) =>
			Effect.sync(() => {
				const { schema, facts } = caseSchema(k, "PreviewCost")
				const model = modelOf(schema)
				const preview = succeeded(previewOver(schema, transport), "the case's schema compiles")
				const whole = servedWrite(schema, servedRelations(schema))
				if (!whole.ok) {
					return assert.fail(
						`the served insertAll of ${Formatter.format(k)} compiles: ${Formatter.format(whole.error)}`
					)
				}
				const served = previewThrough(schema, model, transport, () => whole)
				const refusal =
					k.stamps === "unstampable"
						? servedWrite(schema, [...servedRelations(schema), "Stray"])
						: whole
				const seen = new Set<string>()
				for (const stated of k.calls) {
					const call = callOf(facts, stated)
					const written = Arr.filter(stated, (relation) => (call[relation]?.length ?? 0) > 0)
					const got = comparable(preview(call))
					const at = `the call stating ${Arr.join(written, ", ")} of ${Formatter.format(k)}`
					if (Arr.contains(written, "Stray")) {
						if (refusal.ok) {
							return assert.fail(`the insert of Stray, which no clock stamps, refuses: ${at}`)
						}
						assert.deepEqual(
							got,
							{ uncompiled: Formatter.format(refusal.error.reason) },
							`the preview refuses as the whole write's compile does: ${at}`
						)
						c.note("an insert that does not compile, refused")
						continue
					}
					assert.deepEqual(got, comparable(served(call)), `the served write's binding: ${at}`)
					c.note("rows" in got ? "rows given" : "a refusal")
					c.noteAll(
						written.length === 1
							? ["a call stating one relation"]
							: ["a call stating several families"]
					)
					if (Arr.contains(written, "Dab") && !Arr.contains(written, "Swatch")) {
						c.note("a call writing a family it states only a member of")
					}
					if (Arr.contains(written, "Badge")) {
						c.note("a reference its insert stamps beside its clock's")
					}
					const key = Arr.join(Arr.sort(written, Order.String), ",")
					if (seen.has(key)) {
						c.note("a call reusing a compiled insert")
					}
					seen.add(key)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the served write's binding of insertAll over every top-level relation, compiled whole (preview.fixtures.ts servedWrite)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/preview.ts",
				original: "\t\tfor (const relation of writesOf(model.owned, written)) {",
				replacement: "\t\tfor (const relation of [...written]) {",
				why: "A call compiles the insert of the relations it states alone, not their families' owners and members: a call stating a counted member and not its owner compiles an insert the stratum's appends to an owner it does not insert refuses, or binds the member past a family the whole write fills, and the preview leaves the served write's answer."
			},
			{
				file: "packages/engine/src/program/preview.ts",
				original: '\t\t\t\tif (role.kind === "reference" && role.stamp !== undefined) {',
				replacement: '\t\t\t\tif (role.kind === "reference" && role.stamp === undefined) {',
				why: "A call stating a reference compiles an insert of the reference without its clock's, which stamps it beside no insert of its clock and refuses (clockUnstamped), where the whole write binds its rows: the preview is Uncompiled where the served write gives rows."
			}
		]
	})

/**
 * What compiling and binding a relation's insert compiles of it, each a function of the write's compile and binding
 * called once for each relation it reads: the relations a ChangeSet names (write/delta/source.ts), a relation's unique
 * objects and key laws (write/insert/unique.ts), its host key checks (write/normalize/normalize.ts), a nested insert's
 * nesting (write/family/nesting.ts), its CHECKs' laws and its fields as a witness reads them (write/program/decide.ts),
 * a member's admission (codec/recordset.ts) and its group's binding (runtime/write/normalize.ts); and each front end
 * compiled (write/frontend/compile.ts).
 */
const relationWork = {
	named: { file: "packages/engine/src/write/delta/source.ts", name: "memberRelationNamed" },
	uniques: { file: "packages/engine/src/write/insert/unique.ts", name: "relationUniques" },
	hostChecks: { file: "packages/engine/src/write/normalize/normalize.ts", name: "hostChecks" },
	nestings: { file: "packages/engine/src/write/family/nesting.ts", name: "nestingOf" },
	checks: { file: "packages/engine/src/write/program/decide.ts", name: "lawChecksOf" },
	witnessFields: { file: "packages/engine/src/write/program/decide.ts", name: "witnessField" },
	admissions: { file: "packages/engine/src/codec/recordset.ts", name: "relationNormalizer" },
	groups: { file: "packages/engine/src/runtime/write/normalize.ts", name: "bindGroup" },
	frontEnds: { file: "packages/engine/src/write/frontend/compile.ts", name: "compileChangeSet" }
} as const

/** The preview of the palette's rows does the same work over the palette alone and beside the families and stamps, and a second call compiles no front end. */
export const thePreviewOfThePalettesRowsDoesTheSameWorkOverThePaletteAloneAndBesideTheFamiliesAndStampsAndASecondCallCompilesNoFrontEnd =
	property.explore(previewCostCaseGen, {
		needs: {},
		situations: ["rows given", "a refusal"] satisfies ReadonlyArray<Reached<PreviewCostFeature>>,
		check: (_, c: Case<PreviewCostFeature>) => (k: PreviewCostCase) =>
			Effect.gen(function* () {
				const alone = paletteSchema(k, "PreviewCost")
				const beside = caseSchema(k, "PreviewCost")
				const call = (facts: Readonly<Record<string, ReadonlyArray<unknown>>>) =>
					callOf(facts, Rec.keys(alone.facts))
				/** The preview's work over `s`, its law model compiled before: its compile and its first call. */
				const workOf = (s: AnySchema, facts: Readonly<Record<string, ReadonlyArray<unknown>>>) =>
					Effect.gen(function* () {
						succeeded(rowEvaluator(s), "the case's schema compiles")
						const [answer, counts] = yield* callCounts(
							Effect.sync(() => {
								const preview = succeeded(previewOver(s, transport), "the case's schema compiles")
								return { preview, answer: preview(call(facts)) }
							}),
							relationWork
						)
						return { ...answer, counts }
					})
				const small = yield* workOf(alone.schema, alone.facts)
				const large = yield* workOf(beside.schema, beside.facts)
				assert.deepEqual(
					large.counts,
					small.counts,
					`the palette's preview compiles as much of each relation beside the families and stamps as alone: ${Formatter.format(k)}`
				)
				assert.ok(
					small.counts.frontEnds === 1 && small.counts.groups > 0,
					"the preview compiles the palette's insert"
				)
				c.note(small.answer.ok ? "rows given" : "a refusal")
				const [, again] = yield* callCounts(
					Effect.sync(() => large.preview(call(beside.facts))),
					{
						frontEnds: {
							file: "packages/engine/src/write/frontend/compile.ts",
							name: "compileChangeSet"
						}
					}
				)
				assert.equal(again.frontEnds, 0, "a second call of the same rows compiles no front end")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the same preview over the palette's schema alone, what it compiles of each relation (kernel/calls.ts callCounts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/preview.ts",
				original: "\t\t\t\tinserted = insertable.filter((name) => families.has(name))",
				replacement: "\t\t\t\tinserted = insertable",
				why: "Each call compiles the insert of every top-level relation, the whole schema's: beside the families and stamps the palette's preview compiles and binds their relations too, and its counts leave the palette alone's."
			}
		]
	})
