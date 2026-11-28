/**
 * Generated fields on PostgreSQL 19: STORED generated columns, run as programs of a commands machine whose model
 * predicts every verdict (testing doctrine, rule 11).
 *
 * The relation R holds a caller's key, a closed id `tier` over the roster Tier and two sets over it, a and b, and up to
 * four generated fields, each one of its kind's expressions:
 * - k, a count: |a|, |b|, |a ∪ b| or |a ∩ b|;
 * - s, a set: a ∪ b, a ∩ b, a − b, b − a, or a ∪ L, a ∩ L or a − L, L a literal set operand, Bits.of(Tier, …) of the
 *   live handles at even declared positions (markedOf), which takes a's type, so its bits are the handles' codes; or
 *   {tier} or a ∪ {tier}, the singleton of the row's tier, Bits.singleton(tier), whose one bit is the tier's code;
 * - w, C.at over Weight, a closed relation keyed by a Tier with two integer payloads: Weight.at("w", tier) or
 *   Weight.at("v", tier);
 * - p, C.row over Pair, a closed relation keyed by two Tiers: Pair.row(tier), it ∪ a, or it ∩ {tier}, whether the
 *   tier pairs with itself.
 *
 * Tier is drawn by A8's generator (test/support/closed/generate.ts historyGen) and installed through its history, so
 * most cases meet a roster whose codes have holes, where a set's bit i is code i and not a handle's declared position;
 * rows, Weight's keys and Pair's pairs are drawn from its live handles by the same module. Weight holds every live
 * handle or some of them, so C.at meets keys it holds no tuple at, which read NULL and which the column's NOT NULL
 * refuses with 23502 (fin.md §17; OPEN-U5). The installation declares some generated fields from the start, so a short
 * program meets a closed read over rows. The commands:
 *
 * - **write:** the writer inserts a row of caller values and PostgreSQL computes every generated column, or refuses
 *   the row with 23502 naming w's column where w reads a key Weight does not hold;
 * - **supply:** a direct writer supplies a generated column, by an INSERT or an UPDATE, and PostgreSQL refuses it with
 *   428C9, changing nothing;
 * - **add, change, drop:** a generated field is added, given another expression, or dropped (a declared drop), each a
 *   migration drafted from the snapshot before it as `grizzle generate` drafts it and applied by the real runner. A
 *   changed expression migrates in place by SET EXPRESSION: the column keeps its attnum, which a drop and an add would
 *   not;
 * - **closed rows:** Weight's and Pair's rows change, and every generated column reading them holds the new rows'
 *   values: a STORED column is computed only when it is written, so the migration must re-express each one;
 * - a migration under which w would read a key Weight does not hold, adding w or changing the rows, is refused with
 *   23502 naming w's column. The runner applies a folder file by file, so the files before the refused one stay applied
 *   and the folder is unfinished; a data step deletes the rows that read the absent key, and the same folder applied
 *   again resumes and completes;
 * - **regenerate:** no change drafts nothing, so a generated field's expression is one snapshot text.
 *
 * After every step the installation is the model's: R's columns are its caller's fields and exactly the model's
 * generated fields, each STORED (attgenerated 's'), and every row's caller values are the model's. The oracles are two
 * second implementations of each generation expression: the host evaluator (scalar/compute/evaluate.ts) over the
 * checked schema's expression of the field, its closed reads answered from the model's rows of Weight and Pair, and a
 * naive model of the expression the model chose, over plain Sets. PostgreSQL's stored value of every generated column
 * of every row must agree with both, and with the reference evaluator (test/support/oracle/evaluate/catalog.ts) where
 * the expression reads no closed relation, and PostgreSQL is the judge of every refusal.
 *
 * Each case's commands are a swarm drawn per case (rule 7); the all-off draw is guarded by keeping `write`, which
 * applies in every state, always on. While no witness has added w over a row at a key Weight lacks, or written a row
 * under one of the singleton expressions at a tier whose code is no position, or refused closed rows at such a key, a
 * witness whose turn aims at one draws a run aimed at it (runAims). Bound: programs of three to eight steps, or an
 * aimed write at each live handle, over a roster of two to four handles after up to two migrations of its history.
 *
 * Features: the vocabulary Feature below, each command and each expression kind a program reaches.
 */

