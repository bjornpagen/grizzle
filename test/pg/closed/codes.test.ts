/**
 * A set of closed ids on PostgreSQL 19, judged against A8's model of its roster's history
 * (test/support/closed/generate.ts), a list of code slots replayed command by command that shares no code with the
 * engine's codebook: a set round-trips through its bit(n) column, n its codes rounded up to whole bytes: the text the
 * writer sends is X then the hex digits of the model's positional text (setText), PostgreSQL stores the positional
 * text, and the host decodes it to the set sent. After the roster grows, the column is a domain over bit(n′), every
 * stored set padded with 0s to it, and decodes unchanged; after a removal, VALIDATE names the column of every set that
 * still holds the removed handle, the data step clears its bit, and the domain then refuses a set holding it.
 *
 * Features: the bits histories' growth past and within a byte, a removal refused until its data step, and two
 * migrations.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import { type Codebook } from "#compiler/ir/codes.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { setText, setWidth } from "#test/support/closed/bit-text.ts"
import { type RosterState, codeAt, sizeOf } from "#test/support/closed/generate.ts"
import { asDataStep } from "#test/support/data-step.ts"
import { roleNamesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import {
	applyNext,
	type BitsFeature,
	bitsHistories,
	columnTypeOf,
	domainCheckOf,
	type Drafted,
	draftNext,
	installFirst,
	membersOf,
	modelText,
	serverOf,
	sessionOf,
	setsOf,
	setType,
	sortedHandles,
	stepped,
	subsetsOf,
	wireText
} from "#test/support/pg/closed/codes.fixtures.ts"
import { expectConstraint, inTransaction } from "#test/support/substrate/expect.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * A set round-trips through its bit(n) column, decodes unchanged after its roster grows, and a removed handle's bit
 * fails VALIDATE until the data step clears it, each case installing its own history on a clone of its own, as each
 * case of the search did.
 *
 * Its pre-conversion budget: runs 4, coverage cases 12 (test/pg/closed/codes.test.ts at 5124bea5d).
 */
