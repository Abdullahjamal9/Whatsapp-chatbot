-- WhatsApp Bot Database Setup Script
-- Run this in MySQL to manually create the database and tables

-- Create database
CREATE DATABASE IF NOT EXISTS whatsapp_bot;
USE whatsapp_bot;

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id VARCHAR(255) NOT NULL UNIQUE,
    `from` VARCHAR(100) NOT NULL,
    from_name VARCHAR(255),
    body TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    sentiment_score FLOAT,
    sentiment_comparative FLOAT,
    sentiment_label ENUM('positive', 'negative', 'neutral'),
    sentiment_tokens TEXT,
    top_keywords TEXT,
    is_command BOOLEAN DEFAULT FALSE,
    replied BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_timestamp (timestamp),
    INDEX idx_from (`from`),
    INDEX idx_message_id (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    description TEXT NOT NULL,
    `from` VARCHAR(100) NOT NULL,
    from_name VARCHAR(255),
    status ENUM('pending', 'in-progress', 'completed', 'cancelled') DEFAULT 'pending',
    priority ENUM('low', 'medium', 'high') DEFAULT 'medium',
    type ENUM('task', 'request') DEFAULT 'task',
    message_ref INT,
    completed_at DATETIME,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_from (`from`),
    INDEX idx_created_at (created_at),
    FOREIGN KEY (message_ref) REFERENCES messages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone_number VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255),
    message_count INT DEFAULT 0,
    last_message_at DATETIME,
    average_sentiment FLOAT DEFAULT 0,
    sentiment_positive INT DEFAULT 0,
    sentiment_negative INT DEFAULT 0,
    sentiment_neutral INT DEFAULT 0,
    task_count INT DEFAULT 0,
    request_count INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_last_message_at (last_message_at),
    INDEX idx_phone_number (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Show tables
SHOW TABLES;

-- Display success message
SELECT 'Database and tables created successfully!' AS Status;
