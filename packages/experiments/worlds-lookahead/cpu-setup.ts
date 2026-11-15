/**
 * A test process's CPU seconds (user, system) and its process's wall seconds, appended to $WORLDSCPU_CPU as
 * `<file>\t<user>\t<system>\t<wall>` once its tests end: a file's worker time, which a loaded machine's wall hides.
 */
import { appendFileSync } from "node:fs"
import { afterAll, expect } from "vitest"

const out = process.env.WORLDSCPU_CPU ?? "/dev/null"
const file = expect.getState().testPath ?? "unknown"
afterAll(() => {
	const cpu = process.cpuUsage()
	appendFileSync(
		out,
		`${file}\t${(cpu.user / 1e6).toFixed(1)}\t${(cpu.system / 1e6).toFixed(1)}\t${(performance.now() / 1e3).toFixed(1)}\n`
	)
})
