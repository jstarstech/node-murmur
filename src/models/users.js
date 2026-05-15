import { DataTypes, Model } from 'sequelize';
import { sequelize } from './index.js';

class Users extends Model {}

Users.init(
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
        name: {
            type: DataTypes.TEXT
        },
        pw: {
            type: DataTypes.TEXT
        },
        lastchannel: {
            type: DataTypes.INTEGER
        },
        texture: {
            type: DataTypes.BLOB
        },
        last_active: {
            type: DataTypes.DATE
        }
    },
    {
        sequelize,
        modelName: 'users',
        timestamps: false,
        freezeTableName: true
    }
);

export default Users;
