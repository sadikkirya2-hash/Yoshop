// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-analytics.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

import { getFirestore, doc, setDoc, getDoc, onSnapshot, initializeFirestore, collection, addDoc, query, orderBy, limit, getDocs, deleteDoc, where } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { getStorage, ref, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-storage.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, linkWithCredential, EmailAuthProvider, updatePassword, reauthenticateWithCredential, updateProfile, deleteUser } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAYvXfCDMzylmevTAoePLW84KhxLHAX9SA",
  authDomain: "yoshop-b502f.firebaseapp.com",
  projectId: "yoshop-b502f",
  storageBucket: "yoshop-b502f.firebasestorage.app",
  messagingSenderId: "860076092806",
  appId: "1:860076092806:web:1a83971ae7637ef2cd1007",
  measurementId: "G-5PETKNBCNF"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Initialize Firestore - use default database
// Avoid specifying databaseId explicitly as it can cause compatibility issues
let dbFirestore;
try { // Explicitly connect to the 'yoshop' database
  dbFirestore = getFirestore(app, 'yoshop');
  console.log("Firestore initialized successfully");
} catch (error) {
  console.warn("Firestore initialization warning (will retry on demand):", error.message);
  // Firestore will be re-initialized on demand if needed
}

console.log("Firebase initialized for project:", firebaseConfig.projectId);

const storage = getStorage(app);
const auth = getAuth(app);
let currentUser = null;
let currentUserRole = sessionStorage.getItem('currentUserRole');
let currentUserPermissions = JSON.parse(sessionStorage.getItem('currentUserPermissions') || '[]');
let isPinVerified = sessionStorage.getItem('isPinVerified') === 'true' && !!currentUserRole;
let currentLoggedInStaffName = sessionStorage.getItem('currentLoggedInStaffName') || '';
let isInitialLoadComplete = false; // Safety flag to prevent overwriting cloud data on startup

let syncFailureCount = 0;
let syncDebounceTimer = null;
let isDebouncing = false;
const SYNC_DEBOUNCE_DELAY = 300; // 300ms debounce for rapid changes
let lastSyncTime = 0;
const MIN_SYNC_INTERVAL = 500; // Minimum 500ms between syncs to respect Firebase limits

// Helper function to upload images to Firebase Storage
async function uploadImage(base64Data, path) {
  try {
    if (!base64Data || !base64Data.startsWith('data:image')) return base64Data;
    let userIdentifier = 'anonymous'; // Default for public uploads
    if (currentUser) {
      userIdentifier = currentUser.email || currentUser.uid; // Use email as primary identifier as requested
    }
    const userPath = `users/${userIdentifier}/${path}`;
    const storageRef = ref(storage, userPath);
    await uploadString(storageRef, base64Data, 'data_url');
    return await getDownloadURL(storageRef);
  } catch (error) {
    if (error.code === 'storage/unauthorized') {
      console.error("CRITICAL: Firebase Storage permission denied. Please ensure your Storage Security Rules allow writes to the 'users/' path for authenticated users.");
    }
    console.error("Image upload failed:", error);
    return base64Data; // Return original (likely placeholder) on failure
  }
}

