import { takeCoverage } from "node:v8"
import { afterAll } from "vitest"

/**
 * A coverage pass's record of one test file (main.ts coveragePass): Node writes a NODE_V8_COVERAGE dump only when its
 * process exits, and Vitest ends each test process with SIGTERM, on which it writes none, so the file's coverage is
 * taken once every test and hook of it has run. In a run without NODE_V8_COVERAGE, a mutant's, it writes nothing.
 */
const takeFileCoverage = (): void => takeCoverage()

afterAll(takeFileCoverage)
