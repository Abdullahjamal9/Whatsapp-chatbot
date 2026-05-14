const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Meeting = sequelize.define('Meeting', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  phoneNumber: {
    type: DataTypes.STRING(100),
    allowNull: false,
    field: 'phone_number'
  },
  fromName: {
    type: DataTypes.STRING(255),
    field: 'from_name'
  },
  topic: {
    type: DataTypes.STRING(255),
    allowNull: false,
    defaultValue: 'Client Meeting'
  },
  sourceMessage: {
    type: DataTypes.TEXT,
    field: 'source_message'
  },
  confirmationMessageId: {
    type: DataTypes.STRING(255),
    field: 'confirmation_message_id',
    unique: true,
    allowNull: true
  },
  slotStart: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'slot_start'
  },
  slotEnd: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'slot_end'
  },
  timezone: {
    type: DataTypes.STRING(64),
    allowNull: false,
    defaultValue: 'Asia/Karachi'
  },
  durationMinutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 30,
    field: 'duration_minutes'
  },
  status: {
    type: DataTypes.ENUM('booked', 'cancelled'),
    allowNull: false,
    defaultValue: 'booked'
  },
  zoomMeetingId: {
    type: DataTypes.STRING(100),
    field: 'zoom_meeting_id'
  },
  zoomJoinUrl: {
    type: DataTypes.TEXT,
    field: 'zoom_join_url'
  },
  zoomStartUrl: {
    type: DataTypes.TEXT,
    field: 'zoom_start_url'
  },
  zoomPassword: {
    type: DataTypes.STRING(64),
    field: 'zoom_password'
  }
}, {
  tableName: 'meetings',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['phone_number'] },
    { fields: ['slot_start'] },
    { fields: ['status'] },
    { fields: ['confirmation_message_id'], unique: true }
  ]
});

module.exports = Meeting;
