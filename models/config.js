module.exports = function (sequelize, DataTypes) {
    return sequelize.define('config', {
        server_id: {
            type: DataTypes.INTEGER, primaryKey: true, autoIncrement: false
        },
        key: {
            type: DataTypes.TEXT
        },
        value: {
            type: DataTypes.TEXT
        }
    }, {
        timestamps: false,
        freezeTableName: true
    });
};
