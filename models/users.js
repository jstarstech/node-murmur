import { DataTypes } from 'sequelize';
import { sequelize } from './index.js';

const Users = sequelize.define(
    'users',
    {
        server_id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: false
        },
        user_id: {
            type: DataTypes.INTEGER
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
        timestamps: false,
        freezeTableName: true
    }
);

export default Users;
