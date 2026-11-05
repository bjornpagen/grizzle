import { type Duration, Schedule } from "effect"

export type Gen<A> = (seed: number) => A

export declare const filter: <A>(generator: Gen<A>, keep: (a: A) => boolean, attempts: number) => Gen<A>

export declare const drawSized: <A>(generator: Gen<A>, options: Readonly<{ attempts: number; max: number }>) => Gen<A>

export declare const integer: Gen<number>

export const repeatedDraw = <A>(generator: Gen<A>, k: number): Gen<A> => {
	const schedule = Schedule.recurs(k)
	return schedule === undefined ? generator : generator
}

export interface Plan {
	readonly name: string
}

export declare const definePlan: (
	spec: Readonly<{ name: string; options: Readonly<{ wait: Duration.Input; rounds: number }> }>
) => Plan
