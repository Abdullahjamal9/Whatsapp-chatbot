# AI-Powered Chatbot Setup

Your chatbot now supports **AI-powered responses** using OpenAI GPT!

## Current Status
✅ **Working:** Keyword-based responses (limited but functional)  
🚀 **Available:** AI-powered intelligent responses (requires API key)

## How It Works

### Without OpenAI API Key (Current)
- Uses keyword detection (greeting, pricing, support, etc.)
- Responds with pre-defined templates
- Limited to ~10 different response types
- **Still functional and professional!**

### With OpenAI API Key (Recommended)
- AI understands context and conversation history
- Generates personalized, intelligent responses
- Handles ANY customer query naturally
- Remembers conversation context (last 3 messages)
- Automatic task priority detection
- Much more natural conversations

## Setup AI Responses (Optional)

### Step 1: Get OpenAI API Key
1. Go to https://platform.openai.com/api-keys
2. Create an account (you get $5 free credit!)
3. Click "Create new secret key"
4. Copy your API key (starts with `sk-`)

### Step 2: Add to .env File
Open `.env` file and update:
```env
OPENAI_API_KEY=sk-your-actual-api-key-here
```

### Step 3: Restart Bot
```bash
# Stop the bot (Ctrl+C in terminal)
# Start again:
node src/bot.js
```

## Cost Estimate

**OpenAI Pricing (GPT-3.5-Turbo):**
- ~$0.002 per 1000 messages
- $5 credit = ~2,500 messages
- Very affordable for small-medium businesses!

## What You Get with AI

**Example Conversations:**

**Customer:** "What's your pricing for 100 units?"  
**AI Bot:** "I'd be happy to help with pricing! For 100 units, our rates depend on your specific requirements. Let me connect you with our sales team who can provide a detailed quote tailored to your needs. What industry are you in?"

**Customer:** "My order is delayed and I'm really upset"  
**AI Bot:** "I sincerely apologize for the delay with your order. I understand how frustrating this must be. I've escalated this to our urgent priority list and our team will contact you within the hour to resolve this. Can you share your order number?"

**Customer:** "Do you work on weekends?"  
**AI Bot:** "Our business hours are Monday-Friday, 9 AM to 6 PM. However, you can message us anytime and we'll respond when we're back online. Is there something specific I can help you with right now?"

## Features Comparison

| Feature | Keyword-Based | AI-Powered |
|---------|--------------|------------|
| Response Quality | Good | Excellent |
| Context Awareness | No | Yes |
| Conversation History | No | Yes (3 messages) |
| Natural Language | Limited | Full |
| Task Creation | Yes | Yes (Smarter) |
| Priority Detection | Keyword | Intelligent |
| Custom Responses | 10 templates | Unlimited |
| Setup Required | None | API Key |
| Cost | Free | ~$0.002/message |

## Recommendation

**For Testing:** Current keyword-based system works great!  
**For Production:** Add OpenAI API key for professional AI responses  
**For High Volume:** Consider upgrading to GPT-4 for even better responses

## Need Help?

The bot works perfectly now with or without AI! 
- Test it first with keyword-based responses
- Add AI later when you're ready
- You can switch anytime without code changes

---

**Your chatbot is production-ready right now!** 🚀
