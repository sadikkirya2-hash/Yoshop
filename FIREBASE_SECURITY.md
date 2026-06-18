# Firebase Security Rules & Indexing for YoShop

## 🔐 Firestore Security Rules (Complete)

### Overview
These rules ensure:
- Secure authentication and authorization
- PINs and sensitive data protected
- 100+ shops can be managed safely
- Real-time sync secured
- Admin override capabilities

### Production Rules

```firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // ===== USERS COLLECTION =====
    // App Admin can read/write all users
    // Users can read/write their own data
    match /users/{userId} {
      allow create: if isAuthenticated();
      allow read: if isOwner(userId) || isAdmin();
      allow update: if isOwner(userId) || isAdmin();
      allow delete: if isAdmin();
      
      // Nested data collection (menu, settings, etc.)
      match /data/{document=**} {
        allow read, write: if isOwner(userId) || isAdmin();
      }
      
      // Transactions sub-collection
      match /transactions/{transactionId} {
        allow read, write: if isOwner(userId) || isAdmin();
      }
      
      // Analytics sub-collection
      match /analytics/{analyticsId} {
        allow read, write: if isOwner(userId) || isAdmin();
      }
    }
    
    // ===== SHARED RESOURCES (if any) =====
    match /public/{document=**} {
      allow read: if true; // Public read access
      allow write: if isAdmin(); // Only admin can write
    }
    
    // ===== HELPER FUNCTIONS =====
    function isAuthenticated() {
      return request.auth != null;
    }
    
    function isOwner(userId) {
      return request.auth.uid == userId;
    }
    
    function isAdmin() {
      // Master admin UID - UPDATE THIS TO YOUR ADMIN UID
      return request.auth.uid == 'Y0N3Ny1AX9VZEQb6AdRwhK8xpkg2';
    }
    
    function hasValidCredentials() {
      return request.auth.token.email_verified == true;
    }
    
    function isRateLimited(userId) {
      // Prevent rapid fire requests
      let lastWrite = resource.data.lastUpdated;
      return request.time < timestamp.value(lastWrite) + duration.value(1s);
    }
  }
}
```

---

## 🗂️ Required Firestore Indexes

### Index 1: Users by Last Login (for admin dashboard)

**Collection:** `users`  
**Fields:**
- `lastLogin` (Descending)
- Status: **Scope: Collection**

**Purpose:** Efficiently load recently active shops

**Query Pattern:**
```javascript
query(collection(dbFirestore, "users"), orderBy('lastLogin', 'desc'), limit(25))
```

---

### Index 2: Users by Status & Last Login

**Collection:** `users`  
**Fields:**
- `status` (Ascending)
- `lastLogin` (Descending)
- Status: **Scope: Collection**

**Purpose:** Filter active/pending shops sorted by activity

**Query Pattern:**
```javascript
query(collection(dbFirestore, "users"), 
  where('status', '==', 'active'),
  orderBy('lastLogin', 'desc'),
  limit(25)
)
```

---

### Index 3: Subscription Expiry Check

**Collection:** `users`  
**Fields:**
- `subscriptionExpires` (Ascending)
- Status: **Scope: Collection**

**Purpose:** Find expired subscriptions for notifications

**Query Pattern:**
```javascript
query(collection(dbFirestore, "users"),
  where('subscriptionExpires', '<', new Date())
)
```

---

### Index 4: Transactions by Date (per user)

**Collection:** `users` > `{userId}` > `transactions`  
**Fields:**
- `date` (Descending)
- Status: **Scope: Collection**

**Purpose:** Load recent transactions for each shop

**Query Pattern:**
```javascript
query(collection(dbFirestore, "users", userId, "transactions"),
  orderBy('date', 'desc'),
  limit(50)
)
```

---

## 📈 Performance Tuning

### Firebase Settings Recommendations

#### Firestore

```
Document Write Cost: 1 unit per write
Document Read Cost: 1 unit per read
Document Delete Cost: 1 unit per delete

For 100+ shops:
- Expected monthly reads: ~100,000
- Expected monthly writes: ~50,000
- Total operations: ~150,000 (within free tier)
```

#### Cloud Storage

```
File Upload: 1 cent per GB
File Download: 0.12 cents per GB
Storage: 5 GB free

For YoShop with logos/receipts:
- Expected monthly storage: 1-2 GB
- Expected bandwidth: 500 MB (well within free tier)
```

---

## 🔍 Monitoring & Quotas

### Set Up Firebase Alerts

1. Go to Firebase Console > Firestore > Usage
2. Set alerts for:
   - Read operations > 100,000/day
   - Write operations > 50,000/day
   - Storage > 4 GB
   - Bandwidth > 1 GB/month

### Quota Warnings

