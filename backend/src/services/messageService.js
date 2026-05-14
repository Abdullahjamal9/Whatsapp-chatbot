const Message = require('../models/Message');
const Task = require('../models/Task');
const Conversation = require('../models/Conversation');
const { analyzeSentiment } = require('../utils/sentiment');

const isValidTaskDescription = (description = '') => {
  const text = String(description || '').trim();
  if (text.length < 8) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 2;
};

/**
 * Save message to database with sentiment analysis
 */
const saveMessage = async (msg, recipientNumber = null) => {
  try {
    const contact = await msg.getContact();
    const from = msg.from;
    const body = msg.body;
    
    // For outgoing messages (fromMe = true), 'to' should be the recipient
    // For incoming messages, 'to' is null (or could be the bot's number)
    const to = msg.fromMe ? recipientNumber : null;
    
    // Analyze sentiment
    const sentimentResult = analyzeSentiment(body);
    
    // Check if it's a command
    const isCommand = body.startsWith('!');
    
    const serializedMessageId = msg?.id?._serialized || msg?.id?.id || String(msg?.id || `${from}-${msg.timestamp}`);

    // Save message (findOrCreate prevents duplicate errors on bot restart)
    const [message, created] = await Message.findOrCreate({
      where: { messageId: serializedMessageId },
      defaults: {
        messageId: serializedMessageId,
        from: from,
        to: to,
        fromName: contact.pushname || contact.name || from,
        body: body,
        sentimentScore: sentimentResult.score,
        sentimentComparative: sentimentResult.comparative,
        sentimentLabel: sentimentResult.label,
        sentimentTokens: sentimentResult.tokens,
        topKeywords: sentimentResult.topKeywords,
        isCommand: isCommand,
        timestamp: new Date(msg.timestamp * 1000)
      }
    });
    if (!created) {
      return { message, created: false };
    }
    
    // Update conversation
    await updateConversation(from, contact.pushname || contact.name, sentimentResult);
    
    return { message, created: true };
  } catch (error) {
    console.error('Error saving message:', error);
    return { message: null, created: false };
  }
};

/**
 * Update conversation statistics
 */
const updateConversation = async (phoneNumber, name, sentimentResult) => {
  try {
    const conversation = await Conversation.findOne({ where: { phoneNumber } });
    
    if (conversation) {
      conversation.messageCount += 1;
      conversation.lastMessageAt = new Date();
      conversation.name = name || conversation.name;
      
      // Update sentiment stats
      if (sentimentResult.label === 'positive') {
        conversation.sentimentPositive += 1;
      } else if (sentimentResult.label === 'negative') {
        conversation.sentimentNegative += 1;
      } else {
        conversation.sentimentNeutral += 1;
      }
      
      // Calculate average sentiment
      const total = conversation.sentimentPositive + 
                   conversation.sentimentNegative + 
                   conversation.sentimentNeutral;
      const weightedSum = (conversation.sentimentPositive * 1) + 
                         (conversation.sentimentNegative * -1);
      conversation.averageSentiment = total > 0 ? weightedSum / total : 0;
      
      await conversation.save();
    } else {
      // Create new conversation
      const sentimentStats = {
        sentimentPositive: sentimentResult.label === 'positive' ? 1 : 0,
        sentimentNegative: sentimentResult.label === 'negative' ? 1 : 0,
        sentimentNeutral: sentimentResult.label === 'neutral' ? 1 : 0
      };
      
      await Conversation.create({
        phoneNumber,
        name,
        messageCount: 1,
        lastMessageAt: new Date(),
        averageSentiment: sentimentResult.label === 'positive' ? 1 : 
                         sentimentResult.label === 'negative' ? -1 : 0,
        ...sentimentStats
      });
    }
  } catch (error) {
    console.error('Error updating conversation:', error);
  }
};

/**
 * Create a task or request
 */
const createTask = async (from, fromName, description, type = 'task') => {
  try {
    if (!isValidTaskDescription(description)) {
      return null;
    }

    const task = await Task.create({
      description,
      from,
      fromName,
      type,
      status: 'pending'
    });
    
    // Update conversation task/request count
    const conversation = await Conversation.findOne({ where: { phoneNumber: from } });
    if (conversation) {
      if (type === 'task') {
        conversation.taskCount += 1;
      } else {
        conversation.requestCount += 1;
      }
      await conversation.save();
    }
    
    return task;
  } catch (error) {
    console.error('Error creating task:', error);
    return null;
  }
};

/**
 * Get tasks for a user
 */
const getUserTasks = async (from) => {
  try {
    const tasks = await Task.findAll({ 
      where: { from },
      order: [['createdAt', 'DESC']]
    });
    return tasks;
  } catch (error) {
    console.error('Error getting tasks:', error);
    return [];
  }
};

module.exports = {
  saveMessage,
  updateConversation,
  createTask,
  getUserTasks
};
