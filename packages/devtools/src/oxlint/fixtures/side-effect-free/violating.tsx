import { brand, other, twice } from "#fixture/proven.ts"

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
export const converts = (value: string): number => Number(value) // violation

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
