import { login } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { type WorkNamed, workReads, workWorlds } from "#test/support/fixtures/api/work.ts"

/**
 * The cold bench's login over the Work fixture named `installed`: `server`, holding Work's reader and writer, whose
 * workload serves the reader the four reads the database series measures. `grizzle generate` would commit its served
 * file; the bench compiles it in process with the same compile (bench/cold/run.ts), and the probe serves it as an
 * application does, by its type alone (ColdLogin).
 */
export const coldLogin = (installed: WorkNamed<string>) => {
	const { reader, writer } = workWorlds(installed)
	const reads = workReads(installed)
	return login(installed, "server", [reader, writer], {
		workload: [
			workload(reader, {
				automaticTasksFor: reads.automaticTasksFor,
				automaticBudgetFor: reads.automaticBudgetFor,
				taskCards: reads.taskCards,
				largestPerAccount: reads.largestPerAccount
			})
		]
	})
}

/** The cold bench's login, as the probe serves its file: a type alone, no schema module evaluated. */
export type ColdLogin = ReturnType<typeof coldLogin>
