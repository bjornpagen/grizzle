declare const HttpClientRequest: {
	bearerToken: (token: string) => string
	basicAuth: (token: string) => string
}
const token = "abc"
export const header = `Bearer ${token}` // violation
export const lower = `bearer ${token}` // violation
export const joined = "Bearer " + token // violation
export const request = HttpClientRequest.bearerToken(token) // violation
export const basic = `Basic ${token}`
export const prose = "Bearer token"
export const other = HttpClientRequest.basicAuth(token)
