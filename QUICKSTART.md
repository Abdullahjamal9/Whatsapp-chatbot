# Quick Start Guide

## 🚀 Quick Start (3 Steps)

### Step 1: Start MySQL
```powershell
# Make sure MySQL is running
# If installed as service:
net start MySQL80

# Or check if it's running:
Get-Service MySQL*
```

### Step 2: Create Database
```powershell
# Connect to MySQL and create database
mysql -u root -p
# Then run:
CREATE DATABASE whatsapp_bot;
exit;
```

### Step 3: Configure Database Connection
Edit `.env` file and set your MySQL credentials:
```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=whatsapp_bot
DB_PORT=3306
```

### Step 4: Install Dependencies
```powershell
npm install
```

### Step 5: Start the Dashboard
```powershell
npm start
```
The dashboard will be available at: http://localhost:3000
Tables will be created automatically!

### Step 6: Start the WhatsApp Bot
Open **another** PowerShell terminal:
```powershell
npm run bot
```

### Step 7: Scan QR Code
1. A QR code will appear in the terminal
2. Open WhatsApp on your phone
3. Go to: **Settings > Linked Devices > Link a Device**
4. Scan the QR code
5. Wait for "WhatsApp Bot is Ready!" message

## 📱 Testing the Bot

Send these commands to your bot on WhatsApp:

```
!help
!task Buy groceries
!request Help with coding
!list
!status
```

## 🎯 What's Included

✅ **WhatsApp Bot** with QR code authentication  
✅ **Sentiment Analysis** on all messages  
✅ **Task & Request Tracking**  
✅ **Real-time Dashboard** with charts  
✅ **MySQL Database** for data persistence  
✅ **WebSocket** for live updates  

## 📊 Dashboard URL
```
http://localhost:3000
```

## 🛠️ Troubleshooting

**MySQL not installed?**
Download from: https://dev.mysql.com/downloads/mysql/

**Database connection error?**
Check credentials in `.env` file and ensure MySQL is running

**Port 3000 already in use?**
Change PORT in `.env` file

**QR code not appearing?**
Delete `.wwebjs_auth` folder and restart bot

## 📁 Project Structure
```
src/
  ├── bot.js           - WhatsApp bot
  ├── server.js        - Dashboard server
  ├── models/          - Database models
  ├── services/        - Business logic
  └── utils/           - Helper functions
public/                - Dashboard frontend
```

## 🔄 Development Mode

For auto-restart on file changes:
```powershell
npm run dev
```

## 📝 Notes

- Keep both terminals runySQL
- QR code session persists (scan once)
- Database tables are auto-created on first runfor sentiment
- Dashboard updates every 30 seconds
- All data is stored in MongoDB
- QR code session persists (scan once)

## 🎉 You're Done!

Start chatting with your bot and watch the dashboard update in real-time!
