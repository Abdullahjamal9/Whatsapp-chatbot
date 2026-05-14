const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Task = sequelize.define('Task', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  from: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  fromName: {
    type: DataTypes.STRING(255),
    field: 'from_name'
  },
  status: {
    type: DataTypes.ENUM('pending', 'in-progress', 'completed', 'cancelled'),
    defaultValue: 'pending'
  },
  priority: {
    type: DataTypes.ENUM('low', 'medium', 'high'),
    defaultValue: 'medium'
  },
  type: {
    type: DataTypes.ENUM('task', 'request'),
    defaultValue: 'task'
  },
  messageRef: {
    type: DataTypes.INTEGER,
    field: 'message_ref',
    references: {
      model: 'messages',
      key: 'id'
    }
  },
  completedAt: {
    type: DataTypes.DATE,
    field: 'completed_at'
  },
  notes: {
    type: DataTypes.TEXT
  }
}, {
  tableName: 'tasks',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['status'] },
    { fields: ['from'] },
    { fields: ['created_at'] }
  ]
});

module.exports = Task;