import { defined } from "@bjornpagen/testing/assert"
import { runProgram } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import {
	applyWith,
	type Built,
	builtOf,
	draftNext,
	type Feature,
	initialOf,
	versionInstallation,
	machine,
	noClosedRows,
	noGenerated,
	real,
	removedHandles,
	runAims,
	runGen,
	sameAsModel,
	snapshotOf,
	type System
} from "#test/pg/fields/derived.fixtures.ts"
import { ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { type Declaration, holesOf } from "#test/support/closed/generate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftCodes, fromEmpty, fromSnapshot, noDeclarations } from "#test/support/migrate/kit.ts"
import { kept, reviewedSource } from "#test/support/pg/migrate/support.ts"
import {
	baseSubstrate,
	claimsOfNoFact,
	ownerSession,
	Substrate,
	worldSession
} from "#test/support/substrate/substrate.ts"

/** Generated fields on PostgreSQL 19 every generated column holds what the host evaluator computes from its row, PostgreSQL refuses a writer's value for one and an absent key, and a changed expression migrates in place. */
export const generatedFieldsOnPostgreSQL19EveryGeneratedColumnHoldsWhatTheHostEvaluatorComputesFromItsRowPostgreSQLRefusesAWritersValueForOneAndAnAbsentKeyAndAChangedExpressionMigratesInPlace =
	property.explore(aimed(runGen, runAims), {
		needs: { substrate2: Substrate.fresh(baseSubstrate) },
		situations: [
			"a roster with a hole",
			"a row written",
			"a row written under a literal set operand",
			"a row written under {tier} at a tier whose code is no position",
			"a row written under a ∪ {tier} at a tier whose code is no position",
			"a row written under Pair.row(tier) ∩ {tier} at a tier that pairs with itself and whose code is no position",
			"a write refused at an absent key",
			"an insert supplying a generated column refused",
			"an update of a generated column refused",
			"a generated field added over rows",
			"an addition refused at an absent key",
			"a generated field re-expressed over rows",
			"a generated field dropped",
			"closed rows changed under a closed read",
			"closed rows refused at an absent key",
			"nothing drafted"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 6, coverage cases 96 (derived.test.ts at 4fbc3e95). */
		budget: { runs: 6, steered: 96 },
		check:
			({ substrate2 }, kase: Case<Feature>) =>
			(run) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							if (holesOf(run.history.state).length > 0) {
								kase.note("a roster with a hole")
							}
							const initial = initialOf(run.history, run.closedRows, run.generated)
							const declarations = run.history.declarations
							/**
							 * The roster's history first; the closed rows, over the last declaration's handles, and the first
							 * generated fields only at the end.
							 */
							const versionOf = (name: string, declaration: Declaration, at: number): Built =>
								builtOf(
									name,
									at === declarations.length - 1
										? initial
										: { ...initial, closedRows: noClosedRows, generated: noGenerated },
									declaration
								)
							const substrate = yield* Substrate
							const declared = yield* substrate.schema({ create: false, label: "fields_derived" })
							const owner = yield* substrate.session({ ...ownerSession(), label: "owner" })
							const ambient = yield* ambientOwner(ordinarySession, [
								identifierOf(identity.schema(parsedSchemaName(declared)))
							])
							const builds = Arr.map(declarations, (d, i) => versionOf(declared, d, i))
							const first = Arr.headNonEmpty(builds)
							const installed = versionInstallation(
								first.version,
								declared,
								succeeded(
									draftCodes(first.version.schema, fromEmpty, noDeclarations),
									"the first version's codes"
								)
							)
							const installing: System = {
								m: { declared, owner, ownerLogin: ambient.credentials },
								writer: owner,
								previous: fromEmpty,
								names: installed.names,
								folders: [],
								drafts: 0
							}
							for (const [i, built] of builds.entries()) {
								const { g, names } = yield* draftNext(
									installing,
									built,
									i === 0
										? noDeclarations
										: removedHandles(
												defined(declarations[i - 1], "the declaration before"),
												defined(declarations[i], "the version's declaration")
											)
								)
								const folder = reviewedSource(g, kept)
								yield* applyWith(installing, [folder], g.snapshot)
								installing.folders.push(folder)
								installing.previous = fromSnapshot(g.snapshot)
								installing.names = names
							}
							const last = versionInstallation(
								Arr.lastNonEmpty(builds).version,
								declared,
								codebookOf(snapshotOf(installing))
							)
							const desk = defined(
								Arr.findFirst(last.worlds, (l) => l.name === "desk").pipe(Option.getOrUndefined),
								"the installation's login desk"
							)
							const writerRole = defined(
								Arr.findFirst(desk.roles, (r) => r.name === "writer").pipe(Option.getOrUndefined),
								"desk's role writer"
							)
							const deskLogin = yield* substrate.login(desk.role)
							const writer = yield* substrate.session({
								...worldSession({ login: deskLogin, role: writerRole.role }, claimsOfNoFact),
								label: "writer"
							})
							const sys: System = { ...installing, writer }
							yield* sameAsModel(sys, initial)
							yield* runProgram(
								machine(initial),
								real(sys, (f) => kase.note(f)),
								run.program
							)
						})
					),
					Substrate,
					Effect.map(substrate2, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the host evaluator and a naive model of each generation expression, against PostgreSQL's stored values; PostgreSQL's verdicts against the model's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\t\treturn Result.ok(new Set([...hostOf("bits", a(args))].filter((h) => y.has(h))))',
				replacement: '\t\t\t\treturn Result.ok(new Set([...hostOf("bits", a(args)), ...y]))',
				why: "The host evaluator's set intersection is the union."
			}
		]
	})
