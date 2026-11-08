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
 * The process environment, which Node reads as a thread or a process starts. NODE_V8_COVERAGE leaves it before any
 * test runs, so no thread or process the file starts, the testing library's watchdog thread among them, writes a dump
 * of its own that the process's end could cut short.
 */
const environment: Record<string, string | undefined> = process.env

Reflect.deleteProperty(environment, "NODE_V8_COVERAGE")

afterAll(takeFileCoverage)
