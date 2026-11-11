import { brand, derive, limit, other, twice } from "#fixture/proven.ts"

let counter = 0
const table: Record<string, number> = {}

/* @__NO_SIDE_EFFECTS__ */
export const bumps = (): void => {
	counter += 1 // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const reads = (): number => counter // violation

/* @__NO_SIDE_EFFECTS__ */
export const writes = (value: { n: number }): void => {
	value.n = 1 // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const fills = (key: string): void => {
	;[table[key]] = [1] // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const drops = (value: { n?: number }): void => {
	delete value.n // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const counts = (value: { n: number }): void => {
	value.n++ // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const calls = (callback: () => number): number => callback() // violation

/* @__NO_SIDE_EFFECTS__ */
export const methods = (text: string): string => text.trim() // violation

/* @__NO_SIDE_EFFECTS__ */
export const logs = (): void => {
	console.log("x") // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const freezes = (value: object): object => Object.freeze(value) // violation

/* @__NO_SIDE_EFFECTS__ */
export const assigns = (value: object): object => Object.assign(value, {}) // violation

/* @__NO_SIDE_EFFECTS__ */
export const converts = (value: string): number => Number(value)

/* @__NO_SIDE_EFFECTS__ */
export const throws = (): never => {
	throw new RangeError("no") // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const builds = (): Map<string, number> => new Map() // violation

/* @__NO_SIDE_EFFECTS__ */
export function bound(this: { readonly n: number }): number {
	return this.n // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const unproven = (value: number): number => other(value) // violation

/* @__NO_SIDE_EFFECTS__ */
export const result = (value: number): number => twice(value)(value) // violation

/* @__NO_SIDE_EFFECTS__ */
export const branded = (value: number): number => brand<number, number>()(value)

/* @__NO_SIDE_EFFECTS__ */
export const aliased = (value: () => number): number => {
	const run = value
	return run() // violation
}

/* @__NO_SIDE_EFFECTS__ */
export const awaits = async (value: Promise<number>): Promise<number> => await value // violation

/* @__NO_SIDE_EFFECTS__ */ // violation
export const notAFunction = 1

export const unmarked = (): number => counter

let mutableState = 1

const notFrozen = { value: 1 }

const computed = [1, 2].length

/* @__NO_SIDE_EFFECTS__ */
export const randomized = (): number => Math.random() // violation

/* @__NO_SIDE_EFFECTS__ */
export const stringsAny = (value: { readonly n: number }): string => value.toString() // violation

/* @__NO_SIDE_EFFECTS__ */
export const readsMutable = (): number => notFrozen.value // violation

/* @__NO_SIDE_EFFECTS__ */
export const readsComputed = (): number => computed // violation

/* @__NO_SIDE_EFFECTS__ */
export const readsImportedConstant = (): number => limit.value

/* @__NO_SIDE_EFFECTS__ */
const callsCallback = (spec: { readonly f: () => number }): number => spec.f()

export const callbackImpure = derive({ base: 1, compute: () => mutableState }) // violation

export const callbackMissing = derive(limit) // violation

export const callbackOpaque = derive({ base: 1, compute: callsCallback }) // violation

export const localHigher = callsCallback({ f: () => 1 })

export const localHigherBad = callsCallback({ f: () => (mutableState = 2) }) // violation
