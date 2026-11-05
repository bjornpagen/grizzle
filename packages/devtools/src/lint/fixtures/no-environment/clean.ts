import type { Config } from "effect"

declare const settings: Readonly<{ env: string; cwd: string }>

export const fromCaller = settings.env

export const directory = settings.cwd

export type Typed = Config.Config<string>

export type Environment = typeof process.env

export const pid = process.pid

export const exit = (code: number): void => {
	process.exitCode = code
}

const env = { HOME: "/home" }

export const local = env.HOME

export const options = { cwd: "/tmp", env: {} }
