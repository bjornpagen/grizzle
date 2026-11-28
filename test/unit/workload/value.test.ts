/**
 * workload(schema, programs) as a value (program/workload/value.ts): a workload records a WorkloadDesc holding each
 * program's Description under its name, compiles from that Description with the schema named to the plan its value
 * compiles to, and refuses what its signature forbids.
 *
 * The programs are the workload fixtures' (workload/fixtures.ts), drawn into workloads under drawn names; a renamed
 * schema takes a schema name of the dictionary other than Work's own, so no draw is discarded.
 *
 * Oracles: the workload value's own compile (its Description compiles to its value's plan), the plan over Work itself
 * for a renamed Work, and the specification of workload()'s signature and its refusals.
 *
 * Features: a query and a ChangeSet program, an extension's workload, an empty workload; renamed; named; every
 * signature situation (SignatureFeature); each unreadable site and wild kind.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { passed } from "@bjornpagen/testing/lsw"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { formatLoc } from "#compiler/core/loc.ts"
import { decodeDesc } from "#compiler/ir/desc.ts"
import { workload as admitWorkload, workloadState } from "#compiler/program/workload/value.ts"
import { schema } from "#compiler/public/schema.ts"
import { refusalLoc, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import {
	Board,
	fixtureLogin,
	orderedTasks,
	switchToManualDescribed
} from "#test/support/unit/workload/fixtures.ts"
import {
	admits,
	board,
	foreign,
	nameGen,
	own,
	programsValue,
	renamedNameGen,
	schemaValue,
	type SignatureFeature,
	signatureCaseGen,
	signatureFeatures,
	type UnreadableFeature,
	unreadableGen,
	type ValueFeature,
	workloadGen
} from "#test/unit/workload/value.fixtures.ts"

/**
 * Workload(schema, programs) records each program's Description under its name, and compiles from it with the schema
 * named alone.
 *
 * Budget: its suite's count before the conversion (unit/workload/value-desc: 40 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const workloadSchemaProgramsRecordsEachProgramsDescriptionUnderItsNameAndCompilesFromItWithTheSchemaNamedAlone =
	property.explore(workloadGen, {
		needs: {},
		situations: [
			"query",
			"changeSet",
			"an extension's workload",
			"an empty workload"
		] satisfies ReadonlyArray<Reached<ValueFeature>>,
		check:
			(_, k: Case<ValueFeature>) =>
			([c, entries, other]) =>
				Effect.sync(() => {
					const value = admitWorkload(
						c.schema,
						Rec.fromEntries(Arr.map(entries, (e) => [e.name, e.p.value]))
					)
					unorderedEqual(
						Rec.keys(value.programs),
						Arr.map(entries, (e) => e.name)
					)
					const desc = defined(workloadState(value)?.desc, "the workload's Description")
					succeeded(decodeDesc("workload", desc), "a valid WorkloadDesc")
					assert.equal(desc.schema, c.name)
					for (const e of entries) {
						assert.equal(defined(desc.programs[e.name], e.name).kind, e.p.kind)
						k.note(e.p.kind)
					}
					const owned = (w: unknown) => [{ login: fixtureLogin, workloads: [w] }]
					const byValue = succeeded(
						compileTestWorkload(owned(value), c.schema, testCompile),
						"the workload value compiles"
					)
					const byDesc = succeeded(
						compileTestWorkload(owned(desc), c.schema, testCompile),
						"its Description compiles"
					)
					assert.deepEqual(byDesc.params, byValue.params)
					assert.deepEqual(byDesc.footprints, byValue.footprints)
					refused(
						compileTestWorkload(owned(desc), other.schema, testCompile),
						"MalformedDescription",
						"another schema"
					)
					if (c.schema === W.Reports) {
						k.note("an extension's workload")
					}
					if (entries.length === 0) {
						k.note("an empty workload")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the workload value's own compile: its Description compiles to the plan the value does, and over another schema is refused"
		},
		budget: { runs: 40, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/loc.ts",
				original: '\ttypeof segment === "string" || typeof segment === "number"',
				replacement: "\tfalse",
				why: 'Operator mutant (boolean-return) at packages/engine/src/core/loc.ts:101 in isSegment: `typeof segment === "string" || typeof segment === "number"` becomes `false`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})

/**
 * Workload(schema, programs) compiles a ChangeSet over a schema of the same content under another name.
 *
 * Budget: its suite's count before the conversion (unit/workload/value-renamed: 10 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const workloadSchemaProgramsCompilesAChangeSetOverASchemaOfTheSameContentUnderAnotherName =
	property.explore(renamedNameGen, {
		needs: {},
		situations: ["renamed"] satisfies ReadonlyArray<Reached<"renamed">>,
		check: (_, k: Case<"renamed">) => (name) =>
			Effect.sync(() => {
				const renamed = schema(name, Rec.values(W.Work.relations), W.Work.statements)
				const plan = succeeded(
					compileTestWorkload(
						[
							{
								login: fixtureLogin,
								workloads: [admitWorkload(renamed, { switchToManual: switchToManualDescribed })]
							}
						],
						renamed,
						testCompile
					),
					"the workload over the renamed schema compiles"
				)
				assert.deepEqual(plan.params, own.params)
				assert.deepEqual(plan.footprints, own.footprints)
				k.note("renamed")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the plan of the same ChangeSet over Work itself"
		},
		budget: { runs: 10, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/names.ts",
				original: "===",
				replacement: "!==",
				why: "Operator mutant a062e05d86 at packages/engine/src/laws/model/names.ts:14 in keyOf: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/**
 * Workload(schema, programs) refuses a program the checker refuses, naming the program.
 *
 * Budget: its suite's count before the conversion (unit/workload/value-checker: 20 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const workloadSchemaProgramsRefusesAProgramTheCheckerRefusesNamingTheProgram =
	property.explore(nameGen, {
		needs: {},
		situations: ["named"] satisfies ReadonlyArray<Reached<"named">>,
		check: (_, k: Case<"named">) => (name) =>
			Effect.sync(() => {
				const r = refused(
					compileTestWorkload(
						[
							{
								login: fixtureLogin,
								workloads: [{ ...board, programs: { [name]: foreign } }]
							}
						],
						Board,
						testCompile
					),
					"Refused",
					"a program over another schema"
				)
				assert.equal(
					r.reason._tag === "Refused" ? r.reason.refusal : undefined,
					"the relation is not in this query's schema"
				)
				assert.deepEqual(
					refusalLoc(r).path.slice(0, 2),
					["programs", name],
					formatLoc(refusalLoc(r))
				)
				k.note("named")
			}),
		oracle: {
			kind: "specification",
			name: "a program the checker refuses is refused by its typed refusal at the program's own path"
		},
		budget: { runs: 20, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/result.ts",
				original: "\t\tif (caught instanceof signal) {\n\t\t\treturn err(caught)\n\t\t}",
				replacement: "\t\t{}",
				why: "Operator mutant (guard) at packages/engine/src/core/canonical.ts:223 in catchSignal: `if (caught instanceof signal) {\n\t\t\treturn Result.err(caught)\n\t\t}` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Workload()'s signature admits a schema and a record of named programs over it or a level below, and refuses any
 * other call with MalformedDescription.
 *
 * Budget: its suite's count before the conversion (unit/workload/value-signature: 100 independent cases and 48
 * steered, Vitest at grizzle 4ca3036a).
 */
