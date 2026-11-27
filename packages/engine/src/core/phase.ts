/**
 * The phases of a `grizzle generate` or `grizzle check`, in the order a run meets them, each reported at its start and
 * at its end when the command line asks (`--phases`), so a run that dies, out of memory or otherwise, names the phase
 * it died in:
 *
 * - `config`: the configuration file imported and resolved;
 * - `schema`: one configured schema's whole draft, or its check, of the schema it names;
 * - `build`: the schema's ownership and its logins' (cli/config.ts compileSchema);
 * - `basis`: the law model and the closed constants every installation of the schema is built over (installBasis);
 * - `workload`: the logins' workloads planned (planWorkload), and inside it `workloadLogin`, each login's programs;
 * - `changes`: the logins' ChangeSets compiled for their served files (servedWorkload), inside it `loginChanges`, each
 *   login's, inside that `frontEnd`, each ChangeSet of a role prepared, its front end and put targets, which decide
 *   whether it has a READ COMMITTED form, then `changeSet`, each ChangeSet of the role compiled at the role's level,
 *   READ COMMITTED, or SERIALIZABLE where a member has no READ COMMITTED form, then `certification`, every role's
 *   certificate, then `loginReads`, each login's reads compiled on every role they run on, whose plans the
 *   installation indexes;
 * - `installation`: the installation drafted (installationOver), inside it `installPlan`, its plan, `judge`, the checks
 *   of its rules over queries, and `indexes`, its index plan;
 * - `draft`: the migration planned from the previous snapshot, with the new snapshot; check renders its folder inside it;
 * - `served`: the logins' served files laid out under the draft's snapshot, inside it `servedLogin`, each login's;
 * - `render`: generate's folder of the draft rendered, once the served files are written;
 * - `write`: one schema's folder, snapshot and served files written.
 */
export const phaseNames = [
	"config",
	"schema",
	"build",
	"basis",
	"workload",
	"workloadLogin",
	"changes",
	"loginChanges",
	"frontEnd",
	"changeSet",
	"certification",
	"loginReads",
	"installation",
	"installPlan",
	"judge",
	"indexes",
	"draft",
	"served",
	"servedLogin",
	"render",
	"write"
] as const
export type PhaseName = (typeof phaseNames)[number]

/**
 * One phase of a run: its name, and what it is of, outermost first (the schema, login, role and ChangeSet it works on
 * beneath the phase that holds it); nothing for a phase of the whole run or of the schema the phase around it names.
 */
export interface Phase {
	readonly name: PhaseName
	readonly of: ReadonlyArray<string>
}

/** Where a report stands in its phase: before its work, or after it. */
export type PhaseEdge = "start" | "end"

/**
 * What a run reports its phases to, its caller's: the command line's, which writes a line with the process's readings
 * for each (cli/phases.ts), or silentPhases, which reports nothing.
 */
export interface Phases {
	readonly report: (phase: Phase, edge: PhaseEdge) => void
}

/** The reporter of a run whose phases nobody asked for: it reports nothing. */
export const silentPhases: Phases = { report: () => undefined }

/**
 * `run`, its start and its end reported to `phases` around it, and what it returned. A run that throws reports no end,
 * so the last phase started is the one it died in.
 */
export const phased = <A>(phases: Phases, phase: Phase, run: () => A): A => {
	phases.report(phase, "start")
	const result = run()
	phases.report(phase, "end")
	return result
}
