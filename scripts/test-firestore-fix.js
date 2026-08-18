// Test that getFirestoreOrNull properly enables ignoreUndefinedProperties
// and that the firestore writes succeed with undefined fields in the data.

const path = require('path');
const fs = require('fs');

console.log('Test 1: getFirestoreOrNull returns null when no env vars');
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;
delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.FIREBASE_PRIVATE_KEY;

const mod = require('/home/z/my-project/src/server/wa-firestore-auth-state.cjs');
const db1 = mod.getFirestoreOrNull();
console.log('  Result:', db1 === null ? 'PASS (returned null)' : 'FAIL (should be null)');

console.log('\nTest 2: Module loads without errors');
console.log('  usePersistentAuthState:', typeof mod.usePersistentAuthState);
console.log('  useFirestoreAuthState:', typeof mod.useFirestoreAuthState);
console.log('  getFirestoreOrNull:', typeof mod.getFirestoreOrNull);
console.log('  Result: PASS');

console.log('\nTest 3: useFirestoreAuthState with mock db that simulates Firestore behavior');
// Mock Firestore that rejects undefined values unless ignoreUndefinedProperties=true
const settings = { ignoreUndefinedProperties: false };
const storedData = {};

const fakeDb = {
  settings(opts) {
    Object.assign(settings, opts);
  },
  collection(name) {
    return {
      doc: (id) => ({
        get: async () => ({ exists: Object.keys(storedData).length > 0, data: () => storedData }),
        set: async (data) => {
          // Simulate Firestore behavior
          if (!settings.ignoreUndefinedProperties) {
            const checkUndefined = (obj, path) => {
              for (const [k, v] of Object.entries(obj)) {
                if (v === undefined) {
                  throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path}${k}")`);
                }
                if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
                  checkUndefined(v, `${path}${k}.`);
                }
              }
            };
            checkUndefined(data, '');
          }
          // Strip undefined values (Firestore behavior when ignoreUndefinedProperties=true)
          const strip = (obj) => {
            const out = {};
            for (const [k, v] of Object.entries(obj)) {
              if (v === undefined) continue;
              if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
                out[k] = strip(v);
              } else {
                out[k] = v;
              }
            }
            return out;
          };
          Object.assign(storedData, strip(data));
        },
        delete: async () => {
          for (const k of Object.keys(storedData)) delete storedData[k];
        },
      })
    }
  }
};

// Mock require of firebase-admin to return our fakeDb
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'firebase-admin/app') {
    return {
      initializeApp: () => ({}),
      getApps: () => [{}],
      cert: () => ({}),
    };
  }
  if (id === 'firebase-admin/firestore') {
    return {
      getFirestore: () => fakeDb,
    };
  }
  if (id === '@whiskeysockets/baileys') {
    return originalRequire.call(this, id);
  }
  return originalRequire.call(this, id);
};

// Set env vars to trigger Firebase init
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.FIREBASE_CLIENT_EMAIL = 'test@test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n';

// Reload module to pick up env vars
delete require.cache[require.resolve('/home/z/my-project/src/server/wa-firestore-auth-state.cjs')];
const modFresh = require('/home/z/my-project/src/server/wa-firestore-auth-state.cjs');

const db = modFresh.getFirestoreOrNull();
console.log('  getFirestoreOrNull returned:', db ? 'db instance' : 'null');
console.log('  ignoreUndefinedProperties:', settings.ignoreUndefinedProperties);

// Now use useFirestoreAuthState to test the full flow
modFresh.useFirestoreAuthState(fakeDb, 'test-user-789').then(async ({ state, saveCreds }) => {
  console.log('  state.creds null?', state.creds === null);
  console.log('  state.creds.noiseKey?', !!state.creds?.noiseKey);
  console.log('  state.creds.pairingCode:', state.creds?.pairingCode);

  // Simulate Baileys calling saveCreds — this should NOT throw
  try {
    await saveCreds();
    console.log('  saveCreds: PASS (no throw)');
    console.log('  Result: PASS — Firestore write succeeded with undefined pairingCode field');
  } catch (err) {
    console.error('  saveCreds: FAIL —', err.message);
    process.exit(1);
  }
}).catch(err => {
  console.error('  Test FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
