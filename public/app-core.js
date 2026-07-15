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

                        <div class="relative group cursor-pointer">
                            <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 text-white flex items-center justify-center font-bold shadow-sm">
                                ${this.user ? avatar : '?'}
                            </div>
                            <div class="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 py-1 hidden group-hover:block">
                                <div class="px-4 py-2 border-b border-slate-200 dark:border-slate-700">
                                    <p class="text-xs text-slate-500">Signed in as</p>
                                    <p class="text-sm font-medium truncate text-slate-900 dark:text-slate-100">${email}</p>
                                </div>
                                ${this.user ? '<button onclick="firebase.auth().signOut()" class="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">Sign Out</button>' : ''}
                            </div>
                        </div>
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