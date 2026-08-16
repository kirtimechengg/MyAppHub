/**
 * 🧠 APP CORE
 * Handles Authentication, Global Data Store, and UI Navigation for all pages.
 */

class AppCore {
    constructor() {
        this.user = null;
        this.db = null;
        this.auth = null;
        this.globalState = {
            theme: 'light',
            notifications: 0,
            lastActive: null
        };
        this.stateListeners = [];
    }

    // --- INITIALIZATION ---
    async init() {
        // Wait for Firebase to be ready
        if (typeof firebase === 'undefined') {
            console.error("Firebase SDK not loaded!");
            return;
        }

        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        this.auth = firebase.auth();
        this.db = firebase.firestore();

        // 🔌 Enable Offline Persistence
        try {
            await this.db.enablePersistence();
            console.log("🔌 Offline mode enabled");
        } catch (err) {
            console.log("Persistence disabled (multitab or not supported):", err.code);
        }

        // Finish a Google sign-in that redirected away and back - see
        // signInWithGoogle()/completeGoogleRedirect() below.
        await this.completeGoogleRedirect();

        this.injectStyles();
        this.setupAuth();
    }

    // --- AUTHENTICATION ---
    setupAuth() {
        this.auth.onAuthStateChanged(user => {
            this.user = user;
            if (user) {
                console.log(`✅ Logged in: ${user.email}`);
                this.connectGlobalStore();
                this.renderNav(); 
                if (typeof this.onLogin === 'function') {
                    this.onLogin(user);
                }
            } else {
                console.log("🔒 Guest mode / Logged out");
                this.renderNav();
                // Redirect logic if needed, but safe to stay on page for now
            }
        });
    }

    // --- 🌍 GLOBAL DATA STORE ---
    connectGlobalStore() {
        if (!this.user) return;

        this.db.collection('users').doc(this.user.uid).collection('app_data').doc('global_store')
            .onSnapshot(doc => {
                if (doc.exists) {
                    this.globalState = { ...this.globalState, ...doc.data() };
                    this.notifyListeners();
                    this.applyTheme(this.globalState.theme);
                } else {
                    // Initialize if empty
                    this.updateGlobalStore({ theme: 'light', created: Date.now() });
                }
            });
    }

    async updateGlobalStore(data) {
        if (!this.user) return;
        try {
            await this.db.collection('users').doc(this.user.uid).collection('app_data').doc('global_store').set(
                { ...data, lastUpdated: firebase.firestore.FieldValue.serverTimestamp() },
                { merge: true }
            );
        } catch (e) {
            console.error("Sync Error:", e);
        }
    }

    subscribe(callback) {
        this.stateListeners.push(callback);
        callback(this.globalState);
    }

    notifyListeners() {
        this.stateListeners.forEach(cb => cb(this.globalState));
    }

    // --- UI & NAVIGATION ---
    injectStyles() {
        if(typeof tailwind !== 'undefined') {
            tailwind.config = {
                darkMode: 'class',
                theme: { extend: { fontFamily: { sans: ['Instrument Sans', 'sans-serif'] } } }
            }
        }
    }

