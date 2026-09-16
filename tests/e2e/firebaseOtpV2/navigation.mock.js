const router = { push: path => window.__otpTest.navigation.push(path) };
export function useRouter() { return router; }
export function useSearchParams() { return new URLSearchParams(location.search); }
