import { Config, ConfigProvider, Effect } from "effect"
import * as os from "node:os"
import { homedir } from "node:os"
import { getHeapStatistics } from "node:v8"
import { env } from "node:process"

export const home = process.env.HOME // violation

export const user = env.USER // violation

export const keyed = process["env"] // violation

const { env: copied } = process // violation

export const copy = copied

export const directory = homedir() // violation

export const scratch = os.tmpdir() // violation

export const cores = os.availableParallelism() // violation

export const where = process.cwd() // violation

export const args = process.argv // violation

export const port = Config.Int("PORT") // violation

export const provider = ConfigProvider.fromEnv() // violation

export const viaGlobal = globalThis.process.env // violation

export const shorthand = { env } // violation

export const host = Effect.gen(function* () {
	return yield* Config.String("HOST") // violation
})

export const lineEnd = os.EOL // violation

export const memory = os.totalmem() // violation

export const heap = getHeapStatistics() // violation

export const threads = navigator.hardwareConcurrency // violation

export const platform = process.platform // violation

export const executable = process.execPath // violation