    applyTheme(theme) {
        if (theme === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
    }

    toggleTheme() {
        const newTheme = this.globalState.theme === 'dark' ? 'light' : 'dark';
        this.updateGlobalStore({ theme: newTheme });
    }

    // --- 🔐 GOOGLE SIGN-IN ---
    // Popup first, redirect second. On an iOS Home Screen web app a full-page
    // redirect hands the navigation off to Safari and never returns, so
    // getRedirectResult() would resolve null forever and the user would appear
    // permanently signed out. The popup stays inside this app's own context.
    // Redirect remains the fallback for webviews that block popups.
    async signInWithGoogle() {
        const provider = new firebase.auth.GoogleAuthProvider();
        try {
            await this.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        } catch (e) {
            console.log('Auth persistence:', e.code || e.message);
        }
        // A standalone (Home Screen) web app has no browser window chrome to
        // host a popup - signInWithPopup silently fails or hangs there
        // instead of throwing something the fallback below could react to,
        // so skip straight to redirect.
        const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
        if (!standalone) {
            try {
                await this.auth.signInWithPopup(provider);
                return;
            } catch (e) {
                if (e.code === 'auth/account-exists-with-different-credential') {
                    await this.linkPendingCredential(e);
                    return;
                }
                // Closing the popup is a deliberate cancel, not a reason to fall
                // back to a redirect the user did not ask for.
                if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
                console.log('Popup sign-in unavailable, using redirect:', e.code || e.message);
            }
        }
        try {
            await this.auth.signInWithRedirect(provider);
        } catch (e) {
            alert('Could not start Google sign-in: ' + e.message);
        }
    }

    // Handles the return trip from a redirect sign-in. A failure here used to be
    // swallowed into console.log, which made a broken redirect completely
    // invisible - the symptom that hid the iOS problem for so long.
    async completeGoogleRedirect() {
        const BENIGN = ['auth/no-auth-event', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request'];
        try {
            await this.auth.getRedirectResult();
        } catch (e) {
            if (e.code === 'auth/account-exists-with-different-credential') {
                await this.linkPendingCredential(e);
            } else if (e.code && BENIGN.indexOf(e.code) === -1) {
                console.log('Google sign-in:', e.code);
                alert('Google sign-in did not complete: ' + (e.message || e.code));
            }
        }
    }

    // One-time account link: this Google account's email already has a password
    // account, and Firebase refuses to silently merge the two. Linking once the
    // existing password is confirmed keeps the original uid - and every case
    // saved under it - intact. Shared by both the popup and redirect paths.
    async linkPendingCredential(e) {
        const email = e.email;
        const pendingCred = e.credential;
        const methods = email ? await this.auth.fetchSignInMethodsForEmail(email) : [];
        if (!methods.includes('password')) {
            alert('Sign-in failed: ' + e.message);
            return;
        }
        const password = prompt(
            'You already have an account for ' + email + ' signed in with a password.\n' +
            'Enter that password once to link Google sign-in to it:'
        );
        if (!password) return;
        try {
            const cred = await this.auth.signInWithEmailAndPassword(email, password);
            await cred.user.linkWithCredential(pendingCred);
        } catch (linkErr) {
            alert('Could not link Google sign-in: ' + linkErr.message);
        }
    }

    renderNav() {
        const navContainer = document.getElementById('global-nav');
        if (!navContainer) return;

        const email = this.user ? (this.user.email || 'Anonymous') : 'Not Logged In';
        const avatar = email.charAt(0).toUpperCase();

        navContainer.innerHTML = `
            <nav class="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 sticky top-0 z-50">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
                    <a href="index.html" class="flex items-center gap-2 font-bold text-xl text-slate-800 dark:text-white hover:opacity-80 transition">
                        <div class="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white">A</div>
                        <span>App Hub</span>
                    </a>

                    <div class="flex items-center gap-4">
                        <div id="global-status" class="hidden md:flex text-xs px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                            ${this.user ? '🟢 Synced' : '⚪ Offline'}
                        </div>

                        <button onclick="Core.toggleTheme()" class="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition">
                            ${this.globalState.theme === 'dark' ? '🌙' : '☀️'}
                        </button>

                        ${this.user ? `
                        <div class="relative group cursor-pointer">
                            <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 text-white flex items-center justify-center font-bold shadow-sm">
                                ${avatar}
                            </div>
                            <div class="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 py-1 hidden group-hover:block">
                                <div class="px-4 py-2 border-b border-slate-200 dark:border-slate-700">
                                    <p class="text-xs text-slate-500">Signed in as</p>
                                    <p class="text-sm font-medium truncate text-slate-900 dark:text-slate-100">${email}</p>
                                </div>
                                <button onclick="firebase.auth().signOut()" class="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">Sign Out</button>
                            </div>
                        </div>
                        ` : `
                        <button onclick="Core.signInWithGoogle()" class="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg text-sm font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 transition shadow-sm">
                            <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.8 2.73v2.27h2.92c1.7-1.57 2.68-3.88 2.68-6.64z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.17l-2.92-2.27c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.34C2.44 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.97 10.71c-.18-.54-.28-1.11-.28-1.71s.1-1.17.28-1.71V4.95H.96C.35 6.17 0 7.55 0 9s.35 2.83.96 4.05l3.01-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.95l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
                            <span class="text-slate-700 dark:text-slate-200">Sign in</span>
                        </button>
                        `}
                    </div>
                </div>
            </nav>
        `;
    }
}

// Initialize Global Instance
const Core = new AppCore();

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Core.init());
} else {
    Core.init();
}