import { DataTypes } from 'sequelize';
import { sequelize } from './index.js';

const UserInfo = sequelize.define(
    'user_info',
    {
        server_id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: false
        },
        user_id: {
            type: DataTypes.INTEGER,
            primaryKey: true
        },
        key: {
            type: DataTypes.INTEGER,
            primaryKey: true
        },
        value: {
            type: DataTypes.TEXT
        }
    },
    {
        timestamps: false,
        freezeTableName: true
    }
);

export default UserInfo;
