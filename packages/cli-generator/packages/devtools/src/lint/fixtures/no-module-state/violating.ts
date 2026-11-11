import { Pool } from "pg"

let counter = 0 // violation

var legacy = 1 // violation

const cache = new Map<string, number>() // violation

const seen = new Set<string>() // violation

const pending: Array<string> = [] // violation

const pair: [number, number] = [0, 0] // violation

const totals: Record<string, number> = {} // violation

const box = { value: 0 } // violation

const pool = new Pool() // violation

const ticks = { count: 0 } as { count: number } | undefined // violation

const global = /x/g // violation

export const touch = (): number => {
	globalThis.undeclaredSlot = counter // violation
	return legacy + cache.size + seen.size + pending.length + pair[0] + box.value
}

export const reflect = (): void => {
	Object.assign(globalThis, { other: 1 }) // violation
}

export const exposed = [totals, pool, ticks, global] as const
