import { registerHooks, syncBuiltinESMExports } from "node:module"
import { fileURLToPath } from "node:url"
import { type Json, jsonText, utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"
import { type Read, type Reading, type ReadTrace, traceVariable } from "#test/support/read-trace.ts"

/**
 * What a program reads, recorded by a child Node process that imports this module before its entry point
 * (test/unit/cli/draft-key.test.ts, a real `grizzle generate` under it):
 *
 *   READ_TRACE=<file> node --import test/support/read-trace-probe.ts <entry point> <arguments>
 *
 * Before the entry point loads, it wraps every call of node:fs and node:fs/promises that reads the file system (a
 * file's bytes, a directory's entries, a path's presence or status, where a link points), puts process.env behind a
 * proxy that records each variable read by name, and wraps every reading of the clock (Date.now, a Date made of no
 * value or Date() called, performance.now, process.hrtime); and it records the URL of every module Node loads, whose
 * reads Node's loader makes itself, outside node:fs. Each read, variable and clock reading is recorded with the
 * module that made it: the first frame of its stack in a file, past Node's own and this module's, each distinct one once.
 * As the process exits it writes their JSON to the file the variable READ_TRACE names, which it reads before it puts
 * process.env behind its proxy.
 */

/** node:fs's calls that read the file system, each also under its Sync name; open reads unless its flags write. */
const fsReads = [
	"readFile",
	"readdir",
	"opendir",
	"stat",
	"lstat",
	"statfs",
	"exists",
	"access",
	"realpath",
	"readlink",
	"glob",
	"createReadStream",
	"open"
] as const

/** node:fs/promises' calls that read the file system; open reads unless its flags write. */
const promiseReads = [
	"readFile",
	"readdir",
	"opendir",
	"stat",
	"lstat",
	"statfs",
	"access",
	"realpath",
	"readlink",
	"glob",
	"open"
] as const

const here = import.meta.url

/** The stack frames of a call, past this module's own: each frame's line. */
const frames = (): ReadonlyArray<string> => {
	const limit = Error.stackTraceLimit
	Error.stackTraceLimit = 64
	const stack = new Error().stack ?? ""
	Error.stackTraceLimit = limit
	return Arr.filter(Arr.drop(Str.split(stack, "\n"), 1), (line) => !Str.includes(here)(line))
}

/** The file of the first frame in a file: the module that made the call, or `node` for Node's own alone. */
const fileOf = (lines: ReadonlyArray<string>): string => {
	for (const line of lines) {
		const at = Str.indexOf("file://")(line)
		if (Option.isSome(at)) {
			return Str.replace(regex(":\\d+:\\d+\\)?$"), "")(Str.slice(at.value)(line))
		}
	}
	return "node"
}

/** The module that made a call: the first frame's file past Node's own and this module's. */
const caller = (): string => fileOf(frames())

/** A reading as this module records it: by its module, and whether its first frame is Node's own code. */
const readingOf = (name: string): Reading => {
	const lines = frames()
	const first = lines[0] ?? ""
	return { name, by: fileOf(lines), node: Str.includes("node:")(first) }
}

/** A path as node:fs takes one, made absolute; none for a file descriptor. */
const pathOf = (given: unknown): string | undefined => {
	const path = process.getBuiltinModule("node:path")
	if (typeof given === "string") {
		return path.resolve(given)
	}
	if (given instanceof URL) {
		return given.protocol === "file:" ? fileURLToPath(given) : undefined
	}
	if (given instanceof Uint8Array) {
		const text = utf8Text(given)
		return text === undefined ? undefined : path.resolve(text)
	}
	return undefined
}

/** Whether open's flags write: a numeric flag with O_WRONLY, O_RDWR or O_CREAT, or a text holding w, a or +. */
const writes = (flags: unknown): boolean => {
	const { constants } = process.getBuiltinModule("node:fs")
	if (typeof flags === "number") {
		return (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)) !== 0
	}
	return typeof flags === "string" && Arr.some(["w", "a", "+"], (c) => Str.includes(c)(flags))
}

/** `item` added to `items` unless one alike is there, by its JSON text. */
const once = <A extends Json>(items: Array<A>, seen: Set<string>, item: A): void => {
	const key = jsonText(item)
	if (!seen.has(key)) {
		seen.add(key)
		items.push(item)
	}
}

