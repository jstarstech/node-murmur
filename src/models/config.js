import { DataTypes } from 'sequelize';
import { Model } from 'sequelize';
import { sequelize } from './index.js';

class Config extends Model {}

Config.init(
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
        sequelize,
        modelName: 'config',
        timestamps: false,
        freezeTableName: true
    }
);

export default Config;
