import { create } from 'zustand';
import { connectSocket, refreshSocketToken, setAccountUid } from './socket.js';
import { useGameStore } from '../store/gameStore.js';

/**
 * Accounts through Firebase Authentication (optional). Configure with
 * VITE_FIREBASE_API_KEY / _AUTH_DOMAIN / _PROJECT_ID / _APP_ID. Everyone gets
 * a guest (anonymous) account automatically; "Sign in with Google" upgrades
 * it in place, so stats and seats carry over and follow you to any device.
 * Without the config the game uses per-tab guest ids as before.
 */
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined
};

export const firebaseEnabled = !!(config.apiKey && config.projectId);

function describeAuthError(code: string): string {
  switch (code) {
    case 'auth/unauthorized-domain':
      return "This site isn't allowed to sign in with Google yet (domain not authorized).";
    case 'auth/network-request-failed':
      return 'Sign-in failed: no network connection.';
    default:
      return `Google sign-in failed (${code}).`;
  }
}

export interface AccountState {
  status: 'off' | 'loading' | 'ready' | 'error';
  uid: string | null;
  name: string | null;
  photo: string | null;
  anonymous: boolean;
  busy: boolean;
}

export const useAccount = create<AccountState>(() => ({
  status: firebaseEnabled ? 'loading' : 'off',
  uid: null,
  name: null,
  photo: null,
  anonymous: true,
  busy: false
}));

type AuthModule = typeof import('firebase/auth');
let authMod: AuthModule | null = null;
let auth: import('firebase/auth').Auth | null = null;

// Set right before navigating away for sign-in, so that when the redirect
// lands back here we can tell "no pending sign-in" (normal page load) apart
// from "a sign-in just silently failed to complete" (worth telling the user
// about -- some browsers block the cross-origin storage the redirect
// handshake needs, e.g. Safari ITP, Chrome/Brave tracking protection,
// in-app webviews).
const SIGNIN_PENDING_KEY = 'tmpoly_signin_pending';
function takeSignInPending(): boolean {
  try {
    const was = sessionStorage.getItem(SIGNIN_PENDING_KEY) === '1';
    sessionStorage.removeItem(SIGNIN_PENDING_KEY);
    return was;
  } catch {
    return false;
  }
}
function markSignInPending(): void {
  try {
    sessionStorage.setItem(SIGNIN_PENDING_KEY, '1');
  } catch {
    /* ignore */
  }
}

export async function initAccount(): Promise<void> {
  if (!firebaseEnabled) {
    connectSocket();
    return;
  }
  try {
    const [{ initializeApp }, mod] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    authMod = mod;
    auth = mod.getAuth(initializeApp(config));
    await mod.setPersistence(auth, mod.browserLocalPersistence);

    // Finish a Google sign-in that redirected away and came back. Popups
    // are blocked outright by some browsers / in-app webviews and get
    // silently killed by Cross-Origin-Opener-Policy in others, so sign-in
    // goes through a full-page redirect instead.
    const wasPending = takeSignInPending();
    try {
      const result = await mod.getRedirectResult(auth);
      if (wasPending && !result) {
        // We navigated away to sign in and came back, but Firebase has
        // nothing to complete: the redirect handshake was silently dropped
        // rather than erroring out.
        useGameStore
          .getState()
          .addToast(
            "Sign-in didn't go through -- this browser is blocking Google sign-in (private window, tracking protection, or an in-app browser). Try a normal window or a different browser.",
            'warning'
          );
      }
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === 'auth/credential-already-in-use') {
        // This Google account is already linked to a different uid.
        // credentialFromError reliably extracts a usable credential for
        // POPUP-flow errors only; for a redirect-flow error like this one it
        // routinely comes back null, in which case the only real recovery
        // is to sign in to that existing account directly.
        const cred = mod.GoogleAuthProvider.credentialFromError(e as import('firebase/auth').AuthError);
        if (cred) {
          await mod.signInWithCredential(auth, cred);
        } else {
          markSignInPending();
          await mod.signInWithRedirect(auth, new mod.GoogleAuthProvider());
          return; // page is navigating away
        }
      } else {
        useGameStore.getState().addToast(err.code ? describeAuthError(err.code) : 'Google sign-in failed', 'danger');
      }
    }

    let connectedAs: string | null = null;
    mod.onIdTokenChanged(auth, async (user) => {
      if (!user) {
        // Everyone plays with at least a guest account.
        mod.signInAnonymously(auth!).catch(() => fallBack());
        return;
      }
      const token = await user.getIdToken();
      // Google accounts usually have a displayName; fall back to the part of
      // the email before "@" (e.g. "legendwijaya") when it's missing.
      const name = user.displayName || (user.email ? user.email.split('@')[0] : null);
      useAccount.setState({
        status: 'ready',
        uid: user.uid,
        name,
        photo: user.photoURL,
        anonymous: user.isAnonymous
      });
      if (connectedAs === user.uid) {
        refreshSocketToken(token);
        return;
      }
      connectedAs = user.uid;
      setAccountUid(user.uid);
      useGameStore.getState().setMyPlayerId(user.uid);
      connectSocket(token);
    });
  } catch (e) {
    console.warn('Firebase sign-in unavailable, playing as a local guest', e);
    fallBack();
  }
}

