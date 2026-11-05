import type { LawId } from "#compiler/core/ids.ts"
import {
	type Draft,
	type LawsFile,
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
	readonly file: SlotsFile | LawsFile
	readonly slots: ReadonlyArray<Slot>
}

const runsOf = (ordered: ReadonlyArray<Slot>): ReadonlyArray<FileRun> => {
	const runs: Array<{ readonly file: SlotsFile | LawsFile; readonly slots: Array<Slot> }> = []
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

interface FileHead {
	/** NN: 1 for the first file. */
	readonly ordinal: number
	readonly phase: DeployPhase
	/** `NN-<phase>.sql`. */
	readonly name: string
	readonly drafts: ReadonlyArray<Draft>
}

/** A file of its slots' steps, in one transaction or none, or of one residual law's, always in a transaction of its own. */
export type DraftFile =
	| (FileHead & { readonly scope: { readonly kind: "slots" }; readonly transaction: boolean })
	| (FileHead & {
			readonly scope: { readonly kind: "law"; readonly law: LawId }
			readonly transaction: true
	  })

/**
 * The digits a file's ordinal is written in, at least: `NN`, zero-padded.
 *
 * @formatConstant a migration file's name, `NN-<phase>.sql`: its ordinal in at least two digits
 */
const ordinalDigits = 2

const fileName = (ordinal: number, phase: DeployPhase): string =>
	`${String(ordinal).padStart(ordinalDigits, "0")}-${phase}.sql`

/** A file before it is numbered: its phase, its drafts, and how its head becomes the file. */
interface UnnumberedFile {
	readonly phase: DeployPhase
	readonly drafts: ReadonlyArray<Draft>
	readonly file: (head: FileHead) => DraftFile
}

/** The files one run of slots holds: one for a run of slots, one per residual law for the laws' run, in the order the
 * plan's steps validate the laws. */
const runFiles = (plan: MigrationPlan, run: FileRun): ReadonlyArray<UnnumberedFile> => {
	const { file } = run
	const steps = plan.steps.filter((s) => run.slots.includes(s.slot))
	switch (file.kind) {
		case "slots":
			return [
				{
					phase: file.phase,
					drafts: steps.map((s) => s.draft),
					file: (head) => ({ ...head, scope: { kind: "slots" }, transaction: file.transaction })
				}
			]
		case "laws": {
			const laws = steps.flatMap((s) => (s.slot === "validate.law" ? [s] : []))
			return [...new Set(laws.map((s) => s.law))].map((law): UnnumberedFile => ({
				phase: file.phase,
				drafts: laws.filter((s) => s.law === law).map((s) => s.draft),
				file: (head) => ({ ...head, scope: { kind: "law", law }, transaction: true })
			}))
		}
	}
}

/** The files of a plan, numbered in order: its steps grouped into the ordered files `NN-<phase>.sql` of one migration
 * folder, each with its transaction mode. Each slot names the file its steps go to (`slotFile`): a run of consecutive
 * slots naming one file is one file, the residual laws' slot one file per law in the plan's order. Files are numbered from
 * 01 in slot order, and a file is drafted only when it holds a statement.
 * An ordinary CREATE INDEX on a relation this migration creates is transactional and cheap, since the relation is
 * empty; only a relation that may hold rows needs the concurrent, no-transaction build. Each residual law validates in
 * its own transaction, so a violating law rolls back alone and the files before it stay applied, which is where
 * `grizzle migrate` resumes once the reviewer's data step has fixed the rows. */
export const planFiles = (plan: MigrationPlan): ReadonlyArray<DraftFile> =>
	fileRuns
		.flatMap((run) => runFiles(plan, run))
		.filter((f) => f.drafts.length > 0)
		.map((f, i) =>
			f.file({ ordinal: i + 1, phase: f.phase, name: fileName(i + 1, f.phase), drafts: f.drafts })
		)
