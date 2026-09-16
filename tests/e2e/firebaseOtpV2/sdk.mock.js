// Bundler-only SDK replacement. The production adapter, controller and React UI stay real.
const state = () => window.__otpTest;
if (state().scenario.sdkLoadError) throw Object.assign(new Error('Synthetic module load failure'), { name: 'ChunkLoadError' });
const sdkError = code => Object.assign(new Error('Synthetic SDK error'), { code });
const apps = [];
const renderedHosts = new WeakSet();
export const inMemoryPersistence = {};
export const getApps = () => apps;
export function initializeApp(config, name) {
  const app = { config, name }; apps.push(app); return app;
}
export function initializeAuth() { return {}; }
export async function signOut() { state().sdk.signOut += 1; }
export class RecaptchaVerifier {
  constructor(auth, host) {
    if (!(host instanceof HTMLElement) || !host.isConnected) throw new Error('Detached reCAPTCHA host');
    this.host = host;
    state().sdk.containers.push(host.parentElement.id);
    state().sdk.construct += 1;
  }
  async render() {
    if (state().scenario.renderTypeError) throw new TypeError('private synthetic provider data');
    if (this.rendered) return 1;
    // Clearing an invisible Firebase verifier does not unregister Google's host element.
    if (renderedHosts.has(this.host)) throw new Error('reCAPTCHA has already been rendered in this element');
    if (state().scenario.renderError) throw sdkError(state().scenario.renderError);
    renderedHosts.add(this.host);
    this.rendered = true;
    return 1;
  }
  async verify() { return 'test-only-captcha-token'; }
  clear() { state().sdk.clear += 1; }
}
export async function signInWithPhoneNumber(auth, phone, verifier) {
  state().sdk.sends.push(phone);
  await verifier.verify();
  if (state().scenario.sendDeferred) {
    await new Promise((resolve, reject) => {
      state().releaseSend = () => resolve();
      state().rejectSend = code => reject(sdkError(code));
    });
  }
  if (state().scenario.sendError) throw sdkError(state().scenario.sendError);
  return {
    confirm: async code => {
      state().sdk.confirms.push(code);
      if (state().scenario.confirmDeferred) await new Promise(resolve => { state().releaseConfirm = resolve; });
      if (code === '000000') throw sdkError('auth/invalid-verification-code');
      if (state().scenario.confirmError) throw sdkError(state().scenario.confirmError);
      return { user: { getIdToken: async () => {
        state().sdk.tokens += 1;
        if (state().scenario.tokenFailures > 0) { state().scenario.tokenFailures -= 1; throw sdkError('auth/network-request-failed'); }
        return `mock-id-token:${phone}`;
      } } };
    },
  };
}