// Firebase unreachable: keep the game playable with a local guest id.
function fallBack(): void {
  useAccount.setState({ status: 'error' });
  setAccountUid(null);
  connectSocket();
}

const POPUP_UNAVAILABLE_CODES = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
  'auth/web-storage-unsupported',
  'auth/internal-error'
]);

/**
 * Upgrade the guest account to Google (keeps the same uid when possible).
 *
 * Tries a popup first: it completes via postMessage between the two windows,
 * so it isn't affected by browsers partitioning storage between our domain
 * and the *.firebaseapp.com auth domain (that partitioning is what makes the
 * redirect flow below silently fail to complete in a lot of browsers now --
 * getRedirectResult() comes back with nothing and no error). Falls back to a
 * full-page redirect only when a popup genuinely can't be used (blocked, or
 * an in-app / non-browser environment that doesn't support window.open).
 */
export async function signInWithGoogle(): Promise<void> {
  if (!auth || !authMod) return;
  const provider = new authMod.GoogleAuthProvider();
  useAccount.setState({ busy: true });
  const current = auth.currentUser;
  try {
    if (current?.isAnonymous) {
      await authMod.linkWithPopup(current, provider);
    } else {
      await authMod.signInWithPopup(auth, provider);
    }
    useAccount.setState({ busy: false });
    return;
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === 'auth/credential-already-in-use') {
      // This Google account is already linked to a different uid. Popup
      // errors DO reliably carry a reusable credential (unlike redirect
      // errors), so sign straight into that existing account.
      const cred = authMod.GoogleAuthProvider.credentialFromError(e as import('firebase/auth').AuthError);
      useAccount.setState({ busy: false });
      if (cred) {
        await authMod.signInWithCredential(auth, cred);
        return;
      }
      throw e;
    }
    if (!POPUP_UNAVAILABLE_CODES.has(err.code ?? '')) {
      // Blocked/cancelled/etc: a real answer, not an environment limitation.
      useAccount.setState({ busy: false });
      throw e;
    }
  }

  // Popup couldn't be used here at all: fall back to the redirect flow
  // (initAccount handles completing it on the next load).
  try {
    markSignInPending();
    if (current?.isAnonymous) {
      await authMod.linkWithRedirect(current, provider);
    } else {
      await authMod.signInWithRedirect(auth, provider);
    }
    // The page navigates away now; nothing after this line runs.
  } catch (e) {
    takeSignInPending();
    useAccount.setState({ busy: false });
    throw e;
  }
}

export async function signOutAccount(): Promise<void> {
  if (!auth || !authMod) return;
  await authMod.signOut(auth);
}
