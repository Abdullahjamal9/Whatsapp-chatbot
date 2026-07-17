const CURATED_KEYWORD_DICTIONARY = [
  // Sales / Revenue Intent
  { keyword: 'price', category: 'sales_intent', sentiment: 'neutral', aliases: ['rate', 'cost', 'charges', 'pricing', 'quotation', 'quote', 'kitne ka', 'price kya', 'rate kya'] },
  { keyword: 'order', category: 'sales_intent', sentiment: 'positive', aliases: ['book', 'booking', 'purchase', 'buy', 'place order', 'order karna'] },
  { keyword: 'package', category: 'sales_intent', sentiment: 'neutral', aliases: ['plan', 'bundle', 'subscription plan'] },
  { keyword: 'discount', category: 'sales_intent', sentiment: 'positive', aliases: ['offer', 'deal', 'promo', 'promotion', 'special price'] },
  { keyword: 'payment', category: 'sales_intent', sentiment: 'neutral', aliases: ['pay', 'paid', 'transaction', 'invoice', 'bill'] },

  // Service Quality / Performance
  { keyword: 'fast', category: 'service_quality', sentiment: 'positive', aliases: ['quick', 'instant', 'jaldi', 'speed'] },
  { keyword: 'slow', category: 'service_quality', sentiment: 'negative', aliases: ['delay', 'late', 'sluggish', 'der'] },
  { keyword: 'professional', category: 'service_quality', sentiment: 'positive', aliases: ['expert', 'trained', 'qualified'] },
  { keyword: 'helpful', category: 'service_quality', sentiment: 'positive', aliases: ['supportive', 'cooperative'] },
  { keyword: 'quality', category: 'service_quality', sentiment: 'neutral', aliases: ['standard', 'performance'] },

  // Support / Complaint
  { keyword: 'issue', category: 'support_complaint', sentiment: 'negative', aliases: ['problem', 'masla', 'trouble', 'difficulty'] },
  { keyword: 'error', category: 'support_complaint', sentiment: 'negative', aliases: ['bug', 'fault', 'mistake'] },
  { keyword: 'complaint', category: 'support_complaint', sentiment: 'negative', aliases: ['complain', 'bad service', 'report issue'] },
  { keyword: 'not working', category: 'support_complaint', sentiment: 'negative', aliases: ['failed', 'broken', 'kaam nahi kar raha', 'service down', 'server down', 'site down', 'system down', 'service is down', 'server is down', 'site is down', 'system is down', 'website is down', 'app is down'] },
  { keyword: 'refund', category: 'support_complaint', sentiment: 'negative', aliases: ['money back', 'return payment'] },
  { keyword: 'cancel', category: 'support_complaint', sentiment: 'negative', aliases: ['cancelled', 'terminate', 'close account', 'band karo'] },

  // Retention / Churn Risk
  { keyword: 'unhappy', category: 'churn_risk', sentiment: 'negative', aliases: ['unsatisfied', 'disappointed', 'naraaz'] },
  { keyword: 'switch', category: 'churn_risk', sentiment: 'negative', aliases: ['change provider', 'move service', 'competitor'] },
  { keyword: 'unsubscribe', category: 'churn_risk', sentiment: 'negative', aliases: ['stop service', 'opt out'] },
  { keyword: 'worst', category: 'churn_risk', sentiment: 'negative', aliases: ['terrible', 'awful', 'bad experience'] },

  // Trust / Loyalty
  { keyword: 'thank you', category: 'loyalty_signal', sentiment: 'positive', aliases: ['thanks', 'shukriya', 'shukria'] },
  { keyword: 'satisfied', category: 'loyalty_signal', sentiment: 'positive', aliases: ['happy', 'khush'] },
  { keyword: 'recommend', category: 'loyalty_signal', sentiment: 'positive', aliases: ['refer', 'suggest'] },
  { keyword: 'trust', category: 'loyalty_signal', sentiment: 'positive', aliases: ['reliable', 'dependable'] },
  { keyword: 'excellent', category: 'loyalty_signal', sentiment: 'positive', aliases: ['amazing', 'great', 'awesome', 'behtareen', 'zabardast'] }
];

function normalizeText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const idx = haystack.indexOf(needle, start);
    if (idx === -1) break;
    count++;
    start = idx + needle.length;
  }
  return count;
}

function getKeywordDictionary() {
  return CURATED_KEYWORD_DICTIONARY;
}

function findDictionaryTerm(query = '') {
  const q = normalizeText(query);
  if (!q) return null;

  return CURATED_KEYWORD_DICTIONARY.find(term => {
    if (normalizeText(term.keyword) === q) return true;
    return (term.aliases || []).some(a => normalizeText(a) === q);
  }) || null;
}

function matchDictionaryTermsInText(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const haystack = ` ${normalized} `;
  const matches = [];

  CURATED_KEYWORD_DICTIONARY.forEach(term => {
    const variants = [term.keyword, ...(term.aliases || [])]
      .map(v => normalizeText(v))
      .filter(Boolean);

    const uniqueVariants = [...new Set(variants)];
    uniqueVariants.forEach(v => {
      const needle = ` ${v} `;
      const variantCount = countOccurrences(haystack, needle);
      if (variantCount > 0) {
        matches.push({
          keyword: term.keyword,
          matchedVariant: v,
          category: term.category,
          sentiment: term.sentiment,
          count: variantCount
        });
      }
    });
  });

  return matches;
}

module.exports = {
  getKeywordDictionary,
  findDictionaryTerm,
  matchDictionaryTermsInText,
  normalizeText
};
