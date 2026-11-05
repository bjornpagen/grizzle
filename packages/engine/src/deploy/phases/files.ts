import {
	type Draft,
	type MigrationPlan,
	type Slot,
	type SlotsFile,
	slotFile,
	slots
} from "#compiler/deploy/diff/plan.ts"
import type { DeployPhase } from "#compiler/ir/products.ts"

/** The files of a plan before any is drafted: each run of consecutive slots naming one file (`slotFile`), in slot
 * order. */
interface FileRun {
	readonly file: SlotsFile
	readonly slots: ReadonlyArray<Slot>
}

const runsOf = (ordered: ReadonlyArray<Slot>): ReadonlyArray<FileRun> => {
	const runs: Array<{ readonly file: SlotsFile; readonly slots: Array<Slot> }> = []
	for (const slot of ordered) {
		const file = slotFile[slot]
		const last = runs.at(-1)
		if (last?.file === file) {
			last.slots.push(slot)
		} else {
			runs.push({ file, slots: [slot] })
		}
	}
	return runs
}
const fileRuns = runsOf(slots)

/** A file of its slots' steps, in one transaction or none. */
export interface DraftFile {
	/** NN: 1 for the first file. */
	readonly ordinal: number
	readonly phase: DeployPhase
	/** `NN-<phase>.sql`. */
	readonly name: string
	readonly drafts: ReadonlyArray<Draft>
	readonly transaction: boolean
}

/**
 * The digits a file's ordinal is written in, at least: `NN`, zero-padded.
 *
 * @formatConstant a migration file's name, `NN-<phase>.sql`: its ordinal in at least two digits
 */
const ordinalDigits = 2

const fileName = (ordinal: number, phase: DeployPhase): string =>
	`${String(ordinal).padStart(ordinalDigits, "0")}-${phase}.sql`

/** The files of a plan, numbered in order: its steps grouped into the ordered files `NN-<phase>.sql` of one migration
 * folder, each with its transaction mode. Each slot names the file its steps go to (`slotFile`): a run of consecutive
 * slots naming one file is one file. Files are numbered from 01 in slot order, and a file is drafted only when it holds
 * a statement. An ordinary CREATE INDEX on a relation this migration creates is transactional and cheap, since the
 * relation is empty; only a relation that may hold rows needs the concurrent, no-transaction build. */
export const planFiles = (plan: MigrationPlan): ReadonlyArray<DraftFile> =>
	fileRuns
		.map((run) => ({
			file: run.file,
			drafts: plan.steps.filter((s) => run.slots.includes(s.slot)).map((s) => s.draft)
		}))
		.filter((f) => f.drafts.length > 0)
		.map((f, i) => ({
			ordinal: i + 1,
			phase: f.file.phase,
			name: fileName(i + 1, f.file.phase),
			drafts: f.drafts,
			transaction: f.file.transaction
		}))
