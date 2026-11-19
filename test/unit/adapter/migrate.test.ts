/**
 * The apply runner's pure parts (adapter/migrate): the input check before any connection, transaction-control refusal,
 * and the plan with its resume and refusals. The drift check after an apply is test/pg/admission's.
 *
 * - **Transaction control:** a statement is refused exactly when PostgreSQL's grammar reads it as controlling a
 *   transaction, past comments of both kinds, its keywords in any case.
 * - **The input check:** a target of a prefix of the shop's chain parses into its folders in name order, each file at
 *   its ordinal with its transaction mode; one fault planted at a drawn folder is refused at stage input with exactly
 *   that fault, at that folder.
 * - **The plan:** against a ledger of applied folders, the plan resumes the partial folder at its first file without a
 *   row, applies the rest, and refuses an applied file edited, renamed or deleted, or a file added to a completed
 *   folder, naming every such file. A partial folder redrafted since it started resumes under the redraft, its ledger
 *   rows to take the redraft's meta.json digest and target, when it keeps its source and file count, its meta.json
 *   records every completed file as it ran, and the file it resumes at runs in a transaction; otherwise it is refused.
 *
 * A folder's files as the reviewer leaves them: unedited, or each file's text through `edit`.
 *
 * Oracles: PostgreSQL's grammar of transaction control, per statement form; the documented input faults and the plan's
 * documented resume and refusals, restated over the drawn target and ledger.
 *
 * Features: each statement form and comment placement; each input fault; each plan's resume and refusal.
 */

