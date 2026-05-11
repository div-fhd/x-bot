'use strict';
require('dotenv').config();
const mongoose = require('mongoose');

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const col = db.collection('accounts');

  const map = {
    'نشط':           'active',
    'موقوف':         'suspended',
    'محظور':         'suspended',
    'يحتاج_مصادقة': 'auth_required',
    'نقطة_تحقق':    'locked',
    'غير_نشط':       'dead',
  };

  let total = 0;
  for (const [ar, en] of Object.entries(map)) {
    const r = await col.updateMany({ status: ar }, { $set: { status: en } });
    if (r.modifiedCount > 0) {
      console.log(`${ar} → ${en}: ${r.modifiedCount} accounts`);
      total += r.modifiedCount;
    }
  }
  console.log(`\nTotal migrated: ${total}`);
  await mongoose.disconnect();
}

migrate().catch(console.error);