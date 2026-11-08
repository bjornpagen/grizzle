import { stopCoverage, takeCoverage } from "node:v8"
import { afterAll } from "vitest"

/**
 * A coverage pass's record of one test file (main.ts coveragePass): what the file's own test process runs on its main
 * thread, written once, whole. Node writes a NODE_V8_COVERAGE dump only when a process or a thread exits, and Vitest
 * ends each test process with SIGTERM, which can cut short a dump being written, so the file's coverage is taken once
 * every test and hook of it has run, and collection then stops: the process's exit writes no second dump (Node says
 * on stderr that it found no coverage to write). In a run without NODE_V8_COVERAGE, a mutant's, it does nothing.
 */
const takeFileCoverage = (): void => {
	takeCoverage()
	stopCoverage()
}

/**
 * Removes NODE_V8_COVERAGE from the process environment, which Node reads as a thread or a process starts, before any
 * test runs: no thread or process the file starts, the testing library's watchdog thread among them, then writes a
 * dump of its own that the process's end could cut short.
 */
const dropCoverageVariable = (environment: Record<string, string | undefined>): void => {
	Reflect.deleteProperty(environment, "NODE_V8_COVERAGE")
}

dropCoverageVariable(process.env)

afterAll(takeFileCoverage)
