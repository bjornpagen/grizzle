declare const payload: string
export const sent = navigator.sendBeacon("/beacon", payload) // violation
export const options = { transport: "sendBeacon" } // violation
export const fetchOptions = { transport: "fetch" }
export const agent = navigator.userAgent
