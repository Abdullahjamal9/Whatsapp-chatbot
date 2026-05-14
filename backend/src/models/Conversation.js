const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Conversation = sequelize.define('Conversation', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  phoneNumber: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    field: 'phone_number'
  },
  name: {
    type: DataTypes.STRING(255)
  },
  messageCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'message_count'
  },
  lastMessageAt: {
    type: DataTypes.DATE,
    field: 'last_message_at'
  },
  averageSentiment: {
    type: DataTypes.FLOAT,
    defaultValue: 0,
    field: 'average_sentiment'
  },
  sentimentPositive: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'sentiment_positive'
  },
  sentimentNegative: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'sentiment_negative'
  },
  sentimentNeutral: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'sentiment_neutral'
  },
  taskCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'task_count'
  },
  requestCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'request_count'
  }
}, {
  tableName: 'conversations',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['last_message_at'] },
    { fields: ['phone_number'], unique: true }
  ]
});

module.exports = Conversation;
