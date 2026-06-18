# 🎯 YoShop Quick Reference - Deployment & Operations

## 🚀 Quick Deploy (Copy & Paste Commands)

### Option 1: Deploy to Firebase Hosting (Recommended)

```bash
# 1. Authenticate with Firebase
firebase login

# 2. Deploy hosting + rules
firebase deploy --only hosting,firestore:rules

# 3. Verify deployment
firebase serve --only hosting

# 4. Open in browser
open https://yoshop-b502f.web.app
```

### Option 2: Custom Hosting (Nginx/Apache)

```bash
# 1. Build/minify if using build tool
# (or skip if serving raw files)

# 2. Upload to your server
scp -r ./* user@yourdomain.com:/var/www/yoshop/

# 3. Configure HTTPS
# Use Let's Encrypt or similar

# 4. Test
curl -I https://yourdomain.com/yoshop
```

---

## 📊 Console Shortcuts

### Health & Monitoring (Paste into Browser Console)

```javascript
// Quick health check
getAppHealthStatus()

// Export errors
exportErrorLog()

// View recent errors
errorLog.slice(-10)

// Cache status
requestCache.size

// Firebase status
dbFirestore !== null ? 'Connected' : 'Disconnected'

// User status
currentUser ? currentUser.email : 'Not authenticated'

// All stats at once
console.table({
  Health: getAppHealthStatus().status,
  CacheSize: requestCache.size,
  Errors: errorLog.length,
  FirebaseConnected: dbFirestore !== null ? 'Yes' : 'No',
  UserAuthenticated: currentUser ? 'Yes' : 'No'
})
```

### Performance Testing

```javascript
// Measure dashboard load time
console.time('dashboard');
refreshAppAdminShops();
console.timeEnd('dashboard');

// Measure sync latency
console.time('sync');
saveData();
console.timeEnd('sync');

// Monitor memory
performance.memory.usedJSHeapSize / 1048576 + ' MB'

// Check if caching is working
requestCache.size
```

---

## 🔒 Security Quick Checks

### Before Going Live

```bash
# 1. Verify no hardcoded credentials
grep -r "password\|pin\|secret\|token" app.js | grep -v "//"

# 2. Check for console logs of sensitive data
grep -r "console.log.*password\|console.log.*pin\|console.log.*token" app.js

# 3. Verify Firebase rules are deployed
firebase rules:list

# 4. Check Firebase API key is restricted
firebase projects:list
# Open Firebase Console > Settings > API Keys
```

### Firebase Security Rules Status

```bash
# Download current rules
firebase rules:download --rules firestore.rules

# Validate rules syntax
firebase rules:test

# Deploy rules
firebase deploy --only firestore:rules
```

---

## 📈 Deployment Commands by Environment

### Staging Deployment

```bash
# Deploy to staging (different Firebase project)
firebase use staging

# Or specify explicitly
firebase deploy --project yoshop-staging --only hosting,firestore:rules

# View logs
firebase functions:log --project yoshop-staging
```

### Production Deployment

```bash
# Set to production
firebase use production

# Deploy
firebase deploy --only hosting,firestore:rules

# Verify
open https://yoshop-b502f.web.app

# Monitor
firebase serve --port 5000
```

### Rollback

```bash
# Revert to previous version (from git)
git log --oneline
git revert <commit-hash>
firebase deploy --only hosting,firestore:rules

# Or restore from backup
# Manual restore needed from Firebase Backup
```

---

## 🗂️ File Structure Reference

