import { DataTypes } from 'sequelize';
import { Model } from 'sequelize';
import { sequelize } from './index.js';

class ChannelInfo extends Model {}

ChannelInfo.init(
    {
        server_id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: false
        },
        channel_id: {
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
        sequelize,
        modelName: 'channel_info',
        timestamps: false,
        freezeTableName: true
    }
);

export default ChannelInfo;
