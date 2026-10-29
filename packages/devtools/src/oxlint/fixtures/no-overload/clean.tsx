export function single(a: number): number {
	return a
}
export interface Reader {
	read(): string
}
export interface Reader {
	size(): number
}
export type Call = {
	(a: number): number
}
export class Store {
	get(key: string): string {
		return key
	}
	static get(key: string): string {
		return key
	}
}
