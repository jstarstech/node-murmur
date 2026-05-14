import { DataTypes } from 'sequelize';
import { Model } from 'sequelize';
import { sequelize } from './index.js';

class Channels extends Model {}

Channels.init(
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
        parent_id: {
            type: DataTypes.INTEGER
        },
        name: {
            type: DataTypes.TEXT
        },
        inheritacl: {
            type: DataTypes.INTEGER
        },
        temporary: {
            type: DataTypes.INTEGER
        }
    },
    {
        sequelize,
        modelName: 'channels',
        timestamps: false,
        freezeTableName: true
    }
);

export default Channels;
