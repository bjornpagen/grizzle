export const greet = (name?: string): string => name ?? "" // violation
export function add(a: number, b?: number): number { // violation
	return a + (b ?? 0)
}
export type Handler = (event?: string) => void // violation
export interface Api {
	call(input?: string): void // violation
}
export const required = (name: string): string => name
