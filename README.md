# WhatsApp Bot Dashboard

A comprehensive WhatsApp chatbot with sentiment analysis, task tracking, and real-time dashboard.

## Features

- 📱 WhatsApp Integration with QR Code Authentication
- 😊 Sentiment Analysis on Messages
- ✅ Task & Request Tracking
- 📊 Real-time Dashboard
- 💾 MySQL Database
- 🔄 Live Updates via WebSocket

## Installation

1. Install dependencies:
```bash
npm install
```

2. Set up MySQL database:
```sql
CREATE DATABASE whatsapp_bot;
```

3. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

Edit `.env` with your MySQL credentials:
```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=whatsapp_bot
DB_PORT=3306
```

4. Start the server:
```bash
npm start
```

5. Start the bot:
```bash
npm run bot
```

## Usage

1. Run the bot - a QR code will be displayed
2. Scan the QR code with WhatsApp on your phone
3. Access the dashboard at http://localhost:3000
4. Chat with the bot on WhatsApp
ySQL + Sequeliz
## Bot Commands

- `!task [description]` - Create a new task
- `!request [description]` - Create a new request
- `!list` - List all tasks/requests
- `!status` - Get sentiment statistics
- `!help` - Show help message

## Tech Stack

- Node.js + Express
- MongoDB + Mongoose
- whatsapp-web.js
- Socket.IO
- Sentiment Analysis
- Chart.js (Dashboard)
