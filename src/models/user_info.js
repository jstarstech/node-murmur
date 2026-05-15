import { DataTypes, Model } from 'sequelize';
import { sequelize } from './index.js';

class UserInfo extends Model {}

UserInfo.init(
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
        sequelize,
        modelName: 'user_info',
        timestamps: false,
        freezeTableName: true
    }
);

export default UserInfo;
