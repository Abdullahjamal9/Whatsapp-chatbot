/**
 * Process bot commands
 */
const processCommand = async (msg, client, messageService) => {
  const body = msg.body.toLowerCase();
  const contact = await msg.getContact();
  const from = msg.from;
  const fromName = contact.pushname || contact.name || from;
  
  try {
    if (body.startsWith('!task ')) {
      // Create task
      const description = msg.body.substring(6).trim();
      if (description) {
        const task = await messageService.createTask(from, fromName, description, 'task');
        if (task) {
          await msg.reply(`✅ Task created successfully!\n\nTask: ${description}\nStatus: Pending\n\nUse !list to see all tasks.`);
        } else {
          await msg.reply('❌ Task description clear nahi hai.\nPlease add a meaningful description (at least 2 words).\nExample: !task client ko quotation bhejni hai');
        }
      } else {
        await msg.reply('❌ Please provide a task description.\nUsage: !task [description]');
      }
    } 
    else if (body.startsWith('!request ')) {
      // Create request
      const description = msg.body.substring(9).trim();
      if (description) {
        const request = await messageService.createTask(from, fromName, description, 'request');
        if (request) {
          await msg.reply(`✅ Request created successfully!\n\nRequest: ${description}\nStatus: Pending\n\nUse !list to see all requests.`);
        } else {
          await msg.reply('❌ Request description clear nahi hai.\nPlease add a meaningful description (at least 2 words).\nExample: !request kal 3 baje follow-up call karni hai');
        }
      } else {
        await msg.reply('❌ Please provide a request description.\nUsage: !request [description]');
      }
    }
    else if (body === '!list') {
      // List tasks and requests
      const tasks = await messageService.getUserTasks(from);
      if (tasks.length > 0) {
        let response = `📋 *Your Tasks & Requests*\n\n`;
        tasks.forEach((task, index) => {
          const icon = task.type === 'task' ? '✓' : '📝';
          const status = task.status === 'completed' ? '✅' : 
                        task.status === 'in-progress' ? '⏳' : '⏸️';
          response += `${index + 1}. ${icon} ${task.description}\n   ${status} ${task.status}\n\n`;
        });
        await msg.reply(response);
      } else {
        await msg.reply('📋 No tasks or requests found.\n\nCreate one with:\n!task [description]\n!request [description]');
      }
    }
    else if (body === '!status') {
      // Get sentiment statistics
      const Conversation = require('../models/Conversation');
      const conversation = await Conversation.findOne({ where: { phoneNumber: from } });
      
      if (conversation) {
        const total = conversation.messageCount;
        const positive = conversation.sentimentPositive || 0;
        const negative = conversation.sentimentNegative || 0;
        const neutral = conversation.sentimentNeutral || 0;
        const sentiment = conversation.averageSentiment > 0 ? '😊 Positive' :
                         conversation.averageSentiment < 0 ? '😔 Negative' : '😐 Neutral';
        
        const response = `📊 *Your Statistics*\n\n` +
                        `Messages: ${total}\n` +
                        `Tasks: ${conversation.taskCount}\n` +
                        `Requests: ${conversation.requestCount}\n\n` +
                        `*Sentiment Analysis:*\n` +
                        `😊 Positive: ${positive} (${total > 0 ? ((positive/total)*100).toFixed(1) : 0}%)\n` +
                        `😐 Neutral: ${neutral} (${total > 0 ? ((neutral/total)*100).toFixed(1) : 0}%)\n` +
                        `😔 Negative: ${negative} (${total > 0 ? ((negative/total)*100).toFixed(1) : 0}%)\n\n` +
                        `Overall: ${sentiment}`;
        
        await msg.reply(response);
      } else {
        await msg.reply('📊 No statistics available yet.');
      }
    }
    else if (body === '!help') {
      // Show help
      const helpText = `🤖 *WhatsApp Bot Help*\n\n` +
                      `*Commands:*\n` +
                      `!task [description] - Create a task\n` +
                      `!request [description] - Create a request\n` +
                      `!list - Show all tasks/requests\n` +
                      `!status - Show your statistics\n` +
                      `!help - Show this help message\n\n` +
                      `*Features:*\n` +
                      `• Sentiment analysis on messages\n` +
                      `• Task & request tracking\n` +
                      `• Real-time dashboard\n` +
                      `• Statistics and reports`;
      
      await msg.reply(helpText);
    }
  } catch (error) {
    console.error('Error processing command:', error);
    await msg.reply('❌ An error occurred. Please try again later.');
  }
};

module.exports = { processCommand };
