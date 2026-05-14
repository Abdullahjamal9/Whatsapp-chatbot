# MySQL Setup for WhatsApp Bot

## ✅ Complete MySQL Conversion Done!

The system has been fully converted from MongoDB to MySQL with Sequelize ORM.

## 📋 What Changed

### Dependencies
- ✅ Replaced `mongoose` with `sequelize` and `mysql2`
- ✅ All packages installed

### Database Configuration
- ✅ Updated `src/config/database.js` to use Sequelize
- ✅ MySQL connection pooling configured
- ✅ Auto-sync enabled for table creation

### Models (Sequelize)
- ✅ `src/models/Message.js` - Converted to Sequelize model
- ✅ `src/models/Task.js` - Converted to Sequelize model
- ✅ `src/models/Conversation.js` - Converted to Sequelize model

### Database Schema

#### Messages Table
```sql
- id (INT, PRIMARY KEY, AUTO_INCREMENT)
- message_id (VARCHAR, UNIQUE)
- from (VARCHAR)
- from_name (VARCHAR)
- body (TEXT)
- timestamp (DATETIME)
- sentiment_score (FLOAT)
- sentiment_comparative (FLOAT)
- sentiment_label (ENUM: positive, negative, neutral)
- sentiment_tokens (TEXT, JSON)
- is_command (BOOLEAN)
- replied (BOOLEAN)
- created_at, updated_at (DATETIME)
```

#### Tasks Table
```sql
- id (INT, PRIMARY KEY, AUTO_INCREMENT)
- description (TEXT)
- from (VARCHAR)
- from_name (VARCHAR)
- status (ENUM: pending, in-progress, completed, cancelled)
- priority (ENUM: low, medium, high)
- type (ENUM: task, request)
- message_ref (INT, FOREIGN KEY)
- completed_at (DATETIME)
- notes (TEXT)
- created_at, updated_at (DATETIME)
```

#### Conversations Table
```sql
- id (INT, PRIMARY KEY, AUTO_INCREMENT)
- phone_number (VARCHAR, UNIQUE)
- name (VARCHAR)
- message_count (INT)
- last_message_at (DATETIME)
- average_sentiment (FLOAT)
- sentiment_positive (INT)
- sentiment_negative (INT)
- sentiment_neutral (INT)
- task_count (INT)
- request_count (INT)
- created_at, updated_at (DATETIME)
```

## 🚀 Quick Setup

### 1. Install MySQL (if not installed)
```powershell
# Download from: https://dev.mysql.com/downloads/mysql/
# Or use Chocolatey:
choco install mysql
```

### 2. Start MySQL Service
```powershell
net start MySQL80
# Or
Get-Service MySQL* | Start-Service
```

### 3. Create Database

**Option A: Automatic (Recommended)**
- Just start the server with `npm start`
- Database and tables will be created automatically!

**Option B: Manual SQL Script**
```powershell
# Run the SQL setup script
mysql -u root -p < database_setup.sql
```

**Option C: MySQL Workbench**
```sql
CREATE DATABASE whatsapp_bot;
```

### 4. Configure `.env` File
```env
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=whatsapp_bot
DB_PORT=3306
NODE_ENV=development
```

### 5. Start the Application
```powershell
# Terminal 1: Dashboard
npm start

# Terminal 2: Bot
npm run bot
```

## 🔧 Configuration Options

### Database Connection Pool
The system uses connection pooling for better performance:
- Max connections: 5
- Min connections: 0
- Acquire timeout: 30 seconds
- Idle timeout: 10 seconds

### Auto-Sync
Tables are automatically created/updated when the server starts:
- Mode: `alter` (updates existing tables without data loss)
- Can be changed to `force` (drops and recreates tables)

## 📊 Querying Data

### Using MySQL Workbench
Connect with:
- Host: localhost
- Port: 3306
- User: root
- Database: whatsapp_bot

### Using Command Line
```powershell
mysql -u root -p whatsapp_bot

# View all messages
SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10;

# View tasks
SELECT * FROM tasks WHERE status = 'pending';

# View conversations
SELECT * FROM conversations ORDER BY last_message_at DESC;

# Sentiment statistics
SELECT 
    sentiment_label, 
    COUNT(*) as count 
FROM messages 
GROUP BY sentiment_label;
```

## 🔄 Migration from MongoDB

If you had MongoDB data:

1. Export MongoDB data to JSON
2. Transform the data structure
3. Import into MySQL using Node.js script

(Contact for migration script if needed)

## 🛠️ Troubleshooting

### Connection Errors
```powershell
# Check MySQL status
Get-Service MySQL*

# Restart MySQL
Restart-Service MySQL80

# Check MySQL error log
# Location: C:\ProgramData\MySQL\MySQL Server 8.0\Data\*.err
```

### Authentication Issues
```sql
-- If using MySQL 8.0+ and getting auth errors:
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'your_password';
FLUSH PRIVILEGES;
```

### Table Creation Issues
```sql
-- Drop and recreate database
DROP DATABASE IF EXISTS whatsapp_bot;
CREATE DATABASE whatsapp_bot;
```

### Character Encoding Issues
All tables use `utf8mb4` for full Unicode support including emojis!

## ✨ Benefits of MySQL

- ✅ Better performance for complex queries
- ✅ ACID compliance
- ✅ Mature and widely supported
- ✅ Better for relational data
- ✅ More hosting options
- ✅ SQL query capabilities
- ✅ Strong data integrity

## 📈 Performance Tips

1. **Indexes**: Already configured on frequently queried columns
2. **Connection Pooling**: Enabled by default
3. **Query Optimization**: Use EXPLAIN to analyze slow queries
4. **Regular Backups**: Set up automated backups

```sql
-- Example backup command
mysqldump -u root -p whatsapp_bot > backup.sql

-- Restore
mysql -u root -p whatsapp_bot < backup.sql
```

## 🎯 What's Ready to Use

- ✅ All models converted to Sequelize
- ✅ All queries updated for MySQL
- ✅ Service layer updated
- ✅ Server API endpoints updated
- ✅ Bot integration updated
- ✅ Documentation updated
- ✅ Environment configuration updated
- ✅ SQL setup script provided

## 🚦 Next Steps

1. Configure your MySQL password in `.env`
2. Run `npm start` to create tables automatically
3. Run `npm run bot` to start the WhatsApp bot
4. Start chatting!

The system will automatically:
- Create the database schema
- Set up indexes
- Handle migrations
- Sync model changes

## 📞 Support

For MySQL-specific issues:
- Check MySQL error logs
- Verify credentials in `.env`
- Ensure MySQL service is running
- Check firewall settings (port 3306)

Everything is ready! Just configure your MySQL credentials and start the app! 🎉