// ===== IndexedDB Setup =====
  let db;
  const DB_VERSION = 1;
  const STORE_NAME = 'appState';
  const CART_ID = 'SHOP_CART';

  function initDB(userId = 'guest') {
    return new Promise((resolve, reject) => {
      const dbName = `posDB_${userId}`;
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        db = event.target.result;
        console.log(`Local database [${dbName}] initialized successfully.`);
        resolve(db);
      };

      request.onblocked = () => {
        alert('Database is blocked. Please close other tabs of this app and refresh.');
        reject('DB_BLOCKED');
      };

      request.onerror = (event) => {
        console.error('Database error:', event.target.errorCode);
        reject(event.target.errorCode);
      };
    });
  }

  function saveState(key, value) {
    return new Promise((resolve, reject) => {
      if (!db) return reject('DB not initialized');
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(event.target.error);
    });
  }

  function loadState(key) {
    return new Promise((resolve, reject) => {
      if (!db) return reject('DB not initialized');
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = (event) => resolve(event.target.result ? event.target.result.value : null);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  // ===== Data Handling =====
  let defaultMenu = [];
  let menu = [];
  let activeOrders = {};
  let transactions = [];
  let staff = [];
  let dishCategories = [];
  let customers = [];
  let restockHistory = [];

  const defaultDishCategories = [];
  const defaultSettings = { 
    name: "My Business",
    address: "123 Business Avenue, Suite 100",
    contact: "555-123-4567",
    currency: "$",
    theme: "light",
    defaultMarkup: 200, // Default 200% markup
    lowStockThreshold: 10,
    taxRate: 0,
    managerPIN: "1234" // Default Manager PIN
  };
  let settings = { ...defaultSettings };
  const defaultStaff = [];
  
  let printerDevice = null;
  let printerType = null; // 'USB' or 'BLUETOOTH'
  let units = [];

  // Helper to get logged in user's first name
  function getCurrentServerName() {
    // Return logged-in staff member's name if available
    if (currentLoggedInStaffName) {
      return currentLoggedInStaffName;
    }
    // Otherwise, return Google user's name
    if (currentUser) {
      if (currentUser.displayName) return currentUser.displayName.trim().split(/\s+/)[0];
      if (currentUser.email) return currentUser.email.split('@')[0];
    }
    return 'N/A';
  }

  /**
   * Robust wrapper for Firebase errors to provide better debugging info
   */
  function handleFirebaseError(error, context = "Firebase Operation") {
    const errorCode = error.code || 'unknown';
    const errorMessage = error.message || 'An unexpected error occurred';
    
    console.error(`[${context}] ❌ Error (${errorCode}):`, errorMessage);
    
    if (errorCode === 'permission-denied') {
      console.warn(`[${context}] 🔐 Security Rules violation. Check if the user is authenticated and rules allow access to the path.`);
    } else if (errorCode === 'not-found') {
      console.warn(`[${context}] 🔍 The requested document or database instance was not found.`);
    } else if (errorCode === 'unavailable') {
      console.warn(`[${context}] 🔌 Service is currently unavailable. The app will continue in offline mode.`);
    }
    
    return { code: errorCode, message: errorMessage };
  }

  /**
   * Debounced cloud sync - fires immediately but only syncs to cloud once per debounce period
   * This prevents excessive Firebase writes while ensuring rapid local updates
   */
  async function saveData(syncToCloud = true) {
    try {
      // Save to local IndexedDB immediately (always, synchronous)
      await Promise.all([
        saveState('menu', menu || []),
        saveState('activeOrders', activeOrders || {}),
        saveState('transactions', transactions || []),
        saveState('settings', settings || defaultSettings),
        saveState('staff', staff || []),
        saveState('dishCategories', dishCategories || []),
        saveState('customers', customers || []),
        saveState('units', units || []),
        saveState('restockHistory', restockHistory || [])
      ]);

      // Debounce cloud sync to prevent excessive Firebase writes
      if (syncToCloud && currentUser && isInitialLoadComplete && dbFirestore) {
        // Clear existing debounce timer
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        
        // Set new debounce timer for cloud sync
        syncDebounceTimer = setTimeout(async () => {
          syncDebounceTimer = null;
          
          // Check minimum interval to respect Firebase limits
          const now = Date.now();
          if (now - lastSyncTime < MIN_SYNC_INTERVAL) {
            return; // Skip this sync, reschedule
          }
          
          try {
            isDebouncing = true;
            // Prepare data for Firestore
            // JSON.stringify/parse is used to strip any 'undefined' properties which Firestore forbids.
            const shopData = JSON.parse(JSON.stringify({
              menu: menu || [],
              activeOrders: activeOrders || {},
              settings: settings || defaultSettings,
              staff: staff || [],
              dishCategories: dishCategories || [],
              customers: customers || [],
              units: units || [],
              restockHistory: restockHistory || [],
              lastUpdated: new Date().toISOString()
            }));

            // If we have many consecutive failures, stop trying until manual sync or reload
            if (syncFailureCount > 5) {
              console.warn("Sync suspended due to repeated failures. Check Firebase Console configuration.");
              isDebouncing = false;
              return;
            }

            // Perform actual cloud sync using merge to avoid overwriting other fields
            await setDoc(doc(dbFirestore, "users", currentUser.uid, "data", "SHOP_DATA"), shopData, { merge: true });
            lastSyncTime = Date.now();
            syncFailureCount = 0; // Reset on success

            // Update Last Synced UI Tooltip
            const syncBtn = document.getElementById('sync-now-btn');
            if (syncBtn) {
              syncBtn.setAttribute('data-tooltip', 'Last synced: ' + new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
            }
            console.log('[SYNC] ✅ Cloud data synced successfully');
          } catch (firestoreError) {
            // Add pulse animation to connectivity status on successful sync
            const statusEl = document.getElementById('connectivity-status');
            if (statusEl) {
                statusEl.classList.add('sync-pulse');
                setTimeout(() => statusEl.classList.remove('sync-pulse'), 600);
            }

            syncFailureCount++;
            handleFirebaseError(firestoreError, "Firestore Sync");
          } finally {
            isDebouncing = false;
          }
        }, SYNC_DEBOUNCE_DELAY);
      }
      
      updateOnlineStatus();
    } catch (error) {
      console.error("[SYNC] ❌ Local save failed:", error);
      syncFailureCount++;
      updateOnlineStatus();
    }
  }

  /**
   * Records a single transaction to local storage and Firestore sub-collection
   */
  async function recordTransaction(transaction) {
    // 1. Mark as not synced initially and add to local state for immediate UI update
    transaction.synced = false;
    transactions.unshift(transaction);
    
    // Keep local list at reasonable size for performance
    if (transactions.length > 500) transactions.pop();
    
    // 2. Save locally to IndexedDB
    await saveState('transactions', transactions);

    // 3. Save to Cloud Sub-collection if online
    if (currentUser && dbFirestore && navigator.onLine) {
      try {
        const txRef = collection(dbFirestore, "users", currentUser.uid, "transactions");
        // Strip the local 'synced' flag before sending to Firestore
        const { synced, ...txData } = transaction;
        await addDoc(txRef, txData);
        
        // Update local state to marked as synced
        transaction.synced = true;
        await saveState('transactions', transactions);
        console.log('[SYNC] Transaction saved to cloud collection');
      } catch (e) {
        handleFirebaseError(e, "Cloud Transaction Record");
      }
    }
  }

  /**
   * Pushes transactions created while offline to the cloud sub-collection
   */
  async function syncOfflineTransactions() {
    if (!currentUser || !dbFirestore || !navigator.onLine) return;
    const unsynced = transactions.filter(t => !t.synced);
    if (unsynced.length === 0) return;

    console.log(`[SYNC] Found ${unsynced.length} offline transactions. Syncing...`);
    for (let tx of unsynced) {
      try {
        const txRef = collection(dbFirestore, "users", currentUser.uid, "transactions");
        const { synced, ...txData } = tx;
        await addDoc(txRef, txData);
        tx.synced = true; // Update reference in the 'transactions' array
      } catch (e) { break; } // Stop if we hit API errors
    }
    await saveState('transactions', transactions);
    renderTransactions();
  }

  /**
   * Loads the latest transactions from the cloud collection
   */
  async function loadTransactionsFromCloud(uid, startDate = null, endDate = null) {
    if (!dbFirestore) return;
    try {
      let txRef = collection(dbFirestore, "users", uid, "transactions");
      let q;
      
      if (startDate || endDate) {
        // Note: Range queries with OrderBy require a composite index in Firestore.
        // If you see an error in the console, click the provided link to create the index.
        const constraints = [orderBy("date", "desc")];
        if (startDate) constraints.push(where("date", ">=", startDate));
        if (endDate) constraints.push(where("date", "<=", endDate + "T23:59:59Z"));
        q = query(txRef, ...constraints);
      } else {
        q = query(txRef, orderBy("date", "desc"), limit(200));
      }

      const snap = await getDocs(q);
      const cloudTransactions = [];
      snap.forEach(doc => {
        const data = doc.data();
        data.synced = true;
        cloudTransactions.push(data);
      });

      if (cloudTransactions.length > 0) {
        transactions = cloudTransactions;
        saveState('transactions', transactions);
        renderTransactions();
        updateDashboard();
      }
    } catch (e) { console.warn("Could not load transactions from collection:", e); }
  }

  async function syncNow() {
    if (!currentUser) return alert("Please login to sync data to the cloud.");
    const syncBtn = document.getElementById('sync-now-btn');
    const icon = '🔄';
    syncBtn.innerHTML = '<span class="spinner"></span>';
    syncBtn.disabled = true;
    
    try {
      await saveData();
    } catch (e) {
      alert("Sync failed: " + e.message);
    } finally {
      syncBtn.innerHTML = icon;
      syncBtn.disabled = false;
    }
  }

  function updateOnlineStatus() {
    let container = document.getElementById('connectivity-container');
    if (!container) {
      const header = document.querySelector('header');
      if (!header) return; // Safety check: if header isn't rendered yet, skip
      container = document.createElement('div');
      container.id = 'connectivity-container'; // Adjusted right position
      container.style.cssText = 'position: absolute; right: 175px; display: flex; align-items: center; gap: 8px; font-size: 0.6em;';
      
      const statusEl = document.createElement('span');
      statusEl.id = 'connectivity-status';
      statusEl.style.cssText = 'transition: all 0.3s; cursor: default;';
      container.appendChild(statusEl);

      // Add Spinner CSS
      const style = document.createElement('style');
      style.textContent = `
        .spinner {
          display: inline-block; width: 10px; height: 10px;
          border: 2px solid rgba(255,255,255,0.3); border-radius: 50%;
          border-top-color: #fff; animation: spin 1s ease-in-out infinite;
          margin-right: 4px; vertical-align: middle;
        }
        @keyframes pulse-sync {
          0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.7); }
          70% { transform: scale(1.1); box-shadow: 0 0 0 10px rgba(255, 255, 255, 0); }
          100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); }
        }
        .sync-pulse { animation: pulse-sync 0.6s ease-in-out; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `;
      document.head.appendChild(style);

      const syncInfo = document.createElement('div');
      syncInfo.style.cssText = 'display: flex; flex-direction: column; align-items: flex-start; line-height: 1.1; text-align: left;';
      syncInfo.innerHTML = `
        <button id="sync-now-btn" onclick="syncNow()" data-tooltip="Not synced yet" style="background: none; border: none; color: white; cursor: pointer; padding: 0; font-size: 1.2em; margin-top: 2px;">🔄</button>
      `;
      container.appendChild(syncInfo);
      
      header.appendChild(container);
    }

    const statusEl = document.getElementById('connectivity-status');
    if (navigator.onLine && syncFailureCount === 0) {
      statusEl.textContent = '🟢';
      statusEl.title = 'Online & Synced';
      syncOfflineTransactions();
    } else if (navigator.onLine && syncFailureCount > 0) {
      statusEl.textContent = '🔴';
      statusEl.title = `Sync error (${syncFailureCount} failures)`;
    } else {
      statusEl.textContent = '🔴';
      statusEl.title = 'Offline';
    }
  }

  function updateAuthUI(user) {
    // Remove existing auth container if any
    const existingAuth = document.getElementById('auth-header-container');
    if (existingAuth) existingAuth.remove();

    const authContainer = document.createElement('div'); // Adjusted right position
    authContainer.id = 'auth-header-container';
    authContainer.style.cssText = 'position: absolute; right: 95px; display: flex; align-items: center; gap: 10px; font-size: 0.85em;';

    if (user) {
      const displayName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];
      authContainer.innerHTML = `
        <span style="font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,0.2); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${displayName}</span>
        <img src="${user.photoURL || 'https://placehold.co/30'}" style="width: 32px; height: 32px; border-radius: 50%; border: 2px solid white;">
        <button onclick="logout()" class="logout-icon-btn" data-tooltip="Logout">
          ✕
        </button>
      `;
      // Check if user has completed the second stage (PIN)
      if (isPinVerified) {
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.style.display = 'none';
        const lockBtn = document.getElementById('nav-lock-btn');
        if (lockBtn) lockBtn.style.display = 'inline-block';
        applyRolePermissions();
      } else {
        showLoginOverlay();
        const lockBtn = document.getElementById('nav-lock-btn');
        if (lockBtn) lockBtn.style.display = 'none';
      }
    } else {
      authContainer.innerHTML = `
        <button onclick="login()" class="btn" style="margin: 0; background: white; color: var(--primary); font-size: 0.8em; padding: 5px 12px; display: flex; align-items: center; gap: 8px; border-radius: 4px; border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.2);">
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width: 16px; height: 16px;">
          Login with Google
        </button>
      `;
      // Ensure login overlay is visible
      showLoginOverlay();
      const lockBtn = document.getElementById('nav-lock-btn');
      if (lockBtn) lockBtn.style.display = 'none';
    }
    const header = document.querySelector('header');
    header.appendChild(authContainer);
  }

  function lockApp() {
    isPinVerified = false;
    sessionStorage.removeItem('isPinVerified');
    currentUserRole = null;
    sessionStorage.removeItem('currentUserRole');
    sessionStorage.removeItem('currentUserPermissions');
    currentLoggedInStaffName = '';
    sessionStorage.removeItem('currentLoggedInStaffName');
    showLoginOverlay();
    const lockBtn = document.getElementById('nav-lock-btn');
    if (lockBtn) lockBtn.style.display = 'none';
  }

  async function login() {
    const provider = new GoogleAuthProvider();
    const btn = document.querySelector('#login-overlay button');
    const originalContent = btn ? btn.innerHTML : 'Login with Google';
    if (btn) btn.innerHTML = '<span class="spinner"></span> Signing in...';
    
    try {
      await signInWithPopup(auth, provider);
      location.reload(); 
    } catch (error) {
      console.error("Login failed:", error);
      alert("Login failed: " + error.message);
      if (btn) btn.innerHTML = originalContent;
    }
  }

  async function loginWithEmail() {
    const email = document.getElementById('authEmail')?.value?.trim();
    const password = document.getElementById('authPassword')?.value?.trim();
    if (!email || !password) return alert("Please enter email and password.");
    
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      if (error.code === 'auth/invalid-credential' || error.code === 'auth/user-not-found') {
        alert("Login failed: Incorrect email or password.");
      } else {
        alert("Login failed: " + error.message);
      }
    }
  }

  async function registerWithEmail() {
    const emailInput = document.getElementById('authEmail');
    const passwordInput = document.getElementById('authPassword');
    const nameInput = document.getElementById('authName');
    const confirmInput = document.getElementById('authConfirmPassword');

    const email = emailInput?.value?.trim();
    const password = passwordInput?.value?.trim();
    const name = nameInput?.value?.trim();
    const confirmPassword = confirmInput?.value?.trim();

    if (!email || !password) return alert("Please enter email and password.");
    if (nameInput && !name) return alert("Please enter your name.");
    if (confirmInput && password !== confirmPassword) return alert("Passwords do not match.");
    
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return alert("Password must be at least 8 characters long, and include at least one uppercase letter, one lowercase letter, one number, and one special character.");
    }

    try {
      if (auth.currentUser) {
        // User is already signed in (e.g. Google), link email/pass so they can use either
        const credential = EmailAuthProvider.credential(email, password);
        await linkWithCredential(auth.currentUser, credential);
        // Update name if provided and not already set
        if (name && !auth.currentUser.displayName) {
          await updateProfile(auth.currentUser, { displayName: name });
        }
        alert("Email login successfully added to your account! You can now log in with either Google or this password.");
      } else {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        if (name) {
          await updateProfile(userCredential.user, { displayName: name });
        }
        alert("Registration successful! You are now logged in.");
      }
    } catch (error) {
      if (error.code === 'auth/email-already-in-use') {
        alert("This email is already registered. If you previously used Google, try logging in with Google first, then add a password.");
      } else {
        alert("Registration failed: " + error.message);
      }
    }
  }

  async function handleForgotPassword() {
    const email = document.getElementById('authEmail').value || prompt("Please enter your email address:");
    if (!email) return;

    try {
      await sendPasswordResetEmail(auth, email);
      alert("Password reset email sent! Please check your inbox.");
    } catch (error) {
      alert("Error: " + error.message);
    }
  }

  let activeAuthAction = null;

  function openAuthModal(action) {
    if (!currentUser) return alert("You must be logged in.");
    activeAuthAction = action;
    
    const modal = document.getElementById('authActionModal');
    const title = document.getElementById('authModalTitle');
    const desc = document.getElementById('authModalDescription');
    const curPass = document.getElementById('currentPasswordField');
    const newPass = document.getElementById('newPasswordFields');
    const submitBtn = document.getElementById('authModalSubmitBtn');

    // Reset fields
    document.getElementById('authCurrentPassword').value = '';
    document.getElementById('authNewPassword').value = '';
    document.getElementById('authConfirmNewPassword').value = '';

    const isEmailUser = currentUser.providerData.some(p => p.providerId === 'password');

    if (action === 'changePassword') {
      title.textContent = "Change Password";
      desc.textContent = "Enter your current password and a new secure password.";
      curPass.style.display = 'block';
      newPass.style.display = 'block';
    } else if (action === 'linkPassword') {
      title.textContent = "Create Email Login";
      desc.textContent = "Set a password to allow signing in with your email address in addition to Google.";
      curPass.style.display = 'none';
      newPass.style.display = 'block';
    } else if (action === 'deleteAccount') {
      title.textContent = "Delete Account";
      desc.textContent = "WARNING: This will permanently delete your account and all shop data. Please enter your password to confirm.";
      curPass.style.display = isEmailUser ? 'block' : 'none';
      newPass.style.display = 'none';
      if (!isEmailUser) desc.textContent = "WARNING: This will permanently delete your account and all shop data. Confirm with the button below.";
    }

    modal.style.display = 'flex';
  }

  function closeAuthModal() {
    document.getElementById('authActionModal').style.display = 'none';
    activeAuthAction = null;
  }

  async function submitAuthAction() {
    const curPassValue = document.getElementById('authCurrentPassword').value;
    const newPassValue = document.getElementById('authNewPassword').value;
    const confirmPassValue = document.getElementById('authConfirmNewPassword').value;
    
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    const isEmailUser = currentUser.providerData.some(p => p.providerId === 'password');

    const submitBtn = document.getElementById('authModalSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = "Processing...";

    try {
      if (activeAuthAction === 'changePassword' || (activeAuthAction === 'deleteAccount' && isEmailUser)) {
        if (!curPassValue) throw new Error("Please enter your current password.");
        const credential = EmailAuthProvider.credential(currentUser.email, curPassValue);
        await reauthenticateWithCredential(currentUser, credential);
      }

      if (activeAuthAction === 'changePassword' || activeAuthAction === 'linkPassword') {
        if (!passwordRegex.test(newPassValue)) throw new Error("New password must be at least 8 characters long, and include uppercase, lowercase, numbers, and symbols.");
        if (newPassValue !== confirmPassValue) throw new Error("New passwords do not match.");
        
        if (activeAuthAction === 'changePassword') {
          await updatePassword(currentUser, newPassValue);
          alert("Password updated successfully!");
        } else {
          const credential = EmailAuthProvider.credential(currentUser.email, newPassValue);
          await linkWithCredential(currentUser, credential);
          alert("Email login successfully added! You can now use either Google or this password.");
        }
      } else if (activeAuthAction === 'deleteAccount') {
        if (confirm("FINAL WARNING: All your data will be lost. Are you absolutely sure?")) {
          await deleteUser(currentUser);
          alert("Account deleted.");
          location.reload();
          return;
        }
      }
      
      closeAuthModal();
      loadSettings(); // Refresh UI
    } catch (error) {
      alert("Error: " + error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Confirm";
    }
  }

  // Expose these for the UI
  window.openAuthModal = openAuthModal;
  window.closeAuthModal = closeAuthModal;
  window.submitAuthAction = submitAuthAction;

  async function handleChangePassword() {
    const isEmailUser = currentUser?.providerData.some(p => p.providerId === 'password');
    if (isEmailUser) {
      openAuthModal('changePassword');
    } else {
      alert("This account doesn't have a password. Use the 'Create Password' button instead.");
    }
  }

  async function logout() {
    if (confirm("Are you sure you want to log out?")) {
      sessionStorage.removeItem('currentUserRole');
      sessionStorage.removeItem('currentUserPermissions');
      sessionStorage.removeItem('isPinVerified');
      await signOut(auth);
      location.reload();
    }
  }

  function updateItemUnit(itemIndex, newUnit) {
    if (menu[itemIndex]) {
      menu[itemIndex].unit = newUnit;
      saveData();
    }
  }

  async function refreshApp() {
    try {
      await saveData();
      location.reload();
    } catch (error) {
      console.error("Failed to save data before refresh:", error);
      if (confirm("Could not save data before refreshing. You may lose unsaved changes. Do you still want to refresh?")) {
        location.reload();
      }
    }
  }

  function updateCurrencyDisplay() {
    const symbol = settings.currency || '$';
    document.querySelectorAll('.currency-symbol').forEach(el => el.textContent = symbol);
  }

  // ===== Tabs =====
  function showTab(tabId, btn) {
    const isManager = currentUserRole === 'manager';
    if (!isManager && !currentUserPermissions.includes(tabId)) {
      return alert("Access Denied: This section is restricted to Managers.");
    }

    document.querySelectorAll('section').forEach(sec => sec.classList.remove('active')); 
    const activeSection = document.querySelector(`#${tabId}`);
    activeSection.classList.add('active');

    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    toggleNav(false); // Close nav after selection

    // Special rendering logic for tabs
    switch (tabId) {
      case 'dashboardTab':
        updateDashboard();
        break;
      case 'transactionsTab':
        renderTransactions();
        break;
      case 'menuTab':
        renderMenu();
        break;
      case 'addDishTab':
        renderDishesTable();
        break;
      case 'categoryTab':
        renderCategoryList();
        break;
      case 'unitTab':
        renderUnitList();
        break;
      case 'staffTab':
        renderStaffList();
        break;
      case 'customerTab':
        renderCustomerList();
        break;
      case 'settingsTab':
        loadSettings();
        break;
      case 'stockTab':
        renderInventoryReport(); // For the low stock report
        renderStockListTable(); // For the main stock table
        renderUnitList();
        renderRestockHistoryTable(); // For the main stock table
        break;
      case 'reportsTab':
        populateReportFilters();
        renderReport();
        break;
    }
  }

  // ===== Navigation Toggle =====
  function toggleNav(forceState) {
    const nav = document.querySelector('nav');
    if (typeof forceState === 'boolean') {
      nav.classList.toggle('open', forceState);
    } else {
      nav.classList.toggle('open');
    }
  }

  // ===== Menu =====
  function renderMenu() {
    const container = document.getElementById('menuCategories');
    container.innerHTML = '';

    const searchTerm = document.getElementById('menuSearch')?.value.toLowerCase() || '';
    const categoryFilter = document.getElementById('categoryFilter')?.value || '';

    // Filter for the search term AND ensure the item is a sellable dish (has a recipe).
    // Also filter out items that don't have a category.
    const filteredMenu = menu.filter(dish => {
      const matchesSearch = dish.category && (dish.name.toLowerCase().includes(searchTerm) || (dish.barcode && dish.barcode.toLowerCase().includes(searchTerm))) && dish.recipe && dish.recipe.length > 0;
      const matchesCategory = categoryFilter === '' || dish.category === categoryFilter;
      return matchesSearch && matchesCategory;
    });

    const categories = [...new Set(filteredMenu.map(d => d.category || "Uncategorized"))];
    
    categories.forEach(cat => {
      const catDiv = document.createElement('div');
      if (cat !== "Uncategorized") {
        catDiv.innerHTML = `<h4>${cat}</h4>`;
      }
      const grid = document.createElement('div');
      grid.className = 'menu-grid';
      filteredMenu
          .filter(d => (d.category || "Uncategorized") === cat)
          .forEach((dish, i) => {
            const item = document.createElement('div');
            const currentOrder = activeOrders[CART_ID] || { items: [] };
            const orderItem = currentOrder.items.find(o => o.name === dish.name);
            const quantity = orderItem ? orderItem.qty : 0;
            const stock = calculateDishStock(dish, true);
            const isOutOfStock = stock <= 0;

            let itemClasses = 'menu-item';
            if (quantity > 0) itemClasses += ' active';
            if (isOutOfStock) itemClasses += ' out-of-stock';

            item.className = itemClasses;
            item.onclick = (e) => { // Allow adding item by clicking the card
              if (isOutOfStock) return alert("Item is out of stock.");
              if (e.target.closest('.item-controls')) return;
              addToOrder(CART_ID, dish.name);
            };

            item.innerHTML = `
              <img src="${dish.image}" alt="">
              <div class="menu-item-body">
                <div class="menu-item-header">
                  <h4>${dish.name}</h4>
                  <p><span class="currency-symbol">${settings.currency || '$'}</span>${formatCurrency(dish.price)}</p>
                </div>
                <p class="stock-status ${isOutOfStock ? 'out-of-stock' : 'in-stock'}">Stock: ${stock}</p>
                <div class="item-controls">
                  <button onclick="decreaseQty('${CART_ID}', '${dish.name}')" ${quantity === 0 ? 'disabled' : ''}>-</button>
                  <span class="qty-display">${quantity}</span>
                  <button onclick="addToOrder('${CART_ID}', '${dish.name}')" ${isOutOfStock ? 'disabled' : ''}>+</button>
                </div>
              </div>`;
            grid.appendChild(item);
          });
      catDiv.appendChild(grid);
      container.appendChild(catDiv);
    });

    updateOrders(CART_ID);
    renderDishesTable();
    saveData();
  }

  async function addDish(buttonElement) {
    const name = document.getElementById('dishName').value.trim();    
    const barcode = document.getElementById('dishBarcode').value.trim();
    const category = document.getElementById('dishCategory').value;
    const imageInput = document.getElementById('dishImage');

    if (!name) {
      return alert("Please enter a valid name.");
    }

    if (!category) {
      return alert("Please select a category for the dish.");
    }

    if (buttonElement) {
      buttonElement.disabled = true;
      buttonElement.textContent = 'Processing...';
    }
    
    let totalRecipeCost = 0;
    const recipe = Array.from(document.querySelectorAll('#recipeItemsContainer .recipe-item')).map(itemDiv => {
        totalRecipeCost += parseFloat(itemDiv.dataset.cost) || 0;
        return {
            itemName: itemDiv.dataset.itemName,
            quantity: parseFloat(itemDiv.dataset.quantity)
        };
    });

    const costPrice = totalRecipeCost;
    const price = parseFloat(document.getElementById('dishSellingPrice').value) || 0;

    try {
      let image = document.getElementById('dishImageBase64').value || "https://placehold.co/100";
      const dishIndex = document.getElementById('dishIndex').value;

      // If image is local Base64, upload to Fire Storage
      if (image.startsWith('data:image')) {
        image = await uploadImage(image, `dishes/${Date.now()}.jpg`);
      }

      if (dishIndex !== '') {
        // It's an update
        const index = parseInt(dishIndex, 10);
        const oldName = menu[index].name;

        let dishData = { name, barcode, category, recipe, costPrice, price, image: image };
        menu[index] = dishData;

        // Update active orders immediately to sync name, price, and details
        Object.keys(activeOrders).forEach(cartId => {
            if (activeOrders[cartId].items) {
                activeOrders[cartId].items.forEach(item => {
                    if (item.name === oldName) {
                        item.name = name;
                        item.price = price;
                        item.costPrice = costPrice;
                        item.image = image;
                    }
                });
            }
        });

      } else {
        // It's a new dish
        let dishData = { name, barcode, category, recipe, costPrice, price, image: image };
        // Clear form only for new dishes
        document.getElementById('dishName').value = '';
        document.getElementById('dishBarcode').value = '';
        imageInput.value = ''; // Reset file input
        menu.push(dishData);
      }

      // Force update all orders to sync new prices/details
      Object.keys(activeOrders).forEach(cartId => updateOrders(cartId));

      renderMenu();
      renderDishesTable(); // Update the dishes list
      updateDashboard();
      saveData(); // Ensure changes are saved
      toggleAddDishForm(false); // Hide form on save
    } catch (error) {
      console.error("Error adding dish:", error);
      alert("Failed to save dish: " + error.message);
    } finally {
      if (buttonElement) {
        buttonElement.disabled = false;
        const dishIndex = document.getElementById('dishIndex').value;
        buttonElement.textContent = dishIndex !== '' ? 'Update' : 'Save'; // Restore original text
      }
    }
  }

  function generateRandomBarcode() {
    // Generate a random 12-digit number (like UPC)
    const code = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    document.getElementById('dishBarcode').value = code;
  }

  function editDish(index) {
    
    const dish = menu[index];
    document.getElementById('dishIndex').value = index;
    document.getElementById('dishName').value = dish.name;
    document.getElementById('dishBarcode').value = dish.barcode || '';
    document.getElementById('dishCategory').value = dish.category;
    
    document.getElementById('dishImageBase64').value = dish.image || ''; // Store current image
    document.getElementById('dishSellingPrice').value = (dish.price || 0);

    // Show the form first to ensure all elements are visible and ready.
    toggleAddDishForm(true); 
    document.getElementById('recipeItemsContainer').innerHTML = '';

    // Now that the form is visible and dropdowns are populated, set the category.
    document.getElementById('dishCategory').value = dish.category;

    // Populate recipe builder
    const recipeContainer = document.getElementById('recipeItemsContainer'); 
    if (dish.recipe) {
        dish.recipe.forEach(recipeComponent => {
            addRecipeItem(recipeComponent.itemName, recipeComponent.quantity);
        });
    }
    updateRecipeTotals();

    // If the edit button was clicked from the settings tab, switch to the dishes tab
    const settingsTab = document.getElementById('settingsTab');
    if (settingsTab.classList.contains('active')) {
        showTab('addDishTab', document.querySelector('nav button[onclick*="addDishTab"]'));
    }
  }

  function addRecipeItem(selectedItem, quantity) {
    const ingredient = menu.find(item => item.name === selectedItem && !item.recipe);
    if (!ingredient) return; 

    if (ingredient.stock !== undefined && ingredient.stock <= 0) {
      alert(`"${ingredient.name}" is out of stock. Please add this item to your stock before using it in a recipe.`);
      return;
    }
    
    const container = document.getElementById('recipeItemsContainer');
    const itemDiv = document.createElement('div');
    itemDiv.className = 'recipe-item';
    itemDiv.dataset.itemName = selectedItem;
    itemDiv.dataset.quantity = quantity;
    itemDiv.dataset.cost = (ingredient.costPrice || 0) * quantity;

    const removeBtn = document.createElement('button');
    removeBtn.innerHTML = '&times;';
    removeBtn.onclick = () => {
      itemDiv.remove();
      updateRecipeTotals();
    };

    itemDiv.innerHTML = `<span class="u-flex-grow-1">${quantity} x ${selectedItem}</span>
                         <span><span class="currency-symbol">$</span>${formatCurrency((ingredient.costPrice || 0) * quantity)}</span>`;
    itemDiv.appendChild(removeBtn);
    container.appendChild(itemDiv);
  }

  function addNewRecipeItemFromForm() {
    const select = document.getElementById('newRecipeItemSelect');
    const qtyInput = document.getElementById('newRecipeItemQty');
    const itemName = select.value;
    const quantity = parseFloat(qtyInput.value);

    if (itemName && !isNaN(quantity) && quantity > 0) {
      addRecipeItem(itemName, quantity);
      updateRecipeTotals();
    }
  }

  function updateRecipeItemUnit() {
    const select = document.getElementById('newRecipeItemSelect');
    const unitInput = document.getElementById('newRecipeItemUnit');
    const selectedIngredientName = select.value;
    const ingredient = menu.find(item => item.name === selectedIngredientName);
    unitInput.value = ingredient ? (ingredient.unit || 'N/A') : '';
  }

  function updateRecipeTotals() {
    const recipeItems = document.querySelectorAll('#recipeItemsContainer .recipe-item');
    let totalCost = 0;
    recipeItems.forEach(item => {
        totalCost += parseFloat(item.dataset.cost) || 0;
    });

    document.getElementById('dishCostPrice').value = formatCurrency(totalCost);

    const sellingPrice = parseFloat(document.getElementById('dishSellingPrice').value) || 0;
    const profitValue = sellingPrice - totalCost;
    const profitMargin = sellingPrice > 0 ? (profitValue / sellingPrice) * 100 : 0;

    document.getElementById('dishProfitValue').textContent = formatCurrency(profitValue); // Currency, so formatCurrency is fine
    document.getElementById('dishProfitMargin').textContent = profitMargin.toLocaleString(undefined, { maximumFractionDigits: 1 }); // Percentage, max 1 decimal
  }

  function calculateRecipeCost(recipe) {
      if (!recipe) return 0;
      return recipe.reduce((total, component) => {
          const ingredient = menu.find(item => item.name === component.itemName && !item.recipe);
          if (ingredient) {
              return total + (ingredient.costPrice || 0) * component.quantity;
          }
          return total;
      }, 0);
  }

  function populateRecipeIngredientSelect() {
      const select = document.getElementById('newRecipeItemSelect');
      const ingredients = menu.filter(item => !item.recipe && item.stock > 0); // Only show raw ingredients with stock
      select.innerHTML = ingredients.map(item => `<option value="${item.name}">${item.name} (Stock: ${Number(item.stock).toFixed(1)})</option>`).join('');
  }


  // Helper to convert file to Base64 with resizing
  const toBase64 = file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = event => {
          const img = new Image();
          img.src = event.target.result;
          img.onload = () => {
              const elem = document.createElement('canvas');
              const maxWidth = 800; // Resize to max 800px to save space and memory
              const maxHeight = 800;
              let width = img.width;
              let height = img.height;

              if (width > height) {
                  if (width > maxWidth) {
                      height *= maxWidth / width;
                      width = maxWidth;
                  }
              } else {
                  if (height > maxHeight) {
                      width *= maxHeight / height;
                      height = maxHeight;
                  }
              }
              elem.width = width;
              elem.height = height;
              const ctx = elem.getContext('2d');
              ctx.drawImage(img, 0, 0, width, height);
              resolve(elem.toDataURL('image/jpeg', 0.7)); // Compress to JPEG 70%
          };
          img.onerror = error => reject(new Error("Failed to process image data."));
      };
      reader.onerror = error => reject(new Error("File reading failed. Please check app permissions."));
  });

  function sanitizeLogoUrl(url) {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (trimmed.includes('${')) return null; // Prevent template placeholder leakage
    if (/^(data:|https?:|\/|\.\/|\.\.)/i.test(trimmed)) return trimmed;
    return null;
  }

  function previewDishImage(input) {
    const preview = document.getElementById('dishImagePreview');
    const hiddenInput = document.getElementById('dishImageBase64');
    if (input.files && input.files[0]) {
      // Use the robust toBase64 function for preview as well
      toBase64(input.files[0]).then(base64 => {
        preview.src = base64;
        hiddenInput.value = base64; // Save base64 immediately to avoid re-reading file
      }).catch(e => {
        console.error(e);
        alert("Could not preview image: " + e.message);
        input.value = ''; // Clear input
        preview.src = 'https://placehold.co/100';
      });
    } else {
      preview.src = 'https://placehold.co/100';
    }
  }
  function toggleAddDishForm(show) {
    const formContainer = document.getElementById('addDishFormContainer');
    const toggleButton = document.querySelector('#addDishTab h3 button');
    if (show) {
      formContainer.style.display = 'block';
      populateRecipeIngredientSelect();
      updateRecipeItemUnit();
      populateCategoryDropdown();
      populateStockNameList();
      toggleButton.style.display = 'none';
    } else {
      document.getElementById('dishIndex').value = ''; // Clear index on hide
      formContainer.style.display = 'none';
      toggleButton.style.display = 'inline-block';
      document.getElementById('recipeItemsContainer').innerHTML = ''; // Clear recipe on close
      document.getElementById('dishName').value = '';
      document.getElementById('dishBarcode').value = '';
      document.getElementById('dishImagePreview').src = 'https://placehold.co/100';
      document.getElementById('dishImageBase64').value = '';
      document.getElementById('dishSellingPrice').value = '';
    }
  }

  function populateStockNameList() {
    const datalist = document.getElementById('stockNameList');
    if (!datalist) return;
    datalist.innerHTML = '';
    const stockItems = menu.filter(item => item.stock !== undefined);
    stockItems.forEach(item => {
        const option = document.createElement('option');
        option.value = item.name;
        datalist.appendChild(option);
    });
  }

  function formatCurrency(number) {
    const num = parseFloat(number) || 0;
    // Using toLocaleString to automatically add thousand separators and limit to 1 decimal place
    return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  }

  // ===== Bill Splitting (New Implementation) =====
  let splitState = { unassigned: [], bills: [] };

  function openBillSplitModal() {
    const currentOrder = activeOrders[CART_ID];
    if (!currentOrder || currentOrder.items.length === 0) {
      return alert("No active order to split.");
    }
    document.getElementById('splitBillTableId').textContent = "Current Order";

    // Initialize split state from the current order
    splitState.unassigned = JSON.parse(JSON.stringify(currentOrder.items)); // Deep copy
    splitState.bills = [];

    renderSplitBillUI();
    document.getElementById('billSplitModal').style.display = 'flex';
  }

  function closeSplitBillModal() {
    document.getElementById('billSplitModal').style.display = 'none';
    // Clear state to avoid issues on next open
    splitState = { unassigned: [], bills: [] };
  }

  function renderSplitBillUI() {
    const unassignedContainer = document.getElementById('unassignedItems');
    const splitBillsContainer = document.getElementById('splitBillsContainer');
    unassignedContainer.innerHTML = '';
    splitBillsContainer.innerHTML = '';

    // Render unassigned items
    splitState.unassigned.forEach((item, index) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'split-item';
      itemEl.innerHTML = `<span>${item.qty}x ${item.name}</span><span><span class="currency-symbol">$</span>${formatCurrency(item.price * item.qty)}</span>`;
      itemEl.onclick = () => moveItemToFirstBill(index);
      unassignedContainer.appendChild(itemEl);
    });

    // Render split bills
    splitState.bills.forEach((bill, billIndex) => {
      const billBox = document.createElement('div');
      billBox.className = 'split-bill-box';
      let billTotal = 0;

      let itemsHtml = bill.items.map((item, itemIndex) => {
        billTotal += item.price * item.qty;
        return `<div class="split-item" onclick="moveItemToUnassigned(${billIndex}, ${itemIndex})">
                  <span>${item.qty}x ${item.name}</span>
                  <span><span class="currency-symbol">$</span>${formatCurrency(item.price * item.qty)}</span>
                </div>`;
      }).join('');

      billBox.innerHTML = `
        <h5 style="margin-top: 0; display: flex; justify-content: space-between;">
          <span>Person ${billIndex + 1}</span>
          <button class="icon-btn" onclick="removeSplitBill(${billIndex})" title="Remove Bill" style="font-size: 14px;">✖</button>
        </h5>
        <div style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1;">${itemsHtml}</div>
        <div class="total" style="margin-top: 10px;">Total: <span class="currency-symbol">$</span>${formatCurrency(billTotal)}</div>
      `;
      splitBillsContainer.appendChild(billBox);
    });

    document.getElementById('processSplitBtn').disabled = splitState.unassigned.length > 0 || splitState.bills.length === 0;
    updateCurrencyDisplay();
  }

  function addSplitBill() {
    splitState.bills.push({ items: [] });
    renderSplitBillUI();
  }

  function removeSplitBill(billIndex) {
    const bill = splitState.bills[billIndex];
    // Move all items from this bill back to unassigned
    splitState.unassigned.push(...bill.items);
    splitState.bills.splice(billIndex, 1);
    renderSplitBillUI();
  }

  function moveItemToFirstBill(itemIndex) {
    if (splitState.bills.length === 0) {
      addSplitBill(); // Auto-create the first bill if none exist
    }
    const item = splitState.unassigned.splice(itemIndex, 1)[0];
    splitState.bills[0].items.push(item);
    renderSplitBillUI();
  }

  function moveItemToUnassigned(billIndex, itemIndex) {
    const item = splitState.bills[billIndex].items.splice(itemIndex, 1)[0];
    splitState.unassigned.push(item);
    renderSplitBillUI();
  }

  async function processSplitPayments() {
    if (splitState.unassigned.length > 0) {
      return alert("Please assign all items before processing payments.");
    }

    const serverName = getCurrentServerName();
    closeSplitBillModal();

    for (let i = 0; i < splitState.bills.length; i++) {
      const bill = splitState.bills[i];
      const billTotal = calculateTransactionTotals(bill.items).total;

      // Use a promise to wait for each payment to be confirmed
      const paymentConfirmed = await new Promise(resolve => {
        document.getElementById('paymentTotalDue').textContent = formatCurrency(billTotal);
        document.getElementById('paymentModal').style.display = 'flex';
        document.querySelector('#paymentModal h3').textContent = `Payment for Person ${i + 1} / ${splitState.bills.length}`;
        toggleCashPaymentFields();
        calculateChange();

        document.getElementById('confirmPaymentBtn').onclick = () => resolve(true);
        document.querySelector('#paymentModal button[onclick*="Cancel"]').onclick = () => resolve(false);
      });

      if (paymentConfirmed) {
        const paymentMethod = document.getElementById('paymentMethod').value;
        const transaction = { date: new Date().toISOString(), customerName: serverName, tableNo: 'Shop', items: bill.items, total: billTotal, paymentMethod: paymentMethod };
        await recordTransaction(transaction); // Use individual record helper
        bill.items.forEach(item => deductStock(item.name, item.qty));
        document.getElementById('paymentModal').style.display = 'none';
      } else {
        alert("Payment cancelled. Remaining split bills will not be processed.");
        saveData(); // Save any payments that were processed
        return; // Exit the loop
      }
    }

    // All payments processed, clear the original order
    delete activeOrders[CART_ID];
    saveData();
    renderMenu();
    updateDashboard();
    alert(`All split payments processed successfully!`);
  }

  // ===== Orders =====
  function addToOrder(cartId, name, notes = null) {
    if (!activeOrders[cartId]) {
      activeOrders[cartId] = { items: [], server: '' };
    }

    const dish = menu.find(d => d.name === name);
    if (!dish) return alert("Item not found.");

    // If notes are being added, we always create a new item.
    if (notes !== null) {
        const note = prompt(`Add special requests for ${name}:`, "");
        if (note !== null) { // prompt not cancelled
            // Add as a new line item with a unique ID
            activeOrders[cartId].items.push({ ...dish, qty: 1, notes: note, id: Date.now() });
            updateOrders(cartId);
            renderMenu();
        }
        return;
    }

    const existing = activeOrders[cartId].items.find(o => o.name === name && !o.notes);
    if (existing) existing.qty++;
    else activeOrders[cartId].items.push({ ...dish, qty: 1 });

    updateOrders(cartId);
    renderMenu();
  }

  function decreaseQty(cartId, name, id = null) {
    if (!activeOrders[cartId]) return;

    const orderItem = id ? activeOrders[cartId].items.find(o => o.id === id) : activeOrders[cartId].items.find(o => o.name === name && !o.notes);
    if (!orderItem) return;

    if (orderItem.qty > 1) {
      orderItem.qty--;
    } else {
      const itemIndex = activeOrders[cartId].items.findIndex(o => (id ? o.id === id : (o.name === name && !o.notes)));
      if (itemIndex > -1) activeOrders[cartId].items.splice(itemIndex, 1);
    }
    updateOrders(cartId);
    renderMenu();
  }

  // ===== Tables =====
  function updateOrders(cartId) {
    const currentOrder = activeOrders[cartId] || { items: [] };
    
    // Sync prices with current menu to ensure accuracy
    if (currentOrder.items && currentOrder.items.length > 0) {
      currentOrder.items.forEach(orderItem => {
        const dish = menu.find(d => d.name === orderItem.name);
        if (dish) {
          orderItem.price = parseFloat(dish.price) || 0;
          orderItem.costPrice = parseFloat(dish.costPrice) || 0;
        }
      });
    }

    const totals = calculateTransactionTotals(currentOrder.items);
    const total = totals.total;

    document.getElementById('menuTotal').textContent = formatCurrency(total);
    saveData();
    updateDashboard(); // Add this line to update dashboard cards in real-time
  }

  function processBill() { // This now opens the payment modal
    const currentOrder = activeOrders[CART_ID];
    if (!currentOrder || currentOrder.items.length === 0) {
      return alert("Cannot checkout an empty order.");
    }
    const totals = calculateTransactionTotals(currentOrder.items);

    document.getElementById('paymentSubtotal').textContent = formatCurrency(totals.subtotal);
    document.getElementById('paymentTax').textContent = formatCurrency(totals.tax);
    document.getElementById('paymentDiscountDisplay').textContent = "0.00";

    const totalDueEl = document.getElementById('paymentTotalDue');
    totalDueEl.textContent = formatCurrency(totals.total);
    totalDueEl.dataset.originalTotal = totals.total;
    totalDueEl.dataset.currentTotal = totals.total;

    document.getElementById('discountInput').value = '';

    document.getElementById('splitPaymentContainer').style.display = 'none'; // Hide split view
    document.getElementById('paymentDetails').style.display = 'block'; // Show single payment view
    document.getElementById('confirmPaymentBtn').onclick = () => finalizePayment(); // Set correct handler
    document.getElementById('paymentModal').style.display = 'flex';
    toggleCashPaymentFields(); // Initialize view based on default selection
    calculateChange(); // Initialize change calculation
  }

  function updatePaymentTotals() {
    const totalDueEl = document.getElementById('paymentTotalDue');
    const originalTotal = parseFloat(totalDueEl.dataset.originalTotal) || 0;
    const discountInput = parseFloat(document.getElementById('discountInput').value) || 0;
    
    let discountAmount = discountInput;

    if (discountAmount > originalTotal) discountAmount = originalTotal;
    if (discountAmount < 0) discountAmount = 0;

    document.getElementById('paymentDiscountDisplay').textContent = formatCurrency(discountAmount);

    const newTotal = originalTotal - discountAmount;
    totalDueEl.textContent = formatCurrency(newTotal);
    totalDueEl.dataset.currentTotal = newTotal;
    
    calculateChange();
  }

  function toggleCashPaymentFields() {
    const paymentMethod = document.getElementById('paymentMethod').value;
    const cashFields = document.getElementById('cashPaymentFields');
    cashFields.style.display = (paymentMethod === 'Cash') ? 'block' : 'none';
  }

  function calculateChange() {
    const totalDueEl = document.getElementById('paymentTotalDue');
    const totalDue = totalDueEl.dataset.currentTotal ? parseFloat(totalDueEl.dataset.currentTotal) : (parseFloat(totalDueEl.textContent.replace(/,/g, '')) || 0);
    const amountTendered = parseFloat(document.getElementById('amountTendered').value) || 0;
    const change = amountTendered - totalDue;
    document.getElementById('changeDue').textContent = change > 0 ? formatCurrency(change) : '0';
  }

  async function finalizePayment(isSplit = false) {
    const currentOrder = activeOrders[CART_ID];
    const paymentMethod = document.getElementById('paymentMethod').value;
    const amountTendered = parseFloat(document.getElementById('amountTendered').value);
    const totals = calculateTransactionTotals(currentOrder.items);
    
    // Apply Discount
    const discountInput = parseFloat(document.getElementById('discountInput').value) || 0;
    let discountAmount = discountInput;

    if (discountAmount > totals.total) discountAmount = totals.total;
    if (discountAmount < 0) discountAmount = 0;
    const finalTotal = totals.total - discountAmount;

    if (paymentMethod === 'Cash' && (isNaN(amountTendered) || amountTendered < finalTotal)) {
      return alert("Amount tendered must be greater than or equal to the total due.");
    }

    // Decrement stock
    currentOrder.items.forEach(orderItem => {
        const dish = menu.find(d => d.name === orderItem.name);
        if (dish && dish.name) { // Ensure dish and its name exist before deducting
            // This function will recursively deduct stock
            deductStock(dish.name, orderItem.qty);
        }
    });
    

    const transaction = {
      date: new Date().toISOString(),
      customerName: getCurrentServerName(), // Use the logged-in user's name
      tableNo: 'Shop',
      items: [...currentOrder.items],
      total: finalTotal,
      subtotal: totals.subtotal,
      tax: totals.tax,
      paymentMethod: paymentMethod,
      discount: { value: discountInput, type: 'fixed', amount: discountAmount }
    };
    if (isSplit) {
        // If it's a split payment, we just add the transaction and return.
        // The calling function will handle UI and data clearing.
        return transaction;
    }
    
    await recordTransaction(transaction); // Use individual record helper

    delete activeOrders[CART_ID]; // Clear the order for the table
    await saveData();
    renderMenu();
    document.getElementById('paymentModal').style.display = 'none';
    alert(`Sale processed successfully!`);
  }

  // Helper to calculate subtotal, tax, and total
  function calculateTransactionTotals(items) {
    const subtotal = items.reduce((sum, o) => sum + (o.qty * o.price), 0);
    const taxRate = settings.taxRate || 0;
    const tax = subtotal * (taxRate / 100);
    const total = subtotal + tax;
    return { subtotal, tax, total };
  }

  function calculateOrderTotal(items) {
      return calculateTransactionTotals(items).total;
  }

  function calculateDishStock(dish, isForDisplay = false) {
    // Base case: If the item has no recipe, it's a primary ingredient. Return its own stock.
    if (!dish.recipe || dish.recipe.length === 0) {
        return dish.stock !== undefined ? dish.stock : (isForDisplay ? 0 : Infinity);
    }

    let maxPossibleServings = Infinity;

    // Recursive case: Calculate stock based on the stock of its components.
    for (const component of dish.recipe) {
        const componentDish = menu.find(d => d.name === component.itemName);
        if (!componentDish) return 0; // A component of the recipe doesn't exist.

        // Recursively calculate the stock of the component dish.
        const componentStock = calculateDishStock(componentDish, isForDisplay);
        
        const possibleServings = Math.floor(componentStock / component.quantity);
        if (possibleServings < maxPossibleServings) {
            maxPossibleServings = possibleServings;
        }
    }

    return maxPossibleServings === Infinity ? 0 : maxPossibleServings;
  }

  function deductStock(itemName, quantity) {
    if (!itemName || quantity <= 0) return;
    const dish = menu.find(d => d.name === itemName);
    if (!dish) return;

    // Base case: Item is a primary ingredient, deduct from its own stock.
    if (!dish.recipe || dish.recipe.length === 0) {
        if (dish.stock !== undefined) {
            dish.stock = (dish.stock || 0) - quantity;
            if (dish.stock <= (settings.lowStockThreshold || 10)) {
                sendLowStockNotification(dish.name, dish.stock);
            }
        }
    } else { // Recursive case: Item is a composite dish, deduct from its components.
        dish.recipe.forEach(component => deductStock(component.itemName, component.quantity * quantity));
    }
  }
  // ===== Dishes Table =====
  function renderDishesTable() {
    const tbody = document.getElementById('dishesTableBody');
    tbody.innerHTML = '';
    // Filter the menu to only show items that are actual dishes (i.e., have a recipe property).
    // This separates sellable dishes from raw inventory items.
    menu.filter(dish => dish.recipe).forEach((dish) => {
      const i = menu.indexOf(dish); // Get the original index for edit/delete functions
      const stock = calculateDishStock(dish);
      const costPrice = dish.costPrice || 0;
      const sellingPrice = dish.price || 0;
      const profitValue = sellingPrice - costPrice;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><img src="${dish.image}" alt=""></td>
        <td>${dish.name}</td> 
        <td class="u-text-right u-nowrap"><span class="currency-symbol">${settings.currency || '$'}</span>${formatCurrency(costPrice)}</td>
        <td class="u-text-right u-nowrap"><span class="currency-symbol">${settings.currency || '$'}</span>${formatCurrency(sellingPrice)}</td>
        <td class="u-text-right u-nowrap"><span class="currency-symbol">${settings.currency || '$'}</span>${formatCurrency(profitValue)}</td>
        <td class="u-text-right">
          <button class="icon-btn" title="Print Label" onclick="printDishLabel(${i})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M2.5 8a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z"/><path d="M5 1a2 2 0 0 0-2 2v2H2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2H5zM4 3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2H4V3zm1 5a2 2 0 0 0-2 0v2H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-1v-2a2 2 0 0 0-2-2H5z"/></svg></button>
          <button class="icon-btn" title="Edit Dish" onclick="editDish(${i})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V12h2.293l6.5-6.5-.207-.207z"/></svg></button>
          <button class="icon-btn" title="Delete Dish" onclick="deleteItem(${i})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#dc3545" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button>
        </td>`;
      tbody.appendChild(tr);
    });
  }
  
  // Adjust dishes table header
  (function() {
    const headerRow = document.querySelector('#addDishTab table thead tr');
    if (headerRow) {
      // Header is now directly in HTML, this is no longer needed.
    }
  })();

  function deleteItem(i) {
    const index = Number(i); // Ensure index is a number
    const item = menu[index];
    if (!item) return;

    if (confirm(`Are you sure you want to delete ${item.name}?`)) {
      menu.splice(index, 1);
      saveData(); // Persist the deletion
      
      // Safely update all views with error handling to prevent one failure from stopping the rest
      // Update UI components immediately
      try { renderStockListTable(); } catch (e) { console.error("Error updating stock:", e); }
      try { renderDishesTable(); } catch (e) { console.error("Error updating dishes:", e); }
      try { renderInventoryReport(); } catch (e) { console.error("Error updating inventory:", e); }
      try { updateDashboard(); } catch (e) { console.error("Error updating dashboard:", e); }
      
      try { renderMenu(); } catch (e) { console.error("Error updating menu:", e); }
      
      try { renderDishesTable(); } catch (e) { console.error("Error updating dishes:", e); }
      try { renderStockListTable(); } catch (e) { console.error("Error updating stock:", e); }
      try { renderInventoryReport(); } catch (e) { console.error("Error updating inventory:", e); }
      try { updateDashboard(); } catch (e) { console.error("Error updating dashboard:", e); }
      saveData(); // Persist the deletion
    }
  }

  // ===== Receipt =====
  function previewOrder(transactionData = null) {
    const receiptModal = document.getElementById('receiptModal');
    let currentTransaction;

    if (transactionData) {
      currentTransaction = transactionData;
      // Store the historical transaction data on the modal itself for the print function to use
      receiptModal._transactionData = transactionData;
    } else {
      const currentOrder = activeOrders[CART_ID];
      if (!currentOrder || currentOrder.items.length === 0) {
        return alert("No active order to preview.");
      } else {
        const totals = calculateTransactionTotals(currentOrder.items);
        currentTransaction = {
          date: new Date().toLocaleString(),
          customerName: getCurrentServerName(),
          tableNo: 'Shop',
          items: [...currentOrder.items],
          total: totals.total,
          subtotal: totals.subtotal,
          tax: totals.tax
        };
        // Clear any previously stored historical transaction
        receiptModal._transactionData = null;
      }
    }

    // Populate the content and then display the modal
    populateReceiptContent(currentTransaction);
    document.getElementById('receiptModal').style.display = 'flex';
    
    updateCurrencyDisplay();
  }
  
  async function downloadCurrentReceiptAsPDF() {
    if (typeof window.jspdf === 'undefined' || typeof html2canvas === 'undefined') {
        alert("PDF generation libraries are not loaded. Please check your internet connection.");
        return;
    }
    const receiptContentEl = document.getElementById('receiptContent');
    const { jsPDF } = window.jspdf;

    try {
        const canvas = await html2canvas(receiptContentEl, {
            scale: 2, // Increase scale for better quality
            useCORS: true // Important for external images
        });

        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        pdf.save(`receipt-${Date.now()}.pdf`);

    } catch (error) {
        console.error("Error generating PDF:", error);
        alert("Could not generate PDF. There might be an issue with the receipt content.");
    }
  }

  async function shareReceipt() {
    const receiptContentEl = document.getElementById('receiptContent');
    if (typeof html2canvas === 'undefined') {
        alert("Library not loaded. Please check internet connection.");
        return;
    }
    try {
        const canvas = await html2canvas(receiptContentEl, { scale: 2, useCORS: true });
        canvas.toBlob(async (blob) => {
            const file = new File([blob], "receipt.png", { type: "image/png" });
            if (navigator.share) {
                try {
                    await navigator.share({
                        title: 'Receipt',
                        text: 'Here is your receipt from Yobill.',
                        files: [file]
                    });
                } catch (err) {
                    console.error('Share failed:', err);
                }
            } else {
                alert("Sharing is not supported on this device/browser. You can save as PDF instead.");
            }
        });
    } catch (error) {
        console.error("Error sharing receipt:", error);
        alert("Could not generate receipt image for sharing.");
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (printerDevice) {
      updatePrinterStatus(true, printerDevice.productName || 'Connected Device');
    }
  });

  function printReceipt() {
    // If a device is connected, the user might want to use that instead.
    if (printerDevice) {
      if (confirm("A thermal printer is connected. Do you want to print directly to the device instead of the browser's print dialog?")) {
        return directPrint();
      }
    }
    const receiptModal = document.getElementById('receiptModal');
    let printTransaction = receiptModal._transactionData; // Check for a historical transaction first

    if (!printTransaction) {
      // If no historical transaction is being viewed, get the active order
      const currentOrder = activeOrders[CART_ID];
      if (!currentOrder || currentOrder.items.length === 0) return alert("No active order to print.");
      const totals = calculateTransactionTotals(currentOrder.items);
      printTransaction = {
        date: new Date().toLocaleString(),
        customerName: getCurrentServerName(),
        tableNo: 'Shop',
        items: [...currentOrder.items],
        total: totals.total,
        subtotal: totals.subtotal,
        tax: totals.tax
      };
    }

    const { date, customerName, tableNo, items, total } = printTransaction; 
    const transactionId = new Date(date).getTime();

    const currencySymbol = settings.currency || '$';
    const logoUrl = sanitizeLogoUrl(settings.logo);
    const logoHtml = logoUrl ? `<img src="${logoUrl}" onerror="this.src='assets/icons/icon-192x192.png';" style="width:50px; height:50px; object-fit:contain;">` : '🧾';
    const itemsHtml = items.map(o => {
      const notesHtml = o.notes ? `<br><small style="font-style: italic;">- ${o.notes}</small>` : '';
      return `<div class="item-row"><div class="col-name">${o.name} ${notesHtml}</div><div class="col-qty">${o.qty}x</div><div class="col-price">${currencySymbol}${formatCurrency(o.price)}</div><div class="col-total">${currencySymbol}${formatCurrency(o.qty * o.price)}</div></div>`;
    }).join('');

    const receiptHtml = `
      <div class="receipt-header">
        <div class="logo">${logoHtml}</div>
        <h3>${settings.name || 'My Business'}</h3>
        <p>${settings.address || '123 Business Avenue, Suite 100'}</p>
      </div>
      <div class="receipt-details">
        <div><span>Transaction ID:</span> <span>${transactionId}</span></div>
        <div><span>Date:</span> <span>${new Date(date).toLocaleDateString()}</span></div>
        <div><span>Time:</span> <span>${new Date(date).toLocaleTimeString()}</span></div>
      </div>
      <div class="receipt-items">
        <div class="table-header"><div class="col-name">Item</div><div class="col-qty">Qty</div><div class="col-price">Price</div><div class="col-total">Total</div></div>
        ${itemsHtml}
      </div>
      <div class="receipt-summary">
        <div class="summary-line total"><span>TOTAL</span> <span>${currencySymbol}${formatCurrency(total)}</span></div>
      </div>
      <div class="receipt-footer"><p>Thank you for your visit!</p><p class="promo">Get 10% off on your next visit!</p></div>`;

    const printWindow = window.open('', 'Print Receipt', 'width=420,height=600,scrollbars=yes');
    const printHtml = `<html><head><title>Print Receipt</title><style>body { margin: 0; padding: 10px; background: #f0f0f0; } .receipt-paper { font-family: 'Courier New', Courier, monospace; background: #fff; color: #000; padding: 15px; border: 1px solid #ccc; max-width: 400px; margin: auto; } .receipt-header { text-align: center; margin-bottom: 15px; } .receipt-header .logo { font-size: 40px; margin-bottom: 5px; } .receipt-header h3 { margin: 0; font-size: 1.2em; } .receipt-header p { margin: 2px 0; font-size: 0.8em; } .receipt-details { font-size: 0.8em; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 5px 0; margin-bottom: 10px; } .receipt-details div { display: flex; justify-content: space-between; } .receipt-items .table-header { display: flex; font-weight: bold; border-bottom: 1px solid #000; padding-bottom: 3px; margin-bottom: 5px; font-size: 0.8em; } .receipt-items .item-row { display: flex; margin-bottom: 3px; font-size: 0.8em; } .receipt-items .col-name { width: 50%; } .receipt-items .col-qty { width: 10%; text-align: left; } .receipt-items .col-price { width: 20%; text-align: right; } .receipt-items .col-total { width: 20%; text-align: right; } .receipt-summary { border-top: 1px dashed #000; padding-top: 10px; margin-top: 15px; font-size: 0.9em; } .summary-line { display: flex; justify-content: space-between; margin-bottom: 5px; } .summary-line.total { font-weight: bold; font-size: 1.1em; } .receipt-footer { text-align: center; margin-top: 20px; font-size: 0.8em; } .receipt-footer .promo { margin-top: 10px; font-weight: bold; }</style></head><body><div class="receipt-paper">${receiptHtml}</div></body></html>`;
    printWindow.document.write(printHtml);
    printWindow.document.close();
    printWindow.focus(); // Focus on the new window
    printWindow.print(); // Trigger the print dialog
  }
  
  // ===== Scanner Functions =====
  let keepReadingSerial = false;
  let serialDataBuffer = '';

  async function connectUSBScanner() {
    // Try Web Serial API for USB scanners in Serial Mode
    if ("serial" in navigator) {
      try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 9600 });
        
        keepReadingSerial = true;
        readSerialLoop(port);

        document.getElementById('scannerConnectionStatus').textContent = 'Connected (Serial)';
        document.getElementById('scannerConnectionStatus').style.color = '#28a745';
        alert("Connected to Serial Scanner.");
      } catch (error) {
        console.error('Serial connection failed:', error);
        alert('Failed to connect to serial scanner: ' + error.message);
      }
    } else {
      alert("Web Serial API not supported. If your scanner is in HID mode, it works automatically.");
    }
  }

  async function readSerialLoop(port) {
    while (port.readable && keepReadingSerial) {
      const reader = port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          
          const text = new TextDecoder().decode(value);
          serialDataBuffer += text;

          if (serialDataBuffer.includes('\n') || serialDataBuffer.includes('\r')) {
            const parts = serialDataBuffer.split(/[\r\n]+/);
            serialDataBuffer = parts.pop(); // Keep incomplete part
            
            for (const code of parts) {
              if (code.trim()) processSerialInput(code.trim());
            }
          }
        }
      } catch (error) {
        console.error('Serial read error:', error);
      } finally {
        reader.releaseLock();
      }
    }
  }

  function processSerialInput(code) {
    const activeElement = document.activeElement;
    const isInput = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') && !activeElement.readOnly && !activeElement.disabled;

    if (isInput && activeElement.id !== 'scannerTestInput') {
      // Inject into active field
      const start = activeElement.selectionStart || activeElement.value.length;
      const end = activeElement.selectionEnd || activeElement.value.length;
      activeElement.value = activeElement.value.substring(0, start) + code + activeElement.value.substring(end);
      activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Use general app logic (add to order, search, etc.)
      handleBarcodeScan(code);
    }
  }

  async function connectBluetoothScanner() {
    if (!("bluetooth" in navigator)) {
      return alert("Web Bluetooth is not supported in your browser.");
    }
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      if (device.gatt) {
        await device.gatt.connect();
        document.getElementById('scannerConnectionStatus').textContent = `Connected: ${device.name}`;
        document.getElementById('scannerConnectionStatus').style.color = '#28a745';
      }
    } catch (error) {
      console.error('Bluetooth Scanner connection failed:', error);
    }
  }

  // ===== Printer Functions =====

  async function connectUSBPrinter() {
    if (!("usb" in navigator)) {
      return alert(
        "WebUSB API is not supported in your browser. Please use a recent version of Chrome or Edge."
      );
    }

    try {
      const device = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] }); // 7 is the class code for printers
      await device.open();
      await device.selectConfiguration(1);
      const iface = device.configuration.interfaces.find(i => i.interfaceClass === 7);
      await device.claimInterface(iface.interfaceNumber);

      printerDevice = device;
      printerType = 'USB';
      updatePrinterStatus(true, device.productName);
      alert(`Connected to USB printer: ${device.productName}`);
    } catch (error) {
      console.error('USB connection failed:', error);
      alert('Failed to connect to USB printer. Make sure it is connected and you have granted permission.');
    }
  }

  async function connectBluetoothPrinter() {
    if (!("bluetooth" in navigator)) {
      return alert(
        "Web Bluetooth is not supported in your browser. This feature works best in Chrome on Android, Windows, and macOS. It is NOT supported on iPhone or iPad."
      );
    }

    try {
      // Use acceptAllDevices to allow the user to select from any nearby BLE device.
      // We can still suggest common services to help the browser prioritize.
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ["000018f0-0000-1000-8000-00805f9b34fb"], // Serial Port Profile
      });

      const server = await device.gatt.connect();
      printerDevice = server;
      printerType = 'BLUETOOTH';
      updatePrinterStatus(true, device.name);
      alert(`Connected to Bluetooth printer: ${device.name}`);
    } catch (error) {
      console.error('Bluetooth connection failed:', error);
      alert(
        "Failed to connect. Make sure the printer is on, discoverable (often a blinking blue light), and you grant permission. Note: This feature is not supported on iPhones/iPads."
      );
    }
  }

  function disconnectPrinter() {
    if (printerDevice && printerType === 'BLUETOOTH') {
      printerDevice.disconnect();
    }
    // For WebUSB, closing is more complex and often just releasing the interface is enough.
    // For simplicity, we'll just nullify the device.
    printerDevice = null;
    printerType = null;
    updatePrinterStatus(false);
    alert('Printer disconnected.');
  }

  function updatePrinterStatus(isConnected, deviceName = '') {
    const statusEl = document.getElementById('printerStatus');
    const testBtn = document.getElementById('testPrintBtn');
    const disconnectBtn = document.getElementById('disconnectPrinterBtn');
    const directPrintBtn = document.getElementById('directPrintBtn');
    const headerPrinterIcon = document.getElementById('header-printer-status');

    if (isConnected) {
      statusEl.textContent = `Connected to ${deviceName}`;
      statusEl.style.color = '#28a745';
      testBtn.style.display = 'inline-block';
      disconnectBtn.style.display = 'inline-block';
      headerPrinterIcon.style.display = 'inline-block';
      if (directPrintBtn) directPrintBtn.style.display = 'inline-block';
    } else {
      statusEl.textContent = 'Not Connected';
      statusEl.style.color = 'inherit';
      testBtn.style.display = 'none';
      disconnectBtn.style.display = 'none';
      headerPrinterIcon.style.display = 'none';
      if (directPrintBtn) directPrintBtn.style.display = 'none';
    }
  }

  async function sendDataToPrinter(data) {
    if (!printerDevice) return alert('No printer connected.');

    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data + '\n\n\n'); // Add newlines to feed paper

    try {
      if (printerType === 'USB') {
        const iface = printerDevice.configuration.interfaces.find(i => i.interfaceClass === 7);
        const endpoint = iface.alternate.endpoints.find(e => e.direction === 'out');
        await printerDevice.transferOut(endpoint.endpointNumber, encodedData);

      } else if (printerType === 'BLUETOOTH') {
        // Dynamically find a writable characteristic
        const services = await printerDevice.getPrimaryServices();
        let writableCharacteristic = null;

        for (const service of services) {
          const characteristics = await service.getCharacteristics();
          // Find the first characteristic that is writable
          const found = characteristics.find(
            (c) => c.properties.write || c.properties.writeWithoutResponse
          );
          if (found) {
            writableCharacteristic = found;
            break; // Stop searching once we find one
          }
        }

        if (writableCharacteristic) {
          // Split data into chunks if it's too large for a single write
          const maxChunkSize = writableCharacteristic.service.device.gatt.mtu - 3;
          for (let i = 0; i < encodedData.length; i += maxChunkSize) {
            const chunk = encodedData.subarray(i, i + maxChunkSize);
            await writableCharacteristic.writeValueWithoutResponse(chunk);
          }
        } else {
          throw new Error("No writable characteristic found on the Bluetooth device. This printer may not be compatible.");
        }
      }
    } catch (error) {
      console.error('Failed to print:', error);
      alert('Error sending data to printer. It may have been disconnected or is not compatible. ' + error.message);
      disconnectPrinter();
    }
  }

  function testPrint() {
    const testMessage = 
      '*** Printer Test ***\n' +
      'Connection Successful!\n' +
      `App: ${settings.name || 'Yobill'}\n` +
      `Date: ${new Date().toLocaleString()}\n`;
    sendDataToPrinter(testMessage);
  }

  function directPrint() {
    const receiptContentEl = document.getElementById('receiptContent');
    // Use innerText to get a plain text representation of the receipt
    const plainTextReceipt = receiptContentEl.innerText;
    sendDataToPrinter(plainTextReceipt);
  }

  // ===== Transactions =====
  function renderTransactions() {
    const startDate = document.getElementById('transactionStartDate')?.value;
    const endDate = document.getElementById('transactionEndDate')?.value;
    
    let filteredTransactions = transactions;

    if (startDate || endDate) {
      filteredTransactions = transactions.filter(t => {
        const tDate = t.date.split('T')[0];
        if (startDate && tDate < startDate) return false;
        if (endDate && tDate > endDate) return false;
        return true;
      });
    }

    const sourceArray = (startDate || endDate) ? filteredTransactions : transactions;

    const tableRows = sourceArray.map((t, i) => {
      const originalIndex = transactions.indexOf(t);
      const tr = document.createElement('tr');
      
      const iconReopen = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z"/></svg>`;
      const iconDownload = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L6.354 8.146a.5.5 0 1 0-.708.708l2 2z"/></svg>`;
      const iconDelete = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#dc3545" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>`;
      const syncStatus = t.synced ? '' : ' <span style="font-size:0.8em; color:orange;" title="Pending Sync">⏳</span>';

      tr.innerHTML = `
        <td onclick="previewOrder(transactions[${originalIndex}])" class="u-cursor-pointer u-fs-08 u-nowrap">${new Date(t.date).toLocaleString()}${syncStatus}</td>
        <td onclick="previewOrder(transactions[${originalIndex}])" class="u-cursor-pointer u-text-right u-fs-08 u-nowrap"><span class="currency-symbol">${settings.currency || '$'}</span>${formatCurrency(t.total)}</td>
        <td class="u-text-right">
          <button class="icon-btn" title="Re-Open Bill" onclick="reopenTransaction(${originalIndex})">${iconReopen}</button>
          <button class="icon-btn" title="Download PDF" onclick="downloadBillAsPDF(${originalIndex})">${iconDownload}</button>
          <button class="icon-btn" title="Delete Bill" onclick="deleteTransaction(${originalIndex})">${iconDelete}</button>
        </td>
      `;
      return tr;
    });

    const tbody = document.getElementById('transactionHistoryBody');
    tbody.innerHTML = ''; // Clear existing rows
    tableRows.forEach(row => tbody.appendChild(row));
  }
  
  /**
   * Triggers a cloud search for transactions within the specified date range
   */
  async function searchTransactionsByRange() {
    const start = document.getElementById('transactionStartDate')?.value;
    const end = document.getElementById('transactionEndDate')?.value;
    if (!start && !end) return alert("Please select a date range.");
    if (currentUser) await loadTransactionsFromCloud(currentUser.uid, start, end);
  }

  async function downloadBillAsPDF(transactionIndex) {
    const transaction = transactions[transactionIndex];
    const receiptModal = document.getElementById('receiptModal');
    const originalDisplayStyle = receiptModal.style.display;

    // Temporarily make the modal visible but position it off-screen
    // so html2canvas can render it.
    receiptModal.style.position = 'absolute';
    receiptModal.style.left = '-9999px';
    receiptModal.style.display = 'flex';

    // 1. Populate the hidden receipt content with the data from the selected transaction.
    populateReceiptContent(transaction);
    // 2. Call the existing function that handles saving the currently loaded receipt.
    // This reuses the code and ensures identical functionality.
    await downloadCurrentReceiptAsPDF();

    // 3. Restore the modal's original state.
    receiptModal.style.display = originalDisplayStyle;
    receiptModal.style.position = 'fixed';
    receiptModal.style.left = '0';
  }

  /**
   * Populates the content of the receipt modal without displaying it.
   * This is a helper for PDF generation.
   */
  function populateReceiptContent(transaction) {
      const { date, customerName, tableNo, items, total, subtotal, tax, discount } = transaction;
      const transactionId = new Date(date).getTime();
      const currencySymbol = settings.currency || '$';
      
      // Fallback for old transactions that might not have subtotal/tax saved
      const displaySubtotal = subtotal !== undefined ? subtotal : total; // If no tax info, assume total is subtotal
      const displayTax = tax !== undefined ? tax : 0;

      const itemsHtml = items.map(o => {
        const notesHtml = o.notes ? `<br><small style="font-style: italic;">- ${o.notes}</small>` : '';
        return `
          <div class="item-row">
            <div class="col-name">${o.name} ${notesHtml}</div>
            <div class="col-qty">${o.qty}x</div>
            <div class="col-price"><span class="currency-symbol">$</span>${formatCurrency(o.price)}</div>
            <div class="col-total"><span class="currency-symbol">$</span>${formatCurrency(o.qty * o.price)}</div>
          </div>`;
      }).join('');

      let discountHtml = '';
      if (discount && discount.amount > 0) {
          const label = 'Discount';
          discountHtml = `<div class="summary-line"><span>${label}</span> <span>-<span class="currency-symbol">${currencySymbol}</span>${formatCurrency(discount.amount)}</span></div>`;
      }
      
      const taxHtml = (displayTax > 0) 
        ? `<div class="summary-line"><span>Tax (${settings.taxRate}%)</span> <span><span class="currency-symbol">${currencySymbol}</span>${formatCurrency(displayTax)}</span></div>` 
        : '';
      
      const logoUrl = sanitizeLogoUrl(settings.logo);
      const logoHtml = logoUrl ? `<img src="${logoUrl}" onerror="this.src='assets/icons/icon-192x192.png';" style="width:50px; height:50px; object-fit:contain;">` : '🧾';

      const receiptHtml = `
        <div class="receipt-header">
          <div class="logo">${logoHtml}</div>
          <h3>${settings.name || 'My Business'}</h3>
          <p>${settings.address || '123 Business Avenue, Suite 100'}</p>
        </div>
        <div class="receipt-details">
          <div><span>Transaction ID:</span> <span>${transactionId}</span></div>
          <div><span>Date:</span> <span>${new Date(date).toLocaleDateString()}</span></div>
          <div><span>Time:</span> <span>${new Date(date).toLocaleTimeString()}</span></div>
        </div>
        <div class="receipt-items">
          <div class="table-header"><div class="col-name">Item</div><div class="col-qty">Qty</div><div class="col-price">Price</div><div class="col-total">Total</div></div>
          ${itemsHtml}
        </div>
        <div class="receipt-summary">
          <div class="summary-line"><span>Subtotal</span> <span><span class="currency-symbol">${currencySymbol}</span>${formatCurrency(displaySubtotal)}</span></div>
          ${taxHtml}
          ${discountHtml}
          <div class="summary-line total"><span>TOTAL</span> <span><span class="currency-symbol">${currencySymbol}</span>${formatCurrency(total)}</span></div>
        </div>
        <div class="receipt-footer"><p>Thank you for your visit!</p><p class="promo">Get 10% off on your next visit!</p></div>`;
      document.getElementById('receiptContent').innerHTML = receiptHtml;
  }

  function deleteTransaction(index) {
    const pin = prompt("Enter Manager PIN to delete transaction:");
    if (pin !== (settings.managerPIN || "1234")) {
      return alert("Incorrect PIN. Access denied.");
    }

    if (confirm(`Are you sure you want to permanently delete this transaction? This action cannot be undone.`)) {
      const txToDelete = transactions[index];
      transactions.splice(index, 1);

      // Delete from Cloud Sub-collection
      if (currentUser && dbFirestore) {
        const txRef = collection(dbFirestore, "users", currentUser.uid, "transactions");
        const q = query(txRef, where("date", "==", txToDelete.date), where("total", "==", txToDelete.total));
        getDocs(q).then(snap => {
          snap.forEach(async (doc) => {
            await deleteDoc(doc.ref);
          });
        }).catch(e => console.error("Cloud delete failed:", e));
      }

      saveData();
      renderTransactions();
      updateDashboard();
      alert('Transaction deleted.');
    }
  }

  function reopenTransaction(index) {
    const transactionToEdit = transactions[index];

    if (activeOrders[CART_ID] && activeOrders[CART_ID].items.length > 0) {
      return alert(`Cannot re-open this bill because the cart is currently occupied. Please clear the cart first.`);
    }

    if (confirm(`This will move the transaction back to the active cart and delete the original bill record. Do you want to continue?`)) {
      // Restore the order
      activeOrders[CART_ID] = { 
        items: transactionToEdit.items, 
        server: transactionToEdit.customerName 
      };

      // Delete the old transaction
      transactions.splice(index, 1);
      saveData();
      updateDashboard();
      alert(`Sale has been re-opened for editing.`);
      // Navigate user to the restored order
      showTab('menuTab', document.querySelector('nav button[onclick*="menuTab"]'));
    }
  }

  // ===== Reports =====
  function populateReportFilters() {
    const staffSelect = document.getElementById('reportStaffFilter');
    staffSelect.innerHTML = '<option value="">All Staff</option>';
    staff.forEach(member => {
      staffSelect.innerHTML += `<option value="${member.name}">${member.name}</option>`;
    });
  }

  function renderReport() {
    const reportType = document.getElementById('reportType').value;
    const outputContainer = document.getElementById('reportOutput');
    outputContainer.innerHTML = ''; // Clear previous report

    const reportDate = document.getElementById('reportDate').value;
    const staffFilter = document.getElementById('reportStaffFilter').value;

    let filteredTransactions = transactions.filter(t => {
      if (reportDate) {
        const transactionDateStr = new Date(t.date).toISOString().split('T')[0];
        if (transactionDateStr !== reportDate) return false;
      }
      if (staffFilter && t.customerName !== staffFilter) return false;

      return true;
    });

    if (filteredTransactions.length === 0) {
      outputContainer.innerHTML = '<p style="text-align: center;">No data available for the selected filters.</p>';
      return;
    }

    let reportHtml = '';

    if (reportType === 'salesSummary') {
      const totalRevenue = filteredTransactions.reduce((sum, t) => sum + t.total, 0);
      const totalBills = filteredTransactions.length;
      const paymentMethods = filteredTransactions.reduce((acc, t) => {
        acc[t.paymentMethod] = (acc[t.paymentMethod] || 0) + t.total;
        return acc;
      }, {});

      reportHtml = `<h4>Summary Report</h4>
        <p><strong>Total Revenue:</strong> <span class="currency-symbol">$</span>${formatCurrency(totalRevenue)}</p>
        <p><strong>Total Bills:</strong> ${totalBills}</p>
        <h5>Revenue by Payment Method:</h5>
        <ul>
          ${Object.entries(paymentMethods).map(([method, total]) => `<li>${method}: <span class="currency-symbol">$</span>${formatCurrency(total)}</li>`).join('')}
        </ul>`;

    } else if (reportType === 'itemSales') {
      const itemSales = filteredTransactions.flatMap(t => t.items).reduce((acc, item) => {
        if (!acc[item.name]) acc[item.name] = { qty: 0, total: 0 };
        acc[item.name].qty += item.qty;
        acc[item.name].total += item.qty * item.price;
        return acc;
      }, {});

      const sortedItems = Object.entries(itemSales).sort(([,a],[,b]) => b.qty - a.qty);

      const tableBody = sortedItems.map(([name, data]) => `<tr><td>${name}</td><td style="text-align: right;">${data.qty}</td><td style="text-align: right;"><span class="currency-symbol">$</span>${formatCurrency(data.total)}</td></tr>`).join('');
      reportHtml = `<h4>Item Report</h4><table><thead><tr><th>Item</th><th style="text-align: right;">Quantity Sold</th><th style="text-align: right;">Total Revenue</th></tr></thead><tbody>${tableBody}</tbody></table>`;

    } else if (reportType === 'categorySales') {
      const categorySales = filteredTransactions.flatMap(t => t.items).reduce((acc, item) => {
        const dish = menu.find(d => d.name === item.name);
        const category = dish ? dish.category : 'Uncategorized';
        if (!acc[category]) acc[category] = { qty: 0, total: 0 };
        acc[category].qty += item.qty;
        acc[category].total += item.qty * item.price;
        return acc;
      }, {});

      const sortedCategories = Object.entries(categorySales).sort(([,a],[,b]) => b.total - a.total);
      
      const tableBody = sortedCategories.map(([name, data]) => `<tr><td>${name}</td><td style="text-align: right;">${data.qty}</td><td style="text-align: right;"><span class="currency-symbol">$</span>${formatCurrency(data.total)}</td></tr>`).join('');
      reportHtml = `<h4>Category Report</h4><table><thead><tr><th>Category</th><th style="text-align: right;">Quantity Sold</th><th style="text-align: right;">Total Revenue</th></tr></thead><tbody>${tableBody}</tbody></table>`;
    }

    outputContainer.innerHTML = reportHtml;
    updateCurrencyDisplay();
  }

  function downloadReportPDF() {
    if (typeof window.jspdf === 'undefined') {
        alert("PDF generation libraries are not loaded. Please check your internet connection.");
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const reportOutput = document.getElementById('reportOutput');
    const reportTitle = reportOutput.querySelector('h4');
    const reportTable = reportOutput.querySelector('table');

    if (!reportTitle) {
      return alert("Please generate a report first before downloading.");
    }

    const titleText = reportTitle.innerText;
    const reportDate = document.getElementById('reportDate').value || new Date().toISOString().split('T')[0];
    const filename = `${titleText.replace(/ /g, '_')}_${reportDate}.pdf`;

    doc.text(titleText, 14, 15);

    if (reportTable) {
      doc.autoTable({ html: reportTable, startY: 25 });
    } else {
      // For summary report which has no table
      const summaryText = reportOutput.innerText;
      doc.text(summaryText, 14, 25);
    }

    doc.save(filename);
  }

  // ===== Dashboard =====
  let categoryChartInstance;
  let bestSellingItemsChartInstance;
  let dailySalesChartInstance;

  function updateDashboard() {
    // Initialize with defaults even if data is not yet loaded
    // This ensures the dashboard always shows cards with 0 values
    if (!menu) menu = [];
    if (!transactions) transactions = [];

    // Filter for sellable dishes (items with a recipe) to ensure dashboard reflects the menu, not raw inventory.
    const sellableDishes = menu.filter(item => item.recipe && item.recipe.length > 0);
    document.getElementById('menuCount').textContent = sellableDishes.length;
    document.getElementById('uniqueCategoriesCount').textContent = new Set(sellableDishes.map(d => d.category).filter(Boolean)).size;
    
    // Calculate total stock value (cost of all raw ingredients)
    const totalStockValue = menu
      .filter(item => item.stock !== undefined) // Filter for items with a stock property (raw ingredients)
      .reduce((sum, item) => sum + (item.stock * (item.costPrice || 0)), 0);

    // Calculate total revenue and total cost of goods sold (COGS) from all transactions
    const totalRevenue = transactions.reduce((sum, t) => sum + (t.total || 0), 0);
    const totalCost = transactions.reduce((sum, t) => {
        const transactionCost = (t.items || []).reduce((itemSum, item) => {
            const dish = menu.find(d => d.name === item.name);
            // Use the costPrice stored on the dish, which is calculated from its recipe
            return itemSum + ((dish ? dish.costPrice : 0) * (item.qty || 0));
        }, 0);
        return sum + transactionCost;
    }, 0);

    const profitMargin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;
    const totalBills = transactions.length;

    // Always update dashboard cards (even with 0 values)
    document.getElementById('stockValue').textContent = formatCurrency(totalStockValue);
    document.getElementById('profitPercentage').textContent = profitMargin.toFixed(2);
    document.getElementById('totalRevenue').textContent = formatCurrency(totalRevenue);
    document.getElementById('totalBills').textContent = totalBills;
    
    updateCurrencyDisplay();
    
    // Render charts - they will show empty/zero state if no data
    try {
      renderDashboardChart();
      renderBestSellingItemsChart();
      renderDailySalesChart();
    } catch (error) {
      console.error('Error rendering dashboard charts:', error);
    }
  }

  function renderBestSellingItemsChart() {
    if (typeof Chart === 'undefined') return;
    const ctx = document.getElementById('bestSellingItemsChart').getContext('2d');
    
    // Safely handle empty transactions
    const itemSales = (transactions && transactions.length > 0) 
      ? transactions.flatMap(t => t.items || []).reduce((acc, item) => {
          acc[item.name] = (acc[item.name] || 0) + (item.qty || 0);
          return acc;
        }, {})
      : {};

    const sortedItems = Object.entries(itemSales).sort(([, a], [, b]) => b - a).slice(0, 5);
    const labels = sortedItems.map(([name]) => name);
    const data = sortedItems.map(([, qty]) => qty);

    if (bestSellingItemsChartInstance) {
      bestSellingItemsChartInstance.destroy();
    }

    // Always render chart, even with empty data (shows zero state)
    bestSellingItemsChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['No data yet'],
        datasets: [{
          label: 'Top 5 Best-Selling Items',
          data: data.length > 0 ? data : [0],
          backgroundColor: '#3d5a80',
        }]
      },
      options: {
        indexAxis: 'y',
        scales: { x: { beginAtZero: true } },
        plugins: { 
          legend: { display: false },
          title: {
            display: true,
            text: 'Top 5 Best-Selling Items'
          },
          tooltip: {
            enabled: data.length > 0
          }
        }
      }
    });
  }

  function renderDailySalesChart() {
    if (typeof Chart === 'undefined') return;
    const ctx = document.getElementById('dailySalesChart').getContext('2d');
    
    // Safely handle empty transactions
    const salesByDay = (transactions && transactions.length > 0)
      ? transactions.reduce((acc, t) => {
          const date = new Date(t.date).toLocaleDateString();
          acc[date] = (acc[date] || 0) + (t.total || 0);
          return acc;
        }, {})
      : {};

    const labels = Object.keys(salesByDay).reverse();
    const data = Object.values(salesByDay).reverse();

    if (dailySalesChartInstance) {
      dailySalesChartInstance.destroy();
    }

    // Always render chart, even with empty data (shows zero state)
    dailySalesChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['No data yet'],
        datasets: [{ label: 'Daily Sales', data: data.length > 0 ? data : [0], backgroundColor: '#ff6b35' }]
      },
      options: {
        scales: { y: { beginAtZero: true } },
        plugins: { 
          legend: { display: false },
          title: {
            display: true,
            text: 'Daily Sales'
          },
          tooltip: {
            enabled: data.length > 0
          }
        }
      }
    });
  }
  function renderDashboardChart() {
    if (typeof Chart === 'undefined') return;
    const ctx = document.getElementById('categoryChart').getContext('2d');

    // Only count items that have a category assigned.
    // Safely handle when menu is empty or not initialized
    const categoryCounts = (menu && menu.length > 0)
      ? menu.filter(dish => dish.category).reduce((acc, dish) => {
          if (dish.category) {
            acc[dish.category] = (acc[dish.category] || 0) + 1;
          }
          return acc;
        }, {})
      : {};

    const labels = Object.keys(categoryCounts);
    const data = Object.values(categoryCounts);

    if (categoryChartInstance) {
      categoryChartInstance.destroy();
    }

    // Always render chart, even with empty data (shows zero state)
    categoryChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length > 0 ? labels : ['No data yet'],
        datasets: [{
          label: 'Products by Category',
          data: data.length > 0 ? data : [0],
          backgroundColor: ['#ff6b35', '#f7c59f', '#7dcdb8', '#3d5a80', '#98c1d9'],
        }]
      },
      options: {
        scales: {
          y: {
            beginAtZero: true
          }
        },
        plugins: {
          legend: {
            display: false
          },
          title: {
            display: true,
            text: 'Products by Category'
          },
          tooltip: {
            enabled: data.length > 0
          }
        }
      }
    });
  }

  // ===== Settings =====
  async function saveSettings() {
    const pin = document.getElementById('managerPIN').value;
    const confirmPin = document.getElementById('confirmManagerPIN').value;

    // Enforce exactly 4 numeric digits
    if (pin.length !== 4 || !/^\d+$/.test(pin)) {
      return alert("Manager PIN must be exactly 4 numeric digits.");
    }

    // Match confirmation field
    if (pin !== confirmPin) {
      return alert("Manager PINs do not match. Please verify and try again.");
    }

    settings.name = document.getElementById('companyName').value;
    settings.address = document.getElementById('companyAddress').value;
    settings.contact = document.getElementById('companyContact').value;
    settings.currency = document.getElementById('currency').value;
    settings.lowStockThreshold = parseInt(document.getElementById('lowStockThreshold').value, 10) || 10;
    settings.defaultMarkup = parseFloat(document.getElementById('defaultMarkup').value) || 200;
    settings.taxRate = parseFloat(document.getElementById('taxRate').value) || 0;
    settings.managerPIN = pin;

    const logoFile = document.getElementById('companyLogo').files[0];
    if (logoFile) {
      const base64Logo = await toBase64(logoFile);
      settings.logo = await uploadImage(base64Logo, 'branding/logo.jpg');
    }

    saveData();
    alert('Settings saved!');
    loadSettings(); // Reload to show preview

    // --- Re-render all relevant sections to reflect currency change ---
    updateDashboard();
    renderMenu();
    renderDishesTable();
    renderInventoryReport();
    renderStockListTable();
    renderTransactions();
    renderReport();
    updateCurrencyDisplay(); // Call this AFTER all sections are re-rendered
  }

  function loadSettings() {
    if (currentUser) {
      const emailEl = document.getElementById('display-user-email');
      if (emailEl) emailEl.textContent = currentUser.email;
      
      const providers = currentUser.providerData.map(p => p.providerId);
      const isEmailUser = providers.includes('password');
      const isGoogleUser = providers.includes('google.com');
      
      const badgeContainer = document.getElementById('auth-provider-badges');
      if (badgeContainer) {
        badgeContainer.innerHTML = `
          ${isGoogleUser ? '<span style="background: #4285F4; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.7em;">Google</span>' : ''}
          ${isEmailUser ? '<span style="background: #28a745; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.7em;">Password</span>' : ''}
        `;
      }

      const changeBtn = document.getElementById('change-password-btn');
      const linkBtn = document.getElementById('link-password-btn');
      if (changeBtn) changeBtn.style.display = isEmailUser ? 'block' : 'none';
      if (linkBtn) linkBtn.style.display = (isGoogleUser && !isEmailUser) ? 'block' : 'none';
    }

    // Safe loading helper
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };

    setVal('companyName', settings.name || '');
    setVal('companyAddress', settings.address || '');
    setVal('companyContact', settings.contact || '');
    setVal('currency', settings.currency || '$');
    setVal('lowStockThreshold', settings.lowStockThreshold || 10);
    setVal('taxRate', settings.taxRate || 0);
    setVal('managerPIN', settings.managerPIN || "1234");
    setVal('confirmManagerPIN', settings.managerPIN || "1234");

    const logoPreview = document.getElementById('logoPreview');
    const logoUrl = sanitizeLogoUrl(settings.logo);
    if (logoUrl) {
      logoPreview.src = logoUrl;
      logoPreview.style.display = 'inline-block';
    } else {
      logoPreview.src = '';
      logoPreview.style.display = 'none';
    }
    checkNotificationStatus();
  }

  function togglePINVisibility() {
    const pin = document.getElementById('managerPIN');
    const confirm = document.getElementById('confirmManagerPIN');
    const type = pin.type === 'password' ? 'text' : 'password';
    pin.type = type;
    if (confirm) confirm.type = type;
  }

  function previewLogo(input) {
    if (input.files && input.files[0]) {
      const reader = new FileReader();
      reader.onload = e => {
        const logoPreview = document.getElementById('logoPreview');
        logoPreview.src = e.target.result;
        logoPreview.style.display = 'inline-block';
      };
      reader.readAsDataURL(input.files[0]);
    }
  }

  // ===== Staff Management =====
  function renderStaffList() {
    const tbody = document.getElementById('staffListBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    staff.forEach((member, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${member.name}</td>` +
        `<td>${member.role}</td>` +
        `<td>****</td>` +
        `<td><button class="btn u-fs-08" style="padding: 4px 8px; margin: 0;" onclick="openStaffPermissionsModal(${i})">Manage</button></td>` +
        `<td style="text-align: right;"><button class="icon-btn" title="Delete Staff" onclick="deleteStaff(${i})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#dc3545" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button></td>`;
      tbody.appendChild(tr);
    });
  }

  function addStaff() {
    const nameInput = document.getElementById('staffNameInput');
    const roleInput = document.getElementById('staffRoleInput');
    const pinInput = document.getElementById('staffPinInput');
    const name = nameInput.value.trim(); 
    const role = roleInput.value;
    const pin = pinInput.value.trim();

    const checkboxes = document.querySelectorAll('#staffPermissionsContainer input[type="checkbox"]');
    const permissions = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

    if (!name || pin.length !== 4) {
      alert("Please enter a staff name and a 4-digit PIN.");
      return;
    }

    staff.push({ name, role, pin, permissions });
    nameInput.value = ''; // Clear input
    roleInput.value = ''; // Clear role input
    pinInput.value = '';
    checkboxes.forEach(cb => cb.checked = (cb.value === 'menuTab')); // Reset to default
    saveData();
    renderStaffList();
  }

  function openStaffPermissionsModal(index) {
    const member = staff[index];
    const container = document.getElementById('editPermissionsGrid');
    document.getElementById('permStaffName').textContent = member.name;
    document.getElementById('permStaffIndex').value = index;

    const tabs = [
      { id: 'dashboardTab', label: 'Dashboard' },
      { id: 'menuTab', label: 'Shop' },
      { id: 'addDishTab', label: 'Products' },
      { id: 'categoryTab', label: 'Categories' },
      { id: 'unitTab', label: 'Units' },
      { id: 'staffTab', label: 'Staff' },
      { id: 'customerTab', label: 'Customers' },
      { id: 'stockTab', label: 'Stock' },
      { id: 'transactionsTab', label: 'Sales' },
      { id: 'reportsTab', label: 'Reports' },
      { id: 'settingsTab', label: 'Settings' }
    ];

    container.innerHTML = tabs.map(tab => `
      <label style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
        <input type="checkbox" value="${tab.id}" ${member.permissions?.includes(tab.id) ? 'checked' : ''}>
        ${tab.label}
      </label>
    `).join('');

    document.getElementById('staffPermissionsModal').style.display = 'flex';
  }

  function saveStaffPermissions() {
    const index = parseInt(document.getElementById('permStaffIndex').value, 10);
    const checkboxes = document.querySelectorAll('#editPermissionsGrid input[type="checkbox"]');
    const permissions = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

    staff[index].permissions = permissions;
    saveData();
    document.getElementById('staffPermissionsModal').style.display = 'none';
    alert("Permissions updated successfully.");
  }

  function deleteStaff(index) {
    if (confirm(`Are you sure you want to remove ${staff[index].name}?`)) {
      staff.splice(index, 1);
      saveData();
      renderStaffList();
    }
  }

  async function resetApp() {
    if (confirm("WARNING: This will permanently delete ALL application data, including your menu, transactions, and settings. This action cannot be undone. Are you sure?")) {
      try {
        // If the database connection is open, we must close it before deleting.
        if (db) {
          db.close();
        }
        const deleteRequest = indexedDB.deleteDatabase(DB_NAME);

        deleteRequest.onsuccess = () => {
          alert("Application data has been reset. The application will now reload.");
          location.reload();
        };
        deleteRequest.onerror = (e) => {
          console.error("Error deleting database:", e);
          alert("Could not reset application data. Please try clearing your browser's site data manually for this website.");
        };
        deleteRequest.onblocked = () => {
          alert("Could not reset application data because the database is in use. Please close all other tabs of this app and try again.");
        };
      } catch (error) {
        console.error("Error during app reset:", error);
      }
    }
  }

  function populateCurrencies() {
    const currencies = {
        // Common World Currencies
        "$": "USD (US Dollar)",
        "€": "EUR (Euro)",
        "¥": "JPY (Japanese Yen)",
        "£": "GBP (British Pound)",
        "A$": "AUD (Australian Dollar)",
        "C$": "CAD (Canadian Dollar)",
        "Fr": "CHF (Swiss Franc)",
        "元": "CNY (Chinese Yuan)",
        "₹": "INR (Indian Rupee)",
        "₽": "RUB (Russian Ruble)",
        "R$": "BRL (Brazilian Real)",
        "₩": "KRW (South Korean Won)",
        "₺": "TRY (Turkish Lira)",
        "Mex$": "MXN (Mexican Peso)",
        "S$": "SGD (Singapore Dollar)",
        "NZ$": "NZD (New Zealand Dollar)",
        "AED": "AED (United Arab Emirates Dirham)",
        // African Currencies
        "DZD": "DZD (Algerian Dinar)",
        "AOA": "AOA (Angolan Kwanza)",
        "BWP": "BWP (Botswana Pula)",
        "BIF": "BIF (Burundian Franc)",
        "CVE": "CVE (Cape Verdean Escudo)",
        "XAF": "XAF (Central African CFA Franc)",
        "XOF": "XOF (West African CFA Franc)",
        "KMF": "KMF (Comorian Franc)",
        "CDF": "CDF (Congolese Franc)",
        "DJF": "DJF (Djiboutian Franc)",
        "EGP": "EGP (Egyptian Pound)",
        "ERN": "ERN (Eritrean Nakfa)",
        "SZL": "SZL (Eswatini Lilangeni)",
        "ETB": "ETB (Ethiopian Birr)",
        "GMD": "GMD (Gambian Dalasi)",
        "GHS": "GHS (Ghanaian Cedi)",
        "GNF": "GNF (Guinean Franc)",
        "KES": "KES (Kenyan Shilling)",
        "LSL": "LSL (Lesotho Loti)",
        "LRD": "LRD (Liberian Dollar)",
        "LYD": "LYD (Libyan Dinar)",
        "MGA": "MGA (Malagasy Ariary)",
        "MWK": "MWK (Malawian Kwacha)",
        "MRU": "MRU (Mauritanian Ouguiya)",
        "MUR": "MUR (Mauritian Rupee)",
        "MAD": "MAD (Moroccan Dirham)",
        "MZN": "MZN (Mozambican Metical)",
        "NAD": "NAD (Namibian Dollar)",
        "NGN": "NGN (Nigerian Naira)",
        "RWF": "RWF (Rwandan Franc)",
        "STN": "STN (São Tomé & Príncipe Dobra)",
        "SLL": "SLL (Sierra Leonean Leone)",
        "SOS": "SOS (Somali Shilling)",
        "ZAR": "ZAR (South African Rand)",
        "SSP": "SSP (South Sudanese Pound)",
        "SDG": "SDG (Sudanese Pound)",
        "TZS": "TZS (Tanzanian Shilling)",
        "TND": "TND (Tunisian Dinar)",
        "UGX": "UGX (Ugandan Shilling)",
        "ZMW": "ZMW (Zambian Kwacha)",
        "ZWL": "ZWL (Zimbabwean Dollar)"
    };
    const select = document.getElementById('currency');
    select.innerHTML = ''; // Clear existing options
    for (const symbol in currencies) {
      const option = document.createElement('option');
      option.value = symbol;
      option.textContent = `${symbol} - ${currencies[symbol]}`;
      select.appendChild(option);
    }
  }

  // ===== Category Management =====
  function renderCategoryList() {
    const tbody = document.getElementById('categoryListBody');
    tbody.innerHTML = '';
    dishCategories.forEach(cat => {
      const index = dishCategories.indexOf(cat); // Get index for functions
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${cat}</td>
                      <td style="text-align: right; white-space: nowrap;">
                        <button class="icon-btn" title="Edit Category" onclick="editCategory(${index})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V12h2.293l6.5-6.5-.207-.207z"/></svg></button>
                        <button class="icon-btn" title="Delete Category" onclick="deleteCategory(${index})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#dc3545" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button>
                      </td>`;
      tbody.appendChild(tr);
    });
  }

  function populateCategoryFilter() {
    const select = document.getElementById('categoryFilter');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">All Categories</option>';
    dishCategories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat;
      option.textContent = cat;
      select.appendChild(option);
    });
    if (dishCategories.includes(currentVal)) select.value = currentVal;
  }

  function addCategory() {
    const nameInput = document.getElementById('categoryNameInput');
    const name = nameInput.value.trim();
    if (!name) return alert("Category name cannot be empty.");
    if (dishCategories.includes(name)) return alert("Category already exists.");

    dishCategories.push(name);
    dishCategories.sort();
    nameInput.value = '';
    saveData();
    renderCategoryList();
    populateCategoryDropdown();
    populateCategoryFilter();
    updateDashboard();
  }

  function editCategory(index) {
    const oldCategoryName = dishCategories[index];
    const newCategoryName = prompt(`Enter new name for category "${oldCategoryName}":`, oldCategoryName);

    if (!newCategoryName || newCategoryName.trim() === '') {
      return; // User cancelled or entered empty string
    }

    const trimmedNewName = newCategoryName.trim();
    if (trimmedNewName === oldCategoryName) {
      return; // No change
    }

    if (dishCategories.includes(trimmedNewName)) {
      return alert(`Category "${trimmedNewName}" already exists.`);
    }

    // Update category in the list
    dishCategories[index] = trimmedNewName;
    dishCategories.sort();

    // Update all menu items with the old category
    menu.forEach(dish => {
      if (dish.category === oldCategoryName) {
        dish.category = trimmedNewName;
      }
    });

    saveData();
    renderCategoryList();
    renderDishesTable(); // To reflect changes in the dishes list
    populateCategoryDropdown();
    populateCategoryFilter();
    updateDashboard();
    alert(`Category "${oldCategoryName}" was updated to "${trimmedNewName}".`);
  }

  function deleteCategory(index) {
    const categoryName = dishCategories[index];
    const itemsUsingCategory = menu.filter(item => item.category === categoryName);
    
    let message = `Are you sure you want to delete the category "${categoryName}"?`;
    if (itemsUsingCategory.length > 0) {
      message += `\n\nWarning: This category contains ${itemsUsingCategory.length} items. They will be moved to "Uncategorized".`;
    }

    if (confirm(message)) {
      // Update items to remove the category reference
      itemsUsingCategory.forEach(item => item.category = '');

      dishCategories.splice(index, 1);
      saveData();
      populateCategoryDropdown();
      renderCategoryList();
      populateCategoryFilter();
      updateDashboard();
      
      // Refresh menu if visible to show items in Uncategorized
      if (document.getElementById('menuTab').classList.contains('active')) {
        renderMenu(document.getElementById('menuTab').dataset.tableId);
      }
    }
  }

  function populateCategoryDropdown() {
    const select = document.getElementById('dishCategory'); // This now targets the select in the add dish form
    select.innerHTML = '<option value="" disabled selected>Select Category</option>';
    dishCategories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat;
      option.textContent = cat;
      select.appendChild(option);
    });
  }
  // ===== Customer Management =====
  // ===== Unit Management =====
  function renderUnitList() {
    const tbody = document.getElementById('unitListBody');
    if (!tbody) return;

    // Guard against units being undefined or not an array
    if (!units || !Array.isArray(units)) return;

    tbody.innerHTML = '';

    units.forEach((unit, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${unit.full}</td>
                      <td>${unit.short}</td>
                      <td style="text-align: right;">
                        <button class="icon-btn" title="Delete Unit" onclick="deleteUnit(${i})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#dc3545" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button>
                      </td>`;
      tbody.appendChild(tr);
    });
  }

  function addUnit() {
    const nameInput = document.getElementById('unitNameInput');
    const fullNameInput = document.getElementById('unitFullNameInput');
    const shortName = nameInput.value.trim();
    const fullName = fullNameInput.value.trim();
    if (!shortName || !fullName) return alert("Both short name and full name are required.");
    if (units.some(u => u.short.toLowerCase() === shortName.toLowerCase())) return alert("Unit short name already exists.");
    if (units.some(u => u.full.toLowerCase() === fullName.toLowerCase())) return alert("Unit full name already exists.");
    units.push({ short: shortName, full: fullName });
    units.sort((a, b) => a.short.localeCompare(b.short));
    nameInput.value = '';
    fullNameInput.value = '';
    saveData();
    renderUnitList();
    populateUnitDropdown();
  }

  function deleteUnit(index) {
    const unit = units[index];
    if (confirm(`Are you sure you want to delete the unit "${unit.short} (${unit.full})"?`)) {
      units.splice(index, 1);
      saveData();
      renderUnitList();
      populateUnitDropdown();
    }
  }

  function toggleAddCustomerForm(show) {
    const formContainer = document.getElementById('addCustomerFormContainer');
    const toggleButton = document.getElementById('addCustomerBtn');
    if (show) {
      formContainer.style.display = 'block';
      if (toggleButton) toggleButton.style.display = 'none'; // Hide the 'Add New' button
      document.getElementById('customerNameInput').value = '';
      document.getElementById('customerContactInput').value = '';
      document.getElementById('customerAddressInput').value = '';
      document.getElementById('customerAddressInput').value = '';
    } else {
      formContainer.style.display = 'none';
      if (toggleButton) toggleButton.style.display = 'inline-block'; // Show the 'Add New' button
    }
  }

  function renderCustomerList() {
    const tbody = document.getElementById('customerListBody');
    tbody.innerHTML = '';
    customers.forEach((customer, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${customer.name}</td>
                        <td>${customer.contact}</td>
                        <td>${customer.address || ''}</td>
                        <td style="text-align: right; white-space: nowrap;">
                            <button class="icon-btn" title="Edit Customer" onclick="editCustomer(${i})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V12h2.293l6.5-6.5-.207-.207z"/></svg></button>
                            <button class="icon-btn" title="Delete Customer" onclick="deleteCustomer(${i})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#dc3545" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button>
                        </td>`;
        tbody.appendChild(tr);
    });
  }

  function addCustomer() {
    const nameInput = document.getElementById('customerNameInput');
    const contactInput = document.getElementById('customerContactInput');
    const addressInput = document.getElementById('customerAddressInput');
    const index = document.getElementById('customerIndex').value;

    if (!nameInput.value.trim()) return alert("Customer name is required.");

    const customerData = { 
        name: nameInput.value.trim(), 
        contact: contactInput.value.trim(), 
        address: addressInput.value.trim() 
    };

    if (index !== '') {
        customers[parseInt(index, 10)] = customerData;
    } else {
        customers.push(customerData);
    }

    saveData();
    renderCustomerList();
    toggleAddCustomerForm(false);
  }

  function editCustomer(index) {
    const customer = customers[index];
    toggleAddCustomerForm(true);
    document.getElementById('customerNameInput').value = customer.name;
    document.getElementById('customerContactInput').value = customer.contact;
    document.getElementById('customerAddressInput').value = customer.address;
    document.getElementById('customerIndex').value = index;
    document.getElementById('saveCustomerBtn').textContent = 'Update Customer';
  }

  function deleteCustomer(index) {
    if (confirm(`Are you sure you want to delete customer "${customers[index].name}"?`)) {
        customers.splice(index, 1);
        saveData();
        renderCustomerList();
    }
  }

  // ===== Theme Toggle =====
  function toggleTheme() {
    // Toggle based on the class on the body
    if (document.body.classList.contains('dark-mode')) {
      document.body.classList.remove('dark-mode');
      settings.theme = 'light';
    } else {
      document.body.classList.add('dark-mode');
      settings.theme = 'dark';
    }
    applyTheme(); // Update icon
    saveData();
    // Re-render charts to adapt to new theme
    updateDashboard();
  }

  function applyTheme() {
    const themeIcon = document.getElementById('theme-icon');
    if (settings.theme === 'dark') {
      document.body.classList.add('dark-mode');
      if (themeIcon) themeIcon.textContent = '🌙'; // Moon icon
    } else {
      if (themeIcon) themeIcon.textContent = '☀️'; // Sun icon
    }
  }

  function handleSplashScreen() {
    setTimeout(() => {
      document.body.classList.remove('loading');
      const splash = document.getElementById('splash-screen');
      const header = document.querySelector('header');
      const appLayout = document.querySelector('.app-layout');
      
      if (splash) splash.style.opacity = '0';
      if (header) {
        header.style.visibility = 'visible';
        header.style.opacity = '1';
      }
      if (appLayout) {
        appLayout.style.visibility = 'visible';
        appLayout.style.opacity = '1';
      }
      setTimeout(() => { if (splash) splash.style.display = 'none'; }, 800);
    }, 500);
  }

  // ===== Settings Accordion =====
  function setupSettingsAccordion() {
    const headers = document.querySelectorAll('#settingsTab .settings-header');
    const settingsTab = document.getElementById('settingsTab');
    const allGroups = document.querySelectorAll('#settingsTab .settings-group');

    headers.forEach(header => {
      header.addEventListener('click', () => {
        const content = header.nextElementSibling;
        const parentGroup = header.closest('.settings-group');
        const wasActive = header.classList.contains('active');
        const contentClass = header.dataset.contentClass;

        if (wasActive) {
          // It was active, so close it and show all other groups
          header.classList.remove('active');
          content.style.maxHeight = null;
          content.style.padding = "0 20px";
          content.classList.remove('active');
          if (contentClass) {
            content.classList.remove(contentClass);
          }
          allGroups.forEach(group => group.style.display = 'block');
        } else {
          // It was not active, so open it and hide all other groups
          // First, close any other potentially open group
          headers.forEach(h => {
            h.classList.remove('active');

            const c = h.nextElementSibling;
            c.style.maxHeight = null;
            c.style.padding = "0 20px";
            c.classList.remove('active');
            const otherContentClass = h.dataset.contentClass;
            if (otherContentClass) {
              c.classList.remove(otherContentClass);
            }
          });
          allGroups.forEach(group => group.style.display = 'none');
          parentGroup.style.display = 'block';
          header.classList.add('active');
          content.classList.add('active');
          if (contentClass) {
            content.classList.add(contentClass);
          }
          
          // Calculate available height for scrolling
          // Special handling for management sections to take up full height
          content.style.maxHeight = content.scrollHeight + "px";
          content.style.padding = "20px";
        }
      });
    });
  }

  // ===== Inventory Management (Settings Tab) =====
  function renderInventoryReport() {
    const tbody = document.getElementById('lowStockReportBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const threshold = settings.lowStockThreshold || 10;
    
    // Only check primary ingredients (items with a stock property) for the low stock report.
    const lowStockItems = menu.filter(item => item.stock !== undefined && item.stock <= threshold);

    if (lowStockItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 15px;">No items are currently low on stock.</td></tr>`;
      return;
    }

    lowStockItems.forEach(item => {
      const stock = calculateDishStock(item, true);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.name}</td>
        <td>${item.category}</td>
        <td style="text-align: right; color: #dc3545; font-weight: bold;">${Number(stock).toFixed(1)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderStockListTable() {
    const searchTerm = document.getElementById('stockSearchInput')?.value.toLowerCase() || '';
    const tbody = document.getElementById('stockListBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Filter to show only raw ingredients (items with a 'stock' property)
    const stockItems = menu.filter(item => item.stock !== undefined && (!searchTerm || item.name.toLowerCase().includes(searchTerm)));

    stockItems.forEach((item) => {
      const index = menu.indexOf(item);
      const stock = calculateDishStock(item, true);
      const costPrice = item.costPrice || 0;
      const totalCost = stock * costPrice;
      const tr = document.createElement('tr');


      tr.innerHTML = `
        <td class="u-fs-08 u-text-break">${item.name}</td> 
        <td class="u-fs-08">${(item.recipe && item.recipe.length > 0) ? 'Recipe' : (item.unit || 'N/A')}</td>
        <td class="u-fs-08 u-text-right u-nowrap"><span class="currency-symbol">${settings.currency || '$'}</span>${formatCurrency(costPrice)}</td>
        <td class="u-fs-08 u-text-right">${Number(stock).toFixed(1)}</td>
        <td class="u-fs-08 u-text-right"><span class="currency-symbol">${settings.currency || '$'}</span>${formatCurrency(totalCost)}</td>
        <td class="u-text-right">
          <div class="u-flex-column-end">
            <button class="icon-btn" title="Adjust Stock" onclick="toggleStockAdjustmentForm(true, ${index})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311a1.464 1.464 0 0 1-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413-1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/></svg></button>
            <button class="icon-btn" title="Edit Item" onclick="editStockItem(${index})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V12h2.293l6.5-6.5-.207-.207z"/></svg></button>
            <button class="icon-btn" title="Delete Item" onclick="deleteItem(${index})"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#dc3545" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function editStockItem(index) {
    const item = menu[index];
    if (!item || item.stock === undefined) {
      return alert("This item cannot be edited here. Please edit it from the 'Products' section.");
    }

    // Show the form
    toggleNewStockItemForm(true);

    // Populate the form with the item's data
    document.getElementById('newStockItemName').value = item.name;
    document.getElementById('newStockItemUnit').value = item.unit || '';
    document.getElementById('newStockItemCost').value = item.costPrice || 0;
    document.getElementById('newStockItemPrice').value = item.price || 0;
    document.getElementById('newStockItemStock').value = item.stock || 0;

    // Store the index of the item being edited
    const formContainer = document.getElementById('newStockItemFormContainer');
    formContainer.dataset.editingIndex = index;
  }

  function toggleStockAdjustmentForm(show, index = null) {
    const formContainer = document.getElementById('stockAdjustmentFormContainer');
    if (show && index !== null) {
      const item = menu[index];
      if (item.stock === undefined) {
        return alert(`Cannot directly adjust stock for "${item.name}" because it is a composite dish made from a recipe. Adjust the stock of its individual ingredients instead.`);
      }
      document.getElementById('stockItemIndex').value = index;
      document.getElementById('stockAdjustItemName').textContent = `Adjust Stock for: ${item.name} (Current: ${item.stock})`;
      document.getElementById('newStockValue').value = '';
      formContainer.style.display = 'block';
      document.getElementById('newStockValue').focus();
    } else {
      formContainer.style.display = 'none';
      document.getElementById('stockItemIndex').value = '';
    }
  }

  function saveStockAdjustment() {
    const index = document.getElementById('stockItemIndex').value;
    const newStockInput = document.getElementById('newStockValue');
    const newStock = parseInt(newStockInput.value, 10);

    if (index === '' || isNaN(newStock) || newStock < 0) {
      return alert("Please enter a valid, non-negative number for the stock.");
    }

    const oldStock = menu[index].stock;
    menu[index].stock = newStock;

    restockHistory.unshift({
      date: new Date().toISOString(),
      itemName: menu[index].name,
      adjustment: newStock - oldStock,
      newTotal: newStock
    });
    if (restockHistory.length > 100) restockHistory.pop();

    saveData();

    // Re-render all relevant views
    toggleStockAdjustmentForm(false); // Hide form
    renderStockListTable();
    renderInventoryReport();
    renderDishesTable();
    renderMenu();
  }

  function toggleNewStockItemForm(show) {
    const formContainer = document.getElementById('newStockItemFormContainer');
    const toggleButton = document.querySelector('#settingsTab h5 button[onclick*="toggleNewStockItemForm"]');
    if (show) {
      formContainer.style.display = 'block';
      if (toggleButton) toggleButton.style.display = 'none';
      populateUnitDropdown();
      clearNewStockItemForm();
    } else {
      formContainer.style.display = 'none';
      if (toggleButton) toggleButton.style.display = 'inline-block';
    }
  }

  function populateUnitDropdown() {
    const unitSelect = document.getElementById('newStockItemUnit');
    if (!unitSelect) return;
    unitSelect.innerHTML = `<option value="" disabled selected>Select Unit</option>` + units.map(u => `<option value="${u.short}">${u.short}</option>`).join('');
  }

  function saveNewStockItem() {
    const name = document.getElementById('newStockItemName').value.trim();
    const unit = document.getElementById('newStockItemUnit').value;
    const costPrice = parseFloat(document.getElementById('newStockItemCost').value);
    const sellingPriceInput = document.getElementById('newStockItemPrice').value;
    const stock = parseInt(document.getElementById('newStockItemStock').value, 10);

    if (!name) {
      return alert("Please enter an item name.");
    }
    if (!unit) {
      return alert("Please select a unit.");
    }
    if (isNaN(costPrice) || costPrice < 0) {
      return alert("Please enter a valid cost price.");
    }
    if (isNaN(stock) || stock < 0) {
      return alert("Please enter a valid stock quantity.");
    }

    const itemIndex = document.getElementById('newStockItemFormContainer').dataset.editingIndex;

    if (itemIndex) {
      // Update existing item
      const item = menu[parseInt(itemIndex, 10)];
      item.name = name;
      item.unit = unit;
      item.costPrice = costPrice;
      item.stock = stock;
      
      if (sellingPriceInput && !isNaN(parseFloat(sellingPriceInput))) {
          item.price = parseFloat(sellingPriceInput);
      } else {
          // Recalculate price based on markup in case cost changed
          item.price = costPrice * (1 + ((settings.defaultMarkup || 200) / 100));
      }
      alert(`Item "${name}" updated successfully.`);
    } else {
      // Add new item
      // It's a primary ingredient, so calculate its selling price based on markup
      let price;
      if (sellingPriceInput && !isNaN(parseFloat(sellingPriceInput))) {
          price = parseFloat(sellingPriceInput);
      } else {
          const markup = (settings.defaultMarkup || 200) / 100;
          price = costPrice * (1 + markup);
      }
      const newItem = {
        name,
        category: null, // No default category
        costPrice,
        stock,
        unit,
        price,
        image: "https://placehold.co/100" // Default placeholder
      };

      restockHistory.unshift({
        date: new Date().toISOString(),
        itemName: name,
        adjustment: stock,
        newTotal: stock,
        note: 'Initial Stock'
      });
      menu.push(newItem);
      alert(`Item "${name}" added successfully.`);
    }

    saveData();
    toggleNewStockItemForm(false);
    renderStockListTable();
    renderMenu();
    renderDishesTable();
  }
  function clearNewStockItemForm() {
    document.getElementById('newStockItemName').value = '';
    document.getElementById('newStockItemUnit').value = '';
    document.getElementById('newStockItemCost').value = '';
    document.getElementById('newStockItemPrice').value = '';
    document.getElementById('newStockItemStock').value = '';
    delete document.getElementById('newStockItemFormContainer').dataset.editingIndex;
  }

  function renderRestockHistoryTable() {
    const tbody = document.getElementById('restockHistoryBody');
    if (!tbody) return;
    tbody.innerHTML = restockHistory.map(log => `
      <tr>
        <td class="u-fs-08">${new Date(log.date).toLocaleString()}</td>
        <td class="u-fs-08">${log.itemName}</td>
        <td class="u-fs-08 u-text-right u-bold" style="color: ${log.adjustment >= 0 ? '#28a745' : '#dc3545'};">
          ${log.adjustment > 0 ? '+' : ''}${log.adjustment}
        </td>
        <td class="u-fs-08 u-text-right">${log.newTotal}</td>
      </tr>
    `).join('');
  }

  // ===== Real-Time Cloud Sync =====
  let unsubscribeSync = null;

  /**
   * Sets up real-time listener for cross-device/cross-tab synchronization
   * Updates all tabs/devices instantly when cloud data changes
   */
  function setupRealTimeSync(uid) {
    if (!dbFirestore) {
      console.warn("🔴 Firestore not initialized, skipping real-time sync");
      isInitialLoadComplete = true; // Allow local-only operation
      return;
    }

    if (unsubscribeSync) unsubscribeSync();
    
    try {
      console.log('🟢 [SYNC] Setting up real-time listener for cross-device sync...');
      
      unsubscribeSync = onSnapshot(
        doc(dbFirestore, "users", uid, "data", "SHOP_DATA"),
        { includeMetadataChanges: true },
        (docSnap) => {
          if (docSnap.exists()) {
            const cloudData = docSnap.data();
            
            // Only update if changes come from the cloud (server)
            // hasPendingWrites = true means this is our local change being reflected
            // hasPendingWrites = false means this is an update from another device
            if (!docSnap.metadata.hasPendingWrites) {
              console.log('🔄 [SYNC] ✅ Real-time update from cloud (from another device/tab)');
              
              // Update global state with cloud data
              menu = cloudData.menu || menu;
              activeOrders = cloudData.activeOrders || activeOrders;
              settings = cloudData.settings || settings;
              staff = cloudData.staff || staff;
              dishCategories = cloudData.dishCategories || dishCategories;
              customers = cloudData.customers || customers;
              units = cloudData.units || units;
              restockHistory = cloudData.restockHistory || restockHistory;

              // Fetch transactions separately from sub-collection
              loadTransactionsFromCloud(uid);

              // Mark initial load as complete
              isInitialLoadComplete = true;

              // Persist cloud data to local IndexedDB only (skip cloud push to avoid loops)
              saveData(false); 

              // Refresh the current UI view immediately
              refreshCurrentView();
              updateDashboard();
              applyTheme();

              // Update login staff list if snapshot arrives while overlay is up
              const list = document.getElementById('staffNamesList');
              if (list) {
                list.innerHTML = (staff || []).map(s => `<option value="${s.name}">`).join('');
              }

              // Visual feedback on the sync button
              const statusEl = document.getElementById('connectivity-status');
              if (statusEl && statusEl.classList) {
                statusEl.classList.add('sync-pulse');
                setTimeout(() => statusEl.classList.remove('sync-pulse'), 600);
              }
            } else {
              console.log('📤 [SYNC] Local changes acknowledged by cloud');
            }
          } else {
            // Document doesn't exist on cloud yet
            console.log('📝 [SYNC] No cloud data found, user can create new data');
            isInitialLoadComplete = true;
          }
        },
        (error) => {
          handleFirebaseError(error, "Real-Time Sync Listener");
          console.log('Falling back to local-only mode. You can still use the app offline.');
          isInitialLoadComplete = true; // Don't block local work if cloud fails
        }
      );
    } catch (error) {
      console.warn("🟡 [SYNC] Error setting up real-time sync:", error.message);
      isInitialLoadComplete = true; // Allow offline operation
    }
  }

  /**
   * Re-renders the currently active tab to show fresh data.
   */
  function refreshCurrentView() {
    const activeTab = document.querySelector('section.active');
    if (!activeTab) return;
    
    const renderMap = {
      'dashboardTab': updateDashboard,
      'transactionsTab': renderTransactions,
      'menuTab': renderMenu,
      'addDishTab': renderDishesTable,
      'categoryTab': renderCategoryList,
      'unitTab': renderUnitList,
      'staffTab': renderStaffList,
      'customerTab': renderCustomerList,
      'settingsTab': () => { loadSettings(); },
      'stockTab': () => { renderInventoryReport(); renderStockListTable(); renderUnitList(); renderRestockHistoryTable(); },
      'reportsTab': () => { populateReportFilters(); renderReport(); }
    };
    if (renderMap[activeTab.id]) renderMap[activeTab.id]();
  }

  /**
   * Fetches the current version string from sw.js and updates the UI
   */
  async function updateVersionDisplay() {
    const displayEl = document.getElementById('app-version-display');
    if (!displayEl) return;
    try {
      const response = await fetch('./sw.js');
      const text = await response.text();
      const match = text.match(/CACHE_NAME\s*=\s*['"]yobill-(v\d+)['"]/);
      if (match) displayEl.textContent = match[1].toUpperCase();
    } catch (e) {
      displayEl.textContent = '1.5.0'; // Fallback
    }
  }

  // ===== Main App Initialization =====
  async function mainInit() {
    try {
      // Check if we are opening in Mobile Scanner Client Mode
      if (checkMobileScannerMode()) {
        return; // Stop normal app initialization
      }

      // Determine which local DB to open based on session
      const lastUid = sessionStorage.getItem('currentUserUid') || 'guest';
      await initDB(lastUid);

      // Request persistent storage to prevent browser from clearing data
      if (navigator.storage && navigator.storage.persist) {
        const isPersisted = await navigator.storage.persist();
        console.log(`Persisted storage granted: ${isPersisted}`);
      }

      // Load data from local IndexedDB
      const localData = await Promise.all([
        loadState('menu'),
        loadState('activeOrders'),
        loadState('transactions'),
        loadState('settings'),
        loadState('staff'),
        loadState('dishCategories'),
        loadState('customers'),
        loadState('units'),
        loadState('restockHistory')
      ]);

      // Initialize Connectivity Status Indicator
      updateOnlineStatus();
      window.addEventListener('online', updateOnlineStatus);
      window.addEventListener('offline', updateOnlineStatus);

      // Assign local settings immediately so login overlay can use them for branding
      settings = (localData[3] !== null) ? localData[3] : defaultSettings;

      // Populate state from local storage immediately
      menu = localData[0] || defaultMenu;
      activeOrders = localData[1] || {};
      transactions = localData[2] || [];
      staff = localData[4] || defaultStaff;
      dishCategories = localData[5] || defaultDishCategories;
      customers = localData[6] || [];
      units = localData[7] || [
        { full: 'Bottle', short: 'btl' },
        { full: 'Box', short: 'box' },
        { full: 'Can', short: 'can' },
        { full: 'Case', short: 'case' },
        { full: 'Each', short: 'each' },
        { full: 'Fluid Ounce', short: 'fl oz' },
        { full: 'Gallon', short: 'gal' },
        { full: 'Gram', short: 'g' },
        { full: 'Kilogram', short: 'kg' },
        { full: 'Litre', short: 'L' },
        { full: 'Millilitre', short: 'ml' },
        { full: 'Ounce', short: 'oz' },
        { full: 'Pack', short: 'pk' },
        { full: 'Piece', short: 'pc' },
        { full: 'Pint', short: 'pt' },
        { full: 'Pound', short: 'lb' }
      ];
      restockHistory = localData[8] || [];

      // START UI IMMEDIATELY
      applyTheme();
      handleSplashScreen();
      populateCurrencies();
      
      // CRITICAL: Render dashboard FIRST while other tabs are hidden
      // This ensures charts initialize on visible canvas elements
      updateDashboard();
      
      renderDishesTable();
      renderMenu();
      loadSettings();
      updateVersionDisplay();

      // Background Cloud Sync
      onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        updateAuthUI(user);
        if (user) {
          console.log("Logged in, syncing cloud data in background...");
          
          // If the user just logged in and it's different from the guest/previous DB,
          // we update the session and reload to ensure clean initialization.
          if (sessionStorage.getItem('currentUserUid') !== user.uid) {
            sessionStorage.setItem('currentUserUid', user.uid);
            // We don't reload here if this is the initial load triggered by login()
            // but we ensure future initializations use this UID.
          }
          
          setupRealTimeSync(user.uid);
        } else {
          sessionStorage.removeItem('currentUserUid');
          isInitialLoadComplete = true; // Enable saving for local guests
        }
      });

      renderCategoryList();
      renderInventoryReport();
      renderCustomerList();
      renderStaffList();
      toggleAddCustomerForm(false);
      renderUnitList();
      populateReportFilters();
      populateUnitDropdown();
      populateCategoryFilter();
      setupSettingsAccordion();
      updatePrinterStatus(false);

      // Instant Sync on Visibility Change
      // Save immediately when app goes to background
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          console.log('[SYNC] 📵 App backgrounding - forcing immediate sync');
          // Force immediate sync by clearing debounce
          if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
          syncDebounceTimer = null;
          lastSyncTime = 0; // Reset to allow immediate sync
          saveData();
        }
      });
      
      // Sync on online status change
      window.addEventListener('online', () => {
        console.log('[SYNC] 🌐 Back online - syncing all data');
        if (currentUser) {
          if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
          syncDebounceTimer = null;
          lastSyncTime = 0; // Reset to allow immediate sync
          saveData();
        }
      });
      
      // Listen for updates from other tabs/windows using storage events
      window.addEventListener('storage', (event) => {
        if (event.key && event.key.startsWith('posDB')) {
          console.log('[SYNC] 📱 Data changed in another tab - refreshing');
          // Data was changed in another tab, refresh current view
          setTimeout(() => {
            refreshCurrentView();
            updateDashboard();
          }, 100);
        }
      });

      // Save on visibility change (mobile app backgrounding/closing)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          saveData();
        }
      });

    } catch (error) {
      console.error("Failed to initialize the application:", error);
      document.body.innerHTML = `
        <div style="padding: 40px; text-align: center; background: var(--primary); color: white; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;">
          <h1 style="font-size: 4em; margin-bottom: 20px;">⚠️</h1>
          <h2>App Initialization Failed</h2>
          <p style="max-width: 400px; margin-bottom: 30px;">This usually happens in strict Private Browsing modes or if the local database is corrupted.</p>
          <button onclick="location.reload()" class="btn" style="background: white; color: var(--primary); padding: 12px 30px;">Try Refreshing</button>
          <p style="margin-top: 20px; font-size: 0.8em; opacity: 0.8; cursor: pointer; text-decoration: underline;" onclick="if(confirm('This will wipe all local data. Continue?')) { indexedDB.deleteDatabase('posDB'); location.reload(); }">Reset Local Database</p>
        </div>
      `;
    }
  }

  function showLoginOverlay(mode = 'login') {
    let overlay = document.getElementById('login-overlay');
    const logoUrl = sanitizeLogoUrl(settings?.logo);
    const displayLogo = logoUrl || 'assets/icons/icon-192x192.png';
    const logoHtml = `<img src="${displayLogo}" onerror="this.src='assets/icons/icon-192x192.png';" style="width: 100px; height: 100px; object-fit: contain; margin-bottom: 20px;">`;

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'login-overlay';
      overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: linear-gradient(135deg, var(--primary) 0%, #d35400 100%); z-index: 10000; display: flex; color: white; transition: opacity 0.5s;';
      document.body.appendChild(overlay);
    }

    if (!currentUser) {
      if (window._marketingInterval) clearInterval(window._marketingInterval);

      // Stage 1: Email Auth / Google Login
      const isRegister = mode === 'register';
      const title = isRegister ? 'Create Account' : 'Account Login Required';
      const submitText = isRegister ? 'Register' : 'Login';
      const submitFn = isRegister ? 'registerWithEmail()' : 'loginWithEmail()';
      const toggleText = isRegister ? 'Already have an account? Login' : "Don't have an account? Register";
      const toggleMode = isRegister ? 'login' : 'register';
      const googleBtnText = isRegister ? 'Register with Google' : 'Login with Google';

      overlay.style.flexDirection = 'row';
      overlay.style.alignItems = 'stretch';
      overlay.style.justifyContent = 'center';

      overlay.innerHTML = `
        <div class="marketing-side animate-panel-left" style="flex: 1.2; background: rgba(0,0,0,0.2); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px; text-align: center; border-right: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px);">
          ${logoHtml}
          <h1 style="font-size: 3.5em; margin-bottom: 10px;">${settings?.name || 'YoShop'}</h1>
          <h2 style="font-weight: 300; margin-bottom: 30px; opacity: 0.9;">Modern POS for Smart Businesses</h2>
          
          <div class="marketing-carousel" style="max-width: 450px; text-align: left;">
            <div class="marketing-slide active">
              <p style="font-size: 1.3em;">🚀 <strong>Fast & Reliable</strong></p>
              <p style="opacity: 0.8;">Transactions that never lag. Built for speed with full offline support so your business never stops.</p>
            </div>
            <div class="marketing-slide">
              <p style="font-size: 1.3em;">📊 <strong>Powerful Analytics</strong></p>
              <p style="opacity: 0.8;">Make data-driven decisions with real-time dashboards and comprehensive sales reports at your fingertips.</p>
            </div>
            <div class="marketing-slide">
              <p style="font-size: 1.3em;">📦 <strong>Smart Inventory</strong></p>
              <p style="opacity: 0.8;">Automated stock tracking, recipe-based deductions, and low-stock alerts to keep your shelves full.</p>
            </div>
            <div class="marketing-slide">
              <p style="font-size: 1.3em;">🔐 <strong>Enterprise Security</strong></p>
              <p style="opacity: 0.8;">Protect your business with encrypted cloud sync and Manager PIN protection for sensitive operations.</p>
            </div>
          </div>

          <div style="margin-top: 20px; display: flex; gap: 10px; margin-bottom: 40px;">
            <span class="carousel-dot" style="width: 8px; height: 8px; background: white; border-radius: 50%; opacity: 1;"></span>
            <span class="carousel-dot" style="width: 8px; height: 8px; background: white; border-radius: 50%; opacity: 0.3;"></span>
            <span class="carousel-dot" style="width: 8px; height: 8px; background: white; border-radius: 50%; opacity: 0.3;"></span>
            <span class="carousel-dot" style="width: 8px; height: 8px; background: white; border-radius: 50%; opacity: 0.3;"></span>
          </div>

          <div class="contact-info" style="width: 100%; max-width: 400px; padding: 20px; background: rgba(255,255,255,0.05); border-radius: 12px; font-size: 0.85em; text-align: left; line-height: 1.6;">
            <p style="margin: 0 0 10px 0; font-weight: bold; opacity: 0.9;">For more infor and support contact:</p>
            <p style="margin: 0 0 8px 0; display: flex; align-items: flex-start; gap: 10px;"><span style="font-size: 1.2em;">📍</span> <span>Uganda, Mbale Republic street</span></p>
            <p style="margin: 0 0 8px 0; display: flex; align-items: center; gap: 10px;"><span style="font-size: 1.2em;">📞</span> <span>watsap/call +256754350502</span></p>
            <p style="margin: 0; display: flex; align-items: center; gap: 10px;"><span style="font-size: 1.2em;">📧</span> <span>sadikkirya@gmail.com</span></p>
          </div>
        </div>
        <div class="login-side animate-panel-right" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px;">
          <div style="margin-bottom: 20px; opacity: 0.8; transform: scale(0.8);">${logoHtml}</div>
          <p style="font-size: 1.5em; margin-bottom: 25px; font-weight: bold;">${title}</p>
          
          <div id="email-login-form" style="display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 320px; margin-bottom: 15px;">
            ${isRegister ? `<input type="text" id="authName" placeholder="Full Name" style="padding: 12px; border-radius: 8px; border: none; color: var(--text); background: white;">` : ''}
            <input type="email" id="authEmail" placeholder="Email Address" style="padding: 12px; border-radius: 8px; border: none; color: var(--text); background: white;">
            <input type="password" id="authPassword" placeholder="Password" style="padding: 12px; border-radius: 8px; border: none; color: var(--text); background: white;">
            ${isRegister ? `<input type="password" id="authConfirmPassword" placeholder="Confirm Password" style="padding: 12px; border-radius: 8px; border: none; color: var(--text); background: white;">` : ''}
            <button onclick="${submitFn}" class="btn" style="background: #28a745; color: white; margin: 0; font-weight: bold; padding: 12px; border-radius: 8px; border: none; width: 100%;">${submitText}</button>
            
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 5px;">
              <a href="#" onclick="showLoginOverlay('${toggleMode}')" style="color: white; font-size: 0.8em; text-decoration: underline; opacity: 0.8;">${toggleText}</a>
              ${!isRegister ? `<a href="#" onclick="handleForgotPassword()" style="color: white; font-size: 0.8em; text-decoration: underline; opacity: 0.8;">Forgot Password?</a>` : ''}
            </div>
          </div>

          <div style="width: 100%; max-width: 320px; text-align: center; margin: 10px 0; position: relative;">
            <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.3);">
            <span style="position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: var(--primary); padding: 0 10px; font-size: 0.8em; opacity: 0.7;">OR</span>
          </div>

          <button onclick="login()" class="btn" style="background: white; color: var(--primary); padding: 12px 30px; font-size: 1.1em; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 15px; border-radius: 4px; border: none; box-shadow: 0 2px 4px rgba(0,0,0,0.2); width: 100%; max-width: 320px; margin: 0;">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width: 24px; height: 24px;">
            ${googleBtnText}
          </button>
          
          <div style="margin-top: 40px; font-size: 0.8em; opacity: 0.7; display: flex; gap: 20px;">
            <a href="#" style="color: white; text-decoration: none;">Privacy Policy</a>
            <a href="#" style="color: white; text-decoration: none;">Terms of Service</a>
          </div>
        </div>
      `;

      // Carousel Logic
      const slides = overlay.querySelectorAll('.marketing-slide');
      const dots = overlay.querySelectorAll('.carousel-dot');
      let current = 0;
      window._marketingInterval = setInterval(() => {
        const prev = current;
        slides[prev].classList.remove('active');
        slides[prev].classList.add('exit');
        dots[prev].style.opacity = "0.3";
        
        current = (current + 1) % slides.length;
        
        slides[current].classList.remove('exit');
        slides[current].classList.add('active');
        dots[current].style.opacity = "1";

        setTimeout(() => { slides[prev].classList.remove('exit'); }, 600);
      }, 4000);

    } else {
      if (window._marketingInterval) clearInterval(window._marketingInterval);

      // Stage 2: PIN Access
      overlay.style.flexDirection = 'column';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';

      overlay.innerHTML = `
        ${logoHtml}
        <h1 style="font-size: 3em; margin-bottom: 10px;">${settings?.name || 'YoShop'}</h1>
        <p style="font-size: 1.2em; margin-bottom: 10px;">Welcome, ${currentUser.displayName || currentUser.email.split('@')[0]}</p>
        
        <div style="display: flex; gap: 20px; margin-bottom: 20px; justify-content: center; width: 100%;">
          <label style="cursor:pointer; display: flex; align-items: center; gap: 5px; font-weight: bold;"><input type="radio" name="loginRole" value="manager" checked onchange="document.getElementById('staff-name-container').style.display='none'"> 🛡️ Manager</label>
          <label style="cursor:pointer; display: flex; align-items: center; gap: 5px; font-weight: bold;"><input type="radio" name="loginRole" value="staff" onchange="document.getElementById('staff-name-container').style.display='block'"> 👤 Staff</label>
        </div>

        <div id="staff-name-container" style="display: none; width: 100%; max-width: 300px; margin-bottom: 15px;">
          <input type="text" id="loginStaffName" list="staffNamesList" placeholder="Type or select staff name" style="padding: 12px; border-radius: 8px; border: none; width: 100%; color: var(--text); background: white; font-size: 1.1em;">
          <datalist id="staffNamesList">
            ${(staff || []).map(s => `<option value="${s.name}">`).join('')}
          </datalist>
        </div>
        
        <div id="pin-login-container" style="display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 300px;">
          <input type="password" id="loginPIN" placeholder="Enter PIN" maxlength="4" style="padding: 15px; border-radius: 8px; border: none; text-align: center; font-size: 1.5em; letter-spacing: 10px; width: 100%; color: var(--text);">
          <button onclick="loginWithPIN()" class="btn" style="background: #28a745; color: white; padding: 12px; font-weight: bold; width: 100%; margin: 0;">Unlock System</button>
          <a href="#" onclick="forgotPIN()" style="color: white; font-size: 0.8em; text-align: center; text-decoration: underline; opacity: 0.8; margin-top: 10px;">Forgot PIN?</a>
          <button onclick="logout()" class="btn" style="background: transparent; color: white; border: 1px solid white; padding: 10px; font-size: 0.9em; margin-top: 30px; cursor: pointer;">Logout from Google Account</button>
        </div>
        <div style="position: absolute; bottom: 30px; font-size: 0.8em; opacity: 0.7; display: flex; gap: 20px;">
          <a href="#" style="color: white; text-decoration: none;">Privacy Policy</a>
          <a href="#" style="color: white; text-decoration: none;">Terms of Service</a>
        </div>
      `;
    }
    overlay.style.display = 'flex';
  }

  function applyRolePermissions() {
    const isManager = currentUserRole === 'manager';
    const nav = document.querySelector('nav');
    if (!nav) return;
    
    nav.querySelectorAll('button').forEach(btn => {
      const onclick = btn.getAttribute('onclick') || '';
      const tabIdMatch = onclick.match(/showTab\('([^']+)'/);
      if (tabIdMatch) {
        const tabId = tabIdMatch[1];
        if (isManager) {
          btn.style.display = 'flex';
        } else {
          // Always show Shop and Refresh if not explicitly restricted
          btn.style.display = currentUserPermissions.includes(tabId) ? 'flex' : 'none';
        }
      }
    });

    // Hide Manager-specific settings groups
    const securityGroup = document.getElementById('securitySettingsGroup');
    if (securityGroup) securityGroup.style.display = isManager ? 'block' : 'none';
    
    // If staff is accidentally on an unauthorized tab, kick them to their first allowed tab
    const activeTab = document.querySelector('section.active');
    if (!isManager && activeTab && !currentUserPermissions.includes(activeTab.id)) {
      const targetTab = currentUserPermissions.includes('menuTab') ? 'menuTab' : currentUserPermissions[0];
      if (targetTab) {
        const targetBtn = nav.querySelector(`button[onclick*="${targetTab}"]`);
        if (targetBtn) showTab(targetTab, targetBtn);
      }
    }
  }

  function loginWithPIN() {
    const roleRadio = document.querySelector('input[name="loginRole"]:checked');
    const selectedRole = roleRadio ? roleRadio.value : 'manager';
    const enteredPin = document.getElementById('loginPIN').value;
    
    if (selectedRole === 'manager') {
      const managerPin = settings.managerPIN || "1234";
      if (enteredPin !== managerPin) {
        alert("Incorrect Manager PIN.");
        document.getElementById('loginPIN').value = '';
        return;
      }

      isPinVerified = true;
      sessionStorage.setItem('isPinVerified', 'true');
      currentUserRole = 'manager';
      sessionStorage.setItem('currentUserRole', 'manager');
      currentUserPermissions = []; // Managers bypass checks
      sessionStorage.removeItem('currentUserPermissions');
      currentLoggedInStaffName = 'Manager';
      sessionStorage.setItem('currentLoggedInStaffName', 'Manager');
      const overlay = document.getElementById('login-overlay');
      if (overlay) overlay.style.display = 'none';
      
      const lockBtn = document.getElementById('nav-lock-btn');
      if (lockBtn) lockBtn.style.display = 'inline-block';
      
      applyRolePermissions();
      console.log("Unlocked as Manager");
    } else { // Staff login
      const staffName = document.getElementById('loginStaffName').value.trim();
      if (!staffName) {
        alert("Please enter or select a staff member name.");
        return;
      }

      const staffMember = staff.find(s => s.name === staffName && s.pin === enteredPin);
      if (staffMember) {
        isPinVerified = true;
        sessionStorage.setItem('isPinVerified', 'true');
        currentUserRole = 'staff';
        sessionStorage.setItem('currentUserRole', 'staff');
        currentUserPermissions = staffMember.permissions || ['menuTab'];
        sessionStorage.setItem('currentUserPermissions', JSON.stringify(currentUserPermissions));
        currentLoggedInStaffName = staffMember.name;
        sessionStorage.setItem('currentLoggedInStaffName', staffMember.name);
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.style.display = 'none';

        const lockBtn = document.getElementById('nav-lock-btn');
        if (lockBtn) lockBtn.style.display = 'inline-block';
        
        applyRolePermissions();
        console.log(`Unlocked as Staff: ${staffMember.name}`);
      } else {
        alert("Incorrect PIN. Please try again.");
        document.getElementById('loginPIN').value = '';
      }
    }
  }

  async function forgotPIN() {
    if (!currentUser) return alert("Please sign in with Google first.");
    
    const roleRadio = document.querySelector('input[name="loginRole"]:checked');
    const selectedRole = roleRadio ? roleRadio.value : 'manager';

    if (selectedRole === 'staff') {
      return alert("Staff members should contact the Manager to reset their PIN.");
    }

    if (confirm(`Send a PIN reset code to ${currentUser.email}?`)) {
      alert(`A reset request has been simulated. In a production environment, an email would be sent to ${currentUser.email} with instructions.`);
    }
  }

  mainInit();
  window.addEventListener('load', handleSplashScreen);

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // updateViaCache: 'none' forces the browser to check the server for sw.js changes on every check
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then(registration => {
          console.log('Service Worker registered with scope:', registration.scope);
        
        // Check if there's already a waiting worker (update ready but not activated)
        if (registration.waiting) {
          triggerAppUpdate(false);
        }

        // Listen for new updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              triggerAppUpdate(false);
            }
          });
        });

        // Check for updates every 30 seconds for "instant" feel
        setInterval(() => {
          registration.update();
        }, 30 * 1000);

        // Immediately check for updates when the window is focused or tab becomes visible
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            registration.update();
          }
        });
      })
      .catch(err => {
        console.error('Service Worker registration failed:', err);
      });
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        const overlay = document.getElementById('update-overlay');
        const progressBar = document.getElementById('update-progress-bar');
        if (overlay) overlay.style.display = 'flex';
        
        if (progressBar) {
          // Trigger the white bar to slide across
          setTimeout(() => { progressBar.style.width = '100%'; }, 50);
        }
        
        // Small delay to ensure user sees the "Updating" message
        setTimeout(() => {
          window.location.reload();
        }, 1000);
        refreshing = true;
      }
    });
  }

  function isCheckoutActive() {
    const paymentModal = document.getElementById('paymentModal');
    const splitModal = document.getElementById('billSplitModal');
    const isPaymentOpen = paymentModal && paymentModal.style.display === 'flex';
    const isSplitOpen = splitModal && splitModal.style.display === 'flex';
    return isPaymentOpen || isSplitOpen;
  }

  function showUpdateNotification() {
    // Prevent duplicate notifications in the center
    if (appNotifications.some(n => n.message.includes('new version of YoShop'))) return;

    // Add to notification center
    addNotification('A new version of YoShop is available.', 'info', 'triggerAppUpdate(true)');
    
    playNotificationSound();

    // Show settings button
    const settingsBtn = document.getElementById('settingsUpdateBtn');
    if (settingsBtn) settingsBtn.style.display = 'inline-block';

    // Show toast
    const toast = document.getElementById('updateToast');
    if (toast) {
      toast.style.display = 'block';
      
      // Auto-hide toast after 10 seconds
      setTimeout(() => {
        if (toast.style.display === 'block') {
          toast.style.animation = 'slideOut 0.3s ease-in forwards';
          setTimeout(() => { toast.style.display = 'none'; }, 300);
        }
      }, 10000);
    }

    // Show system notification if enabled
    if (Notification.permission === 'granted' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(registration => {
        registration.showNotification('Update Available', {
          body: 'A new version of Yobill is available. Click to update.',
          icon: 'assets/icons/icon-192x192.png',
          tag: 'update-notification'
        });
      });
    }
  }

  function playNotificationSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.exponentialRampToValueAtTime(1046.5, ctx.currentTime + 0.1); // C6
      
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      console.error("Audio play failed", e);
    }
  }

  function triggerAppUpdate(isManual = false) {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return;

      // If an automatic update is found during checkout, show notification but postpone reload.
      // If it's a manual update (clicked "Update Now"), we reload regardless.
      if (!isManual && isCheckoutActive() && reg.waiting) {
        showUpdateNotification();
        console.log('[UPDATE] Checkout active, postponing automatic reload.');
        return;
      }

      if (reg && reg.waiting) {
        // Send message to SW to skip waiting and activate
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else {
        if (isManual) alert("Checking for updates... If a new version is found, the app will update automatically.");
        if (reg) reg.update();
      }
    });
  }
  
  // ===== PWA Install Button Logic (Enhanced for Cross-Browser Support) =====
  let deferredPrompt;
  const installAppBtn = document.getElementById('installAppBtn');

  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the default mini-infobar from appearing on mobile
    // e.preventDefault();
    console.log('👍 beforeinstallprompt fired. App is installable.');
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    // The button is already visible, just ensure it's enabled.
    installAppBtn.disabled = false;
    installAppBtn.textContent = 'Install App';
  });

  installAppBtn.addEventListener('click', async () => {
    // Case 1: `beforeinstallprompt` was fired (Chrome, Edge)
    if (deferredPrompt) {
      console.log('📲 Triggering install prompt...');
      deferredPrompt.prompt();
      // The prompt can only be used once.
      deferredPrompt = null;
      return;
    }

    // Case 2: The app is already installed (check display mode)
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      alert('This app is already installed on your device!');
      return;
    }

    // Case 3: Fallback for browsers that don't support `beforeinstallprompt` (like Safari on iOS)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      alert("To install this app on your iPhone or iPad:\n\n1. Tap the 'Share' button in the browser menu.\n2. Scroll down and tap 'Add to Home Screen'.");
    } else {
      alert("This app can be installed, but your browser doesn't support the automatic prompt. Please look for an 'Install' or 'Add to Home Screen' option in your browser's menu.");
    }
  });

  window.addEventListener('appinstalled', () => {
    installAppBtn.textContent = 'Installed';
    installAppBtn.disabled = true;
  });
  // ===== Data Export/Import =====
  function exportTransactionsToCSV() {
    if (transactions.length === 0) return alert("No transactions to export.");
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Date,Server,Item Name,Quantity,Price,Total,Payment Method,Notes\r\n";
    transactions.forEach(t => {
      t.items.forEach(item => {
        const row = [
          `"${new Date(t.date).toLocaleString()}"`, `"${t.customerName}"`,
          `"${item.name}"`, item.qty, item.price.toFixed(2), (item.qty * item.price).toFixed(2),
          t.paymentMethod, `"${item.notes || ''}"`
        ].join(",");
        csvContent += row + "\r\n";
      });
    });
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `transactions_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function backupAllData() {
    const dataToBackup = {
      menu, activeOrders, transactions, settings, staff, dishCategories, customers
    };
    const jsonString = JSON.stringify(dataToBackup, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pos-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function restoreData() {
    const fileInput = document.getElementById('restoreFile');
    if (fileInput.files.length === 0) return alert("Please select a backup file to restore.");
    if (!confirm("This will overwrite all current data. Are you sure you want to continue?")) return;

    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = async function(event) {
      try {
        const restoredData = JSON.parse(event.target.result);
        
        // Directly save each part of the restored data to IndexedDB
        await Promise.all([
          saveState('menu', restoredData.menu || defaultMenu),
          saveState('activeOrders', restoredData.activeOrders || {}),
          saveState('transactions', restoredData.transactions || []),
          saveState('settings', restoredData.settings || defaultSettings),
          saveState('staff', restoredData.staff || defaultStaff),
          saveState('dishCategories', restoredData.dishCategories || []),
          saveState('customers', restoredData.customers || []),
          saveState('restockHistory', restoredData.restockHistory || []),
          saveState('units', restoredData.units || [
            { full: 'Bottle', short: 'btl' },
            { full: 'Box', short: 'box' },
            { full: 'Can', short: 'can' },
            { full: 'Case', short: 'case' },
            { full: 'Each', short: 'each' },
            { full: 'Fluid Ounce', short: 'fl oz' },
            { full: 'Gallon', short: 'gal' },
            { full: 'Gram', short: 'g' },
            { full: 'Kilogram', short: 'kg' },
            { full: 'Litre', short: 'L' },
            { full: 'Millilitre', short: 'ml' },
            { full: 'Ounce', short: 'oz' },
            { full: 'Pack', short: 'pk' },
            { full: 'Piece', short: 'pc' },
            { full: 'Pint', short: 'pt' },
            { full: 'Pound', short: 'lb' }
          ])
        ]);

        alert("Data restored successfully. The application will now reload.");
        location.reload();
      } catch (e) { alert("Error reading or parsing the backup file. Please ensure it's a valid backup."); }
    };
    reader.readAsText(file);
  }

  // ===== Barcode Logic =====
  
  // Global Barcode Listener
  let barcodeBuffer = '';
  let lastKeyTime = Date.now();

  document.addEventListener('keydown', (e) => {
    // Ignore if user is typing in a regular input field (except the scanner test input)
    if (e.target.tagName === 'INPUT' && e.target.id !== 'scannerTestInput') return;
    if (e.target.tagName === 'TEXTAREA') return;

    const currentTime = Date.now();
    
    // If time between keys is long (>100ms), it's likely manual typing, reset buffer
    // Scanners usually type very fast (<20ms per char)
    if (currentTime - lastKeyTime > 100) {
        barcodeBuffer = '';
    }
    lastKeyTime = currentTime;

    if (e.key === 'Enter') {
        if (barcodeBuffer.length > 0) {
            handleBarcodeScan(barcodeBuffer);
            barcodeBuffer = '';
        }
    } else if (e.key.length === 1) { // Printable characters
        barcodeBuffer += e.key;
    }
  });

  function handleBarcodeScan(code) {
    // 1. Check if in Settings -> Test
    const testInput = document.getElementById('scannerTestInput');
    if (testInput && document.activeElement === testInput) {
        document.getElementById('lastScannedCode').textContent = code;
        testInput.value = code; 
        return;
    }

    // 2. Check if in Menu Tab -> Add to Order
    if (document.getElementById('menuTab').classList.contains('active')) {
        // Search by barcode property first, then fallback to name
        const dish = menu.find(d => (d.barcode && d.barcode === code) || d.name === code); 
        if (dish) {
            addToOrder(CART_ID, dish.name);
            // Optional: Play a beep sound here
        } else {
            alert(`Item with barcode "${code}" not found in menu.`);
        }
    }
    
    // 3. Check if in Stock/Dishes Tab -> Search
    if (document.getElementById('stockTab').classList.contains('active')) {
        const searchInput = document.getElementById('stockSearchInput');
        if (searchInput) {
            searchInput.value = code;
            renderStockListTable();
        }
    }
  }

  // ===== Mobile Scanner Logic (PeerJS) =====
  let peer = null;
  let conn = null;
  let lastScannedCodeMobile = '';
  let lastScannedTimeMobile = 0;

  function startMobileConnection() {
    if (peer && !peer.destroyed) {
        showMobileConnectModal(peer.id);
        return;
    }

    // Initialize PeerJS
    peer = new Peer(); 

    peer.on('open', function(id) {
        showMobileConnectModal(id);
    });

    peer.on('connection', function(c) {
        if(conn) { c.close(); } // Close existing if any
        
        conn = c;
        setupConnectionHandlers();
        
        document.getElementById('mobileScannerStatus').textContent = "Phone Connected";
        document.getElementById('mobileScannerStatus').style.color = "#28a745";
        closeMobileConnectModal();
        alert("Mobile phone connected as scanner!");
    });
    
    peer.on('error', function(err) {
        console.error(err);
        alert("Mobile connection error: " + err.type);
    });
  }

  function showMobileConnectModal(id) {
    const modal = document.getElementById('mobileConnectModal');
    const qrContainer = document.getElementById('mobileConnectQR');
    const link = document.getElementById('mobileConnectLink');
    
    // Construct URL: current page + ?mobileScanner=ID
    const url = window.location.protocol + '//' + window.location.host + window.location.pathname + '?mobileScanner=' + id;
    
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
        text: url,
        width: 200,
        height: 200
    });
    
    link.href = url;
    modal.style.display = 'flex';
  }

  function closeMobileConnectModal() {
    document.getElementById('mobileConnectModal').style.display = 'none';
  }

  function setupConnectionHandlers() {
    conn.on('data', function(data) {
        if (data.type === 'barcode') {
            handleBarcodeScan(data.code);
            // Send acknowledgement to flash the screen on mobile
            conn.send({type: 'ack'});
        }
    });
    conn.on('close', function() {
        document.getElementById('mobileScannerStatus').textContent = "Phone Disconnected";
        document.getElementById('mobileScannerStatus').style.color = "red";
        conn = null;
    });
  }

  // Check for mobile scanner mode on load
  function checkMobileScannerMode() {
    const urlParams = new URLSearchParams(window.location.search);
    const hostId = urlParams.get('mobileScanner');
    
    if (hostId) {
        initMobileScannerClient(hostId);
        return true; // Stop normal app init
    }
    return false;
  }

  function initMobileScannerClient(hostId) {
    // Hide splash and main app
    document.getElementById('splash-screen').style.display = 'none';
    document.body.classList.remove('loading');
    
    // Show mobile scanner UI
    const ui = document.getElementById('mobile-scanner-ui');
    ui.style.display = 'flex';
    
    const statusEl = document.getElementById('ms-status');
    
    peer = new Peer();
    
    peer.on('open', function(id) {
        statusEl.textContent = "Connecting to POS...";
        conn = peer.connect(hostId);
        
        conn.on('open', function() {
            statusEl.textContent = "Connected to POS ✅";
            statusEl.style.color = "#28a745";
            startMobileCamera();
        });
        
        conn.on('data', function(data) {
            if (data.type === 'ack') {
                const feedback = document.getElementById('scan-feedback');
                feedback.style.opacity = '1';
                setTimeout(() => feedback.style.opacity = '0', 500);
            }
        });
        
        conn.on('close', function() {
            statusEl.textContent = "Disconnected from POS ❌";
            statusEl.style.color = "#dc3545";
            alert("Disconnected from POS.");
        });
        
        conn.on('error', function(err) {
             console.error(err);
             statusEl.textContent = "Connection Error";
        });
    });
  }

  function startMobileCamera() {
      const scanner = new Html5QrcodeScanner("ms-reader", { fps: 10, qrbox: 250, aspectRatio: 1.0 }, false);
      scanner.render((decodedText) => {
          const now = Date.now();
          // Simple debounce to prevent double scanning the same code instantly
          if (decodedText === lastScannedCodeMobile && now - lastScannedTimeMobile < 2000) {
              return; 
          }
          lastScannedCodeMobile = decodedText;
          lastScannedTimeMobile = now;
          
          if (conn && conn.open) {
              conn.send({type: 'barcode', code: decodedText});
          }
      });
  }

  // ===== Camera Scanner Logic =====
  let html5QrcodeScanner = null;

  function manualBarcodeInput() {
    const code = prompt("Enter Product Barcode:");
    if (code) {
        const trimmedCode = code.trim();
        if (document.getElementById('menuTab').classList.contains('active')) {
            const searchInput = document.getElementById('menuSearch');
            if (searchInput) {
                searchInput.value = trimmedCode;
                renderMenu();
            }
        } else {
            handleBarcodeScan(trimmedCode);
        }
    }
  }

  function startCameraScan() {
    document.getElementById('cameraScannerModal').style.display = 'flex';
    
    // Small delay to ensure modal is rendered
    setTimeout(() => {
        if (!html5QrcodeScanner) {
            html5QrcodeScanner = new Html5QrcodeScanner(
                "reader", 
                { fps: 10, qrbox: 250 },
                /* verbose= */ false);
            
            html5QrcodeScanner.render((decodedText, decodedResult) => {
                // Success callback
                handleBarcodeScan(decodedText);
                closeCameraScanner();
            }, (errorMessage) => {
                // parse error, ignore it.
            });
        }
    }, 100);
  }

  function closeCameraScanner() {
    document.getElementById('cameraScannerModal').style.display = 'none';
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear().then(() => {
            html5QrcodeScanner = null;
            document.getElementById('reader').innerHTML = "";
        }).catch(error => console.error("Failed to clear scanner", error));
    }
  }

  function generateAndPrintBarcodes() {
    if (typeof JsBarcode === 'undefined' || typeof window.jspdf === 'undefined') {
        return alert("Barcode libraries not loaded. Please check internet connection.");
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let x = 10, y = 10;
    const width = 60, height = 30; // Label size
    const margin = 5;

    // Filter items that have a barcode or name
    const itemsToPrint = menu.filter(item => item.barcode || item.name);

    if (itemsToPrint.length === 0) return alert("No items to print.");

    itemsToPrint.forEach((item, index) => {
        const canvas = document.createElement('canvas');
        try {
            JsBarcode(canvas, item.barcode || item.name, {
                format: "CODE128",
                displayValue: true,
                fontSize: 14
            });
            const imgData = canvas.toDataURL("image/png");
            
            if (x + width > 200) { x = 10; y += height + margin; }
            if (y + height > 280) { doc.addPage(); x = 10; y = 10; }

            doc.addImage(imgData, 'PNG', x, y, width, height);
            x += width + margin;
        } catch (e) {
            console.warn(`Could not generate barcode for ${item.name}`, e);
        }
    });

    doc.save("barcodes.pdf");
    // To print, we open the PDF in a new tab (blob url)
    const pdfBlob = doc.output('bloburl');
    window.open(pdfBlob, '_blank');
  }

  function printDishLabel(index) {
    if (typeof JsBarcode === 'undefined' || typeof window.jspdf === 'undefined') {
        return alert("Barcode libraries not loaded. Please check internet connection.");
    }

    const item = menu[index];
    if (!item) return;

    const { jsPDF } = window.jspdf;
    // Create a small label PDF (60mm x 40mm)
    const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: [60, 40] 
    });

    doc.setFontSize(10);
    const splitTitle = doc.splitTextToSize(item.name, 55);
    doc.text(splitTitle, 30, 5, { align: 'center' });
    
    doc.setFontSize(9);
    doc.text(`${settings.currency || '$'}${formatCurrency(item.price)}`, 30, 10 + (splitTitle.length - 1) * 4, { align: 'center' });

    if (item.barcode || item.name) {
        const canvas = document.createElement('canvas');
        try {
            JsBarcode(canvas, item.barcode || item.name, { format: "CODE128", displayValue: true, fontSize: 14, margin: 0, height: 50, width: 2 });
            const imgData = canvas.toDataURL("image/png");
            const yPos = 12 + (splitTitle.length - 1) * 4;
            doc.addImage(imgData, 'PNG', 5, yPos, 50, 20);
        } catch (e) { console.warn(`Could not generate barcode for ${item.name}`, e); }
    }

    const pdfBlob = doc.output('bloburl');
    window.open(pdfBlob, '_blank');
  }

  // ===== Notification Functions =====
  function checkNotificationStatus() {
    const statusEl = document.getElementById('notificationStatus');
    const btn = document.getElementById('enableNotifBtn');
    if (!statusEl) return;
    
    if (!('Notification' in window)) {
      statusEl.textContent = "Not Supported";
      if(btn) btn.disabled = true;
      return;
    }
    
    statusEl.textContent = Notification.permission;
    if (btn) {
      if (Notification.permission === 'granted') {
        btn.textContent = "Notifications Enabled";
        btn.disabled = true;
      } else if (Notification.permission === 'denied') {
        btn.textContent = "Notifications Denied";
        btn.disabled = true;
      } else {
        btn.textContent = "Enable Notifications";
        btn.disabled = false;
      }
    }
  }

  async function requestNotificationPermission() {
    if (!('Notification' in window)) return alert("Notifications not supported.");
    const permission = await Notification.requestPermission();
    checkNotificationStatus();
    if (permission === 'granted') {
      testLocalNotification();
    }
  }

  function testLocalNotification() {
    if (Notification.permission === 'granted') {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification('YoShop Notification', {
            body: 'Notifications are working correctly!',
            icon: 'assets/icons/icon-192x192.png',
            vibrate: [100, 50, 100]
          });
        });
      } else {
        new Notification('YoShop Notification', {
          body: 'Notifications are working correctly!',
          icon: 'assets/icons/icon-192x192.png'
        });
      }
    } else {
      alert("Please enable notifications first.");
    }
  }

  // ===== Notification Center Logic =====
  let appNotifications = [];

  function addNotification(message, type = 'info', action = null) {
    const notif = { id: Date.now(), message, type, action, date: new Date() };
    appNotifications.unshift(notif);
    updateNotificationBadge();
    renderNotifications();
  }

  function updateNotificationBadge() {
    const badge = document.getElementById('update-badge');
    const btn = document.getElementById('update-notification-btn');
    if (appNotifications.length > 0) {
        badge.style.display = 'block';
        badge.textContent = appNotifications.length > 9 ? '9+' : appNotifications.length;
        badge.style.width = 'auto';
        badge.style.minWidth = '16px';
        badge.style.height = '16px';
        badge.style.padding = '0 4px';
        badge.style.fontSize = '10px';
        badge.style.lineHeight = '16px';
        badge.style.textAlign = 'center';
        badge.style.color = 'white';
        btn.classList.add('ringing');
    } else {
        badge.style.display = 'none';
        btn.classList.remove('ringing');
    }
  }

  function toggleNotifications() {
    const dropdown = document.getElementById('notificationDropdown');
    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';
  }

  function renderNotifications() {
    const list = document.getElementById('notificationList');
    if (appNotifications.length === 0) {
        list.innerHTML = '<div style="padding: 15px; text-align: center; color: #888;">No notifications</div>';
        return;
    }
    
    list.innerHTML = appNotifications.map(n => {
        const actionBtn = n.action ? `<button class="btn" onclick="${n.action}" style="font-size: 0.8em; padding: 4px 8px; margin-top: 5px; background: var(--primary);">Action</button>` : '';
        const background = n.type === 'alert' ? 'rgba(255,0,0,0.05)' : 'transparent';
        
        return `
            <div style="padding: 10px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: start; background: ${background};">
                <div style="font-size: 0.9em; flex-grow: 1;">
                    <div style="margin-bottom: 4px;">${n.message}</div>
                    <div style="font-size: 0.8em; color: #888;">${n.date.toLocaleTimeString()}</div>
                    ${actionBtn}
                </div>
                <button onclick="dismissNotification(${n.id})" style="background: none; border: none; cursor: pointer; color: #888; font-size: 1.2em; padding: 0 5px;">&times;</button>
            </div>`;
    }).join('');
  }

  function dismissNotification(id) {
    appNotifications = appNotifications.filter(n => n.id !== id);
    updateNotificationBadge();
    renderNotifications();
  }

  function clearAllNotifications() {
    appNotifications = [];
    updateNotificationBadge();
    renderNotifications();
  }

  function sendLowStockNotification(itemName, currentStock) {
    // Add to in-app notification center
    addNotification(`${itemName} is running low! Only ${Number(currentStock).toFixed(1)} remaining.`, 'alert');

    if (Notification.permission === 'granted') {
      const title = 'Low Stock Alert';
      const options = {
        body: `${itemName} is running low! Only ${Number(currentStock).toFixed(1)} remaining.`,
        icon: 'assets/icons/icon-192x192.png',
        tag: 'low-stock-' + itemName,
        vibrate: [200, 100, 200]
      };

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification(title, options);
        });
      } else {
        new Notification(title, options);
      }
    }
  }