export const workloadSSignatureAdmitsASchemaAndARecordOfNamedProgramsOverItOrALevelBelowAndRefusesAnyOtherCallWithMalformedDescription =
	property.explore(signatureCaseGen, {
		needs: {},
		situations: [
			"admitted",
			"a wild schema",
			"an empty programs record",
			"programs as a list",
			"programs as a function",
			"an empty program name",
			"a value that is no program",
			"a program over another schema",
			"a program over a level below",
			"a program over an extension",
			"a third argument"
		] satisfies ReadonlyArray<Reached<SignatureFeature>>,
		check: (_, k: Case<SignatureFeature>) => (c) =>
			Effect.sync(() => {
				const programs = programsValue(c.programs)
				k.noteAll(signatureFeatures(c))
				const schema = c.schema.kind === "live" ? schemaValue(c.schema.value) : passed(c.schema)
				const [third] = c.extra
				const result = catchCompileError(() =>
					third === undefined
						? admitWorkload(schema, programs)
						: admitWorkload(schema, programs, passed(third))
				)
				if (admits(c)) {
					succeeded(result, "workload() admits a schema and its programs")
					return
				}
				refused(result, "MalformedDescription")
			}),
		oracle: {
			kind: "specification",
			name: "workload(schema, programs): a schema, a plain record of named programs over it or a level below, nothing more"
		},
		budget: { runs: 100, steered: 48 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/workload/value.test.ts#workloadSSignatureAdmitsASchemaAndARecordOfNamedProgramsOverItOrALevelBelowAndRefusesAnyOtherCallWithMalformedDescription:-:0.0.0.0.0"
				),
				reason:
					"an empty programs record, which a wild JSON object drew once as wild programs judged refused",
				since: "2026-11-08"
			}
		],
		kills: [
			{
				file: "packages/engine/src/program/workload/value.ts",
				original: "\t\t\tisPlainRecord(programs)",
				replacement: "\t\t\tisPlainRecord(programs) || Array.isArray(programs)",
				why: "A programs list is admitted as a record."
			}
		]
	})

/**
 * Workload()'s signature refuses a programs record or a program whose reading throws with MalformedDescription, never
 * a defect.
 *
 * Budget: its suite's count before the conversion (unit/workload/value-unreadable: 40 independent cases and 16
 * steered, Vitest at grizzle 4ca3036a).
 */
export const workloadSSignatureRefusesAProgramsRecordOrAProgramWhoseReadingThrowsWithMalformedDescriptionNeverADefect =
	property.explore(unreadableGen, {
		needs: {},
		situations: [
			"programs record proxy",
			"programs record throwing getter",
			"program proxy",
			"program throwing getter"
		] satisfies ReadonlyArray<Reached<UnreadableFeature>>,
		check:
			(_, k: Case<UnreadableFeature>) =>
			({ site, wild }) =>
				Effect.sync(() => {
					const unreadable = passed(wild)
					assert.ok(
						typeof unreadable === "object" && unreadable !== null,
						"an unreadable value is an object"
					)
					throwsRefused(
						() =>
							site === "programs record"
								? admitWorkload(Board, unreadable)
								: admitWorkload(Board, { orderedTasks, unreadable }),
						"MalformedDescription"
					)
					k.note(
						`${site} ${wild.kind === "wild" && wild.wild.kind === "proxy" ? "proxy" : "throwing getter"}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "a reading that throws is MalformedDescription, never a defect"
		},
		budget: { runs: 40, steered: 16 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/contract.ts",
				original: "!domain.ok",
				replacement: "domain.ok",
				why: "Operator mutant 66abd32500 at packages/engine/src/scalar/contract.ts:200 in contractParts: `!domain.ok` becomes `domain.ok`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
