# WhatsApp Bot Setup Guide

## Prerequisites

Before starting, ensure you have:
- Node.js (v16 or higher)
- MySQL installed and running
- A phone with WhatsApp installed

## Installation Steps

### 1. Install Dependencies

Open PowerShell in the project directory and run:
```powershell
npm install
```

### 2. Setup MySQL Database

#### Install MySQL (if not installed)
Download from: https://dev.mysql.com/downloads/mysql/

#### Create Database
```powershell
# Open MySQL command line or use MySQL Workbench
mysql -u root -p

# Create the database
CREATE DATABASE whatsapp_bot;

# Exit MySQL
exit;
```

### 3. Configure Environment Variables

Edit the `.env` file with your MySQL credentials:
```
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=whatsapp_bot
DB_PORT=3306
NODE_ENV=development
```

**Important:** Replace `your_mysql_password` with your actual MySQL root password.

### 4. Start the Dashboard Server

In one terminal:
```powershell
npm start
```

This will:
- Connect to MySQL
- Create database tables automatically (if they don't exist)
- Start the dashboard at http://localhost:3000

### 5. Start the WhatsApp Bot

In another terminal:
```powershell
npm run bot
```

### 6. Scan QR Code

1. A QR code will appear in the terminal
2. A `qr-code.png` file will be created in the project root
3. Open WhatsApp on your phone
4. Go to: Settings > Linked Devices > Link a Device
5. Scan the QR code displayed in the terminal or from the PNG file
6. Wait for "WhatsApp Bot is Ready!" message

### 7. Access Dashboard

Open your browser and go to:
```
http://localhost:3000
```

## Using the Bot

Send messages to your WhatsApp bot with these commands:

### Commands

- `!task [description]` - Create a new task
  - Example: `!task Review project documentation`

- `!request [description]` - Create a new request
  - Example: `!request Need help with API integration`

- `!list` - Show all your tasks and requests

- `!status` - View your message statistics and sentiment analysis

- `!help` - Display help information

### Features

✅ **Sentiment Analysis**
- Every message is analyzed for sentiment
- View sentiment trends in the dashboard
- Track positive, negative, and neutral messages

✅ **Task & Request Tracking**
- Create tasks and requests via WhatsApp
- Update status from dashboard
- Track completion rates

✅ **Real-time Dashboard**
- Live statistics
- Message history
- Conversation analytics
- Interactive charts

✅ **QR Code Authentication**
- Easy phone linking
- Secure connection
- Session persistence

## Dashboard Features

### Statistics Cards
- Total messages sent/received
- Total tasks created
- Active conversations
- Sentiment percentage

### Charts
- Sentiment distribution (pie chart)
- Task status breakdown (bar chart)

### Tasks Section
- Filter by status (All, Pending, In Progress, Completed)
- Update task status directly
- View task details and metadata

### Messages Section
- Recent messages with sentiment labels
- Color-coded by sentiment
- Timestamps and user info

### Conversations Section
- All active conversations
- Message counts
- Task/request statistics per conversation
- Overall sentiment per user

## Troubleshooting

### Bot won't connect
- Ensure MySQL is running
- Check database credentials in `.env`
- Verify port 3000 is available
- Ensure WhatsApp is properly linked

### Database connection errors
```powershell
# Check if MySQL is running
Get-Service MySQL*

# Start MySQL if stopped
net start MySQL80
```

### QR code not appearing
- Close the bot (Ctrl+C)
- Delete `.wwebjs_auth` folder
- Restart the bot

### Dashboard not loading data
- Verify the server is running on port 3000
- Check browser console for errors
- Ensure MySQL connection is successful
- Check if tables were created in MySQL

### Dependencies installation fails
- Update Node.js to latest LTS version
- Clear npm cache: `npm cache clean --force`
- Delete `node_modules` and `package-lock.json`
- Run `npm install` again

### MySQL authentication errors
- Verify your MySQL password in `.env`
- Check MySQL user permissions:
```sql
GRANT ALL PRIVILEGES ON whatsapp_bot.* TO 'root'@'localhost';
FLUSH PRIVILEGES;
```

## Database

The bot uses MySQL with three tables:

1. **messages** - Stores all messages with sentiment analysis
2. **tasks** - Tracks tasks and requests
3. **conversations** - Aggregates conversation statistics

Tables are automatically created when you first start the server.

## Development

### Project Structure
```
whatsapp-bot-dashboard/
├── src/
│   ├── bot.js              # WhatsApp bot main file
│   ├── server.js           # Express server & API
│   ├── config/
│   │   └── database.js     # MongoDB connection
│   ├── models/             # Mongoose models
│   │   ├── Message.js
│   │   ├── Task.js
│   │   └── Conversation.js
│   ├── services/           # Business logic
│   │   └── messageService.js
│   └── utils/              # Utilities
│       ├── sentiment.js
│       └── commands.js
├── public/                 # Dashboard frontend
│   ├── index.html
│   ├── css/a managed MySQL service for production
- Implement authentication for dashboard in production
- Use HTTPS in production
- Regular database backups recommended
│   └── js/
│       └── app.js
├── package.json
└── .env                    # Configuration
```

### Running in Development

Use nodemon for auto-restart:
```powershell
npm install -g nodemon
npm run dev
```

## Security Notes

- Keep your `.env` file secure
- Don't commit `.wwebjs_auth` folder
- Use environment variables for sensitive data
- Consider using MongoDB Atlas for production
- Implement authentication for dashboard in production

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review terminal logs for errors
3. Verify all prerequisites are met
4. Ensure WhatsApp Web is working in browser

## License

MIT License - Feel free to modify and use as needed
