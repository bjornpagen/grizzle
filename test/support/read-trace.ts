/**
 * What a program read, as test/support/read-trace-probe.ts records it in a child Node process that imports it before
 * its entry point, and where it writes it: the file the variable READ_TRACE names.
 */

/** A read of the file system: the call, the absolute path it reads, and the module that called it. */
export type Read = {
	readonly call: string
	readonly path: string
	readonly by: string
}

/**
 * A reading of process.env or the clock: what was read, the module that read it, and whether the reading was Node's own
 * code (its first frame past this module's is Node's), as its module loader reads its variables for every module.
 */
export type Reading = {
	readonly name: string
	readonly by: string
	readonly node: boolean
}

/** What a process read, as the probe writes it at exit, and the process's id, which names its own scratch paths. */
export type ReadTrace = {
	readonly pid: number
	readonly loads: ReadonlyArray<string>
	readonly reads: ReadonlyArray<Read>
	readonly env: ReadonlyArray<Reading>
	readonly clock: ReadonlyArray<Reading>
}

/** The variable naming the file the trace is written to. */
export const traceVariable = "READ_TRACE"
