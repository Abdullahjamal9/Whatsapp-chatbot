/**
 * One-off backfill: re-compute `top_keywords` for existing messages using the
 * curated business dictionary, so old chats show the same meaningful keyword
 * tags as new ones.
 *
 * Run once:  node src/scripts/backfillKeywords.js
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const Message = require('../models/Message');
const { analyzeSentiment } = require('../utils/sentiment');

(async () => {
  try {
    await sequelize.authenticate();
    console.log('MySQL Connected — starting keyword backfill...');

    const messages = await Message.findAll({ attributes: ['id', 'body'] });
    console.log(`Found ${messages.length} messages to re-process.`);

    let updated = 0;
    for (const msg of messages) {
      const { topKeywords } = analyzeSentiment(msg.body || '');
      msg.topKeywords = topKeywords; // model setter JSON-stringifies this
      await msg.save({ fields: ['topKeywords'] });
      updated += 1;
      if (updated % 200 === 0) console.log(`  ...${updated} done`);
    }

    console.log(`✅ Backfill complete — updated ${updated} messages.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Backfill failed:', err.message);
    process.exit(1);
  }
})();
