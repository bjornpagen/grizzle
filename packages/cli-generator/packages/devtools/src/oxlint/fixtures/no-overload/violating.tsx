export function parse(text: string): number // violation
export function parse(text: number): number // violation
export function parse(text: string | number): number {
	return Number(text)
}
export interface Reader {
	read(): string // violation
	read(size: number): string // violation
}
export type Dual = {
	(a: number): number // violation
	(a: number, b: number): number // violation
}
export class Store {
	get(key: string): string // violation
	get(key: number): string // violation
	get(key: string | number): string {
		return String(key)
	}
}
export function single(a: number): number {
	return a
}
