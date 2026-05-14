const Sentiment = require('sentiment');
const sentiment = new Sentiment();

const ROMAN_URDU_LABELS = {
  // Positive
  'acha': 3, 'accha': 3, 'acha ha': 3, 'bohat acha': 5, 'bahut acha': 5,
  'zabardast': 5, 'shandar': 5, 'behtareen': 5, 'best': 4, 'perfect': 4,
  'shukriya': 3, 'shukria': 3, 'thanks': 3, 'thankyou': 3,
  'pasand': 3, 'khushi': 4, 'khush': 4, 'mast': 3, 'badhiya': 4,
  'excellent': 5, 'outstanding': 5, 'superb': 5, 'great': 4,
  'helpful': 3, 'satisfied': 4, 'love': 5, 'amazing': 5, 'awesome': 5,
  'wah': 3, 'waah': 3, 'zindabad': 4, 'umda': 3,
  // Negative
  'bekar': -4, 'bakwaas': -4, 'ganda': -3, 'bura': -3,
  'mushkil': -2, 'problem': -2, 'issue': -2, 'error': -2,
  'nahi': -1, 'nhi': -1, 'nahin': -1, 'na': -1,
  'pareshan': -3, 'takleef': -3, 'dukh': -3, 'bura laga': -4,
  'complaint': -3, 'complain': -3, 'worst': -5, 'terrible': -5,
  'disappointed': -4, 'frustrating': -4, 'slow': -2, 'late': -2,
  'refund': -3, 'cancel': -2, 'wrong': -3, 'mistake': -3,
  'angry': -4, 'upset': -3, 'sad': -3, 'unhappy': -4
};

// Register Roman Urdu / Urdu common words
sentiment.registerLanguage('roman-urdu', {
  labels: ROMAN_URDU_LABELS
});

// Get all sentiment labels for keyword matching
const getAllSentimentLabels = () => {
  return ROMAN_URDU_LABELS;
};

/**
 * Extract top sentiment keywords from analysis
 * @param {Array} tokens - All tokens from sentiment analysis
 * @param {Object} sentimentLabels - Sentiment labels configuration
 * @returns {Array} Top keywords with sentiment scores
 */
const extractTopKeywords = (tokens, sentimentLabels) => {
  const keywordMap = {};

  tokens.forEach(token => {
    if (sentimentLabels[token]) {
      keywordMap[token] = sentimentLabels[token];
    }
  });

  // Return top 5 keywords sorted by absolute sentiment value
  return Object.entries(keywordMap)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
    .map(([keyword, score]) => ({
      keyword,
      sentiment: score > 0 ? 'positive' : 'negative',
      score: Math.abs(score)
    }));
};

/**
 * Analyze sentiment of text
 * @param {string} text - Text to analyze
 * @returns {Object} Sentiment analysis result with top keywords
 */
const analyzeSentiment = (text) => {
  const lowerText = text.toLowerCase();

  // Run both English and Roman Urdu analysis, pick stronger result
  const resultEn = sentiment.analyze(lowerText);
  const resultRU = sentiment.analyze(lowerText, { language: 'roman-urdu' });

  // Use whichever has a stronger (non-zero) comparative score
  const result = Math.abs(resultRU.comparative) >= Math.abs(resultEn.comparative)
    ? resultRU
    : resultEn;

  let label = 'neutral';
  if (result.comparative > 0.2) {
    label = 'positive';
  } else if (result.comparative < -0.2) {
    label = 'negative';
  }

  // Extract top keywords with professional formatting
  const topKeywords = extractTopKeywords(result.tokens, ROMAN_URDU_LABELS);
  
  return {
    score: result.score,
    comparative: result.comparative,
    label: label,
    topKeywords: topKeywords,
    totalTokens: result.tokens.length
  };
};

module.exports = { analyzeSentiment, getAllSentimentLabels, extractTopKeywords };
