# Bot Commands Reference

## Available Commands

### 📝 Task Management

#### Create a Task
```
!task [description]
```
**Example:**
```
!task Review project documentation
!task Call client tomorrow
!task Complete the report
```

#### Create a Request
```
!request [description]
```
**Example:**
```
!request Need help with API integration
!request Can you review my code?
!request Information about pricing
```

### 📋 View Information

#### List All Tasks/Requests
```
!list
```
Shows all your tasks and requests with their current status.

#### View Statistics
```
!status
```
Displays:
- Total messages sent
- Number of tasks
- Number of requests
- Sentiment analysis breakdown
- Overall sentiment rating

#### Get Help
```
!help
```
Shows available commands and features.

## 🎯 Features

### Automatic Sentiment Analysis
Every message you send is automatically analyzed for sentiment:
- **😊 Positive** - Happy, satisfied messages
- **😐 Neutral** - Informational messages
- **😔 Negative** - Unhappy, frustrated messages

### Real-time Tracking
- All messages are saved to database
- Tasks can be updated from dashboard
- Live statistics and charts
- Conversation history

## 📊 Dashboard Features

### View and Manage Tasks
1. Open dashboard at http://localhost:3000
2. Filter tasks by status (All, Pending, In Progress, Completed)
3. Update task status directly from dashboard
4. View task creation time and details

### Monitor Sentiment
- Pie chart showing sentiment distribution
- Timeline of sentiment trends
- Per-conversation sentiment averages

### Track Conversations
- See all active conversations
- Message counts per contact
- Task/request statistics per user
- Overall sentiment indicators

## 💡 Tips

1. **Be Specific**: When creating tasks, include all details
   ```
   ✅ !task Call John at 3pm to discuss Q1 report
   ❌ !task Call John
   ```

2. **Use Requests for Questions**: Use requests when you need something from someone
   ```
   !request Can you send me the latest sales figures?
   ```

3. **Check Status Regularly**: Use `!status` to see your sentiment trends
   ```
   !status
   ```

4. **List Before Creating**: Check existing tasks before creating duplicates
   ```
   !list
   ```

## 🔔 Bot Responses

The bot will respond with:
- ✅ Confirmation when tasks/requests are created
- 📋 List of all your items when you use !list
- 📊 Detailed statistics with !status
- ❌ Error messages if something goes wrong
- 🤖 Help information with !help

## 📱 Example Conversation

```
You: !help
Bot: 🤖 WhatsApp Bot Help
     Commands:
     !task [description] - Create a task
     !request [description] - Create a request
     ...

You: !task Finish project presentation
Bot: ✅ Task created successfully!
     Task: Finish project presentation
     Status: Pending

You: !list
Bot: 📋 Your Tasks & Requests
     1. ✓ Finish project presentation
        ⏸️ pending

You: !status
Bot: 📊 Your Statistics
     Messages: 5
     Tasks: 1
     Requests: 0
     
     Sentiment Analysis:
     😊 Positive: 3 (60.0%)
     😐 Neutral: 2 (40.0%)
     😔 Negative: 0 (0.0%)
     
     Overall: 😊 Positive
```

## 🎨 Command Format Rules

- Commands must start with `!`
- Case-insensitive (`!TASK` and `!task` both work)
- Space required after command name
- Description is everything after the space

## ⚡ Advanced Usage

### Bulk Operations
Create multiple tasks by sending multiple messages:
```
!task Task 1
!task Task 2
!task Task 3
```

### Dashboard Updates
- Change task status in dashboard
- Updates reflect immediately
- Bot doesn't notify of dashboard changes (view only)

### Conversation Analytics
Each conversation tracks:
- Message count
- Average sentiment
- Task/request counts
- Last message timestamp

## 🔒 Privacy

- All data stored locally in MongoDB
- No data sent to external servers
- Messages encrypted by WhatsApp
- Dashboard only accessible on localhost

## 📈 Metrics Tracked

For each message:
- Sender information
- Message content
- Timestamp
- Sentiment score
- Sentiment label
- Whether it's a command

For each task/request:
- Description
- Creator
- Status (pending/in-progress/completed/cancelled)
- Type (task/request)
- Creation timestamp
- Completion timestamp (if completed)

For each conversation:
- Contact name/number
- Total messages
- Last message time
- Average sentiment
- Sentiment breakdown
- Task/request counts