```
/workspaces/Yoshop/
├── app.js                              # Main app logic (7300+ lines)
├── index.html                          # HTML structure
├── style.css                           # Styling
├── sw.js                              # Service Worker
├── manifest.json                       # PWA manifest
├── firebase.json                       # Firebase config
├── firestore.rules                     # Security rules
├── firestore.indexes.json              # Index definitions
├── DEPLOYMENT_GUIDE.md                 # Full deployment steps
├── FIREBASE_SECURITY.md                # Security & rules
├── PERFORMANCE_GUIDE.md                # Performance tuning
├── DEPLOYMENT_CHECKLIST.md             # Pre-launch checklist
└── DEPLOYMENT_SUMMARY.md               # This summary

assets/
├── app.js (backup)
├── style.css (backup)
└── icons/
    ├── icon.png
    ├── android192x192.png
    └── android512x512.png

functions/
├── index.js                            # Cloud functions (if using)
└── package.json

```

---

## 🐛 Debugging Tips

### Enable Debug Mode

```javascript
// In browser console:
window.DEBUG = true;

// Will show verbose logging
// Already integrated in app.js
```

### View All Logs

```javascript
// Combine all types of logs
const allLogs = [
  ...errorLog,
  ...console.logs  // (if saving them)
];

// Export for analysis
const blob = new Blob([JSON.stringify(allLogs, null, 2)]);
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `yoshop-debug-${Date.now()}.json`;
a.click();
```

### Monitor in Real-Time

```javascript
// Watch health every 10 seconds
setInterval(() => {
  const health = getAppHealthStatus();
  console.clear();
  console.table(health);
  console.log('Cache:', requestCache.size);
  console.log('Errors:', errorLog.length);
}, 10000);
```

---

## 🔄 Common Operations

### Add a New Shop (Admin)

```
1. Open YoShop admin panel
2. Navigate to Admin Shops tab
3. Click "Add New Shop"
4. Enter shop details
5. Wait for user email confirmation
6. Approve when pending
7. Set subscription if needed
```

### Monitor a Shop

```
1. Click Monitor button on shop card
2. View shop's dashboard
3. See real-time transactions
4. Check inventory
5. View analytics
```

### Export Data

```javascript
// Export transactions as CSV
exportTransactionsToCSV()

// Backup all data
backupAllData()

// Export error log
exportErrorLog()

// Generate PDF report
downloadReportPDF()
```

### Test Features

```javascript
// Test notification
testLocalNotification()

// Test barcode scanner
startCameraScan()

// Test payment processing
// (manually process test transaction)
```

---

## 📋 Configuration Files

### Firebase Configuration (firebase.json)

```json
{
  "hosting": {
    "public": ".",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  },
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

### Environment Variables (.env.production)

```env
# Firebase
VITE_FIREBASE_PROJECT_ID=yoshop-b502f
VITE_FIREBASE_DATABASE_NAME=yoshop

# Performance
SYNC_DEBOUNCE_DELAY=200
MIN_SYNC_INTERVAL=500
QUERY_CACHE_TTL=30000

# Features
ENABLE_ERROR_REPORTING=true
ENABLE_HEALTH_CHECKS=true
```

---

## 🎯 Monitoring Dashboard Setup

### Add Monitoring Widget (Optional)

```html
<!-- Add to index.html before </body> -->
<div id="yoshop-monitoring" style="
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: rgba(0,0,0,0.85);
  color: #0f0;
  padding: 10px;
  border-radius: 8px;
  font-family: monospace;
  font-size: 11px;
  max-width: 250px;
  z-index: 10000;
  max-height: 300px;
  overflow-y: auto;
">
  <div style="font-weight: bold; margin-bottom: 5px;">YoShop Monitor</div>
  <div id="yoshop-monitor-content"></div>
</div>

<script>
setInterval(() => {
  const health = getAppHealthStatus();
  const content = `
Health: ${health.status}
Uptime: ${health.uptime}
Errors: ${health.errorRate}
Calls: ${health.firebaseCalls}
Cache: ${health.cacheSize}
  `.trim();
  
  document.getElementById('yoshop-monitor-content').textContent = content;
  
  // Update color based on health
  const elem = document.getElementById('yoshop-monitoring');
  elem.style.color = health.status === 'healthy' ? '#0f0' : '#ff0';
}, 5000);
</script>
```

---

## 📞 Emergency Procedures

### If App is Down

```bash
# 1. Check Firebase status
firebase status

