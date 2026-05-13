import { DataTypes } from 'sequelize';
import { sequelize } from './index.js';

const Config = sequelize.define(
    'config',
    {
        server_id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: false
        },
        key: {
            type: DataTypes.TEXT,
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

export default Config;