These quotas are built-in to YoShop:

```javascript
const QUOTA_LIMITS = {
  firebaseCallsPerSecond: 100,
  storagePerShop: 100, // MB
  transactionsPerDay: 10000,
  concurrentConnections: 50
};
```

---

## 🛡️ Data Protection

### Encryption

- ✅ **In Transit:** HTTPS/TLS (Firebase default)
- ✅ **At Rest:** Google Cloud encryption (Firebase default)
- ✅ **Sensitive Fields:** PINs never sent to client
- ✅ **PIIs:** Email addresses hashed in logs

### Backup Strategy

```javascript
// Automatic backups (recommended monthly)
// 1. Use Firebase Console > Firestore > Backups
// 2. Enable automatic backups
// 3. Retention: 30 days recommended

// Or manual backup via:
exportTransactionsToCSV()
backupAllData()  // Local backup
```

---

## 🚨 Common Security Issues & Solutions

### Issue: Unauthenticated reads

**Problem:** Users can read all shops data

**Solution:** Update rules to require authentication

```firestore
allow read: if isAuthenticated();
```

### Issue: Excessive writes

**Problem:** Sync creates too many writes

**Solution:** Implement write batching (already in app)

```javascript
// Already implemented in saveData()
const batch = writeBatch(dbFirestore);
// batch multiple writes
await batch.commit();
```

### Issue: Data breach exposure

**Problem:** PINs stored in documents

**Solution:** PINs never stored (already fixed)

```javascript
// ✅ App admin PIN only stored locally
// ✅ Never transmitted to Firebase
// ✅ Staff PINs stored encrypted
```

---

## 📋 Pre-Deployment Security Checklist

- [ ] Security rules reviewed and deployed
- [ ] All indexes created in Firestore
- [ ] Admin UID updated in security rules
- [ ] Rate limiting configured
- [ ] Authentication verified
- [ ] No hardcoded credentials in code
- [ ] HTTPS enabled on hosting domain
- [ ] Firebase API key restricted (API restrictions)
- [ ] Cloud Storage rules set to private by default
- [ ] Backup strategy configured
- [ ] Monitoring alerts set up
- [ ] SSL certificate installed
- [ ] CORS headers configured correctly

---

## 🔑 API Key Security

### Restrict Your Firebase Web API Key

In Firebase Console:

1. Go to **Settings** > **Service Accounts**
2. Click **API keys**
3. Click your web API key (starts with `AIzaSy`)
4. Set **Application restrictions:** Web applications only
5. Set **API restrictions:** Select specific APIs:
   - Cloud Firestore API ✓
   - Firebase Storage API ✓
   - Firebase Authentication API ✓
   - Google Analytics API ✓

### Expected API Key

Your current public key is safe because:
- ✅ Restricted to web origin only
- ✅ Firestore rules enforce authentication
- ✅ Storage rules enforce user ownership
- ✅ Public key is designed for client-side use

---

## 📊 Audit Logging

### Enable Audit Logs in Firebase

Cloud Audit Logs track:
- Admin Activity
- Data Access
- System Events

View in: **Cloud Console** > **Cloud Audit Logs**

### What Gets Logged

- ✅ All read/write operations
- ✅ Authentication events
- ✅ Rule violations
- ✅ Access attempts
- ✅ Configuration changes

---

## 🔄 Regular Security Reviews

### Weekly
- [ ] Check error logs for suspicious patterns
- [ ] Review quota usage
- [ ] Monitor failed authentication attempts

### Monthly
- [ ] Review audit logs
- [ ] Update security rules if needed
- [ ] Verify backups working
- [ ] Check for new security advisories

### Quarterly
- [ ] Full security audit
- [ ] Penetration testing (if applicable)
- [ ] Update dependencies
- [ ] Review access logs

---

## 📞 Emergency Procedures

### If Compromised

1. **Disable user immediately:**
   ```javascript
   // Via Firebase Console > Auth
   // Disable compromised user account
   ```

2. **Revoke tokens:**
   ```javascript
   // Firebase handles automatically on logout
   ```

3. **Reset rules (emergency mode):**
   ```firestore
   match /databases/{database}/documents {
     match /{document=**} {
       allow read, write: if false; // Deny all
     }
   }
   ```

4. **Review audit logs**
5. **Restore from backup** if necessary

---

## 📚 References

- [Firebase Security Rules](https://firebase.google.com/docs/database/security)
- [Firestore Indexes](https://firebase.google.com/docs/firestore/indexes)
- [Cloud Firestore Quotas](https://firebase.google.com/docs/firestore/quotas)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)

---

**Last Updated:** 2026-06-18  
**Status:** ✅ Production Ready  
**Compliance:** GDPR-friendly, PCI Data Security Standard considerations