# 2. Check hosting status
firebase hosting:status

# 3. View logs
firebase functions:log

# 4. Rollback immediately
git revert --no-edit HEAD
firebase deploy

# 5. Notify users
# Send announcement via email/in-app
```

### If Database is Compromised

```bash
# 1. IMMEDIATELY disable user
# Firebase Console > Authentication > Select User > Disable

# 2. Check audit logs
# Firebase Console > Cloud Audit Logs

# 3. Restore from backup
# Firebase Console > Firestore > Backups > Restore

# 4. Change admin credentials
# Update app settings
```

### If Performance Degrades

```javascript
// 1. Check metrics
getAppHealthStatus()

// 2. Clear cache if needed
requestCache.clear()

// 3. Check for memory leaks
performance.memory

// 4. Export errors
exportErrorLog()

// 5. Reduce pagination if needed
// Modify SHOPS_PER_PAGE in app.js
```

---

## 🔗 Useful Links

| Resource | URL |
|----------|-----|
| Firebase Console | https://console.firebase.google.com/ |
| Cloud Console | https://console.cloud.google.com/ |
| YoShop Live | https://yoshop-b502f.web.app |
| Firebase Docs | https://firebase.google.com/docs |
| GitHub Repo | https://github.com/sadikkirya1-rgb/Yoshop |
| Web.dev | https://web.dev/ |

---

## ✅ Daily Operations Checklist

### Every Morning

- [ ] Check `getAppHealthStatus()` in console
- [ ] Export and review error log: `exportErrorLog()`
- [ ] Verify Firebase quota usage
- [ ] Check backup completion
- [ ] Review user feedback

### Every Evening

- [ ] Generate daily metrics report
- [ ] Check for critical errors
- [ ] Verify tomorrow's maintenance window
- [ ] Update status dashboard

### Weekly (Friday)

- [ ] Full performance audit
- [ ] Security review
- [ ] Backup verification
- [ ] Team sync meeting
- [ ] Plan next week

---

## 🎓 Learning Resources

### Documentation
- **Setup:** DEPLOYMENT_GUIDE.md
- **Security:** FIREBASE_SECURITY.md
- **Performance:** PERFORMANCE_GUIDE.md
- **Launch:** DEPLOYMENT_CHECKLIST.md

### External Resources
- [Firebase Documentation](https://firebase.google.com/docs)
- [Firestore Security](https://firebase.google.com/docs/firestore/security)
- [Web Performance](https://web.dev/performance/)
- [OWASP Security](https://owasp.org/www-project-top-ten/)

---

## 💡 Pro Tips

1. **Always test on staging first**
   ```bash
   firebase use staging
   firebase deploy
   # Test thoroughly
   firebase use production
   firebase deploy
   ```

2. **Keep error logs handy**
   ```javascript
   // Every morning
   const errors = errorLog.slice(-100);
   console.save(errors, 'daily-errors.json');
   ```

3. **Monitor quotas proactively**
   - Set alerts in Firebase Console
   - Track monthly trends
   - Plan capacity ahead

4. **Use version control**
   - Tag releases: `git tag v1.0.0`
   - Create release notes
   - Keep rollback ready

5. **Automate monitoring**
   - Set up cron jobs
   - Export logs daily
   - Send alerts to Slack

---

## 🎉 You're All Set!

### Quick Start (30 seconds)

```javascript
// Copy to console to verify all is good:
console.log('✅ YoShop Status Check');
console.log('Health:', getAppHealthStatus().status);
console.log('Ready:', requestCache.size > 0 && errorLog.length < 5);
```

---

**Last Updated:** 2026-06-18  
**Quick Reference Version:** 1.0  
**Status:** ✅ Production Ready

---

**Questions?** Check the documentation files or export error logs for debugging!