// Expose functions to global scope for inline event handlers (HTML onclick, etc.)
Object.assign(window, {
  // Data and State (Required for inline HTML references)
  menu, activeOrders, transactions, settings, staff, dishCategories, customers, units, auth, currentUser,
  db, CART_ID, analytics, app, dbFirestore,

  // Functions
  toggleNav, showTab, renderMenu, addDish, generateRandomBarcode, editDish,
  addNewRecipeItemFromForm, updateRecipeItemUnit, updateRecipeTotals,
  previewDishImage, previewLogo, toggleAddDishForm, openBillSplitModal, closeSplitBillModal, renderRestockHistoryTable,
  addSplitBill, removeSplitBill, moveItemToFirstBill, moveItemToUnassigned,
  processSplitPayments, addToOrder, decreaseQty, processBill, updatePaymentTotals,
  toggleCashPaymentFields, calculateChange, finalizePayment, printDishLabel, getCurrentServerName,
  deleteItem, previewOrder, downloadCurrentReceiptAsPDF, shareReceipt,
  printReceipt, connectUSBScanner, connectBluetoothScanner,
  connectUSBPrinter, connectBluetoothPrinter, disconnectPrinter, testPrint,
  directPrint, renderTransactions, downloadBillAsPDF, deleteTransaction, handleChangePassword,
  reopenTransaction, downloadReportPDF, saveSettings, addStaff, deleteStaff,
  resetApp, addCategory, editCategory, deleteCategory, addUnit, deleteUnit,
  toggleAddCustomerForm, addCustomer, editCustomer, deleteCustomer, toggleTheme,
  renderStockListTable, editStockItem, toggleStockAdjustmentForm,
  saveStockAdjustment, toggleNewStockItemForm, saveNewStockItem,
  triggerAppUpdate, exportTransactionsToCSV, backupAllData, restoreData,
  manualBarcodeInput, startCameraScan, closeCameraScanner, startMobileConnection, login, loginWithEmail, registerWithEmail, handleForgotPassword, logout, syncNow,
  closeMobileConnectModal, generateAndPrintBarcodes, requestNotificationPermission,
  showLoginOverlay, testLocalNotification, toggleNotifications, dismissNotification,
  clearAllNotifications, refreshApp, handleSplashScreen, applyTheme, togglePINVisibility, loginWithPIN, lockApp, forgotPIN, searchTransactionsByRange
});
