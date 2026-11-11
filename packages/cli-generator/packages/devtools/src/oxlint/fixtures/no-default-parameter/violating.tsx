export const greet = (name = "world"): string => name // violation
export function add(a: number, b = 1): number { // violation
	return a + b
}
export class Box {
	constructor(readonly size = 1) {} // violation
}
export const pick = ({ a = 1 }: { a?: number }): number => a