export const aSetRoundTripsThroughItsBitColumnDecodesUnchangedAfterGrowthAndARemovedBitFailsValidateUntilTheDataStep =
	property.explore(bitsHistories, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a growth past a byte",
			"a growth within a byte",
			"a removal refused until the data step",
			"two migrations"
		] satisfies ReadonlyArray<Reached<BitsFeature>>,
		check:
			({ substrate }, k: Case<BitsFeature>) =>
			(history) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const { m, first } = yield* installFirst("closed_codes_bits", (name) =>
								setsOf(name, history.installed)
							)
							const writer = yield* sessionOf(m, first.writer, "writer")
							const reader = yield* sessionOf(m, first.reader, "reader")
							const view = roleNamesOf(m, first.reader)
							const table = printObjectName(m.names.relation("Sets"))
							const id = quoteIdent(m.names.column("Sets", "id"))
							const members = quoteIdent(m.names.column("Sets", "members"))
							/** Every stored set, by id, as PostgreSQL's text. */
							const storedTexts = Effect.map(
								m.owner.values(`SELECT ${members}::text FROM ${table} ORDER BY ${id}`, []),
								Arr.map((r) => String(r[0]))
							)
							/** Every set written so far, by id, as the model holds it: its live handles. */
							let stored: ReadonlyArray<ReadonlyArray<string>> = []
							/** Writes every subset of `state`'s live handles after the stored ones, sent as the host encodes them. */
							const writeEvery = (state: RosterState, codes: Codebook) =>
								Effect.gen(function* () {
									const codec = scalarCodec(setType(state), codes)
									const sets = subsetsOf(state)
									yield* writer.begin
									for (const [i, set] of sets.entries()) {
										const text = succeeded(codec.encode(new Set(set)), "a set of live handles")
										assert.equal(
											text,
											wireText(state, set),
											`the wire text of ${Formatter.format(set)}`
										)
										yield* writer.query(
											`INSERT INTO ${table} (${id}, ${members}) VALUES ($1::integer, $2::text::bit(${setWidth(sizeOf(state))}))`,
											[stored.length + i, text]
										)
									}
									yield* writer.commit
									stored = [...stored, ...Arr.map(sets, sortedHandles)]
									const texts = yield* storedTexts
									assert.deepEqual(
										Arr.drop(texts, texts.length - sets.length),
										Arr.map(sets, (set) => modelText(state, set)),
										"PostgreSQL stores each set's positional text"
									)
									assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
										decodes(state, codes, texts),
										stored,
										"every stored set decodes to its live handles"
									)
								})
							const decodes = (state: RosterState, codes: Codebook, texts: ReadonlyArray<string>) =>
								Arr.map(texts, (t) =>
									membersOf(scalarReader(setType(state), codes).convert(outputText(t)))
								)
							yield* writeEvery(history.installed, codebookOf(m.snapshot))
							const viewed = yield* reader.values(
								`SELECT v.${view.column("Sets", "members")}::text FROM ${view.view("Sets")} AS v ORDER BY v.${view.column("Sets", "id")}`,
								[]
							)
							const installedTexts = yield* storedTexts
							assert.deepEqual(
								Arr.map(viewed, (r) => String(r[0])),
								installedTexts,
								"the view reads the stored sets"
							)
							let before = history.installed
							let snapshot = m.snapshot
							const drafted: Array<Drafted> = []
							for (const [i, step] of history.steps.entries()) {
								const after = stepped(before, step)
								const next = yield* draftNext(
									m,
									snapshot,
									setsOf(m.declared, after).version,
									i + 2,
									step.kind === "remove"
										? {
												renames: [],
												drops: [{ kind: "handle", roster: after.closed, handle: step.handle }]
											}
										: noDeclarations
								)
								drafted.push(next)
								const textsBefore = yield* storedTexts
								if (step.kind === "remove") {
									/** Every subset was written, so a stored set holds the removed handle. */
									const failure = yield* Effect.flip(applyNext(m, drafted))
									const server = serverOf(failure)
									assert.deepEqual(
										{ sqlstate: server.sqlstate, table: server.table, column: server.column },
										{
											sqlstate: sqlstates.checkViolation,
											table: m.names.relation("Sets").name,
											column: m.names.column("Sets", "members")
										},
										"VALIDATE names the column of the sets that still hold the removed handle"
									)
									assert.ok(
										Str.includes("change or delete those rows in a data step first")(
											failure.message
										),
										`the refusal names its data step, before the migration or outside it: ${failure.message}`
									)
									/** A person's data step between the attempts, in a transaction of its own as a data step over
									 * Sets (data-step.ts asDataStep), the one way a closed relation's rows are removed: each set
									 * deleted and inserted again with the removed bit cleared, its mask spelled as a literal. */
									const live = setText(
										sizeOf(after),
										Arr.flatMap(after.slots, (slot, code) => (slot.kind === "live" ? [code] : []))
									)
									const dataStep = `WITH gone AS (DELETE FROM ${table} RETURNING ${id}, ${members}) INSERT INTO ${table} (${id}, ${members}) SELECT ${id}, ${members} & B'${live}'::bit(${setWidth(sizeOf(after))}) FROM gone`
									yield* m.owner.begin
									for (const sql of asDataStep(m.installation, [dataStep])) {
										yield* m.owner.query(sql, [])
									}
									yield* m.owner.commit
									k.note("a removal refused until the data step")
								}
								yield* applyNext(m, drafted)
								const afterType = yield* columnTypeOf(
									m.owner,
									table,
									m.names.column("Sets", "members")
								)
								assert.deepEqual(
									{ kind: afterType.kind, base: afterType.base },
									{ kind: "d", base: `bit(${setWidth(sizeOf(after))})` },
									"the column is a domain over bit(n), n the roster's codes in whole bytes"
								)
								const textsAfter = yield* storedTexts
								if (step.kind === "grow") {
									assert.deepEqual(
										textsAfter,
										Arr.map(textsBefore, (t) => Str.padEnd(setWidth(sizeOf(after)), "0")(t)),
										"the widening pads every stored set with the new code absent"
									)
									k.note(
										setWidth(sizeOf(after)) > setWidth(sizeOf(before))
											? "a growth past a byte"
											: "a growth within a byte"
									)
								} else {
									stored = Arr.map(stored, (set) => Arr.filter(set, (h) => h !== step.handle))
									const check = yield* domainCheckOf(m.owner, afterType.domain)
									const fields = yield* expectConstraint(
										inTransaction(
											writer,
											writer.query(
												`INSERT INTO ${table} (${id}, ${members}) VALUES ($1::integer, $2::text::bit(${setWidth(sizeOf(after))}))`,
												[-1, setText(sizeOf(after), [defined(codeAt(before, step.handle))])]
											)
										),
										check,
										"23514"
									)
									yield* writer.rollback
									assert.deepEqual(
										fields.dataType,
										Option.some(afterType.domain.name),
										"the bits domain refuses a set holding the removed handle"
									)
								}
								assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
									decodes(after, next.codes, textsAfter),
									stored,
									"every stored set decodes to its live handles under the step's codes"
								)
								yield* writeEvery(after, next.codes)
								before = after
								snapshot = next.snapshot
							}
							if (history.steps.length > 1) {
								k.note("two migrations")
							}
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the history model's positional text of each set, and its live handles after each step"
		},
		show: Formatter.format,
		budget: { runs: 4, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/errors.ts",
				original: '\t\t? "; change or delete those rows in a data step first',
				replacement: '\t\t? "; those rows',
				why: "A VALIDATE refused by rows holding a removed code names no data step: the person is never told to change those rows first, or outside the migration by delete and insert."
			}
		]
	})
