const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Message = sequelize.define('Message', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  messageId: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true
  },
  from: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  to: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  fromName: {
    type: DataTypes.STRING(255)
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  sentimentScore: {
    type: DataTypes.FLOAT,
    field: 'sentiment_score'
  },
  sentimentComparative: {
    type: DataTypes.FLOAT,
    field: 'sentiment_comparative'
  },
  sentimentLabel: {
    type: DataTypes.ENUM('positive', 'negative', 'neutral'),
    field: 'sentiment_label'
  },
  sentimentTokens: {
    type: DataTypes.TEXT,
    field: 'sentiment_tokens',
    get() {
      const rawValue = this.getDataValue('sentimentTokens');
      return rawValue ? JSON.parse(rawValue) : [];
    },
    set(value) {
      this.setDataValue('sentimentTokens', JSON.stringify(value));
    }
  },
  topKeywords: {
    type: DataTypes.TEXT,
    field: 'top_keywords',
    get() {
      const rawValue = this.getDataValue('topKeywords');
      return rawValue ? JSON.parse(rawValue) : [];
    },
    set(value) {
      this.setDataValue('topKeywords', JSON.stringify(value));
    }
  },
  isCommand: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    field: 'is_command'
  },
  replied: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'messages',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['timestamp'] },
    { fields: ['from'] },
    { fields: ['message_id'], unique: true }
  ]
});

module.exports = Message;