import { inspect } from "node:util"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import {
	folderSource,
	type ParsedTarget,
	parseTarget,
	transactionControl
} from "#adapter/migrate/input.ts"
import { planApply, runFiles } from "#adapter/migrate/plan.ts"
import { indices } from "#compiler/core/array.ts"
import type { LedgerState, RecordedFolder } from "#compiler/deploy/ledger/ledger.ts"
import { emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { assert, defined, failed, succeeded } from "#test/support/assert.ts"
import { draftFiles } from "#test/support/migrate/review.ts"
import {
	chainOf,
	holdsDatabaseWide,
	type ControlFeature,
	emptyShop,
	gaps,
	inputCaseGen,
	type InputFeature,
	lossFiles,
	marked,
	type PartialFolder,
	partialOf,
	planCases,
	type PlanFeature,
	plantedFolders,
	type PlanVerdict,
	recordedOf,
	reviewedText,
	reviewedSource,
	type RunVerdict,
	shop,
	shopChain,
	source,
	statementGen,
	drawnStatementText,
	stemsInstallation,
	underDraft,
	unedited,
	unrecordedStatement
} from "#test/unit/adapter/migrate.fixtures.ts"

/**
 * Transaction control in a migration file refuses exactly the statements PostgreSQL's grammar reads as controlling a
 * transaction, past comments of both kinds.
 *
 * Budget: its suite's count before the conversion (unit/adapter/transaction-control: 600 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const transactionControlInAMigrationFileRefusesExactlyTheStatementsPostgreSQLsGrammarReadsAsControllingATransactionPastCommentsOfBothKinds =
	property.explore(statementGen, {
		needs: {},
		situations: [
			"BEGIN",
			"START TRANSACTION",
			"COMMIT",
			"COMMIT PREPARED",
			"END",
			"ABORT",
			"ROLLBACK",
			"ROLLBACK PREPARED",
			"PREPARE TRANSACTION",
			"SAVEPOINT",
			"RELEASE",
			"ROLLBACK TO",
			"PREPARE a statement",
			"DO a block that commits",
			"a plain statement",
			"a keyword continued past its letters",
			"a line comment ended by a lone carriage return before a part",
			"a nested block comment before a part",
			"a comment between two parts"
		] satisfies ReadonlyArray<Reached<ControlFeature>>,
		check: (_, c: Case<ControlFeature>) => (d) =>
			Effect.sync(() => {
				const text = drawnStatementText(d)
				assert.equal(transactionControl(text), d.form.control, inspect(text))
				c.note(d.form.name)
				const pieces = gaps(d).flat()
				if (Arr.some(pieces, (p) => p.kind === "line ended by a lone carriage return")) {
					c.note("a line comment ended by a lone carriage return before a part")
				}
				if (Arr.some(pieces, (p) => p.kind === "nested block")) {
					c.note("a nested block comment before a part")
				}
				if (Arr.some(gaps(d).slice(1), (g) => Arr.some(g, (p) => p.kind !== "space"))) {
					c.note("a comment between two parts")
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's grammar of transaction control (gram.y TransactionStmt), per statement form"
		},
		budget: { runs: 600, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/input.ts",
				original:
					'\t\t\tconst next = wordOf(second) === "WORK" || wordOf(second) === "TRANSACTION" ? third : second',
				replacement: '\t\t\tconst next = wordOf(second) === "TRANSACTION" ? third : second',
				why: "ROLLBACK WORK TO is read as a transaction's rollback; the transaction control property fails."
			}
		]
	})

/**
 * The input check before any connection orders the folders by name and the files by ordinal with each one's mode, and
 * refuses each fault planted in them at stage input, naming it.
 *
 * Budget: its suite's count before the conversion (unit/adapter/migrate-input: 150 independent cases and 16 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theInputCheckBeforeAnyConnectionOrdersTheFoldersByNameAndTheFilesByOrdinalWithEachOnesModeAndRefusesEachFaultPlantedInThemAtStageInputNamingIt =
	property.explore(inputCaseGen, {
		needs: {},
		situations: [
			"the empty snapshot with no folders",
			"folders handed over out of order",
			"a file outside a transaction",
			"refused folderName",
			"refused repeatedFolder",
			"refused malformedMeta",
			"refused foreignMeta",
			"refused repeatedFile",
			"refused metaAmongFiles",
			"refused fileNames",
			"refused transactionControl"
		] satisfies ReadonlyArray<Reached<InputFeature>>,
		check: (_, k: Case<InputFeature>) => (c) =>
			Effect.sync(() => {
				const drafts = Arr.take(shopChain, c.versions)
				const handed = Arr.map(c.order, (i) => {
					const g = defined(drafts[i], "a version's draft")
					return source(g.folder, c.reviewed[i] === true ? reviewedText : unedited)
				})
				const snapshot = Option.match(Arr.last(drafts), {
					onNone: () => emptyShop,
					onSome: (g) => g.snapshot
				})
				const planted = plantedFolders(handed, c.fault)
				const parsed = parseTarget(
					{ snapshot, folders: Arr.map(planted.folders, folderSource) },
					stemsInstallation
				)
				if (planted.refusal !== undefined) {
					const reason = failed(parsed).reason
					assert.deepEqual(
						{
							stage: failed(parsed).stage,
							fault: reason._tag === "InputRefused" ? reason.fault.kind : reason._tag,
							folder:
								reason._tag === "InputRefused" && reason.fault.kind !== "repeatedSchema"
									? reason.fault.folder
									: undefined
						},
						{ stage: "input", fault: planted.refusal.kind, folder: planted.refusal.folder }
					)
					k.note(`refused ${planted.refusal.kind}`)
					return
				}
				const target = succeeded(parsed)
				assert.deepEqual(
					Arr.map(target.folders, (f) => ({
						name: f.name,
						files: Arr.map(
							f.files,
							(file) => [file.name, file.ordinal, file.noTransaction] as const
						)
					})),
					Arr.map(drafts, (g) => ({
						name: g.folder.name,
						files: Arr.map(draftFiles(g), (d, i) => [d.name, i + 1, !d.transaction] as const)
					}))
				)
				if (c.versions === 0) {
					k.note("the empty snapshot with no folders")
				}
				if (Arr.some(c.order, (position, i) => position !== i)) {
					k.note("folders handed over out of order")
				}
				if (Arr.some(target.folders, (f) => Arr.some(f.files, (file) => file.noTransaction))) {
					k.note("a file outside a transaction")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the chain's drafts in name order, each fault's refusal planted at its folder"
		},
		budget: { runs: 150, steered: 16 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/build.ts",
				original: `\t\twrite(members, \`\${JSON.stringify(key)}: \`, member, i === entries.length - 1 ? "" : ",")`,
				replacement: `\t\twrite(members, \`\${JSON.stringify(key)}: \`, member, i === entries.length - 1 ? "," : "")`,
				why: 'Operator mutant (arm-swap) at packages/engine/src/deploy/snapshot/build.ts:1305 in nestedValue: `i === entries.length - 1 ? "" : ","` becomes `i === entries.length - 1 ? "," : ""`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})

/**
 * The plan: skip, resume, run, or refuse before any statement runs exactly the folders the ledger has not applied,
 * resuming the partial one, or refuses in the documented order.
 *
 * Budget: its suite's count before the conversion (unit/adapter/migrate-plan: 200 independent cases and 64 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const thePlanSkipResumeRunOrRefuseBeforeAnyStatementRunsExactlyTheFoldersTheLedgerHasNotAppliedResumingThePartialOneOrRefusesInTheDocumentedOrder =
	property.explore(planCases, {
		needs: {},
		situations: [
			"every folder run from the empty snapshot",
			"the applied folders skipped",
			"a partial folder resumed",
			"a partial folder resumed under a redraft of another target",
			"a partial folder resumed under a redraft of its target",
			"a partial folder resumed under a redraft past a database-wide statement",
			"a redraft of another source refused",
			"a redraft not recording a completed file refused",
			"a partial folder of another file count refused",
			"a redraft resuming at a no-transaction file refused",
			"a folder started after a resumed one",
			"nothing to run",
			"refused AppliedEdited",
			"refused FolderRefused",
			"refused SnapshotUnreached",
			"refused MarkersUnresolved",
			"refused LossesUndecided"
		] satisfies ReadonlyArray<Reached<PlanFeature>>,
		check: (_2, k: Case<PlanFeature>) => (c) =>
			Effect.sync(() => {
				const chain = chainOf(c.chain)
				const partial = partialOf(c)
				/** Every folder as the reviewer left it, the extra statement of the partial folder's file in it. */
				const sources = Arr.map(chain, (g, i) => {
					const reviewed = reviewedSource(c, g.folder, i)
					const extra = partial?.index === i ? partial.extra : Option.none()
					return Option.match(extra, {
						onNone: () => reviewed,
						onSome: (at) => ({
							...reviewed,
							files: Arr.map(reviewed.files, (f, j) =>
								j === at ? { ...f, text: `${f.text}${unrecordedStatement}` } : f
							)
						})
					})
				})
				/** Every folder as it ran, which the ledger's digests record. */
				const ran = succeeded(
					parseTarget(
						{
							snapshot: defined(Arr.last(chain).pipe(Option.getOrUndefined), "a draft").snapshot,
							folders: Arr.map(sources, folderSource)
						},
						stemsInstallation
					)
				).folders
				const recordedFolders = [
					...Arr.map(Arr.take(ran, c.complete), (f) => ({
						folder: f,
						files: f.files.length
					})),
					...(partial === undefined
						? []
						: [{ folder: defined(ran[partial.index]), files: partial.recorded }])
				]
				/** The recorded folder whose ledger rows name the empty snapshot as its target, which none of the
				 * chain's folders targets. */
				const moved =
					c.edit.kind === "a recorded folder of another target" && recordedFolders.length > 0
						? c.edit.pick % recordedFolders.length
						: undefined
				const recordedAt = (
					i: number,
					folder: ParsedTarget["folders"][number],
					files: number
				): RecordedFolder =>
					i === moved
						? { ...recordedOf(folder, files), target: emptyFingerprint(shop) }
						: recordedOf(folder, files)
				const state: LedgerState = {
					latest:
						c.complete === 0
							? emptyFingerprint(shop)
							: defined(ran[c.complete - 1], "the latest complete folder").meta.target,
					complete: Arr.map(Arr.take(ran, c.complete), (f, i) => recordedAt(i, f, f.files.length)),
					partial:
						partial === undefined
							? undefined
							: underDraft(
									partial,
									recordedAt(partial.index, defined(ran[partial.index]), partial.recorded)
								)
				}
				/** The edit, resolved: the recorded file it edits, or the complete folder a file is added to. */
				const recordedFiles = Arr.flatMap(recordedFolders, ({ folder, files }) =>
					Arr.map(Arr.take(folder.files, files), (f) => ({
						folder: folder.name,
						file: f.name
					}))
				)
				const edit = c.edit
				const edited =
					edit.kind === "a recorded file edited" && recordedFiles.length > 0
						? defined(recordedFiles[edit.pick % recordedFiles.length])
						: undefined
				const added =
					edit.kind === "a file added to a complete folder" && c.complete > 0
						? defined(ran[edit.pick % c.complete]).name
						: undefined
				const heldSources = Arr.filter(sources, (_, i) => c.held[i] === true)
				const target = Arr.map(heldSources, (folder) => ({
					...folder,
					files: [
						...Arr.map(folder.files, (f) =>
							edited !== undefined && edited.folder === folder.name && edited.file === f.name
								? { ...f, text: `${f.text}\n-- edited after it ran\n` }
								: f
						),
						...(added === folder.name
							? [
									{
										name: `${Str.padStart(2, "0")(String(folder.files.length + 1))}-added.sql`,
										text: "SELECT 1;\n"
									}
								]
							: [])
					]
				}))
				const known: DeploySnapshot =
					c.known < 0 ? emptyShop : defined(chain[c.known], "the known version").snapshot
				/** The model's notes of the partial folder's decision. */
				const notes: Array<PlanFeature> = []
				/** Whether a redraft fails to record a completed file of the partial folder as it ran: one ran with a
				 * statement no draft records, or holds a loss its reviewer left commented. */
				const unrecorded = (p: PartialFolder): boolean => {
					const drafted = defined(chain[p.index], "the partial folder").folder
					const losses = lossFiles(drafted)
					return (
						Option.isSome(p.extra) ||
						(c.chain === "a first migration beside an abandoned schema" &&
							c.reviewed[p.index] !== true &&
							Arr.some(Arr.take(drafted.files, p.recorded), (f) => Arr.contains(losses, f.name)))
					)
				}
				const verdict = ((): PlanVerdict => {
					const recordedIndices = [
						...indices(c.complete),
						...(partial === undefined ? [] : [partial.index])
					]
					if (
						Arr.some(recordedIndices, (i) => c.held[i] !== true) ||
						(edited !== undefined &&
							Arr.some(
								recordedIndices,
								(i) => c.held[i] === true && defined(ran[i]).name === edited.folder
							)) ||
						(added !== undefined &&
							Arr.some(
								indices(c.complete),
								(i) => c.held[i] === true && defined(ran[i]).name === added
							))
					) {
						return { kind: "refused", reason: "AppliedEdited" }
					}
					const runs: Array<{ readonly index: number; readonly run: RunVerdict }> = []
					let latest = c.complete - 1
					for (const i of indices(chain.length)) {
						const redrafted = partial?.index === i && partial.draft.kind === "a redraft"
						if (i === moved && c.held[i] === true && !redrafted) {
							return { kind: "refused", reason: "FolderRefused" }
						}
						if (c.held[i] !== true || i < c.complete) {
							continue
						}
						const folder = defined(ran[i])
						const ordinals = Arr.map(folder.files, (f) => f.ordinal)
						if (partial?.index === i) {
							const draft = partial.draft
							const run = Arr.drop(ordinals, partial.recorded)
							if (draft.kind === "a redraft" && draft.source === "another") {
								notes.push("a redraft of another source refused")
								return { kind: "refused", reason: "FolderRefused" }
							}
							if (partial.files === "one more") {
								notes.push("a partial folder of another file count refused")
								return { kind: "refused", reason: "FolderRefused" }
							}
							if (draft.kind === "its own") {
								runs.push({
									index: i,
									run: { folder: folder.name, kind: "resume", ordinals: run }
								})
							} else if (unrecorded(partial)) {
								notes.push("a redraft not recording a completed file refused")
								return { kind: "refused", reason: "FolderRefused" }
							} else if (folder.files[partial.recorded]?.noTransaction === true) {
								notes.push("a redraft resuming at a no-transaction file refused")
								return { kind: "refused", reason: "FolderRefused" }
							} else {
								runs.push({
									index: i,
									run: {
										folder: folder.name,
										kind: "redraft",
										ordinals: run,
										record: { meta: folder.metaDigest, target: folder.meta.target }
									}
								})
							}
						} else if (i === latest + 1) {
							runs.push({ index: i, run: { folder: folder.name, kind: "start", ordinals } })
						} else {
							return { kind: "refused", reason: "FolderRefused" }
						}
						latest = i
					}
					if (latest !== c.known) {
						return { kind: "refused", reason: "SnapshotUnreached" }
					}
					const runText = ({ index, run }: (typeof runs)[number]) =>
						Arr.flatMap(defined(ran[index]).files, (f) =>
							Arr.contains(run.ordinals, f.ordinal) ? [f.text] : []
						)
					if (Arr.some(runs, (run) => Arr.some(runText(run), marked))) {
						return { kind: "refused", reason: "MarkersUnresolved" }
					}
					if (
						c.chain === "a first migration beside an abandoned schema" &&
						Arr.some(runs, (run) => c.reviewed[run.index] !== true)
					) {
						return { kind: "refused", reason: "LossesUndecided" }
					}
					return {
						kind: "plan",
						runs: Arr.map(runs, ({ run }) => run),
						after: known.fingerprint
					}
				})()
				const parsed = succeeded(
					parseTarget(
						{ snapshot: known, folders: Arr.map(target, folderSource) },
						stemsInstallation
					)
				)
				const planned = planApply(parsed, state)
				if (verdict.kind === "refused") {
					const refusal: MigrateError = failed(planned)
					assert.equal(refusal.reason._tag, verdict.reason)
					k.note(`refused ${verdict.reason}`)
					Arr.forEach(notes, (n) => k.note(n))
					return
				}
				const plan = succeeded(planned)
				assert.deepEqual<PlanVerdict>(
					{
						kind: "plan" as const,
						runs: Arr.map(plan.runs, (r): RunVerdict => {
							const ordinals = Arr.map(runFiles(r), (f) => f.ordinal)
							return r.kind === "redraft"
								? { folder: r.folder.name, kind: r.kind, ordinals, record: r.record }
								: { folder: r.folder.name, kind: r.kind, ordinals }
						}),
						after: plan.after
					},
					verdict
				)
				if (plan.runs.length === 0) {
					k.note("nothing to run")
				}
				if (
					c.complete === 0 &&
					partial === undefined &&
					plan.runs.length === chain.length &&
					chain.length > 1
				) {
					k.note("every folder run from the empty snapshot")
				}
				if (c.complete > 0 && plan.runs.length > 0) {
					k.note("the applied folders skipped")
				}
				if (Arr.some(plan.runs, (r) => r.kind === "resume")) {
					k.note("a partial folder resumed")
				}
				for (const r of plan.runs) {
					if (r.kind === "redraft") {
						k.note(
							state.partial?.target === r.record.target
								? "a partial folder resumed under a redraft of its target"
								: "a partial folder resumed under a redraft of another target"
						)
						if (
							partial !== undefined &&
							holdsDatabaseWide(Arr.take(defined(ran[partial.index]).files, partial.recorded))
						) {
							k.note("a partial folder resumed under a redraft past a database-wide statement")
						}
					}
				}
				if (
					Arr.some(plan.runs, (r) => r.kind !== "start") &&
					Arr.some(plan.runs, (r) => r.kind === "start")
				) {
					k.note("a folder started after a resumed one")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the planner's documented order, restated over the chain's positions"
		},
		budget: { runs: 200, steered: 64 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/plan.ts",
				original: "\t\t\treturn file.value.digest === row.digest",
				replacement: "\t\t\treturn file.value.ordinal === row.ordinal",
				why: "An applied file edited afterwards goes unnoticed (its ledger row is compared by ordinal, not by digest); the plan's property fails."
			},
			{
				file: "packages/engine/src/deploy/ledger/decide.ts",
				original: "\tif (partial.source !== folder.meta.source) {",
				replacement:
					"\tif (partial.source !== folder.meta.source && partial.meta === folder.metaDigest) {",
				why: "A redraft of another source resumes; the plan's property fails."
			},
			{
				file: "packages/engine/src/deploy/ledger/decide.ts",
				original: "\t\t(f) => done.has(f.ordinal) && !recordsAsWritten(folder.meta, f)",
				replacement:
					'\t\t(f) => done.has(f.ordinal) && !recordsAsWritten(folder.meta, f) && folder.meta.kind === "custom"',
				why: "A redraft whose meta.json does not record a completed file as it ran resumes, unless it is a custom folder's; the plan's property fails."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/plan.ts",
				original: "\t\t...(state.partial === undefined ? [] : editsOf(state.partial, () => []))",
				replacement:
					"\t\t...(state.partial === undefined ? [] : editsOf({ ...state.partial, completed: [] }, () => []))",
				why: "The partial folder's completed files are not compared with the texts that ran; the plan's property fails."
			},
			{
				file: "packages/engine/src/deploy/ledger/decide.ts",
				original: "\treturn next?.noTransaction === true",
				replacement: '\treturn next?.noTransaction === true && next.name === ""',
				why: "A redraft resumes at a no-transaction file; the plan's property fails."
			},
			{
				file: "packages/engine/src/deploy/render/sql.ts",
				original:
					"\treturn [{ above, write: first }, ...rest.map((write): Spelled => ({ above: [], write }))]",
				replacement:
					"\treturn [\n\t\t{\n\t\t\tabove,\n\t\t\twrite: (out) => {\n\t\t\t\tlet pending = first\n\t\t\t\tfor (const next of rest) {\n\t\t\t\t\tterminated(out, pending)\n\t\t\t\t\tpending = next\n\t\t\t\t}\n\t\t\t\tpending(out)\n\t\t\t}\n\t\t}\n\t]",
				why: "meta.json records a statement of two commands (a database-wide statement and its database lock) as one text, so a drafted file no longer records as it is written; the plan's property fails."
			}
		]
	})
