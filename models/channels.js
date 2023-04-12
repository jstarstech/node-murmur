module.exports = function (sequelize, DataTypes) {
    return sequelize.define('channels', {
        server_id: {
            type: DataTypes.INTEGER, primaryKey: true, autoIncrement: false
        },
        channel_id: {
            type: DataTypes.INTEGER
        },
        parent_id: {
            type: DataTypes.INTEGER
        },
        name: {
            type: DataTypes.TEXT
        },
        inheritacl: {
            type: DataTypes.INTEGER
        }
    }, {
        timestamps: false,
        freezeTableName: true
    });
};
