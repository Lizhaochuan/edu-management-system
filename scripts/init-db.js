// scripts/init-db.js
const fs = require('fs');
const path = require('path');

// Mock wx environment if running under Node.js
if (typeof wx === 'undefined') {
  global.wx = {
    _storage: {},
    getStorageSync(key) {
      return this._storage[key] || null;
    },
    setStorageSync(key, val) {
      this._storage[key] = val;
    }
  };
}
if (typeof getApp === 'undefined') {
  global.getApp = () => ({
    globalData: {
      currentUser: { id: 'u_sa1', name: '张校长(创始人)', role: 'super_admin' }
    }
  });
}

const db = require('../services/db');
db.initDatabase(true);

const seedData = {};
Object.values(db.TABLES).forEach(tableName => {
  seedData[tableName] = db.getTable(tableName) || [];
});

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbFilePath = path.join(dataDir, 'db.json');
fs.writeFileSync(dbFilePath, JSON.stringify(seedData, null, 2), 'utf8');
console.log(`Database initialized successfully at ${dbFilePath}`);
console.log(`Tables initialized: ${Object.keys(seedData).length}`);
