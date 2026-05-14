const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserProfile = sequelize.define('UserProfile', {
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
    type: DataTypes.STRING(255),
    allowNull: true
  },
  designation: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  contactPhone: {
    type: DataTypes.STRING(100),
    allowNull: true,
    field: 'contact_phone'
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  onboardingComplete: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    field: 'onboarding_complete'
  }
}, {
  tableName: 'user_profiles',
  timestamps: true
});

module.exports = UserProfile;