const traceReads = (): void => {
	const variables = process.env
	const out: unknown = Reflect.get(variables, traceVariable)
	if (typeof out !== "string") {
		throw new Error(`read-trace: ${traceVariable} names no file to write the trace to`)
	}
	const writeFileSync = process.getBuiltinModule("node:fs").writeFileSync
	const loads: Array<string> = []
	const reads: Array<Read> = []
	const env: Array<Reading> = []
	const clock: Array<Reading> = []
	const seen = new Set<string>()
	let loading = 0
	registerHooks({
		resolve: (specifier, context, nextResolve) => {
			loading += 1
			try {
				return nextResolve(specifier, context)
			} finally {
				loading -= 1
			}
		},
		load: (url, context, nextLoad) => {
			loads.push(url)
			loading += 1
			try {
				return nextLoad(url, context)
			} finally {
				loading -= 1
			}
		}
	})
	const read = (call: string, args: ReadonlyArray<unknown>): void => {
		if (loading > 0) {
			return
		}
		const path = pathOf(args[0])
		if (path === undefined || (Str.startsWith("open")(call) && writes(args[1]))) {
			return
		}
		once(reads, seen, { call, path, by: caller() })
	}
	const wrap = (host: Record<string, unknown>, name: string, label: string): void => {
		const original = host[name]
		if (typeof original !== "function") {
			return
		}
		const wrapper = function (this: unknown, ...args: Array<unknown>): unknown {
			read(label, args)
			return Reflect.apply(original, this, args)
		}
		Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original))
		host[name] = wrapper
	}
	const fs: Record<string, unknown> = process.getBuiltinModule("node:fs")
	for (const name of fsReads) {
		wrap(fs, name, name)
		wrap(fs, `${name}Sync`, `${name}Sync`)
	}
	const promises: Record<string, unknown> = process.getBuiltinModule("node:fs/promises")
	for (const name of promiseReads) {
		wrap(promises, name, `promises.${name}`)
	}
	syncBuiltinESMExports()
	const reading = (name: string): void => {
		once(env, seen, readingOf(name))
	}
	Object.defineProperty(process, "env", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: new Proxy(variables, {
			get: (target, key) => {
				if (typeof key === "string") {
					reading(key)
				}
				const value: unknown = Reflect.get(target, key)
				return value
			},
			has: (target, key) => {
				if (typeof key === "string") {
					reading(key)
				}
				return Reflect.has(target, key)
			},
			ownKeys: (target) => {
				reading("*")
				return Reflect.ownKeys(target)
			},
			getOwnPropertyDescriptor: (target, key) => {
				if (typeof key === "string") {
					reading(key)
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			}
		})
	})
	const tick = (name: string): void => {
		once(clock, seen, readingOf(name))
	}
	const RealDate = Date
	const realNow: () => number = RealDate.now.bind(RealDate)
	const TracedDate = function (this: unknown, ...args: Array<unknown>): unknown {
		const constructing: unknown = new.target
		if (constructing === undefined) {
			tick("Date()")
			return RealDate()
		}
		if (args.length === 0) {
			tick("new Date()")
		}
		return Reflect.construct(RealDate, args, new.target)
	}
	Object.defineProperties(TracedDate, Object.getOwnPropertyDescriptors(RealDate))
	Object.defineProperty(TracedDate, "now", {
		configurable: true,
		writable: true,
		value: () => {
			tick("Date.now")
			return realNow()
		}
	})
	Reflect.set(globalThis, "Date", TracedDate)
	const now = performance.now.bind(performance)
	performance.now = () => {
		tick("performance.now")
		return now()
	}
	const hrtime = process.hrtime
	const bigint = hrtime.bigint.bind(hrtime)
	const tracedHrtime = (time: [number, number] | undefined): [number, number] => {
		tick("process.hrtime")
		return hrtime(time)
	}
	tracedHrtime.bigint = (): bigint => {
		tick("process.hrtime.bigint")
		return bigint()
	}
	process.hrtime = tracedHrtime
	process.on("exit", () => {
		const trace: ReadTrace = { pid: process.pid, loads, reads, env, clock }
		writeFileSync(out, jsonText(trace))
	})
}

traceReads()
